import {readProjectData} from './project-data.js';
import {validateBackup} from './model.js';
export async function load(fetcher=globalThis.fetch,base=new URL('../data/',import.meta.url)){
  return readProjectData(async path=>{
    const response=await fetcher(new URL(path,base),{cache:'no-store'});
    if(!response.ok)throw new Error(`项目数据读取失败：${path} (${response.status})`);
    return response.text();
  });
}
export function exportBackup(data){return JSON.stringify(validateBackup(data),null,2)+'\n';}
