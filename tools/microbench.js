// Micro-benchmark of the CPU core on tiny hand-assembled loops (MMU off). usage: node tools/microbench.js [iterations]
const {Ram,Bus}=require('../src/mem.js');const {CPU}=require('../src/cpu.js');
const N=+process.argv[2]||20000000;
function run(name,words,setup,jit){
  const ram=new Ram(0x40000000,16<<20),bus=new Bus(ram),cpu=new CPU(ram,bus);cpu.jitEnabled=!!jit;if(jit==='js')cpu.jitBackend='js';
  const b=new Uint8Array(words.length*4);new DataView(b.buffer);words.forEach((w,i)=>{b[i*4]=w&255;b[i*4+1]=(w>>>8)&255;b[i*4+2]=(w>>>16)&255;b[i*4+3]=(w>>>24)&255;});
  ram.writeBytes(0,b);cpu.reset(0x40000000);setup(cpu);
  const t0=process.hrtime.bigint();let ran=0;while(ran<N*0+1e9){const n=cpu.run(20000);ran+=n;if(cpu.R[15]>>>0>=0x40000000+words.length*4)break;if(n===0)break;}
  const dt=Number(process.hrtime.bigint()-t0)/1e9;console.log(name.padEnd(28),(jit?String(jit).padEnd(6):'interp'),(ran/dt/1e6).toFixed(1).padStart(7),'MIPS',(ran/1e6).toFixed(0)+'M instr');
}
// loop A: add r2,r2,#1 ; cmp r2,r3 ; bne  (3 instr/iter)
const A=[0xe2822001,0xe1520003,0x1afffffc,0xe1a00000];
// loop B: str r1,[r0] ; add r2,r2,#1 ; cmp r2,r3 ; bne (4 instr/iter, one store)
const B=[0xe5801000,0xe2822001,0xe1520003,0x1afffffb,0xe1a00000];
// loop C: ldr r4,[r0] ; add r5,r5,r4 ; add r2,r2,#1 ; cmp r2,r3 ; bne
const C=[0xe5904000,0xe0855004,0xe2822001,0xe1520003,0x1afffffa,0xe1a00000];
for(const jit of [false,'js','wasm']){
  const set=cpu=>{cpu.R[3]=N/3|0;cpu.R[0]=0x40010000|0;};
  run('A add/cmp/bne',A,set,jit);
  run('B str+add/cmp/bne',B,cpu=>{cpu.R[3]=N/4|0;cpu.R[0]=0x40010000|0;cpu.R[1]=7;},jit);
  run('C ldr+add+add/cmp/bne',C,cpu=>{cpu.R[3]=N/5|0;cpu.R[0]=0x40010000|0;},jit);
}

// Dispatch benchmark: a ring of NB tiny blocks (3 instructions each, always-taken conditional branch to the next one)
function ring(NB,jit){
  const words=new Array(NB*3);const P=i=>(i*1009)%NB; // blocks scattered: block i lives at slot P(i) and jumps to block i+1
  for(let i=0;i<NB;i++){const at=P(i)*3,tgt=P((i+1)%NB)*3,here=at+2;words[at]=0xe2822001;words[at+1]=0xe1500000;words[at+2]=0x0a000000|(((tgt-(here+2))&0xFFFFFF));}
  words.push(0xe1a00000);
  const ram=new Ram(0x40000000,16<<20),bus=new Bus(ram),cpu=new CPU(ram,bus);cpu.jitEnabled=!!jit;if(jit==='js')cpu.jitBackend='js';
  const b=new Uint8Array(words.length*4);words.forEach((w,i)=>{b[i*4]=w&255;b[i*4+1]=(w>>>8)&255;b[i*4+2]=(w>>>16)&255;b[i*4+3]=(w>>>24)&255;});
  ram.writeBytes(0,b);cpu.reset(0x40000000);
  const t0=process.hrtime.bigint();let ran=0;while(ran<N){ran+=cpu.run(20000);}
  const dt=Number(process.hrtime.bigint()-t0)/1e9;console.log(('ring of '+NB+' blocks').padEnd(28),(jit?String(jit).padEnd(6):'interp'),(ran/dt/1e6).toFixed(1).padStart(7),'MIPS',jit?JSON.stringify(cpu.jitStats):'');
}
for(const nb of [8,200,3000])for(const jit of [false,'js','wasm'])ring(nb,jit);
