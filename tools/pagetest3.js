// Full page run in headless Chromium: load the real IPSW, boot for a while, check speed, JIT and the tracing toggle.
const {chromium}=require('playwright');
(async()=>{
  const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1100,height:900}});
  const errs=[];pg.on('pageerror',e=>errs.push(e.message));pg.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
  await pg.goto('file://'+require('path').join(__dirname,'..','dist','iwebos.html'));
  await pg.setInputFiles('#file',(process.env.IPSW||'fw/ipad.ipsw'));await pg.click('#start');
  await pg.waitForTimeout(+process.argv[2]*1000||30000);
  const snap=async(t)=>console.log(t.padEnd(14),'status:',await pg.textContent('#status'),'| speed',await pg.textContent('#s_mips'),'| instr',await pg.textContent('#s_ran'),'| jit',await pg.textContent('#s_jit'));
  await snap('after boot');
  await pg.click('.tab[data-t=trace]');await pg.selectOption('#tmode','tail');await pg.waitForTimeout(4000);await snap('tracing on');
  const lines=await pg.evaluate(()=>document.querySelector('#log').textContent.split('\n').length);console.log('trace lines visible:',lines);
  await pg.selectOption('#tmode','off');await pg.waitForTimeout(8000);await snap('tracing off');
  await pg.screenshot({path:require('path').join(require('os').tmpdir(),'page3.png')});
  console.log('errors',errs);await b.close();
})();
