import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.js';
import {planMove,resourceConflicts,suggestPlans,todayInZone} from '../shared/schedule.js';

async function fixture(t){
  let sequence=0,captures=0;const orders=new Map();
  const payment={configured:true,
    async create(h,q){const id='DEPOSIT-'+(++sequence);orders.set(id,{id,ref:h.id,amount:q.deposit,paid:false});return{id,links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]};},
    async get(id){const o=orders.get(id);return{id,status:o.paid?'COMPLETED':'APPROVED',purchase_units:[{custom_id:o.ref,payments:{captures:o.paid?[{id:'CAP-'+id,status:'COMPLETED',amount:{currency_code:'USD',value:o.amount.toFixed(2)}}]:[]}}]};},
    async capture(id){captures++;orders.get(id).paid=true;return this.get(id);},
  };
  const app=createApp({database:':memory:',env:{DEMO_MODE:'true'},paymentService:payment}),server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));t.after(()=>{server.close();app.locals.db.close();});
  const client=()=>{let cookie='';return async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api`+path,{headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:await r.json()};};};
  const customer=client(),mover=client(),other=client(),anonymous=client();
  for(const [r,userId] of [[customer,'customer'],[mover,'goodmove'],[other,'citycrew']])await r('/demo-session',{userId});
  const w=(await customer('/workspace')).data,j=w.jobs.find(j=>j.id==='move-101'),o=w.offers.find(o=>o.id==='offer-gm-101');
  const hold=async()=> (await customer('/offers/'+o.id+'/reserve',{})).data;
  return{customer,mover,other,anonymous,j,o,db:app.locals.db,payment,orders,hold,get captures(){return captures;}};
}

test('core API requires sessions and separates customer and mover permissions',async t=>{
  const f=await fixture(t);assert.equal((await f.anonymous('/workspace')).status,401);
  assert.equal((await f.mover('/jobs',f.j)).status,403);
  assert.equal((await f.customer('/jobs/'+f.j.id+'/offers',f.o)).status,403);
  assert.equal((await f.mover('/jobs/'+f.j.id+'/update',f.j)).status,403);
});
test('move dates and complete ordered access windows are validated at the API',async t=>{
  const f=await fixture(t);
  for(const patch of [{date:'2030-02-30'},{date:'2020-01-01'},{pickupStart:'11:00',pickupEnd:'10:00'},{dropStart:''}])assert.equal((await f.customer('/jobs',{...f.j,...patch})).status,400);
  assert.equal((await f.customer('/jobs',{...f.j,title:'A valid future move'})).status,201);
});
test('reviewed plans include destination waiting and protect the return buffer',async t=>{
  const f=await fixture(t),plan=planMove(f.j,f.o);
  assert.equal(plan.valid,true);assert.equal(plan.reserveEnd,plan.end+15);assert.equal(plan.phases.find(p=>p.kind==='wait').end,660);
  assert.equal(resourceConflicts(f.j.date,['gm-1'],plan,[{date:f.j.date,resourceId:'gm-1',start:plan.end+5,end:plan.end+30}]).length,1);
  assert.equal(planMove({...f.j,pickupEnd:'09:45'},f.o).valid,false);
  assert.equal(planMove({...f.j,pickupEnd:''},f.o).valid,false);
});
test('offers enforce truck ownership, crew size and resource availability',async t=>{
  const f=await fixture(t);
  for(const resources of [['cc-truck','gm-1'],['gm-truck-1'],['gm-truck-1','gm-1','gm-1']])assert.equal((await f.mover('/jobs/'+f.j.id+'/offers',{...f.o,resources})).status,400);
  await f.hold();assert.equal((await f.mover('/jobs/'+f.j.id+'/offers',f.o)).status,409);
});
test('holds are idempotent and cannot allocate the same crew to overlapping jobs',async t=>{
  const f=await fixture(t),h=await f.hold();assert.equal((await f.hold()).id,h.id);
  assert.equal((await f.customer('/offers/offer-cc-101/reserve',{})).status,409);
  const j2=(await f.customer('/jobs',{...f.j,title:'Conflicting resource reservation'})).data;
  assert.equal((await f.mover('/jobs/'+j2.id+'/offers',f.o)).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE hold_id=?').get(h.id).n,3);
});
test('editing an open job invalidates existing quotes and never changes a paid/held move',async t=>{
  const f=await fixture(t);assert.equal((await f.customer('/jobs/'+f.j.id+'/update',{...f.j,inventory:'Changed inventory: two sofas.'})).status,200);
  assert.equal((await f.customer('/offers/'+f.o.id+'/reserve',{})).status,409);
  assert.equal((await f.mover('/jobs/'+f.j.id+'/offers',f.o)).status,201);
  await f.hold();assert.equal((await f.customer('/jobs/'+f.j.id+'/update',f.j)).status,409);
});
test('exact deposit cents and capture confirmation are idempotent',async t=>{
  const f=await fixture(t);await f.mover('/jobs/'+f.j.id+'/offers',{...f.o,price:181});const h=await f.hold();
  const order=(await f.customer('/holds/'+h.id+'/paypal-order',{})).data;assert.equal(f.orders.get(order.id).amount,36.2);
  const paid=await f.customer('/holds/'+h.id+'/capture',{}),again=await f.customer('/holds/'+h.id+'/capture',{});
  assert.equal(paid.data.status,'booked');assert.equal(again.data.capture,paid.data.capture);assert.equal(f.captures,1);
});
test('incorrect deposit amount or quote reference never books resources',async t=>{
  const f=await fixture(t),h=await f.hold(),path='/holds/'+h.id;
  const o=(await f.customer(path+'/paypal-order',{})).data;f.orders.get(o.id).amount=0.01;
  assert.equal((await f.customer(path+'/capture',{})).status,409);
  f.orders.get(o.id).amount=f.o.deposit;f.orders.get(o.id).ref='WRONG-RESERVATION';
  assert.equal((await f.customer(path+'/capture',{})).status,409);
});
test('unpaid expired checkout cannot capture; initiated checkout remains recoverable',async t=>{
  const f=await fixture(t),h=await f.hold(),path='/holds/'+h.id;
  await f.customer(path+'/paypal-order',{});f.db.prepare('UPDATE holds SET expires=? WHERE id=?').run(Date.now()-1000,h.id);
  assert.equal((await f.customer(path+'/capture',{})).status,409);assert.equal(f.captures,0);
  assert.equal((await f.customer('/workspace')).data.paymentHistory[0].id,h.id);
});
test('lost deposit responses reconcile once; late paid holds require selected-provider review',async t=>{
  const f=await fixture(t),h=await f.hold(),path='/holds/'+h.id;
  const o=(await f.customer(path+'/paypal-order',{})).data;await f.payment.capture(o.id);
  f.db.prepare('UPDATE holds SET expires=? WHERE id=?').run(Date.now()-1000,h.id);
  assert.equal((await f.customer(path+'/capture',{})).data.status,'needs_review');assert.equal(f.captures,1);
  assert.equal((await f.other(path+'/confirm-late',{})).status,403);
  assert.equal((await f.mover(path+'/confirm-late',{})).data.status,'booked');assert.equal(f.captures,1);
});
test('a prior externally completed deposit is reconciled before a second checkout',async t=>{
  const f=await fixture(t),first=await f.hold(),path='/holds/'+first.id;
  const o=(await f.customer(path+'/paypal-order',{})).data;await f.payment.capture(o.id);
  f.db.prepare("UPDATE holds SET status='expired',expires=? WHERE id=?").run(Date.now()-1000,first.id);
  const second=await f.hold();assert.notEqual(first.id,second.id);
  assert.equal((await f.customer('/holds/'+second.id+'/paypal-order',{})).status,409);
  assert.equal(f.orders.size,1);assert.equal(f.db.prepare('SELECT status FROM holds WHERE id=?').get(first.id).status,'needs_review');
});
test('plan suggestions preserve reviewed estimates and exclude occupied resources',async t=>{
  const f=await fixture(t),estimate={...f.o,loadMinutes:30},plans=suggestPlans(f.j,estimate,[]);
  assert.ok(plans.length>0&&plans.length<=3);
  for(const p of plans){assert.equal(p.price,estimate.price);assert.equal(p.loadMinutes,30);assert.equal(planMove(f.j,p).valid,true);}
  const busy=[{date:f.j.date,resourceId:'gm-truck-1',start:360,end:1200}];assert.equal(suggestPlans(f.j,estimate,busy).length,0);
  assert.equal((await f.customer('/jobs/'+f.j.id+'/suggestions',estimate)).status,403);
});
