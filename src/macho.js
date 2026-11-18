'use strict';
function parseMacho(b){
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const magic=dv.getUint32(0,true); if(magic!==0xfeedface) throw new Error('not 32-bit Mach-O '+magic.toString(16));
  const m={cputype:dv.getUint32(4,true),cpusub:dv.getUint32(8,true),filetype:dv.getUint32(12,true),ncmds:dv.getUint32(16,true),segs:[],thread:null,syms:[]};
  let o=28,symoff=0,nsyms=0,stroff=0;
  const str=(p,n)=>{let s='';for(let i=0;i<n&&b[p+i];i++)s+=String.fromCharCode(b[p+i]);return s;};
  for(let i=0;i<m.ncmds;i++){
    const cmd=dv.getUint32(o,true),sz=dv.getUint32(o+4,true);
    if(cmd===1){ const s={name:str(o+8,16),vmaddr:dv.getUint32(o+24,true),vmsize:dv.getUint32(o+28,true),fileoff:dv.getUint32(o+32,true),filesize:dv.getUint32(o+36,true),prot:dv.getUint32(o+44,true),sects:[]};
      const ns=dv.getUint32(o+48,true);
      for(let k=0;k<ns;k++){const p=o+56+k*68;s.sects.push({name:str(p,16),addr:dv.getUint32(p+32,true),size:dv.getUint32(p+36,true),off:dv.getUint32(p+40,true)});}
      m.segs.push(s);}
    else if(cmd===5){ // UNIXTHREAD: flavor, count, regs[16 r0-r12,sp,lr,pc, cpsr]
      const flavor=dv.getUint32(o+8,true),count=dv.getUint32(o+12,true);const regs=[];for(let k=0;k<count;k++)regs.push(dv.getUint32(o+16+k*4,true));m.thread={flavor,regs};}
    else if(cmd===2){symoff=dv.getUint32(o+8,true);nsyms=dv.getUint32(o+12,true);stroff=dv.getUint32(o+16,true);}
    o+=sz;
  }
  for(let i=0;i<nsyms;i++){const p=symoff+i*12;const si=dv.getUint32(p,true);const t=b[p+4];const v=dv.getUint32(p+8,true);
    const n=str(stroff+si,200); if(n) m.syms.push({n,v,t});}
  return m;
}
// Apple DeviceTree: node = nprops, nchildren, props{name[32],len,data(pad4)}, children
function parseDT(b){
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);let o=0;
  function node(){
    const np=dv.getUint32(o,true),nc=dv.getUint32(o+4,true);o+=8;const n={props:{},kids:[]};
    for(let i=0;i<np;i++){let nm='';for(let k=0;k<32&&b[o+k];k++)nm+=String.fromCharCode(b[o+k]);let len=dv.getUint32(o+32,true)&0x7fffffff;o+=36;n.props[nm]=b.subarray(o,o+len);o+=(len+3)&~3;}
    for(let i=0;i<nc;i++)n.kids.push(node());
    return n;}
  return node();
}
function writeDT(root){
  const parts=[];let size=0;
  const u32=v=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,v>>>0,true);return b;};
  const push=b=>{parts.push(b);size+=b.length;};
  (function w(n){
    const keys=Object.keys(n.props);push(u32(keys.length));push(u32(n.kids.length));
    for(const k of keys){const nm=new Uint8Array(32);for(let i=0;i<k.length&&i<31;i++)nm[i]=k.charCodeAt(i);push(nm);
      const v=n.props[k];push(u32(v.length));const pad=new Uint8Array((v.length+3)&~3);pad.set(v);push(pad);}
    for(const c of n.kids)w(c);
  })(root);
  const out=new Uint8Array(size);let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;
}
function findNode(n,name){return n.kids.find(k=>dtStr(k.props.name||new Uint8Array(0))===name);}
const dtStr=v=>{let s='';for(const c of v){if(!c)break;s+=String.fromCharCode(c);}return s;};
module.exports={parseMacho,parseDT,writeDT,findNode,dtStr};
