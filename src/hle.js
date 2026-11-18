'use strict';
// iWebOS high-level emulation (HLE) of hot kernel library routines.
//
// When the CPU arrives at the entry of one of these functions, the work is done here in one step (with typed-array copies/fills)
// and the CPU returns straight to the caller. Every routine first checks that all memory it will touch is ordinary RAM that the
// current privilege level may access; if anything is unusual (MMIO, unmapped page, tiny length) it declines and the real ARM code
// runs instead, so the guest can never observe a difference except in how many instructions were spent.
const { Abort } = require('./cpu.js');
const { TICK_DIV } = require('./soc.js');

const MIN_BYTES = 64; // below this the call overhead outweighs the work; let the guest code run

// RAM offset for a virtual address, or -1 if it is not plain RAM / would fault. No guest-visible side effects.
function ramOff(cpu, va, write) {
  try {
    const pa = cpu.tl(va >>> 0, write ? 1 : 0), o = (pa - cpu.rb) >>> 0;
    return o < cpu.rs ? o : -1;
  } catch (e) { if (e instanceof Abort) return -1; throw e; }
}
// physical segments covering [va, va+len) split at 4 KB pages: [ramOffset, length, ...] or null
function segments(cpu, va, len, write) {
  const out = [];
  let k = 0;
  while (k < len) {
    const a = (va + k) >>> 0, n = Math.min(0x1000 - (a & 0xFFF), len - k);
    const o = ramOff(cpu, a, write);
    if (o < 0) return null;
    out.push(o, n); k += n;
  }
  return out;
}
function ret(cpu, r0) { // return to the caller (bx lr)
  const R = cpu.R, lr = R[14] >>> 0;
  if (r0 !== undefined) R[0] = r0;
  cpu.T = lr & 1; R[15] = (lr & ~1) | 0; cpu.xb = 1;
}

function copy(cpu, dst, src, len) { // memmove semantics
  if (len < MIN_BYTES || len > (64 << 20)) return false;
  const s = segments(cpu, src, len, false); if (!s) return false;
  const d = segments(cpu, dst, len, true); if (!d) return false;
  const ram = cpu.ram, tmp = new Uint8Array(len);
  let k = 0;
  for (let i = 0; i < s.length; i += 2) { tmp.set(ram.readBytes(s[i], s[i + 1]), k); k += s[i + 1]; }
  k = 0;
  for (let i = 0; i < d.length; i += 2) { ram.writeBytes(d[i], tmp.subarray(k, k + d[i + 1])); k += d[i + 1]; }
  return true;
}
function fill(cpu, dst, val, len) {
  if (len < MIN_BYTES || len > (256 << 20)) return false;
  const d = segments(cpu, dst, len, true); if (!d) return false;
  for (let i = 0; i < d.length; i += 2) cpu.ram.fillBytes(d[i], val & 255, d[i + 1]);
  return true;
}
// length of the NUL-terminated string at va (scanning at most max bytes), or -1 if memory is unusual
function cstrlen(cpu, va, max) {
  const ram = cpu.ram;
  let a = va >>> 0, n = 0;
  while (n < max) {
    const o = ramOff(cpu, a, false); if (o < 0) return -1;
    const pg = o >>> 16; if (!ram.R8[pg]) ram.mapR(pg);
    const v = ram.R8[pg], po = o & 0xFFFF, m = Math.min(0x1000 - (a & 0xFFF), max - n);
    for (let i = 0; i < m; i++) { if (v[po + i] === 0) return n + i; }
    n += m; a = (a + m) >>> 0;
  }
  return n;
}
function byteAt(cpu, va) { // caller guarantees the string was validated by cstrlen
  const o = ramOff(cpu, va >>> 0, false), pg = o >>> 16; return cpu.ram.R8[pg][o & 0xFFFF];
}
function cmpStrings(cpu, a, b, n) { // n bytes at most; both strings validated
  for (let i = 0; i < n; i++) {
    const x = byteAt(cpu, a + i), y = byteAt(cpu, b + i);
    if (x !== y) return x - y;
    if (x === 0) return 0;
  }
  return 0;
}

