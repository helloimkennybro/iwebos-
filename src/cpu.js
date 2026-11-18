'use strict';
// iWebOS CPU: ARMv7-A (Cortex-A8 class) interpreter. Privileged modes, banked registers, CP15 MMU/TLB, exceptions.
const { VFP } = require('./vfp.js');
const { O, Inst, decodeARM, decodeThumb } = require('./decode.js');
const { compile } = require('./jit.js');
const wasmjit = require('./wasmjit.js');
const JIT_HOT = 300, JIT_MAX = 400000; // a block is compiled once it has been entered 1000 times (cold code stays in the interpreter: thousands of lukewarm generated functions thrash the CPU cache and V8's tiers); the whole code cache is flushed past JIT_MAX instructions
const IC_MASK = (1 << 17) - 1; // decoded-instruction cache: direct mapped, validated by the instruction word itself (self-modifying code safe)

const M_USR = 0x10, M_FIQ = 0x11, M_IRQ = 0x12, M_SVC = 0x13, M_MON = 0x16, M_ABT = 0x17, M_UND = 0x1B, M_SYS = 0x1F;
const BANK = { 0x10: 0, 0x1F: 0, 0x11: 1, 0x12: 2, 0x13: 3, 0x16: 4, 0x17: 5, 0x1B: 6 };

class Abort { constructor(kind, va, fs, domain, write) { this.kind = kind; this.va = va; this.fs = fs; this.domain = domain; this.write = write; } }
class Halt { constructor(why) { this.why = why; } }

const ROR = (x, n) => (n & 31) ? ((x >>> (n & 31)) | (x << (32 - (n & 31)))) : x;

class CPU {
  constructor(ram, bus) {
    this.ram = ram; this.bus = bus; this.rb = ram.base; this.rs = ram.size;
    this.R = new Int32Array(ram.buffer, 0, 16);        // registers live at the start of the shared memory (see CTX in mem.js)
    this.N = 0; this.Z = 0; this.C = 0; this.V = 0; this.Q = 0; this.GE = 0; this.T = 0; this.IT = 0;
    this.I = 1; this.F = 1; this.A = 1; this.E = 0; this.mode = M_SVC; this.priv = 1;
    this.bankSP = new Int32Array(7); this.bankLR = new Int32Array(7); this.spsr = new Int32Array(7);
    this.fiqR = new Int32Array(5); this.usrR = new Int32Array(5);
    // CP15
    this.sctlr = 0x00C50078; this.actlr = 0; this.cpacr = 0; this.ttbr0 = 0; this.ttbr1 = 0; this.ttbcr = 0; this.dacr = 0;
    this.dfsr = 0; this.ifsr = 0; this.dfar = 0; this.ifar = 0; this.vbar = 0; this.contextidr = 0; this.fcse = 0;
    this.tpidrurw = 0; this.tpidruro = 0; this.tpidrprw = 0; this.prrr = 0; this.nmrr = 0; this.csselr = 0; this.par = 0;
    this.auxl2 = 0; this.pmcr = 0;
    // TLB: index = ((kind*2+priv)<<10) | (vpn&1023); kind 0=read 1=write 2=exec
    this.ttag = new Int32Array(8192).fill(-1); this.tpa = new Uint32Array(8192);
    this.tr = 1024; this.tw = 3072; this.tx = 5120; // priv=1 bases (kind*2+priv)*1024
    this.fvpn = -1; this.fpage = null; this.fidx = 0;
    this.drT = new Int32Array(ram.buffer, 0x1000, 1024).fill(-1); this.drA = new Int32Array(ram.buffer, 0x2000, 1024); this.dr8 = new Array(1024); this.dr16 = new Array(1024); this.dr32 = new Array(1024); this.drO = new Int32Array(1024);
    this.dwT = new Int32Array(ram.buffer, 0x3000, 1024).fill(-1); this.dwA = new Int32Array(ram.buffer, 0x4000, 1024); this.dw8 = new Array(1024); this.dw16 = new Array(1024); this.dw32 = new Array(1024); this.dwO = new Int32Array(1024);
    ram.onSweep = () => { this.fvpn = -1; this.drFlush(); this.dwFlush(); };
    this.ldmVals = new Int32Array(16); this.seqPc = -1; this.hleKey = new Int32Array(8192); this.hleFn = new Array(8192).fill(null); this.hleName = new Array(8192).fill(null); this.hleStats = {}; this.hleOn = true; this.jitCheck = null; this.jitEnabled = true; this.jitBackend = ram.wmem ? 'wasm' : 'js'; this.F64 = new Float64Array(ram.buffer, 88, 3); this.M32 = new Int32Array(ram.buffer, 0, 32); this._ws = null;
    this.XTv = new Int32Array(ram.buffer, wasmjit.XT, 1024).fill(-1); this.XFv = new Int32Array(ram.buffer, wasmjit.XF, 1024);
    this.HKv = new Int32Array(ram.buffer, wasmjit.HK, 65536).fill(-1); this.HIv = new Int32Array(ram.buffer, wasmjit.HI, 65536); this.HNv = new Int32Array(ram.buffer, wasmjit.HN, 65536);
    this.wtable = null; this.wnext = 0; this.wblocks = []; this.wpending = []; this.wpendSince = 0; this.wasmBatch = 32; this.frameBlocks = []; this.wdispatch = null; this.inWasm = false;
    if (this.jitBackend === 'wasm') { try { this.wtable = new WebAssembly.Table({ element: 'anyfunc', initial: 4096 }); this.wdispatch = wasmjit.buildDispatcher(this); } catch (e) { this.jitBackend = 'js'; } } this.jitHot = JIT_HOT; this.jitCount = 0; this.jb = null; this.jc0 = 0; this.xb = 0; this.ffr = 0;
    this.jtA = []; this.jtT = []; this.jitStats = { blocks: 0, insts: 0, runs: 0, failed: 0, ex: 0, wasm: 0, wasmFail: 0, ms: 0 };
    this.ic = new Array(IC_MASK + 1); this.I_ = new Inst(); this.npc = 0; this.pcv = 0; this.inIT = false;
    this.irq = false; this.fiq = false; this.wfi = false; this.exAddr = -1;
    this.cycles = 0; this.trace = null; this.log = null; this.stats = { undef: 0, vfp: 0, svc: 0, dabt: 0, pabt: 0, irq: 0, cp15unk: 0 };
    this.hookPC = -1; this.hookFn = null; this.idlePC = -1; this.idleHit = false; this.idleResume = false; this.vfp = new VFP(); this.vfpEnabled = false; this.breakAt = -1; this.hitBreak = false;
    this._sc = 0; this._cy = 0; this._ov = 0; this.mh = 0; this.ml = 0;
    this.undefHook = null;
  }

  // ------------------------------------------------------------ CPSR / modes
  getCPSR() {
    const it = this.IT;
    return ((this.N << 31) | (this.Z << 30) | (this.C << 29) | (this.V << 28) | (this.Q << 27) | ((it & 3) << 25) | (this.GE << 16) |
      ((it >>> 2) << 10) | (this.E << 9) | (this.A << 8) | (this.I << 7) | (this.F << 6) | (this.T << 5) | this.mode) | 0;
  }
  setCPSRraw(v) { // full write incl. mode switch (exception return, reset)
    this.xb = 1;
    this.N = v >>> 31; this.Z = (v >>> 30) & 1; this.C = (v >>> 29) & 1; this.V = (v >>> 28) & 1; this.Q = (v >>> 27) & 1;
    this.GE = (v >>> 16) & 15; this.IT = ((v >>> 10) & 0x3F) << 2 | ((v >>> 25) & 3); this.E = (v >>> 9) & 1;
    this.A = (v >>> 8) & 1; this.I = (v >>> 7) & 1; this.F = (v >>> 6) & 1; this.T = (v >>> 5) & 1;
    this.switchMode(v & 31);
  }
  switchMode(nm) {
    this.xb = 1;
    const ob = BANK[this.mode], nb = BANK[nm];
    if (nb === undefined) nm = M_SVC; // invalid mode: unpredictable, pick SVC
    const nb2 = BANK[nm];
    if (ob !== nb2) {
      const R = this.R;
      this.bankSP[ob] = R[13]; this.bankLR[ob] = R[14];
      if (ob === 1) { for (let i = 0; i < 5; i++) { this.fiqR[i] = R[8 + i]; R[8 + i] = this.usrR[i]; } }
      if (nb2 === 1) { for (let i = 0; i < 5; i++) { this.usrR[i] = R[8 + i]; R[8 + i] = this.fiqR[i]; } }
      R[13] = this.bankSP[nb2]; R[14] = this.bankLR[nb2];
    }
    this.mode = nm; this.setPriv(nm !== M_USR ? 1 : 0);
  }
  setPriv(p) { if (p === this.priv && this.privInit) return; this.privInit = true; this.priv = p; this.tr = p ? 1024 : 0; this.tw = p ? 3072 : 2048; this.tx = p ? 5120 : 4096; this.fvpn = -1; this.XTv.fill(-1); this.drFlush(); this.dwFlush(); }
  curBank() { return BANK[this.mode]; }
  getUserReg(n) { // for LDM/STM with S bit from privileged mode
    if (this.mode === M_USR || this.mode === M_SYS) return this.R[n];
    if (n < 8 || (n < 13 && this.mode !== M_FIQ)) return this.R[n];
    if (n < 13) return this.usrR[n - 8];
    return n === 13 ? this.bankSP[0] : this.bankLR[0];
  }
  setUserReg(n, v) {
    if (this.mode === M_USR || this.mode === M_SYS) { this.R[n] = v; return; }
    if (n < 8 || (n < 13 && this.mode !== M_FIQ)) { this.R[n] = v; return; }
    if (n < 13) { this.usrR[n - 8] = v; return; }
    if (n === 13) this.bankSP[0] = v; else this.bankLR[0] = v;
  }
  condPass(c) {
    let r;
    switch (c >>> 1) {
      case 0: r = this.Z === 1; break; case 1: r = this.C === 1; break; case 2: r = this.N === 1; break; case 3: r = this.V === 1; break;
      case 4: r = this.C === 1 && this.Z === 0; break; case 5: r = this.N === this.V; break;
      case 6: r = this.N === this.V && this.Z === 0; break; default: return true;
    }
    return (c & 1) ? !r : r;
  }

