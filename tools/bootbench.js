// Boot benchmark: wall time until a kernel console line containing TARGET appears (default: the last line before the PMU stall).
// usage: node tools/bootbench.js [target] [maxInstructions]   env: NOJIT=1, NOHLE=1, QUIET=1
const fs=require('fs');const {Emulator}=require('../src/emu.js');
const W='work/';const fw={kernel:new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin')),devicetree:new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin')),ramdisk:new Uint8Array(fs.readFileSync(W+'018-7226-009.dmg.bin'))};
if(process.env.LOGO)fw.logo=require('../src/logo.js').decodeIBootIm(new Uint8Array(fs.readFileSync(W+'applelogo.s5l8930x.bin')));
const target=process.argv[2]||'AppleTVOut',max=+process.argv[3]||3e9;
const e=new Emulator(fw,{graphical:!!process.env.GRAPHICAL,cmdline:process.env.CMD||'-v rd=md0',hle:!process.env.NOHLE,poolBytes:process.env.POOL?(+process.env.POOL)<<20:undefined});if(process.env.NOJIT)e.cpu.jitEnabled=false;if(process.env.JITHOT)e.cpu.jitHot=+process.env.JITHOT;if(process.env.JS)e.cpu.jitBackend='js';
let hit=null,lines=[];const t0=Date.now();
e.consoleSink=t=>{lines.push(t);if(!process.env.QUIET)process.stdout.write(((Date.now()-t0)/1000).toFixed(2).padStart(7)+'s | '+t);if(!hit&&t.includes(target))hit={t:(Date.now()-t0)/1000,ran:e.ran,vms:e.cpu.cycles/40/24000};};
let sweepAt=0;while(!hit&&e.ran<max){const n=e.run(2e6);if(!n)break;if(e.ran-sweepAt>=2e7){e.sweep();sweepAt=e.ran;}}
const dt=(Date.now()-t0)/1000;
if(hit)console.log(`REACHED "${target}" after ${hit.t.toFixed(2)}s wall, ${(hit.ran/1e6).toFixed(1)}M instructions, ${hit.vms.toFixed(0)} ms guest time`);
else console.log(`NOT reached after ${dt.toFixed(1)}s, ${(e.ran/1e6).toFixed(0)}M instructions`);
console.log('ram',JSON.stringify(e.ram.stats()));console.log('console lines',lines.length,'hash',require('crypto').createHash('md5').update(lines.join('')).digest('hex').slice(0,12),'jit',JSON.stringify(e.cpu.jitStats),'hle',JSON.stringify(e.cpu.hleStats||{}));
