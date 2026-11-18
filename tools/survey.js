const fs=require('fs');const {parseMacho,parseDT,dtStr}=require('../src/macho.js');
const k=new Uint8Array(fs.readFileSync('work/kernelcache.release.k48.bin'));
const m=parseMacho(k);
console.log('cpu',m.cputype,'sub',m.cpusub,'type',m.filetype,'cmds',m.ncmds);
for(const s of m.segs)console.log(' seg',s.name.padEnd(18),'va',s.vmaddr.toString(16).padStart(8,'0'),'sz',s.vmsize.toString(16).padStart(8),'foff',s.fileoff.toString(16).padStart(8),'fsz',s.filesize.toString(16).padStart(8),'prot',s.prot);
if(m.thread)console.log('UNIXTHREAD flavor',m.thread.flavor,'pc=0x'+m.thread.regs[15].toString(16),'sp=0x'+m.thread.regs[13].toString(16),'cpsr=0x'+m.thread.regs[16].toString(16));
console.log('symbols',m.syms.length);
const want=['_start','_kernel_bootstrap','_arm_init','_arm_vm_init','_machine_startup','_PE_init_platform','_PE_state','_PE_parse_boot_argn'];
for(const w of want){const s=m.syms.find(x=>x.n===w);console.log(' ',w,s?'0x'+s.v.toString(16):'-');}
const d=new Uint8Array(fs.readFileSync('work/DeviceTree.k48ap.bin'));
const root=parseDT(d);
function show(n,ind){const nm=n.props.name?dtStr(n.props.name):'?';
 const extra=['compatible','device_type','model','AAPL,phandle'].filter(p=>n.props[p]).map(p=>p+'='+JSON.stringify(dtStr(n.props[p]))).join(' ');
 const reg=n.props.reg&&n.props.reg.length>=8?' reg='+Array.from(new Uint32Array(n.props.reg.buffer.slice(n.props.reg.byteOffset,n.props.reg.byteOffset+n.props.reg.length&~3))).map(x=>'0x'+x.toString(16)).join(','):'';
 console.log(ind+nm+(extra?'  '+extra:'')+reg); if(ind.length<6)for(const c of n.kids)show(c,ind+'  ');}
show(root,'');