  // ------------------------------------------------------------ exceptions
  vecBase() { return (this.sctlr & 0x2000) ? 0xFFFF0000 : this.vbar >>> 0; }
  enter(vec, mode, lr, fiq) {
    this.xb = 1;
    const old = this.getCPSR();
    this.switchMode(mode);
    this.spsr[BANK[mode]] = old;
    this.R[14] = lr | 0;
    this.T = (this.sctlr >>> 30) & 1; this.IT = 0; this.E = (this.sctlr >>> 25) & 1; this.I = 1;
    if (fiq) this.F = 1; if (mode === M_ABT) this.A = 1;
    this.npc = (this.vecBase() + vec) >>> 0; this.exAddr = -1;
  }
  undef(pc, len) { this.stats.undef++; if (this.undefHook) this.undefHook(pc, this.I_); this.enter(0x04, M_UND, pc + len, false); }
  handleAbort(a, pc) {
    if (this.abortHook) this.abortHook(a, pc);
    if (this.log) this.log((a.kind === 2 ? 'PREFETCH ABORT' : (a.write ? 'DATA ABORT (write)' : 'DATA ABORT (read)')) + ' va=0x' + (a.va >>> 0).toString(16) + ' fsr=0x' + a.fs.toString(16) + ' domain=' + a.domain + ' pc=0x' + pc.toString(16) + ' lr=0x' + (this.R[14] >>> 0).toString(16));
    if (a.kind === 2) { this.ifar = a.va | 0; this.ifsr = (a.fs & 15) | ((a.fs & 16) << 6) | (a.domain << 4); this.stats.pabt++; this.enter(0x0C, M_ABT, pc + 4, false); }
    else { this.dfar = a.va | 0; this.dfsr = (a.fs & 15) | ((a.fs & 16) << 6) | (a.domain << 4) | (a.write ? 0x800 : 0); this.stats.dabt++; this.enter(0x10, M_ABT, pc + 8, false); }
    this.R[15] = this.npc | 0;
  }

  // ------------------------------------------------------------ MMU
  flushTLB() { this.xb = 1; this.ttag.fill(-1); this.fvpn = -1; this.XTv.fill(-1); this.drFlush(); this.dwFlush(); }
  xlate(va, kind, priv) {
    va >>>= 0;
    const vpn = va >>> 12;
    if (!(this.sctlr & 1)) { const pa = va & ~0xFFF; this.fill(vpn, pa, kind, priv); return (pa | (va & 0xFFF)) >>> 0; }
    const n = this.ttbcr & 7;
    let tbase, idx = va >>> 20;
    if (n === 0 || (va >>> (32 - n)) === 0) { tbase = (this.ttbr0 >>> 0) & (0xFFFFFFFF << (14 - n)) >>> 0; tbase = ((this.ttbr0 >>> 0) >>> (14 - n)) << (14 - n) >>> 0; }
    else { tbase = ((this.ttbr1 >>> 0) >>> 14) << 14 >>> 0; }
    const l1 = this.pr32((tbase + idx * 4) >>> 0) >>> 0;
    const wr = kind === 1;
    let domain, ap, xn, base, sect;
    switch (l1 & 3) {
      case 0: case 3: throw new Abort(kind, va, 0x05, 0, wr);
      case 1: {
        domain = (l1 >>> 5) & 15;
        const l2a = ((l1 & 0xFFFFFC00) + ((va >>> 12) & 0xFF) * 4) >>> 0;
        const dac = (this.dacr >>> (domain * 2)) & 3;
        if (dac === 0 || dac === 2) throw new Abort(kind, va, 0x0B, domain, wr);
        const l2 = this.pr32(l2a) >>> 0;
        if ((l2 & 3) === 0) throw new Abort(kind, va, 0x07, domain, wr);
        if ((l2 & 3) === 1) { // large page 64KB
          base = (l2 & 0xFFFF0000) >>> 0; xn = (l2 >>> 15) & 1; base = (base | (va & 0xF000)) >>> 0;
        } else { base = (l2 & 0xFFFFF000) >>> 0; xn = l2 & 1; }
        ap = ((l2 >>> 4) & 3) | (((l2 >>> 9) & 1) << 2); sect = false;
        return this.finish(va, kind, priv, domain, dac, ap, xn, base, sect);
      }
      default: { // section / supersection
        domain = (l1 >>> 5) & 15; const dac = (this.dacr >>> (domain * 2)) & 3;
        if (dac === 0 || dac === 2) throw new Abort(kind, va, 0x09, domain, wr);
        ap = ((l1 >>> 10) & 3) | (((l1 >>> 15) & 1) << 2); xn = (l1 >>> 4) & 1;
        if (l1 & 0x40000) base = ((l1 & 0xFF000000) | (va & 0x00FFF000)) >>> 0; // supersection (24-bit)
        else base = ((l1 & 0xFFF00000) | (va & 0x000FF000)) >>> 0;
        return this.finish(va, kind, priv, domain, dac, ap, xn, base, true);
      }
    }
  }
  finish(va, kind, priv, domain, dac, ap, xn, pagebase, sect) {
    const wr = kind === 1;
    if (dac === 1) { // client: check permissions
      let rdok, wrok;
      switch (ap) {
        case 0: rdok = wrok = false; break;
        case 1: rdok = wrok = priv === 1; break;
        case 2: rdok = priv === 1 || true; wrok = priv === 1; break;
        case 3: rdok = wrok = true; break;
        case 5: rdok = priv === 1; wrok = false; break;
        case 6: case 7: rdok = true; wrok = false; break;
        default: rdok = wrok = false;
      }
      if (kind === 2) { if (!rdok || xn) throw new Abort(2, va, sect ? 0x0D : 0x0F, domain, false); }
      else if (wr ? !wrok : !rdok) throw new Abort(kind, va, sect ? 0x0D : 0x0F, domain, wr);
    }
    this.fill(va >>> 12, pagebase & ~0xFFF, kind, priv);
    return (pagebase | (va & 0xFFF)) >>> 0;
  }
  fill(vpn, pa, kind, priv) {
    const i = ((kind * 2 + priv) << 10) | (vpn & 1023); this.ttag[i] = vpn; this.tpa[i] = pa >>> 0;
  }

  // ------------------------------------------------------------ physical access
  pr8(pa) { const o = (pa - this.rb) >>> 0; if (o < this.rs) return this.ram.r8(o); this.xb = 1; return this.bus.read(pa, 1); }
  pr16(pa) { const o = (pa - this.rb) >>> 0; if (o < this.rs) return this.ram.r16(o); this.xb = 1; return this.bus.read(pa, 2); }
  pr32(pa) { const o = (pa - this.rb) >>> 0; if (o < this.rs) { const p = this.ram.R32[o >>> 16]; return (p !== undefined ? p[(o & 0xFFFF) >>> 2] : this.ram.r32(o)) | 0; } this.xb = 1; return this.bus.read(pa, 4) | 0; }
  pw8(pa, v) { const o = (pa - this.rb) >>> 0; if (o < this.rs) this.ram.w8(o, v); else { this.xb = 1; this.bus.write(pa, 1, v); } }
  pw16(pa, v) { const o = (pa - this.rb) >>> 0; if (o < this.rs) this.ram.w16(o, v); else { this.xb = 1; this.bus.write(pa, 2, v); } }
  pw32(pa, v) { const o = (pa - this.rb) >>> 0; if (o < this.rs) { const p = this.ram.W32[o >>> 16]; if (p !== undefined) p[(o & 0xFFFF) >>> 2] = v; else this.ram.w32(o, v); } else { this.xb = 1; this.bus.write(pa, 4, v); } }

