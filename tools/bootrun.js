// Boot the decrypted iOS 3.2 kernel on the iWebOS CPU and report how far it gets.
const fs=require('fs');
const {Ram,Bus}=require('../src/mem.js');const {CPU}=require('../src/cpu.js');const {disasm}=require('../src/disasm.js');
const {parseDT,dtStr,findNode}=require('../src/macho.js');const {bootImage,PHYS,VIRT}=require('../src/boot.js');const {LogDev,IO,Machine,attachDevices}=require('../src/soc.js');
const budget=+process.argv[2]||5e6;
const W='work/';const kernel=new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin'));
const dt=new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin'));
const rd=process.env.NORD?null:new Uint8Array(fs.readFileSync(W+'018-7226-009.dmg.bin'));
const ram=new Ram(PHYS,256<<20),bus=new Bus(ram),cpu=new CPU(ram,bus);if(process.env.NOJIT)cpu.jitEnabled=false;if(process.env.JITHOT)cpu.jitHot=+process.env.JITHOT;
const out=[];const log=s=>{out.push(s);if(process.env.LIVE)console.log(s);};
bus.log=log;bus.cpu=cpu;cpu.log=log;
const info=bootImage(ram,{kernel,devicetree:dt,ramdisk:rd},{cmdline:process.env.CMD||'-v rd=md0'});
// symbols
const syms=info.macho.syms.filter(s=>s.v>=0xc0001000&&s.v<0xc0930000).sort((a,b)=>a.v-b.v);
const symAt=a=>{a=a>>>0;const v=a>=PHYS&&a<PHYS+0x10000000?a-PHYS+VIRT:a;let lo=0,hi=syms.length-1;if(!syms.length||v<syms[0].v)return '?';while(lo<hi){const m=(lo+hi+1)>>1;if(syms[m].v<=v)lo=m;else hi=m-1;}return syms[lo].n+(v-syms[lo].v?'+0x'+(v-syms[lo].v).toString(16):'');};
const root=parseDT(dt);let serial='';const devs=attachDevices(bus,cpu,root,log,{findNode,dtStr},(c,n)=>{serial+=String.fromCharCode(c);if(process.env.SERIALLIVE)process.stdout.write(String.fromCharCode(c));});const machine=new Machine(cpu,devs);
if(!process.env.NOIDLE&&ram.r32(0xc0063360-VIRT)===0xee1d2f90)cpu.idlePC=0xc0063360;   // idle routine called by machine_idle (verified by its first instruction)
const bsym=process.env.BREAK;if(bsym){const t=syms.find(x=>x.n===bsym);if(t){cpu.breakAt=t.v&~1;console.log('break at',bsym,t.v.toString(16));}}
cpu.reset(info.entry);cpu.R[0]=info.bootArgs;
console.log('entry',info.entry.toString(16),'bootargs',info.bootArgs.toString(16),'dt',info.dt.toString(16),'len',info.dtLen,'top',info.top.toString(16));
const ring=[];let snap=null;const SN=+process.env.SNAP||60;const lo=process.env.SNAPLO?parseInt(process.env.SNAPLO,16):0xc0014aec,hi=process.env.SNAPHI?parseInt(process.env.SNAPHI,16):0xc0014c20;
const callAddrs=new Map();for(const n of (process.env.CALLS||'').split(',').filter(Boolean)){const t=syms.find(x=>x.n===n||x.n==='_'+n);if(t)callAddrs.set((t.v&~1)>>>0,t.n);else console.log('no symbol',n);}
const cstr=a=>{try{let o='';for(let i=0;i<80;i++){const c=cpu.rd8((a+i)>>>0);if(c===0)break;if(c<32||c>126)return null;o+=String.fromCharCode(c);}return o.length>=2?o:null;}catch(e){return null;}};
const objStrings=(a0)=>{const seen=new Set(),out=[];const q=[[a0>>>0,0]];while(q.length&&seen.size<200){const [a,d]=q.shift();if(seen.has(a)||a<0xc0000000&&!(a>=0xe0000000)||d>4)continue;seen.add(a);
  for(let k=0;k<12;k++){let w;try{w=cpu.rd32((a+k*4)>>>0)>>>0;}catch(e){break;}const c=cstr(w);if(c&&w>=0xc0000000)out.push(c);else if(w>=0xc0000000&&w<0xf0000000&&d<4)q.push([w,d+1]);}}return [...new Set(out)].slice(0,16);};
