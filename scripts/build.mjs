import {build} from 'esbuild';
import {readFile,mkdir,writeFile,cp,rm} from 'node:fs/promises';
const assets={};
for(const [name,type] of [['index.html','text/html; charset=utf-8'],['app.js','text/javascript; charset=utf-8'],['styles.css','text/css; charset=utf-8']])assets['/'+name]={type,body:await readFile('web/'+name,'utf8')};
await writeFile('worker/assets.generated.js','export const assets = '+JSON.stringify(assets)+';\n');
await rm('dist',{recursive:true,force:true});await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});
await build({entryPoints:['worker/index.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:false});
await cp('.openai/hosting.json','dist/.openai/hosting.json');await cp('drizzle','dist/drizzle',{recursive:true});
console.log('Built private Worker, embedded UI, and schema migrations.');
