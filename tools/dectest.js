// Compare iWebOS decoder/disassembler against LLVM over the kernel's own code.
const fs=require('fs');
const {Inst,decodeARM,decodeThumb,O}=require('../src/decode.js');const {disasm}=require('../src/disasm.js');
const b=fs.readFileSync('work/kernelcache.release.k48.bin');const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
let o=28,sym,n;for(let i=0;i<12;i++){const c=dv.getUint32(o,true),s=dv.getUint32(o+4,true);if(c===2){sym=dv.getUint32(o+8,true);n=dv.getUint32(o+12,true);}o+=s;}
const T0=0xc0001000,T1=0xc023f000;const mode=new Map();
for(let i=0;i<n;i++){const p=sym+i*12;const v=dv.getUint32(p+8,true),d=dv.getUint16(p+6,true);if(v>=T0&&v<T1)mode.set(v,(d&8)?1:0);}
const addrs=[...mode.keys()].sort((a,c)=>a-c);
function modeAt(a){let lo=0,hi=addrs.length-1;while(lo<hi){const m=(lo+hi+1)>>1;if(addrs[m]<=a)lo=m;else hi=m-1;}return mode.get(addrs[lo]);}
const norm=s=>{
  s=s.toLowerCase().replace(/<[^>]*>/g,'').replace(/[@;].*$/,'').replace(/\s+/g,' ').trim();
  s=s.replace(/^(\w+)\.(w|n)\b/,'$1').replace(/#/g,'').replace(/\[\s+/g,'[');
  s=s.replace(/-?0x[0-9a-f]+|-?\b\d+\b/g,m=>{let v=m.startsWith('-')?-parseInt(m.slice(1)):parseInt(m);return String(v>>>0);});
  s=s.replace(/\b(ldm|stm)ia\b/,'$1').replace(/\bip\b/,'r12').replace(/\bcc\b/,'lo').replace(/\bcs\b/,'hs');
  s=s.replace(/^(adr\w*) (\w+), .*$/,'$1 $2').replace(/^(udf\w*).*$/,'$1').replace(/\b(ldm|stm)ia(\w*)\b/,'$1$2').replace(/^(\w+) (r\d+|sp), \2, /,'$1 $2, ').replace(/ ,/g,',').replace(/,(\S)/g,', $1');
  return s;};
const lines=fs.readFileSync('work/k.dis','utf8').split('\n');
const I=new Inst();let ok=0,bad=0,total=0,ign=0;const cat={};const samples={};
let it=[];let inIT=false;
for(const L of lines){
  const m=/^([0-9a-f]{8}):\s+(.*)$/.exec(L);if(!m)continue;
  const a=parseInt(m[1],16);const llv=m[2].trim();if(llv==='...'||llv.startsWith('<unknown>')){continue;}
  const th=modeAt(a);const off=a-T0;
  let mine,len;
  if(!th){decodeARM(dv.getUint32(off,true),I);len=4;mine=disasm(I,a);}
  else{const h1=dv.getUint16(off,true);const h2=(off+2<b.length)?dv.getUint16(off+2,true):0;decodeThumb(h1,h2,I);len=I.len;
    let cond=undefined,iit=false;
    if(it.length){cond=it.shift();iit=true;}
    mine=disasm(I,a,cond,iit);
    if(I.op===O.IT){const fc=I.o1,mk=I.o2;it=[];let t=0,mm=mk;while(!(mm&1)){mm>>=1;t++;}const cnt=4-t;it.push(fc);for(let i=1;i<cnt;i++){const bit=(mk>>(4-i))&1;it.push(bit===(fc&1)?fc:(fc^1));}}
  }
  total++;
  const A=norm(mine),B=norm(llv);if(/^(cdp|ldc|stc|mrc2|mcr2|mrrc2|mcrr2)/.test(B)||/^(cdp|ldc|stc)/.test(A)){ign++;continue;}
  if(A===B)ok++;else{bad++;const k=(B.split(' ')[0])+' | '+(A.split(' ')[0]);cat[k]=(cat[k]||0)+1;if(!samples[k])samples[k]=[(th?'T ':'A ')+a.toString(16)+' w='+(th?dv.getUint16(off,true).toString(16)+' '+dv.getUint16(off+2,true).toString(16):dv.getUint32(off,true).toString(16)),B,A];}
}
console.log('ignored(coproc)',ign);console.log('total',total,'ok',ok,'bad',bad,(100*ok/total).toFixed(2)+'%');
const top=Object.entries(cat).sort((a,b)=>b[1]-a[1]).slice(0,+process.argv[2]||40);
for(const [k,c] of top)console.log(String(c).padStart(7),k,'\n        ',samples[k].join('\n         '));
