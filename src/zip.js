'use strict';
// Minimal streaming-free ZIP reader over a Blob/File (reads only the central directory and the entries you ask for) + own inflate.
function inflate(src, outSize) {
  const out = new Uint8Array(outSize || src.length * 3 + 1024); let op = 0, ip = 0, bb = 0, bc = 0;
  const grow = n => { if (op + n > out.length) { throw new Error('inflate: output overflow'); } };
  const need = n => { while (bc < n) { bb |= src[ip++] << bc; bc += 8; } };
  const bits = n => { if (!n) return 0; need(n); const v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; };
  const LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258], LE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577], DE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  function build(lens) { // canonical Huffman decode tables (count/symbol)
    const count = new Uint16Array(16), sym = new Uint16Array(lens.length);
    for (const l of lens) count[l]++; count[0] = 0;
    const offs = new Uint16Array(16); for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let s = 0; s < lens.length; s++) if (lens[s]) sym[offs[lens[s]]++] = s;
    return { count, sym };
  }
  function decode(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1); const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: bad code');
  }
  let fixedL = null, fixedD = null;
  for (;;) {
    const last = bits(1), type = bits(2);
    if (type === 0) {
      bb = 0; bc = 0; const len = src[ip] | (src[ip + 1] << 8); ip += 4;
      grow(len); out.set(src.subarray(ip, ip + len), op); op += len; ip += len;
    } else if (type === 1 || type === 2) {
      let hl, hd;
      if (type === 1) {
        if (!fixedL) { const l = new Uint8Array(288); l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288); fixedL = build(l); fixedD = build(new Uint8Array(30).fill(5)); }
        hl = fixedL; hd = fixedD;
      } else {
        const nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4, ord = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15], cl = new Uint8Array(19);
        for (let i = 0; i < nc; i++) cl[ord[i]] = bits(3);
        const hc = build(cl), lens = new Uint8Array(nl + nd);
        for (let i = 0; i < nl + nd;) {
          const s = decode(hc);
          if (s < 16) lens[i++] = s;
          else { let prev = 0, rep; if (s === 16) { prev = lens[i - 1]; rep = 3 + bits(2); } else if (s === 17) rep = 3 + bits(3); else rep = 11 + bits(7); while (rep--) lens[i++] = prev; }
        }
        hl = build(lens.subarray(0, nl)); hd = build(lens.subarray(nl));
      }
      for (;;) {
        const s = decode(hl);
        if (s < 256) { grow(1); out[op++] = s; }
        else if (s === 256) break;
        else {
          const li = s - 257, len = LB[li] + bits(LE[li]), di = decode(hd), dist = DB[di] + bits(DE[di]);
          grow(len); for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
        }
      }
    } else throw new Error('inflate: bad block');
    if (last) break;
  }
  return out.subarray(0, op);
}
async function openZip(blob) {
  const size = blob.size, tailLen = Math.min(size, 70000);
  const tail = new Uint8Array(await blob.slice(size - tailLen, size).arrayBuffer());
  const tdv = new DataView(tail.buffer);
  let e = tail.length - 22; while (e >= 0 && tdv.getUint32(e, true) !== 0x06054B50) e--;
  if (e < 0) throw new Error('not a ZIP/IPSW file (no end-of-central-directory record)');
  const n = tdv.getUint16(e + 10, true), cdSize = tdv.getUint32(e + 12, true), cdOff = tdv.getUint32(e + 16, true);
  if (cdOff === 0xFFFFFFFF) throw new Error('ZIP64 archives are not supported');
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer()), dv = new DataView(cd.buffer);
  const dec = new TextDecoder(), entries = new Map(); let o = 0;
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(o, true) !== 0x02014B50) throw new Error('corrupt central directory');
    const method = dv.getUint16(o + 10, true), csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true), nl = dv.getUint16(o + 28, true), el = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true), off = dv.getUint32(o + 42, true);
    entries.set(dec.decode(cd.subarray(o + 46, o + 46 + nl)), { method, csize, usize, off }); o += 46 + nl + el + cl;
  }
  return {
    names: () => [...entries.keys()],
    has: nm => entries.has(nm),
    info: nm => entries.get(nm),
    async read(nm) {
      const en = entries.get(nm); if (!en) throw new Error('missing in IPSW: ' + nm);
      const lh = new DataView(await blob.slice(en.off, en.off + 30).arrayBuffer());
      const ds = en.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const raw = new Uint8Array(await blob.slice(ds, ds + en.csize).arrayBuffer());
      if (en.method === 0) return raw;
      if (en.method === 8) return inflate(raw, en.usize);
      throw new Error('unsupported ZIP method ' + en.method);
    },
  };
}
module.exports = { openZip, inflate };
