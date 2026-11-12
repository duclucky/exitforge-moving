import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.js';
import {PayPal} from '../server/paypal.js';

async function fixture(t,{configured=true,feeBps,quotePrice}={}){
  const batches=new Map();let createCalls=0,loseResponse=false;
  const payment={configured:true,
    async create(h,q){this.h=h;this.q=q;return{id:'DEPOSIT'};},
    async createBalance(){return{id:'FINAL'};},
    async get(id){return{id,status:'COMPLETED',purchase_units:[{custom_id:this.h.id+(id==='FINAL'?':balance':''),payments:{captures:[{id:'CAPTURE-'+id,status:'COMPLETED',amount:{currency_code:'USD',value:(id==='FINAL'?this.q.price-this.q.deposit:this.q.deposit).toFixed(2)}}]}}]};},
    async capture(id){return this.get(id);},
    async createPayout(row){createCalls++;let b=batches.get(row.batch_key);if(!b){b={batch_header:{payout_batch_id:'BATCH-1',batch_status:'PENDING',sender_batch_header:{sender_batch_id:row.batch_key}},items:[{payout_item_id:'ITEM-1',transaction_status:'PENDING',payout_item:{receiver:row.receiver,recipient_type:'PAYPAL_ID',sender_item_id:row.item_key,amount:{currency:'USD',value:(row.amount_cents/100).toFixed(2)}}}]};batches.set(row.batch_key,b);}if(loseResponse){loseResponse=false;throw new Error('Lost payout response');}return b;},
    async getPayout(){return [...batches.values()][0];},
  };
  const env={DEMO_MODE:'true',PLATFORM_FEE_BPS:feeBps,...(configured?{PAYPAL_GOODMOVE_RECIPIENT:'TESTMERCHANT1'}:{})};
  const app=createApp({database:':memory:',env,paymentService:payment}),server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.close();app.locals.db.close();});
  function client(){let cookie='';return async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api`+path,{headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return{status:r.status,data:await r.json()};};}
  const customer=client(),provider=client(),other=client();for(const [r,userId] of [[customer,'customer'],[provider,'goodmove'],[other,'citycrew']])await r('/demo-session',{userId});
  if(quotePrice){
    const quote=(await provider('/workspace')).data.offers.find(offer=>offer.id==='offer-gm-101');
    const result=await provider('/jobs/move-101/offers',{...quote,price:quotePrice,platformFeeCents:1});
    assert.equal(result.status,201);
  }
  const h=(await customer('/offers/offer-gm-101/reserve',{})).data,path='/holds/'+h.id;
  await customer(path+'/paypal-order',{});await customer(path+'/capture',{});
  async function complete(){await provider(path+'/work/start',{});await provider(path+'/work/report',{note:'Sandbox work is completed; please inspect it.'});await customer(path+'/work/accept',{confirmed:true});await customer(path+'/balance/paypal-order',{});await customer(path+'/balance/capture',{});}
  function success(){const b=[...batches.values()][0];b.batch_header.batch_status='SUCCESS';b.items[0].transaction_status='SUCCESS';b.items[0].transaction_id='RECEIVER-TX-1';return b;}
  return{customer,provider,other,h,path,complete,payment,env,db:app.locals.db,batches,success,get createCalls(){return createCalls;},lose(){loseResponse=true;}};
}

test('only the selected mover can request a payout and only after accepted fully paid work',async t=>{
  const f=await fixture(t);assert.equal((await f.provider(f.path+'/payout',{})).status,409);await f.complete();
  assert.equal((await f.customer(f.path+'/payout',{})).status,403);assert.equal((await f.other(f.path+'/payout',{})).status,403);
  assert.equal((await f.provider(f.path+'/payout',{})).data.status,'PENDING');
});
test('a pending batch never means the mover was paid; repeated requests reuse one payout',async t=>{
  const f=await fixture(t);await f.complete();await f.provider(f.path+'/payout',{});await f.provider(f.path+'/payout',{});
  assert.equal(f.createCalls,1);assert.equal(f.batches.size,1);
  const r=(await f.customer(f.path+'/receipt')).data;assert.equal(r.payout.received,false);assert.equal(r.payout.amount,180);
  f.success();const paid=await f.provider(f.path+'/payout/check',{});assert.equal(paid.data.received,true);assert.equal(paid.data.transactionId,'RECEIVER-TX-1');
  await f.provider(f.path+'/payout',{});assert.equal(f.createCalls,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE hold_id=? AND action='provider_payout_received'").get(f.h.id).n,1);
});
test('lost submission responses retry with the same immutable batch, recipient and amount',async t=>{
  const f=await fixture(t);await f.complete();f.lose();assert.equal((await f.provider(f.path+'/payout',{})).status,502);
  f.env.PAYPAL_GOODMOVE_RECIPIENT='CHANGED-RECIPIENT';
  assert.equal((await f.provider(f.path+'/payout',{amount:1,receiver:'ATTACKER'})).status,200);
  assert.equal(f.batches.size,1);const item=[...f.batches.values()][0].items[0].payout_item;
  assert.equal(item.receiver,'TESTMERCHANT1');assert.equal(item.amount.value,'180.00');
});
test('wrong amount or receiver cannot mark a provider payout successful',async t=>{
  const f=await fixture(t);await f.complete();await f.provider(f.path+'/payout',{});const b=f.success();
  b.items[0].payout_item.amount.value='1.00';assert.equal((await f.provider(f.path+'/payout/check',{})).status,409);
  b.items[0].payout_item.amount.value='180.00';b.items[0].payout_item.receiver='WRONG';assert.equal((await f.provider(f.path+'/payout/check',{})).status,409);
  assert.equal((await f.customer(f.path+'/receipt')).data.payout.received,false);
});
test('unclaimed or failed items stay unpaid and never silently create another payout',async t=>{
  const f=await fixture(t);await f.complete();await f.provider(f.path+'/payout',{});const b=[...f.batches.values()][0];b.batch_header.batch_status='SUCCESS';b.items[0].transaction_status='UNCLAIMED';
  assert.equal((await f.provider(f.path+'/payout/check',{})).data.received,false);
  b.items[0].transaction_status='FAILED';await f.provider(f.path+'/payout',{});assert.equal(f.createCalls,1);
  assert.equal((await f.other(f.path+'/payout/check',{})).status,403);
});
test('missing recipient configuration is explicit and does not call Payouts',async t=>{
  const f=await fixture(t,{configured:false});await f.complete();assert.equal((await f.provider(f.path+'/payout',{})).status,503);assert.equal(f.createCalls,0);
});
test('PayPal payout wire request uses exact USD amount and stable batch/item keys',async()=>{
  const p=new PayPal({});let captured;p.request=async(path,options)=>{captured={path,...options};return{batch_header:{payout_batch_id:'B'}};};
  await p.createPayout({hold_id:'hold-id',receiver:'TESTMERCHANT1',amount_cents:18100,batch_key:'fixed-batch',item_key:'fixed-item'});
  assert.equal(captured.path,'/v1/payments/payouts');assert.equal(captured.body.sender_batch_header.sender_batch_id,'fixed-batch');assert.equal(captured.body.items[0].amount.value,'181.00');assert.equal(captured.body.items[0].sender_item_id,'fixed-item');assert.equal(captured.body.items[0].recipient_type,'PAYPAL_ID');
});

test('duplicate payout submission reconciles the original Sandbox batch and rejects external links',async()=>{
  const p=new PayPal({}),row={batch_key:'same-batch',item_key:'same-item',receiver:'TESTMERCHANT1',amount_cents:20500};
  let calls=[];p.request=async(path)=>{calls.push(path);if(path==='/v1/payments/payouts')throw Object.assign(new Error('Duplicate'),{code:'VALIDATION_ERROR',details:[{issue:'DUPLICATE_BATCH_ID',links:[{rel:'original_payout_batch',href:'https://api-m.sandbox.paypal.com/v1/payments/payouts/ORIGINAL123'}]}]});return{batch_header:{payout_batch_id:'ORIGINAL123'}};};
  assert.equal((await p.createPayout(row)).batch_header.payout_batch_id,'ORIGINAL123');assert.deepEqual(calls,['/v1/payments/payouts','/v1/payments/payouts/ORIGINAL123']);
  p.request=async()=>{throw Object.assign(new Error('Duplicate'),{code:'DUPLICATE_BATCH_ID',links:[{rel:'original_payout_batch',href:'https://example.com/v1/payments/payouts/OTHER'}]});};
  await assert.rejects(()=>p.createPayout(row),/Duplicate/);
});

test('the quoted platform fee reduces only the mover payout and stays fixed after booking',async t=>{
  const f=await fixture(t,{quotePrice:181});
  const quote=JSON.parse(f.h.snapshot);
  assert.equal(quote.platformFeeCents,91);
  assert.equal(quote.deposit,36.2);
  f.env.PLATFORM_FEE_BPS='800';
  const changedQuote={...quote,platformFeeCents:1};
  f.db.prepare('UPDATE offers SET data=? WHERE id=?').run(JSON.stringify(changedQuote),f.h.offer);
  const booked=(await f.customer(f.path+'/receipt')).data;
  assert.equal(booked.total,181);
  assert.equal(booked.balanceDue,144.8);
  assert.equal(booked.payout.platformFee,0.91);
  assert.equal(booked.payout.amount,180.09);
  await f.complete();
  assert.equal((await f.provider(f.path+'/payout',{})).data.amount,180.09);
  const item=[...f.batches.values()][0].items[0].payout_item;
  assert.equal(item.amount.value,'180.09');
  f.success();
  assert.equal((await f.provider(f.path+'/payout/check',{})).data.received,true);
  assert.equal((await f.customer(f.path+'/receipt')).data.amountPaid,181);
});
