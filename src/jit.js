'use strict';
// iWebOS block compiler: translates straight-line runs of ARM/Thumb instructions into one generated JS function.
//
// A block starts at a hot guest address, runs until the first control transfer / system instruction (or 48 instructions, or the
// end of the 4 KB frame) and is cached by *physical* address, so it is valid for every virtual mapping of that code.
// Anything the translator has no inline template for is executed through the interpreter's own exec() from inside the block,
// so behaviour (flags, faults, instruction counts, virtual time) is identical to interpreting one instruction at a time.
const { O, Inst, decodeARM, decodeThumb } = require('./decode.js');

const MAXN = 48;
const ENDERS = new Set([O.BX, O.BLX_R, O.BLX_I, O.TB, O.SVC, O.BKPT, O.UDF, O.MRS, O.MSR, O.CPS, O.SRS, O.RFE,
  O.MCR, O.MCRR, O.MRRC, O.CDP, O.LDC, O.STC, O.WFI, O.WFE, O.SEV, O.YIELD, O.SETEND]);

// enders that are plain control transfers; every other ender (SVC, MSR, CPS, CP15, WFI ...) tells the dispatcher to re-check interrupts etc.
const PLAIN_BRANCH = new Set([O.BX, O.BLX_R, O.BLX_I, O.TB]);
const CONDS = ['cpu.Z===1', 'cpu.Z===0', 'cpu.C===1', 'cpu.C===0', 'cpu.N===1', 'cpu.N===0', 'cpu.V===1', 'cpu.V===0',
  'cpu.C===1&&cpu.Z===0', 'cpu.C===0||cpu.Z===1', 'cpu.N===cpu.V', 'cpu.N!==cpu.V', 'cpu.N===cpu.V&&cpu.Z===0', 'cpu.N!==cpu.V||cpu.Z===1'];

const s32 = (x) => (x | 0);

// inline barrel-shifter expression (result only; the carry-out is not needed by the caller)
function shiftExpr(x, type, n) {
  switch (type) {
    case 0: return n === 0 ? x : `(${x}<<${n})`;
    case 1: return n >= 32 ? '0' : `((${x}>>>${n})|0)`;
    case 2: return `(${x}>>${n >= 32 ? 31 : n})`;
    case 3: return `((${x}>>>${n})|(${x}<<${32 - n}))`;
    default: return `((${x}>>>1)|(cpu.C<<31))`;
  }
}

