'use strict';
// IPSW -> decrypted kernel / device tree / restore ramdisk. Keys are supplied by the user.
const { parseImg3, unwrapComplzss } = require('./img3.js');
const { openZip } = require('./zip.js');
const { decryptCBC } = require('./aes.js');
const hex = s => { s = String(s || '').replace(/[^0-9a-fA-F]/g, ''); const o = new Uint8Array(s.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; };
async function decryptImg3(raw, ivHex, keyHex, label, log) {
  const img = parseImg3(raw), iv = hex(ivHex), key = hex(keyHex);
  if (iv.length !== 16 || key.length !== 32) throw new Error(label + ': need a 32-hex-digit IV and a 64-hex-digit key');
  const n = img.data.length & ~15;
  const head = await decryptCBC(key, iv, img.data.subarray(0, n));
  const out = new Uint8Array(img.data.length); out.set(head); out.set(img.data.subarray(n), n);   // trailing bytes are not encrypted
  log && log(label + ': decrypted ' + img.data.length + ' bytes (IMG3 type ' + img.type + ')');
  return unwrapComplzss(out);
}
function between(s, a, b) { const i = s.indexOf(a); if (i < 0) return null; const j = s.indexOf(b, i + a.length); return j < 0 ? null : s.slice(i + a.length, j); }
async function loadFirmware(file, keys, log) {
  log = log || (() => {});
  const zip = await openZip(file);
  log('IPSW opened: ' + zip.names().length + ' entries');
  let product = '', version = '', build = '', ramName = null;
  if (zip.has('Restore.plist')) {
    const t = new TextDecoder().decode(await zip.read('Restore.plist'));
    const val = k => { const m = t.match(new RegExp('<key>' + k + '</key>\\s*<string>([^<]*)</string>')); return m ? m[1] : ''; };
    product = val('ProductType'); version = val('ProductVersion'); build = val('ProductBuildVersion');
    const rr = between(t, '<key>RestoreRamDisks</key>', '</dict>');
    if (rr) { const m = rr.match(/<key>User<\/key>\s*<string>([^<]*)<\/string>/); if (m) ramName = m[1]; }
  }
  log('Firmware: ' + (product || '?') + ' ' + (version || '?') + ' (' + (build || '?') + ')');
  if (product && product !== 'iPad1,1') throw new Error('This is a ' + product + ' firmware. iWebOS emulates iPad1,1 (A4) - please pick the iPad 3.2 IPSW.');
  const names = zip.names();
  const kName = names.find(n => /^kernelcache\.release\.k48$/.test(n)) || names.find(n => /^kernelcache\.release\./.test(n));
  const dName = names.find(n => /DeviceTree\.k48ap\.img3$/.test(n));
  if (!kName) throw new Error('kernelcache not found in this IPSW');
  if (!dName) throw new Error('DeviceTree.k48ap not found in this IPSW');
  if (!ramName || !zip.has(ramName)) throw new Error('restore ramdisk not found in this IPSW');
  log('Entries: ' + kName + ', ' + dName.split('/').pop() + ', ' + ramName);
  const kernel = await decryptImg3(await zip.read(kName), keys.kernel.iv, keys.kernel.key, 'kernelcache', log);
  if (!(kernel[0] === 0xCE && kernel[1] === 0xFA && kernel[2] === 0xED && kernel[3] === 0xFE)) throw new Error('kernelcache did not decrypt to a Mach-O - check its IV/key (and that this is the 3.2 / 7B367 IPSW)');
  const devicetree = await decryptImg3(await zip.read(dName), keys.dt.iv, keys.dt.key, 'DeviceTree', log);
  if (!(devicetree[0] === 0x0A || devicetree[0] < 0x40) || devicetree.length < 1000) throw new Error('DeviceTree did not decrypt correctly - check its IV/key');
  const ramdisk = await decryptImg3(await zip.read(ramName), keys.ram.iv, keys.ram.key, 'ramdisk', log);
  const ok = (ramdisk[0x400] === 0x48 && (ramdisk[0x401] === 0x2B || ramdisk[0x401] === 0x58));
  if (!ok) throw new Error('ramdisk did not decrypt to an HFS+ volume - check its IV/key (the User restore ramdisk ' + ramName + ')');
  log('Decrypted: kernel ' + kernel.length + ' B, device tree ' + devicetree.length + ' B, ramdisk ' + ramdisk.length + ' B (HFS+)');
  // boot logo (optional): iBoot normally draws this before the kernel starts
  let logo = null;
  const lName = names.find(n => /applelogo[^/]*\.img3$/i.test(n));
  if (lName && keys.logo && keys.logo.iv && keys.logo.key) {
    try {
      const raw = await decryptImg3(await zip.read(lName), keys.logo.iv, keys.logo.key, 'AppleLogo', log);
      logo = require('./logo.js').decodeIBootIm(raw);
      log('Apple logo: ' + logo.w + 'x' + logo.h + ' ' + logo.fmt);
    } catch (e) { log('Apple logo not decoded (' + e.message + ') - check the AppleLogo IV/key'); logo = null; }
  } else if (lName) log('Apple logo: no AppleLogo IV/key given, the screen stays black until the kernel draws');
  return { kernel, devicetree, ramdisk, logo, info: { product, version, build, ramName } };
}
// Pull IV/key pairs out of pasted text (e.g. the keys page). Looks for each label and takes the next 32-hex and 64-hex tokens.
function parseKeys(text, ramName) {
  const out = {}; const toks = text.split(/[^0-9A-Za-z.,_-]+/).filter(Boolean);
  const grab = (re) => {
    for (let i = 0; i < toks.length; i++) if (re.test(toks[i])) {
      let iv = null, key = null;
      for (let j = i + 1; j < Math.min(toks.length, i + 40); j++) { const t = toks[j]; if (/^[0-9a-fA-F]{32}$/.test(t) && !iv) iv = t; else if (/^[0-9a-fA-F]{64}$/.test(t) && !key) key = t; if (iv && key) return { iv, key }; if (j > i + 1 && /^(kernelcache|devicetree|ibss|ibec|iboot|llb|applelogo|restoreramdisk|updateramdisk)/i.test(t) && !(iv && key)) break; }
    }
    return null;
  };
  out.kernel = grab(/^kernelcache/i); out.dt = grab(/^devicetree/i); out.logo = grab(/^applelogo/i);
  out.ram = (ramName && grab(new RegExp('^' + ramName.replace(/\.dmg$/, '').replace(/[^0-9A-Za-z-]/g, ''), 'i'))) || grab(/^restoreramdisk$/i);
  return out;
}
module.exports = { loadFirmware, parseKeys, hex };
