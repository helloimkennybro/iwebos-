// usage: node tools/dis.js <hexaddr> <count> [arm]  -- disassemble kernel text from decrypted kernel
const fs=require('fs');const {parseMacho}=require('../src/macho.js');const D=require('../src/decode.js');const {disasm}=require('../src/disasm.js');
const k=new Uint8Array(fs.readFileSync('work/kernelcache.release.k48.bin'));const m=parseMacho(k);
const rd=(va)=>{for(const s of m.segs){if(va>=s.vmaddr&&va<s.vmaddr+s.filesize)return k[s.fileoff+va-s.vmaddr];}return 0;};
let pc=parseInt(process.argv[2],16),n=+process.argv[3]||40;const arm=process.argv[4]==='arm';
const syms=m.syms.sort((a,b)=>a.v-b.v);
for(let i=0;i<n;i++){const I=new D.Inst();let len;
  if(arm){const w=(rd(pc)|rd(pc+1)<<8|rd(pc+2)<<16|rd(pc+3)<<24)>>>0;D.decodeARM(w,I);len=4;console.log(pc.toString(16),w.toString(16).padStart(8,'0'),disasm(I,pc,I.cond,false));}
  else{const h1=rd(pc)|rd(pc+1)<<8,h2=rd(pc+2)|rd(pc+3)<<8;D.decodeThumb(h1,h2,I);len=I.len||2;console.log(pc.toString(16),h1.toString(16).padStart(4,'0'),disasm(I,pc,I.cond,false));}
  pc+=len;}
