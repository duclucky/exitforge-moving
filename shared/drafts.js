// Existing browser drafts remain readable during the brand migration.
const legacyPrefix='movewindow-draft-';
export const draftKeyFor=id=>'exitforge-draft-'+(id||'new');
export function readDraft(storage,key){
  const current=storage.getItem(key);
  return JSON.parse(current??storage.getItem(legacyPrefix+key.slice('exitforge-draft-'.length))??'null');
}
export function clearDraft(storage,key){
  storage.removeItem(key);
  storage.removeItem(legacyPrefix+key.slice('exitforge-draft-'.length));
}
