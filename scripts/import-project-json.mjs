import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectFiles} from '../src/project-data.js';
import {validateBackup,mergeValuations} from '../src/model.js';
import {checkProjectData} from './project-files.mjs';
const input=process.argv[2];if(!input)throw new Error('Usage: node scripts/import-project-json.mjs <market-data.json>');
const root=fileURLToPath(new URL('../data/',import.meta.url));
const incoming=validateBackup(JSON.parse(readFileSync(resolve(input),'utf8')));
let data=incoming,names={};
if(existsSync(resolve(root,'manifest.json'))){
  const existing=await checkProjectData(root);names=Object.fromEntries(existing.manifest.assets.map(a=>[a.symbol,a.name]));
  data=mergeValuations(existing.data,incoming.valuations).data;
  const prices=new Map(existing.data.prices.map(r=>[r.symbol+'/'+r.as_of,r]));
  for(const row of incoming.prices)prices.set(row.symbol+'/'+row.as_of,row);
  data.prices=[...prices.values()];data.fxRates={...existing.data.fxRates,...incoming.fxRates};
  const events=new Map(existing.data.formalEvents.map(e=>[e.id,e]));for(const e of incoming.formalEvents)events.set(e.id,e);
  data.formalEvents=[...events.values()];data.legacyFormalEvents=[...existing.data.legacyFormalEvents,...incoming.legacyFormalEvents];
}
const files=projectFiles(data,names);
for(const [path,content] of Object.entries(files)){
  const target=resolve(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content);
}
console.log(`Wrote ${Object.keys(files).length} public project data files.`);