// -------- per-instruction templates. Each returns JS source (statements) or null if the instruction needs the generic path.
function genDP(I, pcv, S) {
  const dp = I.dp;
  const write = !(dp >= 8 && dp <= 11);
  if (I.rd === 15 && write) return null;
  if (dp > 16) return null;
  const logical = dp === 0 || dp === 1 || dp === 8 || dp === 9 || dp === 12 || dp === 13 || dp === 14 || dp === 15 || dp === 16;
  let pre = '', A, B, SC;
  if (dp === 13 || dp === 15) A = '0'; else A = I.rn === 15 ? String(s32(I.lit ? (pcv & ~3) : pcv)) : `R[${I.rn}]`;
  if (I.isImm) { B = String(I.imm | 0); SC = I.immC < 0 ? 'cpu.C' : String(I.immC); }
  else {
    const x = I.rm === 15 ? String(s32(pcv)) : `R[${I.rm}]`;
    if (I.shReg) { pre += `const b=cpu.shiftC(${x},${I.sh},R[${I.rs}]&255,cpu.C);const sc=cpu._sc;`; B = 'b'; SC = 'sc'; }
    else if (I.sh === 0 && I.shImm === 0) { B = x; SC = 'cpu.C'; }
    else if (S && logical) { pre += `const b=cpu.shiftC(${x},${I.sh},${I.shImm},cpu.C);const sc=cpu._sc;`; B = 'b'; SC = 'sc'; }
    else { B = shiftExpr(x, I.sh, I.shImm); SC = 'cpu.C'; }
  }
  let c = `{${pre}const a=${A},b2=${B};let r;`;
  const arith = (expr) => { c += expr; };
  switch (dp) {
    case 0: case 8: c += 'r=a&b2;'; break;
    case 1: case 9: c += 'r=a^b2;'; break;
    case 12: c += 'r=a|b2;'; break;
    case 13: c += 'r=b2;'; break;
    case 14: c += 'r=a&~b2;'; break;
    case 15: c += 'r=~b2;'; break;
    case 16: c += 'r=a|~b2;'; break;
    case 4: case 11: // add / cmn
      if (S) arith('const s=(a>>>0)+(b2>>>0);r=s|0;cpu.C=s>4294967295?1:0;cpu.V=((a^r)&(b2^r))>>>31;'); else c += 'r=(a+b2)|0;'; break;
    case 2: case 10: // sub / cmp
      if (S) arith('r=(a-b2)|0;cpu.C=(a>>>0)>=(b2>>>0)?1:0;cpu.V=((a^b2)&(a^r))>>>31;'); else c += 'r=(a-b2)|0;'; break;
    case 3: // rsb
      if (S) arith('r=(b2-a)|0;cpu.C=(b2>>>0)>=(a>>>0)?1:0;cpu.V=((b2^a)&(b2^r))>>>31;'); else c += 'r=(b2-a)|0;'; break;
    case 5: if (S) arith('r=cpu.addc(a,b2,cpu.C);cpu.C=cpu._cy;cpu.V=cpu._ov;'); else c += 'r=(a+b2+cpu.C)|0;'; break;
    case 6: if (S) arith('r=cpu.addc(a,~b2,cpu.C);cpu.C=cpu._cy;cpu.V=cpu._ov;'); else c += 'r=(a+~b2+cpu.C)|0;'; break;
    case 7: if (S) arith('r=cpu.addc(b2,~a,cpu.C);cpu.C=cpu._cy;cpu.V=cpu._ov;'); else c += 'r=(b2+~a+cpu.C)|0;'; break;
    default: return null;
  }
  if (S) { c += 'cpu.N=r>>>31;cpu.Z=r===0?1:0;'; if (logical) c += `cpu.C=${SC};`; }
  if (write) c += `R[${I.rd}]=r;`;
  return c + '}';
}

function genMem(I, pcv, i, isLoad) {
  if (I.size !== 1 && I.size !== 2 && I.size !== 4) return null;
  if (I.usr || I.rd === 15) return null;
  if (I.rn === 15 && (I.W || !I.P || !isLoad)) return null;
  let off;
  if (I.isImm) off = String(I.imm | 0);
  else {
    if (I.rm === 15 || I.sh === 4 || (I.shImm && I.sh !== 0)) return null;
    off = I.shImm ? `(R[${I.rm}]<<${I.shImm})` : `R[${I.rm}]`;
  }
  const base = I.rn === 15 ? String(s32(I.lit ? (pcv & ~3) : pcv)) : `R[${I.rn}]`;
  const wb = (I.W || !I.P);
  let c = `{const base=${base};const nb=(base${I.U ? '+' : '-'}(${off}))|0;const ea=(${I.P ? 'nb' : 'base'})>>>0;cpu.cycles=c0+${i + 1};`;
  if (isLoad) {
    let rd;
    if (I.size === 4) rd = 'cpu.rd32(ea)';
    else if (I.size === 2) rd = I.sgn ? '(cpu.rd16(ea)<<16)>>16' : 'cpu.rd16(ea)';
    else rd = I.sgn ? '(cpu.rd8(ea)<<24)>>24' : 'cpu.rd8(ea)';
    c += `const v=${rd};`;
    if (wb) c += `R[${I.rn}]=nb;`;
    c += `R[${I.rd}]=v;`;
  } else {
    c += `const v=R[${I.rd}];`;
    c += I.size === 4 ? 'cpu.wr32(ea,v);' : I.size === 2 ? 'cpu.wr16(ea,v);' : 'cpu.wr8(ea,v);';
    if (wb) c += `R[${I.rn}]=nb;`;
  }
  return c + '}';
}

