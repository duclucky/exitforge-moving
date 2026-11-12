import {fulfillmentFor} from './fulfillment.js';

const fail=(message,status=409)=>Object.assign(new Error(message),{status});

// All checkout surfaces share the same order identity and capture/reconciliation lock.
export function createBalanceService({db,paypal,atomic,job}){
  const inFlight=new Map();
  function once(key,action){
    if(inFlight.has(key))return inFlight.get(key);
    const pending=Promise.resolve().then(action).finally(()=>inFlight.delete(key));
    inFlight.set(key,pending);return pending;
  }
  function current(hold){
    if(hold.status!=='booked'||!hold.paid||!hold.capture||!hold.snapshot)throw fail('A verified deposit and confirmed booking are required first.');
    const f=fulfillmentFor(db,hold);
    if(!f.paidInFull&&(f.stage!=='balance_due'||!f.acceptedAt))throw fail('Confirm the completed work before paying the final balance.');
    return f;
  }
  async function check(hold,actor,{allowCapture=true,strict=false}={}){
    const paid=await once('capture:'+hold.id+':'+(allowCapture?'write':'read'),async()=>{
      let f=current(hold);if(f.paidInFull)return true;
      if(!f.balanceOrder)return false;
      let order=await paypal.get(f.balanceOrder);
      if(order.status!=='COMPLETED'){
        if(!allowCapture)throw fail('This payment link expired. Ask the mover for a new QR code.',410);
        if(order.status!=='APPROVED'){
          return false;
        }
        order=await paypal.capture(f.balanceOrder,hold.id+'-balance');
      }
      const unit=order.purchase_units?.[0],capture=unit?.payments?.captures?.find(c=>c.status==='COMPLETED');
      if(order.id!==f.balanceOrder||order.status!=='COMPLETED'||!capture?.id||capture.id===hold.capture||unit.custom_id!==hold.id+':balance'||capture.amount?.currency_code!=='USD'||capture.amount?.value!==f.balance.toFixed(2))throw fail('Payment is not a verified final balance for this move. The job is not marked paid in full.');
      atomic(()=>{
        f=current(hold);if(f.paidInFull)return;
        db.prepare("UPDATE fulfillments SET stage='completed',balance_paid=1,balance_capture=?,completed_at=? WHERE hold_id=?").run(capture.id,new Date().toISOString(),hold.id);
        db.prepare('INSERT INTO work_events(hold_id,actor,action,note,created_at) VALUES (?,?,?,?,?)').run(hold.id,actor,'balance_paid','',new Date().toISOString());
      });return true;
    });
    if(strict&&!paid)throw fail('Approve this payment in PayPal Sandbox first. The balance is still unpaid.');
    return paid;
  }
  function order(hold,context){
    return once('order:'+hold.id,async()=>{
      const f=current(hold);if(f.paidInFull)return {id:f.balanceOrder,paid:true};
      const order=f.balanceOrder?await paypal.get(f.balanceOrder):await paypal.createBalance(hold,JSON.parse(hold.snapshot),job(hold.job).title,context);
      if(!f.balanceOrder)db.prepare('UPDATE fulfillments SET balance_order=? WHERE hold_id=? AND balance_order IS NULL').run(order.id,hold.id);
      if(order.status==='COMPLETED'){await check(hold,'Customer · payment reconciliation');return {id:order.id,paid:true};}
      const approvalUrl=order.links?.find(l=>['approve','payer-action'].includes(l.rel))?.href;
      if(!approvalUrl)return {id:order.id,approvalRequired:order.status!=='APPROVED'};
      const url=new URL(approvalUrl);
      if(url.protocol!=='https:'||!['www.sandbox.paypal.com','sandbox.paypal.com'].includes(url.hostname))throw fail('Unexpected payment destination.');
      return {id:order.id,approvalUrl:url.href};
    });
  }
  return {current,order,check};
}
