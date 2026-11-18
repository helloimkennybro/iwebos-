// JIT-specific behaviour: self-modifying code, loops, MMIO side exits, budget exactness.
const {Ram,Bus}=require('../src/mem.js');const {CPU}=require('../src/cpu.js');
function mk(words){const ram=new Ram(0x40000000,16<<20),bus=new Bus(ram),cpu=new CPU(ram,bus);cpu.jitHot=0;cpu.wasmBatch=1;
  const b=new Uint8Array(words.length*4);words.forEach((w,i)=>{b[i*4]=w&255;b[i*4+1]=(w>>>8)&255;b[i*4+2]=(w>>>16)&255;b[i*4+3]=(w>>>24)&255;});
  ram.writeBytes(0,b);cpu.reset(0x40000000);return {ram,bus,cpu};}
let fails=0;const check=(name,ok,extra)=>{console.log((ok?'PASS':'FAIL'),'jittest',name,ok?'':extra||'');if(!ok)fails++;};
// 1. loop: r2 counts to r3 (add/cmp/bne), exact instruction budget honoured
{const {cpu}=mk([0xe2822001,0xe1520003,0x1afffffc,0xe1a00000]);cpu.R[3]=1000;let ran=0;
 const n=cpu.run(1500);check('loop budget',n===1500&&cpu.cycles===1500,'ran '+n+' cycles '+cpu.cycles);
 const i=mk([0xe2822001,0xe1520003,0x1afffffc,0xe1a00000]);i.cpu.jitEnabled=false;i.cpu.R[3]=1000;i.cpu.run(1500);
 check('loop equals interpreter',Array.from(cpu.R).join()===Array.from(i.cpu.R).join(),Array.from(cpu.R).join()+' vs '+Array.from(i.cpu.R).join());}
// 2. self-modifying code: the loop body is patched by a store from the program itself and from the host
{const {ram,cpu}=mk([0xe2822001,0xe1520003,0x1afffffc,0xe1a00000]);cpu.R[3]=0x7fffffff;cpu.run(300);const before=cpu.R[2];
 // patch 'add r2,r2,#1' into 'add r2,r2,#2' through the CPU store path (as a guest store would)
 cpu.wr32(0x40000000,0xe2822002);cpu.run(300);const after=cpu.R[2]-before;
 check('guest store to code page invalidates',after>=2*99&&after<=2*101,'delta '+after);
 ram.writeBytes(0,new Uint8Array([0x03,0x20,0x82,0xe2]));const b2=cpu.R[2];cpu.fvpn=-1;cpu.run(300);const d3=cpu.R[2]-b2;
 check('host write to code page invalidates',d3>=3*99&&d3<=3*101,'delta '+d3);}
// 3. MMIO store inside a block returns control to the dispatcher so the device can raise an interrupt
{const {bus,cpu}=mk([0xe3a01000|0x10,0xe3a00201,0xe5801000,0xe2822001,0xe1a00000]); // mov r1,#0x10 ; mov r0,#0x10000000 ; str r1,[r0] ; add r2,r2,#1
 let hits=0;bus.map(0x10000000,0x10,{read:()=>0,write:()=>{hits++;}},'dev');
 cpu.run(100);check('mmio write executed once',hits===1,'hits '+hits);}
process.exit(fails?1:0);