let callCount=0;const CALLMAX=+process.env.CALLMAX||300;
const watch=(process.env.WATCH||'').split(',').filter(Boolean).map(x=>parseInt(x,16));
if(process.env.TRACE||process.env.WATCH||process.env.SNAPLO||callAddrs.size)cpu.trace=(pc,I,c,it)=>{if(callAddrs.size&&callAddrs.has(pc)){if(callCount++<CALLMAX){const R=cpu.R;if(/waitFor|lookUp/.test(callAddrs.get(pc)))console.log("  DICT",JSON.stringify(objStrings(/lookUp/.test(callAddrs.get(pc))?R[1]>>>0:R[0]>>>0)));console.log('CALL',callAddrs.get(pc),'vms',(cpu.cycles/40/24000).toFixed(1),'r0-2',[R[0],R[1],R[2]].map(x=>(x>>>0).toString(16)).join(' '),'lr',symAt(R[14]>>>0),'chain',(()=>{let fp=R[7]>>>0;const ch=[];for(let i=0;i<7&&fp>0xc0000000;i++){try{ch.push(symAt(cpu.rd32((fp+4)>>>0)>>>0));fp=cpu.rd32(fp)>>>0;}catch(e){break;}}return ch.join('<');})());}if(!process.env.TRACE&&!process.env.WATCH&&!process.env.SNAPLO)return;}if(process.env.HIST&&ran>=+process.env.HIST){const f=symAt(pc).replace(/\+0x.*/,'');hist.set(f,(hist.get(f)||0)+1);}if(watch.length&&watch.includes(pc)){const R=cpu.R;console.log('WATCH',pc.toString(16),symAt(pc),'r0-3',[R[0],R[1],R[2],R[3]].map(x=>(x>>>0).toString(16)).join(' '),'sp0',(cpu.rd32(R[13]>>>0)>>>0).toString(16),'lr',symAt(R[14]>>>0));}ring.push([pc,I.thumb?(I.len==4?((I.w<<16)|I.w2)>>>0:I.w):I.w,disasm(I,pc,c,it),cpu.R[0]>>>0,cpu.R[1]>>>0,cpu.R[14]>>>0]);if(ring.length>400)ring.shift();if(!snap&&pc>=lo&&pc<hi)snap=ring.slice(-SN);};
let abDumped=false;
cpu.abortHook=(a,pc)=>{if(abDumped||!process.env.ABDUMP)return;abDumped=true;const va=a.va>>>0;const tb=(cpu.ttbr0>>>14<<14)>>>0;
  const l1=ram.r32((tb-PHYS+(va>>>20)*4)>>>0);console.log('ABDUMP va',va.toString(16),'ttbr0',cpu.ttbr0.toString(16),'ttbr1',cpu.ttbr1.toString(16),'ttbcr',cpu.ttbcr,'L1',l1.toString(16),'dacr',cpu.dacr.toString(16));
  if((l1&3)===1){const l2b=(l1&0xFFFFFC00)>>>0;const idx=(va>>>12)&255;const l2=ram.r32((l2b-PHYS+idx*4)>>>0);console.log(' L2 table',l2b.toString(16),'entry',l2.toString(16));}
  for(let j=0;j<8;j++)console.log('  L2['+j+']='+ram.r32((0x4095d000-PHYS+j*4)>>>0).toString(16));for(let k=-2;k<=2;k++){const e=ram.r32((tb-PHYS+((va>>>20)+k)*4)>>>0);console.log('  L1['+((va>>>20)+k).toString(16)+']='+e.toString(16));}};
const hist=new Map();let histOn=false;
const oldTrace=()=>{};
let ran=0,lastpc=-1,same=0,t0=Date.now();
const seenFn=new Set();
const histTrace=(pc)=>{const f=process.env.HISTADDR?((pc>>>0)&~0x3f).toString(16):symAt(pc).replace(/\+0x.*/,'');hist.set(f,(hist.get(f)||0)+1);};
while(ran<budget){if(process.env.HIST&&!process.env.TRACE&&ran>=+process.env.HIST&&!cpu.trace)cpu.trace=histTrace;const n=machine.run(Math.min(20000,budget-ran));ran+=n;if(process.env.SWEEP&&ran%+process.env.SWEEP<20000){ram.sweep();cpu.fvpn=-1;}if(n===0)break;if(process.env.PROGRESS&&ran%+process.env.PROGRESS<20000){console.log('[progress]',ran/1e6+'M','pc',(cpu.R[15]>>>0).toString(16),'irq',cpu.stats.irq,'serial',serial.length);}
  if(cpu.R[15]===lastpc){if(++same>3)break;}else same=0;lastpc=cpu.R[15];
  if(cpu.hitBreak)break;if(cpu.mode===0x17&&cpu.stats.dabt+cpu.stats.pabt>50)break;}
