'use strict';
// iWebOS WebAssembly block compiler.
//
// Same block shapes as jit.js (side exits on conditional branches, followed jumps, loops back to the block start), but each block
// is emitted as a small WebAssembly module that works directly on the shared memory: guest registers and flags live at fixed
// addresses (see CTX in mem.js), and guest RAM is reached through the 1024-entry data cache whose entries hold the absolute
// address of the 4 KB page inside the slot pool. Anything uncommon (cache miss, MMIO, unaligned access, untranslated
// instruction) calls back into the JavaScript CPU, which keeps exact interpreter semantics, faults and timing.
const { O, Inst, decodeARM, decodeThumb } = require('./decode.js');

const MAXN = 48;
// shared-memory layout (bytes)
const OFF_N = 64, OFF_Z = 68, OFF_C = 72, OFF_V = 76, OFF_XB = 80, OFF_SC = 84, OFF_CYC = 88, OFF_IT = 112, OFF_T = 116;
const DRT = 0x1000, DRA = 0x2000, DWT = 0x3000, DWA = 0x4000;
const ENDERS = new Set([O.BX, O.BLX_R, O.BLX_I, O.TB, O.SVC, O.BKPT, O.UDF, O.MRS, O.MSR, O.CPS, O.SRS, O.RFE,
  O.MCR, O.MCRR, O.MRRC, O.CDP, O.LDC, O.STC, O.WFI, O.WFE, O.SEV, O.YIELD, O.SETEND]);
const PLAIN_BRANCH = new Set([O.BX, O.BLX_R, O.BLX_I, O.TB]);

// ---------------------------------------------------------------- binary helpers
function uleb(out, v) { v >>>= 0; do { let b = v & 0x7F; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v); }
function sleb(out, v) { v |= 0; for (;;) { const b = v & 0x7F; v >>= 7; if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return; } out.push(b | 0x80); } }
function f64bytes(out, x) { const b = new Uint8Array(new Float64Array([x]).buffer); for (const v of b) out.push(v); }
function str(out, s) { uleb(out, s.length); for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); }
function section(out, id, body) { out.push(id); uleb(out, body.length); for (const b of body) out.push(b); }

// imported functions (indices)
const F_RD8 = 0, F_RD16 = 1, F_RD32 = 2, F_WR8 = 3, F_WR16 = 4, F_WR32 = 5, F_GEN = 6, F_SHC = 7, F_XFER = 8, NIMPORT = 9;
// locals: 0 = param left; then
const L_TOT = 1, L_A = 2, L_B = 3, L_R = 4, L_EA = 5, L_NB = 6, L_VPN = 7, L_S = 8, L_X = 9, L_SC = 10, L_BASE = 11, L_T = 12, NI32 = 12;
const L_C0 = 13;   // f64
const L_W = 14;    // i64
const L_STG = 15;  // 15..30: i32 staging for LDM

class Emitter {
  constructor() { this.b = []; this.depth = 0; this.patchN = []; this.patchG = []; }
  op(...x) { for (const v of x) this.b.push(v); return this; }
  i32(v) { this.b.push(0x41); sleb(this.b, v | 0); return this; }
  get(l) { this.b.push(0x20); uleb(this.b, l); return this; }
  set(l) { this.b.push(0x21); uleb(this.b, l); return this; }
  tee(l) { this.b.push(0x22); uleb(this.b, l); return this; }
  load(off, kind) { kind = kind || 0x28; this.b.push(kind, kind === 0x2D || kind === 0x2C ? 0 : kind === 0x2F || kind === 0x2E ? 1 : kind === 0x2B ? 3 : 2); uleb(this.b, off); return this; }
  store(off, kind) { kind = kind || 0x36; this.b.push(kind, kind === 0x3A ? 0 : kind === 0x3B ? 1 : kind === 0x39 ? 3 : 2); uleb(this.b, off); return this; }
  call(f) { this.b.push(0x10); uleb(this.b, f); return this; }
  if_(t) { this.b.push(0x04, t || 0x40); this.depth++; return this; }
  else_() { this.b.push(0x05); return this; }
  end() { this.b.push(0x0B); this.depth--; return this; }
  // registers and flags (memory resident)
  getR(r) { return this.i32(0).load(4 * r); }
  setR(r, emit) { this.i32(0); emit(); return this.store(4 * r); }
  setRl(r, l) { return this.setR(r, () => this.get(l)); }
  getF(off) { return this.i32(0).load(off); }
  setF(off, emit) { this.i32(0); emit(); return this.store(off); }
  cycles(k) { this.i32(0).get(L_C0); this.b.push(0x44); f64bytes(this.b, k); this.b.push(0xA0); return this.store(OFF_CYC, 0x39); }
  ret(k) { return this.get(L_TOT).i32(k).op(0x6A, 0x0F); }                  // return tot + k
  exitTo(pcConst, k) { this.setR(15, () => this.i32(pcConst)); this.cycles(k); return this.ret(k); }
}

