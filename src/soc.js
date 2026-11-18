'use strict';
// iWebOS SoC: S5L8930X (Apple A4) peripherals. Devices are added milestone by milestone; unknown registers are logged.
const IO = 0x80000000;
class LogDev { // placeholder for hardware not modelled yet: reads 0, remembers what the kernel pokes
  constructor(name, log) { this.name = name; this.log = log; this.seen = new Set(); this.regs = new Map(); this.cpu = null; }
  read(off, size) { const v = this.regs.has(off) ? this.regs.get(off) : 0; this.note('R', off, size, v); return v; }
  write(off, size, v) { this.regs.set(off, v); this.note('W', off, size, v); }
  note(rw, off, size, v) {
    const k = rw + off; this.hits = this.hits || new Map(); this.hits.set(k, (this.hits.get(k) || 0) + 1); if (this.seen.has(k)) return; this.seen.add(k);
    if (this.log) this.log('[' + this.name + '] ' + rw + (size * 8) + ' +0x' + off.toString(16) + (rw === 'W' ? ' = 0x' + (v >>> 0).toString(16) : ' -> 0x' + (v >>> 0).toString(16)) + (this.cpu ? '  pc=0x' + (this.cpu.R[15] >>> 0).toString(16) : ''));
  }
}

// ---- PL192-style vectored interrupt controller: 4 banks x 32 lines, bank stride 0x10000 ----
class VIC extends LogDev {
  constructor(name, log, cpu) {
    super(name, log); this.cpu = cpu;
    this.line = new Uint32Array(4); this.soft = new Uint32Array(4); this.enable = new Uint32Array(4); this.select = new Uint32Array(4);
    this.vecaddr = new Uint32Array(128); this.vecprio = new Uint32Array(128).fill(0xF); this.defaddr = new Uint32Array(4); this.prot = new Uint32Array(4);
    this.cur = 0;
  }
  setLine(n, level) { const b = n >>> 5, m = 1 << (n & 31); if (level) this.line[b] |= m; else this.line[b] &= ~m; this.update(); }
  update() {
    let irq = false, fiq = false;
    for (let b = 0; b < 4; b++) { const r = (this.line[b] | this.soft[b]) & this.enable[b]; if (r & ~this.select[b]) irq = true; if (r & this.select[b]) fiq = true; }
    this.cpu.irq = irq; this.cpu.fiq = fiq;
  }
  pendingVector(b) {
    const r = ((this.line[b] | this.soft[b]) & this.enable[b] & ~this.select[b]) >>> 0; if (!r) return this.defaddr[b];
    let best = -1, bp = 99;
    for (let i = 0; i < 32; i++) if (r & (1 << i)) { const p = this.vecprio[b * 32 + i]; if (p < bp) { bp = p; best = i; } }
    return this.vecaddr[b * 32 + best];
  }
  read(off, size) {
    const b = (off >>> 16) & 3, o = off & 0xFFFF, bi = b * 32;
    let v;
    switch (true) {
      case o === 0x000: v = (this.line[b] | this.soft[b]) & this.enable[b] & ~this.select[b]; break;
      case o === 0x004: v = (this.line[b] | this.soft[b]) & this.enable[b] & this.select[b]; break;
      case o === 0x008: v = this.line[b] | this.soft[b]; break;
      case o === 0x00C: v = this.select[b]; break;
      case o === 0x010: case o === 0x014: v = this.enable[b]; break;
      case o === 0x018: v = this.soft[b]; break;
      case o === 0x020: v = this.prot[b]; break;
      case o >= 0x100 && o < 0x180: v = this.vecaddr[bi + ((o - 0x100) >> 2)]; break;
      case o >= 0x200 && o < 0x280: v = this.vecprio[bi + ((o - 0x200) >> 2)]; break;
      case o === 0xF00: v = this.pendingVector(b); break;
      default: v = 0;
    }
    this.note('R', off, size, v >>> 0); return v >>> 0;
  }
  write(off, size, v) {
    const b = (off >>> 16) & 3, o = off & 0xFFFF, bi = b * 32; v >>>= 0;
    this.note('W', off, size, v);
    switch (true) {
      case o === 0x00C: this.select[b] = v; break;
      case o === 0x010: this.enable[b] |= v; break;
      case o === 0x014: this.enable[b] &= ~v; break;
      case o === 0x018: this.soft[b] |= v; break;
      case o === 0x01C: this.soft[b] &= ~v; break;
      case o === 0x020: this.prot[b] = v; break;
      case o >= 0x100 && o < 0x180: this.vecaddr[bi + ((o - 0x100) >> 2)] = v; break;
      case o >= 0x200 && o < 0x280: this.vecprio[bi + ((o - 0x200) >> 2)] = v; break;
      case o === 0xF00: break;                                             // end of interrupt
    }
    this.update();
  }
}

