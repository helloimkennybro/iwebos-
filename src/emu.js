'use strict';
// iWebOS emulator facade: builds the machine from decrypted firmware and exposes run/inspect/trace helpers (used by the page's worker and by tools).
const { Ram, Bus, PAGE } = require('./mem.js');
const { CPU } = require('./cpu.js');
const { disasm } = require('./disasm.js');
const { Inst, decodeARM, decodeThumb } = require('./decode.js');
const { parseDT, dtStr, findNode } = require('./macho.js');
const { bootImage, PHYS, VIRT } = require('./boot.js');
const { Machine, attachDevices } = require('./soc.js');

const TRACE_RING = 1 << 15;
class Emulator {
  constructor(fw, opts) {
    opts = opts || {};
    this.ram = new Ram(PHYS, 256 << 20, { poolBytes: opts.poolBytes }); this.bus = new Bus(this.ram); this.cpu = new CPU(this.ram, this.bus);
    this.events = []; this.eventsDropped = 0; this.consoleText = ''; this.consoleSink = null;
    const log = s => { if (this.events.length < 4000) this.events.push(s); else this.eventsDropped++; };
    this.bus.log = log; this.bus.cpu = this.cpu; this.cpu.log = log;
    this.info = bootImage(this.ram, { kernel: fw.kernel, devicetree: fw.devicetree, ramdisk: fw.ramdisk }, { cmdline: opts.cmdline || '-v rd=md0', graphical: !!opts.graphical });
    if (fw.logo) { const { drawLogo } = require('./logo.js'); this.logoAt = drawLogo(this.ram, this.info.fb.base - PHYS, this.info.fb.w, this.info.fb.h, fw.logo); }
    const root = parseDT(fw.devicetree);
    this.devs = attachDevices(this.bus, this.cpu, root, log, { findNode, dtStr }, (c) => { this.uart(c); });
    this.machine = new Machine(this.cpu, this.devs);
    this.syms = this.info.macho.syms.filter(s => s.v >= 0xC0001000 && s.v < 0xC0930000).map(s => ({ v: (s.v & ~1) >>> 0, n: s.n })).sort((a, b) => a.v - b.v);
    // paravirtual hooks (verified by instruction bytes so a different build simply disables them)
    this.idleOK = this.ram.r32(0xC0063360 - VIRT) === 0xEE1D2F90;
    if (this.idleOK) this.cpu.idlePC = 0xC0063360;
    const cn = this.syms.find(s => s.n === '_cnputc');
    if (cn) { this.cpu.hookPC = cn.v; this.cpu.hookFn = c => { this.putc(c.R[0] & 0xFF); }; }
    if (opts.hle !== false) this.hleCount = require('./hle.js').installHLE(this.cpu, this.info.macho.syms, log);
    this.shims = require('./hle.js').installShims(this.cpu, this.ram, VIRT, PHYS, log);
    this.cpu.reset(this.info.entry); this.cpu.R[0] = this.info.bootArgs;
    this.ring = new Uint32Array(TRACE_RING * 4); this.ringPos = 0; this.ringCount = 0; this.tracing = false;
    this.fbBase = this.info.fb.base - PHYS; this.fbW = this.info.fb.w; this.fbH = this.info.fb.h;
    this.startMs = 0; this.ran = 0;
  }
  putc(c) { // kernel console character (tapped at cnputc)
    if (c === 13) return; this.consoleText += c === 10 ? '\n' : String.fromCharCode(c);
    if (c === 10 && this.consoleSink) { this.consoleSink(this.consoleText); this.consoleText = ''; }
  }
  uart(c) { /* serial output is mirrored by the cnputc tap; keep for completeness */ }
  run(n) { const r = this.machine.run(n); this.ran += r; return r; }
  sweep() { this.ram.sweep(); this.cpu.fvpn = -1; }
  setTrace(on) {
    this.tracing = !!on;
    if (!on) { this.cpu.trace = null; return; }
    const ring = this.ring;
    this.cpu.trace = (pc, I, cond, inIT) => {
      const o = (this.ringPos & (TRACE_RING - 1)) * 4; this.ringPos++; this.ringCount++;
      ring[o] = pc; ring[o + 1] = I.w >>> 0; ring[o + 2] = I.thumb ? (I.w2 >>> 0) : 0; ring[o + 3] = (I.thumb ? 1 : 0) | ((I.len === 4 ? 1 : 0) << 1) | ((inIT ? 1 : 0) << 2) | (cond << 4);
    };
  }
  symAt(a) {
    a = a >>> 0; const S = this.syms; if (!S.length || a < S[0].v) return '';
    let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].v <= a) lo = m; else hi = m - 1; }
    const d = a - S[lo].v; return S[lo].n.replace(/^_/, '') + (d ? '+0x' + d.toString(16) : '');
  }
  traceLines(count) { // format the most recent `count` instructions
    const out = [], I = new Inst(), have = Math.min(this.ringPos, TRACE_RING, count);
    for (let k = this.ringPos - have; k < this.ringPos; k++) {
      const o = (k & (TRACE_RING - 1)) * 4, pc = this.ring[o], w = this.ring[o + 1], w2 = this.ring[o + 2], fl = this.ring[o + 3], thumb = fl & 1, cond = fl >>> 4;
      let text;
      try { if (thumb) decodeThumb(w, w2, I); else decodeARM(w, I); text = disasm(I, pc, cond, !!(fl & 4)); } catch (e) { text = '??'; }
      out.push(pc.toString(16).padStart(8, '0') + '  ' + (thumb ? ((fl & 2) ? (w.toString(16).padStart(4, '0') + w2.toString(16).padStart(4, '0')) : w.toString(16).padStart(4, '0') + '    ') : w.toString(16).padStart(8, '0')) + '  ' + text + '  <' + this.symAt(pc) + '>');
    }
    return out;
  }
  frame() { // copy of the framebuffer as 0x00RRGGBB words
    const b = this.ram.readBytes(this.fbBase, this.fbW * this.fbH * 4); return new Uint32Array(b.buffer, 0, this.fbW * this.fbH);
  }
  stats() {
    const c = this.cpu, r = this.ram.stats();
    return { ran: this.ran, pc: c.R[15] >>> 0, sym: this.symAt(c.R[15] >>> 0), mode: c.mode, cycles: c.cycles, vms: Math.round(c.cycles / 40 / 24000), irq: c.stats.irq, jit: { blocks: c.jitStats.blocks, ex: c.jitStats.ex, on: c.jitEnabled && c.trace === null }, dabt: c.stats.dabt, pabt: c.stats.pabt, undef: c.stats.undef, vfp: c.stats.vfp, idleSkips: this.machine.idleSkips || 0, ram: r, unmapped: this.bus.unmapped };
  }
}
module.exports = { Emulator };