// push the truth value of ARM condition c (0..13)
function cond(e, c) {
  const N = () => e.getF(OFF_N), Z = () => e.getF(OFF_Z), C = () => e.getF(OFF_C), V = () => e.getF(OFF_V);
  switch (c) {
    case 0: Z(); break; case 1: Z(); e.op(0x45); break;
    case 2: C(); break; case 3: C(); e.op(0x45); break;
    case 4: N(); break; case 5: N(); e.op(0x45); break;
    case 6: V(); break; case 7: V(); e.op(0x45); break;
    case 8: C(); Z(); e.op(0x45, 0x71); break;
    case 9: C(); e.op(0x45); Z(); e.op(0x72); break;
    case 10: N(); V(); e.op(0x46); break;
    case 11: N(); V(); e.op(0x47); break;
    case 12: N(); V(); e.op(0x46); Z(); e.op(0x45, 0x71); break;
    case 13: N(); V(); e.op(0x47); Z(); e.op(0x72); break;
  }
}

// ---- memory access: address in L_EA, k = instruction index (for exact cycles on the slow path)
function emitLoad(e, size, sgn, k) {
  e.get(L_EA).i32(12).op(0x76).set(L_VPN);
  e.get(L_VPN).i32(1023).op(0x71).i32(2).op(0x74).tee(L_S).load(DRT).get(L_VPN).op(0x46);
  if (size === 4) e.get(L_EA).i32(3).op(0x71, 0x45, 0x71); else if (size === 2) e.get(L_EA).i32(1).op(0x71, 0x45, 0x71);
  e.if_(0x7F);
  e.get(L_S).load(DRA).get(L_EA).i32(0xFFF).op(0x71, 0x6A);
  e.load(0, size === 4 ? 0x28 : size === 2 ? (sgn ? 0x2E : 0x2F) : (sgn ? 0x2C : 0x2D));
  e.else_();
  e.cycles(k + 1);
  e.get(L_EA).call(size === 4 ? F_RD32 : size === 2 ? F_RD16 : F_RD8);
  if (sgn && size === 2) e.op(0xC1); else if (sgn && size === 1) e.op(0xC0);
  e.end();
}
function emitStore(e, size, k, emitVal) { // value pushed by emitVal (evaluated once, into L_X)
  emitVal(); e.set(L_X);
  e.get(L_EA).i32(12).op(0x76).set(L_VPN);
  e.get(L_VPN).i32(1023).op(0x71).i32(2).op(0x74).tee(L_S).load(DWT).get(L_VPN).op(0x46);
  if (size === 4) e.get(L_EA).i32(3).op(0x71, 0x45, 0x71); else if (size === 2) e.get(L_EA).i32(1).op(0x71, 0x45, 0x71);
  e.if_();
  e.get(L_S).load(DWA).get(L_EA).i32(0xFFF).op(0x71, 0x6A).get(L_X);
  e.store(0, size === 4 ? 0x36 : size === 2 ? 0x3B : 0x3A);
  e.else_();
  e.cycles(k + 1);
  e.get(L_EA).get(L_X).call(size === 4 ? F_WR32 : size === 2 ? F_WR16 : F_WR8);
  e.end();
}
// after an instruction that touched memory: leave if the slow path saw a device / code write (dispatcher must look)
function emitXbExit(e, next, k, itNext) {
  e.getF(OFF_XB).if_(); e.setR(15, () => e.i32(next)); if (itNext) e.setF(OFF_IT, () => e.i32(itNext)); e.ret(k + 1); e.end();
}
const itAdvance = (it) => ((it & 7) === 0 ? 0 : (it & 0xE0) | ((it << 1) & 0x1F));

