'use strict';
// iWebOS instruction decoder: ARM (A32) and Thumb/Thumb-2 (T32) -> one Inst record.
// The same record drives the executor (cpu.js) and the disassembler (disasm.js).

const NAMES = ['DP','?1','?2','?3','?4','?5','?6','?7','?8','?9','?10','?11','?12','?13','?14','?15',
 'MUL','MLA','MLS','UMULL','UMLAL','SMULL','SMLAL','UMAAL','HMUL','CLZ','RBIT','REV','REV16','REVSH',
 'EXT','SAT','SAT16','BFI','BFC','SBFX','UBFX','PKH','SEL','USAD8','PAR','QADD','QSUB','QDADD','QDSUB',
 'LDR','STR','LDM','STM','B','BL','BLX_I','BX','BLX_R','CBZ','TB','IT','MRS','MSR','CPS','SRS','RFE',
 'SVC','BKPT','MCR','MRC','MCRR','MRRC','CDP','LDC','STC','NOP','WFI','WFE','SEV','YIELD','DMB','DSB',
 'ISB','CLREX','PLD','PLI','SETEND','MOVW','MOVT','UDF','SWP','LDREX','STREX','VFP','DSPMUL','DIV'];
const O = {}; NAMES.forEach((n, i) => { O[n] = i; });
// data-processing sub-opcodes (dp field): 0..15 as ARM, 16 = ORN (Thumb-2)
const DPN = ['and','eor','sub','rsb','add','adc','sbc','rsc','tst','teq','cmp','cmn','orr','mov','bic','mvn','orn'];

class Inst {
  constructor() {
    this.op = 0; this.dp = 0; this.cond = 14; this.S = 0; this.rd = 0; this.rn = 0; this.rm = 0; this.rs = 0;
    this.ra = 0; this.rdhi = 0; this.imm = 0; this.immC = -1; this.isImm = 0; this.sh = 0; this.shImm = 0;
    this.shReg = 0; this.P = 0; this.U = 0; this.W = 0; this.size = 4; this.sgn = 0; this.usr = 0;
    this.list = 0; this.cp = 0; this.crn = 0; this.crm = 0; this.o1 = 0; this.o2 = 0; this.len = 4;
    this.thumb = 0; this.x = 0; this.y = 0; this.rot = 0; this.kind = 0; this.lit = 0; this.w = 0; this.w2 = 0;
    this.L = 0;
  }
}
function clear(I) {
  I.dp = 0; I.S = 0; I.rd = 0; I.rn = 0; I.rm = 0; I.rs = 0; I.ra = 0; I.rdhi = 0; I.imm = 0; I.immC = -1;
  I.isImm = 0; I.sh = 0; I.shImm = 0; I.shReg = 0; I.P = 0; I.U = 0; I.W = 0; I.size = 4; I.sgn = 0; I.usr = 0;
  I.list = 0; I.cp = 0; I.crn = 0; I.crm = 0; I.o1 = 0; I.o2 = 0; I.x = 0; I.y = 0; I.rot = 0; I.kind = 0;
  I.lit = 0; I.L = 0;
}
const ror = (x, n) => n ? ((x >>> n) | (x << (32 - n))) >>> 0 : x >>> 0;
const sx = (v, bits) => (v << (32 - bits)) >> (32 - bits);

function shiftFields(I, type, imm5) {
  // immediate shift decoding: LSR/ASR #0 means 32, ROR #0 means RRX
  I.sh = type;
  if (type === 1 || type === 2) I.shImm = imm5 === 0 ? 32 : imm5;
  else if (type === 3 && imm5 === 0) { I.sh = 4; I.shImm = 1; }
  else I.shImm = imm5;
}
function udf(I) { I.op = O.UDF; return I; }

