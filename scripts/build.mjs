import {mkdirSync,readFileSync,writeFileSync,copyFileSync,readdirSync,statSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {checkProjectData} from './project-files.mjs';
import {projectFiles} from '../src/project-data.js';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'dist');mkdirSync(output,{recursive:true});
const sources=['strategy.js','valuation.js','preview.js','model.js','storage.js','app.js','bootstrap.js','project-data.js'];
const project=await checkProjectData(join(root,'data'));
const publicFiles=projectFiles(project.data,Object.fromEntries(project.manifest.assets.map(a=>[a.symbol,a.name])));
const templates=['valuation-history.csv','prices.csv','fx-rates.csv'];
// Version the whole module graph, not just app.js: browsers cache every import separately.
const hash=createHash('sha256');
for(const file of ['scripts/build.mjs','public/index.html','public/style.css','public/style-extra.css','public/icon.png',...sources.map(s=>'src/'+s),...project.files.map(p=>'data/'+p),...templates.map(p=>'public/templates/'+p)]){
  hash.update(file);
  const content=readFileSync(join(root,file));
  // Windows checkouts use CRLF while Pages builds use LF; both must share a release.
  hash.update(file.endsWith('.png')?content:content.toString('utf8').replaceAll('\r\n','\n'));
}
const version=hash.digest('hex').slice(0,16);
const allowed=new Set(['index.html','release.json','style.css','icon.png','.nojekyll',...templates.map(p=>'templates/'+p),...sources.map(s=>'src/'+s),...project.files.map(p=>'data/'+p)]);
function inventory(dir){return readdirSync(dir).flatMap(n=>{const p=join(dir,n);return statSync(p).isDirectory()?inventory(p):[relative(output,p).replaceAll('\\','/')];});}
for(const file of inventory(output))if(!allowed.has(file))throw new Error(`发布目录有非白名单文件，构建停止：${file}`);
mkdirSync(join(output,'src'),{recursive:true});mkdirSync(join(output,'templates'),{recursive:true});
copyFileSync(join(root,'public/icon.png'),join(output,'icon.png'));
const html=readFileSync(join(root,'public/index.html'),'utf8')
  .replaceAll('__BUILD_VERSION__',version)
  .replace(/((?:src|href)="\.\/(?:src\/[\w-]+\.js|style\.css|icon\.png))(?:\?[^"\s]*)?"/g,`$1?v=${version}"`);
writeFileSync(join(output,'index.html'),html);
writeFileSync(join(output,'release.json'),JSON.stringify({version})+'\n');
writeFileSync(join(output,'style.css'),readFileSync(join(root,'public/style.css'),'utf8')+'\n'+readFileSync(join(root,'public/style-extra.css'),'utf8'));
for(const name of sources){
  const code=readFileSync(join(root,'src',name),'utf8').replaceAll('__BUILD_VERSION__',version)
    .replace(/(['"])(\.\/[\w-]+\.js)\1/g,`$1$2?v=${version}$1`);
  writeFileSync(join(output,'src',name),code);
}
for(const template of templates)copyFileSync(join(root,'public/templates',template),join(output,'templates',template));
for(const path of project.files){mkdirSync(dirname(join(output,'data',path)),{recursive:true});writeFileSync(join(output,'data',path),publicFiles[path]);}
writeFileSync(join(output,'.nojekyll'),'');
for(const file of inventory(output))if(!allowed.has(file))throw new Error(`Unexpected artifact: ${file}`);
for(const file of inventory(output).filter(f=>/\.(html|js|css)$/.test(f))){
  const content=readFileSync(join(output,file),'utf8');
  if(/ibkr|directus|antigravity|localhost|127\.0\.0\.1|localStorage|sessionStorage|indexedDB/i.test(content))throw new Error(`静态输出包含旧服务或持久化依赖：${file}`);
}
console.log(`Built ${inventory(output).length} whitelisted static files in ${output} (release ${version})`);