function genLDMSTM(I, pcv, i, isLoad) {
  if (I.S || I.rn === 15 || I.list === 0) return null;
  if (isLoad && (I.list & 0x8000)) return null;
  const regs = []; for (let r = 0; r < 16; r++) if (I.list & (1 << r)) regs.push(r);
  const n = regs.length;
  const off = I.U ? (I.P ? 4 : 0) : (I.P ? -4 * n : -4 * n + 4);
  let c = `{const base=R[${I.rn}];const a=(base+(${off}))>>>0;cpu.cycles=c0+${i + 1};`;
  if (isLoad) {
    regs.forEach((r, k) => { c += `const v${k}=cpu.rd32(${k ? `(a+${4 * k})>>>0` : 'a'});`; });
    if (I.W) c += `R[${I.rn}]=(base+(${I.U ? 4 * n : -4 * n}))|0;`;
    regs.forEach((r, k) => { c += `R[${r}]=v${k};`; });
  } else {
    regs.forEach((r, k) => { c += `cpu.wr32(${k ? `(a+${4 * k})>>>0` : 'a'},${r === 15 ? s32(pcv) : `R[${r}]`});`; });
    if (I.W) c += `R[${I.rn}]=(base+(${I.U ? 4 * n : -4 * n}))|0;`;
  }
  return c + '}';
}

// returns { code, kind } ; kind: 0 plain, 1 memory (needs side-effect exit check), 2 block end (code sets R[15])
function genInst(I, K, i, pc, T) {
  const pcv = pc + (T ? 4 : 8);
  const next = pc + I.len;
  const S = I.S === 1 || I.S === 2;
  let c = null, kind = 0;
  switch (I.op) {
    case O.DP: c = genDP(I, pcv, S); break;
    case O.LDR: c = genMem(I, pcv, i, true); kind = 1; break;
    case O.STR: c = genMem(I, pcv, i, false); kind = 1; break;
    case O.LDM: c = genLDMSTM(I, pcv, i, true); kind = 1; break;
    case O.STM: c = genLDMSTM(I, pcv, i, false); kind = 1; break;
    case O.MOVW: if (I.rd !== 15) c = `R[${I.rd}]=${I.imm | 0};`; break;
    case O.MOVT: if (I.rd !== 15) c = `R[${I.rd}]=(R[${I.rd}]&0xFFFF)|${(I.imm << 16) | 0};`; break;
    case O.MUL: if (I.rd !== 15) { c = `{const r=Math.imul(R[${I.rm}],R[${I.rs}]);R[${I.rd}]=r;${S ? 'cpu.N=r>>>31;cpu.Z=r===0?1:0;' : ''}}`; } break;
    case O.CLZ: if (I.rd !== 15) c = `R[${I.rd}]=Math.clz32(R[${I.rm}]);`; break;
    case O.B: c = `R[15]=${s32(pcv + I.imm)};`; kind = 2; break;
    case O.BL: c = `R[14]=${s32(next | (T ? 1 : 0))};R[15]=${s32(pcv + I.imm)};`; kind = 2; break;
    case O.CBZ: c = `R[15]=((R[${I.rn}]===0)!==${I.kind === 1 ? 'true' : 'false'})?${s32(pcv + I.imm)}:${s32(next)};`; kind = 2; break;
  }
  if (c !== null) return { code: c, kind };
  // generic: run the interpreter's own executor for this instruction
  const ender = ENDERS.has(I.op);
  c = `cpu.pcv=${pcv};cpu.npc=${next};cpu.I_=K[${i}];cpu.cycles=c0+${i + 1};cpu.exec(K[${i}],${pc});`;
  c += ender ? `R[15]=cpu.npc|0;${PLAIN_BRANCH.has(I.op) ? '' : 'cpu.xb=1;'}return @T@${i + 1};`
    : `if(cpu.npc!==${next}||cpu.xb!==0){R[15]=cpu.npc|0;return @T@${i + 1};}`;
  return { code: c, kind: ender ? 3 : 0, generic: true };
}

