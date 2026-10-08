import {emptyData,validateBackup} from './model.js';
// Path-scoped: two GitHub Pages applications on the same origin do not collide.
const pathScope = new URL('.', globalThis.location?.href || 'https://example.invalid/').pathname;
export const STORAGE_KEY = 'cycle-algorithm-v2:' + pathScope;
export const LEGACY_STORAGE_KEY = 'cycle-algorithm-v1:' + pathScope;

export function load(storage=globalThis.localStorage){
  const raw = storage.getItem(STORAGE_KEY);
  if(raw) return validateBackup(JSON.parse(raw));
  const legacy = storage.getItem(LEGACY_STORAGE_KEY);
  if(legacy) {
    const migrated = validateBackup(JSON.parse(legacy));
    save(migrated, storage);
    return migrated;
  }
  return emptyData();
}
export function save(data,storage=globalThis.localStorage){
  const stamped={...data,updatedAt:new Date().toISOString()};
  // setItem is atomic: a quota/write failure keeps the previous persisted data.
  storage.setItem(STORAGE_KEY,JSON.stringify(stamped));
  return stamped;
}
export function exportBackup(data){return JSON.stringify({...data,exportedAt:new Date().toISOString()},null,2);}