  // ------------------------------------------------------------ virtual access
  tl(va, kind) { // translate for current privilege view
    const base = kind === 0 ? this.tr : kind === 1 ? this.tw : this.tx;
    const i = base | ((va >>> 12) & 1023);
    if (this.ttag[i] === (va >>> 12)) return (this.tpa[i] | (va & 0xFFF)) >>> 0;
    return this.xlate(va, kind, base >= 3072 || (base >= 1024 && base < 2048) || (base >= 5120) ? 1 : 0);
  }
  // ---- data accesses. Fast path: a 1024-entry direct-mapped cache vpn -> views of the RAM page backing it (read and write sides).
  // Flushed with the TLB, on privilege change, on RAM sweeps and when a page becomes code. MMIO is never cached.
  drFlush() { this.drT.fill(-1); }
  dwFlush() { this.dwT.fill(-1); }
  rd8(va) {
    const vpn = va >>> 12, s = vpn & 1023;
    if (this.drT[s] === vpn) return this.dr8[s][((this.drO[s] << 2) + (va & 0xFFF))];
    return this.rd8s(va);
  }
  rd8s(va) {
    const pa = this.tl(va, 0), o = (pa - this.rb) >>> 0;
    if (o < this.rs) { this.drFill(va, o); return this.ram.r8(o); }
    this.xb = 1; return this.bus.read(pa, 1);
  }
  drFill(va, o) {
    const ram = this.ram, pg = o >>> 16;
    if (!ram.R8[pg]) ram.mapR(pg);
    const vpn = va >>> 12, s = vpn & 1023;
    this.drT[s] = vpn; this.drA[s] = ram.addrOf(o & ~0xFFF); this.dr8[s] = ram.R8[pg]; this.dr16[s] = ram.R16[pg]; this.dr32[s] = ram.R32[pg]; this.drO[s] = (o & 0xF000) >>> 2;
  }
  dwFill(va, o) {
    const ram = this.ram, pg = o >>> 16;
    if (ram.codePg[pg]) return;
    if (!ram.W8[pg]) ram.mapW(pg);
    const vpn = va >>> 12, s = vpn & 1023;
    this.dwT[s] = vpn; this.dwA[s] = ram.addrOf(o & ~0xFFF); this.dw8[s] = ram.W8[pg]; this.dw16[s] = ram.W16[pg]; this.dw32[s] = ram.W32[pg]; this.dwO[s] = (o & 0xF000) >>> 2;
  }
  rd16(va) {
    const vpn = va >>> 12, s = vpn & 1023;
    if (this.drT[s] === vpn && (va & 1) === 0) return this.dr16[s][((this.drO[s] << 1) + ((va & 0xFFF) >>> 1))];
    return this.rd16s(va);
  }
  rd16s(va) {
    if (va & 1) return this.rd8(va) | (this.rd8(va + 1) << 8);
    const pa = this.tl(va, 0), o = (pa - this.rb) >>> 0;
    if (o < this.rs) { this.drFill(va, o); return this.ram.r16(o); }
    this.xb = 1; return this.bus.read(pa, 2);
  }
  rd32(va) {
    const vpn = va >>> 12, s = vpn & 1023;
    if (this.drT[s] === vpn && (va & 3) === 0) return this.dr32[s][this.drO[s] + ((va & 0xFFF) >>> 2)] | 0;
    return this.rd32s(va);
  }
  rd32s(va) {
    if (va & 3) { if ((va & 0xFFF) <= 0xFFC) { const pa = this.tl(va, 0); return (this.pr8(pa) | (this.pr8(pa + 1) << 8) | (this.pr8(pa + 2) << 16) | (this.pr8(pa + 3) << 24)) | 0; }
      return (this.rd8(va) | (this.rd8(va + 1) << 8) | (this.rd8(va + 2) << 16) | (this.rd8(va + 3) << 24)) | 0; }
    const pa = this.tl(va, 0), o = (pa - this.rb) >>> 0;
    if (o < this.rs) { this.drFill(va, o); return this.ram.r32(o) | 0; }
    this.xb = 1; return this.bus.read(pa, 4) | 0;
  }
  wr8(va, v) {
    const vpn = va >>> 12, s = vpn & 1023;
    if (this.dwT[s] === vpn) { this.dw8[s][((this.dwO[s] << 2) + (va & 0xFFF))] = v; return; }
    const pa = this.tl(va, 1), o = (pa - this.rb) >>> 0;
    if (o < this.rs) { this.dwFill(va, o); this.ram.w8(o, v & 255); } else { this.xb = 1; this.bus.write(pa, 1, v & 255); }
  }
  wr16(va, v) {
    const vpn = va >>> 12, s = vpn & 1023;
    if (this.dwT[s] === vpn && (va & 1) === 0) { this.dw16[s][((this.dwO[s] << 1) + ((va & 0xFFF) >>> 1))] = v; return; }
    if (va & 1) { this.wr8(va, v); this.wr8(va + 1, v >>> 8); return; }
    const pa = this.tl(va, 1), o = (pa - this.rb) >>> 0;
    if (o < this.rs) { this.dwFill(va, o); this.ram.w16(o, v & 0xFFFF); } else { this.xb = 1; this.bus.write(pa, 2, v & 0xFFFF); }
  }
  wr32(va, v) {
    const vpn = va >>> 12, s = vpn & 1023;
    if (this.dwT[s] === vpn && (va & 3) === 0) { this.dw32[s][this.dwO[s] + ((va & 0xFFF) >>> 2)] = v; return; }
    if (va & 3) { this.tl(va, 1); this.tl(va + 3, 1); this.wr8(va, v); this.wr8(va + 1, v >>> 8); this.wr8(va + 2, v >>> 16); this.wr8(va + 3, v >>> 24); return; }
    const pa = this.tl(va, 1), o = (pa - this.rb) >>> 0;
    if (o < this.rs) { this.dwFill(va, o); this.ram.w32(o, v); } else { this.xb = 1; this.bus.write(pa, 4, v); }
  }
  // user-privilege access view (LDRT/STRT)
  withUser(f) {
    const sr = this.tr, sw = this.tw, sx = this.tx; this.tr = 0; this.tw = 2048; this.tx = 4096; this.drFlush(); this.dwFlush();
    try { return f(); } finally { this.tr = sr; this.tw = sw; this.tx = sx; this.drFlush(); this.dwFlush(); }
  }

  fetch16(va) {
    const vpn = va >>> 12;
    if (vpn === this.fvpn) return this.fpage[((va & 0xFFF) >>> 1) + this.fidx];
    const pa = this.tl(va, 2);
    const o = (pa - this.rb) >>> 0;
    if (o < this.rs) {
      const pg = o >>> 16; let p = this.ram.R16[pg]; if (!p) { this.ram.mapR(pg); p = this.ram.R16[pg]; }
      this.fvpn = vpn; this.fpage = p; this.fidx = (o & 0xF000) >>> 1; this.ffr = o >>> 12; this.XTv[vpn & 1023] = vpn; this.XFv[vpn & 1023] = o >>> 12;
      return p[((va & 0xFFF) >>> 1) + this.fidx];
    }
    return this.bus.read(pa, 2);
  }
  fetch32(va) {
    const vpn = va >>> 12;
    if (vpn === this.fvpn && !(va & 2)) { const k = ((va & 0xFFF) >>> 1) + this.fidx; return (this.fpage[k] | (this.fpage[k + 1] << 16)) | 0; }
    const lo = this.fetch16(va); return (lo | (this.fetch16(va + 2) << 16)) | 0;
  }

  // ------------------------------------------------------------ ALU helpers
  addc(a, b, c) { const r = (a >>> 0) + (b >>> 0) + c; const res = r | 0; this._cy = r > 0xFFFFFFFF ? 1 : 0; this._ov = ((a ^ res) & (b ^ res)) >>> 31; return res; }
  shiftC(v, type, amt, cin) {
    switch (type) {
      case 0: if (amt === 0) { this._sc = cin; return v; } if (amt < 32) { this._sc = (v >>> (32 - amt)) & 1; return v << amt; } if (amt === 32) { this._sc = v & 1; return 0; } this._sc = 0; return 0;
      case 1: if (amt === 0) { this._sc = cin; return v; } if (amt < 32) { this._sc = (v >>> (amt - 1)) & 1; return v >>> amt; } if (amt === 32) { this._sc = v >>> 31; return 0; } this._sc = 0; return 0;
      case 2: if (amt === 0) { this._sc = cin; return v; } if (amt < 32) { this._sc = (v >>> (amt - 1)) & 1; return v >> amt; } this._sc = v >>> 31; return v >> 31;
      case 3: { if (amt === 0) { this._sc = cin; return v; } const a = amt & 31; if (a === 0) { this._sc = v >>> 31; return v; } this._sc = (v >>> (a - 1)) & 1; return (v >>> a) | (v << (32 - a)); }
      default: this._sc = v & 1; return (v >>> 1) | (cin << 31);
    }
  }
  mul64(a, b, signed) { // sets this.mh,this.ml (unsigned halves of the 64-bit product)
    a >>>= 0; b >>>= 0;
    const al = a & 0xFFFF, ah = a >>> 16, bl = b & 0xFFFF, bh = b >>> 16;
    const p0 = al * bl, mid = ah * bl + al * bh, p3 = ah * bh;
    const midLo = mid % 65536, midHi = (mid - midLo) / 65536;
    let lo = p0 + midLo * 65536; let carry = 0; if (lo >= 4294967296) { lo -= 4294967296; carry = 1; }
    let hi = p3 + midHi + carry;
    if (signed) { if (a & 0x80000000) hi -= b; if (b & 0x80000000) hi -= a; hi = ((hi % 4294967296) + 4294967296) % 4294967296; }
    this.mh = hi >>> 0; this.ml = lo >>> 0;
  }
  setNZ(r) { this.N = r >>> 31; this.Z = r === 0 ? 1 : 0; }
  bxWrite(a) { if (a & 1) { this.T = 1; this.npc = (a & ~1) >>> 0; } else { this.T = 0; this.npc = (a & ~3) >>> 0; } }
  loadPC(a) { this.bxWrite(a); }
  rr(n) { return n === 15 ? this.pcv : this.R[n]; }
  sat(v, bits, uns) { // v: JS number (may exceed 32 bits). returns saturated value, sets Q
    let max, min;
    if (uns) { min = 0; max = bits >= 32 ? 4294967295 : (2 ** bits) - 1; } else { max = (2 ** (bits - 1)) - 1; min = -(2 ** (bits - 1)); }
    if (v > max) { this.Q = 1; return max; } if (v < min) { this.Q = 1; return min; } return v;
  }