// operand helpers
function pushReg(e, r, pcv) { if (r === 15) e.i32(pcv); else e.getR(r); }
function pushShifted(e, I, pcv, wantCarry) {      // pushes shifter result; if wantCarry, carry-out goes to L_SC
  pushReg(e, I.rm, pcv); e.set(L_X);
  const n = I.shImm, t = I.sh;
  if (t === 0 && n === 0) { if (wantCarry) e.getF(OFF_C).set(L_SC); e.get(L_X); return; }
  switch (t) {
    case 0: if (wantCarry) e.get(L_X).i32(32 - n).op(0x76).i32(1).op(0x71).set(L_SC); e.get(L_X).i32(n).op(0x74); break;
    case 1: if (wantCarry) e.get(L_X).i32(n >= 32 ? 31 : n - 1).op(0x76).i32(1).op(0x71).set(L_SC); if (n >= 32) e.i32(0); else e.get(L_X).i32(n).op(0x76); break;
    case 2: if (wantCarry) e.get(L_X).i32(n >= 32 ? 31 : n - 1).op(0x76).i32(1).op(0x71).set(L_SC); e.get(L_X).i32(n >= 32 ? 31 : n).op(0x75); break;
    case 3: if (wantCarry) e.get(L_X).i32(n - 1).op(0x76).i32(1).op(0x71).set(L_SC); e.get(L_X).i32(n).op(0x78); break;
    default: if (wantCarry) e.get(L_X).i32(1).op(0x71).set(L_SC); e.get(L_X).i32(1).op(0x76).getF(OFF_C).i32(31).op(0x74, 0x72); break; // RRX
  }
}

// add with carry on a, b (locals) and carry-in pushed by cin(); result -> L_R, flags C/V to memory
function addcFlags(e, la, lb, cin) {
  e.get(la).op(0xAD).get(lb).op(0xAD, 0x7C); cin(); e.op(0xAD, 0x7C).set(L_W);
  e.get(L_W).op(0xA7).set(L_R);
  e.setF(OFF_C, () => { e.get(L_W).op(0x42); sleb(e.b, 32); e.op(0x88, 0xA7); });
  e.setF(OFF_V, () => { e.get(la).get(L_R).op(0x73).get(lb).get(L_R).op(0x73, 0x71).i32(31).op(0x76); });
}

function genDP(e, I, pcv, S) {
  const dp = I.dp, write = !(dp >= 8 && dp <= 11);
  if ((I.rd === 15 && write) || dp > 16) return false;
  const logical = dp === 0 || dp === 1 || dp === 8 || dp === 9 || dp === 12 || dp === 13 || dp === 14 || dp === 15 || dp === 16;
  // a
  if (dp !== 13 && dp !== 15) { if (I.rn === 15) e.i32(I.lit ? (pcv & ~3) : pcv); else e.getR(I.rn); e.set(L_A); }
  // b (+ shifter carry into L_SC when a flag-setting logical op needs it)
  const needSC = S && logical;
  if (I.isImm) { e.i32(I.imm | 0); if (needSC) { if (I.immC < 0) e.getF(OFF_C); else e.i32(I.immC); e.set(L_SC); } }
  else if (I.shReg) { pushReg(e, I.rm, pcv); e.i32(I.sh); e.getR(I.rs).i32(255).op(0x71); e.getF(OFF_C); e.call(F_SHC); if (needSC) e.getF(OFF_SC).set(L_SC); }
  else pushShifted(e, I, pcv, needSC);
  e.set(L_B);
  const A = () => e.get(L_A), B = () => e.get(L_B);
  switch (dp) {
    case 0: case 8: A(); B(); e.op(0x71).set(L_R); break;
    case 1: case 9: A(); B(); e.op(0x73).set(L_R); break;
    case 12: A(); B(); e.op(0x72).set(L_R); break;
    case 13: B(); e.set(L_R); break;
    case 14: A(); B(); e.i32(-1).op(0x73, 0x71).set(L_R); break;
    case 15: B(); e.i32(-1).op(0x73).set(L_R); break;
    case 16: A(); B(); e.i32(-1).op(0x73, 0x72).set(L_R); break;
    case 4: case 11: if (S) addcFlags(e, L_A, L_B, () => e.i32(0)); else { A(); B(); e.op(0x6A).set(L_R); } break;
    case 2: case 10:
      if (S) { e.get(L_B).i32(-1).op(0x73).set(L_T); addcFlags(e, L_A, L_T, () => e.i32(1)); } else { A(); B(); e.op(0x6B).set(L_R); } break;
    case 3: if (S) { e.get(L_A).i32(-1).op(0x73).set(L_T); addcFlags(e, L_B, L_T, () => e.i32(1)); } else { B(); A(); e.op(0x6B).set(L_R); } break;
    case 5: if (S) addcFlags(e, L_A, L_B, () => e.getF(OFF_C)); else { A(); B(); e.op(0x6A); e.getF(OFF_C).op(0x6A).set(L_R); } break;
    case 6: if (S) { e.get(L_B).i32(-1).op(0x73).set(L_T); addcFlags(e, L_A, L_T, () => e.getF(OFF_C)); } else { A(); B(); e.i32(-1).op(0x73, 0x6A); e.getF(OFF_C).op(0x6A).set(L_R); } break;
    case 7: if (S) { e.get(L_A).i32(-1).op(0x73).set(L_T); addcFlags(e, L_B, L_T, () => e.getF(OFF_C)); } else { B(); A(); e.i32(-1).op(0x73, 0x6A); e.getF(OFF_C).op(0x6A).set(L_R); } break;
    default: return false;
  }
  if (S) {
    e.setF(OFF_N, () => e.get(L_R).i32(31).op(0x76));
    e.setF(OFF_Z, () => e.get(L_R).op(0x45));
    if (logical) e.setF(OFF_C, () => e.get(L_SC));
  }
  if (write) e.setRl(I.rd, L_R);
  return true;
}