// ---------------------------------------------------------------- ARM
function decodeARM(w, I) {
  w >>>= 0; clear(I); I.w = w; I.len = 4; I.thumb = 0; I.cond = w >>> 28;
  if (I.cond === 15) return decodeUncond(w, I);
  const top = (w >>> 25) & 7;
  switch (top) {
    case 0: case 1: return decodeDP(w, I, top);
    case 2: case 3: return decodeLS(w, I, top);
    case 4: // LDM/STM
      I.op = (w & 0x100000) ? O.LDM : O.STM; I.P = (w >>> 24) & 1; I.U = (w >>> 23) & 1; I.S = (w >>> 22) & 1;
      I.W = (w >>> 21) & 1; I.rn = (w >>> 16) & 15; I.list = w & 0xFFFF; return I;
    case 5:
      I.op = (w & 0x1000000) ? O.BL : O.B; I.imm = (sx(w & 0xFFFFFF, 24) << 2) | 0; return I;
    case 6: return decodeCoprocMem(w, I);
    default:
      if (w & 0x1000000) { I.op = O.SVC; I.imm = w & 0xFFFFFF; return I; }
      return decodeCoprocReg(w, I);
  }
}
function decodeDP(w, I, top) {
  const opc = (w >>> 21) & 15, S = (w >>> 20) & 1;
  I.rn = (w >>> 16) & 15; I.rd = (w >>> 12) & 15;
  if (top === 1) { // immediate forms
    if (opc >= 8 && opc <= 11 && !S) {
      const hi = w & 0x0FF00000;
      if (hi === 0x03000000) { I.op = O.MOVW; I.imm = ((w >>> 4) & 0xF000) | (w & 0xFFF); return I; }
      if (hi === 0x03400000) { I.op = O.MOVT; I.imm = ((w >>> 4) & 0xF000) | (w & 0xFFF); return I; }
      if ((w & 0x0FB0F000) === 0x0320F000) { // MSR immediate
        I.op = O.MSR; I.isImm = 1; I.kind = (w >>> 22) & 1; I.o1 = (w >>> 16) & 15;
        I.imm = ror(w & 0xFF, 2 * ((w >>> 8) & 15)); return I;
      }
      if ((w & 0x0FFFFF00) === 0x0320F000) { // hints
        const h = w & 0xFF; I.op = h === 0 ? O.NOP : h === 1 ? O.YIELD : h === 2 ? O.WFE : h === 3 ? O.WFI : h === 4 ? O.SEV : O.NOP;
        I.imm = h; return I;
      }
      return udf(I);
    }
    I.op = O.DP; I.dp = opc; I.S = S; I.isImm = 1;
    const rot = (w >>> 8) & 15; I.imm = ror(w & 0xFF, 2 * rot); I.immC = rot ? (I.imm >>> 31) : -1; return I;
  }
  // register forms
  const b7 = (w >>> 7) & 1, b4 = (w >>> 4) & 1;
  if (b4 && b7) { // multiplies, sync, extra load/store
    const sh = (w >>> 5) & 3;
    if (sh === 0) {
      if ((w & 0x0F000000) === 0) return decodeMul(w, I);
      return decodeSync(w, I);
    }
    return decodeExtraLS(w, I);
  }
  if (opc >= 8 && opc <= 11 && !S) return decodeMisc(w, I);
  I.op = O.DP; I.dp = opc; I.S = S; I.rm = w & 15;
  if (b4) { I.shReg = 1; I.rs = (w >>> 8) & 15; I.sh = (w >>> 5) & 3; }
  else shiftFields(I, (w >>> 5) & 3, (w >>> 7) & 31);
  return I;
}
function decodeMul(w, I) {
  const o = (w >>> 21) & 7; I.S = (w >>> 20) & 1;
  I.rd = (w >>> 16) & 15; I.ra = (w >>> 12) & 15; I.rs = (w >>> 8) & 15; I.rm = w & 15; I.rdhi = I.rd;
  switch (o) {
    case 0: I.op = O.MUL; break; case 1: I.op = O.MLA; break; case 2: I.op = O.UMAAL; break; case 3: I.op = O.MLS; break;
    case 4: I.op = O.UMULL; break; case 5: I.op = O.UMLAL; break; case 6: I.op = O.SMULL; break; default: I.op = O.SMLAL;
  }
  if (o === 4 || o === 5 || o === 6 || o === 7 || o === 2) { I.rdhi = (w >>> 16) & 15; I.rd = (w >>> 12) & 15; } // rd = RdLo
  return I;
}
function decodeSync(w, I) {
  if ((w & 0x0FB00FF0) === 0x01000090) { // SWP/SWPB
    I.op = O.SWP; I.size = (w & 0x400000) ? 1 : 4; I.rn = (w >>> 16) & 15; I.rd = (w >>> 12) & 15; I.rm = w & 15; return I;
  }
  if ((w & 0x0F800000) === 0x01800000) {
    const sz = [4, 8, 1, 2][(w >>> 21) & 3];
    I.size = sz; I.rn = (w >>> 16) & 15;
    if (w & 0x100000) { if ((w & 0xF0F) !== 0xF0F) return udf(I); I.op = O.LDREX; I.rd = (w >>> 12) & 15; return I; }
    I.op = O.STREX; I.rd = (w >>> 12) & 15; I.rm = w & 15; return I;
  }
  return udf(I);
}
function decodeExtraLS(w, I) {
  const L = (w >>> 20) & 1, sh = (w >>> 5) & 3;
  I.P = (w >>> 24) & 1; I.U = (w >>> 23) & 1; I.W = (w >>> 21) & 1;
  I.rn = (w >>> 16) & 15; I.rd = (w >>> 12) & 15; I.size = 2; I.sgn = 0; I.op = O.LDR;
  if (L) { if (sh === 1) { } else if (sh === 2) { I.size = 1; I.sgn = 1; } else { I.size = 2; I.sgn = 1; } }
  else { if (sh === 1) I.op = O.STR; else if (sh === 2) { I.size = 8; I.op = O.LDR; } else { I.size = 8; I.op = O.STR; } }
  if (w & 0x400000) { I.isImm = 1; I.imm = ((w >>> 4) & 0xF0) | (w & 15); } else { I.rm = w & 15; }
  if (!I.P && I.W) { I.usr = 1; I.W = 0; } // LDRHT etc: post-indexed, unprivileged
  return I;
}
function decodeMisc(w, I) {
  I.rm = w & 15;
  if ((w & 0x0FBF0FFF) === 0x010F0000) { I.op = O.MRS; I.rd = (w >>> 12) & 15; I.kind = (w >>> 22) & 1; return I; }
  if ((w & 0x0FB0FFF0) === 0x0120F000) { I.op = O.MSR; I.isImm = 0; I.kind = (w >>> 22) & 1; I.o1 = (w >>> 16) & 15; return I; }
  if ((w & 0x0FFFFFD0) === 0x012FFF10) { I.op = (w & 0x20) ? O.BLX_R : O.BX; return I; }
  if ((w & 0x0FFFFFF0) === 0x012FFF20) { I.op = O.BX; return I; } // BXJ ~ BX
  if ((w & 0x0FFF0FF0) === 0x016F0F10) { I.op = O.CLZ; I.rd = (w >>> 12) & 15; return I; }
  if ((w & 0x0FF000F0) === 0x01200070) { I.op = O.BKPT; I.imm = ((w >>> 4) & 0xFFF0) | (w & 15); return I; }
  if ((w & 0x0F900FF0) === 0x01000050) {
    I.op = [O.QADD, O.QSUB, O.QDADD, O.QDSUB][(w >>> 21) & 3]; I.rd = (w >>> 12) & 15; I.rn = (w >>> 16) & 15; return I;
  }
  if ((w & 0x0F900090) === 0x01000080) { // halfword multiplies
    I.op = O.HMUL; I.kind = (w >>> 21) & 3; I.x = (w >>> 5) & 1; I.y = (w >>> 6) & 1;
    I.rd = (w >>> 16) & 15; I.ra = (w >>> 12) & 15; I.rs = (w >>> 8) & 15; I.rm = w & 15; I.rdhi = I.rd;
    if (I.kind === 2) { I.rdhi = (w >>> 16) & 15; I.rd = (w >>> 12) & 15; }
    return I;
  }
  return udf(I);
}
function decodeLS(w, I, top) {
  if (top === 3 && (w & 0x10)) return decodeMedia(w, I);
  I.P = (w >>> 24) & 1; I.U = (w >>> 23) & 1; I.W = (w >>> 21) & 1;
  I.size = (w & 0x400000) ? 1 : 4; I.op = (w & 0x100000) ? O.LDR : O.STR;
  I.rn = (w >>> 16) & 15; I.rd = (w >>> 12) & 15;
  if (!I.P && I.W) { I.usr = 1; I.W = 0; }
  if (top === 2) { I.isImm = 1; I.imm = w & 0xFFF; }
  else { I.rm = w & 15; shiftFields(I, (w >>> 5) & 3, (w >>> 7) & 31); }
  return I;
}
function decodeMedia(w, I) {
  const g = (w >>> 23) & 3;
  I.rn = (w >>> 16) & 15; I.rd = (w >>> 12) & 15; I.rm = w & 15;
  if (g === 0) { // parallel add/sub
    const pf = (w >>> 20) & 7; if (pf === 0 || pf === 4) return udf(I);
    const po = (w >>> 5) & 7; if (po === 5 || po === 6) return udf(I);
    I.op = O.PAR; I.kind = pf; I.o1 = po; return I;
  }
  if (g === 1) {
    if ((w & 0x0FF00030) === 0x06800010) { I.op = O.PKH; I.kind = (w >>> 6) & 1; I.shImm = (w >>> 7) & 31; if (I.kind && !I.shImm) I.shImm = 32; return I; }
    if ((w & 0x0FA00030) === 0x06A00010) { // SSAT/USAT
      I.op = O.SAT; I.kind = (w >>> 22) & 1; I.o1 = ((w >>> 16) & 31) + (I.kind ? 0 : 1);
      I.sh = (w >>> 6) & 1 ? 2 : 0; I.shImm = (w >>> 7) & 31; if (I.sh === 2 && !I.shImm) I.shImm = 32; I.rn = w & 15; I.rm = w & 15; return I;
    }
    if ((w & 0x0FB00FF0) === 0x06A00F30) { I.op = O.SAT16; I.kind = (w >>> 22) & 1; I.o1 = ((w >>> 16) & 15) + (I.kind ? 0 : 1); return I; }
    if ((w & 0x0FF00FF0) === 0x06800FB0) { I.op = O.SEL; return I; }
    if ((w & 0x0F8003F0) === 0x06800070) { // extend
      const o = (w >>> 20) & 7; const k = [0, -1, 1, 3, 5, -1, 2, 4];
      // 000 SXTB16, 010 SXTB, 011 SXTH, 100 UXTB16, 110 UXTB, 111 UXTH
      const map = { 0: 4, 2: 0, 3: 1, 4: 5, 6: 2, 7: 3 };
      if (!(o in map)) return udf(I);
      I.op = O.EXT; I.kind = map[o]; I.rot = ((w >>> 10) & 3) * 8; return I;
    }
    if ((w & 0x0FFF0FF0) === 0x06BF0F30) { I.op = O.REV; return I; }
    if ((w & 0x0FFF0FF0) === 0x06BF0FB0) { I.op = O.REV16; return I; }
    if ((w & 0x0FFF0FF0) === 0x06FF0F30) { I.op = O.RBIT; return I; }
    if ((w & 0x0FFF0FF0) === 0x06FF0FB0) { I.op = O.REVSH; return I; }
    return udf(I);
  }
  if (g === 2) {
    if ((w & 0x0FF0F0F0) === 0x0780F010) { I.op = O.USAD8; I.rd = (w >>> 16) & 15; I.rn = w & 15; I.rm = (w >>> 8) & 15; I.ra = 15; return I; }
    if ((w & 0x0FF000F0) === 0x07800010) { I.op = O.USAD8; I.rd = (w >>> 16) & 15; I.ra = (w >>> 12) & 15; I.rn = w & 15; I.rm = (w >>> 8) & 15; return I; }
    I.op = O.DSPMUL; I.w = w; return I; // SMUAD/SMMUL/... family, decoded lazily by the executor
  }
  // g === 3 : bitfield
  if ((w & 0x0FE00070) === 0x07A00050 || (w & 0x0FE00070) === 0x07E00050) {
    I.op = (w & 0x400000) ? O.UBFX : O.SBFX; I.rd = (w >>> 12) & 15; I.rn = w & 15; I.o1 = (w >>> 7) & 31; I.o2 = ((w >>> 16) & 31) + 1; return I;
  }
  if ((w & 0x0FE00070) === 0x07C00010) {
    const lsb = (w >>> 7) & 31, msb = (w >>> 16) & 31; if (msb < lsb) return udf(I);
    I.rd = (w >>> 12) & 15; I.rn = w & 15; I.o1 = lsb; I.o2 = msb - lsb + 1; I.op = I.rn === 15 ? O.BFC : O.BFI; return I;
  }
  return udf(I);
}
function decodeCoprocMem(w, I) {
  const cp = (w >>> 8) & 15;
  if (cp === 10 || cp === 11) { I.op = O.VFP; return I; }
  if ((w & 0x0FE00000) === 0x0C400000) { // MCRR/MRRC
    I.op = (w & 0x100000) ? O.MRRC : O.MCRR; I.cp = cp; I.o1 = (w >>> 4) & 15; I.rd = (w >>> 12) & 15; I.rn = (w >>> 16) & 15; I.crm = w & 15; return I;
  }
  I.op = (w & 0x100000) ? O.LDC : O.STC; I.cp = cp; I.P = (w >>> 24) & 1; I.U = (w >>> 23) & 1; I.W = (w >>> 21) & 1;
  I.x = (w >>> 22) & 1; I.rn = (w >>> 16) & 15; I.crn = (w >>> 12) & 15; I.imm = (w & 0xFF) << 2; return I;
}
function decodeCoprocReg(w, I) {
  const cp = (w >>> 8) & 15;
  if (cp === 10 || cp === 11) { I.op = O.VFP; return I; }
  I.cp = cp; I.o1 = (w >>> 21) & 7; I.crn = (w >>> 16) & 15; I.rd = (w >>> 12) & 15; I.o2 = (w >>> 5) & 7; I.crm = w & 15;
  if (w & 0x10) I.op = (w & 0x100000) ? O.MRC : O.MCR; else I.op = O.CDP;
  return I;
}
function decodeUncond(w, I) {
  I.cond = 14; // unconditional instructions execute always
  if (((w & 0xFE000000) >>> 0) === 0xFA000000) { I.op = O.BLX_I; I.imm = (sx(w & 0xFFFFFF, 24) << 2) | (((w >>> 24) & 1) << 1); return I; }
  if (((w & 0xFFF10020) >>> 0) === 0xF1000000) {
    I.op = O.CPS; I.kind = (w >>> 18) & 3; I.x = (w >>> 17) & 1; I.o1 = w & 31; I.o2 = (w >>> 6) & 7; I.W = (w >>> 6) & 7 /*aif*/; return I;
  }
  if (((w & 0xFFFFFE00) >>> 0) === 0xF1010000) { I.op = O.SETEND; I.imm = (w >>> 9) & 1; return I; }
  if (((w & 0xFFFFFFF0) >>> 0) === 0xF57FF010) { I.op = O.CLREX; return I; }
  if (((w & 0xFFFFFFF0) >>> 0) === 0xF57FF040) { I.op = O.DSB; return I; }
  if (((w & 0xFFFFFFF0) >>> 0) === 0xF57FF050) { I.op = O.DMB; return I; }
  if (((w & 0xFFFFFFF0) >>> 0) === 0xF57FF060) { I.op = O.ISB; return I; }
  if (((w & 0xFD70F000) >>> 0) === 0xF550F000 || ((w & 0xFD70F000) >>> 0) === 0xF510F000) { I.op = O.PLD; return I; }
  if (((w & 0xFD70F000) >>> 0) === 0xF450F000) { I.op = O.PLI; return I; }
  if (((w & 0xFE5FFFE0) >>> 0) === 0xF84D0500) { I.op = O.SRS; I.P = (w >>> 24) & 1; I.U = (w >>> 23) & 1; I.W = (w >>> 21) & 1; I.o1 = w & 31; return I; }
  if (((w & 0xFE50FFFF) >>> 0) === 0xF8100A00) { I.op = O.RFE; I.P = (w >>> 24) & 1; I.U = (w >>> 23) & 1; I.W = (w >>> 21) & 1; I.rn = (w >>> 16) & 15; return I; }
  if (((w & 0xFE000000) >>> 0) === 0xF2000000 || ((w & 0xFF100000) >>> 0) === 0xF4000000) { I.op = O.VFP; return I; } // NEON
  if (((w & 0xFF000000) >>> 0) === 0xFE000000 || ((w & 0xFE000000) >>> 0) === 0xFC000000) { I.op = O.VFP; return I; }
  return udf(I);
}

