// cpu.js inlines opcode numbers as `12/*O.DP*/` so V8 can build jump tables; verify they still match decode.js
const fs=require('fs');const {O}=require('../src/decode.js');
let bad=0,n=0;
for(const f of ['cpu.js','jit.js']){let s;try{s=fs.readFileSync(__dirname+'/../src/'+f,'utf8');}catch(e){continue;}
  for(const m of s.matchAll(/(\d+)\/\*O\.([A-Z0-9_]+)\*\//g)){n++;if(O[m[2]]!==+m[1]){bad++;console.log('MISMATCH',f,m[2],m[1],'!=',O[m[2]]);}}}
console.log(bad?'FAIL':'PASS','opcheck ('+n+' constants)');process.exitCode=bad?1:0;