function genMem(e, I, pcv, k, isLoad) {
  if (I.size !== 1 && I.size !== 2 && I.size !== 4) return false;
  if (I.usr || I.rd === 15) return false;
  if (I.rn === 15 && (I.W || !I.P || !isLoad)) return false;
  if (!I.isImm && (I.rm === 15 || I.sh === 4 || (I.shImm && I.sh !== 0))) return false;
  if (I.rn === 15) e.i32(I.lit ? (pcv & ~3) : pcv); else e.getR(I.rn);
  e.set(L_BASE);
  e.get(L_BASE);
  if (I.isImm) e.i32(I.imm | 0); else { e.getR(I.rm); if (I.shImm) e.i32(I.shImm).op(0x74); }
  e.op(I.U ? 0x6A : 0x6B).set(L_NB);
  e.get(I.P ? L_NB : L_BASE).set(L_EA);
  const wb = I.W || !I.P;
  if (isLoad) {
    emitLoad(e, I.size, I.sgn, k); e.set(L_R);
    if (wb) e.setRl(I.rn, L_NB);
    e.setRl(I.rd, L_R);
  } else {
    emitStore(e, I.size, k, () => e.getR(I.rd));
    if (wb) e.setRl(I.rn, L_NB);
  }
  return true;
}

// branch to the address in local l with ARM interworking (BX semantics); ends the block
function emitBxTo(e, l, T, k) {
  e.get(l).i32(1).op(0x71).i32(T).op(0x46);
  e.if_();
  e.setR(15, () => e.get(l).i32(T ? -2 : -4).op(0x71));
  e.else_();
  e.cycles(k + 1); e.get(l).call(F_XFER).op(0x1A);                      // instruction-set switch: the JS side updates T and asks to stop
  e.end();
  e.cycles(k + 1); e.ret(k + 1);
}

function genLDMSTM(e, I, pcv, k, isLoad) {
  if (I.S || I.rn === 15 || I.list === 0) return false;
  const regs = []; for (let r = 0; r < 16; r++) if (I.list & (1 << r)) regs.push(r);
  const n = regs.length;
  const off = I.U ? (I.P ? 4 : 0) : (I.P ? -4 * n : -4 * n + 4);
  e.getR(I.rn).set(L_BASE);
  if (isLoad) {
    // stage loaded values in the free locals A,B,R,NB,X,SC,T,(VPN reused carefully: not usable) -> use a stack of i32 locals
    const stage = regs.map((r, i) => L_STG + i);
    regs.forEach((r, i) => { e.get(L_BASE).i32(off + 4 * i).op(0x6A).set(L_EA); emitLoad(e, 4, false, k); e.set(stage[i]); });
    if (I.W) e.setR(I.rn, () => e.get(L_BASE).i32(I.U ? 4 * n : -4 * n).op(0x6A));
    regs.forEach((r, i) => { if (r !== 15) e.setRl(r, stage[i]); });
    if (I.list & 0x8000) return 'pc';   // caller ends the block with an interworking branch to stage[n-1]
  } else {
    regs.forEach((r, i) => { e.get(L_BASE).i32(off + 4 * i).op(0x6A).set(L_EA); emitStore(e, 4, k, () => pushReg(e, r, pcv)); });
    if (I.W) e.setR(I.rn, () => e.get(L_BASE).i32(I.U ? 4 * n : -4 * n).op(0x6A));
  }
  return true;
}