// ---- power manager: also hosts the 24 MHz timebase and decrementer ----
const TICK_DIV = 40;            // guest cycles per 24 MHz tick (guest "runs" at ~1 GHz)
const TIMER_IRQ = 6;
class PMGR extends LogDev {
  constructor(name, log, cpu, vic) { super(name, log); this.cpu = cpu; this.vic = vic; this.ctl = 0; this.armed = false; this.expire = 0; this.dec = 0; this.fired = false; this.lastRead = -1e9; this.streak = 0; this.warps = 0; }
  ticks() { return Math.floor(this.cpu.cycles / TICK_DIV); }
  read(off, size) {
    switch (off) {
      case 0x2000: { const v = this.ticks() % 4294967296; this.note('R', off, size, v); this.spin(); return v; }
      case 0x2004: { const v = Math.floor(this.ticks() / 4294967296); this.note('R', off, size, v); return v; }
      case 0x2008: { const v = this.armed && !this.fired ? Math.max(0, this.expire - this.ticks()) : 0; this.note('R', off, size, v); return v >>> 0; }
      case 0x2010: this.note('R', off, size, this.ctl); return this.ctl;
    }
    return super.read(off, size);
  }
  write(off, size, v) {
    v >>>= 0;
    if (off === 0x2008) { this.note('W', off, size, v); this.dec = v; this.expire = this.ticks() + v; this.armed = true; this.fired = false; this.vic.setLine(TIMER_IRQ, false); return; }
    if (off === 0x2010) { this.ctl = v & 1; this.note('W', off, size, v); if (v & 2) { this.vic.setLine(TIMER_IRQ, false); } return; } // bit0 enable, bit1 acknowledge
    // clock/power-gate state registers: hardware status (bits 7:4) follows the requested state (bits 3:0) immediately
    if (off < 0x200 || (off >= 0x1000 && off < 0x1200)) v = ((v & ~0xF0) | ((v & 0xF) << 4)) >>> 0;
    super.write(off, size, v);
  }
  // Busy-wait detector: software that reads the timebase over and over with only a few instructions in between is waiting for
  // time to pass. After 64 such reads in a row the guest clock jumps ahead (never past the next timer interrupt).
  spin() {
    const c = this.cpu.cycles;
    if (c - this.lastRead < 400) { if (++this.streak >= 64) {
      this.streak = 0; let warp = 200 * 24 * TICK_DIV;                  // 200 us
      const ne = this.nextEventCycle(); if (ne >= 0) warp = Math.min(warp, ne - c - 1);
      if (warp > 0) { this.cpu.cycles = c + warp; this.warps++; }
    } } else this.streak = 0;
    this.lastRead = this.cpu.cycles;
  }
  nextEventCycle() { return this.armed && !this.fired && (this.ctl & 1) ? this.expire * TICK_DIV : -1; }
  update() {
    if (this.armed && !this.fired && (this.ctl & 1) && this.ticks() >= this.expire) { this.fired = true; this.vic.setLine(TIMER_IRQ, true); }
  }
}

