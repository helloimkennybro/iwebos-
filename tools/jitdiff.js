// Differential test: boot the kernel with the interpreter and with the JIT in lockstep and report the first slice where state differs.
const fs=require('fs');
const {Ram,Bus}=require('../src/mem.js');const {CPU}=require('../src/cpu.js');
const {parseDT,findNode}=require('../src/macho.js');const {bootImage,PHYS}=require('../src/boot.js');const {Machine,attachDevices}=require('../src/soc.js');
const W='work/';
function mk(jit,hot){
  const kernel=new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin')),dt=new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin'));
  const ram=new Ram(PHYS,256<<20),bus=new Bus(ram),cpu=new CPU(ram,bus);cpu.jitEnabled=jit;if(hot!==undefined)cpu.jitHot=hot;
  bus.cpu=cpu;const log=()=>{};bus.log=log;cpu.log=log;
  const info=bootImage(ram,{kernel,devicetree:dt,ramdisk:null},{cmdline:'-v rd=md0'});
  const root=parseDT(dt);const devs=attachDevices(bus,cpu,root,log,{findNode,dtStr:require('../src/macho.js').dtStr},()=>{});const machine=new Machine(cpu,devs);
  if(ram.r32(0xc0063360-0xC0000000+0x40000000)===0xee1d2f90)cpu.idlePC=0xc0063360;
  cpu.reset(info.entry);cpu.R[0]=info.bootArgs;return {ram,cpu,machine};
}
const total=+process.argv[2]||2e6, slice=+process.argv[3]||5000, hot=(process.argv[4]!==undefined&&process.argv[4]!==''&&process.argv[4]!=='x')?+process.argv[4]:undefined;
const a=mk(false),b=mk(true,hot);let ran=0;const startCheck=process.env._BIS?+process.argv[5]:-1;if(process.env.DUMPLOOP)b.cpu.jitDump=(pc,blk)=>{if(blk.loopLen)console.log('LOOP block at',pc.toString(16),'n',blk.n,'loopLen',blk.loopLen,'\n'+blk.src);};
const sig=(m)=>Array.from(m.cpu.R).join(',')+'|'+m.cpu.getCPSR()+'|'+m.cpu.cycles;
if(process.env._BIS){ // replay up to the last good slice, then check every block against the interpreter
  while(ran<startCheck){const na=a.machine.run(slice),nb=b.machine.run(slice);ran+=na;}
  const cmp=(why,blk)=>{const sa=sig(a),sb=sig(b);if(sa!==sb){console.log('BLOCK MISMATCH',why,'at cycles',b.cpu.cycles);console.log(' interp',sa);console.log(' jit   ',sb);if(blk){console.log(' block pcs',blk.pcs[0].toString(16),'n',blk.n,'loopLen',blk.loopLen);console.log(blk.src);}process.exit(2);}};
  b.cpu.jitCheck=(blk,k)=>{ if(k<0){const d=b.cpu.cycles-a.cpu.cycles;if(d>0)a.cpu.run(d);cmp('before block',null);} else {const d=b.cpu.cycles-a.cpu.cycles;a.cpu.run(d);cmp('after block',blk);} };
  while(ran<total+slice){const nb=b.machine.run(slice);ran+=nb;if(!nb)break;}
  console.log('no mismatch found in replay');process.exit(0);
}
while(ran<total){
  const na=a.machine.run(slice),nb=b.machine.run(slice);ran+=na;
  if(na!==nb||sig(a)!==sig(b)){
    if(!process.env.NOBISECT&&!process.env._BIS){const r=require('child_process').spawnSync(process.execPath,[__filename,String(ran-slice),String(slice),hot===undefined?'':String(hot),String(ran-slice)],{env:{...process.env,_BIS:'1'},cwd:process.cwd(),encoding:'utf8'});console.log(r.stdout);process.exit(1);}
    console.log('DIVERGE after',ran,'instructions (slice',slice+')','ran',na,nb);
    console.log(' interp',sig(a));console.log(' jit   ',sig(b));
    process.exit(1);
  }
  if(na===0)break;
}
console.log('no divergence in',ran,'instructions; jit stats',JSON.stringify(b.cpu.jitStats));
