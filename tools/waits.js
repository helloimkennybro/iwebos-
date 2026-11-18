// Who is the kernel waiting on? Taps the scheduler's wait/wakeup entry points and reports, per thread, the last wait that was
// never woken, with a backtrace. usage: node tools/waits.js [instructions]
const fs=require('fs');const {Emulator}=require('../src/emu.js');const W='work/';
const fw={kernel:new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin')),devicetree:new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin')),ramdisk:new Uint8Array(fs.readFileSync(W+'018-7226-009.dmg.bin'))};
const e=new Emulator(fw,{cmdline:process.env.CMD||'-v rd=md0'});const cpu=e.cpu;
const sym=(a)=>(a>>>0).toString(16)+' '+e.symAt(a>>>0);
const rd=(a)=>{try{return cpu.rd32(a>>>0)>>>0;}catch(x){return 0;}};
function bt(){const out=[sym(cpu.R[14]>>>0)];let fp=cpu.R[7]>>>0;for(let i=0;i<12&&fp>=0xc0000000;i++){const lr=rd(fp+4),nfp=rd(fp);if(!lr)break;out.push(sym(lr&~1));if(nfp<=fp)break;fp=nfp;}return out;}
const waits=new Map(),woken=new Map();let wseq=0;
const by=new Map();for(const s of e.info.macho.syms)if(!by.has(s.n))by.set(s.n,s.v>>>0);
const tap=(name,evReg)=>{const a=by.get(name);if(a===undefined)return;cpu.addHLE(a&~1,'tap'+name,(c)=>{const ev=c.R[evReg]>>>0;waits.set(c.tpidrprw>>>0,{name,ev,seq:++wseq,cyc:c.cycles,bt:bt()});return 0;});};
tap('_assert_wait',0);tap('_assert_wait_timeout',0);tap('_assert_wait_deadline',0);tap('_IOLockSleep',1);tap('_IOLockSleepDeadline',1);tap('_lck_mtx_sleep',2);tap('_lck_mtx_sleep_deadline',2);tap('_msleep',0);tap('_tsleep',0);
{const a=by.get('_thread_wakeup_prim');cpu.addHLE(a&~1,'tapwake',(c)=>{woken.set(c.R[0]>>>0,++wseq);return 0;});}
const dump=require('./osdump.js').makeDumper(e);const wanted=new Map(),curWant=new Map();
{const a=by.get('__ZN9IOService22waitForMatchingServiceEP12OSDictionaryy');cpu.addHLE(a&~1,'tapwfms',(c)=>{const d=dump(c.R[0]>>>0,0);wanted.set(d,(wanted.get(d)||0)+1);curWant.set(c.tpidrprw>>>0,d);return 0;});}
const lines=[];e.consoleSink=t=>lines.push(t.trim());
const max=+process.argv[2]||900e6;while(e.ran<max){if(!e.run(5e6))break;}
console.log('waitForMatchingService requests:');for(const [d,n] of wanted)console.log(String(n).padStart(4),d);
console.log('last console:',lines.slice(-2).join(' / '));
const vms=(c)=>(c/40/24000).toFixed(1)+'ms';
for(const [th,w] of [...waits].sort((a,b)=>a[1].seq-b[1].seq)){const ok=(woken.get(w.ev)||0)>w.seq;if(ok)continue;
  if(process.env.SHORT){console.log('STUCK',th.toString(16),w.bt.some(l=>/waitForMatchingService/.test(l))?'waitForService '+curWant.get(th):w.bt.slice(0,4).map(l=>l.split(' ')[1]).join(' < '));continue;}
  console.log('\nthread',th.toString(16),'waits in',w.name,'event',w.ev.toString(16),'since',vms(w.cyc));for(const l of w.bt)console.log('    '+l);}