// ---- S5L-style UART: TX goes to the host, status registers always say "ready" ----
class UART extends LogDev {
  constructor(name, log, cpu, sink) { super(name, log); this.cpu = cpu; this.sink = sink; this.rx = []; }
  read(off, size) {
    let v;
    switch (off) {
      case 0x10: v = 0x6 | (this.rx.length ? 1 : 0); break;                 // UTRSTAT: tx empty + tx buffer empty (+ rx ready)
      case 0x14: v = 0; break;                                             // UERSTAT
      case 0x18: v = this.rx.length & 0xF; break;                          // UFSTAT: rx count, tx fifo empty
      case 0x24: v = this.rx.length ? this.rx.shift() : 0; break;          // URXH
      default: return super.read(off, size);
    }
    return v;
  }
  write(off, size, v) {
    if (off === 0x20) { if (this.sink) this.sink(v & 0xFF, this.name); return; }  // UTXH
    super.write(off, size, v);
  }
}

// ---- S5L8930X I2C controller (layout recovered from the kernel's driver) ----
// +0x00 slave address (8-bit form)   +0x08 interrupt mask   +0x0C status, write 1 to clear (bit4 done, bit5 no ack)
// +0x10 first byte (register index)  +0x18 data byte count  +0x20 data FIFO  +0x24 control (bit2 start, bit0 write)
class I2C extends LogDev {
  constructor(name, log, vic, irq) { super(name, log); this.vic = vic; this.irq = irq; this.slaves = new Map(); this.r = new Uint32Array(16); this.tx = []; this.rx = []; this.xfers = 0; }
  attach(addr, dev) { this.slaves.set(addr & 0xFE, dev); }
  line() { if (this.irq >= 0) this.vic.setLine(this.irq, (this.r[3] & this.r[2] & 0xF0) !== 0); }
  read(off, size) {
    let v;
    if (off === 0x20) v = this.rx.length ? this.rx.shift() : 0;
    else v = off < 0x40 ? this.r[off >> 2] : 0;
    this.note('R', off, size, v); return v >>> 0;
  }
  write(off, size, v) {
    v >>>= 0; this.note('W', off, size, v);
    if (off === 0x20) { this.tx.push(v & 0xFF); return; }
    if (off === 0x0C) { this.r[3] &= ~v; this.line(); return; }
    if (off < 0x40) this.r[off >> 2] = v;
    if (off === 0x08) this.line();
    if (off === 0x24 && (v & 4)) this.start(v & 1);
  }
  start(isWrite) {
    const addr = this.r[0] & 0xFE, reg = this.r[4] & 0xFF, n = this.r[6] & 0xFF, dev = this.slaves.get(addr);
    this.xfers++;
    let st = 0x10;
    if (!dev) { st |= 0x20; if (this.log) this.log('[' + this.name + '] no device at 0x' + addr.toString(16) + ' (NAK)'); }
    else if (isWrite) { for (let i = 0; i < this.tx.length; i++) dev.wr((reg + i) & 0xFF, this.tx[i]); if (dev.trace) dev.trace('W', reg, this.tx.slice()); }
    else { this.rx = []; for (let i = 0; i < n; i++) this.rx.push(dev.rd((reg + i) & 0xFF) & 0xFF); if (dev.trace) dev.trace('R', reg, this.rx.slice()); }
    this.tx = [];
    this.r[9] = 0; this.r[3] |= st; this.line();
  }
}

// ---- PKE (public-key engine): the driver starts an operation via +0x08 bit0 and polls for it to clear.
// The arithmetic itself is not modelled yet: operations complete immediately.
class PKE extends LogDev {
  write(off, size, v) { if (off === 0x8) v &= ~1; super.write(off, size, v); this.ops = (this.ops || 0) + (off === 0x8 ? 1 : 0); }
}

// ---- IOP (ARM7M coprocessor): +0x100 control. Writing bit4 (stop) must report bit1 (stopped). The core itself is not run.
class IOP extends LogDev {
  write(off, size, v) { if (off === 0x100) { v >>>= 0; if (v & 0x10) v |= 2; else v &= ~2; } super.write(off, size, v); }
}

