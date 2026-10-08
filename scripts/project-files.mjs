import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join,relative} from 'node:path';
import {readProjectData} from '../src/project-data.js';
export function inventory(directory,base=directory){
  return readdirSync(directory).flatMap(name=>{
    const path=join(directory,name);return statSync(path).isDirectory()?inventory(path,base):[relative(base,path).replaceAll('\\','/')];
  }).sort();
}
export async function checkProjectData(directory){
  const loaded=await readProjectData(path=>readFileSync(join(directory,path),'utf8'));
  const expected=['manifest.json','fx-rates.csv','formal-events.json',...loaded.manifest.assets.flatMap(a=>[a.valuations,a.prices])];
  const actual=inventory(directory).filter(p=>p!=='README.md');
  if(actual.some(p=>!expected.includes(p)))throw new Error('数据目录存在未登记文件：'+actual.filter(p=>!expected.includes(p)).join('、'));
  return {...loaded,files:expected.sort()};
}
