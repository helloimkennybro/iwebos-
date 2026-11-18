// Sample the guest pc every N instructions after a warm-up; print the hottest kernel symbols (cheap profiler).
const fs=require('fs');const {Emulator}=require('../src/emu.js');const W='work/';
const fw={kernel:new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin')),devicetree:new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin')),ramdisk:new Uint8Array(fs.readFileSync(W+'018-7226-009.dmg.bin'))};
const warm=+process.argv[2]||600e6,span=+process.argv[3]||300e6,step=+process.argv[4]||20011;
const e=new Emulator(fw,{cmdline:process.env.CMD||'-v rd=md0'});
while(e.ran<warm){if(!e.run(5e6))break;}
const h=new Map(),hp=new Map();const v0=e.cpu.cycles;let n=0;
while(e.ran<warm+span){const r=e.run(step);if(!r)break;const pc=e.cpu.R[15]>>>0;const s=e.symAt(pc).replace(/\+0x[0-9a-f]+$/,'');h.set(s,(h.get(s)||0)+1);hp.set(pc,(hp.get(pc)||0)+1);n++;}
console.log('samples',n,'guest ms advanced',((e.cpu.cycles-v0)/40/24000).toFixed(0),'idle skips',e.machine.idleSkips||0,'irq',e.cpu.stats.irq,'mode',e.cpu.mode.toString(16));
console.log([...h].sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>(100*v/n).toFixed(1).padStart(5)+'% '+k).join('\n'));
console.log('top pcs',[...hp].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>k.toString(16)+':'+v).join(' '));
