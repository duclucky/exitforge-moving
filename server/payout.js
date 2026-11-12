import { quoteSettlement } from '../shared/payments.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const recipientFor=(env,provider)=>env[`PAYPAL_${provider.toUpperCase()}_RECIPIENT`];
const rowFor=(db,id)=>db.prepare('SELECT * FROM provider_settlements WHERE hold_id=?').get(id);

export function payoutFor(db,hold,env={}){
  const quote=JSON.parse(hold.snapshot),row=rowFor(db,hold.id),full=db.prepare('SELECT balance_paid FROM fulfillments WHERE hold_id=?').get(hold.id)?.balance_paid;
  const configured=Boolean(row?.receiver||recipientFor(env,quote.provider));
  const settlement = quoteSettlement(quote);
  const amountCents = row?.amount_cents ?? settlement.payoutCents;
  return{status:row?.status||(full?(configured?'READY':'NOT_CONFIGURED'):'NOT_READY'),configured,received:row?.status==='SUCCESS',amount:amountCents/100,grossAmount:settlement.totalCents/100,platformFee:(settlement.totalCents-amountCents)/100,currency:'USD',environment:'PayPal Sandbox',batchId:row?.batch_id||null,itemId:row?.item_id||null,transactionId:row?.transaction_id||null,lastError:row?.last_error||'',updatedAt:row?.updated_at||null};
}

export function registerPayout(app,{db,paypal,atomic,env}){
  const inFlight=new Map();
  function authorized(req,providerOnly=false){
    const hold=db.prepare('SELECT * FROM holds WHERE id=?').get(req.params.id);
    if(!hold?.snapshot)throw fail('Booked move not found.',404);
    const quote=JSON.parse(hold.snapshot),provider=req.user.role==='provider'&&quote.provider===req.user.id,customer=req.user.role==='customer'&&hold.owner===req.user.id;
    if(!provider&&(!customer||providerOnly))throw fail('Only the selected mover can request this payout; payment status is private to the booking.',403);
    return hold;
  }
  function eligible(hold){
    const f=db.prepare('SELECT * FROM fulfillments WHERE hold_id=?').get(hold.id);
    if(hold.status!=='booked'||!hold.paid||!hold.capture||!f?.balance_paid||!f.balance_capture||f.stage!=='completed'||!f.accepted_at)throw fail('A payout requires accepted work and both verified customer payments.',409);
  }
  function recordEvent(hold,action){db.prepare('INSERT INTO work_events(hold_id,actor,action,note,created_at) VALUES (?,?,?,?,?)').run(hold.id,'ExitForge Sandbox',action,'',new Date().toISOString());}
  function apply(hold,row,result){
    const header=result.batch_header;
    if(!header?.payout_batch_id||header.sender_batch_header?.sender_batch_id!==row.batch_key||(row.batch_id&&header.payout_batch_id!==row.batch_id))throw fail('The payout response does not match this move. Provider payment is not confirmed.',409);
    const item=result.items?.find(i=>i.payout_item?.sender_item_id===row.item_key);
    if(item&&(item.payout_item.receiver!==row.receiver||item.payout_item.recipient_type!=='PAYPAL_ID'||item.payout_item.amount?.currency!=='USD'||item.payout_item.amount?.value!==(row.amount_cents/100).toFixed(2)))throw fail('The payout amount or recipient does not match this move. Provider payment is not confirmed.',409);
    const status=item?.transaction_status||(['DENIED','CANCELED'].includes(header.batch_status)?header.batch_status:'PENDING');
    if(status==='SUCCESS'&&(!item?.transaction_id||!item?.payout_item_id))throw fail('The completed payout is missing its transaction reference.',409);
    atomic(()=>{
      const before=rowFor(db,hold.id);
      db.prepare('UPDATE provider_settlements SET batch_id=?,item_id=?,transaction_id=?,status=?,last_error=?,updated_at=? WHERE hold_id=?').run(header.payout_batch_id,item?.payout_item_id||before.item_id,item?.transaction_id||before.transaction_id,status,item?.errors?.name||'',new Date().toISOString(),hold.id);
      if(status==='SUCCESS'&&before.status!=='SUCCESS')recordEvent(hold,'provider_payout_received');
    });return payoutFor(db,hold,env);
  }
  async function submit(hold){
    eligible(hold);let row=rowFor(db,hold.id);
    if(row?.batch_id)return apply(hold,row,await paypal.getPayout(row.batch_id));
    if(!row){
      const quote = JSON.parse(hold.snapshot);
      const provider = quote.provider;
      const receiver = recipientFor(env, provider);
      if(!receiver)throw fail('A dedicated PayPal Sandbox recipient has not been configured for this mover.',503);
      if(!/^[A-Z0-9]{10,20}$/.test(receiver))throw fail('The configured Sandbox recipient ID is invalid.',503);
      const amount=quoteSettlement(quote).payoutCents,now=new Date().toISOString();
      atomic(()=>{db.prepare("INSERT OR IGNORE INTO provider_settlements(hold_id,provider,receiver,amount_cents,batch_key,item_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'SUBMITTING',?,?)").run(hold.id,provider,receiver,amount,hold.id,'move-'+hold.id,now,now);recordEvent(hold,'provider_payout_requested');});
      row=rowFor(db,hold.id);
    }
    if(Date.now()-Date.parse(row.created_at)>29*86400000)throw fail('This uncertain payout is too old to retry safely. Review it with PayPal before any new payment.',409);
    try{
      const result=await paypal.createPayout(row);
      const updated=apply(hold,row,result);
      return updated;
    }catch(error){
      if(error.status===409)throw error;
      db.prepare("UPDATE provider_settlements SET status='UNCERTAIN',last_error=?,updated_at=? WHERE hold_id=? AND batch_id IS NULL").run(error.code||'SUBMISSION_UNCONFIRMED',new Date().toISOString(),hold.id);
      throw fail('The payout submission is not confirmed. Recheck using the same request; do not send another payment manually.',502);
    }
  }
  app.post('/api/holds/:id/payout',async(req,res)=>{
    const hold=authorized(req,true);
    if(!inFlight.has(hold.id)){const promise=submit(hold).finally(()=>inFlight.delete(hold.id));inFlight.set(hold.id,promise);}
    res.json(await inFlight.get(hold.id));
  });
  app.post('/api/holds/:id/payout/check',async(req,res)=>{
    const hold=authorized(req),row=rowFor(db,hold.id);
    if(!row?.batch_id)throw fail('No payout batch has been confirmed yet. The selected mover can retry the original request.',409);
    res.json(apply(hold,row,await paypal.getPayout(row.batch_id)));
  });
}
