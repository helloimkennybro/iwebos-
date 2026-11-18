'use strict';
// iWebOS boot loader: plays the role of SecureROM/LLB/iBoot. Loads the kernel Mach-O, patches the device tree, builds boot_args.
const { parseMacho, parseDT, writeDT, findNode, dtStr } = require('./macho.js');
const PHYS = 0x40000000, VIRT = 0xC0000000;
const enc = s => { const a = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
const u32s = (...v) => { const b = new Uint8Array(v.length * 4); const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, true)); return b; };

function loadKernel(ram, kbytes, mo) {
  let top = 0;
  for (const s of mo.segs) {
    if (!s.filesize) { top = Math.max(top, s.vmaddr + s.vmsize); continue; }
    ram.writeBytes(s.vmaddr - VIRT, kbytes.subarray(s.fileoff, s.fileoff + s.filesize));
    top = Math.max(top, s.vmaddr + s.vmsize);
  }
  return top - VIRT + PHYS; // first free physical address after the kernel
}
function prepareDT(dtBytes, o) {
  const root = parseDT(dtBytes);
  const setP = (n, k, v) => { n.props[k] = v; };
  const mem = findNode(root, 'memory'); setP(mem, 'reg', u32s(PHYS, o.memSize));
  const chosen = findNode(root, 'chosen');
  const mm = findNode(chosen, 'memory-map');
  // iBoot turns MemoryMapReserved-N slots into named (address,size) ranges
  const slots = Object.keys(mm.props).filter(k => /^MemoryMapReserved-/.test(k));
  const entries = o.memoryMap || [];
  const np = {};
  for (const k of Object.keys(mm.props)) if (!/^MemoryMapReserved-/.test(k)) np[k] = mm.props[k];
  entries.forEach(e => { np[e.name] = u32s(e.addr, e.size); });
  for (let i = entries.length; i < slots.length; i++) np[slots[i]] = u32s(0, 0);
  mm.props = np;
  setP(findNode(root, 'pram'), 'reg', u32s(0x4F000000, 0x100000));   // persistent RAM scratch (zero-filled)
  setP(findNode(root, 'vram'), 'reg', u32s(0x4E000000, 0x400000));   // framebuffer
  const cpus = findNode(root, 'cpus'); const cpu0 = findNode(cpus, 'cpu0');
  setP(cpu0, 'timebase-frequency', u32s(24000000)); setP(cpu0, 'clock-frequency', u32s(1000000000));
  setP(cpu0, 'bus-frequency', u32s(250000000)); setP(cpu0, 'peripheral-frequency', u32s(50000000));
  setP(cpu0, 'memory-frequency', u32s(400000000)); setP(cpu0, 'fixed-frequency', u32s(24000000));
  setP(root, 'clock-frequency', u32s(24000000));
  setP(chosen, 'chip-id', u32s(0x8930)); setP(chosen, 'board-id', u32s(2)); setP(chosen, 'debug-enabled', u32s(1));
  const fw = new Uint8Array(256); fw.set(enc('iBoot-817.28')); setP(chosen, 'firmware-version', fw);
  if (o.extra) o.extra(root, { findNode, setP, u32s, enc });
  return writeDT(root);
}
// Build physical memory image: kernel, device tree, boot args, optional ramdisk. Returns entry state.
function bootImage(ram, files, opts) {
  opts = opts || {};
  const memSize = opts.memSize || 0x0E000000;   // like iBoot: the top 32 MB (framebuffer at 0x4E000000, panic RAM) is not given to the kernel
  const mo = parseMacho(files.kernel);
  const kTop = loadKernel(ram, files.kernel, mo);
  const BA = (kTop + 0xFFFF) & ~0xFFFF;                 // boot args page
  const DT = BA + 0x1000;
  const memoryMap = [];
  // like iBoot: the ramdisk sits right after the device tree and below topOfKernelData, so the kernel never hands its pages out
  const rdAddr = (DT + 0x20000 + 0xFFFF) & ~0xFFFF;
  let rdEnd = rdAddr;
  if (files.ramdisk) { ram.writeBytes(rdAddr - PHYS, files.ramdisk); memoryMap.push({ name: 'RAMDisk', addr: rdAddr, size: files.ramdisk.length }); rdEnd = rdAddr + files.ramdisk.length; }
  memoryMap.push({ name: 'BootArgs', addr: BA, size: 0x1000 });
  memoryMap.push({ name: 'DeviceTree', addr: DT, size: 0x20000 });
  const dtb = prepareDT(files.devicetree, { memSize, memoryMap, extra: opts.dtExtra });
  ram.writeBytes(DT - PHYS, dtb);
  const topOfKernelData = (Math.max(DT + 0x20000, rdEnd) + 0x3FFF) & ~0x3FFF;
  const fbBase = opts.fbBase || 0x4E000000, W = 768, H = 1024;
  const ba = new Uint8Array(0x1000), dv = new DataView(ba.buffer);
  dv.setUint16(0, 2, true); dv.setUint16(2, 2, true);                   // Revision, Version
  dv.setUint32(4, VIRT, true); dv.setUint32(8, PHYS, true); dv.setUint32(12, memSize, true); dv.setUint32(16, topOfKernelData, true);
  dv.setUint32(0x14, fbBase, true); dv.setUint32(0x18, opts.graphical ? 1 : 0, true);   // v_display: 1 = graphics (keep iBoot's logo) dv.setUint32(0x1C, W * 4, true); dv.setUint32(0x20, W, true); dv.setUint32(0x24, H, true); dv.setUint32(0x28, 32, true);
  dv.setUint32(0x2C, 0, true); dv.setUint32(0x30, DT - PHYS + VIRT, true); dv.setUint32(0x34, dtb.length, true);
  const cmd = opts.cmdline || '-v rd=md0'; for (let i = 0; i < cmd.length; i++) ba[0x38 + i] = cmd.charCodeAt(i);
  dv.setUint32(0x138, 0, true); dv.setUint32(0x13C, memSize, true);
  ram.writeBytes(BA - PHYS, ba);
  const entryVirt = mo.thread.regs[15];
  return { entry: entryVirt - VIRT + PHYS, bootArgs: BA, dt: DT, dtLen: dtb.length, top: topOfKernelData, fb: { base: fbBase, w: W, h: H }, macho: mo, kTop };
}
module.exports = { bootImage, PHYS, VIRT };
