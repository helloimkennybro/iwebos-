// Browser boot benchmark: seconds from clicking Boot until the kernel log shows TARGET (headless Chromium, real IPSW).
const {chromium}=require('playwright');
(async()=>{
  const target=process.argv[2]||'AppleBaseband',mode=process.argv[3]||'logo';
  const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1100,height:900}});
  const errs=[];pg.on('pageerror',e=>errs.push(e.message));
  await pg.goto('file://'+require('path').join(__dirname,'..','dist','iwebos.html'));
  await pg.selectOption('#bootmode',mode);
  await pg.setInputFiles('#file',(process.env.IPSW||'fw/ipad.ipsw'));
  const t0=Date.now();await pg.click('#start');
  let tBoot=null,tHit=null;
  for(let i=0;i<600&&!tHit;i++){await pg.waitForTimeout(250);
    const st=await pg.textContent('#status');if(!tBoot&&/Running/.test(st))tBoot=(Date.now()-t0)/1000;
    const log=await pg.evaluate(()=>document.querySelector('#log').textContent);if(log.includes(target))tHit=(Date.now()-t0)/1000;}
  console.log('firmware loaded+decrypted after',tBoot,'s; "'+target+'" after',tHit,'s total ('+(tHit&&tBoot?(tHit-tBoot).toFixed(1):'?')+'s of emulation)');
  console.log('speed',await pg.textContent('#s_mips'),'| jit',await pg.textContent('#s_jit'),'| instr',await pg.textContent('#s_ran'));
  await pg.screenshot({path:require('path').join(require('os').tmpdir(),'pagebench.png')});
  const setupLog=await pg.evaluate(()=>[...document.querySelectorAll('#log div')].slice(0,12).map(d=>d.textContent).join('\n'));console.log(setupLog);
  console.log('errors',errs);await b.close();
})();
