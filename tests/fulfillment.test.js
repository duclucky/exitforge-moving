import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { PayPal } from '../server/paypal.js';

async function fixture(t){
  const orders=new Map();let balanceCaptures=0,sequence=0;
  const payment={configured:true,
    async create(h,q){return this.order(h.id,q.deposit,'deposit');},
    async createBalance(h,q){return this.order(h.id+':balance',(Math.round(q.price*100)-Math.round(q.deposit*100))/100,'balance');},
    order(reference,amount,kind){const id='ORDER-'+(++sequence);orders.set(id,{id,reference,amount,kind,complete:false,status:'APPROVED'});return{id,links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]};},
    async get(id){const o=orders.get(id);return{id,status:o.complete?'COMPLETED':o.status,purchase_units:[{custom_id:o.reference,payments:{captures:o.complete?[{id:'CAPTURE-'+id,status:'COMPLETED',amount:{currency_code:'USD',value:o.amount.toFixed(2)}}]:[]}}]};},
    async capture(id){const o=orders.get(id);if(o.kind==='balance')balanceCaptures++;o.complete=true;return this.get(id);},
  };
  const app=createApp({database:':memory:',paymentService:payment,env:{DEMO_MODE:'true'}}),server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.close();app.locals.db.close();});
  const base='http://127.0.0.1:'+server.address().port;
  function client(){let cookie='';return async(path,body)=>{const response=await fetch(base+'/api'+path,{headers:{'Content-Type':'application/json',Cookie:cookie},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,headers:response.headers,data:await response.json()};};}
  const customer=client(),provider=client(),other=client();
  for(const [request,userId] of [[customer,'customer'],[provider,'goodmove'],[other,'citycrew']])await request('/demo-session',{userId});
  await provider('/jobs/move-101/offers',{price:181,start:'09:00',loadMinutes:60,travelMinutes:45,unloadMinutes:60,resources:['gm-truck-1','gm-1','gm-2'],note:'Reviewed service estimate for this test moving job.'});
  const h=(await customer('/offers/offer-gm-101/reserve',{})).data;
  await customer('/holds/'+h.id+'/paypal-order',{});await customer('/holds/'+h.id+'/capture',{});
  const path='/holds/'+h.id;
  async function report(){await provider(path+'/work/start',{});return provider(path+'/work/report',{note:'All agreed items delivered and unloaded; please inspect the completed move.'});}
  async function accept(){await report();return customer(path+'/work/accept',{confirmed:true});}
  return{customer,provider,other,h,path,report,accept,payment,orders,db:app.locals.db,get balanceCaptures(){return balanceCaptures;}};
}

test('a verified deposit starts a scheduled job with an exact unpaid balance',async t=>{
  const f=await fixture(t),receipt=await f.customer(f.path+'/receipt');
  assert.equal(receipt.status,200);assert.equal(receipt.data.stage,'scheduled');assert.equal(receipt.data.deposit,36.2);assert.equal(receipt.data.balanceDue,144.8);assert.equal(receipt.data.paidInFull,false);
});

