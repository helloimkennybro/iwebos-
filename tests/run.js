// Run a flat test binary on the iWebOS CPU. Pass: value 0 written to tohost (0x10000000).
const fs=require('fs');const {Ram,Bus}=require('../src/mem.js');const {CPU}=require('../src/cpu.js');const {disasm}=require('../src/disasm.js');
function runTest(name,opts){
  opts=opts||{};
  const ram=new Ram(0x40000000,64<<20);const bus=new Bus(ram);const cpu=new CPU(ram,bus);
  let result=null;
  bus.map(0x10000000,0x1000,{read:()=>0,write:(o,s,v)=>{result=v;}},'tohost');
  const bin=fs.readFileSync(__dirname+'/'+name+'.bin');ram.writeBytes(0,new Uint8Array(bin));
  cpu.reset(0x40000000);
  const ring=[];if(!opts.jit)cpu.trace=(pc,I,c,it)=>{ring.push([pc,I.thumb?(I.len==4?((I.w<<16)|I.w2)>>>0:I.w):I.w,disasm(I,pc,c,it)]);if(ring.length>24)ring.shift();};
  if(opts.jit){cpu.jitHot=0;cpu.wasmBatch=1;}   // compile every block on first visit so the tests exercise the translator
  if(opts.setup)opts.setup(cpu,ram,bus);
  let ran=0;
  while(result===null&&ran<2e6){const n=cpu.run(opts.slice||10000);ran+=n;if(opts.onSlice)opts.onSlice(cpu,ran);if(n===0)break;}
  if(result===0){console.log('PASS',name+(opts.jit?' [jit: '+cpu.jitStats.blocks+' blocks: '+cpu.jitStats.wasm+' wasm, '+cpu.jitStats.wasmFail+' wasm failures]':''),'('+ran+' instructions)');return true;}
  console.log('FAIL',name,'check id =',result,'after',ran,'instructions');
  for(const r of ring.slice(-14))console.log('   ',r[0].toString(16),r[1].toString(16).padStart(8,'0'),r[2]);
  console.log('   regs',Array.from(cpu.R).map(x=>(x>>>0).toString(16)).join(' '),'cpsr',(cpu.getCPSR()>>>0).toString(16));
  return false;
}
module.exports={runTest};
if(require.main===module){let ok=true;for(const n of process.argv.slice(2))ok=runTest(n)&&ok;process.exit(ok?0:1);}
