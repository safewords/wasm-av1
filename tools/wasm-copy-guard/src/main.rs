//! `wasm-copy-guard <in.wasm> <out.wasm> [--always-slow]`
//!
//! A post-link pass for wasm-av1's threads builds, run by `scripts/build.sh`
//! between wasm-bindgen and wasm-opt. It replaces every `memory.copy` and
//! `memory.fill` in the module with a call to a helper that does the same
//! thing, so that the threads builds work in JavaScriptCore (Safari).
//!
//! Why: in JavaScriptCore, when one Worker grows a shared memory, an
//! instance of the module in another Worker keeps its old idea of the
//! memory's size. Its `memory.size` keeps returning the old size, and its
//! `memory.copy` and `memory.fill` check bounds against that size, so they
//! trap ("Out of bounds memory access") on any page grown since. Loads,
//! stores and atomics on those pages work. Only that instance's own
//! `memory.grow` of one page or more refreshes its size. The threads builds
//! run one instance per decoder thread, each in its own Worker. Any thread
//! that allocates can grow the memory, and every `memcpy`/`memset` in the
//! decoder is a `memory.copy`/`memory.fill` (shared memory needs
//! bulk-memory, and LLVM then lowers to them), so the first copy into a
//! newly grown frame buffer killed a thread. Measured in Playwright's macOS
//! WebKit, 2026-11-12; Chromium and Firefox are not affected
//! (docs/features/variants-and-threading.md).
//!
//! The helpers check the range against the instance's own `memory.size`.
//! Inside it, they run the native instruction, which cannot hit the bug
//! because that is the size JavaScriptCore checks against. On an engine
//! without the bug, `memory.size` is always current, so every in-bounds copy
//! takes this path. Beyond it, they copy or fill with plain 8-byte and 1-byte
//! loads and stores, which do work there. A copy that is really out of
//! bounds still traps, in the loop instead of up front.
//!
//! `--always-slow` leaves out the native path, so that the tests can run
//! the loops on an engine without the bug (test/copy-guard.test.mjs).

use std::collections::HashSet;
use std::process::ExitCode;

use walrus::ir::{
    BinaryOp, Call, ExtendedLoad, Instr, InstrLocId, InstrSeqId, LoadKind, MemArg, StoreKind,
    UnaryOp, VisitorMut,
};
use walrus::{FunctionBuilder, FunctionId, InstrSeqBuilder, LocalId, MemoryId, Module, ValType};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let always_slow = args.iter().any(|a| a == "--always-slow");
    let paths: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let [input, output] = paths[..] else {
        eprintln!("usage: wasm-copy-guard <in.wasm> <out.wasm> [--always-slow]");
        return ExitCode::from(2);
    };
    match run(input, output, always_slow) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("wasm-copy-guard: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(input: &str, output: &str, always_slow: bool) -> Result<(), String> {
    let mut module = Module::from_file(input).map_err(|e| format!("{input}: {e}"))?;
    let memories: Vec<_> = module.memories.iter().collect();
    let [memory] = memories[..] else {
        return Err(format!(
            "{input}: expected exactly one memory, found {}",
            memories.len()
        ));
    };
    if memory.memory64 {
        return Err(format!("{input}: memory64 is not supported"));
    }
    if !memory.shared {
        return Err(format!(
            "{input}: the memory is not shared; only the threads builds need this pass"
        ));
    }
    let mem = memory.id();

    let copy = build_copy(&mut module, mem, always_slow);
    let fill = build_fill(&mut module, mem, always_slow);
    let helpers: HashSet<FunctionId> = [copy, fill].into_iter().collect();

    let mut rewrite = Rewrite {
        mem,
        copy,
        fill,
        copies: 0,
        fills: 0,
    };
    for (id, func) in module.funcs.iter_local_mut() {
        if helpers.contains(&id) {
            continue;
        }
        let entry = func.entry_block();
        walrus::ir::dfs_pre_order_mut(&mut rewrite, func, entry);
    }
    module
        .emit_wasm_file(output)
        .map_err(|e| format!("{output}: {e}"))?;
    println!(
        "   wasm-copy-guard: {} memory.copy and {} memory.fill routed through the guarded helpers{}",
        rewrite.copies,
        rewrite.fills,
        if always_slow { " (always the slow path)" } else { "" }
    );
    Ok(())
}

/// Replaces the instructions with calls; the helpers take the same operands
/// in the same order and leave nothing on the stack, as the instructions do.
struct Rewrite {
    mem: MemoryId,
    copy: FunctionId,
    fill: FunctionId,
    copies: usize,
    fills: usize,
}

