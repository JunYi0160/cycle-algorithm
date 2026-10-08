import {emptyData,validateBackup} from './model.js';
// Path-scoped: two GitHub Pages applications on the same origin do not collide.
export const STORAGE_KEY='cycle-algorithm-v1:'+new URL('.',globalThis.location?.href||'https://example.invalid/').pathname;
export function load(storage=globalThis.localStorage){
  const raw=storage.getItem(STORAGE_KEY);return raw?validateBackup(JSON.parse(raw)):emptyData();
}
export function save(data,storage=globalThis.localStorage){
  const stamped={...data,updatedAt:new Date().toISOString()};
  // setItem is atomic: a quota/write failure keeps the previous persisted data.
  storage.setItem(STORAGE_KEY,JSON.stringify(stamped));return stamped;
}
export function exportBackup(data){return JSON.stringify({...data,exportedAt:new Date().toISOString()},null,2);}
