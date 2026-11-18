// Print a backtrace (and r0-r3) every time the CPU enters the given address(es). usage: node tools/bthook.js <hexaddr[,hexaddr]> [maxInstr]
const fs=require('fs');const {Emulator}=require('../src/emu.js');const W='work/';
const fw={kernel:new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin')),devicetree:new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin')),ramdisk:new Uint8Array(fs.readFileSync(W+'018-7226-009.dmg.bin'))};
const e=new Emulator(fw,{cmdline:process.env.CMD||'-v rd=md0'});const cpu=e.cpu;
const rd=(a)=>{try{return cpu.rd32(a>>>0)>>>0;}catch(x){return 0;}};const sym=(a)=>(a>>>0).toString(16)+' '+e.symAt(a>>>0);
const dump=require('./osdump.js').makeDumper(e);const rs=(a)=>{let s='';for(let i=0;i<120;i++){let c;try{c=cpu.rd8((a+i)>>>0);}catch(x){break;}if(!c)break;s+=String.fromCharCode(c);}return s;};
let hits=0;const lines=[];e.consoleSink=t=>lines.push(t.trim());
for(const h of process.argv[2].split(','))cpu.addHLE(parseInt(h,16)&~1,'bt'+h,(c)=>{if(hits++>20)return 0;
  const out=['HIT '+h+' after console: '+JSON.stringify(lines.slice(-1)[0]||''),'  r0..r3 '+[0,1,2,3].map(i=>(c.R[i]>>>0).toString(16)).join(' ')+'  str(r0)='+JSON.stringify(rs(c.R[0]>>>0).slice(0,80))+'  obj r1='+dump(c.R[1]>>>0,0)+' r3='+dump(c.R[3]>>>0,0),'  '+sym(c.R[14]>>>0)];
  let fp=c.R[7]>>>0;for(let i=0;i<14&&fp>=0xc0000000;i++){const lr=rd(fp+4),n=rd(fp);if(!lr)break;out.push('  '+sym(lr&~1));if(n<=fp)break;fp=n;}console.log(out.join('\n'));return 0;});
const max=+process.argv[3]||1500e6;while(e.ran<max){if(!e.run(5e6))break;}
