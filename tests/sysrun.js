const {runTest}=require('./run.js');
const ack=(cpu,bus)=>bus.map(0x10001000,0x10,{read:()=>0,write:()=>{cpu.irq=false;}},'irqack');
let ok=runTest('sys1',{setup:(cpu,ram,bus)=>{
  ack(cpu,bus);
  let n=0;const old=cpu.trace;cpu.trace=(pc,I,c,it)=>{old(pc,I,c,it);if(++n===20000)cpu.irq=true;};
}});
// same system test through the JIT: compile everything on first visit, raise the interrupt between 5000-instruction slices
let fired=false;
ok=runTest('sys1',{jit:true,slice:5000,setup:(cpu,ram,bus)=>{ack(cpu,bus);},onSlice:(cpu,ran)=>{if(!fired&&ran>=20000){fired=true;cpu.irq=true;}}})&&ok;
process.exit(ok?0:1);