// ---- Dialog D1815 power-management unit (iPad): 256 byte registers behind I2C address 0x74 ----
class PMU {
  constructor(log) { this.log = log; this.regs = new Uint8Array(256); this.hist = new Map(); }
  rd(r) { this.hist.set('R' + r, (this.hist.get('R' + r) || 0) + 1); return this.regs[r]; }
  wr(r, v) { this.hist.set('W' + r, (this.hist.get('W' + r) || 0) + 1); this.regs[r] = v; }
}

// Instantiate SoC devices from the device tree's arm-io children.
function attachDevices(bus, cpu, root, log, util, serialSink) {
  const { findNode, dtStr } = util; const aio = findNode(root, 'arm-io'); const devs = {};
  const vic = new VIC('vic', log, cpu); devs.vic = vic;
  for (const c of aio.kids) {
    const nm = dtStr(c.props.name), r = c.props.reg; if (!r) continue;
    const u = new Uint32Array(r.buffer.slice(r.byteOffset, r.byteOffset + (r.length & ~3)));
    for (let i = 0; i + 1 < u.length; i += 2) {
      if (u[i + 1] === 0 || u[i] >= 0x40000000) continue;
      let d;
      if (nm === 'vic' && i === 0) d = vic;
      else if (nm === 'pmgr' && i === 0) { d = new PMGR('pmgr', log, cpu, vic); devs.pmgr = d; }
      else if (/^uart\d/.test(nm) && i === 0) d = new UART(nm, log, cpu, serialSink);
      else if (nm === 'pke' && i === 0) { d = new PKE(nm, log); devs.pke = d; }
      else if (nm === 'iop' && i === 0) { d = new IOP(nm, log); devs.iop = d; }
      else if (/^i2c\d/.test(nm) && i === 0) {
        const irq = c.props.interrupts ? new DataView(c.props.interrupts.buffer, c.props.interrupts.byteOffset).getUint32(0, true) : -1;
        d = new I2C(nm, log, vic, irq); devs[nm] = d;
        if (nm === 'i2c0') { devs.pmu = new PMU(log); d.attach(0x74, devs.pmu); }
      }
      else d = new LogDev(nm + (i ? '#' + (i / 2) : ''), log);
      d.cpu = cpu; bus.map(IO + u[i], u[i + 1], d, nm);
    }
  }
  return devs;
}

// Runs the CPU and the devices that depend on time.
class Machine {
  constructor(cpu, devs) { this.cpu = cpu; this.devs = devs; }
  run(budget) {
    const cpu = this.cpu, tm = this.devs.pmgr; let done = 0;
    while (done < budget) {
      tm.update();
      let chunk = Math.min(budget - done, 20000);
      const ne = tm.nextEventCycle();
      if (ne >= 0) { if (ne > cpu.cycles) chunk = Math.min(chunk, ne - cpu.cycles); else chunk = 1; }
      if (cpu.wfi && !cpu.irq && !cpu.fiq) {                               // idle: jump to the next timer event
        if (ne < 0) return done;
        if (ne > cpu.cycles) cpu.cycles = ne; tm.update(); if (!cpu.irq && !cpu.fiq) { cpu.cycles++; tm.update(); }
        if (!(cpu.irq || cpu.fiq)) return done;
        cpu.wfi = false; continue;
      }
      const n = cpu.run(chunk); done += n;
      if (cpu.idleHit) {                                                   // paravirtual idle: skip virtual time to the next event
        cpu.idleHit = false; const e = tm.nextEventCycle();
        cpu.cycles = e > cpu.cycles ? e : cpu.cycles + 24000 * TICK_DIV; this.idleSkips = (this.idleSkips || 0) + 1;
        tm.update(); cpu.idleResume = true; continue;
      }
      if (cpu.hitBreak) break;
      if (n === 0 && !cpu.wfi) break;
    }
    tm.update(); return done;
  }
}
module.exports = { LogDev, VIC, PMGR, I2C, PMU, Machine, attachDevices, IO, TICK_DIV };