impl VisitorMut for Rewrite {
    fn visit_instr_mut(&mut self, instr: &mut Instr, _: &mut InstrLocId) {
        match instr {
            Instr::MemoryCopy(c) if c.src == self.mem && c.dst == self.mem => {
                *instr = Instr::Call(Call { func: self.copy });
                self.copies += 1;
            }
            Instr::MemoryFill(f) if f.memory == self.mem => {
                *instr = Instr::Call(Call { func: self.fill });
                self.fills += 1;
            }
            _ => {}
        }
    }
}

const BYTE: MemArg = MemArg {
    align: 1,
    offset: 0,
};
const UNALIGNED_I64: MemArg = MemArg {
    align: 1,
    offset: 0,
};

/// Branch to `slow` unless `addr + len` (as 64-bit, so no wrap) is within
/// this instance's own `memory.size`.
fn br_if_beyond_size(
    b: &mut InstrSeqBuilder,
    mem: MemoryId,
    addr: LocalId,
    len: LocalId,
    slow: InstrSeqId,
) {
    b.local_get(addr)
        .unop(UnaryOp::I64ExtendUI32)
        .local_get(len)
        .unop(UnaryOp::I64ExtendUI32)
        .binop(BinaryOp::I64Add)
        .memory_size(mem)
        .unop(UnaryOp::I64ExtendUI32)
        .i64_const(16)
        .binop(BinaryOp::I64Shl)
        .binop(BinaryOp::I64GtU)
        .br_if(slow);
}

/// `local += delta` for an i32 local.
fn add(b: &mut InstrSeqBuilder, local: LocalId, delta: i32) {
    b.local_get(local)
        .i32_const(delta)
        .binop(BinaryOp::I32Add)
        .local_set(local);
}

/// `(dst, src, n)`: `memory.copy`, i.e. memmove.
fn build_copy(module: &mut Module, mem: MemoryId, always_slow: bool) -> FunctionId {
    let i32 = ValType::I32;
    let dst = module.locals.add(i32);
    let src = module.locals.add(i32);
    let n = module.locals.add(i32);
    let mut builder = FunctionBuilder::new(&mut module.types, &[i32, i32, i32], &[]);
    builder.name("__wasm_av1_guarded_memory_copy".into());
    let mut body = builder.func_body();
    if !always_slow {
        body.block(None, |slow| {
            let slow_id = slow.id();
            br_if_beyond_size(slow, mem, dst, n, slow_id);
            br_if_beyond_size(slow, mem, src, n, slow_id);
            slow.local_get(dst)
                .local_get(src)
                .local_get(n)
                .memory_copy(mem, mem)
                .return_();
        });
    }
    // Forward when that cannot overwrite bytes not yet read: dst <= src, or
    // dst at or past src + n. Each step loads before it stores, and a
    // forward step never stores at or past the next load's address, nor a
    // backward step at or below it.
    body.local_get(dst)
        .local_get(src)
        .binop(BinaryOp::I32LeU)
        .local_get(dst)
        .local_get(src)
        .binop(BinaryOp::I32Sub)
        .local_get(n)
        .binop(BinaryOp::I32GeU)
        .binop(BinaryOp::I32Or)
        .if_else(
            None,
            |fwd| {
                // while n >= 8 { *dst = *src (8 bytes); dst += 8; src += 8; n -= 8 }
                fwd.block(None, |done| {
                    let done_id = done.id();
                    done.loop_(None, |l| {
                        let l_id = l.id();
                        l.local_get(n)
                            .i32_const(8)
                            .binop(BinaryOp::I32LtU)
                            .br_if(done_id);
                        l.local_get(dst)
                            .local_get(src)
                            .load(mem, LoadKind::I64 { atomic: false }, UNALIGNED_I64)
                            .store(mem, StoreKind::I64 { atomic: false }, UNALIGNED_I64);
                        add(l, dst, 8);
                        add(l, src, 8);
                        add(l, n, -8);
                        l.br(l_id);
                    });
                });
                // while n != 0 { *dst = *src (1 byte); dst += 1; src += 1; n -= 1 }
                fwd.block(None, |done| {
                    let done_id = done.id();
                    done.loop_(None, |l| {
                        let l_id = l.id();
                        l.local_get(n).unop(UnaryOp::I32Eqz).br_if(done_id);
                        l.local_get(dst)
                            .local_get(src)
                            .load(
                                mem,
                                LoadKind::I32_8 {
                                    kind: ExtendedLoad::ZeroExtend,
                                },
                                BYTE,
                            )
                            .store(mem, StoreKind::I32_8 { atomic: false }, BYTE);
                        add(l, dst, 1);
                        add(l, src, 1);
                        add(l, n, -1);
                        l.br(l_id);
                    });
                });
            },
            |bwd| {
                // Overlapping with dst above src: from the end down.
                // while n >= 8 { n -= 8; dst[n..n+8] = src[n..n+8] }
                bwd.block(None, |done| {
                    let done_id = done.id();
                    done.loop_(None, |l| {
                        let l_id = l.id();
                        l.local_get(n)
                            .i32_const(8)
                            .binop(BinaryOp::I32LtU)
                            .br_if(done_id);
                        add(l, n, -8);
                        l.local_get(dst)
                            .local_get(n)
                            .binop(BinaryOp::I32Add)
                            .local_get(src)
                            .local_get(n)
                            .binop(BinaryOp::I32Add)
                            .load(mem, LoadKind::I64 { atomic: false }, UNALIGNED_I64)
                            .store(mem, StoreKind::I64 { atomic: false }, UNALIGNED_I64);
                        l.br(l_id);
                    });
                });
                // while n != 0 { n -= 1; dst[n] = src[n] }
                bwd.block(None, |done| {
                    let done_id = done.id();
                    done.loop_(None, |l| {
                        let l_id = l.id();
                        l.local_get(n).unop(UnaryOp::I32Eqz).br_if(done_id);
                        add(l, n, -1);
                        l.local_get(dst)
                            .local_get(n)
                            .binop(BinaryOp::I32Add)
                            .local_get(src)
                            .local_get(n)
                            .binop(BinaryOp::I32Add)
                            .load(
                                mem,
                                LoadKind::I32_8 {
                                    kind: ExtendedLoad::ZeroExtend,
                                },
                                BYTE,
                            )
                            .store(mem, StoreKind::I32_8 { atomic: false }, BYTE);
                        l.br(l_id);
                    });
                });
            },
        );
    builder.finish(vec![dst, src, n], &mut module.funcs)
}

