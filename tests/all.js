// Run every test: flat binaries (interpreter traced + JIT), opcode-constant check, JIT-specific tests, system test (last: it exits)
const {runTest}=require('./run.js');const cp=require('child_process');
let ok=true;
for(const n of ['arm1','thumb1']){ok=runTest(n)&&ok;ok=runTest(n,{jit:true})&&ok;}
for(const f of ['opcheck.js','jittest.js'])ok=(cp.spawnSync(process.execPath,[__dirname+'/'+f],{stdio:'inherit'}).status===0)&&ok;
ok=(cp.spawnSync(process.execPath,[__dirname+'/sysrun.js'],{stdio:'inherit'}).status===0)&&ok;
console.log(ok?'ALL PASS':'FAILURES');process.exitCode=ok?0:1;
