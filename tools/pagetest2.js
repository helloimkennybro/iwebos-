const {chromium}=require('playwright');
(async()=>{
  const b=await chromium.launch();const pg=await b.newPage({viewport:{width:390,height:844}});
  const errs=[];pg.on('pageerror',e=>errs.push(e.message));
  await pg.goto('file://'+require('path').join(__dirname,'..','dist','iwebos.html'));
  console.log('before file:',await pg.textContent('#setupMsg'),'| start enabled',await pg.isEnabled('#start'));
  await pg.click('#start');console.log('click w/o file:',await pg.textContent('#setupMsg'));
  await pg.setInputFiles('#file',(process.env.IPSW||'fw/ipad.ipsw'));
  console.log('file label:',await pg.textContent('#fileInfo'));console.log('hint:',await pg.textContent('#setupMsg'));
  await pg.locator('#start').scrollIntoViewIfNeeded();await pg.screenshot({path:'/tmp/phone_start.png'});
  console.log('start visible',await pg.isVisible('#start'),'overflowX',await pg.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
  await pg.click('#start');await pg.waitForTimeout(15000);
  console.log('status',await pg.textContent('#status'),'| setup hidden',await pg.isHidden('#setup'),'| restart visible',await pg.isVisible('#restart'));
  await pg.click('#restart');console.log('after restart: setup visible',await pg.isVisible('#setup'),'| start enabled',await pg.isEnabled('#start'),'|',await pg.textContent('#setupMsg'));
  console.log('errors',errs);await b.close();
})();