/// `(dst, val, n)`: `memory.fill`, i.e. memset with the low byte of `val`.
fn build_fill(module: &mut Module, mem: MemoryId, always_slow: bool) -> FunctionId {
    let i32 = ValType::I32;
    let dst = module.locals.add(i32);
    let val = module.locals.add(i32);
    let n = module.locals.add(i32);
    let word = module.locals.add(ValType::I64);
    let mut builder = FunctionBuilder::new(&mut module.types, &[i32, i32, i32], &[]);
    builder.name("__wasm_av1_guarded_memory_fill".into());
    let mut body = builder.func_body();
    if !always_slow {
        body.block(None, |slow| {
            let slow_id = slow.id();
            br_if_beyond_size(slow, mem, dst, n, slow_id);
            slow.local_get(dst)
                .local_get(val)
                .local_get(n)
                .memory_fill(mem)
                .return_();
        });
    }
    // word = (val & 0xff) * 0x0101_0101_0101_0101
    body.local_get(val)
        .i32_const(0xff)
        .binop(BinaryOp::I32And)
        .unop(UnaryOp::I64ExtendUI32)
        .i64_const(0x0101_0101_0101_0101)
        .binop(BinaryOp::I64Mul)
        .local_set(word);
    body.block(None, |done| {
        let done_id = done.id();
        done.loop_(None, |l| {
            let l_id = l.id();
            l.local_get(n)
                .i32_const(8)
                .binop(BinaryOp::I32LtU)
                .br_if(done_id);
            l.local_get(dst).local_get(word).store(
                mem,
                StoreKind::I64 { atomic: false },
                UNALIGNED_I64,
            );
            add(l, dst, 8);
            add(l, n, -8);
            l.br(l_id);
        });
    });
    body.block(None, |done| {
        let done_id = done.id();
        done.loop_(None, |l| {
            let l_id = l.id();
            l.local_get(n).unop(UnaryOp::I32Eqz).br_if(done_id);
            l.local_get(dst)
                .local_get(val)
                .store(mem, StoreKind::I32_8 { atomic: false }, BYTE);
            add(l, dst, 1);
            add(l, n, -1);
            l.br(l_id);
        });
    });
    builder.finish(vec![dst, val, n], &mut module.funcs)
}
