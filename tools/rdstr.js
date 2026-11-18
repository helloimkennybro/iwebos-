const fs=require('fs');const {parseMacho}=require('../src/macho.js');
const k=new Uint8Array(fs.readFileSync('work/kernelcache.release.k48.bin'));const m=parseMacho(k);
const rd=(va)=>{for(const s of m.segs){if(va>=s.vmaddr&&va<s.vmaddr+s.filesize)return k[s.fileoff+va-s.vmaddr];}return 0;};
const w=a=>(rd(a)|rd(a+1)<<8|rd(a+2)<<16|rd(a+3)<<24)>>>0;
const str=a=>{let o='';for(let i=0;i<80;i++){const c=rd(a+i);if(!c)break;o+=String.fromCharCode(c);}return o;};
for(const a of process.argv.slice(2)){const v=parseInt(a,16);const p=w(v);console.log(a,'->',p.toString(16),JSON.stringify(str(p)));}