// ---------------------------------------------------------------- block translation
function compile(cpu, frame, pc0, T) {
  const ram = cpu.ram, base = frame << 12;
  const K = [], pcs = [], seen = new Set();
  const noLoop = pc0 === cpu.hookPC || pc0 === cpu.idlePC || pc0 === cpu.breakAt;
  const e = new Emitter();
  let pc = pc0, n = 0, ended = false, inline = 0, loopLen = 0, it = 0;
  const gens = [], its = [];   // generic instructions; IT state in force at each instruction (for fault recovery)
  while (n < MAXN && !ended) {
    if (pc === cpu.hookPC || pc === cpu.idlePC || pc === cpu.breakAt || (n > 0 && cpu.isHLE(pc))) break;
    if (n > 0 && seen.has(pc)) break;
    if (((pc ^ pc0) >>> 12) !== 0) break;
    const off = pc & 0xFFF;
    if (off + (T ? 2 : 4) > 0x1000) break;
    const I = new Inst();
    if (T) {
      const h1 = ram.r16(base + off); let h2 = 0;
      if ((h1 >>> 11) >= 29) { if (off + 4 > 0x1000) break; h2 = ram.r16(base + off + 2); }
      decodeThumb(h1, h2, I);
    } else decodeARM(ram.r32(base + off) >>> 0, I);
    if (I.op === O.IT) {                                   // IT: the next 1-4 instructions get their conditions statically
      if (it !== 0 || n + 5 >= MAXN) break;
      K.push(I); pcs.push(pc); seen.add(pc); its.push(0);
      it = (I.o1 << 4) | I.o2; n++; pc += I.len; continue;
    }
    K.push(I); pcs.push(pc); seen.add(pc); its.push(it);
    const inIT = it !== 0, itNext = inIT ? itAdvance(it) : 0;
    const pcv = (pc + (T ? 4 : 8)) | 0, next = (pc + I.len) | 0, S = I.S === 1 || (I.S === 2 && !inIT);
    const c = inIT ? ((it >>> 4) >= 14 ? -1 : (it >>> 4)) : (I.cond >= 14 ? -1 : I.cond);
    it = itNext;
    let nextPc = pc + I.len;
    const k = n;
    if (I.op === O.B || I.op === O.CBZ) {
      inline++;
      const target = (pcv + I.imm) >>> 0;
      const pushTaken = () => { if (I.op === O.CBZ) { e.getR(I.rn); if (I.kind !== 1) e.op(0x45); } else cond(e, c); };
      const uncond = I.op === O.B && c < 0;
      if (uncond && ((target >>> 12) === (pc0 >>> 12)) && !seen.has(target) && target !== pc0 && n + 1 < MAXN - 1) {
        nextPc = target;
      } else if (target === pc0 && !noLoop && loopLen === 0) {
        loopLen = n + 1;
        const cont = () => {
          e.cycles(n + 1);
          e.get(L_TOT).i32(n + 1).op(0x6A).set(L_TOT);
          e.get(L_TOT); e.op(0x41); e.patchN.push(e.b.length); e.op(0x80, 0x80, 0x00); e.op(0x6A).get(0).op(0x4C);     // tot + N <= left ? (N patched below)
          e.if_(); e.op(0x0C); uleb(e.b, e.depth); e.end();            // br to the loop (depth counts the open ifs)
          e.setR(15, () => e.i32(target | 0)); e.get(L_TOT).op(0x0F);
        };
        if (uncond) { cont(); ended = true; } else { pushTaken(); e.if_(); cont(); e.end(); }
      } else if (uncond) { e.exitTo(target | 0, n + 1); ended = true; }
      else { pushTaken(); e.if_(); e.exitTo(target | 0, n + 1); e.end(); }
    } else if (I.op === O.BL) {
      inline++;
      if (c >= 0) { cond(e, c); e.if_(); }
      e.setR(14, () => e.i32((next | (T ? 1 : 0)) | 0)); e.exitTo((pcv + I.imm) | 0, n + 1);
      if (c >= 0) { e.end(); e.exitTo(next, n + 1); }
      ended = true;
    } else {
      // inline templates
      const mark = e.b.length, depth0 = e.depth;
      if (c >= 0) { cond(e, c); e.if_(); }
      let ok = false, mem = false;
      switch (I.op) {
        case O.BX: case O.BLX_R: if (I.rm !== 15) {
          e.getR(I.rm).set(L_A);
          if (I.op === O.BLX_R) e.setR(14, () => e.i32((next | (T ? 1 : 0)) | 0));
          emitBxTo(e, L_A, T, n);
          ok = 'end'; } break;
        case O.BLX_I: {                                   // call with instruction-set switch: LR, new T in memory, jump
          e.setR(14, () => e.i32((next | (T ? 1 : 0)) | 0));
          e.setF(OFF_T, () => e.i32(T ? 0 : 1));
          e.exitTo((T ? ((pcv & ~3) + I.imm) : (pcv + I.imm)) | 0, n + 1);
          ok = 'end'; break; }
        case O.TB: {
          if (I.rn === 15) e.i32(pcv); else e.getR(I.rn);
          e.getR(I.rm); if (I.kind) e.i32(1).op(0x74); e.op(0x6A).set(L_EA);
          emitLoad(e, I.kind ? 2 : 1, false, n);
          e.i32(1).op(0x74).i32(pcv).op(0x6A).set(L_A);
          e.setRl(15, L_A); e.cycles(n + 1); e.ret(n + 1);
          ok = 'end'; break; }
        case O.DP: ok = genDP(e, I, pcv, S); break;
        case O.LDR: ok = genMem(e, I, pcv, k, true); mem = true; break;
        case O.STR: ok = genMem(e, I, pcv, k, false); mem = true; break;
        case O.LDM: ok = genLDMSTM(e, I, pcv, k, true); mem = true; break;
        case O.STM: ok = genLDMSTM(e, I, pcv, k, false); mem = true; break;
        case O.MOVW: if (I.rd !== 15) { e.setR(I.rd, () => e.i32(I.imm | 0)); ok = true; } break;
        case O.MOVT: if (I.rd !== 15) { e.setR(I.rd, () => { e.getR(I.rd).i32(0xFFFF).op(0x71).i32((I.imm << 16) | 0).op(0x72); }); ok = true; } break;
        case O.MUL: if (I.rd !== 15) {
          e.getR(I.rm).getR(I.rs).op(0x6C).set(L_R); e.setRl(I.rd, L_R);
          if (S) { e.setF(OFF_N, () => e.get(L_R).i32(31).op(0x76)); e.setF(OFF_Z, () => e.get(L_R).op(0x45)); }
          ok = true; } break;
        case O.CLZ: if (I.rd !== 15) { e.setR(I.rd, () => e.getR(I.rm).op(0x67)); ok = true; } break;
        case O.EXT: if (I.rd !== 15 && I.rm !== 15 && I.kind <= 3) {
          e.setR(I.rd, () => {
            e.getR(I.rm); if (I.rot) e.i32(I.rot).op(0x78);
            if (I.kind === 0) e.op(0xC0); else if (I.kind === 1) e.op(0xC1); else if (I.kind === 2) e.i32(0xFF).op(0x71); else e.i32(0xFFFF).op(0x71);
            if (I.rn !== 15) e.getR(I.rn).op(0x6A);
          }); ok = true; } break;
      }
      if (ok === 'end') {                                  // template already ended the block
        if (c >= 0) { e.end(); e.exitTo(next, n + 1); }
        inline++; ended = true;
      } else if (ok === 'pc') {                                   // LDM including PC (e.g. pop {..., pc}): branch to the loaded value
        const nregs = (() => { let m = 0; for (let r = 0; r < 16; r++) if (I.list & (1 << r)) m++; return m; })();
        emitBxTo(e, L_STG + nregs - 1, T, n);
        if (c >= 0) { e.end(); e.exitTo(next, n + 1); }
        inline++; ended = true;
      } else if (ok) {
        inline++;
        if (c >= 0) e.end();
        if (mem) emitXbExit(e, next, n, itNext);
      } else {
        e.b.length = mark; e.depth = depth0;
        // generic: the JavaScript executor runs this one instruction (flags/cycles are synchronised by the import)
        const ender = ENDERS.has(I.op);
        const gi = gens.length; gens.push({ I, pc: pc >>> 0, pcvU: pc + (T ? 4 : 8), nextU: pc + I.len, ender, plain: PLAIN_BRANCH.has(I.op), inIT, itNext });
        if (c >= 0) { cond(e, c); e.if_(); }
        e.cycles(n + 1); e.op(0x41); e.patchG.push([e.b.length, gi]); e.op(0x80, 0x80, 0x00); e.call(F_GEN);
        if (ender) { e.op(0x1A); e.ret(n + 1); }                   // gen() already stored R15 / xb
        else { e.if_(); e.ret(n + 1); e.end(); }
        if (c >= 0) { e.end(); if (ender) e.exitTo(next, n + 1); }
        if (ender) ended = true;
      }
    }
    n++; pc = nextPc;
  }
  if (n === 0 || (n === 1 && inline === 0)) return null;
  if (!ended) { if (it) { e.setF(OFF_IT, () => e.i32(it)); e.setF(OFF_XB, () => e.i32(1)); } e.exitTo(pc | 0, n); }
  // patch the loop budget constants (3-byte padded LEB placeholders) with the final instruction count
  const body = e.b;
  for (const at of e.patchN) { body[at] = 0x80 | (n & 0x7F); body[at + 1] = 0x80 | ((n >> 7) & 0x7F); body[at + 2] = (n >> 14) & 0x3F; }
  // function body: [loop] c0 = cycles ; body ; [end] unreachable
  const fb = [];
  // locals: 15 i32 (1..12 + 2 spare for LDM staging: 15,16 are i32 too) -> declare groups in index order
  const locals = [[12, 0x7F], [1, 0x7C], [1, 0x7E], [16, 0x7F]];  // 1..12 i32, 13 f64, 14 i64, 15..30 i32
  uleb(fb, locals.length); for (const [cnt, t] of locals) { uleb(fb, cnt); fb.push(t); }
  if (loopLen) fb.push(0x03, 0x40);
  fb.push(0x41, 0x00, 0x2B, 0x03); uleb(fb, OFF_CYC); fb.push(0x21); uleb(fb, L_C0);
  for (const b of body) fb.push(b);
  if (loopLen) fb.push(0x0B);
  fb.push(0x00, 0x0B);
  // gen-id placeholders: byte offsets inside fb = header length + offset in body
  const hdr = fb.length - body.length - (loopLen ? 1 : 0) - 2;
  return { fb, n, pcs, its, loopLen, gens, K, patchG: e.patchG.map(([at, gi]) => [at + hdr, gi]), wasm: true };
}

