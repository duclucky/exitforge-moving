import React, { useState } from 'react';
import { CheckCircle2, Play, Send, Wallet, AlertCircle, FileDown, ArrowUpRight } from 'lucide-react';
import { Button, Field, Tag } from './ui';
import { api } from './api';
import { money } from '../shared/schedule';
import PayoutPanel from './PayoutPanel';
import ScheduleChangePanel from './ScheduleChangePanel';
import {QrPaymentPanel} from './QrPayment';

const titles={scheduled:'Your crew is booked',in_progress:'The move is in progress',awaiting_confirmation:'Review the completed work',changes_requested:'Changes requested',balance_due:'Work accepted · final payment due',completed:'Move completed · paid in full'};
const eventLabels={schedule_change_requested:'Building hours updated',schedule_change_proposed:'New schedule proposed',schedule_changed:'New schedule confirmed',started:'Move started',completion_reported:'Completion reported',changes_requested:'Changes requested',work_accepted:'Customer accepted the work',balance_paid:'Final payment verified',provider_payout_requested:'Moving-team payout requested',provider_payout_received:'Moving-team payment received'};

export default function FulfillmentPanel({hold,job,provider,status,onChange,onToast,renderTimeline}){
  const f=hold.fulfillment;
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[note,setNote]=useState(''),[confirmed,setConfirmed]=useState(false),[requestingChanges,setRequestingChanges]=useState(false);
  if(!f)return null;
  async function action(path,body,message){
    setBusy(path);setError('');
    try{await api(`/holds/${hold.id}${path}`,body);await onChange();setNote('');setConfirmed(false);setRequestingChanges(false);onToast(message);}
    catch(e){setError(e.message);}finally{setBusy('');}
  }
  async function pay(){
    setBusy('pay');setError('');
    try{
      const order=await api(`/holds/${hold.id}/balance/paypal-order`,{});
      if(order.paid){await onChange();return;}
      if(!order.approvalUrl)throw new Error('Check the existing final payment before continuing.');
      const url=new URL(order.approvalUrl);
      if(url.protocol!=='https:'||!['www.sandbox.paypal.com','sandbox.paypal.com'].includes(url.hostname))throw new Error('Unexpected payment destination.');
      location.assign(url.href);
    }catch(e){setError(e.message);setBusy('');}
  }
  return <section className={`fulfillment-panel ${f.stage==='completed'?'fully-paid':''}`} aria-label="Work and payment status">
    <div className="fulfillment-heading"><CheckCircle2 size={25}/><div><h3>{titles[f.stage]}</h3><p>{f.stage==='completed'?'Both Sandbox payments are verified. No balance remains.':'Deposit confirmed. The final balance is paid only after customer acceptance.'}</p></div><Tag tone="green">{f.paidInFull?'Paid in full':'Deposit paid'}</Tag></div>
    <dl className="payment-totals"><div><dt>Agreed total</dt><dd>{money(f.total)}</dd></div><div><dt>Deposit paid · 20%</dt><dd>{money(f.deposit)}</dd></div><div><dt>{f.paidInFull?'Final balance paid · 80%':'Remaining balance · 80%'}</dt><dd>{money(f.balance)}</dd></div></dl>
    {f.stage==='scheduled'&&<>
      <ScheduleChangePanel key={`${f.scheduleChange?.id}:${f.scheduleChange?.version}:${f.scheduleChange?.status}`} hold={hold} job={job} provider={provider} canAnalyze={status?.ai} onChange={onChange} onToast={onToast} renderTimeline={renderTimeline}/>
      <div className="work-action">
        <p>{f.scheduleChangePending?'Work can start after the customer approves the updated schedule.':provider?'Start this move when your crew begins the agreed work.':'Your mover will update the job when the work starts. You do not pay the remaining balance yet.'}</p>
        {provider&&<Button onClick={()=>action('/work/start',{},'Move started. The customer can follow its progress.')} busy={busy==='/work/start'} disabled={Boolean(busy)||f.scheduleChangePending}><Play size={17}/>Start move</Button>}
      </div>
    </>}
    {f.stage==='in_progress'&&!provider&&<p className="work-copy">Your crew is working. The mover must report completion before you can review and pay the remaining balance.</p>}
    {f.stage==='changes_requested'&&<div className="work-attention"><strong>Customer’s requested changes</strong><p>{f.customerNote}</p><small>{provider?'Resolve these points, then send a new completion report.':'Your mover must address this request and report completion again before final payment.'}</small></div>}
    {provider&&['in_progress','changes_requested'].includes(f.stage)&&<form className="work-report" onSubmit={e=>{e.preventDefault();action('/work/report',{note},'Completion reported. Waiting for the customer’s review.');}}><Field label="Completion report"><textarea value={note} onChange={e=>setNote(e.target.value)} required minLength={10} maxLength={2000} rows={3} placeholder="Describe the completed delivery and anything the customer should inspect."/></Field><Button type="submit" disabled={Boolean(busy)||note.trim().length<10} busy={busy==='/work/report'}><Send size={17}/>Report work complete</Button></form>}
    {f.stage==='awaiting_confirmation'&&<div className="work-review"><div className="completion-note"><strong>Mover’s completion report</strong><p>{f.operatorNote}</p></div>{provider?<p className="work-copy">Waiting for the customer to inspect and accept the work. Reporting completion does not charge the customer.</p>:<><p className="work-copy">Check that the agreed items have arrived and the service scope is complete. You can request fixes before accepting.</p><label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>I inspected the completed move and accept the agreed work.</label><div className="work-buttons"><Button disabled={!confirmed||Boolean(busy)} busy={busy==='/work/accept'} onClick={()=>action('/work/accept',{confirmed:true},'Work accepted. Review and pay the final balance through PayPal Sandbox.')}><CheckCircle2 size={17}/>Accept work & review final payment</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={()=>setRequestingChanges(v=>!v)}>Request a fix</Button></div>{requestingChanges&&<form className="work-report" onSubmit={e=>{e.preventDefault();action('/work/request-changes',{note},'Request sent. Final payment is blocked until the work is reported and accepted again.');}}><Field label="What still needs attention?"><textarea value={note} onChange={e=>setNote(e.target.value)} required minLength={10} maxLength={2000} rows={3} placeholder="Describe what the mover needs to resolve."/></Field><Button type="submit" variant="secondary" disabled={Boolean(busy)||note.trim().length<10} busy={busy==='/work/request-changes'}>Send request to mover</Button></form>}</>}</div>}
    {f.stage==='balance_due'&&<div className="balance-checkout"><h4>{provider?'Waiting for the customer’s final payment':`Final payment: ${money(f.balanceDue)}`}</h4><p>{provider?'The customer accepted the work. The job closes after PayPal verifies the remaining payment.':'You accepted the work. PayPal will ask you to approve this remaining balance separately; accepting work does not charge you.'}</p>{!provider&&<div className="work-buttons"><Button onClick={pay} busy={busy==='pay'} disabled={!status?.paypal||Boolean(busy)}><Wallet size={18}/>Pay {money(f.balanceDue)} with PayPal Sandbox <ArrowUpRight size={16}/></Button>{f.balanceOrder&&<Button variant="secondary" disabled={Boolean(busy)} busy={busy==='/balance/capture'} onClick={()=>action('/balance/capture',{},'Final payment verified. The move is completed and paid in full.')}>Check final payment</Button>}{!status?.paypal&&<p className="alert">PayPal Sandbox is not connected. The balance remains unpaid.</p>}</div>}</div>}
    {provider&&f.stage==='balance_due'&&<QrPaymentPanel hold={hold} onChange={onChange}/>}
    {f.paidInFull&&<div className="paid-total"><CheckCircle2 size={19}/><strong>Total paid: {money(f.amountPaid)}</strong><span>Outstanding: {money(f.balanceDue)}</span></div>}
    <div className="receipt-actions"><a className="button secondary" href={`/api/holds/${hold.id}/receipt?download=1`} download><FileDown size={17}/>Download payment receipt</a><span>{f.paidInFull?'Deposit and final payment recorded':'Receipt shows the deposit and unpaid balance'}</span></div>
    {f.events.length>0&&<details className="work-history"><summary>Work and payment activity</summary><ol>{f.events.map((event,i)=><li key={i}><strong>{eventLabels[event.action]||event.action}</strong><small>{event.actor} · {new Date(event.createdAt).toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} GMT+7</small>{event.note&&<p>{event.note}</p>}</li>)}</ol></details>}
    {error&&<p className="alert error" role="alert"><AlertCircle size={18}/>{error}</p>}
    {f.paidInFull&&<PayoutPanel hold={hold} provider={provider} onChange={onChange} onToast={onToast}/>}
    <p className="notice">Customer payments go to the platform test merchant. Moving-team receipt is confirmed separately through PayPal Sandbox Payouts.</p>
  </section>;
}