// handlers return the number of instruction-equivalents to charge, or 0 to decline (run the real code)
const HANDLERS = {
  _bzero(cpu) { const R = cpu.R, len = R[1] >>> 0; if (!fill(cpu, R[0] >>> 0, 0, len)) return 0; ret(cpu); return 4 + (len >>> 5); },
  _memset(cpu) { const R = cpu.R, dst = R[0], len = R[2] >>> 0; if (!fill(cpu, dst >>> 0, R[1], len)) return 0; ret(cpu, dst); return 4 + (len >>> 5); },
  _bcopy(cpu) { const R = cpu.R, len = R[2] >>> 0; if (!copy(cpu, R[1] >>> 0, R[0] >>> 0, len)) return 0; ret(cpu); return 4 + (len >>> 4); },
  _memcpy(cpu) { const R = cpu.R, dst = R[0], len = R[2] >>> 0; if (!copy(cpu, dst >>> 0, R[1] >>> 0, len)) return 0; ret(cpu, dst); return 4 + (len >>> 4); },
  _strlen(cpu) { const n = cstrlen(cpu, cpu.R[0], 1 << 20); if (n < 0 || n >= (1 << 20)) return 0; ret(cpu, n); return 4 + (n >>> 2); },
  _strnlen(cpu) { const max = cpu.R[1] >>> 0, lim = Math.min(max, 1 << 20); const n = cstrlen(cpu, cpu.R[0], lim); if (n < 0 || (n === lim && lim < max)) return 0; ret(cpu, n); return 4 + (n >>> 2); },
  _strcmp(cpu) {
    const a = cpu.R[0] >>> 0, b = cpu.R[1] >>> 0, la = cstrlen(cpu, a, 1 << 16), lb = cstrlen(cpu, b, 1 << 16);
    if (la < 0 || lb < 0 || la >= (1 << 16) || lb >= (1 << 16)) return 0;
    const n = Math.min(la, lb) + 1; ret(cpu, cmpStrings(cpu, a, b, n)); return 4 + n;
  },
  _strncmp(cpu) {
    const a = cpu.R[0] >>> 0, b = cpu.R[1] >>> 0, max = cpu.R[2] >>> 0; if (max === 0) { ret(cpu, 0); return 3; }
    const lim = Math.min(max, 1 << 16), la = cstrlen(cpu, a, lim), lb = cstrlen(cpu, b, lim);
    if (la < 0 || lb < 0 || (lim < max && (la === lim || lb === lim))) return 0;
    const n = Math.min(lim, Math.min(la, lb) + 1); ret(cpu, cmpStrings(cpu, a, b, n)); return 4 + n;
  },
  // busy-wait delays: advance the guest clock instead of spinning (interrupts that fall due are delivered right after)
  _delay(cpu) { const us = Math.abs(cpu.R[0] | 0); cpu.cycles += Math.round(us * 24 * TICK_DIV); ret(cpu); return 4; },
  _IODelay(cpu) { const us = cpu.R[0] >>> 0; cpu.cycles += Math.round(us * 24 * TICK_DIV); ret(cpu); return 4; },
  _delay_for_interval(cpu) { const ns = (cpu.R[0] >>> 0) * (cpu.R[1] >>> 0); cpu.cycles += Math.round(ns * 0.024 * TICK_DIV); ret(cpu); return 4; },
  _clock_delay_until(cpu) {
    const deadline = (cpu.R[1] >>> 0) * 4294967296 + (cpu.R[0] >>> 0), c = deadline * TICK_DIV;
    if (c > cpu.cycles) cpu.cycles = c;
    ret(cpu); return 4;
  },
};
// _memmove and _ovbcopy share their entry points with _memcpy / _bcopy in this kernel; they are handled by address.

// Device shims for coprocessors that are not emulated. Each is pinned to exact instruction bytes so another build is never patched.
const SHIMS = [
  { // AppleS5L8920XARM7M: IOP health query (mode 1 = watchdog ping). The IOP firmware is not run, so report "healthy" (0).
    name: 'iop-watchdog', pc: 0xc04d1e8c, thumb: true, sig: [0xaf03b5f0, 0x0d00e92d],
    fn(cpu) { if (cpu.R[1] !== 1) return 0; ret(cpu, 0); return 6; } },
];
function installShims(cpu, ram, virt, phys, log) {
  let n = 0;
  for (const s of SHIMS) {
    const o = s.pc - virt;
    if (s.sig.every((w, i) => (ram.r32(o + i * 4) >>> 0) === w) && cpu.addHLE(s.pc, s.name, s.fn)) n++;
    else if (log) log('shim ' + s.name + ' not installed (code differs)');
  }
  return n;
}

function installHLE(cpu, syms, log) {
  const by = new Map(); for (const s of syms) if (!by.has(s.n)) by.set(s.n, s.v >>> 0);
  let n = 0;
  for (const name of Object.keys(HANDLERS)) {
    const a = by.get(name); if (a === undefined) continue;
    if (cpu.addHLE(a & ~1, name, HANDLERS[name])) n++; else if (log) log('hle: slot collision for ' + name);
  }
  return n;
}

module.exports = { installHLE, installShims, HANDLERS, ramOff };