test('receipt download is an authenticated attachment with the authoritative unpaid balance',async t=>{
  const f=await fixture(t),receipt=await f.customer(f.path+'/receipt?download=1');
  assert.equal(receipt.status,200);assert.match(receipt.headers.get('content-disposition'),/^attachment; filename="?ExitForge-receipt-/);
  assert.equal(receipt.data.reservationId,f.h.id);assert.equal(receipt.data.balanceDue,144.8);
  assert.equal((await f.other(f.path+'/receipt?download=1')).status,403);
});
test('work and final checkout enforce the selected operator and customer review',async t=>{
  const f=await fixture(t);
  assert.equal((await f.customer(f.path+'/work/start',{})).status,403);
  assert.equal((await f.other(f.path+'/work/start',{})).status,403);
  assert.equal((await f.provider(f.path+'/work/report',{note:'The job is complete, please inspect.'})).status,409);
  assert.equal((await f.customer(f.path+'/work/accept',{confirmed:true})).status,409);
  assert.equal((await f.customer(f.path+'/balance/paypal-order',{})).status,409);
});
test('changes require a new completion report before the customer can accept',async t=>{
  const f=await fixture(t);await f.report();
  assert.equal((await f.customer(f.path+'/work/request-changes',{note:'Please bring the final two boxes into the apartment.'})).data.stage,'changes_requested');
  assert.equal((await f.customer(f.path+'/work/accept',{confirmed:true})).status,409);
  await f.provider(f.path+'/work/report',{note:'The final two boxes are now delivered. Please inspect the move again.'});
  assert.equal((await f.customer(f.path+'/work/accept',{confirmed:false})).status,400);
  assert.equal((await f.customer(f.path+'/work/accept',{confirmed:true})).data.stage,'balance_due');
});
test('only verified final payment closes the job and repeated confirmation does not charge again',async t=>{
  const f=await fixture(t);await f.accept();
  assert.equal((await f.provider(f.path+'/balance/paypal-order',{})).status,403);
  const a=await f.customer(f.path+'/balance/paypal-order',{}),b=await f.customer(f.path+'/balance/paypal-order',{});
  assert.equal(a.data.id,b.data.id);assert.equal(f.orders.get(a.data.id).amount,144.8);
  assert.equal((await f.customer(f.path+'/receipt')).data.paidInFull,false);
  const first=await f.customer(f.path+'/balance/capture',{}),again=await f.customer(f.path+'/balance/capture',{});
  assert.equal(first.data.stage,'completed');assert.equal(again.data.balanceCapture,first.data.balanceCapture);assert.equal(f.balanceCaptures,1);
  const receipt=(await f.customer(f.path+'/receipt')).data;assert.equal(receipt.amountPaid,181);assert.equal(receipt.balanceDue,0);assert.equal(receipt.paidInFull,true);
  assert.equal((await f.customer('/workspace')).data.jobs.find(j=>j.id==='move-101').status,'completed');
});
test('incorrect amount or reservation reference cannot mark a balance paid',async t=>{
  const f=await fixture(t);await f.accept();const order=(await f.customer(f.path+'/balance/paypal-order',{})).data;
  f.orders.get(order.id).amount=0.01;
  assert.equal((await f.customer(f.path+'/balance/capture',{})).status,409);
  assert.equal((await f.customer(f.path+'/receipt')).data.paidInFull,false);
  f.orders.get(order.id).amount=144.8;f.orders.get(order.id).reference=f.h.id;
  assert.equal((await f.customer(f.path+'/balance/capture',{})).status,409);
});
test('a lost final-capture response is reconciled without another charge',async t=>{
  const f=await fixture(t);await f.accept();const order=(await f.customer(f.path+'/balance/paypal-order',{})).data;
  await f.payment.capture(order.id);
  assert.equal((await f.customer(f.path+'/balance/capture',{})).data.stage,'completed');assert.equal(f.balanceCaptures,1);
  assert.equal((await f.other(f.path+'/receipt')).status,403);
  assert.equal((await f.provider(f.path+'/work/report',{note:'Attempt to report an already completed job.'})).status,409);
});
test('unapproved final checkout stays unpaid and accepted completion is idempotent',async t=>{
  const f=await fixture(t);await f.accept();
  assert.equal((await f.customer(f.path+'/work/accept',{confirmed:true})).data.stage,'balance_due');
  const order=(await f.customer(f.path+'/balance/paypal-order',{})).data;f.orders.get(order.id).status='CREATED';
  assert.equal((await f.customer(f.path+'/balance/capture',{})).status,409);assert.equal(f.balanceCaptures,0);
  assert.equal((await f.customer(f.path+'/receipt')).data.stage,'balance_due');
});
test('final balance uses the original paid quote rather than a mutable offer',async t=>{
  const f=await fixture(t);await f.accept();const row=f.db.prepare('SELECT data FROM offers WHERE id=?').get(f.h.offer),quote=JSON.parse(row.data);quote.price=999;
  f.db.prepare('UPDATE offers SET data=? WHERE id=?').run(JSON.stringify(quote),f.h.offer);
  const order=(await f.customer(f.path+'/balance/paypal-order',{})).data;assert.equal(f.orders.get(order.id).amount,144.8);
});
test('PayPal final order has a separate amount, reference, return URL and retry key',async()=>{
  const paypal=new PayPal({APP_URL:'http://127.0.0.1:4174'});let sent;
  paypal.request=async(path,args)=>{sent={path,...args};return{id:'BALANCE'};};
  await paypal.createBalance({id:'hold-123'},{price:181,deposit:36.2},'Test move');
  assert.equal(sent.body.purchase_units[0].amount.value,'144.80');assert.equal(sent.body.purchase_units[0].custom_id,'hold-123:balance');
  assert.match(sent.requestId,/balance/);assert.match(sent.body.payment_source.paypal.experience_context.return_url,/balance_payment=hold-123/);
});

test('QR-created PayPal orders return directly to the same phone payment link',async()=>{
  const paypal=new PayPal({APP_URL:'https://exitforge.site'});let sent;
  paypal.request=async(path,args)=>{sent=args.body;return{id:'QR-ORDER'};};
  const context={returnUrl:'https://exitforge.site/pay/test-capability?approved=1',cancelUrl:'https://exitforge.site/pay/test-capability?cancelled=1'};
  await paypal.createBalance({id:'hold-qr'},{price:180,deposit:36},'QR moving test',context);
  assert.equal(sent.payment_source.paypal.experience_context.return_url,context.returnUrl);
  assert.equal(sent.payment_source.paypal.experience_context.cancel_url,context.cancelUrl);
});
