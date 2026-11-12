import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.js';

async function fixture(t,overrides={}){
  const orders=new Map();let created=0,captured=0,gets=0;
  const payment={configured:true,
    async createBalance(h,q){
      created++;await new Promise(r=>setTimeout(r,15));
      const id='FINAL-'+created;orders.set(id,{id,status:'CREATED',reference:h.id+':balance',amount:((Math.round(q.price*100)-Math.round(q.deposit*100))/100).toFixed(2)});
      return {id,links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}]};
    },
    async get(id){gets++;const o=orders.get(id);return {id,status:o.status,links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token='+id}],purchase_units:[{custom_id:o.reference,payments:{captures:o.status==='COMPLETED'?[{id:'CAP-'+id,status:'COMPLETED',amount:{currency_code:'USD',value:o.amount}}]:[]}}]};},
    async capture(id){captured++;await new Promise(r=>setTimeout(r,15));orders.get(id).status='COMPLETED';return this.get(id);},
  };
  const app=createApp({database:':memory:',env:{DEMO_MODE:'true',APP_URL:'https://exitforge.site',...overrides},paymentService:payment,setup:true});
  const db=app.locals.db,quote=JSON.parse(db.prepare("SELECT data FROM offers WHERE id='offer-gm-101'").get().data);
  db.prepare('INSERT INTO holds(id,job,offer,owner,expires,status,capture,paid,snapshot) VALUES (?,?,?,?,?,?,?,?,?)').run('qr-test','move-101','offer-gm-101','customer',Date.now()+60000,'booked','DEPOSIT-VERIFIED',1,JSON.stringify(quote));
  db.prepare("INSERT INTO fulfillments(hold_id,stage,accepted_at) VALUES (?,'balance_due',?)").run('qr-test',new Date().toISOString());
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.close();db.close();});const base='http://127.0.0.1:'+server.address().port;
  function client(){let cookie='';return async(path,body,headers={})=>{const res=await fetch(base+'/api'+path,{headers:{Cookie:cookie,'Content-Type':'application/json',...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,headers:res.headers,data:await res.json()};};}
  const customer=client(),provider=client(),other=client(),guest=client();
  for(const [request,userId] of [[customer,'customer'],[provider,'goodmove'],[other,'citycrew']])await request('/demo-session',{userId});
  async function link(){return provider('/holds/qr-test/payment-link',{});}
  return {app,db,payment,orders,customer,provider,other,guest,link,base,get created(){return created;},get captured(){return captured;},get gets(){return gets;}};
}

test('only the selected mover can generate a QR after customer acceptance',async t=>{
  const f=await fixture(t);
  assert.equal((await f.customer('/holds/qr-test/payment-link',{})).status,403);
  assert.equal((await f.other('/holds/qr-test/payment-link',{})).status,403);
  f.db.prepare("UPDATE fulfillments SET stage='awaiting_confirmation',accepted_at=NULL").run();
  assert.equal((await f.link()).status,409);
  f.db.prepare("UPDATE fulfillments SET stage='balance_due',accepted_at=?").run(new Date().toISOString());
  const result=await f.link();assert.equal(result.status,200);assert.match(result.data.url,/^https:\/\/exitforge\.site\/pay\/[A-Za-z0-9_-]{43}$/);
  assert.match(result.data.qrImage,/^data:image\/png;base64,/);assert.equal(f.created,0);
});

test('a guest QR reveals payment scope only, stores a token hash and grants no workspace access',async t=>{
  const f=await fixture(t),link=(await f.link()).data,token=link.url.split('/').pop();
  const info=await f.guest('/public-payments/'+token);assert.equal(info.status,200);assert.equal(info.data.balanceDue,144);assert.equal(info.data.provider,'GoodMove');
  assert.equal(info.data.currency,'USD');assert.equal(info.data.environment,'PayPal Sandbox');
  for(const key of ['from','to','owner','inventory','customerNote','receiver','events','depositCapture','balanceOrder'])assert.equal(info.data[key],undefined,key);
  assert.equal((await f.guest('/workspace')).status,401);assert.equal((await f.guest('/holds/qr-test/receipt')).status,401);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM payment_links').all()).includes(token),false);
  assert.equal((await f.guest('/public-payments/'+'z'.repeat(43))).status,404);
});

test('phone and desktop checkout share a single order and capture under concurrency',async t=>{
  const f=await fixture(t),token=(await f.link()).data.url.split('/').pop(),path='/public-payments/'+token;
  const [a,b,c]=await Promise.all([f.guest(path+'/paypal-order',{}),f.customer('/holds/qr-test/balance/paypal-order',{}),f.guest(path+'/paypal-order',{})]);
  assert.equal(a.status,200);assert.equal(a.data.id,b.data.id);assert.equal(a.data.id,c.data.id);assert.equal(f.created,1);
  assert.equal((await f.guest(path+'/check',{})).data.paid,false);assert.equal(f.captured,0);
  f.orders.get(a.data.id).status='APPROVED';
  const [one,two]=await Promise.all([f.guest(path+'/check',{}),f.customer('/holds/qr-test/balance/capture',{})]);
  assert.equal(one.data.paid,true);assert.equal(two.data.paidInFull,true);assert.equal(f.captured,1);
  assert.equal((await f.guest(path+'/paypal-order',{})).data.paid,true);
  assert.equal((await f.guest(path+'/check',{})).data.paid,true);assert.equal(f.captured,1);
  assert.equal((await f.link()).status,409);
});

test('expired QR cannot start or capture a payment, but an already completed capture can reconcile',async t=>{
  const f=await fixture(t),token=(await f.link()).data.url.split('/').pop(),path='/public-payments/'+token;
  const order=(await f.guest(path+'/paypal-order',{})).data;f.orders.get(order.id).status='APPROVED';
  f.db.prepare('UPDATE payment_links SET expires=?').run(Date.now()-1);
  assert.equal((await f.guest(path+'/paypal-order',{})).status,410);
  assert.equal((await f.guest(path+'/check',{})).status,410);assert.equal(f.captured,0);
  f.orders.get(order.id).status='COMPLETED';
  assert.equal((await f.guest(path+'/check',{})).data.paid,true);assert.equal(f.captured,0);
});

test('an unapproved QR poll cannot make a concurrent customer capture report success',async t=>{
  const f=await fixture(t),token=(await f.link()).data.url.split('/').pop(),path='/public-payments/'+token;
  await f.guest(path+'/paypal-order',{});
  const get=f.payment.get.bind(f.payment);
  f.payment.get=async id=>{await new Promise(r=>setTimeout(r,30));return get(id);};
  const [poll,capture]=await Promise.all([f.guest(path+'/check',{}),f.customer('/holds/qr-test/balance/capture',{})]);
  assert.equal(poll.status,200);assert.equal(poll.data.paid,false);
  assert.equal(capture.status,409);assert.equal(f.captured,0);
});

test('QR checks reject mismatched capture amounts and never accept browser supplied amounts',async t=>{
  const f=await fixture(t),token=(await f.link()).data.url.split('/').pop(),path='/public-payments/'+token;
  const order=(await f.guest(path+'/paypal-order',{amount:0.01,holdId:'different'})).data;
  assert.equal(f.orders.get(order.id).amount,'144.00');f.orders.get(order.id).status='COMPLETED';f.orders.get(order.id).amount='0.01';
  assert.equal((await f.guest(path+'/check',{})).status,409);
  assert.equal((await f.customer('/holds/qr-test/receipt')).data.paidInFull,false);
});

test('public HTTPS origin is accepted, hostile origins denied and session cookies secure',async t=>{
  const f=await fixture(t);
  assert.equal((await f.guest('/demo-session',{userId:'customer'},{Origin:'https://hostile.example'})).status,403);
  const r=await f.guest('/demo-session',{userId:'customer'},{Origin:'https://exitforge.site'});
  assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/; Secure/);
  assert.equal(r.headers.get('referrer-policy'),'no-referrer');
});

test('hosted demo denies private files, disables local setup and enforces AI allowance before a model call',async t=>{
  const f=await fixture(t,{NODE_ENV:'production',AI_DAILY_LIMIT:'0'});
  assert.equal(f.app.locals.setupPath,undefined);
  for(const path of ['/.env','/data/exitforge.sqlite','/server/index.js','/deploy/Dockerfile','/package.json'])assert.equal((await fetch(f.base+path)).status,404,path);
  for(const path of ['/survey','/extract']){
    assert.equal((await f.customer(path,{inventory:'Two packed boxes for the office move.'})).status,429,path);
    assert.equal((await f.provider(path,{inventory:'Two packed boxes for the office move.'})).status,403,path);
  }
  assert.equal((await f.guest('/demo-session',{userId:'customer'},{Origin:'http://127.0.0.1:4174'})).status,403);
});
