'use strict';
// iWebOS VFPv3-D32 + NEON unit (Cortex-A8 flavour). Register file is the source of truth as raw 32-bit words so
// that moves/loads/stores never disturb NaN payloads; arithmetic goes through typed-array views.
const U32 = 4294967296;

class VFP {
  constructor() {
    const b = new ArrayBuffer(256);
    this.u = new Uint32Array(b); this.i32 = new Int32Array(b); this.f32 = new Float32Array(b); this.f64 = new Float64Array(b);
    this.b8 = new Uint8Array(b); this.u16 = new Uint16Array(b); this.i8 = new Int8Array(b); this.i16 = new Int16Array(b);
    this.fpscr = 0; this.fpexc = 0; this.fpinst = 0; this.fpinst2 = 0;
    this.fpsid = 0x410330C3; this.mvfr0 = 0x11111111; this.mvfr1 = 0x00011111;
    this.unimpl = new Set();
    this.tmp = new ArrayBuffer(16); this.tb = new Uint8Array(this.tmp);
  }
  reset() { this.u.fill(0); this.fpscr = 0; this.fpexc = 0; }

  // Normalise a Thumb-2 coprocessor/NEON instruction to its ARM encoding.
  static norm(I) {
    if (!I.thumb) return I.w >>> 0;
    const h1 = I.w & 0xFFFF, h2 = I.w2 & 0xFFFF;
    if ((h1 & 0xEF00) === 0xEF00) return (0xF2000000 | (((h1 >>> 12) & 1) << 24) | ((h1 & 0xFF) << 16) | h2) >>> 0;
    if ((h1 & 0xFF00) === 0xF900) return (0xF4000000 | ((h1 & 0xFF) << 16) | h2) >>> 0;
    return (0xE0000000 | ((h1 & 0xFFF) << 16) | h2) >>> 0;
  }

  // returns true if handled; false => caller raises UNDEF
  exec(cpu, I, pc) {
    const w = VFP.norm(I);
    const f = (cpu.cpacr >>> 20) & 3;
    if (f === 0 || f === 2 || (f === 1 && !cpu.priv)) return false;           // coprocessor access denied
    const sysAccess = this.isSysXfer(w);
    if (sysAccess) {                                                           // VMRS/VMSR
      const reg = (w >>> 16) & 15;
      if (reg !== 1 && !cpu.priv) return false;                                // FPSID/FPEXC/MVFR*: privileged only
      if (reg === 1 && !(this.fpexc & 0x40000000)) return false;              // FPSCR needs EN
      return this.sysXfer(cpu, w, I, pc);
    }
    if (!(this.fpexc & 0x40000000)) return false;                              // VFP/NEON disabled
    if ((w >>> 28) === 15) return this.neon(cpu, w, I, pc);
    const t = (w >>> 24) & 15;
    if (t === 14) return (w & 0x10) ? this.xfer(cpu, w, I) : this.dataProc(cpu, w, I);
    if (t === 12 || t === 13) {
      if (((w >>> 21) & 0x7F) === 0x62) return this.twoReg(cpu, w);
      if (t === 13 && !(w & 0x200000)) return this.ldstr(cpu, w, I, pc);
      return this.ldstm(cpu, w, I, pc);
    }
    return false;
  }
  isSysXfer(w) { return ((w >>> 24) & 15) === 14 && (w & 0x10) && ((w >>> 21) & 7) === 7 && (((w >>> 8) & 15) === 10); }

