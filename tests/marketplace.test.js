import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.js';

async function fixture(t){
  const app=createApp({database:':memory:',env:{DEMO_MODE:'true'}}),server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));t.after(()=>{server.close();app.locals.db.close();});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const client=()=>{let cookie='';return async(path,body)=>{const r=await fetch(base+path,{headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:await r.json()};};};
  const customer=client(),goodmove=client(),citycrew=client();
  for(const [request,userId] of [[customer,'customer'],[goodmove,'goodmove'],[citycrew,'citycrew']])await request('/demo-session',{userId});
  return{customer,goodmove,citycrew,db:app.locals.db};
}
const conversation='/jobs/move-101/conversations/goodmove';

test('assigned moves hide private instructions from other movers while preserving their own quote history',async t=>{
  const f=await fixture(t),original=(await f.customer('/workspace')).data.jobs.find(j=>j.id==='move-101');
  await f.citycrew('/jobs/move-101/conversations/citycrew',{text:'Keep our proposal conversation available as history.'});
  await f.customer('/offers/offer-gm-101/reserve',{});
  const selected=(await f.goodmove('/workspace')).data,unselected=(await f.citycrew('/workspace')).data;
  assert.equal(selected.jobs.find(j=>j.id===original.id).inventory,original.inventory);
  const restricted=unselected.jobs.find(j=>j.id===original.id);
  assert.equal(restricted.restricted,true);assert.equal(restricted.from,undefined);assert.equal(restricted.to,undefined);assert.equal(restricted.inventory,undefined);assert.equal(restricted.notes,undefined);
  assert.ok(unselected.offers.some(o=>o.jobId===original.id));assert.ok(unselected.conversations.some(c=>c.job===original.id));
  assert.equal((await f.citycrew('/jobs/move-101/conversations/citycrew')).data.writable,false);
  f.db.prepare("DELETE FROM messages WHERE job='move-101' AND provider='citycrew'").run();f.db.prepare("DELETE FROM offers WHERE job='move-101' AND provider='citycrew'").run();
  assert.equal((await f.citycrew('/workspace')).data.jobs.some(j=>j.id===original.id),false);
  await f.customer('/holds/'+selected.holds[0].id+'/release',{});
  assert.equal((await f.citycrew('/workspace')).data.jobs.find(j=>j.id===original.id).from,original.from);
});

test('quote conversations are private, persistent, and count only unread incoming messages',async t=>{
  const f=await fixture(t);
  assert.equal((await f.goodmove(conversation,{text:'Can you confirm the loading entrance is available?'})).status,201);
  assert.equal((await f.citycrew(conversation)).status,403);
  assert.equal((await f.citycrew(conversation,{text:'Access another company thread.'})).status,403);
  const w=(await f.customer('/workspace')).data;
  assert.equal(w.conversations.find(c=>c.provider==='goodmove').unread,1);
  assert.equal((await f.customer(conversation)).data.messages[0].text,'Can you confirm the loading entrance is available?');
  await f.customer(conversation+'/read',{});
  assert.equal((await f.customer('/workspace')).data.conversations[0].unread,0);
  await f.customer(conversation,{text:'Yes, use the service entrance at the rear.'});
  assert.equal((await f.goodmove('/workspace')).data.conversations[0].unread,1);
  assert.equal((await f.customer(conversation)).data.messages.length,2);
  assert.equal((await f.customer(conversation,{text:'  '})).status,400);
});

test('once a crew is reserved only its conversation remains writable',async t=>{
  const f=await fixture(t);await f.customer('/offers/offer-gm-101/reserve',{});
  assert.equal((await f.citycrew('/jobs/move-101/conversations/citycrew',{text:'Another offer after assignment.'})).status,409);
  assert.equal((await f.customer('/jobs/move-101/conversations/citycrew',{text:'An unselected thread after assignment.'})).status,409);
  assert.equal((await f.goodmove(conversation,{text:'We have reserved the truck and crew.'})).status,201);
});

test('only the posting customer can cancel an unreserved unpaid job and closed records cannot be reused',async t=>{
  const f=await fixture(t);
  assert.equal((await f.goodmove('/jobs/move-101/cancel',{reason:'No longer required.'})).status,403);
  const j=(await f.customer('/workspace')).data.jobs.find(j=>j.id==='move-101');
  assert.equal((await f.customer('/jobs/move-101/cancel',{reason:'Plans changed; keeping a record.'})).status,200);
  assert.equal((await f.customer('/workspace')).data.jobs.find(j=>j.id==='move-101').status,'cancelled');
  assert.equal((await f.customer('/offers/offer-gm-101/reserve',{})).status,409);
  assert.equal((await f.customer('/jobs/move-101/update',j)).status,409);
  assert.equal((await f.goodmove(conversation,{text:'Message a cancelled job.'})).status,409);
});

test('reservation and unresolved initiated payments block job cancellation',async t=>{
  const f=await fixture(t),h=(await f.customer('/offers/offer-gm-101/reserve',{})).data;
  assert.equal((await f.customer('/jobs/move-101/cancel',{reason:'Try cancelling held resources.'})).status,409);
  f.db.prepare("UPDATE holds SET status='expired',paypal_order='PENDING-EXTERNAL' WHERE id=?").run(h.id);
  assert.equal((await f.customer('/jobs/move-101/cancel',{reason:'Try cancelling an unreconciled checkout.'})).status,409);
});

test('providers can withdraw only their own unreserved offer; withdrawn quotes cannot be booked',async t=>{
  const f=await fixture(t);
  assert.equal((await f.citycrew('/offers/offer-gm-101/withdraw',{})).status,403);
  assert.equal((await f.goodmove('/offers/offer-gm-101/withdraw',{})).status,200);
  assert.equal((await f.customer('/offers/offer-gm-101/reserve',{})).status,409);
  assert.equal((await f.customer('/workspace')).data.offers.find(o=>o.id==='offer-gm-101').status,'withdrawn');
  await f.customer('/offers/offer-cc-101/reserve',{});
  assert.equal((await f.citycrew('/offers/offer-cc-101/withdraw',{})).status,409);
});

test('elapsed move dates cannot be reserved or receive new proposals',async t=>{
  const f=await fixture(t),row=f.db.prepare('SELECT data FROM jobs WHERE id=?').get('move-101'),j=JSON.parse(row.data);
  f.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({...j,date:'2020-01-01'}),j.id);
  assert.equal((await f.customer('/offers/offer-gm-101/reserve',{})).status,409);
  const o=(await f.goodmove('/workspace')).data.offers.find(o=>o.id==='offer-gm-101');
  assert.equal((await f.goodmove('/jobs/move-101/offers',o)).status,409);
});

test('editing a job never reactivates a withdrawn quote',async t=>{
  const f=await fixture(t);await f.goodmove('/offers/offer-gm-101/withdraw',{});
  const j=(await f.customer('/workspace')).data.jobs.find(j=>j.id==='move-101');
  await f.customer('/jobs/move-101/update',{...j,inventory:'Updated inventory for fresh review.'});
  assert.equal((await f.customer('/workspace')).data.offers.find(o=>o.id==='offer-gm-101').status,'withdrawn');
});
