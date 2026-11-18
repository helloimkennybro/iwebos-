'use strict';
// iWebOS physical memory: lazy 64 KB pages, zero-page elision, cold-page LZ4 compression, MMIO bus.

// ---- LZ4 block codec (own implementation) ----
const HT = new Int32Array(1 << 13);
function lz4Compress(src, n, dst) { // returns compressed size, or -1 if it does not fit in dst
  HT.fill(-1);
  let ip = 0, anchor = 0, op = 0, miss = 0;
  const limit = n - 12, dlen = dst.length;
  while (ip < limit) {
    const seq = (src[ip] | (src[ip + 1] << 8) | (src[ip + 2] << 16) | (src[ip + 3] << 24));
    const h = (Math.imul(seq, 2654435761) >>> 19);
    const ref = HT[h]; HT[h] = ip;
    if (ref >= 0 && ip - ref < 65536 &&
        src[ref] === src[ip] && src[ref + 1] === src[ip + 1] && src[ref + 2] === src[ip + 2] && src[ref + 3] === src[ip + 3]) {
      let m = 4; const maxm = n - 5 - ip;
      while (m < maxm && src[ref + m] === src[ip + m]) m++;
      const lit = ip - anchor;
      if (op + 1 + lit + (lit >= 15 ? (lit - 15) / 255 + 1 : 0) + 2 + (m >= 19 ? ((m - 19) / 255 | 0) + 1 : 0) + 8 > dlen) return -1;
      const tp = op++;
      let tok = (lit >= 15 ? 15 : lit) << 4;
      if (lit >= 15) { let r = lit - 15; while (r >= 255) { dst[op++] = 255; r -= 255; } dst[op++] = r; }
      for (let i = 0; i < lit; i++) dst[op++] = src[anchor + i];
      const off = ip - ref; dst[op++] = off & 255; dst[op++] = off >> 8;
      const ml = m - 4;
      if (ml >= 15) { tok |= 15; let r = ml - 15; while (r >= 255) { dst[op++] = 255; r -= 255; } dst[op++] = r; } else tok |= ml;
      dst[tp] = tok;
      ip += m; anchor = ip; miss = 0;
    } else ip += 1 + (miss++ >> 5);   // LZ4-style acceleration: skip faster through data that does not compress
  }
  const lit = n - anchor;
  if (op + 1 + lit + (lit >= 15 ? (lit - 15) / 255 + 1 : 0) > dlen) return -1;
  let tok = (lit >= 15 ? 15 : lit) << 4; dst[op++] = tok;
  if (lit >= 15) { let r = lit - 15; while (r >= 255) { dst[op++] = 255; r -= 255; } dst[op++] = r; }
  for (let i = 0; i < lit; i++) dst[op++] = src[anchor + i];
  return op;
}
function lz4Decompress(src, dst) {
  let ip = 0, op = 0; const n = src.length;
  while (ip < n) {
    const tok = src[ip++]; let lit = tok >> 4;
    if (lit === 15) { let b; do { b = src[ip++]; lit += b; } while (b === 255); }
    for (let i = 0; i < lit; i++) dst[op++] = src[ip++];
    if (ip >= n) break;
    const off = src[ip] | (src[ip + 1] << 8); ip += 2;
    let ml = tok & 15; if (ml === 15) { let b; do { b = src[ip++]; ml += b; } while (b === 255); }
    ml += 4; let mp = op - off;
    for (let i = 0; i < ml; i++) dst[op++] = dst[mp++];
  }
  return op;
}

const PAGE = 65536, SHIFT = 16;
const CTX = 1 << 20; // bytes reserved at the start of the backing memory for CPU state shared with compiled (WebAssembly) code

