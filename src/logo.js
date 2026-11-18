'use strict';
// iBoot boot-screen images ("iBootIm": LZSS-compressed grey+alpha or ARGB bitmaps, e.g. applelogo.*.img3 from the user's IPSW).
// iWebOS replaces iBoot, so it does what iBoot does before starting the kernel: draw the logo centred on a black screen.
const { lzssDecompress } = require('./img3.js');

function decodeIBootIm(b) {
  const tag = String.fromCharCode(...b.subarray(0, 7));
  if (tag !== 'iBootIm') throw new Error('not an iBootIm image');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const comp = String.fromCharCode(b[0x0F], b[0x0E], b[0x0D], b[0x0C]);   // stored little-endian: 'sszl' -> 'lzss'
  const fmt = String.fromCharCode(b[0x13], b[0x12], b[0x11], b[0x10]);    // 'argb' or 'grey'
  const w = dv.getUint16(0x14, true), h = dv.getUint16(0x16, true);
  if (comp !== 'lzss') throw new Error('unknown iBootIm compression ' + JSON.stringify(comp));
  if (!w || !h || w > 4096 || h > 4096) throw new Error('bad iBootIm size ' + w + 'x' + h);
  const bpp = fmt === 'argb' ? 4 : 2;
  const px = lzssDecompress(b.subarray(0x40), w * h * bpp);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (bpp === 2) { const g = px[i * 2], a = 255 - px[i * 2 + 1]; /* second byte is transparency (255 = see-through) */ rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = a; }
    else { rgba[i * 4] = px[i * 4 + 2]; rgba[i * 4 + 1] = px[i * 4 + 1]; rgba[i * 4 + 2] = px[i * 4]; rgba[i * 4 + 3] = px[i * 4 + 3]; } // stored B,G,R,A
  }
  return { w, h, fmt, rgba, short: px.length < w * h * bpp };
}

// composite onto black and write into the framebuffer (32-bit 0x00RRGGBB pixels, rowBytes = fbW*4) at physical fb offset
function drawLogo(ram, fbOff, fbW, fbH, img) {
  const x0 = ((fbW - img.w) / 2) | 0, y0 = ((fbH - img.h) / 2) | 0;
  const row = new Uint8Array(img.w * 4);
  for (let y = 0; y < img.h; y++) {
    const yy = y0 + y; if (yy < 0 || yy >= fbH) continue;
    for (let x = 0; x < img.w; x++) {
      const s = (y * img.w + x) * 4, a = img.rgba[s + 3] / 255;
      row[x * 4] = Math.round(img.rgba[s + 2] * a); row[x * 4 + 1] = Math.round(img.rgba[s + 1] * a); row[x * 4 + 2] = Math.round(img.rgba[s] * a); row[x * 4 + 3] = 0;
    }
    ram.writeBytes(fbOff + (yy * fbW + x0) * 4, row);
  }
  return { x: x0, y: y0 };
}
module.exports = { decodeIBootIm, drawLogo };
