import { z } from 'zod';
import {payoutFor} from './payout.js';
import { bookingScheduleFor, registerScheduleChanges } from './schedule-change.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const noteInput=z.object({note:z.string().trim().min(10,'Add a short explanation of at least 10 characters.').max(2000)});
const acceptedInput=z.object({confirmed:z.literal(true)});

export function fulfillmentFor(db,hold,env={}){
  const row=db.prepare('SELECT * FROM fulfillments WHERE hold_id=?').get(hold.id);
  const quote=JSON.parse(hold.snapshot);
  const totalCents=Math.round(quote.price*100),depositCents=Math.round(quote.deposit*100),balanceCents=totalCents-depositCents;
  return {
    stage:row?.stage||'scheduled',total:totalCents/100,deposit:depositCents/100,balance:balanceCents/100,
    balanceDue:row?.balance_paid?0:balanceCents/100,amountPaid:(depositCents+(row?.balance_paid?balanceCents:0))/100,
    paidInFull:Boolean(row?.balance_paid),balanceOrder:row?.balance_order||null,balanceCapture:row?.balance_capture||null,
    startedAt:row?.started_at||null,reportedAt:row?.reported_at||null,acceptedAt:row?.accepted_at||null,completedAt:row?.completed_at||null,
    operatorNote:row?.operator_note||'',customerNote:row?.customer_note||'',
    events:db.prepare('SELECT actor,action,note,created_at AS createdAt FROM work_events WHERE hold_id=? ORDER BY id').all(hold.id),
    payout:payoutFor(db,hold,env),
    ...bookingScheduleFor(db,hold.id),
  };
}

export function registerFulfillment(app,{db,balance,atomic,job,allocations,env={}}){
  function authorized(req,role){
    const hold=db.prepare('SELECT * FROM holds WHERE id=?').get(req.params.id);
    if(!hold||!hold.snapshot)throw fail('Booked move not found.',404);
    const quote=JSON.parse(hold.snapshot);
    const customer=req.user.role==='customer'&&hold.owner===req.user.id;
    const provider=req.user.role==='provider'&&quote.provider===req.user.id;
    if((role==='customer'&&!customer)||(role==='provider'&&!provider)||(!role&&!customer&&!provider))throw fail('This action is limited to the customer or selected mover.',403);
    if(hold.status!=='booked'||!hold.paid||!hold.capture)throw fail('A verified deposit and confirmed booking are required first.',409);
    return hold;
  }
  function ensure(hold){db.prepare('INSERT OR IGNORE INTO fulfillments(hold_id) VALUES (?)').run(hold.id);}
  function event(hold,req,action,note=''){db.prepare('INSERT INTO work_events(hold_id,actor,action,note,created_at) VALUES (?,?,?,?,?)').run(hold.id,req.user.name,action,note,new Date().toISOString());}
  function receipt(hold){return{reservationId:hold.id,jobId:hold.job,title:job(hold.job).title,currency:'USD',environment:'PayPal Sandbox',depositCapture:hold.capture,...fulfillmentFor(db,hold,env),settlement:'Customer payments are collected by the platform test merchant. Provider settlement is tracked separately through PayPal Sandbox Payouts; queued batches do not prove receipt.'};}

  registerScheduleChanges(app,{db,authorized,atomic,job,allocations,receipt,event});

  app.get('/api/holds/:id/receipt',(req,res)=>{
    const hold=authorized(req);
    if(req.query.download==='1')res.attachment(`ExitForge-receipt-${hold.id.slice(0,8)}.json`);
    res.json(receipt(hold));
  });
  app.post('/api/holds/:id/work/start',(req,res)=>{
    const hold=authorized(req,'provider');
    atomic(()=>{
      ensure(hold);const current=fulfillmentFor(db,hold);
      if(current.stage==='in_progress')return;
      if(current.stage!=='scheduled')throw fail('Only a scheduled move can be started.',409);
      if(current.scheduleChangePending)throw fail('Confirm the new schedule before starting the move.',409);
      db.prepare("UPDATE fulfillments SET stage='in_progress',started_at=? WHERE hold_id=?").run(new Date().toISOString(),hold.id);
      event(hold,req,'started');
    });res.json(receipt(hold));
  });
  app.post('/api/holds/:id/work/report',(req,res)=>{
    const hold=authorized(req,'provider'),{note}=noteInput.parse(req.body);
    atomic(()=>{
      ensure(hold);const current=fulfillmentFor(db,hold);
      if(current.stage==='awaiting_confirmation'&&current.operatorNote===note)return;
      if(!['in_progress','changes_requested'].includes(current.stage))throw fail('Start the move or resolve the customer’s requested changes before reporting completion.',409);
      db.prepare("UPDATE fulfillments SET stage='awaiting_confirmation',reported_at=?,operator_note=? WHERE hold_id=?").run(new Date().toISOString(),note,hold.id);
      event(hold,req,'completion_reported',note);
    });res.json(receipt(hold));
  });
  app.post('/api/holds/:id/work/request-changes',(req,res)=>{
    const hold=authorized(req,'customer'),{note}=noteInput.parse(req.body);
    atomic(()=>{
      ensure(hold);if(fulfillmentFor(db,hold).stage!=='awaiting_confirmation')throw fail('Changes can be requested while reviewing the mover’s completion report.',409);
      db.prepare("UPDATE fulfillments SET stage='changes_requested',customer_note=? WHERE hold_id=?").run(note,hold.id);
      event(hold,req,'changes_requested',note);
    });res.json(receipt(hold));
  });
  app.post('/api/holds/:id/work/accept',(req,res)=>{
    const hold=authorized(req,'customer');acceptedInput.parse(req.body);
    atomic(()=>{
      ensure(hold);const current=fulfillmentFor(db,hold);
      if(['balance_due','completed'].includes(current.stage))return;
      if(current.stage!=='awaiting_confirmation')throw fail('The mover must report completion before you can accept the work.',409);
      db.prepare("UPDATE fulfillments SET stage='balance_due',accepted_at=? WHERE hold_id=?").run(new Date().toISOString(),hold.id);
      event(hold,req,'work_accepted');
    });res.json(receipt(hold));
  });
  app.post('/api/holds/:id/balance/paypal-order',async(req,res)=>{
    res.json(await balance.order(authorized(req,'customer')));
  });
  app.post('/api/holds/:id/balance/capture',async(req,res)=>{
    const hold=authorized(req,'customer');
    await balance.check(hold,req.user.name,{strict:true});
    res.json(receipt(hold));
  });
}