  // ------------------------------------------------------------ high-level emulation hooks (see hle.js)
  addHLE(pc, name, fn) {
    const k = (pc >>> 1) & 8191;
    if (this.hleFn[k] !== null && this.hleKey[k] !== (pc | 0)) return false;
    this.hleKey[k] = pc | 0; this.hleFn[k] = fn; this.hleName[k] = name; this.hleStats[name] = 0; this.jitFlush(); return true;
  }
  isHLE(pc) { const k = (pc >>> 1) & 8191; return this.hleFn[k] !== null && this.hleKey[k] === (pc | 0); }

  // ------------------------------------------------------------ JIT management
  // flags and the cycle counter are mirrored into shared memory around WebAssembly blocks
  flagsToMem() { const m = this.M32; m[16] = this.N; m[17] = this.Z; m[18] = this.C; m[19] = this.V; }
  flagsFromMem() { const m = this.M32; this.N = m[16]; this.Z = m[17]; this.C = m[18]; this.V = m[19]; }
  wasmImports(gens) {
    const cpu = this, F = this.F64, M = this.M32;
    if (!this._ws) {
      const pre = () => { cpu.cycles = F[0]; }, post = () => { F[0] = cpu.cycles; if (cpu.xb) M[20] = 1; };
      this._ws = {
        mem: this.ram.wmem,
        rd8: (va) => { pre(); const v = cpu.rd8s(va >>> 0); post(); return v; },
        rd16: (va) => { pre(); const v = cpu.rd16s(va >>> 0); post(); return v; },
        rd32: (va) => { pre(); const v = cpu.rd32s(va >>> 0); post(); return v; },
        wr8: (va, v) => { pre(); cpu.wr8(va >>> 0, v); post(); },
        wr16: (va, v) => { pre(); cpu.wr16(va >>> 0, v); post(); },
        wr32: (va, v) => { pre(); cpu.wr32(va >>> 0, v); post(); },
        shc: (x, sh, amt, cin) => { const v = cpu.shiftC(x, sh, amt, cin); M[21] = cpu._sc; return v; },
        xfer: (a) => { cpu.bxWrite(a); cpu.R[15] = cpu.npc | 0; M[29] = cpu.T; return 0; },   // ARM<->Thumb switch: the dispatcher reads T from memory
      };
    }
    const ws = this._ws;
    return Object.assign({}, ws, {
      gen: (gi) => {
        const g = gens[gi];
        cpu.cycles = F[0]; cpu.flagsFromMem(); cpu.T = M[29];
        cpu.pcv = g.pcvU; cpu.npc = g.nextU; cpu.I_ = g.I; cpu.inIT = g.inIT;
        const T0 = cpu.T;
        cpu.exec(g.I, g.pc);
        M[29] = cpu.T;                                                   // the dispatcher keys blocks by instruction set
        cpu.flagsToMem(); F[0] = cpu.cycles;
        if (g.ender) { cpu.R[15] = cpu.npc | 0; if (!g.plain) cpu.xb = 1; if (cpu.xb) M[20] = 1; return 1; }
        if (cpu.npc !== g.nextU || cpu.xb) { cpu.R[15] = cpu.npc | 0; M[20] = 1; if (cpu.npc === g.nextU && g.itNext) M[28] = g.itNext; return 1; }
        return 0;
      },
    });
  }
  jitBuild(fr, pc) {
    const t0 = performance.now();
    let b = null;
    if (this.jitBackend === 'wasm') {
      const t = wasmjit.translate(this, fr, pc, this.T);
      if (t !== null) {
        const key = (((fr << 12) | (pc & 0xFFF)) << 1) | this.T;
        b = { fn: null, n: 1e9, waits: 0, pcs: t.pcs, its: t.its, loopLen: t.loopLen, wasm: true, t, fr, key, h: -1, idx: -1, dead: false, pc,
              hookable: !(pc === this.hookPC || pc === this.idlePC || this.isHLE(pc)) };
        if (this.wpending.length === 0) this.wpendSince = t0;
        this.wpending.push(b);
        (this.frameBlocks[fr] || (this.frameBlocks[fr] = [])).push(b);
        this.jitStats.wasm++;
      } else this.jitStats.wasmFail++;
    }
    if (b === null) b = compile(this, fr, pc, this.T);
    this.jitStats.ms += performance.now() - t0;
    if (b === null) { this.jitStats.failed++; return false; }
    if (this.jitDump) this.jitDump(pc, b);
    const ram = this.ram, pg = fr >>> 4;
    ram.codePg[pg] = 1; ram.cf[fr] = 1; ram.W8[pg] = ram.W16[pg] = ram.W32[pg] = undefined; this.dwFlush(); // from now on writes to this page are intercepted
    ram.onCode = this.onCodeBound || (this.onCodeBound = (f) => this.codeChanged(f));
    this.jitStats.blocks++; this.jitStats.insts += b.wasm ? b.t.n : b.n; this.jitCount += b.wasm ? b.t.n : b.n;
    if (this.jitCount > JIT_MAX) { this.jitFlush(); return false; }
    if (this.wpending.length >= this.wasmBatch) this.wasmFlushPending();
    return b;
  }
  // compile all queued blocks into one WebAssembly module and make them reachable from the dispatcher
  wasmFlushPending() {
    const list = this.wpending.filter((b) => !b.dead); this.wpending = [];
    if (list.length === 0) return;
    const t0 = performance.now();
    let r;
    try { r = wasmjit.buildModule(this, list.map((b) => b.t)); }
    catch (err) { if (this.log) this.log('wasm jit: ' + err.message); for (const b of list) b.dead = true; this.jitBackend = 'js'; return; }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (this.wnext >= this.wtable.length) this.wtable.grow(Math.max(1024, this.wtable.length));
      const idx = this.wnext++;
      this.wtable.set(idx, r.fns[i]);
      b.fn = r.fns[i]; b.idx = idx; b.n = b.t.n; b.t = null; this.wblocks[idx] = b;
      if (b.hookable) { b.h = wasmjit.hashOf(b.key); this.HKv[b.h] = b.key; this.HIv[b.h] = idx; this.HNv[b.h] = b.n; }
    }
    this.jitStats.modules = (this.jitStats.modules || 0) + 1; this.jitStats.ms += performance.now() - t0;
  }
  codeChanged(f) {
    this.jtA[f] = undefined; this.jtT[f] = undefined; this.xb = 1;
    const l = this.frameBlocks[f];
    if (l) { for (const b of l) { b.dead = true; if (b.h >= 0 && this.HKv[b.h] === b.key) this.HKv[b.h] = -1; } this.frameBlocks[f] = undefined; }
  }
  jitFlush() {
    this.jtA.length = 0; this.jtT.length = 0; this.ram.cf.fill(0); this.jitCount = 0; this.xb = 1;
    for (const l of this.frameBlocks) if (l) for (const b of l) b.dead = true;
    this.frameBlocks = []; this.wpending = []; this.HKv.fill(-1); this.wnext = 0; this.wblocks = [];
  }

  // ------------------------------------------------------------ run loop
  run(n) {
    let left = n | 0;
    const ic = this.ic;
    const chk = this.jitCheck; let ex = 0;
    const jit = this.jitEnabled && this.trace === null && this.breakAt < 0;
    while (left > 0) {
      let pc = 0;
      try {
        while (left > 0) {
          if ((this.irq && !this.I) || (this.fiq && !this.F)) {
            this.wfi = false;
            if (this.fiq && !this.F) { this.stats.irq++; this.enter(0x1C, M_FIQ, (this.R[15] >>> 0) + 4, true); this.R[15] = this.npc | 0; }
            else { this.stats.irq++; this.enter(0x18, M_IRQ, (this.R[15] >>> 0) + 4, false); this.R[15] = this.npc | 0; }
            continue;
          }
          if (this.wfi) { if (this.irq || this.fiq) { this.wfi = false; } else return n - left; }
          pc = this.R[15] >>> 0;
          if (pc === this.breakAt) { this.hitBreak = true; return n - left; }
          if (pc === this.hookPC) this.hookFn(this);
          if (pc === this.idlePC) { if (this.idleResume) this.idleResume = false; else { this.idleHit = true; return n - left; } }
          { const hk = (pc >>> 1) & 8191;
            if (this.hleKey[hk] === (pc | 0) && this.hleFn[hk] !== null && this.IT === 0 && this.hleOn) {
              const c = this.hleFn[hk](this);
              if (c > 0) { left -= c; this.cycles += c; this.hleStats[this.hleName[hk]]++; continue; }
            } }
          if (jit && this.IT === 0) {
            let vpn = pc >>> 12;
            if (vpn !== this.fvpn) this.fetch16(pc);              // primes the fetch frame; faults exactly like the interpreter would
            if (vpn === this.fvpn) {
              const tabs = this.T ? this.jtT : this.jtA, fr = this.ffr;
              let tab = tabs[fr];
              if (tab === undefined) tab = tabs[fr] = new Array(this.T ? 2048 : 1024).fill(0);
              const idx = this.T ? (pc & 0xFFF) >>> 1 : (pc & 0xFFF) >>> 2;
              let e = tab[idx];
              if (e !== false) {
                if (typeof e === 'number') {
                  if (pc === this.seqPc) e = -1;                    // only jump targets start blocks (straight-line successors are inside them)
                  else if (e < this.jitHot) tab[idx] = e + 1;
                  else { e = tab[idx] = this.jitBuild(fr, pc); }
                }
                if (typeof e === 'object' && e.t !== undefined && e.t !== null && ++e.waits > 50) { this.wasmFlushPending(); }  // queued block keeps getting hit: compile the batch now
                if (typeof e === 'object' && e.n <= left) {
                  // run compiled blocks back to back for as long as nothing needs the dispatcher (xb: MMIO, mode change, exception, WFI, ...)
                  for (;;) {
                    this.xb = 0; this.inIT = false; this.jb = e; this.jc0 = this.cycles;
                    if (chk !== null) chk(e, -1);
                    let k;
                    if (e.wasm) {
                      const M = this.M32, F = this.F64;
                      this.flagsToMem(); F[0] = this.cycles; M[20] = 0; M[28] = 0; M[29] = this.T; this.inWasm = true;
                      if (chk === null && e.h >= 0) {             // let the WebAssembly dispatcher chain blocks
                        if (this.HKv[e.h] !== e.key) { this.HKv[e.h] = e.key; this.HIv[e.h] = e.idx; this.HNv[e.h] = e.n; }
                        k = this.wdispatch(left);
                      } else k = 0;
                      if (k === 0) { M[24] = e.idx; M[25] = 0; F[2] = this.cycles; k = e.fn(left); }
                      this.inWasm = false; this.flagsFromMem(); this.cycles = F[0]; this.T = M[29]; if (M[20] !== 0) { this.xb = 1; if (M[28] !== 0) this.IT = M[28]; }
                    } else k = e.fn(this, left);
                    this.jb = null; left -= k; ex += k; this.seqPc = -1;
                    if (chk !== null) chk(e, k);
                    if (left <= 0 || this.xb !== 0) break;
                    pc = this.R[15] >>> 0;
                    if (pc === this.hookPC || pc === this.idlePC || (pc >>> 12) !== this.fvpn || this.hleKey[(pc >>> 1) & 8191] === (pc | 0)) break;
                    const t2 = (this.T ? this.jtT : this.jtA)[this.ffr];
                    if (t2 === undefined) break;
                    e = t2[this.T ? (pc & 0xFFF) >>> 1 : (pc & 0xFFF) >>> 2];
                    if (typeof e !== 'object' || e.n > left) break;
                  }
                  continue;
                }
              }
            }
          }
          let cond, I;
          if (this.T) {
            const h1 = this.fetch16(pc);
            const h2 = (h1 >>> 11) >= 29 ? this.fetch16(pc + 2) : 0;
            const k = (pc >>> 1) & IC_MASK;
            I = ic[k]; if (I === undefined) { I = ic[k] = new Inst(); I.w = -1; }
            if (I.w !== h1 || I.w2 !== h2 || I.thumb === 0) decodeThumb(h1, h2, I);
            this.pcv = pc + 4; cond = this.IT ? (this.IT >>> 4) : I.cond;
          } else {
            const w = this.fetch32(pc);
            const k = (pc >>> 2) & IC_MASK;
            I = ic[k]; if (I === undefined) { I = ic[k] = new Inst(); I.w = -1; }
            if (I.w !== (w >>> 0) || I.thumb === 1) decodeARM(w, I);
            this.pcv = pc + 8; cond = I.cond;
          }
          this.I_ = I; this.inIT = this.IT !== 0;
          if (this.trace) this.trace(pc, I, cond, this.inIT);
          this.npc = pc + I.len; this.seqPc = this.npc; left--; this.cycles++;
          if (cond === 14 || this.condPass(cond)) this.exec(I, pc);
          if (this.IT && I.op !== 56/*O.IT*/) { this.IT = (this.IT & 7) === 0 ? 0 : (this.IT & 0xE0) | ((this.IT << 1) & 0x1F); }
          this.R[15] = this.npc | 0;
        }
      } catch (e) {
        if (e instanceof Abort) {
          const jb = this.jb;
          if (this.inWasm) {                                          // fault inside WebAssembly: which block, how far
            this.inWasm = false; this.flagsFromMem(); this.T = this.M32[29];
            const b = this.wblocks[this.M32[24]], within = this.cycles - this.F64[2], done = this.M32[25] + within;
            const ix = b.loopLen ? (within - 1) % b.loopLen : within - 1; pc = b.pcs[ix]; this.IT = b.its ? b.its[ix] : 0; left -= done; this.jb = null;
          } else if (jb !== null) { const done = this.cycles - this.jc0; pc = jb.pcs[jb.loopLen ? (done - 1) % jb.loopLen : done - 1]; left -= done; this.jb = null; }
          this.handleAbort(e, pc); left--; this.cycles++;
        } else { this.jb = null; throw e; }
      }
    }
    this.jitStats.ex += ex;
    if (this.wpending.length && performance.now() - this.wpendSince > 15) this.wasmFlushPending();
    return n - left;
  }

  // ------------------------------------------------------------ execute one decoded instruction
  exec(I, pc) {
    const R = this.R;
    switch (I.op) {
      case 0/*O.DP*/: return this.execDP(I, pc);
      case 45/*O.LDR*/: return this.execLDR(I, pc);
      case 46/*O.STR*/: return this.execSTR(I, pc);
      case 49/*O.B*/: this.npc = (this.pcv + I.imm) >>> 0; return;
      case 50/*O.BL*/: R[14] = (pc + I.len) | (this.T ? 1 : 0); this.npc = (this.pcv + I.imm) >>> 0; return;
      case 51/*O.BLX_I*/: {
        R[14] = (pc + I.len) | (this.T ? 1 : 0);
        if (this.T) { this.npc = ((this.pcv & ~3) + I.imm) >>> 0; this.T = 0; } else { this.npc = (this.pcv + I.imm) >>> 0; this.T = 1; }
        return;
      }
      case 52/*O.BX*/: this.bxWrite(this.rr(I.rm)); return;
      case 53/*O.BLX_R*/: { const t = this.rr(I.rm); R[14] = (pc + I.len) | (this.T ? 1 : 0); this.bxWrite(t); return; }
      case 54/*O.CBZ*/: { const z = R[I.rn] === 0; if (z !== (I.kind === 1)) this.npc = (this.pcv + I.imm) >>> 0; return; }
      case 55/*O.TB*/: { const base = I.rn === 15 ? this.pcv : R[I.rn]; const idx = R[I.rm]; const off = I.kind ? this.rd16((base + idx * 2) >>> 0) : this.rd8((base + idx) >>> 0); this.npc = (this.pcv + off * 2) >>> 0; return; }
      case 56/*O.IT*/: this.IT = (I.o1 << 4) | I.o2; return;
      case 83/*O.MOVW*/: R[I.rd] = I.imm; return;
      case 84/*O.MOVT*/: R[I.rd] = (R[I.rd] & 0xFFFF) | (I.imm << 16); return;
      case 47/*O.LDM*/: return this.execLDM(I, pc);
      case 48/*O.STM*/: return this.execSTM(I, pc);
      case 16/*O.MUL*/: { const r = Math.imul(R[I.rm], R[I.rs]); R[I.rd] = r; if (I.S === 1 || (I.S === 2 && !this.inIT)) this.setNZ(r); return; }
      case 17/*O.MLA*/: { const r = (Math.imul(R[I.rm], R[I.rs]) + R[I.ra]) | 0; R[I.rd] = r; if (I.S === 1) this.setNZ(r); return; }
      case 18/*O.MLS*/: R[I.rd] = (R[I.ra] - Math.imul(R[I.rm], R[I.rs])) | 0; return;
      case 19/*O.UMULL*/: case 21/*O.SMULL*/: case 20/*O.UMLAL*/: case 22/*O.SMLAL*/: case 23/*O.UMAAL*/: return this.execLong(I);
      case 24/*O.HMUL*/: return this.execHMUL(I);
      case 25/*O.CLZ*/: R[I.rd] = Math.clz32(R[I.rm]); return;
      case 26/*O.RBIT*/: { let v = R[I.rm], r = 0; for (let i = 0; i < 32; i++) { r = (r << 1) | (v & 1); v >>>= 1; } R[I.rd] = r; return; }
      case 27/*O.REV*/: { const v = R[I.rm]; R[I.rd] = ((v << 24) | ((v & 0xFF00) << 8) | ((v >>> 8) & 0xFF00) | (v >>> 24)) | 0; return; }
      case 28/*O.REV16*/: { const v = R[I.rm]; R[I.rd] = (((v & 0x00FF00FF) << 8) | ((v >>> 8) & 0x00FF00FF)) | 0; return; }
      case 29/*O.REVSH*/: { const v = R[I.rm]; R[I.rd] = (((v & 0xFF) << 8) | ((v >>> 8) & 0xFF)) << 16 >> 16; return; }
      case 30/*O.EXT*/: return this.execEXT(I);
      case 31/*O.SAT*/: { let v = ROR(0, 0); let x = R[I.rm]; if (I.sh === 2) x = I.shImm === 32 ? (x >> 31) : (x >> I.shImm); else x = x << I.shImm; R[I.rd] = this.sat(x, I.o1, I.kind) | 0; return; }
      case 32/*O.SAT16*/: { const v = R[I.rn]; const lo = this.sat((v << 16) >> 16, I.o1, I.kind), hi = this.sat(v >> 16, I.o1, I.kind); R[I.rd] = ((hi << 16) | (lo & 0xFFFF)) | 0; return; }
      case 33/*O.BFI*/: { const w = I.o2, l = I.o1; const m = (w >= 32 ? 0xFFFFFFFF : ((1 << w) - 1)) << l; R[I.rd] = (R[I.rd] & ~m) | ((R[I.rn] << l) & m); return; }
      case 34/*O.BFC*/: { const w = I.o2, l = I.o1; const m = (w >= 32 ? 0xFFFFFFFF : ((1 << w) - 1)) << l; R[I.rd] = R[I.rd] & ~m; return; }
      case 36/*O.UBFX*/: { const l = I.o1, w = I.o2; R[I.rd] = (R[I.rn] >>> l) & (w >= 32 ? 0xFFFFFFFF : ((1 << w) - 1)); return; }
      case 35/*O.SBFX*/: { const l = I.o1, w = I.o2; R[I.rd] = (R[I.rn] << (32 - l - w)) >> (32 - w); return; }
      case 37/*O.PKH*/: { const a = R[I.rn], b = R[I.rm]; if (I.kind) { const s = I.shImm === 32 ? (b >> 31) : (b >> I.shImm); R[I.rd] = ((a & 0xFFFF0000) | (s & 0xFFFF)) | 0; } else { R[I.rd] = ((b << I.shImm) & 0xFFFF0000 | (a & 0xFFFF)) | 0; } return; }
      case 38/*O.SEL*/: { const a = R[I.rn], b = R[I.rm], g = this.GE; let r = 0; for (let i = 0; i < 4; i++) { const m = 0xFF << (i * 8); r |= ((g >> i) & 1 ? a : b) & m; } R[I.rd] = r | 0; return; }
      case 39/*O.USAD8*/: { const a = R[I.rn], b = R[I.rm]; let s = 0; for (let i = 0; i < 4; i++) s += Math.abs(((a >>> (i * 8)) & 255) - ((b >>> (i * 8)) & 255)); if (I.ra !== 15) s += R[I.ra] >>> 0; R[I.rd] = s | 0; return; }
      case 40/*O.PAR*/: return this.execPAR(I);
      case 41/*O.QADD*/: { const r = (R[I.rm] | 0) + (R[I.rn] | 0); R[I.rd] = this.sat(r, 32, 0) | 0; return; }
      case 42/*O.QSUB*/: { const r = (R[I.rm] | 0) - (R[I.rn] | 0); R[I.rd] = this.sat(r, 32, 0) | 0; return; }
      case 43/*O.QDADD*/: { const d = this.sat(2 * (R[I.rn] | 0), 32, 0); R[I.rd] = this.sat((R[I.rm] | 0) + d, 32, 0) | 0; return; }
      case 44/*O.QDSUB*/: { const d = this.sat(2 * (R[I.rn] | 0), 32, 0); R[I.rd] = this.sat((R[I.rm] | 0) - d, 32, 0) | 0; return; }
      case 91/*O.DIV*/: { const a = R[I.rn], b = R[I.rm]; if (b === 0) { R[I.rd] = 0; return; } R[I.rd] = I.kind ? ((a >>> 0) / (b >>> 0)) | 0 : ((a / b) | 0); return; }
      case 57/*O.MRS*/: R[I.rd] = I.kind ? (this.mode === M_USR || this.mode === M_SYS ? this.getCPSR() : this.spsr[BANK[this.mode]]) : (this.priv ? this.getCPSR() : (this.getCPSR() & 0xF80F0000)); return;
      case 58/*O.MSR*/: return this.execMSR(I);
      case 59/*O.CPS*/: return this.execCPS(I, pc);
      case 62/*O.SVC*/: this.stats.svc++; this.enter(0x08, M_SVC, pc + I.len, false); return;
      case 63/*O.BKPT*/: this.stats.pabt++; this.ifar = pc | 0; this.ifsr = 2; this.enter(0x0C, M_ABT, pc + 4, false); return;
      case 64/*O.MCR*/: case 65/*O.MRC*/: return this.execCP(I, pc);
      case 66/*O.MCRR*/: case 67/*O.MRRC*/: case 68/*O.CDP*/: case 69/*O.LDC*/: case 70/*O.STC*/: this.undef(pc, I.len); return;
      case 71/*O.NOP*/: case 75/*O.YIELD*/: case 74/*O.SEV*/: case 76/*O.DMB*/: case 77/*O.DSB*/: case 78/*O.ISB*/: case 80/*O.PLD*/: case 81/*O.PLI*/: case 73/*O.WFE*/: case 82/*O.SETEND*/: return;
      case 72/*O.WFI*/: this.wfi = true; this.xb = 1; return;
      case 79/*O.CLREX*/: this.exAddr = -1; return;
      case 86/*O.SWP*/: { const a = R[I.rn] >>> 0; const v = R[I.rm]; if (I.size === 1) { const o = this.rd8(a); this.wr8(a, v); R[I.rd] = o; } else { const o = this.rd32(a); this.wr32(a, v); R[I.rd] = o; } return; }
      case 87/*O.LDREX*/: { const a = R[I.rn] >>> 0; this.exAddr = a;
        if (I.size === 1) R[I.rd] = this.rd8(a); else if (I.size === 2) R[I.rd] = this.rd16(a); else if (I.size === 8) { R[I.rd] = this.rd32(a); R[I.thumb ? I.rdhi : I.rd + 1] = this.rd32(a + 4); } else R[I.rd] = this.rd32((a + (I.isImm ? I.imm : 0)) >>> 0); return; }
      case 88/*O.STREX*/: { const a = (R[I.rn] >>> 0) + (I.isImm ? I.imm : 0); const ok = this.exAddr === ((R[I.rn] >>> 0));
        if (ok) { if (I.size === 1) this.wr8(a, R[I.rm]); else if (I.size === 2) this.wr16(a, R[I.rm]); else if (I.size === 8) { this.wr32(a, R[I.rm]); this.wr32(a + 4, R[I.thumb ? I.rdhi : I.rm + 1]); } else this.wr32(a >>> 0, R[I.rm]); }
        this.exAddr = -1; R[I.rd] = ok ? 0 : 1; return; }
      case 60/*O.SRS*/: case 61/*O.RFE*/: return this.execSRSRFE(I, pc);
      case 89/*O.VFP*/: return this.execVFP(I, pc);
      case 90/*O.DSPMUL*/: this.stats.undef++; this.undef(pc, I.len); return;
      default: this.undef(pc, I.len); return;
    }
  }

  execDP(I, pc) {
    const R = this.R; const dp = I.dp;
    let a;
    if (I.rn === 15) a = I.lit ? ((this.pcv & ~3) >>> 0) : this.pcv; else a = R[I.rn];
    let b, sc;
    if (I.isImm) { b = I.imm | 0; sc = I.immC < 0 ? this.C : I.immC; }
    else {
      b = I.rm === 15 ? this.pcv : R[I.rm];
      if (I.shReg) { b = this.shiftC(b, I.sh, R[I.rs] & 255, this.C); sc = this._sc; }
      else if (I.sh === 0 && I.shImm === 0) sc = this.C;
      else { b = this.shiftC(b, I.sh, I.shImm, this.C); sc = this._sc; }
    }
    const S = I.S === 1 || (I.S === 2 && !this.inIT);
    let res, logical = false, write = true;
    switch (dp) {
      case 0: res = a & b; logical = true; break;
      case 1: res = a ^ b; logical = true; break;
      case 2: res = this.addc(a, ~b, 1); break;
      case 3: res = this.addc(b, ~a, 1); break;
      case 4: res = this.addc(a, b, 0); break;
      case 5: res = this.addc(a, b, this.C); break;
      case 6: res = this.addc(a, ~b, this.C); break;
      case 7: res = this.addc(b, ~a, this.C); break;
      case 8: res = a & b; logical = true; write = false; break;
      case 9: res = a ^ b; logical = true; write = false; break;
      case 10: res = this.addc(a, ~b, 1); write = false; break;
      case 11: res = this.addc(a, b, 0); write = false; break;
      case 12: res = a | b; logical = true; break;
      case 13: res = b; logical = true; break;
      case 14: res = a & ~b; logical = true; break;
      case 15: res = ~b; logical = true; break;
      default: res = a | ~b; logical = true; break;
    }
    if (I.rd === 15 && write) {
      if (S && !I.thumb || (S && I.thumb && I.rn === 14 && dp === 2)) { // exception return
        const sp = this.spsr[BANK[this.mode]]; this.setCPSRraw(sp); this.npc = (res >>> 0) & (this.T ? ~1 : ~3); this.exAddr = -1; return;
      }
      if (this.T) this.npc = (res >>> 0) & ~1; else this.bxWrite(res);
      return;
    }
    if (S) {
      this.N = res >>> 31; this.Z = res === 0 ? 1 : 0;
      if (logical) { this.C = sc; } else { this.C = this._cy; this.V = this._ov; }
    }
    if (write) R[I.rd] = res;
  }

  eaOffset(I) {
    if (I.isImm) return I.imm;
    let v = this.R[I.rm];
    if (I.sh === 4) return this.shiftC(v, 4, 1, this.C);
    if (I.shImm) return this.shiftC(v, I.sh, I.shImm, this.C);
    return v;
  }
  execLDR(I, pc) {
    const R = this.R;
    let base = I.rn === 15 ? (I.lit ? (this.pcv & ~3) : this.pcv) : R[I.rn];
    const off = this.eaOffset(I);
    const nb = I.U ? (base + off) | 0 : (base - off) | 0;
    const ea = (I.P ? nb : base) >>> 0;
    if (I.size === 8) {
      const lo = this.rd32(ea), hi = this.rd32((ea + 4) >>> 0);
      if (I.W || !I.P) R[I.rn] = nb;
      R[I.rd] = lo; R[I.thumb ? I.rdhi : (I.rd + 1)] = hi; return;
    }
    const v = I.usr ? this.ldrUser(I, ea) : this.ldrSized(I, ea);
    if (I.W || !I.P) R[I.rn] = nb;
    if (I.rd === 15) { this.loadPC(v); return; }
    R[I.rd] = v;
  }
  ldrSized(I, ea) {
    if (I.size === 4) return this.rd32(ea);
    if (I.size === 2) { const x = this.rd16(ea); return I.sgn ? (x << 16) >> 16 : x; }
    if (I.size === 1) { const x = this.rd8(ea); return I.sgn ? (x << 24) >> 24 : x; }
    return 0;
  }
  ldrUser(I, ea) { return this.withUser(() => this.ldrSized(I, ea)); }
  strSized(I, ea, v) { if (I.size === 4) this.wr32(ea, v); else if (I.size === 2) this.wr16(ea, v); else this.wr8(ea, v); }
  execSTR(I, pc) {
    const R = this.R;
    let base = I.rn === 15 ? this.pcv : R[I.rn];
    const off = this.eaOffset(I);
    const nb = I.U ? (base + off) | 0 : (base - off) | 0;
    const ea = (I.P ? nb : base) >>> 0;
    let v = I.rd === 15 ? (pc + (I.thumb ? 4 : 8)) : R[I.rd];
    if (I.size === 8) {
      const hi = R[I.thumb ? I.rdhi : (I.rd + 1)];
      this.wr32(ea, v); this.wr32((ea + 4) >>> 0, hi);
      if (I.W || !I.P) R[I.rn] = nb; return;
    }
    if (I.usr) this.withUser(() => this.strSized(I, ea, v)); else this.strSized(I, ea, v);
    if (I.W || !I.P) R[I.rn] = nb;
  }
  ldmAddr(I, n) { // start address for LDM/STM and writeback value
    const base = this.R[I.rn]; let start, wb;
    if (I.U) { start = I.P ? base + 4 : base; wb = base + 4 * n; } else { start = I.P ? base - 4 * n : base - 4 * n + 4; wb = base - 4 * n; }
    this.wbv = wb | 0; return start >>> 0;
  }
  execLDM(I, pc) {
    const R = this.R; let n = 0, list = I.list; for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
    if (n === 0) return;
    let a = this.ldmAddr(I, n); const wb = this.wbv;
    const vals = this.ldmVals; // values read before any register update (fault-safe)
    const userRegs = I.S && !(list & 0x8000);
    for (let i = 0; i < 16; i++) if (list & (1 << i)) { vals[i] = this.rd32(a); a += 4; }
    if (I.W) R[I.rn] = wb;
    for (let i = 0; i < 15; i++) if (list & (1 << i)) { if (userRegs) this.setUserReg(i, vals[i]); else R[i] = vals[i]; }
    if (list & 0x8000) {
      if (I.S) { const sp = this.spsr[BANK[this.mode]]; this.setCPSRraw(sp); this.npc = (vals[15] >>> 0) & (this.T ? ~1 : ~3); this.exAddr = -1; }
      else this.loadPC(vals[15]);
    }
  }
  execSTM(I, pc) {
    const R = this.R; let n = 0, list = I.list; for (let i = 0; i < 16; i++) if (list & (1 << i)) n++;
    if (n === 0) return;
    let a = this.ldmAddr(I, n); const wb = this.wbv;
    for (let i = 0; i < 16; i++) if (list & (1 << i)) {
      const v = i === 15 ? pc + (I.thumb ? 4 : 8) : (I.S ? this.getUserReg(i) : R[i]);
      this.wr32(a, v); a += 4;
    }
    if (I.W) R[I.rn] = wb;
  }
  execLong(I) {
    const R = this.R; const a = R[I.rm], b = R[I.rs]; const S = I.S === 1;
    switch (I.op) {
      case 19/*O.UMULL*/: this.mul64(a, b, false); break;
      case 21/*O.SMULL*/: this.mul64(a, b, true); break;
      case 20/*O.UMLAL*/: case 22/*O.SMLAL*/: {
        this.mul64(a, b, I.op === 22/*O.SMLAL*/); let lo = this.ml + (R[I.rd] >>> 0), carry = 0; if (lo >= 4294967296) { lo -= 4294967296; carry = 1; }
        this.ml = lo >>> 0; this.mh = (this.mh + (R[I.rdhi] >>> 0) + carry) >>> 0; break;
      }
      default: { // UMAAL
        this.mul64(a, b, false); let lo = this.ml + (R[I.rd] >>> 0) + (R[I.rdhi] >>> 0), carry = 0; while (lo >= 4294967296) { lo -= 4294967296; carry++; }
        this.ml = lo >>> 0; this.mh = (this.mh + carry) >>> 0;
      }
    }
    R[I.rd] = this.ml | 0; R[I.rdhi] = this.mh | 0;
    if (S) { this.N = this.mh >>> 31; this.Z = (this.mh | this.ml) === 0 ? 1 : 0; }
  }
  execHMUL(I) {
    const R = this.R; const h = (v, t) => t ? (v >> 16) : ((v << 16) >> 16);
    const a = R[I.rm], b = R[I.rs];
    switch (I.kind) {
      case 0: { const p = h(a, I.x) * h(b, I.y); const s = p + R[I.ra]; if (s > 2147483647 || s < -2147483648) this.Q = 1; R[I.rd] = s | 0; return; }
      case 1: { const p = Math.floor(((a) * h(b, I.y)) / 65536); const s = p + R[I.ra]; if (s > 2147483647 || s < -2147483648) this.Q = 1; R[I.rd] = s | 0; return; }
      case 2: { const p = h(a, I.x) * h(b, I.y); let lo = (R[I.rd] >>> 0) + (p < 0 ? p + 4294967296 : p), hi = R[I.rdhi] >>> 0; if (p < 0) hi += 4294967295; while (lo >= 4294967296) { lo -= 4294967296; hi++; } R[I.rd] = lo | 0; R[I.rdhi] = (hi % 4294967296) | 0; return; }
      case 3: R[I.rd] = h(a, I.x) * h(b, I.y); return;
      default: R[I.rd] = Math.floor((a * h(b, I.y)) / 65536) | 0; return;
    }
  }
  execEXT(I) {
    const R = this.R; let v = R[I.rm]; if (I.rot) v = ROR(v, I.rot);
    const acc = I.rn !== 15; const A = acc ? R[I.rn] : 0;
    switch (I.kind) {
      case 0: R[I.rd] = (((v << 24) >> 24) + A) | 0; return;
      case 1: R[I.rd] = (((v << 16) >> 16) + A) | 0; return;
      case 2: R[I.rd] = ((v & 0xFF) + A) | 0; return;
      case 3: R[I.rd] = ((v & 0xFFFF) + A) | 0; return;
      case 4: { const lo = (((v << 24) >> 24) + (A << 16 >> 16)) & 0xFFFF, hi = (((v << 8) >> 24) + (A >> 16)) & 0xFFFF; R[I.rd] = ((hi << 16) | lo) | 0; return; }
      default: { const lo = ((v & 0xFF) + (A & 0xFFFF)) & 0xFFFF, hi = (((v >>> 16) & 0xFF) + (A >>> 16)) & 0xFFFF; R[I.rd] = ((hi << 16) | lo) | 0; return; }
    }
  }
  execPAR(I) {
    const R = this.R, a = R[I.rn], b = R[I.rm], pf = I.kind, op = I.o1; const uns = pf >= 5; const mode = uns ? pf - 4 : pf; // 1 wrap(+GE) 2 sat 3 halve
    const h16 = op <= 3; let res = 0, ge = 0;
    const lane = (x, sh, w, sg) => { const m = (1 << w) - 1; const v = (x >>> sh) & m; return sg ? (v << (32 - w)) >> (32 - w) : v; };
    const fin = (r, w, i, sg) => {
      let v = r;
      if (mode === 1) { const g = sg ? (r >= 0) : (r >= 0 && r < (1 << w)); const gg = (op === 3 || op === 7) ? (sg ? r >= 0 : r >= 0 && false) : g; ge |= (sg ? (r >= 0) : 0) ? 1 << i : 0; return v & ((1 << w) - 1); }
      if (mode === 2) { const lo = sg ? -(1 << (w - 1)) : 0, hi = sg ? (1 << (w - 1)) - 1 : (1 << w) - 1; v = Math.max(lo, Math.min(hi, r)); return v & ((1 << w) - 1); }
      return (r >> 1) & ((1 << w) - 1);
    };
    const sg = !uns;
    if (h16) {
      const a0 = lane(a, 0, 16, sg), a1 = lane(a, 16, 16, sg), b0 = lane(b, 0, 16, sg), b1 = lane(b, 16, 16, sg);
      let r0, r1, add0, add1;
      switch (op) { case 0: r0 = a0 + b0; r1 = a1 + b1; add0 = add1 = true; break; case 1: r0 = a0 - b1; r1 = a1 + b0; add0 = false; add1 = true; break; case 2: r0 = a0 + b1; r1 = a1 - b0; add0 = true; add1 = false; break; default: r0 = a0 - b0; r1 = a1 - b1; add0 = add1 = false; }
      const g = (r, add) => mode === 1 ? (sg ? (r >= 0) : (add ? r >= 0x10000 : r >= 0)) : false;
      if (mode === 1) { if (g(r0, add0)) ge |= 3; if (g(r1, add1)) ge |= 12; this.GE = ge; res = ((r1 & 0xFFFF) << 16) | (r0 & 0xFFFF); }
      else res = (fin(r1, 16, 0, sg) << 16) | fin(r0, 16, 0, sg);
    } else {
      for (let i = 0; i < 4; i++) {
        const x = lane(a, i * 8, 8, sg), y = lane(b, i * 8, 8, sg); const add = op === 4; const r = add ? x + y : x - y;
        if (mode === 1) { if (sg ? r >= 0 : (add ? r >= 256 : r >= 0)) ge |= 1 << i; res |= (r & 255) << (i * 8); }
        else res |= fin(r, 8, i, sg) << (i * 8);
      }
      if (mode === 1) this.GE = ge;
    }
    R[I.rd] = res | 0;
  }
  execMSR(I) {
    const R = this.R; const v = I.isImm ? I.imm | 0 : R[I.rm]; const m = I.o1;
    let mask = 0; if (m & 1) mask |= 0xFF; if (m & 2) mask |= 0xFF00; if (m & 4) mask |= 0xFF0000; if (m & 8) mask |= 0xFF000000;
    if (I.kind) { // SPSR
      if (this.mode === M_USR || this.mode === M_SYS) return;
      const b = BANK[this.mode]; this.spsr[b] = (this.spsr[b] & ~mask) | (v & mask); return;
    }
    if (!this.priv) mask &= 0xF80F0000; else mask &= ~0x20; // T bit not writable here
    // IT and E bits are not writable via MSR except E; keep IT
    mask &= ~0x0600FC00 | 0;
    const old = this.getCPSR(); this.setCPSRraw((old & ~mask) | (v & mask));
  }
  execCPS(I, pc) {
    if (!this.priv) return;
    if (I.kind >= 2) { const dis = I.kind === 3 ? 1 : 0; const f = I.W; if (f & 4) this.A = dis; if (f & 2) this.I = dis; if (f & 1) this.F = dis; }
    if (I.x) this.switchMode(I.o1);
  }
  execSRSRFE(I, pc) {
    if (!this.priv) { this.undef(pc, I.len); return; }
    if (I.op === 61/*O.RFE*/) {
      const base = this.R[I.rn]; let a = I.U ? (I.P ? base + 4 : base) : (I.P ? base - 8 : base - 4); const pcv = this.rd32(a >>> 0), cp = this.rd32((a + 4) >>> 0);
      if (I.W) this.R[I.rn] = I.U ? base + 8 : base - 8;
      this.setCPSRraw(cp); this.npc = (pcv >>> 0) & (this.T ? ~1 : ~3); return;
    }
    // SRS: store LR and SPSR to the stack of mode o1
    const tm = I.o1 & 31, tb = BANK[tm]; const sp = (tm === this.mode) ? this.R[13] : this.bankSP[tb];
    let a = I.U ? (I.P ? sp + 4 : sp) : (I.P ? sp - 8 : sp - 4);
    this.wr32(a >>> 0, this.R[14]); this.wr32((a + 4) >>> 0, this.spsr[BANK[this.mode]] | 0);
    if (I.W) { const nsp = (I.U ? sp + 8 : sp - 8) | 0; if (tm === this.mode) this.R[13] = nsp; else this.bankSP[tb] = nsp; }
  }
  execVFP(I, pc) {
    this.stats.vfp++;
    if (this.vfpHook && this.vfpHook(I, pc)) return;
    if (this.vfp.exec(this, I, pc)) return;
    this.undef(pc, I.len);
  }

  // ------------------------------------------------------------ CP15
  execCP(I, pc) {
    if (I.cp === 15) {
      const rd = I.op === 65/*O.MRC*/;
      if (!this.priv) { // user mode: only TPIDRURW (RW) and TPIDRURO (RO)
        if (I.crn === 13 && I.crm === 0 && I.o1 === 0 && (I.o2 === 2 || (I.o2 === 3 && rd))) { /* allowed */ } else { this.undef(pc, I.len); return; }
      }
      if (rd) { const v = this.cp15Read(I.crn, I.o1, I.crm, I.o2); if (I.rd === 15) { this.N = v >>> 31; this.Z = (v >>> 30) & 1; this.C = (v >>> 29) & 1; this.V = (v >>> 28) & 1; } else this.R[I.rd] = v; }
      else this.cp15Write(I.crn, I.o1, I.crm, I.o2, this.R[I.rd]);
      return;
    }
    if (I.cp === 14) { if (I.op === 65/*O.MRC*/) { if (I.rd !== 15) this.R[I.rd] = 0; } return; } // debug: RAZ/WI
    this.undef(pc, I.len);
  }
  cp15Read(crn, o1, crm, o2) {
    const k = (crn << 12) | (o1 << 8) | (crm << 4) | o2;
    switch (k) {
      case 0x0000: return 0x412FC083 | 0; // MIDR: Cortex-A8
      case 0x0001: return 0x82048004 | 0; // CTR
      case 0x0002: return 0; case 0x0003: return 0x00000202;
      case 0x0010: return 0x1031; case 0x0011: return 0x11; case 0x0012: return 0x400; case 0x0013: return 0;
      case 0x0014: return 0x31100003; case 0x0015: return 0x20000000; case 0x0016: return 0x01202000; case 0x0017: return 0x00000011;
      case 0x0020: return 0x00101111; case 0x0021: return 0x12112111; case 0x0022: return 0x21232031; case 0x0023: return 0x11112131; case 0x0024: return 0x00011142;
      case 0x0100: return 0xE007E01A | 0; // CCSIDR
      case 0x0101: return 0x0A200023; // CLIDR
      case 0x0200: return this.csselr;
      case 0x1000: return this.sctlr | 0; case 0x1001: return this.actlr; case 0x1002: return this.cpacr;
      case 0x2000: return this.ttbr0; case 0x2001: return this.ttbr1; case 0x2002: return this.ttbcr;
      case 0x3000: return this.dacr;
      case 0x5000: return this.dfsr; case 0x5001: return this.ifsr; case 0x5010: case 0x5011: return 0;
      case 0x6000: return this.dfar; case 0x6002: return this.ifar;
      case 0x7040: return this.par;
      case 0x9000: return 0; case 0x9020: return this.auxl2; case 0x9C00: return this.pmcr;
      case 0xA020: return this.prrr; case 0xA021: return this.nmrr;
      case 0xC000: return this.vbar; case 0xC010: return 0;
      case 0xD000: return this.fcse; case 0xD001: return this.contextidr;
      case 0xD002: return this.tpidrurw; case 0xD003: return this.tpidruro; case 0xD004: return this.tpidrprw;
    }
    this.stats.cp15unk++; if (this.log) this.log('cp15 read unknown c' + crn + ',' + o1 + ',c' + crm + ',' + o2 + ' @pc=' + (this.R[15] >>> 0).toString(16));
    return 0;
  }
  cp15Write(crn, o1, crm, o2, v) {
    const k = (crn << 12) | (o1 << 8) | (crm << 4) | o2;
    switch (k) {
      case 0x0200: this.csselr = v; return;
      case 0x1000: { const old = this.sctlr; this.sctlr = v; if ((old ^ v) & 0x3) this.flushTLB(); if ((old ^ v) & 1) this.flushTLB(); if (this.log && ((old ^ v) & 0x2005)) this.log('SCTLR ' + (old >>> 0).toString(16) + ' -> ' + (v >>> 0).toString(16) + ((v & 1) ? ' (MMU on)' : ' (MMU off)')); return; }
      case 0x1001: this.actlr = v; return; case 0x1002: this.cpacr = v; return;
      case 0x2000: this.ttbr0 = v; this.flushTLB(); return; case 0x2001: this.ttbr1 = v; this.flushTLB(); return; case 0x2002: this.ttbcr = v; this.flushTLB(); return;
      case 0x3000: this.dacr = v; this.flushTLB(); return;
      case 0x5000: this.dfsr = v; return; case 0x5001: this.ifsr = v; return;
      case 0x6000: this.dfar = v; return; case 0x6002: this.ifar = v; return;
      case 0xA020: this.prrr = v; return; case 0xA021: this.nmrr = v; return;
      case 0xC000: this.vbar = v; return;
      case 0xD000: this.fcse = v; this.flushTLB(); return; case 0xD001: this.contextidr = v; return;
      case 0xD002: this.tpidrurw = v; return; case 0xD003: this.tpidruro = v; return; case 0xD004: this.tpidrprw = v; return;
      case 0x9020: this.auxl2 = v; return; case 0x9C00: this.pmcr = v; return;
    }
    if (crn === 8) { this.flushTLB(); return; }                       // TLB maintenance
    if (crn === 7) {                                                  // cache / barrier / address translation ops
      if (crm === 0 && o2 === 4) { this.wfi = true; this.xb = 1; return; }           // WFI (ARMv6 encoding)
      if (crm === 8) { this.atsOp(o1, o2, v); return; }
      this.fvpn = -1; return;                                          // all other cache ops: nothing to do (no caches)
    }
    if (crn === 9 || crn === 10 || crn === 11 || crn === 15 || crn === 5 || crn === 12) return; // perf monitors, lockdown, DMA, impl-defined: ignore
    this.stats.cp15unk++; if (this.log) this.log('cp15 write unknown c' + crn + ',' + o1 + ',c' + crm + ',' + o2 + ' = ' + (v >>> 0).toString(16) + ' @pc=' + (this.R[15] >>> 0).toString(16));
  }
  atsOp(o1, o2, v) { // address translation: result goes to PAR
    try { const priv = (o2 & 2) ? 0 : 1, kind = (o2 & 1) ? 1 : 0; const pa = this.xlate(v >>> 0, kind, priv); this.par = (pa & 0xFFFFF000) | 0; }
    catch (e) { if (e instanceof Abort) this.par = 1 | (e.fs << 1); else throw e; }
  }

  // ------------------------------------------------------------ host helpers
  reset(entry, mode) { this.switchMode(mode === undefined ? M_SVC : mode); this.I = this.F = this.A = 1; this.T = 0; this.IT = 0; this.R[15] = entry | 0; this.npc = entry; this.flushTLB(); }
  readVirtual(va, len) { const out = new Uint8Array(len); for (let i = 0; i < len; i++) out[i] = this.rd8((va + i) >>> 0); return out; }
}
module.exports = { CPU, Abort, M_USR, M_FIQ, M_IRQ, M_SVC, M_ABT, M_UND, M_SYS };
