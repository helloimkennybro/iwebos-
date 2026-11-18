'use strict';
// IMG3 container reader + Apple "complzss" decompressor (iWebOS)
function parseImg3(buf){
  if(buf.length<20||buf[0]!==0x33||buf[1]!==0x67||buf[2]!==0x6d||buf[3]!==0x49) throw new Error('not IMG3');
  const dv=new DataView(buf.buffer,buf.byteOffset,buf.byteLength);
  const tags={};let o=20;
  while(o+12<=buf.length){
    const t=String.fromCharCode(buf[o+3],buf[o+2],buf[o+1],buf[o]);
    const tl=dv.getUint32(o+4,true),dl=dv.getUint32(o+8,true);
    if(!tl) break;
    (tags[t]=tags[t]||[]).push(buf.subarray(o+12,o+12+dl));
    o+=tl;
  }
  return {type:tags.TYPE?String.fromCharCode(...tags.TYPE[0].subarray(0,4)).split('').reverse().join(''):'',tags,data:tags.DATA[0]};
}
function lzssDecompress(src,outSize){
  const N=4096,F=18,TH=2,tb=new Uint8Array(N+F-1).fill(0x20),out=new Uint8Array(outSize);
  let r=N-F,flags=0,s=0,d=0;
  while(true){
    if(((flags>>=1)&0x100)===0){ if(s>=src.length)break; flags=src[s++]|0xFF00; }
    if(flags&1){ if(s>=src.length||d>=outSize)break; const c=src[s++]; out[d++]=c; tb[r++]=c; r&=N-1; }
    else{
      if(s+1>=src.length)break; let i=src[s++],j=src[s++]; i|=(j&0xF0)<<4; j=(j&0x0F)+TH;
      for(let k=0;k<=j;k++){ const c=tb[(i+k)&(N-1)]; if(d<outSize)out[d++]=c; tb[r++]=c; r&=N-1; }
    }
  }
  return out.subarray(0,d);
}
function unwrapComplzss(b){
  const dv=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const m=String.fromCharCode(...b.subarray(0,8));
  if(m!=='complzss') return b;
  const usize=dv.getUint32(12),csize=dv.getUint32(16);
  return lzssDecompress(b.subarray(0x180,0x180+csize),usize);
}
module.exports={parseImg3,lzssDecompress,unwrapComplzss};
