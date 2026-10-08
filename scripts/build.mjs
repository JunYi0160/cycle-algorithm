import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'dist');mkdirSync(output,{recursive:true});
const sources=['strategy.js','valuation.js','preview.js','model.js','storage.js','app.js'];
const allowed=new Set(['index.html','style.css','icon.png','.nojekyll','templates/valuation-history.csv',...sources.map(s=>'src/'+s)]);
function inventory(dir){return readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?inventory(p):[relative(output,p).replaceAll('\\','/')];});}
for(const file of inventory(output))if(!allowed.has(file))throw new Error(`发布目录有非白名单文件，构建停止：${file}`);
mkdirSync(join(output,'src'),{recursive:true});mkdirSync(join(output,'templates'),{recursive:true});
for(const name of ['index.html','icon.png'])copyFileSync(join(root,'public',name),join(output,name));
writeFileSync(join(output,'style.css'),readFileSync(join(root,'public/style.css'),'utf8')+'\n'+readFileSync(join(root,'public/style-extra.css'),'utf8'));
for(const name of sources)copyFileSync(join(root,'src',name),join(output,'src',name));
copyFileSync(join(root,'public/templates/valuation-history.csv'),join(output,'templates/valuation-history.csv'));
writeFileSync(join(output,'.nojekyll'),'');
for(const file of inventory(output))if(!allowed.has(file))throw new Error(`Unexpected artifact: ${file}`);
for(const file of inventory(output).filter(f=>/\.(html|js|css)$/.test(f))){
  const content=readFileSync(join(output,file),'utf8');
  if(/ibkr|directus/i.test(content))throw new Error(`静态输出包含旧服务依赖：${file}`);
}
console.log(`Built ${inventory(output).length} whitelisted static files in ${output}`);