// Compile the block that starts at guest address pc0 (virtual), located in RAM frame `frame` (4 KB frame index inside RAM).
// Conditional branches become side exits and translation continues on the fall-through path; an unconditional B to a not yet
// visited address in the same frame is followed; a branch back to the block's own start becomes a loop inside the function.
function compile(cpu, frame, pc0, T) {
  const ram = cpu.ram, base = frame << 12;
  const K = [], pcs = [], seen = new Set();
  const noLoop = pc0 === cpu.hookPC || pc0 === cpu.idlePC || pc0 === cpu.breakAt;
  let src = '', pc = pc0, off = 0, n = 0, ended = false, inline = 0, loopLen = 0;
  while (n < MAXN && !ended) {
    if (pc === cpu.hookPC || pc === cpu.idlePC || pc === cpu.breakAt || (n > 0 && cpu.isHLE(pc))) break;
    if (n > 0 && seen.has(pc)) break;
    if (((pc ^ pc0) >>> 12) !== 0) break;           // never leave the 4 KB frame the block is cached under
    off = pc & 0xFFF;
    if (off + (T ? 2 : 4) > 0x1000) break;
    const I = new Inst();
    if (T) {
      const h1 = ram.r16(base + off); let h2 = 0;
      if ((h1 >>> 11) >= 29) { if (off + 4 > 0x1000) break; h2 = ram.r16(base + off + 2); }
      decodeThumb(h1, h2, I);
    } else decodeARM(ram.r32(base + off) >>> 0, I);
    if (I.op === O.IT) break;
    K.push(I); pcs.push(pc); seen.add(pc);
    const g = genInst(I, K, n, pc, T);
    if (!g.generic) inline++;
    const cond = (I.cond >= 14) ? null : CONDS[I.cond];
    const next = pc + I.len, pcv = pc + (T ? 4 : 8);
    let nextPc = next;
    if (g.kind === 2 && (I.op === O.B || I.op === O.CBZ)) {
      const target = (pcv + I.imm) >>> 0;
      const taken = I.op === O.CBZ ? (I.kind === 1 ? `R[${I.rn}]!==0` : `R[${I.rn}]===0`) : cond;
      if (I.op === O.B && taken === null && ((target >>> 12) === (pc0 >>> 12)) && !seen.has(target) && target !== pc0 && n + 1 < MAXN - 1) {
        nextPc = target;                                               // unconditional forward/backward jump inside the frame: keep translating there
      } else if (target === pc0 && !noLoop && loopLen === 0) {
        loopLen = n + 1;                                               // branch back to the start: stay inside the function
        const body = `cpu.cycles=c0+${n + 1};tot+=${n + 1};if(tot+@N@<=left){continue;}R[15]=${s32(target)};return tot;`;
        src += taken === null ? body : `if(${taken}){${body}}`;
        if (taken === null) ended = true;
      } else if (taken === null) {                                     // unconditional jump we cannot follow: block ends
        src += `R[15]=${s32(target)};cpu.cycles=c0+${n + 1};return @T@${n + 1};`; ended = true;
      } else {                                                         // conditional: side exit, fall-through continues
        src += `if(${taken}){R[15]=${s32(target)};cpu.cycles=c0+${n + 1};return @T@${n + 1};}`;
      }
    } else if (g.kind === 2) {   // BL: block ends here
      src += cond ? `if(${cond}){${g.code}}else{R[15]=${s32(next)};}` : g.code;
      src += `cpu.cycles=c0+${n + 1};return @T@${n + 1};`; ended = true;
    } else if (g.kind === 3) {   // generic system instruction: it returns by itself when executed
      src += cond ? `if(${cond}){${g.code}}R[15]=${s32(next)};cpu.cycles=c0+${n + 1};return @T@${n + 1};` : g.code;
      ended = true;
    } else {
      src += cond ? `if(${cond}){${g.code}}` : g.code;
      if (g.kind === 1) src += `if(cpu.xb!==0){R[15]=${s32(next)};return @T@${n + 1};}`; // cycles were set before the access (a device may have moved time on)
    }
    n++; pc = nextPc;
  }
  if (n === 0 || (n === 1 && inline === 0)) return null;
  if (!ended) src += `R[15]=${s32(pc)};cpu.cycles=c0+${n};return @T@${n};`;
  src = src.replace(/@N@/g, String(n));
  const body = loopLen ? `const R=cpu.R;let tot=0;for(;;){const c0=cpu.cycles;${src.replace(/@T@/g, 'tot+')}}`
                       : `const R=cpu.R;const c0=cpu.cycles;${src.replace(/@T@/g, '')}`;
  let fn;
  try { fn = new Function('K', `return function b${pc0.toString(16)}(cpu,left){${body}}`)(K); } catch (e) { return null; }
  return { fn, n, pcs, loopLen, src: body };
}

module.exports = { compile, MAXN };
