'use strict';
// iWebOS disassembler: formats an Inst (decode.js) as text. Used by the verbose console.
const { O, DPN } = require('./decode.js');
const CC = ['eq','ne','hs','lo','mi','pl','vs','vc','hi','ls','ge','lt','gt','le','',''];
const RN = ['r0','r1','r2','r3','r4','r5','r6','r7','r8','r9','r10','r11','r12','sp','lr','pc'];
const SH = ['lsl','lsr','asr','ror','rrx'];
const hex = v => '0x' + (v >>> 0).toString(16);
const imm = v => '#' + (v | 0);
function regList(l) {
  const a = []; for (let i = 0; i < 16; i++) if (l & (1 << i)) a.push(RN[i]); return '{' + a.join(', ') + '}';
}
function op2(I) {
  if (I.isImm) return '#' + (I.imm >>> 0);
  let s = RN[I.rm];
  if (I.shReg) return s + ', ' + SH[I.sh] + ' ' + RN[I.rs];
  if (I.sh === 4) return s + ', rrx';
  if (I.sh === 0 && I.shImm === 0) return s;
  return s + ', ' + SH[I.sh] + ' #' + I.shImm;
}
function addr(I, pc) {
  const sign = I.U ? '' : '-';
  if (I.lit) { // pc-relative literal
    const base = ((pc + (I.thumb ? 4 : 8)) & ~3) >>> 0;
    return '[pc, #' + sign + (I.imm >>> 0) + ']  ; ' + hex((base + (I.U ? I.imm : -I.imm)) >>> 0);
  }
  let off;
  if (I.isImm) off = '#' + sign + (I.imm >>> 0);
  else { off = sign + RN[I.rm]; if (I.sh === 4) off += ', rrx'; else if (I.shImm) off += ', ' + SH[I.sh] + ' #' + I.shImm; }
  if (I.P) return '[' + RN[I.rn] + (I.isImm && !I.imm ? '' : ', ' + off) + ']' + (I.W ? '!' : '');
  return '[' + RN[I.rn] + '], ' + off;
}
function ldrName(I) {
  let n = I.op === O.LDR ? 'ldr' : 'str';
  if (I.size === 1) n += I.sgn ? 'sb' : 'b'; else if (I.size === 2) n += I.sgn ? 'sh' : 'h'; else if (I.size === 8) n += 'd';
  return n;
}
// cond: effective condition for display (Thumb IT block supplies it); inIT: S-suffix suppression for 16-bit Thumb
function disasm(I, pc, cond, inIT) {
  if (cond === undefined) cond = I.cond;
  const c = CC[cond & 15];
  const sfx = (I.S === 1 || (I.S === 2 && !inIT)) ? 's' : '';
  const rn = RN[I.rn], rd = RN[I.rd], rm = RN[I.rm];
  switch (I.op) {
    case O.DP: {
      const n = DPN[I.dp];
      if (I.dp === 13 && !I.isImm && (I.sh !== 0 || I.shReg || I.shImm)) { // shift pseudo-ops
        if (I.sh === 4) return 'rrx' + sfx + c + ' ' + rd + ', ' + rm;
        return SH[I.sh] + sfx + c + ' ' + rd + ', ' + rm + ', ' + (I.shReg ? RN[I.rs] : '#' + I.shImm);
      }
      if (I.dp === 13 || I.dp === 15) return n + sfx + c + ' ' + rd + ', ' + op2(I);
      if (I.dp >= 8 && I.dp <= 11) return n + c + ' ' + rn + ', ' + op2(I);
      if (I.lit && I.isImm && (I.dp === 4 || I.dp === 2)) {
        const base = ((pc + (I.thumb ? 4 : 8)) & ~3) >>> 0;
        return 'adr' + c + ' ' + rd + ', ' + hex((I.dp === 4 ? base + I.imm : base - I.imm) >>> 0);
      }
      return n + sfx + c + ' ' + rd + ', ' + rn + ', ' + op2(I);
    }
    case O.MUL: return 'mul' + sfx + c + ' ' + rd + ', ' + rm + ', ' + RN[I.rs];
    case O.MLA: return 'mla' + sfx + c + ' ' + rd + ', ' + rm + ', ' + RN[I.rs] + ', ' + RN[I.ra];
    case O.MLS: return 'mls' + c + ' ' + rd + ', ' + rm + ', ' + RN[I.rs] + ', ' + RN[I.ra];
    case O.UMULL: case O.UMLAL: case O.SMULL: case O.SMLAL: case O.UMAAL:
      return ['umull', 'umlal', 'smull', 'smlal', 'umaal'][[O.UMULL, O.UMLAL, O.SMULL, O.SMLAL, O.UMAAL].indexOf(I.op)] +
        (I.op === O.UMAAL ? '' : sfx) + c + ' ' + rd + ', ' + RN[I.rdhi] + ', ' + rm + ', ' + RN[I.rs];
    case O.HMUL: {
      const xy = (I.x ? 't' : 'b') + (I.y ? 't' : 'b');
      if (I.kind === 0) return 'smla' + xy + c + ' ' + rd + ', ' + rm + ', ' + RN[I.rs] + ', ' + RN[I.ra];
      if (I.kind === 1) return 'smlaw' + (I.y ? 't' : 'b') + c + ' ' + rd + ', ' + rm + ', ' + RN[I.rs] + ', ' + RN[I.ra];
      if (I.kind === 2) return 'smlal' + xy + c + ' ' + rd + ', ' + RN[I.rdhi] + ', ' + rm + ', ' + RN[I.rs];
      if (I.kind === 3) return 'smul' + xy + c + ' ' + rd + ', ' + rm + ', ' + RN[I.rs];
      return 'smulw' + (I.y ? 't' : 'b') + c + ' ' + rd + ', ' + rm + ', ' + RN[I.rs];
    }
    case O.CLZ: return 'clz' + c + ' ' + rd + ', ' + rm;
    case O.RBIT: return 'rbit' + c + ' ' + rd + ', ' + rm;
    case O.REV: return 'rev' + c + ' ' + rd + ', ' + rm;
    case O.REV16: return 'rev16' + c + ' ' + rd + ', ' + rm;
    case O.REVSH: return 'revsh' + c + ' ' + rd + ', ' + rm;
    case O.EXT: {
      const n = ['sxtb', 'sxth', 'uxtb', 'uxth', 'sxtb16', 'uxtb16'][I.kind];
      const acc = I.rn !== 15;
      return (acc ? n.replace('xt', 'xta') : n) + c + ' ' + rd + ', ' + (acc ? rn + ', ' : '') + rm + (I.rot ? ', ror #' + I.rot : '');
    }
    case O.SAT: return (I.kind ? 'usat' : 'ssat') + c + ' ' + rd + ', #' + I.o1 + ', ' + RN[I.rm] + (I.shImm ? ', ' + SH[I.sh] + ' #' + I.shImm : '');
    case O.SAT16: return (I.kind ? 'usat16' : 'ssat16') + c + ' ' + rd + ', #' + I.o1 + ', ' + rn;
    case O.BFI: return 'bfi' + c + ' ' + rd + ', ' + rn + ', #' + I.o1 + ', #' + I.o2;
    case O.BFC: return 'bfc' + c + ' ' + rd + ', #' + I.o1 + ', #' + I.o2;
    case O.SBFX: return 'sbfx' + c + ' ' + rd + ', ' + rn + ', #' + I.o1 + ', #' + I.o2;
    case O.UBFX: return 'ubfx' + c + ' ' + rd + ', ' + rn + ', #' + I.o1 + ', #' + I.o2;
    case O.PKH: return (I.kind ? 'pkhtb' : 'pkhbt') + c + ' ' + rd + ', ' + rn + ', ' + rm + (I.shImm ? ', ' + (I.kind ? 'asr' : 'lsl') + ' #' + I.shImm : '');
    case O.SEL: return 'sel' + c + ' ' + rd + ', ' + rn + ', ' + rm;
    case O.USAD8: return (I.ra === 15 ? 'usad8' : 'usada8') + c + ' ' + rd + ', ' + rn + ', ' + rm + (I.ra === 15 ? '' : ', ' + RN[I.ra]);
    case O.PAR: {
      const p = ['', 's', 'q', 'sh', '', 'u', 'uq', 'uh'][I.kind];
      return p + ['add16', 'asx', 'sax', 'sub16', 'add8', '', '', 'sub8'][I.o1] + c + ' ' + rd + ', ' + rn + ', ' + rm;
    }
    case O.QADD: case O.QSUB: case O.QDADD: case O.QDSUB:
      return ['qadd', 'qsub', 'qdadd', 'qdsub'][[O.QADD, O.QSUB, O.QDADD, O.QDSUB].indexOf(I.op)] + c + ' ' + rd + ', ' + rm + ', ' + rn;
    case O.LDR: case O.STR: {
      const n = ldrName(I) + (I.usr ? 't' : '') + c;
      if (I.size === 8) return n + ' ' + rd + ', ' + RN[I.thumb ? I.rdhi : I.rd + 1] + ', ' + addr(I, pc);
      return n + ' ' + rd + ', ' + addr(I, pc);
    }
    case O.LDM: case O.STM: {
      if (I.rn === 13 && I.W && I.op === O.STM && I.P && !I.U) return 'push' + c + ' ' + regList(I.list);
      if (I.rn === 13 && I.W && I.op === O.LDM && !I.P && I.U) return 'pop' + c + ' ' + regList(I.list);
      const m = I.P ? (I.U ? 'ib' : 'db') : (I.U ? 'ia' : 'da');
      return (I.op === O.LDM ? 'ldm' : 'stm') + m + c + ' ' + rn + (I.W ? '!' : '') + ', ' + regList(I.list) + (I.S ? '^' : '');
    }
    case O.B: return 'b' + (I.kind ? CC[I.cond] : c) + ' ' + hex((pc + (I.thumb ? 4 : 8) + I.imm) >>> 0);
    case O.BL: return 'bl' + c + ' ' + hex((pc + (I.thumb ? 4 : 8) + I.imm) >>> 0);
    case O.BLX_I: return 'blx ' + hex((((pc + (I.thumb ? 4 : 8)) & (I.thumb ? ~3 : ~0)) + I.imm) >>> 0);
    case O.BX: return 'bx' + c + ' ' + rm;
    case O.BLX_R: return 'blx' + c + ' ' + rm;
    case O.CBZ: return (I.kind ? 'cbnz ' : 'cbz ') + rn + ', ' + hex((pc + 4 + I.imm) >>> 0);
    case O.TB: return (I.kind ? 'tbh' : 'tbb') + c + ' [' + rn + ', ' + rm + (I.kind ? ', lsl #1' : '') + ']';
    case O.IT: {
      const fc = I.o1, mk = I.o2; let s = '';
      const len = 4 - Math.floor(Math.log2(mk & -mk)); // number of instructions - 1 handled below
      let n = 0; for (let b = 3; b >= 0; b--) if (mk & (1 << b)) { n = 4 - b; break; }
      n = 0; { let m = mk; let t = 0; while (!(m & 1)) { m >>= 1; t++; } n = 4 - t; }
      let out = 'it';
      for (let i = 1; i < n; i++) { const bit = (mk >> (4 - i)) & 1; out += (bit === (fc & 1)) ? 't' : 'e'; }
      return out + ' ' + (CC[fc] || 'al');
    }
    case O.MRS: return 'mrs' + c + ' ' + rd + ', ' + (I.kind ? 'spsr' : 'apsr');
    case O.MSR: {
      const r = I.kind ? 'spsr' : 'cpsr', m = I.o1;
      const f = (m & 8 ? 'f' : '') + (m & 4 ? 's' : '') + (m & 2 ? 'x' : '') + (m & 1 ? 'c' : '');
      return 'msr' + c + ' ' + r + '_' + f + ', ' + (I.isImm ? '#' + (I.imm >>> 0) : rm);
    }
    case O.CPS: {
      const a = (I.W & 4 ? 'a' : '') + (I.W & 2 ? 'i' : '') + (I.W & 1 ? 'f' : '');
      let s = 'cps';
      if (I.kind === 2) s += 'ie'; else if (I.kind === 3) s += 'id';
      if (I.kind >= 2) s += ' ' + a + (I.x ? ', #' + I.o1 : ''); else s += ' #' + I.o1;
      return s;
    }
    case O.SRS: return 'srs' + (I.P ? (I.U ? 'ib' : 'db') : (I.U ? 'ia' : 'da')) + ' sp' + (I.W ? '!' : '') + ', #' + I.o1;
    case O.RFE: return 'rfe' + (I.P ? (I.U ? 'ib' : 'db') : (I.U ? 'ia' : 'da')) + ' ' + rn + (I.W ? '!' : '');
    case O.SVC: return 'svc' + c + ' #' + (I.imm >>> 0);
    case O.BKPT: return 'bkpt #' + (I.imm >>> 0);
    case O.MCR: case O.MRC:
      return (I.op === O.MCR ? 'mcr' : 'mrc') + c + ' p' + I.cp + ', #' + I.o1 + ', ' + rd + ', c' + I.crn + ', c' + I.crm + ', #' + I.o2;
    case O.MCRR: case O.MRRC:
      return (I.op === O.MCRR ? 'mcrr' : 'mrrc') + c + ' p' + I.cp + ', #' + I.o1 + ', ' + rd + ', ' + rn + ', c' + I.crm;
    case O.CDP: return 'cdp' + c + ' p' + I.cp;
    case O.LDC: case O.STC: return (I.op === O.LDC ? 'ldc' : 'stc') + c + ' p' + I.cp + ', c' + I.crn + ', [' + rn + ', #' + (I.U ? '' : '-') + I.imm + ']';
    case O.NOP: return 'nop' + c; case O.WFI: return 'wfi' + c; case O.WFE: return 'wfe' + c; case O.SEV: return 'sev' + c; case O.YIELD: return 'yield' + c;
    case O.DMB: return 'dmb'; case O.DSB: return 'dsb'; case O.ISB: return 'isb'; case O.CLREX: return 'clrex';
    case O.PLD: return 'pld'; case O.PLI: return 'pli'; case O.SETEND: return 'setend ' + (I.imm ? 'be' : 'le');
    case O.MOVW: return 'movw' + c + ' ' + rd + ', #' + I.imm;
    case O.MOVT: return 'movt' + c + ' ' + rd + ', #' + I.imm;
    case O.SWP: return 'swp' + (I.size === 1 ? 'b' : '') + c + ' ' + rd + ', ' + rm + ', [' + rn + ']';
    case O.LDREX: return 'ldrex' + (I.size === 1 ? 'b' : I.size === 2 ? 'h' : I.size === 8 ? 'd' : '') + c + ' ' + rd + ', [' + rn + ']';
    case O.STREX: return 'strex' + (I.size === 1 ? 'b' : I.size === 2 ? 'h' : I.size === 8 ? 'd' : '') + c + ' ' + rd + ', ' + rm + ', [' + rn + ']';
    case O.VFP: return 'vfp/neon' + c + ' ; ' + hex(I.w >>> 0);
    case O.DSPMUL: return 'dspmul' + c + ' ; ' + hex(I.w >>> 0);
    case O.DIV: return (I.kind ? 'udiv' : 'sdiv') + c + ' ' + rd + ', ' + rn + ', ' + rm;
    default: return 'udf' + c + ' ; ' + hex(I.thumb ? (I.len === 4 ? ((I.w << 16) | I.w2) >>> 0 : I.w) : I.w);
  }
}
module.exports = { disasm, RN, CC, SH };
