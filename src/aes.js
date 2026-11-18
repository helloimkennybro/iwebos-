'use strict';
// AES-256-CBC decrypt without padding. Uses WebCrypto when available (padding trick), otherwise a table-driven JS fallback.
const SB = new Uint8Array(256), ISB = new Uint8Array(256);
(function () { // generate S-box
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xFF) ^ (p & 0x80 ? 0x1B : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xFF; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    const v = (x ^ 0x63) & 0xFF; SB[p] = v; ISB[v] = p;
  } while (p !== 1);
  SB[0] = 0x63; ISB[0x63] = 0;
})();
const xt = x => ((x << 1) ^ (x & 0x80 ? 0x11B : 0)) & 0xFF;
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
for (let i = 0; i < 256; i++) {
  const s = ISB[i];
  const w = ((mul(s, 14) << 24) | (mul(s, 9) << 16) | (mul(s, 13) << 8) | mul(s, 11)) >>> 0;
  TD[0][i] = w; TD[1][i] = ((w >>> 8) | (w << 24)) >>> 0; TD[2][i] = ((w >>> 16) | (w << 16)) >>> 0; TD[3][i] = ((w >>> 24) | (w << 8)) >>> 0;
}
function expandKey(key) { // 32-byte key -> encryption round keys (60 words)
  const nk = 8, nr = 14, w = new Uint32Array(4 * (nr + 1)); let rc = 1;
  for (let i = 0; i < nk; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  for (let i = nk; i < w.length; i++) {
    let t = w[i - 1];
    if (i % nk === 0) { t = ((t << 8) | (t >>> 24)) >>> 0; t = ((SB[t >>> 24] << 24) | (SB[(t >>> 16) & 255] << 16) | (SB[(t >>> 8) & 255] << 8) | SB[t & 255]) >>> 0; t = (t ^ (rc << 24)) >>> 0; rc = xt(rc); }
    else if (i % nk === 4) t = ((SB[t >>> 24] << 24) | (SB[(t >>> 16) & 255] << 16) | (SB[(t >>> 8) & 255] << 8) | SB[t & 255]) >>> 0;
    w[i] = (w[i - nk] ^ t) >>> 0;
  }
  return w;
}
function decKeys(key) { // equivalent inverse cipher keys
  const e = expandKey(key), nr = 14, d = new Uint32Array(e.length);
  for (let r = 0; r <= nr; r++) for (let c = 0; c < 4; c++) {
    let v = e[(nr - r) * 4 + c];
    if (r > 0 && r < nr) v = (TD[0][SB[v >>> 24]] ^ TD[1][SB[(v >>> 16) & 255]] ^ TD[2][SB[(v >>> 8) & 255]] ^ TD[3][SB[v & 255]]) >>> 0;
    d[r * 4 + c] = v;
  }
  return d;
}
function jsDecryptCBC(key, iv, data) {
  const dk = decKeys(key), out = new Uint8Array(data.length), n = data.length >> 4;
  let p0 = ((iv[0] << 24) | (iv[1] << 16) | (iv[2] << 8) | iv[3]) >>> 0, p1 = ((iv[4] << 24) | (iv[5] << 16) | (iv[6] << 8) | iv[7]) >>> 0,
    p2 = ((iv[8] << 24) | (iv[9] << 16) | (iv[10] << 8) | iv[11]) >>> 0, p3 = ((iv[12] << 24) | (iv[13] << 16) | (iv[14] << 8) | iv[15]) >>> 0;
  const T0 = TD[0], T1 = TD[1], T2 = TD[2], T3 = TD[3];
  for (let b = 0; b < n; b++) {
    const o = b * 16;
    const c0 = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0, c1 = ((data[o + 4] << 24) | (data[o + 5] << 16) | (data[o + 6] << 8) | data[o + 7]) >>> 0,
      c2 = ((data[o + 8] << 24) | (data[o + 9] << 16) | (data[o + 10] << 8) | data[o + 11]) >>> 0, c3 = ((data[o + 12] << 24) | (data[o + 13] << 16) | (data[o + 14] << 8) | data[o + 15]) >>> 0;
    let s0 = c0 ^ dk[0], s1 = c1 ^ dk[1], s2 = c2 ^ dk[2], s3 = c3 ^ dk[3], k = 4;
    for (let r = 1; r < 14; r++, k += 4) {
      const t0 = T0[s0 >>> 24] ^ T1[(s3 >>> 16) & 255] ^ T2[(s2 >>> 8) & 255] ^ T3[s1 & 255] ^ dk[k];
      const t1 = T0[s1 >>> 24] ^ T1[(s0 >>> 16) & 255] ^ T2[(s3 >>> 8) & 255] ^ T3[s2 & 255] ^ dk[k + 1];
      const t2 = T0[s2 >>> 24] ^ T1[(s1 >>> 16) & 255] ^ T2[(s0 >>> 8) & 255] ^ T3[s3 & 255] ^ dk[k + 2];
      const t3 = T0[s3 >>> 24] ^ T1[(s2 >>> 16) & 255] ^ T2[(s1 >>> 8) & 255] ^ T3[s0 & 255] ^ dk[k + 3];
      s0 = t0; s1 = t1; s2 = t2; s3 = t3;
    }
    const r0 = ((ISB[s0 >>> 24] << 24) | (ISB[(s3 >>> 16) & 255] << 16) | (ISB[(s2 >>> 8) & 255] << 8) | ISB[s1 & 255]) ^ dk[k];
    const r1 = ((ISB[s1 >>> 24] << 24) | (ISB[(s0 >>> 16) & 255] << 16) | (ISB[(s3 >>> 8) & 255] << 8) | ISB[s2 & 255]) ^ dk[k + 1];
    const r2 = ((ISB[s2 >>> 24] << 24) | (ISB[(s1 >>> 16) & 255] << 16) | (ISB[(s0 >>> 8) & 255] << 8) | ISB[s3 & 255]) ^ dk[k + 2];
    const r3 = ((ISB[s3 >>> 24] << 24) | (ISB[(s2 >>> 16) & 255] << 16) | (ISB[(s1 >>> 8) & 255] << 8) | ISB[s0 & 255]) ^ dk[k + 3];
    const x0 = (r0 ^ p0) >>> 0, x1 = (r1 ^ p1) >>> 0, x2 = (r2 ^ p2) >>> 0, x3 = (r3 ^ p3) >>> 0;
    out[o] = x0 >>> 24; out[o + 1] = x0 >>> 16; out[o + 2] = x0 >>> 8; out[o + 3] = x0;
    out[o + 4] = x1 >>> 24; out[o + 5] = x1 >>> 16; out[o + 6] = x1 >>> 8; out[o + 7] = x1;
    out[o + 8] = x2 >>> 24; out[o + 9] = x2 >>> 16; out[o + 10] = x2 >>> 8; out[o + 11] = x2;
    out[o + 12] = x3 >>> 24; out[o + 13] = x3 >>> 16; out[o + 14] = x3 >>> 8; out[o + 15] = x3;
    p0 = c0; p1 = c1; p2 = c2; p3 = c3;
  }
  return out;
}
async function decryptCBC(key, iv, data, forceJS) { // data.length must be a multiple of 16
  const sub = globalThis.crypto && globalThis.crypto.subtle;
  if (sub && !forceJS && data.length) {
    try {
      const k = await sub.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt']);
      const last = data.subarray(data.length - 16);
      const pad = await sub.encrypt({ name: 'AES-CBC', iv: last }, k, new Uint8Array(16).fill(16));   // E(pad ^ lastCipherBlock)
      const ext = new Uint8Array(data.length + 16); ext.set(data); ext.set(new Uint8Array(pad, 0, 16), data.length);
      return new Uint8Array(await sub.decrypt({ name: 'AES-CBC', iv }, k, ext));                        // final block decrypts to valid PKCS#7 padding and is stripped
    } catch (e) { /* fall through to JS */ }
  }
  return jsDecryptCBC(key, iv, data);
}
module.exports = { decryptCBC, jsDecryptCBC };