// ---------------------------------------------------------------- Thumb
function thumbExpand(i, imm3, imm8, I) {
  const v = (i << 11) | (imm3 << 8) | imm8;
  if ((v >>> 10) === 0) {
    const b = v & 0xFF;
    switch ((v >>> 8) & 3) {
      case 0: I.imm = b; break; case 1: I.imm = (b << 16) | b; break;
      case 2: I.imm = ((b << 24) | (b << 8)) >>> 0; break; default: I.imm = ((b << 24) | (b << 16) | (b << 8) | b) >>> 0;
    }
    I.immC = -1;
  } else { I.imm = ror(0x80 | (v & 0x7F), v >>> 7); I.immC = I.imm >>> 31; }
}
function decodeThumb(h1, h2, I) {
  clear(I); I.thumb = 1; I.cond = 14; I.w = h1; I.w2 = 0;
  const top5 = h1 >>> 11;
  if (top5 < 29) { I.len = 2; return decodeT16(h1, I); }
  I.len = 4; I.w2 = h2; return decodeT32(h1, h2, I);
}
function decodeT16(h, I) {
  const t = h >>> 12;
  switch (t) {
    case 0: case 1:
      if (((h >>> 11) & 3) === 3) { // add/sub
        I.op = O.DP; I.S = 2; I.dp = (h & 0x200) ? 2 : 4; I.rn = (h >>> 3) & 7; I.rd = h & 7;
        if (h & 0x400) { I.isImm = 1; I.imm = (h >>> 6) & 7; } else I.rm = (h >>> 6) & 7; return I;
      }
      I.op = O.DP; I.S = 2; I.dp = 13; I.rd = h & 7; I.rm = (h >>> 3) & 7; shiftFields(I, (h >>> 11) & 3, (h >>> 6) & 31);
      return I;
    case 2: case 3: {
      const o = (h >>> 11) & 3, r = (h >>> 8) & 7, imm = h & 0xFF;
      I.op = O.DP; I.isImm = 1; I.imm = imm; I.S = 2; I.rd = r; I.rn = r;
      I.dp = [13, 10, 4, 2][o]; if (o === 1) I.S = 1; return I;
    }
    case 4:
      if (h & 0x800) { // t=4 and bit11: LDR literal
        if (((h >>> 11) & 31) === 9) { I.op = O.LDR; I.rd = (h >>> 8) & 7; I.rn = 15; I.lit = 1; I.isImm = 1; I.imm = (h & 0xFF) << 2; I.P = 1; I.U = 1; I.size = 4; return I; }
      }
      if ((h & 0xFC00) === 0x4000) { // DP register
        const o = (h >>> 6) & 15, rm = (h >>> 3) & 7, rd = h & 7;
        I.S = 2; I.rd = rd; I.rn = rd; I.rm = rm; I.op = O.DP;
        switch (o) {
          case 0: I.dp = 0; break; case 1: I.dp = 1; break;
          case 2: I.dp = 13; I.sh = 0; I.shReg = 1; I.rs = rm; I.rm = rd; break;
          case 3: I.dp = 13; I.sh = 1; I.shReg = 1; I.rs = rm; I.rm = rd; break;
          case 4: I.dp = 13; I.sh = 2; I.shReg = 1; I.rs = rm; I.rm = rd; break;
          case 5: I.dp = 5; break; case 6: I.dp = 6; break;
          case 7: I.dp = 13; I.sh = 3; I.shReg = 1; I.rs = rm; I.rm = rd; break;
          case 8: I.dp = 8; I.S = 1; break;
          case 9: I.dp = 3; I.isImm = 1; I.imm = 0; I.rn = rm; I.rm = 0; break; // NEG: rsb rd, rm, #0
          case 10: I.dp = 10; I.S = 1; break; case 11: I.dp = 11; I.S = 1; break;
          case 12: I.dp = 12; break;
          case 13: I.op = O.MUL; I.S = 2; I.rs = rd; I.rm = rm; I.rd = rd; break; // MUL rd, rm, rd
          case 14: I.dp = 14; break; default: I.dp = 15; break;
        }
        return I;
      }
      if ((h & 0xFC00) === 0x4400) { // special data / BX
        const o = (h >>> 8) & 3, rm = (h >>> 3) & 15, rd = ((h >>> 4) & 8) | (h & 7);
        if (o === 3) { I.op = (h & 0x80) ? O.BLX_R : O.BX; I.rm = rm; return I; }
        I.op = O.DP; I.rd = rd; I.rn = rd; I.rm = rm;
        if (o === 0) { I.dp = 4; } else if (o === 1) { I.dp = 10; I.S = 1; } else { I.dp = 13; }
        return I;
      }
      // fallthrough to load/store register (0101xx) handled below
      return decodeT16LSreg(h, I);
    case 5: return decodeT16LSreg(h, I);
    case 6: case 7: {
      const B = (h >>> 12) & 1, L = (h >>> 11) & 1;
      I.op = L ? O.LDR : O.STR; I.rd = h & 7; I.rn = (h >>> 3) & 7; I.isImm = 1; I.P = 1; I.U = 1; I.size = B ? 1 : 4;
      I.imm = ((h >>> 6) & 31) << (B ? 0 : 2); return I;
    }
    case 8:
      I.op = (h & 0x800) ? O.LDR : O.STR; I.size = 2; I.rd = h & 7; I.rn = (h >>> 3) & 7; I.isImm = 1; I.P = 1; I.U = 1; I.imm = ((h >>> 6) & 31) << 1; return I;
    case 9:
      I.op = (h & 0x800) ? O.LDR : O.STR; I.rd = (h >>> 8) & 7; I.rn = 13; I.isImm = 1; I.P = 1; I.U = 1; I.imm = (h & 0xFF) << 2; return I;
    case 10:
      I.op = O.DP; I.dp = 4; I.rd = (h >>> 8) & 7; I.isImm = 1; I.imm = (h & 0xFF) << 2;
      if (h & 0x800) I.rn = 13; else { I.rn = 15; I.lit = 1; } return I;
    case 11: return decodeT16Misc(h, I);
    case 12:
      I.op = (h & 0x800) ? O.LDM : O.STM; I.rn = (h >>> 8) & 7; I.list = h & 0xFF; I.P = 0; I.U = 1;
      I.W = (h & 0x800) && (I.list >>> I.rn) & 1 ? 0 : 1; return I;
    case 13: {
      const c = (h >>> 8) & 15;
      if (c === 14) return udf(I);
      if (c === 15) { I.op = O.SVC; I.imm = h & 0xFF; return I; }
      I.op = O.B; I.cond = c; I.imm = sx(h & 0xFF, 8) << 1; I.kind = 1; return I; // kind=1: conditional-in-encoding
    }
    default: // 14: B imm11 (bit11 = 0)
      I.op = O.B; I.imm = sx(h & 0x7FF, 11) << 1; return I;
  }
}
function decodeT16LSreg(h, I) {
  const o = (h >>> 9) & 7;
  I.rd = h & 7; I.rn = (h >>> 3) & 7; I.rm = (h >>> 6) & 7; I.P = 1; I.U = 1;
  switch (o) {
    case 0: I.op = O.STR; I.size = 4; break; case 1: I.op = O.STR; I.size = 2; break; case 2: I.op = O.STR; I.size = 1; break;
    case 3: I.op = O.LDR; I.size = 1; I.sgn = 1; break; case 4: I.op = O.LDR; I.size = 4; break;
    case 5: I.op = O.LDR; I.size = 2; break; case 6: I.op = O.LDR; I.size = 1; break; default: I.op = O.LDR; I.size = 2; I.sgn = 1;
  }
  return I;
}
function decodeT16Misc(h, I) {
  if ((h & 0xFF00) === 0xB000) { I.op = O.DP; I.dp = (h & 0x80) ? 2 : 4; I.rd = 13; I.rn = 13; I.isImm = 1; I.imm = (h & 0x7F) << 2; return I; }
  if ((h & 0xFF00) === 0xB200) { I.op = O.EXT; I.kind = [1, 0, 3, 2][(h >>> 6) & 3]; I.rd = h & 7; I.rm = (h >>> 3) & 7; I.rn = 15; I.rot = 0; return I; }
  if ((h & 0xF500) === 0xB100) { I.op = O.CBZ; I.kind = (h >>> 11) & 1; I.rn = h & 7; I.imm = ((h >>> 3) & 0x40) | ((h >>> 2) & 0x3E); return I; }
  if ((h & 0xFE00) === 0xB400) { I.op = O.STM; I.rn = 13; I.P = 1; I.U = 0; I.W = 1; I.list = (h & 0xFF) | ((h & 0x100) ? 0x4000 : 0); return I; }
  if ((h & 0xFE00) === 0xBC00) { I.op = O.LDM; I.rn = 13; I.P = 0; I.U = 1; I.W = 1; I.list = (h & 0xFF) | ((h & 0x100) ? 0x8000 : 0); return I; }
  if ((h & 0xFFC0) === 0xBA00) { I.op = O.REV; I.rd = h & 7; I.rm = (h >>> 3) & 7; return I; }
  if ((h & 0xFFC0) === 0xBA40) { I.op = O.REV16; I.rd = h & 7; I.rm = (h >>> 3) & 7; return I; }
  if ((h & 0xFFC0) === 0xBAC0) { I.op = O.REVSH; I.rd = h & 7; I.rm = (h >>> 3) & 7; return I; }
  if ((h & 0xFF00) === 0xBE00) { I.op = O.BKPT; I.imm = h & 0xFF; return I; }
  if ((h & 0xFF00) === 0xBF00) {
    if (h & 15) { I.op = O.IT; I.o1 = (h >>> 4) & 15; I.o2 = h & 15; return I; }
    const hint = (h >>> 4) & 15; I.op = hint === 1 ? O.YIELD : hint === 2 ? O.WFE : hint === 3 ? O.WFI : hint === 4 ? O.SEV : O.NOP; return I;
  }
  if ((h & 0xFFE8) === 0xB660) { I.op = O.CPS; I.kind = (h & 0x10) ? 3 : 2; I.x = 0; I.W = h & 7; return I; }
  if ((h & 0xFFF7) === 0xB650) { I.op = O.SETEND; I.imm = (h >>> 3) & 1; return I; }
  return udf(I);
}
function decodeT32(h1, h2, I) {
  const op1 = (h1 >>> 11) & 3, op2 = (h1 >>> 4) & 0x7F, op = (h2 >>> 15) & 1;
  if (op1 === 1) {
    if (op2 & 0x40) return t32Coproc(h1, h2, I);
    if (op2 & 0x20) return t32DPShifted(h1, h2, I);
    if (op2 & 4) return t32DualExTbb(h1, h2, I);
    return t32LDMSTM(h1, h2, I);
  }
  if (op1 === 2) {
    if (!op) return (h1 & 0x200) ? t32PlainImm(h1, h2, I) : t32DPModImm(h1, h2, I);
    return t32Branch(h1, h2, I);
  }
  // op1 === 3
  if (op2 & 0x40) {
    if ((op2 & 0x70) === 0x40) return t32Coproc(h1, h2, I);
    return t32Coproc(h1, h2, I);
  }
  if ((op2 & 0x71) === 0x00) return t32LSSingle(h1, h2, I, 0);   // store single
  if ((op2 & 0x71) === 0x10) return udf(I);                         // SIMD ld/st multiple/single: treat as VFP
  if ((op2 & 0x67) === 0x01 || (op2 & 0x67) === 0x03 || (op2 & 0x67) === 0x05) return t32LSSingle(h1, h2, I, 1);
  if ((op2 & 0x70) === 0x20) return t32DPReg(h1, h2, I);
  if ((op2 & 0x78) === 0x30) return t32Mul(h1, h2, I);
  if ((op2 & 0x78) === 0x38) return t32LongMul(h1, h2, I);
  return udf(I);
}
function t32LDMSTM(h1, h2, I) {
  const m = (h1 >>> 7) & 3, L = (h1 >>> 4) & 1, W = (h1 >>> 5) & 1, rn = h1 & 15;
  if (m === 1 || m === 2) {
    I.op = L ? O.LDM : O.STM; I.rn = rn; I.W = W; I.list = h2 & 0xFFFF;
    if (m === 1) { I.P = 0; I.U = 1; } else { I.P = 1; I.U = 0; }
    return I;
  }
  // SRS / RFE
  if (L) { I.op = O.RFE; I.rn = rn; I.W = W; I.P = m === 3 ? 1 : 0; I.U = m === 3 ? 1 : 0; return I; }
  I.op = O.SRS; I.o1 = h2 & 31; I.W = W; I.P = m === 3 ? 1 : 0; I.U = m === 3 ? 1 : 0; return I;
}
function t32DualExTbb(h1, h2, I) {
  const P = (h1 >>> 8) & 1, U = (h1 >>> 7) & 1, W = (h1 >>> 5) & 1, L = (h1 >>> 4) & 1, rn = h1 & 15;
  if (!P && !U && !W || (!P && U && !W && false)) {
    // exclusive: STREX / LDREX (word)
  }
  if (!P && !U) { // 1110 1000 0xxx : STREX/LDREX
    if (W === 0 && !L) { I.op = O.STREX; I.size = 4; I.rn = rn; I.rd = (h2 >>> 8) & 15; I.rm = (h2 >>> 12) & 15; I.imm = (h2 & 0xFF) << 2; I.isImm = 1; return I; }
    if (W === 0 && L) { I.op = O.LDREX; I.size = 4; I.rn = rn; I.rd = (h2 >>> 12) & 15; I.imm = (h2 & 0xFF) << 2; I.isImm = 1; return I; }
    if (W && !L) { /* STRD post? falls below */ }
  }
  if (!P && U && !W) { // 1110 1000 11x : TBB/TBH, STREXB/H/D, LDREXB/H/D
    const o = (h2 >>> 4) & 15;
    if (L && o === 0) { I.op = O.TB; I.kind = 0; I.rn = rn; I.rm = h2 & 15; return I; }
    if (L && o === 1) { I.op = O.TB; I.kind = 1; I.rn = rn; I.rm = h2 & 15; return I; }
    if (L) { const sz = o === 4 ? 1 : o === 5 ? 2 : o === 7 ? 8 : 0; if (!sz) return udf(I); I.op = O.LDREX; I.size = sz; I.rn = rn; I.rd = (h2 >>> 12) & 15; I.rdhi = (h2 >>> 8) & 15; return I; }
    const sz = o === 4 ? 1 : o === 5 ? 2 : o === 7 ? 8 : 0; if (!sz) return udf(I);
    I.op = O.STREX; I.size = sz; I.rn = rn; I.rm = (h2 >>> 12) & 15; I.rdhi = (h2 >>> 8) & 15; I.rd = h2 & 15; return I;
  }
  if (P || W) { // LDRD / STRD immediate
    I.op = L ? O.LDR : O.STR; I.size = 8; I.rn = rn; I.rd = (h2 >>> 12) & 15; I.rdhi = (h2 >>> 8) & 15;
    I.P = P; I.U = U; I.W = W; I.isImm = 1; I.imm = (h2 & 0xFF) << 2; if (rn === 15) I.lit = 1; return I;
  }
  return udf(I);
}
function t32DPShifted(h1, h2, I) {
  const opc = (h1 >>> 5) & 15, S = (h1 >>> 4) & 1, rn = h1 & 15, rd = (h2 >>> 8) & 15, rm = h2 & 15;
  I.rn = rn; I.rd = rd; I.rm = rm; I.S = S;
  shiftFields(I, (h2 >>> 4) & 3, ((h2 >>> 10) & 0x1C) | ((h2 >>> 6) & 3));
  if (opc === 6) { // PKH
    if (S) return udf(I);
    I.op = O.PKH; I.kind = (h2 >>> 5) & 1 ? 1 : 0; I.shImm = (((h2 >>> 12) & 7) << 2) | ((h2 >>> 6) & 3);
    if (I.kind && !I.shImm) I.shImm = 32; return I;
  }
  const map = { 0: 0, 1: 14, 2: 12, 3: 16, 4: 1, 8: 4, 10: 5, 11: 6, 13: 2, 14: 3 };
  if (!(opc in map)) return udf(I);
  let dp = map[opc];
  I.op = O.DP;
  if (rd === 15 && S) { if (dp === 0) dp = 8; else if (dp === 1) dp = 9; else if (dp === 4) dp = 11; else if (dp === 2) dp = 10; else return udf(I); }
  if (rn === 15 && dp === 12) dp = 13;       // ORR rd, pc -> MOV
  if (rn === 15 && dp === 16) dp = 15;       // ORN -> MVN
  I.dp = dp; return I;
}
function t32DPModImm(h1, h2, I) {
  const opc = (h1 >>> 5) & 15, S = (h1 >>> 4) & 1, rn = h1 & 15, rd = (h2 >>> 8) & 15;
  I.rn = rn; I.rd = rd; I.S = S; I.isImm = 1; I.op = O.DP;
  thumbExpand((h1 >>> 10) & 1, (h2 >>> 12) & 7, h2 & 0xFF, I);
  const map = { 0: 0, 1: 14, 2: 12, 3: 16, 4: 1, 8: 4, 10: 5, 11: 6, 13: 2, 14: 3 };
  if (!(opc in map)) return udf(I);
  let dp = map[opc];
  if (rd === 15 && S) { if (dp === 0) dp = 8; else if (dp === 1) dp = 9; else if (dp === 4) dp = 11; else if (dp === 2) dp = 10; else return udf(I); }
  if (rn === 15 && dp === 12) dp = 13;
  if (rn === 15 && dp === 16) dp = 15;
  I.dp = dp; return I;
}
function t32PlainImm(h1, h2, I) {
  const o = (h1 >>> 4) & 31, rn = h1 & 15, rd = (h2 >>> 8) & 15;
  const imm12 = (((h1 >>> 10) & 1) << 11) | (((h2 >>> 12) & 7) << 8) | (h2 & 0xFF);
  I.rn = rn; I.rd = rd;
  switch (o) {
    case 0: case 10: // ADDW / SUBW / ADR
      I.op = O.DP; I.dp = o === 0 ? 4 : 2; I.isImm = 1; I.imm = imm12; I.S = 0; if (rn === 15) I.lit = 1; return I;
    case 4: I.op = O.MOVW; I.imm = (rn << 12) | imm12; return I;
    case 12: I.op = O.MOVT; I.imm = (rn << 12) | imm12; return I;
    case 16: case 18: case 24: case 26: {
      const uns = o >= 24; const amt = ((h2 >>> 12) & 7) * 4 + ((h2 >>> 6) & 3);
      if ((o === 18 || o === 26) && amt === 0 && false) { }
      if ((o === 18 || o === 26) && amt === 0 && ((h2 & 0x70C0) === 0)) { I.op = O.SAT16; I.kind = uns ? 1 : 0; I.o1 = (h2 & 15) + (uns ? 0 : 1); return I; }
      I.op = O.SAT; I.kind = uns ? 1 : 0; I.o1 = (h2 & 31) + (uns ? 0 : 1);
      I.sh = (o === 18 || o === 26) ? 2 : 0; I.shImm = amt; if (I.sh === 2 && !I.shImm) I.shImm = 32; I.rm = rn; return I;
    }
    case 20: case 28: I.op = o === 28 ? O.UBFX : O.SBFX; I.o1 = (((h2 >>> 12) & 7) << 2) | ((h2 >>> 6) & 3); I.o2 = (h2 & 31) + 1; return I;
    case 22: {
      const lsb = (((h2 >>> 12) & 7) << 2) | ((h2 >>> 6) & 3), msb = h2 & 31; if (msb < lsb) return udf(I);
      I.o1 = lsb; I.o2 = msb - lsb + 1; I.op = rn === 15 ? O.BFC : O.BFI; return I;
    }
  }
  return udf(I);
}
function t32Branch(h1, h2, I) {
  const t = (h2 >>> 12) & 7;
  const S = (h1 >>> 10) & 1, j1 = (h2 >>> 13) & 1, j2 = (h2 >>> 11) & 1;
  if (t & 4 || (t & 1)) { // BL / BLX / B.W
    const i1 = (~(j1 ^ S)) & 1, i2 = (~(j2 ^ S)) & 1;
    const imm = (S << 24) | (i1 << 23) | (i2 << 22) | ((h1 & 0x3FF) << 12) | ((h2 & 0x7FF) << 1);
    I.imm = sx(imm, 25);
    if (t & 4) { I.op = (t & 1) ? O.BL : O.BLX_I; if (!(t & 1)) I.imm &= ~2; } else I.op = O.B;
    return I;
  }
  // t = 0b0x0
  const c = (h1 >>> 6) & 15;
  if (c < 14) { // conditional B.W
    I.op = O.B; I.cond = c; I.kind = 1;
    I.imm = sx((S << 20) | (j2 << 19) | (j1 << 18) | ((h1 & 0x3F) << 12) | ((h2 & 0x7FF) << 1), 21); return I;
  }
  return t32Misc(h1, h2, I);
}
function t32Misc(h1, h2, I) {
  if ((h1 & 0xFFE0) === 0xF380) { I.op = O.MSR; I.isImm = 0; I.kind = (h1 >>> 4) & 1; I.o1 = (h2 >>> 8) & 15; I.rm = h1 & 15; return I; }
  if ((h1 & 0xFFEF) === 0xF3EF && (h2 & 0xF000) === 0x8000) { I.op = O.MRS; I.kind = (h1 >>> 4) & 1; I.rd = (h2 >>> 8) & 15; return I; }
  if (h1 === 0xF3AF && (h2 & 0xFF00) === 0x8000) {
    const h = h2 & 0xFF; I.op = h === 0 ? O.NOP : h === 1 ? O.YIELD : h === 2 ? O.WFE : h === 3 ? O.WFI : h === 4 ? O.SEV : O.NOP; I.imm = h; return I;
  }
  if (h1 === 0xF3AF && (h2 & 0xE000) === 0x8000 && (h2 & 0xFF00) !== 0x8000) {
    I.op = O.CPS; I.kind = (h2 >>> 9) & 3; I.x = (h2 >>> 8) & 1; I.o1 = h2 & 31; I.W = (h2 >>> 5) & 7; return I;
  }
  if (h1 === 0xF3BF) {
    const o = (h2 >>> 4) & 15;
    if ((h2 & 0xFF00) === 0x8F00) { I.op = o === 2 ? O.CLREX : o === 4 ? O.DSB : o === 5 ? O.DMB : o === 6 ? O.ISB : O.NOP; return I; }
  }
  if ((h1 & 0xFFFF) === 0xF3DE && (h2 & 0xFF00) === 0x8F00) { // SUBS pc, lr, #imm8
    I.op = O.DP; I.dp = 2; I.S = 1; I.rd = 15; I.rn = 14; I.isImm = 1; I.imm = h2 & 0xFF; return I;
  }
  return udf(I);
}
function t32LSSingle(h1, h2, I, load) {
  const size = (h1 >>> 5) & 3, sgn = (h1 >>> 8) & 1, rn = h1 & 15, rt = (h2 >>> 12) & 15;
  if (size === 3) return udf(I);
  I.op = load ? O.LDR : O.STR; I.size = [1, 2, 4][size]; I.sgn = load ? sgn : 0; I.rn = rn; I.rd = rt;
  if (load && rn === 15) { // literal
    I.isImm = 1; I.lit = 1; I.imm = h2 & 0xFFF; I.P = 1; I.U = (h1 >>> 7) & 1;
    if (rt === 15 && size < 2) { I.op = O.PLD; }
    return I;
  }
  if (h1 & 0x80) { I.isImm = 1; I.imm = h2 & 0xFFF; I.P = 1; I.U = 1; }
  else if ((h2 & 0x800) === 0) { I.rm = h2 & 15; I.shImm = (h2 >>> 4) & 3; I.P = 1; I.U = 1; I.sh = 0; }
  else {
    I.isImm = 1; I.imm = h2 & 0xFF; I.P = (h2 >>> 10) & 1; I.U = (h2 >>> 9) & 1; I.W = (h2 >>> 8) & 1;
    if (I.P && I.U && !I.W && false) { }
    if ((h2 & 0xF00) === 0xE00) { I.usr = 1; I.P = 1; I.U = 1; I.W = 0; }
  }
  if (load && rt === 15 && size < 2 && !sgn) { I.op = O.PLD; }
  if (load && rt === 15 && size < 2 && sgn) { I.op = O.PLI; }
  return I;
}
function t32DPReg(h1, h2, I) {
  const op1 = (h1 >>> 4) & 15, op2 = (h2 >>> 4) & 15, rn = h1 & 15, rd = (h2 >>> 8) & 15, rm = h2 & 15;
  I.rn = rn; I.rd = rd; I.rm = rm;
  if ((op1 & 8) === 0) {
    if (op2 === 0) { // register shift
      I.op = O.DP; I.dp = 13; I.S = (h1 >>> 4) & 1; I.sh = (h1 >>> 5) & 3; I.shReg = 1; I.rs = rm; I.rm = rn; return I;
    }
    if (op2 & 8) { // extend (with optional accumulate)
      const k = (op1 >>> 0) & 7; const map = { 0: 1, 1: 3, 2: 4, 3: 5, 4: 0, 5: 2 };
      if (!(k in map)) return udf(I);
      I.op = O.EXT; I.kind = map[k]; I.rot = ((h2 >>> 4) & 3) * 8; return I;
    }
    return udf(I);
  }
  // parallel add/sub (op1 bit3 =1, op2 bit3=0) and misc operations
  if (op2 < 8) {
    const prefix = [0, 1, 3, 5, 6, 7, 0, 0]; // op2[1:0] with U via op1 handled below
    const po = (op1 >>> 0) & 7; const u = (op2 >>> 2) & 1; const pf = (op2 & 3);
    const kindS = pf === 0 ? 1 : pf === 1 ? 2 : pf === 2 ? 3 : -1;
    // ARM encoding: S=001,Q=010,SH=011, U=101,UQ=110,UH=111
    const k = u ? (pf === 0 ? 5 : pf === 1 ? 6 : pf === 2 ? 7 : -1) : kindS;
    // thumb op1 (low 3 bits): 001 ADD16, 010 ASX, 110 SAX, 101 SUB16, 000 ADD8, 100 SUB8
    const tmap = { 1: 0, 2: 1, 6: 2, 5: 3, 0: 4, 4: 7 };
    if (k < 0 || !(po in tmap)) return udf(I);
    I.op = O.PAR; I.kind = k; I.o1 = tmap[po]; return I;
  }
  const k = (op1 & 7), s = (h2 >>> 4) & 3;
  if (op2 >= 8 && op2 <= 11 || op2 >= 8) {
    if (k === 0) { I.op = [O.QADD, O.QDADD, O.QSUB, O.QDSUB][s]; I.rn = rm; I.rm = rn; I.rn = rn; I.rm = rm;
      // QADD rd, rm, rn : operands swapped relative to ARM field names; store as ARM-style (rm=value, rn=addend)
      I.rm = rm; I.rn = rn; return I; }
    if (k === 1) { I.op = [O.REV, O.REV16, O.RBIT, O.REVSH][s]; I.rm = rm; return I; }
    if (k === 2 && s === 0) { I.op = O.SEL; return I; }
    if (k === 3 && s === 0) { I.op = O.CLZ; I.rm = rm; return I; }
  }
  return udf(I);
}
function t32Mul(h1, h2, I) {
  const o1 = (h1 >>> 4) & 7, o2 = (h2 >>> 4) & 3, rn = h1 & 15, ra = (h2 >>> 12) & 15, rd = (h2 >>> 8) & 15, rm = h2 & 15;
  I.rn = rn; I.rd = rd; I.rm = rm; I.ra = ra; I.rs = rm;
  if (o1 === 0) {
    if (o2 === 0) { I.op = ra === 15 ? O.MUL : O.MLA; I.rs = rm; I.rm = rn; I.S = 0; return I; }
    if (o2 === 1) { I.op = O.MLS; I.rs = rm; I.rm = rn; return I; }
    return udf(I);
  }
  if (o1 === 1) { I.op = O.HMUL; I.kind = ra === 15 ? 3 : 0; I.x = (h2 >>> 5) & 1; I.y = (h2 >>> 4) & 1; I.rs = rm; I.rm = rn; return I; }
  if (o1 === 3) { I.op = O.HMUL; I.kind = ra === 15 ? 4 : 1; I.y = (h2 >>> 4) & 1; I.rs = rm; I.rm = rn; return I; }
  if (o1 === 7) { I.op = O.USAD8; I.rn = rn; I.rm = rm; return I; }
  I.op = O.DSPMUL; I.w = (h1 << 16) | h2; I.thumb = 1; return I;
}
function t32LongMul(h1, h2, I) {
  const o1 = (h1 >>> 4) & 7, o2 = (h2 >>> 4) & 15, rn = h1 & 15, rl = (h2 >>> 12) & 15, rh = (h2 >>> 8) & 15, rm = h2 & 15;
  I.rm = rn; I.rs = rm; I.rd = rl; I.rdhi = rh; I.rn = rn;
  if (o1 === 0 && o2 === 0) { I.op = O.SMULL; return I; }
  if (o1 === 2 && o2 === 0) { I.op = O.UMULL; return I; }
  if (o1 === 4 && o2 === 0) { I.op = O.SMLAL; return I; }
  if (o1 === 6 && o2 === 0) { I.op = O.UMLAL; return I; }
  if (o1 === 6 && o2 === 6) { I.op = O.UMAAL; return I; }
  if (o1 === 1 && o2 === 15) { I.op = O.DIV; I.kind = 0; I.rd = rh; I.rn = rn; I.rm = rm; return I; }
  if (o1 === 3 && o2 === 15) { I.op = O.DIV; I.kind = 1; I.rd = rh; I.rn = rn; I.rm = rm; return I; }
  return udf(I);
}
function t32Coproc(h1, h2, I) {
  const cp = (h2 >>> 8) & 15;
  if ((h1 & 0xEF00) === 0xEF00 || (h1 & 0xFF00) === 0xF900 || ((h1 & 0xFE00) === 0xFC00 && false)) { I.op = O.VFP; return I; }
  if (cp === 10 || cp === 11) { I.op = O.VFP; return I; }
  if ((h1 & 0xFFE0) === 0xEC40) {
    I.op = (h1 & 0x10) ? O.MRRC : O.MCRR; I.cp = cp; I.o1 = (h2 >>> 4) & 15; I.rd = (h2 >>> 12) & 15; I.rn = h1 & 15; I.crm = h2 & 15; return I;
  }
  if ((h1 & 0xFF00) === 0xEE00 || (h1 & 0xFF00) === 0xFE00) {
    if (h1 & 0xFF00 === 0xFE00) return udf(I);
    I.cp = cp; I.o1 = (h1 >>> 5) & 7; I.crn = h1 & 15; I.rd = (h2 >>> 12) & 15; I.o2 = (h2 >>> 5) & 7; I.crm = h2 & 15;
    if (h2 & 0x10) I.op = (h1 & 0x10) ? O.MRC : O.MCR; else I.op = O.CDP; return I;
  }
  if ((h1 & 0xFE00) === 0xEC00) {
    I.op = (h1 & 0x10) ? O.LDC : O.STC; I.cp = cp; I.P = (h1 >>> 8) & 1; I.U = (h1 >>> 7) & 1; I.x = (h1 >>> 6) & 1; I.W = (h1 >>> 5) & 1;
    I.rn = h1 & 15; I.crn = (h2 >>> 12) & 15; I.imm = (h2 & 0xFF) << 2; return I;
  }
  return udf(I);
}

module.exports = { O, NAMES, DPN, Inst, decodeARM, decodeThumb, ror, sx };