// Guest RAM lives in a fixed pool of 64 KB slots inside one backing buffer — a WebAssembly.Memory when available, so compiled
// WebAssembly blocks can address guest pages directly. Pages get a slot on first touch; cold pages are LZ4-compressed (or dropped
// if all zero) and give their slot back. When the pool is smaller than the guest RAM and full, the coldest page is evicted.
class Ram {
  constructor(base, size, opts) {
    opts = opts || {};
    this.base = base >>> 0; this.size = size >>> 0; this.np = size >>> SHIFT;
    this.poolPages = Math.min(this.np, Math.max(16, (opts.poolBytes || size) >>> SHIFT));
    const bytes = CTX + this.poolPages * PAGE;
    this.wmem = null;
    if (opts.wasm !== false && typeof WebAssembly === 'object') {
      try { const pg = bytes >>> 16; this.wmem = new WebAssembly.Memory({ initial: pg, maximum: pg }); } catch (e) { this.wmem = null; }
    }
    this.buffer = this.wmem ? this.wmem.buffer : new ArrayBuffer(bytes);
    this.poolOff = CTX;
    this.R8 = new Array(this.np); this.R16 = new Array(this.np); this.R32 = new Array(this.np); // read-mapped
    this.W8 = new Array(this.np); this.W16 = new Array(this.np); this.W32 = new Array(this.np); // write-mapped
    this.slot = new Int32Array(this.np).fill(-1);   // pool slot holding page i (mapped or cooling), -1 if not resident
    this.owner = new Int32Array(this.poolPages).fill(-1);
    this.free = []; for (let k = this.poolPages - 1; k >= 0; k--) this.free.push(k); // lowest slot first keeps the touched area compact
    this.hand = 0;                             // clock hand for forced eviction
    this.comp = new Array(this.np);            // compressed copy (valid while clean) or undefined
    this.raw = new Uint8Array(this.np);        // comp[i] is an uncompressed copy (forced eviction of incompressible data)
    this.zero = new Uint8Array(this.np).fill(1); // page is all zeros and has no storage
    this.dirty = new Uint8Array(this.np);      // resident copy differs from compressed copy
    this.touched = new Uint8Array(this.np);
    this.cold = new Uint8Array(this.np);       // sweeps since the page was last touched
    this.refaults = new Uint8Array(this.np);   // how often the page came back soon after being released (needs to stay longer)
    this.resident = 0; this.compBytes = 0; this.compPages = 0; this.zeroPages = this.np; this.faults = 0; this.evictions = 0;
    this.scratch = new Uint8Array(PAGE + 1024);
    this.onWrite = null; // hook: (pageIndex) called when a page becomes write-mapped
    // JIT support: pages holding compiled code are never write-mapped; writes go through codeWrite(), which invalidates the 4 KB frame
    this.codePg = new Uint8Array(this.np); this.cf = new Uint8Array(this.np * 16); this.onCode = null; this.onSweep = null;
  }
  addrOf(o) { return this.poolOff + this.slot[o >>> SHIFT] * PAGE + (o & 0xFFFF); } // byte address in buffer (page must be resident)
  slotView(sl) { return new Uint8Array(this.buffer, this.poolOff + sl * PAGE, PAGE); }
  // bring page i into residence and map it for reading
  mapR(i) {
    let sl = this.slot[i];
    if (sl < 0) {
      this.faults++;
      if (this.cold[i] === 255 && this.refaults[i] < 255) this.refaults[i]++;   // released at the last sweep and needed again
      sl = this.allocSlot(i);
      const v = this.slotView(sl);
      if (this.zero[i]) { v.fill(0); this.zero[i] = 0; this.zeroPages--; this.dirty[i] = 0; }
      else if (this.comp[i]) { if (this.raw[i]) v.set(this.comp[i]); else lz4Decompress(this.comp[i], v); this.dirty[i] = 0; }
      else v.fill(0);
      this.resident++;
    }
    this.cold[i] = 0;
    const a = this.poolOff + sl * PAGE;
    this.R8[i] = new Uint8Array(this.buffer, a, PAGE); this.R16[i] = new Uint16Array(this.buffer, a, PAGE >> 1); this.R32[i] = new Uint32Array(this.buffer, a, PAGE >> 2);
    this.touched[i] = 1;
  }
  allocSlot(i) {
    if (this.free.length === 0) this.evictOne(i);
    const sl = this.free.pop(); this.slot[i] = sl; this.owner[sl] = i; return sl;
  }
  // pool full: push out the coldest page (cooling pages first, then anything but `keep`)
  evictOne(keep) {
    for (let pass = 0; pass < 3; pass++) {
      for (let n = 0; n < this.poolPages; n++) {
        const sl = this.hand; this.hand = (this.hand + 1) % this.poolPages;
        const i = this.owner[sl]; if (i < 0 || i === keep) continue;
        const mapped = !!this.R8[i];
        if (pass === 0 && mapped) continue;                       // first look for unmapped (cooling) pages
        if (pass === 1 && mapped && this.touched[i]) { this.touched[i] = 0; continue; } // second chance
        this.release(i, true);
        if (mapped && this.onSweep) this.onSweep();               // CPU caches may hold views of the evicted page
        this.evictions++;
        return;
      }
    }
    throw new Error('RAM pool exhausted');
  }
  unmap(i) { this.R8[i] = this.R16[i] = this.R32[i] = undefined; this.W8[i] = this.W16[i] = this.W32[i] = undefined; }
  // give page i's slot back, keeping its contents as zero / compressed (force: store raw if incompressible). false if kept.
  release(i, force) {
    const sl = this.slot[i], v = this.slotView(sl);
    let gone = false;
    if (!this.dirty[i] && this.comp[i]) gone = true;
    else {
      const u32 = new Uint32Array(this.buffer, this.poolOff + sl * PAGE, PAGE >> 2);
      let z = true; for (let k = 0; k < u32.length; k++) if (u32[k]) { z = false; break; }
      if (z) { if (this.comp[i]) { this.compBytes -= this.comp[i].length; this.compPages--; this.comp[i] = undefined; } this.zero[i] = 1; this.zeroPages++; this.dirty[i] = 0; gone = true; }
      else {
        const n = lz4Compress(v, PAGE, this.scratch);
        if (n >= 0 && n < PAGE - 512) { this.setComp(i, this.scratch.slice(0, n), 0); gone = true; }
        else if (force) { this.setComp(i, v.slice(), 1); gone = true; }
      }
    }
    if (!gone) return false;
    this.unmap(i); this.slot[i] = -1; this.owner[sl] = -1; this.free.push(sl); this.resident--; this.dirty[i] = 0;
    return true;
  }
  setComp(i, c, raw) {
    if (this.comp[i]) { this.compBytes -= this.comp[i].length; this.compPages--; }
    this.comp[i] = c; this.raw[i] = raw; this.compBytes += c.length; this.compPages++;
  }
  markDirty(i) {
    this.dirty[i] = 1;
    if (this.comp[i]) { this.compBytes -= this.comp[i].length; this.compPages--; this.comp[i] = undefined; }
  }
  mapW(i) {
    if (!this.R8[i]) this.mapR(i);
    this.W8[i] = this.R8[i]; this.W16[i] = this.R16[i]; this.W32[i] = this.R32[i];
    this.markDirty(i);
    if (this.onWrite) this.onWrite(i);
  }
  // write to a page that contains compiled code (slow path): drop the code of the written 4 KB frame, then store
  codeWrite(o, v, size) {
    const i = o >>> SHIFT;
    if (!this.R8[i]) this.mapR(i);
    this.markDirty(i);
    const fr = o >>> 12;
    if (this.cf[fr]) { this.cf[fr] = 0; if (this.onCode) this.onCode(fr); }
    if (size === 4) this.R32[i][(o & 0xFFFF) >>> 2] = v; else if (size === 2) this.R16[i][(o & 0xFFFF) >>> 1] = v; else this.R8[i][o & 0xFFFF] = v;
  }
  codeKill(i) { // forget all compiled code of 64 KB page i
    for (let k = 0; k < 16; k++) { const fr = i * 16 + k; if (this.cf[fr]) { this.cf[fr] = 0; if (this.onCode) this.onCode(fr); } }
    this.codePg[i] = 0;
  }
  r8(o) { const i = o >>> SHIFT; let p = this.R8[i]; if (!p) { this.mapR(i); p = this.R8[i]; } return p[o & 0xFFFF]; }
  r16(o) { const i = o >>> SHIFT; let p = this.R16[i]; if (!p) { this.mapR(i); p = this.R16[i]; } return p[(o & 0xFFFF) >>> 1]; }
  r32(o) { const i = o >>> SHIFT; let p = this.R32[i]; if (!p) { this.mapR(i); p = this.R32[i]; } return p[(o & 0xFFFF) >>> 2]; }
  w8(o, v) { const i = o >>> SHIFT; let p = this.W8[i]; if (!p) { if (this.codePg[i]) { this.codeWrite(o, v, 1); return; } this.mapW(i); p = this.W8[i]; } p[o & 0xFFFF] = v; }
  w16(o, v) { const i = o >>> SHIFT; let p = this.W16[i]; if (!p) { if (this.codePg[i]) { this.codeWrite(o, v, 2); return; } this.mapW(i); p = this.W16[i]; } p[(o & 0xFFFF) >>> 1] = v; }
  w32(o, v) { const i = o >>> SHIFT; let p = this.W32[i]; if (!p) { if (this.codePg[i]) { this.codeWrite(o, v, 4); return; } this.mapW(i); p = this.W32[i]; } p[(o & 0xFFFF) >>> 2] = v; }
  // bulk helpers (host side)
  writeBytes(o, bytes) { for (let k = 0; k < bytes.length;) { const i = (o + k) >>> SHIFT, po = (o + k) & 0xFFFF; if (this.codePg[i]) this.codeKill(i); if (!this.W8[i]) this.mapW(i); const n = Math.min(PAGE - po, bytes.length - k); this.W8[i].set(bytes.subarray(k, k + n), po); k += n; } }
  fillBytes(o, v, len) { for (let k = 0; k < len;) { const i = (o + k) >>> SHIFT, po = (o + k) & 0xFFFF; if (this.codePg[i]) this.codeKill(i); if (!this.W8[i]) this.mapW(i); const n = Math.min(PAGE - po, len - k); this.W8[i].fill(v, po, po + n); k += n; } }
  readBytes(o, len) { const out = new Uint8Array(len); for (let k = 0; k < len;) { const i = (o + k) >>> SHIFT, po = (o + k) & 0xFFFF; if (!this.R8[i]) this.mapR(i); const n = Math.min(PAGE - po, len - k); out.set(this.R8[i].subarray(po, po + n), k); k += n; } return out; }
  // Called periodically. Pages untouched since the previous sweep are compressed/dropped; the rest are unmapped to detect reuse.
  sweep() {
    let freed = 0;
    for (let i = 0; i < this.np; i++) {
      if (this.slot[i] < 0) continue;
      if (this.R8[i]) { this.unmap(i); this.touched[i] = 0; this.cold[i] = 0; continue; } // mapped: cool it (unmap), keep the slot
      // still unmapped: compress / drop once it has stayed cold long enough (pages that keep coming back wait longer)
      if (++this.cold[i] >= 1 + Math.min(6, this.refaults[i])) { if (this.release(i, false)) { freed++; this.cold[i] = 255; } }
    }
    if (this.onSweep) this.onSweep();
    return freed;
  }
  stats() {
    const r = this.resident * 64, c = this.compBytes / 1024 | 0;
    return { residentKB: r * 1, compressedKB: c, compPages: this.compPages, zeroPages: this.zeroPages, pages: this.np, faults: this.faults, poolKB: this.poolPages * 64, evictions: this.evictions, wasm: !!this.wmem };
  }
}

