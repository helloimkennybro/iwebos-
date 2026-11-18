'use strict';
const fs=require('fs'),crypto=require('crypto'),{execFileSync}=require('child_process');
const {parseImg3,unwrapComplzss}=require('../src/img3.js');
const IPSW=(process.env.IPSW||'fw/ipad.ipsw'),OUT=require('path').join(__dirname,'..','work');
const K={
 'kernelcache.release.k48':['0ce08a45b54f54bb99f12e582122b992','8c80ca1a1fb8a1f87b6dfa34d186fd235118025029c0aa8df6a70bd33987c146'],
 'Firmware/all_flash/all_flash.k48ap.production/DeviceTree.k48ap.img3':['0e3fdb2cd018eaab38b427b34cbf556d','2b5a61188dd993997da958d56b08ae55aea4362a5d29fceb627de91150199d75'],
 '018-7226-009.dmg':['9c051576ddd94f48c324cf7ac3197fe1','31e7ecd9c364414205a8fa0092cc80c0d67eae40e75ffa27b37048c42335a106'],
 'Firmware/all_flash/all_flash.k48ap.production/applelogo.s5l8930x.img3':['e839ae241b3c2010a13c2031973f7310','f6a6c39e8ea1c2bf9d2bd4eef2e7ef4d0d0611d86a6d8511c625b58042e8e31e'],
};
const py=`import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile('${IPSW}').read(sys.argv[1]))`;
for(const [name,[iv,key]] of Object.entries(K)){
  const raw=execFileSync('python3',['-I','-c',py,name],{maxBuffer:1<<30});
  const img=parseImg3(new Uint8Array(raw));
  const n=img.data.length&~15;
  const dec=crypto.createDecipheriv('aes-256-cbc',Buffer.from(key,'hex'),Buffer.from(iv,'hex'));dec.setAutoPadding(false);
  let out=new Uint8Array(Buffer.concat([dec.update(img.data.subarray(0,n)),dec.final(),Buffer.from(img.data.subarray(n))]));
  const head=Buffer.from(out.subarray(0,8)).toString('latin1');
  console.log(name.split('/').pop(),'type',img.type,'payload',img.data.length,'-> head',JSON.stringify(head.replace(/[^\x20-\x7e]/g,'.')));
  const out2=unwrapComplzss(out);
  if(out2!==out) console.log('  complzss ->',out2.length);
  fs.writeFileSync(OUT+'/'+name.split('/').pop().replace(/\.img3$/,'')+'.bin',out2);
}
