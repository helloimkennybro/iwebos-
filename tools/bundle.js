// Builds dist/iwebos.html: module registry + worker source + UI, all inline.
const fs=require('fs');
const mods=['decode','disasm','mem','vfp','jit','wasmjit','cpu','hle','soc','macho','boot','img3','logo','aes','zip','loader','emu'];
let reg='const __defs={};const __cache={};\nfunction require(p){const k=p.replace(/^.*\\//,"");if(!__cache[k]){const m={exports:{}};__cache[k]=m;__defs[k](m,m.exports,require);}return __cache[k].exports;}\n';
for(const m of mods)reg+='__defs["'+m+'.js"]=function(module,exports,require){\n'+fs.readFileSync('src/'+m+'.js','utf8')+'\n};\n';
const worker=fs.readFileSync('src/worker.js','utf8');
let ui=fs.readFileSync('ui/index.html','utf8');
const esc=s=>s.replace(/<\/script/gi,'<\\/script');
const dsrc=fs.readFileSync('tools/decrypt.js','utf8');const K={};for(const m of dsrc.matchAll(/'([^']+)':\['([0-9a-f]+)','([0-9a-f]+)'\]/g))K[m[1]]={iv:m[2],key:m[3]};
const DEF={};const al=Object.keys(K).find(n=>/applelogo/i.test(n));if(al){DEF.a_iv=K[al].iv;DEF.a_key=K[al].key;}const kk=K['kernelcache.release.k48'],dd=K['Firmware/all_flash/all_flash.k48ap.production/DeviceTree.k48ap.img3'],rr=K['018-7226-009.dmg'];
Object.assign(DEF,{k_iv:kk.iv,k_key:kk.key,d_iv:dd.iv,d_key:dd.key,r_iv:rr.iv,r_key:rr.key});
ui=ui.replace('/*@@KEYS@@*/',()=>JSON.stringify(DEF));
ui=ui.replace('/*@@REGISTRY@@*/',()=>esc(reg)).replace('/*@@WORKER@@*/',()=>esc(worker));
fs.writeFileSync('dist/iwebos.html',ui);
console.log('dist/iwebos.html',(ui.length/1024).toFixed(0)+' KB');
