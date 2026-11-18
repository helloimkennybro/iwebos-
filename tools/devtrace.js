// Record every access to devices whose name matches a regex. usage: node tools/devtrace.js <regex> [maxInstr] [tail]
const fs=require('fs');const {Emulator}=require('../src/emu.js');const W='work/';
const fw={kernel:new Uint8Array(fs.readFileSync(W+'kernelcache.release.k48.bin')),devicetree:new Uint8Array(fs.readFileSync(W+'DeviceTree.k48ap.bin')),ramdisk:new Uint8Array(fs.readFileSync(W+'018-7226-009.dmg.bin'))};
const re=new RegExp(process.argv[2]||'i2c0'),max=+process.argv[3]||450e6,tail=+process.argv[4]||200;
const e=new Emulator(fw,{cmdline:process.env.CMD||'-v rd=md0'});e.cpu.jitEnabled=!!process.env.JIT;
const rec=[];let total=0;
for(const d of e.bus.devs){if(!re.test(d.name))continue;const dev=d.dev,nm=d.name;const r=dev.read.bind(dev),w=dev.write.bind(dev);
  dev.read=(o,s)=>{const v=r(o,s);total++;rec.push(nm+' R +0x'+o.toString(16)+' -> 0x'+(v>>>0).toString(16)+'  lr='+(e.cpu.R[14]>>>0).toString(16)+'  @'+e.cpu.cycles);if(rec.length>50000)rec.splice(0,10000);return v;};
  dev.write=(o,s,v)=>{w(o,s,v);total++;rec.push(nm+' W +0x'+o.toString(16)+' = 0x'+(v>>>0).toString(16)+'  lr='+(e.cpu.R[14]>>>0).toString(16)+'  @'+e.cpu.cycles);if(rec.length>50000)rec.splice(0,10000);};}
e.consoleSink=t=>{rec.push('  | '+t.trim());};
while(e.ran<max){if(!e.run(5e6))break;}
console.log('total accesses',total);console.log(rec.slice(-tail).join('\n'));