// MMIO bus: devices claim physical ranges. dev.read(off,size)/dev.write(off,size,val)
class Bus {
  constructor(ram) { this.ram = ram; this.devs = []; this.last = null; this.log = null; this.unmapped = 0; }
  map(start, size, dev, name) { this.devs.push({ start: start >>> 0, end: (start + size) >>> 0, dev, name: name || dev.name || '?' }); }
  find(pa) {
    const l = this.last; if (l && pa >= l.start && pa < l.end) return l;
    for (const d of this.devs) if (pa >= d.start && pa < d.end) { this.last = d; return d; }
    return null;
  }
  read(pa, size) {
    const d = this.find(pa);
    if (!d) { this.unmapped++; if (this.log) this.log('unmapped read' + size * 8 + ' @' + (pa >>> 0).toString(16) + (this.cpu ? ' pc=' + (this.cpu.R[15] >>> 0).toString(16) : '')); return 0; }
    return d.dev.read(pa - d.start, size) >>> 0;
  }
  write(pa, size, v) {
    const d = this.find(pa);
    if (!d) { this.unmapped++; if (this.log) this.log('unmapped write' + size * 8 + ' @' + (pa >>> 0).toString(16) + ' = ' + (v >>> 0).toString(16) + (this.cpu ? ' pc=' + (this.cpu.R[15] >>> 0).toString(16) : '')); return; }
    d.dev.write(pa - d.start, size, v >>> 0);
  }
}
module.exports = { Ram, Bus, lz4Compress, lz4Decompress, PAGE, CTX };
