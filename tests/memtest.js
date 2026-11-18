const {Ram,lz4Compress,lz4Decompress,PAGE}=require('../src/mem.js');const fs=require('fs');
const k=fs.readFileSync('work/kernelcache.release.k48.bin');
let tot=0,comp=0,bad=0;const dst=new Uint8Array(PAGE+1024),out=new Uint8Array(PAGE);
for(let o=0;o+PAGE<=k.length;o+=PAGE){const src=new Uint8Array(k.buffer,k.byteOffset+o,PAGE);const n=lz4Compress(src,PAGE,dst);tot+=PAGE;
  if(n<0){comp+=PAGE;continue;}comp+=n;out.fill(0);const m=lz4Decompress(dst.subarray(0,n),out);
  if(m!==PAGE||Buffer.compare(Buffer.from(out),Buffer.from(src))!==0)bad++;}
console.log('lz4 kernel',tot,'->',comp,(100*comp/tot).toFixed(1)+'%','roundtrip failures',bad);
// random + zero + pattern pages
for(const gen of [()=>0,i=>i&255,i=>(i*2654435761>>>24),i=>(i>>4)&255]){const s=new Uint8Array(PAGE);for(let i=0;i<PAGE;i++)s[i]=gen(i);const n=lz4Compress(s,PAGE,dst);if(n>=0){const o2=new Uint8Array(PAGE);lz4Decompress(dst.subarray(0,n),o2);console.log('gen ok',n,Buffer.compare(Buffer.from(o2),Buffer.from(s))===0);}else console.log('incompressible');}
// Ram behaviour
const r=new Ram(0x40000000,256<<20);
for(let i=0;i<100;i++){r.w32(i*PAGE+8,i+1);}
console.log('after writes',JSON.stringify(r.stats()));
r.sweep();console.log('after sweep1 (cooling)',JSON.stringify(r.stats()));
r.sweep();console.log('after sweep2 (evict)',JSON.stringify(r.stats()));
let ok=true;for(let i=0;i<100;i++)if(r.r32(i*PAGE+8)!==i+1)ok=false;console.log('data intact after eviction:',ok,JSON.stringify(r.stats()));

// forced eviction: 16 slots for 256 guest pages, random data must survive being pushed out and brought back
{
  const r2=new Ram(0x40000000,16<<20,{poolBytes:1<<20});let seed=1;const rnd=()=>(seed=(Math.imul(seed,1103515245)+12345)>>>0);
  const ref=new Map();
  for(let k=0;k<20000;k++){const o=(rnd()%(16<<20))&~3;let v;if(k%3===0){v=rnd();r2.w32(o,v);ref.set(o,v>>>0);}else{const e=ref.get(o);if(e!==undefined&&r2.r32(o)!==e){console.log('FAIL forced eviction at',o,r2.r32(o),e);process.exit(1);}}}
  let bad=0;for(const [o,v] of ref)if(r2.r32(o)!==v)bad++;
  console.log(bad?'FAIL':'PASS','forced eviction',JSON.stringify(r2.stats()));if(bad)process.exit(1);
}
