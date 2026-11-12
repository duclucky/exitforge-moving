import test from 'node:test';
import assert from 'node:assert/strict';
import {draftKeyFor,readDraft,clearDraft} from '../shared/drafts.js';
function storage(values={}){const entries=new Map(Object.entries(values));return{getItem:k=>entries.get(k)??null,removeItem:k=>entries.delete(k)};}
test('renamed drafts recover prior browser data and prefer the latest saved version',()=>{
  const saved=JSON.stringify({form:{title:'A move already drafted'},version:2});
  const old=storage({'movewindow-draft-job-1':saved});
  assert.equal(readDraft(old,draftKeyFor('job-1')).form.title,'A move already drafted');
  assert.equal(readDraft(old,draftKeyFor('job-2')),null);
  const both=storage({'movewindow-draft-new':saved,'exitforge-draft-new':JSON.stringify({form:{title:'Latest draft'}})});
  assert.equal(readDraft(both,draftKeyFor()).form.title,'Latest draft');
});
test('discarding or posting a renamed draft does not resurrect its old saved copy',()=>{
  const s=storage({'movewindow-draft-new':'{}','exitforge-draft-new':'{}'});
  clearDraft(s,draftKeyFor());assert.equal(readDraft(s,draftKeyFor()),null);
});
