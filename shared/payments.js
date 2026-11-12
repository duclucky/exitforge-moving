const cents=value=>Math.round(Number(value||0)*100);
const pending=new Set(['SUBMITTING','PENDING','PROCESSING','ONHOLD']);

export function platformFeeFor(price, basisPoints) {
  const totalCents = cents(price);
  const roundedFee = Math.round(totalCents * basisPoints / 10000);
  return Math.min(roundedFee, Math.max(0, totalCents - 1));
}

export function quoteSettlement(quote) {
  const totalCents = cents(quote.price);
  const recordedFee = quote.platformFeeCents;
  const feeCents = Number.isInteger(recordedFee) && recordedFee >= 0 && recordedFee < totalCents ? recordedFee : 0;
  return { totalCents, feeCents, payoutCents: totalCents - feeCents };
}

export function paymentAction(role,hold){
  if(!hold)return null;
  if(hold.status==='needs_review')return 'Review your payment';
  const f=hold.fulfillment,p=f?.payout;
  if(role==='customer')return f?.stage==='balance_due'?'Pay the final balance':hold.status==='held'?'Finish your deposit':null;
  if(!f?.paidInFull||p?.status==='SUCCESS')return null;
  if(p?.status==='READY')return 'Receive crew payment';
  if(pending.has(p?.status))return 'Track crew payment';
  return 'Review crew payment';
}

export function paymentOverview(workspace){
  const provider=workspace.user.role==='provider';
  const unique=new Map([...(workspace.paymentHistory||[]),...workspace.holds].map(h=>[h.id,h]));
  const rows=[...unique.values()].filter(h=>h.snapshot&&(provider?h.status==='booked'||h.status==='needs_review':h.paid||h.paypal_order||h.fulfillment)).map(h=>{
    const q=JSON.parse(h.snapshot),f=h.fulfillment,p=f?.payout,j=workspace.jobs.find(j=>j.id===h.job);
    const depositPaid=Boolean(h.paid&&h.capture),finalPaid=Boolean(f?.paidInFull&&f.balanceCapture);
    const paidCents=(depositPaid?cents(q.deposit):0)+(finalPaid?cents(q.price)-cents(q.deposit):0);
    const dueCents=h.status==='booked'&&depositPaid&&!finalPaid?cents(q.price)-cents(q.deposit):0;
    const settled=p?.status==='SUCCESS'&&p.received===true&&Boolean(p.transactionId);
    const action=paymentAction(workspace.user.role,h);
    const label=h.status==='needs_review'?'Payment review':settled?'Crew payment received':finalPaid?(p?.status==='READY'?'Ready for crew payment':pending.has(p?.status)?'Crew payment processing':p?.status==='NOT_CONFIGURED'?'Crew payment setup needed':p?.status&&p.status!=='NOT_READY'?'Crew payment needs review':'Customer paid in full'):depositPaid?(f?.stage==='balance_due'?'Final payment due':'Deposit paid'):'Checkout not confirmed';
    return{id:h.id,hold:h,job:j,title:j?.title||'Previous reservation',date:j?.date||'',provider:q.provider,total:cents(q.price)/100,paid:paidCents/100,due:dueCents/100,received:settled?cents(p.amount)/100:0,awaitingSettlement:finalPaid&&!settled?(p?.amount??quoteSettlement(q).payoutCents/100):0,settled,attention:provider?Boolean(action):Boolean(action)||h.status==='expired',action,label};
  }).sort((a,b)=>Number(b.attention)-Number(a.attention)||b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  const sum=key=>rows.reduce((n,r)=>n+cents(r[key]),0)/100;
  return{rows,customerPaid:sum('paid'),customerDue:sum('due'),received:sum('received'),awaitingSettlement:sum('awaitingSettlement')};
}
