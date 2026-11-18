// Node check of the browser loader against the real IPSW: results must be byte-identical to the earlier tools/decrypt.js output.
const fs=require('fs');const {loadFirmware}=require('../src/loader.js');const {jsDecryptCBC,decryptCBC}=require('../src/aes.js');
const src=fs.readFileSync('tools/decrypt.js','utf8');
const K={};for(const m of src.matchAll(/'([^']+)':\['([0-9a-f]+)','([0-9a-f]+)'\]/g))K[m[1]]={iv:m[2],key:m[3]};
const keys={kernel:K['kernelcache.release.k48'],dt:K['Firmware/all_flash/all_flash.k48ap.production/DeviceTree.k48ap.img3'],ram:K['018-7226-009.dmg']};
(async()=>{
  const blob=await fs.openAsBlob((process.env.IPSW||'fw/ipad.ipsw'));
  const t0=Date.now();const fw=await loadFirmware(blob,keys,s=>console.log('  ',s));console.log('loaded in',Date.now()-t0,'ms');
  const same=(a,f)=>{const b=fs.readFileSync('work/'+f);return a.length===b.length&&Buffer.compare(Buffer.from(a),b)===0;};
  console.log('kernel identical',same(fw.kernel,'kernelcache.release.k48.bin'),'dt identical',same(fw.devicetree,'DeviceTree.k48ap.bin'),'ramdisk identical',same(fw.ramdisk,'018-7226-009.dmg.bin'));
  // JS AES fallback must agree with WebCrypto
  const data=new Uint8Array(fs.readFileSync('work/018-7226-009.dmg.bin').subarray(0,4096));const key=Buffer.from(keys.ram.key,'hex'),iv=Buffer.from(keys.ram.iv,'hex');
  const a=await decryptCBC(new Uint8Array(key),new Uint8Array(iv),data),b=await decryptCBC(new Uint8Array(key),new Uint8Array(iv),data,true);
  console.log('webcrypto==js fallback',Buffer.compare(Buffer.from(a),Buffer.from(b))===0);
})();
