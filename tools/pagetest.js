const {chromium}=require('playwright');const fs=require('fs');
const src=fs.readFileSync('tools/decrypt.js','utf8');const K={};for(const m of src.matchAll(/'([^']+)':\['([0-9a-f]+)','([0-9a-f]+)'\]/g))K[m[1]]={iv:m[2],key:m[3]};
const kk=K['kernelcache.release.k48'],dd=K['Firmware/all_flash/all_flash.k48ap.production/DeviceTree.k48ap.img3'],rr=K['018-7226-009.dmg'];
(async()=>{
  const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1280,height:900}});
  const errs=[];pg.on('pageerror',e=>errs.push('pageerror '+e.message));pg.on('console',m=>{if(m.type()==='error')errs.push('console '+m.text());});
  await pg.goto('file://'+require('path').join(__dirname,'..','dist','iwebos.html'));
  await pg.setInputFiles('#file',(process.env.IPSW||'fw/ipad.ipsw'));
  // paste in the wiki-ish format to exercise the parser
  await pg.fill('#paste',`Kernelcache  IV: ${kk.iv}  Key: ${kk.key}\nDeviceTree IV ${dd.iv} Key ${dd.key}\n018-7226-009 IV ${rr.iv} Key ${rr.key}`);
  console.log('keys filled',await pg.inputValue('#k_iv')===kk.iv,await pg.inputValue('#d_key')===dd.key,await pg.inputValue('#r_iv')===rr.iv);
  console.log('start enabled',await pg.isEnabled('#start'));
  await pg.click('#start');
  const wait=+process.argv[2]||60;
  for(let i=0;i<wait/5;i++){await pg.waitForTimeout(5000);console.log(await pg.textContent('#status'),'|',await pg.textContent('#s_mips'),await pg.textContent('#s_ran'),await pg.textContent('#s_vms'));}
  console.log('setup msg:',await pg.textContent('#setupMsg'));
  await pg.screenshot({path:'/tmp/page1.png'});
  await pg.click('[data-t=events]');await pg.waitForTimeout(500);console.log('events tail:',(await pg.textContent('#log')).slice(-300));
  console.log('errors',errs);
  await b.close();
})();
