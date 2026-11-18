const fs=require('fs');const {Emulator}=require('../src/emu.js');
const W='work/';const fw={kernel:new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin')),devicetree:new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin')),ramdisk:new Uint8Array(fs.readFileSync(W+'018-7226-009.dmg.bin'))};
const e=new Emulator(fw,{cmdline:process.env.CMD||'-v rd=md0'});let lines=0;e.consoleSink=t=>{lines++;process.stdout.write('  | '+t);};
const t0=Date.now();const total=+process.argv[2]||200e6;let sweepAt=0;
while(e.ran<total){const n=e.run(2e6);if(!n)break;if(e.ran-sweepAt>=1e7){e.sweep();sweepAt=e.ran;}}
const dt=(Date.now()-t0)/1000;console.log('ran',e.ran,'in',dt.toFixed(1)+'s',(e.ran/dt/1e6).toFixed(1)+' MIPS','console lines',lines);console.log(JSON.stringify(e.stats()));
e.setTrace(true);e.run(2000);console.log(e.traceLines(6).join('\n'));
const f=e.frame();let nz=0;for(let i=0;i<f.length;i++)if(f[i]&0xFFFFFF)nz++;console.log('fb non-black',nz);