if(cpu.hitBreak){const r=cpu.R;const rs=a=>{try{let o='';for(let i=0;i<300;i++){const c=cpu.rd8((a+i)>>>0);if(!c)break;o+=String.fromCharCode(c);}return o;}catch(e){return '<unreadable>';}};
  console.log('BREAK pc',(cpu.R[15]>>>0).toString(16),'lr',symAt(r[14]>>>0),'msg:',JSON.stringify(rs(r[0]>>>0)),'r1',(r[1]>>>0).toString(16),'r2',(r[2]>>>0).toString(16),'r3',(r[3]>>>0).toString(16));
  let fp=r[7]>>>0;const chain=[];for(let i=0;i<10&&fp>0xc0000000;i++){try{chain.push(symAt(cpu.rd32(fp+4)>>>0));fp=cpu.rd32(fp)>>>0;}catch(e){break;}}console.log('call chain (r7 frames):',chain.join(' <- '));
  console.log('dfsr',cpu.dfsr.toString(16),'dfar',(cpu.dfar>>>0).toString(16),'ifsr',cpu.ifsr.toString(16),'ifar',(cpu.ifar>>>0).toString(16));}
{const all=[];for(const d of bus.devs)if(d.dev.hits)for(const [k,v] of d.dev.hits)all.push([v,d.name+' '+k]);all.sort((a,b)=>b[0]-a[0]);console.log('--- MMIO hit counts (top 12) ---');for(const [v,k] of all.slice(0,12))console.log('  ',String(v).padStart(8),k);}
const dt_=(Date.now()-t0)/1000;
console.log('ran',ran,'instructions in',dt_.toFixed(1)+'s ('+(ran/dt_/1e6).toFixed(1)+' MIPS)','cycles',cpu.cycles);
console.log('jit',JSON.stringify(cpu.jitStats));if(cpu.pt)console.log('sampled fn time ms est',Number(cpu.pt)/1e6*64,'samples',cpu.pn);console.log('idle skips',machine.idleSkips||0,'virtual ms',(cpu.cycles/40/24000).toFixed(0));console.log('stats',JSON.stringify(cpu.stats),'mode',cpu.mode.toString(16),'mmu',cpu.sctlr&1);
if(snap){console.log('--- first entry into panic range; preceding instructions ---');for(const r of snap)console.log('  ',r[0].toString(16).padStart(8,'0'),symAt(r[0]).padEnd(30),r[1].toString(16).padStart(8,'0'),r[2].padEnd(34),'r0='+r[3].toString(16),'lr='+symAt(r[5]));}
if(process.env.HIST){console.log('--- hot functions since',process.env.HIST);for(const [k,v] of [...hist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12))console.log('  ',String(v).padStart(8),k);}
{let fp=cpu.R[7]>>>0;const ch=[(cpu.R[14]>>>0).toString(16)];for(let i=0;i<12&&fp>0xc0000000;i++){try{ch.push((cpu.rd32((fp+4)>>>0)>>>0).toString(16));fp=cpu.rd32(fp)>>>0;}catch(e){break;}}console.log('chain (r7):',ch.join(' <- '));}
console.log('last instructions:');for(const r of ring.slice(-3))console.log('  ',r[0].toString(16).padStart(8,'0'),symAt(r[0]).padEnd(34),r[1].toString(16).padStart(8,'0'),r[2]);
console.log('regs',Array.from(cpu.R).map(x=>(x>>>0).toString(16)).join(' '),'cpsr',(cpu.getCPSR()>>>0).toString(16));
console.log('--- log ('+out.length+' lines, filtered) ---');console.log(out.filter(l=>!/^\[gpio\] R32/.test(l)).slice(0,+process.env.LOGN||80).join('\n'));
console.log('--- serial ('+serial.length+' chars) ---');console.log(serial.slice(-3000));
console.log('ram',JSON.stringify(ram.stats()));
{ // framebuffer check
  const FB=0x4E000000-PHYS, W=768,H=1024;let nz=0,minY=1e9,maxY=-1;const row=W*4;
  for(let y=0;y<H;y++){const b=ram.readBytes(FB+y*row,row);let any=false;for(let i=0;i<row;i+=4)if(b[i]|b[i+1]|b[i+2]){any=true;nz++;}if(any){if(y<minY)minY=y;if(y>maxY)maxY=y;}}
  console.log('framebuffer non-black pixels',nz,'rows',minY,'..',maxY);
  if(process.env.FBDUMP){const out=Buffer.alloc(18+W*H*3);out[2]=2;out.writeUInt16LE(W,12);out.writeUInt16LE(H,14);out[16]=24;out[17]=0x20;let o=18;for(let y=0;y<H;y++){const b=ram.readBytes(FB+y*row,row);for(let x=0;x<W;x++){out[o++]=b[x*4];out[o++]=b[x*4+1];out[o++]=b[x*4+2];}}require('fs').writeFileSync(process.env.FBDUMP,out);}
}
