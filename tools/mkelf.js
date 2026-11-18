// Re-emit the kernel's text bytes as an ELF (ARM/Thumb marked by symbol table) for disassembly cross-checking.
const fs=require('fs'),cp=require('child_process');
const b=fs.readFileSync('work/kernelcache.release.k48.bin');const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
let o=28,sym,n;for(let i=0;i<12;i++){const c=dv.getUint32(o,true),s=dv.getUint32(o+4,true);if(c===2){sym=dv.getUint32(o+8,true);n=dv.getUint32(o+12,true);}o+=s;}
const TEXT0=0xc0001000,TEXT1=0xc023f000;
const m=new Map();for(let i=0;i<n;i++){const p=sym+i*12;const v=dv.getUint32(p+8,true),d=dv.getUint16(p+6,true),t=b[p+4];
  if(v>=TEXT0&&v<TEXT1&&(t&0xe)===0xe||(v>=TEXT0&&v<TEXT1&&(t&1)===0&&false))m.set(v,(d&8)?1:0);}
// include all symbols in text regardless of type bits
for(let i=0;i<n;i++){const p=sym+i*12;const v=dv.getUint32(p+8,true),d=dv.getUint16(p+6,true);if(v>=TEXT0&&v<TEXT1&&!m.has(v))m.set(v,(d&8)?1:0);}
const addrs=[...m.keys()].sort((a,c)=>a-c);
let out=['.syntax unified','.section .text,"ax"','.globl _s','_s:'];
const lim=+process.argv[2]||addrs.length;
let cur=-1;let first=addrs[0];
for(let k=0;k<Math.min(addrs.length,lim);k++){
  const a=addrs[k],e=k+1<addrs.length?addrs[k+1]:TEXT1;const th=m.get(a);
  if(th!==cur){out.push(th?'.thumb':'.arm');cur=th;}
  const off=a-0xc0001000;
  if(th){for(let x=a;x<e;x+=2)out.push('.inst.n 0x'+dv.getUint16(x-0xc0001000,true).toString(16));}
  else {for(let x=a;x<e;x+=4)out.push('.inst 0x'+(dv.getUint32(x-0xc0001000,true)>>>0).toString(16));}
}
fs.writeFileSync('work/k.s',out.join('\n')+'\n');
cp.execSync('clang --target=armv7-none-eabi -mcpu=cortex-a8 -c work/k.s -o work/k.o');
cp.execSync('ld.lld -Ttext=0x'+first.toString(16)+' -e _s work/k.o -o work/k.elf');
cp.execSync('llvm-objdump -d --no-show-raw-insn work/k.elf > work/k.dis 2>/dev/null; llvm-objdump -d work/k.elf > work/k.disraw 2>/dev/null');
console.log('funcs',addrs.length,'first',first.toString(16));
