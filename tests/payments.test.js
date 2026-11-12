import test from 'node:test';
import assert from 'node:assert/strict';
import {paymentOverview,paymentAction} from '../shared/payments.js';

function booking(id,patch={}){return{id,job:id,status:'booked',paid:1,capture:'CAP-'+id,snapshot:JSON.stringify({provider:'goodmove',price:181,deposit:36.2}),fulfillment:{stage:'completed',balance_paid:undefined,balanceCapture:'FINAL-'+id,paidInFull:true,balanceDue:0,payout:{status:'READY',received:false,amount:181}},...patch};}
function workspace(role,holds){return{user:{role,id:role==='provider'?'goodmove':'customer'},holds,paymentHistory:[],jobs:holds.map(h=>({id:h.job,title:'Move '+h.job,date:'2026-11-18',status:h.fulfillment?.stage||'booked'}))};}
test('payment overview separates customer captures, ready settlement, pending payout and received earnings',()=>{
  const ready=booking('ready'),pending=booking('pending',{fulfillment:{...booking('pending').fulfillment,payout:{status:'PENDING',received:false,amount:181}}}),paid=booking('paid',{fulfillment:{...booking('paid').fulfillment,payout:{status:'SUCCESS',received:true,amount:181,transactionId:'RECEIVED'}}});
  const provider=paymentOverview(workspace('provider',[ready,pending,paid]));
  assert.equal(provider.received,181);assert.equal(provider.awaitingSettlement,362);assert.equal(provider.customerPaid,543);
  assert.equal(provider.rows.find(r=>r.id==='pending').settled,false);assert.equal(provider.rows.find(r=>r.id==='paid').settled,true);
  assert.equal(paymentAction('provider',ready),'Receive crew payment');assert.equal(paymentAction('provider',paid),null);
});
test('amounts use immutable quotes and exact cents; unpaid checkouts are never counted as collected',()=>{
  const paid=booking('paid'),deposit=booking('deposit',{fulfillment:{stage:'scheduled',paidInFull:false,balanceDue:144.8}}),checkout=booking('checkout',{status:'held',paid:0,capture:null,fulfillment:undefined,paypal_order:'STARTED'});
  const w=workspace('customer',[paid,deposit,checkout]);w.offers=[{jobId:'paid',price:9999}];w.paymentHistory=[checkout];
  const overview=paymentOverview(w);assert.equal(overview.rows.length,3);assert.equal(overview.customerPaid,217.2);assert.equal(overview.customerDue,144.8);assert.equal(overview.rows.find(r=>r.id==='checkout').paid,0);
});
test('failed and unclaimed payouts need review and cannot inflate received totals',()=>{
  const holds=['FAILED','UNCLAIMED','UNCERTAIN','NOT_CONFIGURED'].map(status=>booking(status,{fulfillment:{...booking(status).fulfillment,payout:{status,received:false,amount:181}}}));
  const result=paymentOverview(workspace('provider',holds));assert.equal(result.received,0);assert.equal(result.awaitingSettlement,724);assert.ok(result.rows.every(r=>r.attention&&!r.settled));
  assert.equal(paymentAction('provider',holds[0]),'Review crew payment');
  assert.equal(paymentAction('customer',booking('due',{fulfillment:{stage:'balance_due',paidInFull:false,balanceDue:144.8}})),'Pay the final balance');
});