// patch a 3-byte padded LEB placeholder
function put3(b, at, v) { b[at] = 0x80 | (v & 0x7F); b[at + 1] = 0x80 | ((v >> 7) & 0x7F); b[at + 2] = (v >> 14) & 0x7F; }

// Compile several translated blocks into one module (dense code, one compile). Returns the exported functions, in order.
function buildModule(cpu, blocks) {
  const gensAll = [];
  const bodies = blocks.map((t) => {
    const fb = t.fb.slice();
    const base = gensAll.length; for (const g of t.gens) gensAll.push(g);
    for (const [at, gi] of t.patchG) put3(fb, at, base + gi);
    return fb;
  });
  const out = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
  section(out, 1, typeSection());
  section(out, 2, importSection(false));
  const fs = []; uleb(fs, bodies.length); for (let i = 0; i < bodies.length; i++) fs.push(0); section(out, 3, fs);
  const exp = []; uleb(exp, bodies.length);
  for (let i = 0; i < bodies.length; i++) { str(exp, 'f' + i); exp.push(0x00); uleb(exp, NIMPORT + i); }
  section(out, 7, exp);
  const code = []; uleb(code, bodies.length);
  for (const fb of bodies) { uleb(code, fb.length); for (const x of fb) code.push(x); }
  section(out, 10, code);
  const mod = new WebAssembly.Module(new Uint8Array(out));
  const inst = new WebAssembly.Instance(mod, { m: cpu.wasmImports(gensAll) });
  return { fns: bodies.map((_, i) => inst.exports['f' + i]), bytes: out.length };
}