  // ---------------------------------------------------------------- system register transfers
  sysXfer(cpu, w, I, pc) {
    const reg = (w >>> 16) & 15, rt = (w >>> 12) & 15, load = (w >>> 20) & 1;
    if (load) { // VMRS
      let v;
      switch (reg) {
        case 0: v = this.fpsid; break; case 1: v = this.fpscr; break; case 6: v = this.mvfr1; break; case 7: v = this.mvfr0; break;
        case 8: v = this.fpexc; break; case 9: v = this.fpinst; break; case 10: v = this.fpinst2; break;
        default: return false;
      }
      if (rt === 15 && reg === 1) { cpu.N = (v >>> 31) & 1; cpu.Z = (v >>> 30) & 1; cpu.C = (v >>> 29) & 1; cpu.V = (v >>> 28) & 1; }
      else cpu.R[rt] = v | 0;
    } else {   // VMSR
      const v = cpu.R[rt] >>> 0;
      switch (reg) {
        case 0: break; case 1: this.fpscr = v; break;
        case 8: this.fpexc = v; break;
        case 9: this.fpinst = v; break; case 10: this.fpinst2 = v; break;
        default: return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- core <-> VFP transfers (bit4 = 1)
  xfer(cpu, w, I) {
    const cp11 = (w >>> 8) & 1, L = (w >>> 20) & 1, rt = (w >>> 12) & 15, opc1 = (w >>> 21) & 7;
    if (!cp11) {                                                        // single-precision register <-> core
      if (opc1 === 0 && ((w >>> 5) & 3) === 0 && (w & 15) === 0) {
        const n = (((w >>> 16) & 15) << 1) | ((w >>> 7) & 1);
        if (L) cpu.R[rt] = this.u[n] | 0; else this.u[n] = cpu.R[rt];
        return true;
      }
      return false;
    }
    // cp11: scalar moves / VDUP
    const opc2 = (w >>> 5) & 3;
    if ((w & 15) !== 0) return false;
    if (L === 0 && (opc1 & 4) && !(w & 0x00100000) && ((w >>> 23) & 1)) { // VDUP (core -> all lanes): 1110 1 B Q 0 Vd Rt 1011 D 0 E 1 0000
      const B = (w >>> 22) & 1, Q = (w >>> 21) & 1, E = (w >>> 5) & 1, d = (((w >>> 7) & 1) << 4) | ((w >>> 16) & 15), v = cpu.R[rt] >>> 0;
      const regs = Q ? 2 : 1, esz = B ? 1 : (E ? 2 : 4), n = 8 * regs / esz;
      if (B && E) return false;
      const tbl = this.b8, base = d * 8;
      for (let i = 0; i < n; i++) {
        if (esz === 1) tbl[base + i] = v & 255; else if (esz === 2) this.u16[(base >> 1) + i] = v & 0xFFFF; else this.u[(base >> 2) + i] = v;
      }
      return true;
    }
    const dn = (((w >>> 7) & 1) << 4) | ((w >>> 16) & 15);
    const o = (opc1 & 3) << 2 | opc2;   // bits 22:21 : 6:5
    let size, idx;
    if (o & 8) { size = 1; idx = o & 7; } else if (o & 1) { size = 2; idx = ((o >> 2) & 1) << 1 | ((o >> 1) & 1); } else if ((o & 3) === 0) { size = 4; idx = (o >> 2) & 1; } else return false;
    if (L) { // scalar -> core, U = bit 23
      const U = (w >>> 23) & 1; let v;
      if (size === 1) { v = this.b8[dn * 8 + idx]; if (!U) v = (v << 24) >> 24; }
      else if (size === 2) { v = this.u16[dn * 4 + idx]; if (!U) v = (v << 16) >> 16; }
      else v = this.u[dn * 2 + idx];
      cpu.R[rt] = v | 0;
    } else {
      const v = cpu.R[rt];
      if (size === 1) this.b8[dn * 8 + idx] = v & 255; else if (size === 2) this.u16[dn * 4 + idx] = v & 0xFFFF; else this.u[dn * 2 + idx] = v;
    }
    return true;
  }

  // VMOV two core registers <-> two singles / one double
  twoReg(cpu, w) {
    const L = (w >>> 20) & 1, rt = (w >>> 12) & 15, rt2 = (w >>> 16) & 15, dbl = (w >>> 8) & 1;
    if (dbl) {
      const m = (((w >>> 5) & 1) << 4) | (w & 15);
      if (L) { cpu.R[rt] = this.u[m * 2] | 0; cpu.R[rt2] = this.u[m * 2 + 1] | 0; } else { this.u[m * 2] = cpu.R[rt]; this.u[m * 2 + 1] = cpu.R[rt2]; }
    } else {
      const m = ((w & 15) << 1) | ((w >>> 5) & 1);
      if (m >= 31) return false;
      if (L) { cpu.R[rt] = this.u[m] | 0; cpu.R[rt2] = this.u[m + 1] | 0; } else { this.u[m] = cpu.R[rt]; this.u[m + 1] = cpu.R[rt2]; }
    }
    return true;
  }

  // ---------------------------------------------------------------- loads / stores
  base(cpu, rn, I, pc) { return rn === 15 ? (((pc + (I.thumb ? 4 : 8)) & ~3) >>> 0) : (cpu.R[rn] >>> 0); }
  ldstr(cpu, w, I, pc) {
    const U = (w >>> 23) & 1, L = (w >>> 20) & 1, rn = (w >>> 16) & 15, dbl = (w >>> 8) & 1, off = (w & 0xFF) << 2;
    const a = (this.base(cpu, rn, I, pc) + (U ? off : -off)) >>> 0;
    if (dbl) {
      const d = (((w >>> 22) & 1) << 4) | ((w >>> 12) & 15);
      if (L) { const lo = cpu.rd32(a), hi = cpu.rd32(a + 4); this.u[d * 2] = lo; this.u[d * 2 + 1] = hi; }
      else { cpu.wr32(a, this.u[d * 2]); cpu.wr32(a + 4, this.u[d * 2 + 1]); }
    } else {
      const d = (((w >>> 12) & 15) << 1) | ((w >>> 22) & 1);
      if (L) this.u[d] = cpu.rd32(a); else cpu.wr32(a, this.u[d]);
    }
    return true;
  }
  ldstm(cpu, w, I, pc) {
    const P = (w >>> 24) & 1, U = (w >>> 23) & 1, W = (w >>> 21) & 1, L = (w >>> 20) & 1, rn = (w >>> 16) & 15, dbl = (w >>> 8) & 1, imm = w & 0xFF;
    if (!((!P && U) || (P && !U && W))) return false;
    const dd = (((w >>> 22) & 1) << 4) | ((w >>> 12) & 15), sd = (((w >>> 12) & 15) << 1) | ((w >>> 22) & 1);
    let a = this.base(cpu, rn, I, pc); const start = P ? ((a - imm * 4) >>> 0) : a;
    let addr = start;
    const first = dbl ? dd * 2 : sd;
    if (first + imm > 64) return false;
    for (let i = 0; i < imm; i++, addr = (addr + 4) >>> 0) {
      if (L) this.u[first + i] = cpu.rd32(addr); else cpu.wr32(addr, this.u[first + i]);
    }
    if (W) cpu.R[rn] = P ? start | 0 : (a + imm * 4) | 0;
    return true;
  }

  // ---------------------------------------------------------------- data processing
  dataProc(cpu, w, I) {
    const dbl = (w >>> 8) & 1, p = (w >>> 23) & 1, q = (w >>> 21) & 1, r = (w >>> 20) & 1, s = (w >>> 6) & 1;
    const d1 = (w >>> 22) & 1, n1 = (w >>> 7) & 1, m1 = (w >>> 5) & 1;
    let d, n, m;
    if (dbl) { d = (d1 << 4) | ((w >>> 12) & 15); n = (n1 << 4) | ((w >>> 16) & 15); m = (m1 << 4) | (w & 15); }
    else { d = (((w >>> 12) & 15) << 1) | d1; n = (((w >>> 16) & 15) << 1) | n1; m = ((w & 15) << 1) | m1; }
    const F = dbl ? this.f64 : this.f32;
    const rd = dbl ? (x => x) : Math.fround;
    const op = (p << 2) | (q << 1) | r;
    switch (op) {
      case 0: { const pr = rd(F[n] * F[m]); F[d] = s ? rd(F[d] - pr) : rd(F[d] + pr); return true; }          // VMLA / VMLS
      case 1: { const pr = rd(F[n] * F[m]); F[d] = s ? rd(-F[d] - pr) : rd(pr - F[d]); return true; }         // VNMLA (s=1) / VNMLS (s=0)
      case 2: { const pr = rd(F[n] * F[m]); F[d] = s ? -pr : pr; return true; }                               // VMUL / VNMUL
      case 3: F[d] = s ? rd(F[n] - F[m]) : rd(F[n] + F[m]); return true;                                      // VADD / VSUB
      case 4: F[d] = rd(F[n] / F[m]); return true;                                                           // VDIV
      case 7: return this.extDP(cpu, w, dbl, d, m, F, rd);
      default: return false;
    }
  }
  extDP(cpu, w, dbl, d, m, F, rd) {
    const opc2 = (w >>> 16) & 15, opc3 = (w >>> 6) & 3;
    if ((w & 0xF0) === 0) {                                              // VMOV immediate
      const imm8 = (((w >>> 16) & 15) << 4) | (w & 15), sign = (imm8 >>> 7) & 1, b = (imm8 >>> 6) & 1;
      if (dbl) {
        this.u[d * 2] = 0;
        this.u[d * 2 + 1] = ((sign << 31) | ((b ^ 1) << 30) | ((b ? 0xFF : 0) << 22) | (((imm8 >>> 4) & 3) << 20) | ((imm8 & 15) << 16)) >>> 0;
      } else {
        this.u[d] = ((sign << 31) | ((b ^ 1) << 30) | ((b ? 0x1F : 0) << 25) | (((imm8 >>> 4) & 3) << 23) | ((imm8 & 15) << 19)) >>> 0;
      }
      return true;
    }
    switch (opc2) {
      case 0:
        if (opc3 === 1) { if (dbl) { this.u[d * 2] = this.u[m * 2]; this.u[d * 2 + 1] = this.u[m * 2 + 1]; } else this.u[d] = this.u[m]; return true; }     // VMOV reg
        if (opc3 === 3) { if (dbl) { const hi = this.u[m * 2 + 1] & 0x7FFFFFFF, lo = this.u[m * 2]; this.u[d * 2] = lo; this.u[d * 2 + 1] = hi; } else this.u[d] = this.u[m] & 0x7FFFFFFF; return true; } // VABS
        return false;
      case 1:
        if (opc3 === 1) { if (dbl) { const hi = (this.u[m * 2 + 1] ^ 0x80000000) >>> 0, lo = this.u[m * 2]; this.u[d * 2] = lo; this.u[d * 2 + 1] = hi; } else this.u[d] = (this.u[m] ^ 0x80000000) >>> 0; return true; } // VNEG
        if (opc3 === 3) { F[d] = rd(Math.sqrt(F[m])); return true; }                                                                                         // VSQRT
        return false;
      case 4: case 5: {                                                  // VCMP / VCMPE
        if (!(opc3 & 1)) return false;
        const a = F[d], b = opc2 === 5 ? 0 : F[m]; let fl;
        if (a !== a || b !== b) fl = 3; else if (a === b) fl = 6; else if (a < b) fl = 8; else fl = 2;
        this.fpscr = ((this.fpscr & 0x0FFFFFFF) | (fl << 28)) >>> 0; return true;
      }
      case 7:
        if (opc3 === 3) {                                                // VCVT double <-> single
          if (dbl) { this.f32[((((w >>> 12) & 15) << 1) | ((w >>> 22) & 1))] = this.f64[(((w >>> 5) & 1) << 4) | (w & 15)]; }
          else { this.f64[(((w >>> 22) & 1) << 4) | ((w >>> 12) & 15)] = this.f32[((w & 15) << 1) | ((w >>> 5) & 1)]; }
          return true;
        }
        return false;
      case 8: {                                                          // VCVT int -> float
        if (!(opc3 & 1)) return false;
        const sm = ((w & 15) << 1) | ((w >>> 5) & 1), sgn = (w >>> 7) & 1;
        const v = sgn ? this.i32[sm] : this.u[sm];
        if (dbl) this.f64[(((w >>> 22) & 1) << 4) | ((w >>> 12) & 15)] = v; else this.f32[(((w >>> 12) & 15) << 1) | ((w >>> 22) & 1)] = v;
        return true;
      }
      case 10: case 11: case 14: case 15: {                              // VCVT float <-> fixed
        if (!(opc3 & 1)) return false;
        const toFixed = opc2 >= 14, uns = opc2 & 1, sx = (w >>> 7) & 1, size = sx ? 32 : 16;
        const imm5 = ((w & 15) << 1) | ((w >>> 5) & 1), frac = size - imm5; if (frac < 0) return false;
        const dd = dbl ? (((w >>> 22) & 1) << 4) | ((w >>> 12) & 15) : (((w >>> 12) & 15) << 1) | ((w >>> 22) & 1);
        const sc = Math.pow(2, frac);
        if (toFixed) {
          let v = F[dd] * sc; v = v !== v ? 0 : Math.trunc(v);
          let lo, hi;
          if (uns) { lo = 0; hi = size === 32 ? 4294967295 : 65535; } else { lo = size === 32 ? -2147483648 : -32768; hi = size === 32 ? 2147483647 : 32767; }
          if (v < lo) v = lo; if (v > hi) v = hi;
          const wi = dbl ? dd * 2 : dd;
          if (size === 32) this.u[wi] = v >>> 0; else this.u[wi] = ((this.u[wi] & 0xFFFF0000) | (v & 0xFFFF)) >>> 0;
        } else {
          const raw = this.u[dbl ? dd * 2 : dd]; let v;
          if (size === 16) v = uns ? (raw & 0xFFFF) : ((raw << 16) >> 16); else v = uns ? raw : (raw | 0);
          F[dd] = rd(v / sc);
        }
        return true;
      }
      case 12: case 13: {                                                // VCVT float -> int
        if (!(opc3 & 1)) return false;
        const src = dbl ? this.f64[(((w >>> 5) & 1) << 4) | (w & 15)] : this.f32[((w & 15) << 1) | ((w >>> 5) & 1)];
        const dsn = (((w >>> 12) & 15) << 1) | ((w >>> 22) & 1), sgn = opc2 & 1, rz = (w >>> 7) & 1;
        let v = src;
        if (v !== v) v = 0; else {
          const rm = rz ? 3 : ((this.fpscr >>> 22) & 3);
          if (rm === 3) v = Math.trunc(v);
          else if (rm === 0) { const fl = Math.floor(v), df = v - fl; v = df > 0.5 ? fl + 1 : df < 0.5 ? fl : (fl % 2 === 0 ? fl : fl + 1); }
          else if (rm === 1) v = Math.ceil(v); else v = Math.floor(v);
        }
        if (sgn) { if (v > 2147483647) v = 2147483647; if (v < -2147483648) v = -2147483648; this.i32[dsn] = v; }
        else { if (v > 4294967295) v = 4294967295; if (v < 0) v = 0; this.u[dsn] = v; }
        return true;
      }
      default: return false;
    }
  }

  // ---------------------------------------------------------------- NEON
  neon(cpu, w, I, pc) {
    if ((w >>> 24) === 0xF4) return this.neonLdSt(cpu, w);
    if (!this.unimpl.has(w >>> 0 & 0xFFB00FF0)) { this.unimpl.add(w >>> 0 & 0xFFB00FF0); if (cpu.log) cpu.log('NEON unimplemented ' + (w >>> 0).toString(16).padStart(8, '0') + ' @pc=' + (pc >>> 0).toString(16)); }
    return false;
  }
  neonLdSt(cpu, w) {
    const L = (w >>> 21) & 1;
    if (w & 0x800000) return this.neonLdStSingle(cpu, w);
    const d = (((w >>> 22) & 1) << 4) | ((w >>> 12) & 15), rn = (w >>> 16) & 15, rm = w & 15, type = (w >>> 8) & 15;
    const esz = 1 << ((w >>> 6) & 3);
    let addr = cpu.R[rn] >>> 0; const start = addr;
    let regs = 0;
    switch (type) { case 7: regs = 1; break; case 10: regs = 2; break; case 6: regs = 3; break; case 2: regs = 4; break; }
    if (regs) {                                                           // VLD1/VST1: plain 64-bit chunks
      if (L) for (let i = 0; i < regs * 2; i++) this.u[d * 2 + i] = cpu.rd32(addr + i * 4);
      else for (let i = 0; i < regs * 2; i++) cpu.wr32(addr + i * 4, this.u[d * 2 + i]);
      addr += regs * 8;
    } else {                                                              // VLD2/3/4 (multiple structures), interleaved
      let nelem, inc = 1, groups = 1;
      switch (type) {
        case 8: nelem = 2; break; case 9: nelem = 2; inc = 2; break; case 3: nelem = 2; groups = 2; break;
        case 4: nelem = 3; break; case 5: nelem = 3; inc = 2; break;
        case 0: nelem = 4; break; case 1: nelem = 4; inc = 2; break;
        default: return false;
      }
      const lanes = 8 / esz;
      for (let g = 0; g < groups; g++) for (let k = 0; k < lanes; k++) for (let e = 0; e < nelem; e++) {
        const o = (d + g * 2 + e * inc) * 8 + k * esz;
        if (L) for (let b = 0; b < esz; b++) this.b8[o + b] = cpu.rd8(addr + b); else for (let b = 0; b < esz; b++) cpu.wr8(addr + b, this.b8[o + b]);
        addr += esz;
      }
    }
    this.wb(cpu, rn, rm, start, addr - start);
    return true;
  }
  wb(cpu, rn, rm, start, bytes) {
    if (rm === 15) return;
    cpu.R[rn] = rm === 13 ? (start + bytes) | 0 : (start + cpu.R[rm]) | 0;
  }
  neonLdStSingle(cpu, w) {
    const L = (w >>> 21) & 1, d = (((w >>> 22) & 1) << 4) | ((w >>> 12) & 15), rn = (w >>> 16) & 15, rm = w & 15, size = (w >>> 10) & 3;
    const nelem = ((w >>> 8) & 3) + 1;
    let addr = cpu.R[rn] >>> 0; const start = addr;
    if (size === 3) {                                                     // load one element to all lanes
      if (!L) return false;
      const esz = 1 << ((w >>> 6) & 3), T = (w >>> 5) & 1;
      for (let e = 0; e < nelem; e++) {
        let val = 0; for (let b = 0; b < esz; b++) val |= cpu.rd8(addr + b) << (8 * b);
        addr += esz;
        const regsToFill = nelem === 1 ? (T ? 2 : 1) : 1, base = nelem === 1 ? d : d + e * (T ? 2 : 1);
        for (let r = 0; r < regsToFill; r++) for (let k = 0; k < 8 / esz; k++) { const o = (base + r) * 8 + k * esz; for (let b = 0; b < esz; b++) this.b8[o + b] = (val >>> (8 * b)) & 255; }
      }
    } else {
      const esz = 1 << size;
      const sp = size === 0 ? 1 : size === 1 ? (((w >>> 5) & 1) ? 2 : 1) : (((w >>> 6) & 1) ? 2 : 1);
      const lane = size === 0 ? (w >>> 5) & 7 : size === 1 ? (w >>> 6) & 3 : (w >>> 7) & 1;
      for (let e = 0; e < nelem; e++) {
        const o = (d + e * sp) * 8 + lane * esz;
        if (L) for (let b = 0; b < esz; b++) this.b8[o + b] = cpu.rd8(addr + b); else for (let b = 0; b < esz; b++) cpu.wr8(addr + b, this.b8[o + b]);
        addr += esz;
      }
    }
    this.wb(cpu, rn, rm, start, addr - start);
    return true;
  }
}
module.exports = { VFP };