function typeSection() {
  const types = [];
  uleb(types, 3);
  types.push(0x60, 1, 0x7F, 1, 0x7F);                  // 0: (i32)->i32   block, rd*, gen
  types.push(0x60, 2, 0x7F, 0x7F, 0);                   // 1: (i32,i32)->() wr*
  types.push(0x60, 4, 0x7F, 0x7F, 0x7F, 0x7F, 1, 0x7F); // 2: shc
  return types;
}
function importSection(withTable) {
  const imp = [];
  const fimps = [['rd8', 0], ['rd16', 0], ['rd32', 0], ['wr8', 1], ['wr16', 1], ['wr32', 1], ['gen', 0], ['shc', 2], ['xfer', 0]];
  uleb(imp, fimps.length + 1 + (withTable ? 1 : 0));
  str(imp, 'm'); str(imp, 'mem'); imp.push(0x02, 0x00); uleb(imp, 1);
  if (withTable) { str(imp, 'm'); str(imp, 'tbl'); imp.push(0x01, 0x70, 0x00); uleb(imp, 1); }
  for (const [nm, t] of fimps) { str(imp, 'm'); str(imp, nm); imp.push(0x00); uleb(imp, t); }
  return imp;
}

// shared-memory layout for the dispatcher
const XT = 0x5000, XF = 0x6000;                    // fetch translation cache: vpn tag / physical 4 KB frame (filled by the JS CPU)
const HK = 0x10000, HI = 0x50000, HN = 0x90000;    // block hash (65536 entries): key, table index, instruction count
const OFF_CURB = 96, OFF_DONE = 100, OFF_JC0 = 104;
function hashOf(key) { return (Math.imul(key, 0x9E3779B1) >>> 16); }

// The dispatcher: keeps calling compiled blocks (through the shared function table) while the next block is known and nothing
// needs the JavaScript side. run(left, T) -> instructions executed.
function buildDispatcher(cpu) {
  const L_LEFT = 0, L_TB = 1, D_DONE = 2,  // L_TB is now a local loaded from memory each round
  /* */ D_PC = 3, D_VPN = 4, D_S = 5, D_KEY = 6, D_H = 7, D_IDX = 8;
  const e = new Emitter();
  e.op(0x03, 0x40);                                                       // loop
  e.get(D_DONE).get(L_LEFT).op(0x4E); e.if_(); e.get(D_DONE).op(0x0F); e.end();          // done >= left -> return
  e.getR(15).set(D_PC); e.getF(OFF_T).set(L_TB);
  e.get(D_PC).i32(12).op(0x76).set(D_VPN);
  e.get(D_VPN).i32(1023).op(0x71).i32(2).op(0x74).tee(D_S).load(XT).get(D_VPN).op(0x47);
  e.if_(); e.get(D_DONE).op(0x0F); e.end();
  e.get(D_S).load(XF).i32(12).op(0x74).get(D_PC).i32(0xFFF).op(0x71, 0x72).i32(1).op(0x74).get(L_TB).op(0x72).set(D_KEY);
  e.get(D_KEY).i32(0x9E3779B1 | 0).op(0x6C).i32(16).op(0x76).i32(2).op(0x74).set(D_H);
  e.get(D_H).load(HK).get(D_KEY).op(0x47); e.if_(); e.get(D_DONE).op(0x0F); e.end();
  e.get(D_H).load(HN).get(L_LEFT).get(D_DONE).op(0x6B).op(0x4A); e.if_(); e.get(D_DONE).op(0x0F); e.end();
  e.get(D_H).load(HI).set(D_IDX);
  e.i32(0).get(D_IDX).store(OFF_CURB); e.i32(0).get(D_DONE).store(OFF_DONE);
  e.i32(0).i32(0).load(OFF_CYC, 0x2B).store(OFF_JC0, 0x39);
  e.get(L_LEFT).get(D_DONE).op(0x6B).get(D_IDX);
  e.op(0x11); uleb(e.b, 0); e.op(0x00);                                   // call_indirect type 0, table 0
  e.get(D_DONE).op(0x6A).set(D_DONE);
  e.getF(OFF_XB); e.if_(); e.get(D_DONE).op(0x0F); e.end();
  e.op(0x0C, 0x00);                                                       // br loop
  e.op(0x0B, 0x00);                                                       // end loop; unreachable
  const fb = []; uleb(fb, 1); uleb(fb, 8); fb.push(0x7F); for (const x of e.b) fb.push(x); fb.push(0x0B);
  const out = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
  const types = []; uleb(types, 2); types.push(0x60, 1, 0x7F, 1, 0x7F); types.push(0x60, 1, 0x7F, 1, 0x7F);
  section(out, 1, types);
  const imp = []; uleb(imp, 2);
  str(imp, 'm'); str(imp, 'mem'); imp.push(0x02, 0x00); uleb(imp, 1);
  str(imp, 'm'); str(imp, 'tbl'); imp.push(0x01, 0x70, 0x00); uleb(imp, 1);
  section(out, 2, imp);
  section(out, 3, [1, 1]);
  const exp = []; uleb(exp, 1); str(exp, 'run'); exp.push(0x00); uleb(exp, 0); section(out, 7, exp);
  const code = []; uleb(code, 1); uleb(code, fb.length); for (const x of fb) code.push(x); section(out, 10, code);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(out)), { m: { mem: cpu.ram.wmem, tbl: cpu.wtable } });
  return inst.exports.run;
}

module.exports = { translate: compile, buildModule, buildDispatcher, hashOf, XT, XF, HK, HI, HN, OFF_N, OFF_Z, OFF_C, OFF_V, OFF_XB, OFF_SC, OFF_CYC, OFF_CURB, OFF_DONE, OFF_JC0, OFF_IT, OFF_T };
