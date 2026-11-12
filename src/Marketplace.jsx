import React,{useEffect,useRef,useState} from 'react';
import {ArrowRight,MessageCircle,Send,CheckCircle2,Clock3,Truck,FileText} from 'lucide-react';
import {Button,Field,Tag} from './ui';
import {api} from './api';
import {money} from '../shared/schedule';
import {paymentAction} from '../shared/payments';

const stageActions={
  customer:{reserved:'Finish your deposit',booked:'Review your booked plan',awaiting_confirmation:'Inspect the completed work',changes_requested:'Follow up on requested fixes',balance_due:'Pay the final balance',needs_review:'Review your payment'},
  provider:{booked:'Start your booked move',in_progress:'Report work complete',changes_requested:'Resolve requested fixes',balance_due:'View payment progress',needs_review:'Review a late deposit'},
};
export function ActionQueue({workspace,onOpen,onMessages}){
  const {user,jobs,holds,offers,conversations=[]}=workspace,provider=user.role==='provider';
  const relevant=jobs.filter(j=>!provider||holds.some(h=>h.job===j.id)||offers.some(o=>o.jobId===j.id));
  const priority = { balance_due:0, awaiting_confirmation:1, changes_requested:2, reserved:3, completed:4 };
  const items = relevant.filter(job => !job.restricted).map(job => {
    const hold = holds.find(h => h.job === job.id);
    const change = hold?.fulfillment?.scheduleChange;
    if (hold?.fulfillment?.scheduleChangePending) {
      const label = change.status === 'proposed'
        ? (provider ? 'View your proposed schedule' : 'Review the new schedule')
        : (provider ? 'Propose a new schedule' : 'View your schedule request');
      return { job, label, priority: -1 };
    }
    const openAction = job.status === 'open' && (provider
      ? offers.some(o => o.jobId === job.id && o.status === 'outdated') && 'Renew your quote'
      : offers.some(o => o.jobId === job.id && o.status === 'offered') && 'Compare moving offers');
    const label = paymentAction(user.role, hold) || stageActions[user.role][job.status] || openAction;
    return { job, label, priority: priority[job.status] ?? 5 };
  }).filter(item => item.label).sort((a, b) => a.priority - b.priority).slice(0, 3);
  const unread=conversations.reduce((n,c)=>n+c.unread,0);
  if(!items.length&&!unread)return null;
  return <section className="action-queue" aria-label="Your next steps"><div className="section-title"><h2>Your next steps</h2><span>Keep your move moving</span></div><div className="action-grid">{unread>0&&<button className="action-card" onClick={onMessages}><span className="action-icon"><MessageCircle size={21}/></span><span><strong>{unread} unread {unread===1?'message':'messages'}</strong><small>Questions and updates from your move</small></span><ArrowRight size={18}/></button>}{items.map(({job,label})=><button className="action-card" key={job.id} onClick={()=>onOpen(job)}><span className="action-icon"><Clock3 size={21}/></span><span><strong>{label}</strong><small>{job.title}</small></span><ArrowRight size={18}/></button>)}</div></section>;
}

export function MessagesPage({workspace,onOpen}){
  const {jobs,users,user,offers,conversations=[]}=workspace;
  if(!conversations.length)return <div className="empty-state"><MessageCircle size={36}/><h2>Keep the details together.</h2><p>Open a moving offer to ask about packing, access or the agreed service.<br/>Your conversations will appear here.</p></div>;
  return <section className="message-list" aria-label="Move conversations">{conversations.map(c=>{const j=jobs.find(j=>j.id===c.job),person=users.find(u=>u.id===(user.role==='provider'?j?.owner:c.provider)),o=offers.find(o=>o.jobId===c.job&&o.provider===c.provider);return j&&<button className="thread-preview" key={c.job+c.provider} onClick={()=>onOpen(j,o?.id)}><span className="provider-logo">{person?.initials}</span><span><strong>{person?.name}<small>{j.title}</small></strong><p>{c.text}</p></span><span className="thread-meta"><time>{new Date(c.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</time>{c.unread>0&&<Tag tone="green">{c.unread} new</Tag>}<ArrowRight size={18}/></span></button>;})}</section>;
}

export function Conversation({job,offer,workspace,onChange,initialOpen=false}){
  const {user,users,conversations=[]}=workspace;
  const [opened,setOpened]=useState(initialOpen),[data,setData]=useState(null),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const toggleRef=useRef(null);
  useEffect(()=>{if(initialOpen)requestAnimationFrame(()=>toggleRef.current?.focus());},[]);
  const path=`/jobs/${job.id}/conversations/${offer.provider}`,person=users.find(u=>u.id===(user.role==='provider'?job.owner:offer.provider));
  const unread=conversations.find(c=>c.job===job.id&&c.provider===offer.provider)?.unread||0;
  useEffect(()=>{
    if(!opened)return;let live=true;
    async function load(){try{const result=await api(path);if(!live)return;setData(result);if(result.messages.some(m=>m.sender!==user.id)){await api(path+'/read',{});if(live&&unread)await onChange();}}catch(e){if(live)setError(e.message);}}
    load();const timer=setInterval(load,10000);return()=>{live=false;clearInterval(timer);};
  },[opened,path,user.id,unread,job.status]);
  async function send(e){e.preventDefault();setBusy(true);setError('');try{await api(path,{text});setText('');setData(await api(path));await onChange();}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <section className="conversation"><button ref={toggleRef} className="conversation-toggle" aria-expanded={opened} onClick={()=>setOpened(v=>!v)}><MessageCircle size={20}/><span><strong>Message {person?.name}</strong><small>Clarify this offer’s service, inventory and building access</small></span>{unread>0?<Tag tone="green">{unread} new</Tag>:<span>{opened?'Close':'Open'}</span>}</button>{opened&&<div className="conversation-body">{!data&&!error?<p role="status">Loading conversation…</p>:<><ol className="message-bubbles" aria-label="Conversation messages">{data?.messages.map(m=><li key={m.id} className={m.sender===user.id?'outgoing':''}><small>{users.find(u=>u.id===m.sender)?.name} · {new Date(m.createdAt).toLocaleString('en-US',{timeZone:'Asia/Ho_Chi_Minh',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} GMT+7</small><p>{m.text}</p></li>)}</ol>{!data?.messages.length&&<p className="muted">{data?.writable?'No messages yet. Agree on the details here before booking.':'No messages were exchanged for this offer.'}</p>}{data?.writable&&job.status!=='cancelled'?<form onSubmit={send}><Field label="Your message"><textarea value={text} onChange={e=>setText(e.target.value)} required minLength={2} maxLength={2000} rows={3} placeholder="Ask about what’s included or share an access detail."/></Field><Button type="submit" disabled={busy||text.trim().length<2} busy={busy}><Send size={16}/>Send message</Button></form>:<p className="notice">This conversation is read-only. The move is cancelled or assigned to another crew.</p>}</>}{error&&<p className="alert error" role="alert">{error}</p>}<p className="notice">Local demo conversation between sample accounts. A message does not change the accepted quote or charge a payment.</p></div>}</section>;
}

export function PostLifecycle({job,provider,offer,onChange,onToast}){
  const [opened,setOpened]=useState(false),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  if(job.status==='cancelled')return <div className="cancelled-note"><FileText size={20}/><div><strong>This move was cancelled</strong><p>{job.cancelReason}</p><small>History is retained. New offers and reservations are closed.</small></div></div>;
  if(job.status!=='open'||(provider&&(!offer||offer.status==='withdrawn')))return null;
  async function submit(e){e.preventDefault();setBusy(true);setError('');try{await api(provider?`/offers/${offer.id}/withdraw`:`/jobs/${job.id}/cancel`,provider?{}:{reason});await onChange();setOpened(false);onToast(provider?'Offer withdrawn. It can no longer be booked.':'Move cancelled. Its history is still available.');}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <section className="lifecycle-tools"><button className="text-button" onClick={()=>setOpened(v=>!v)}>{provider?'Withdraw this offer':'Cancel this move'}</button>{opened&&<form onSubmit={submit}><h4>{provider?'Withdraw your quote?':'Cancel this unbooked move?'}</h4><p>{provider?'The customer will no longer be able to reserve this offer. You can send a revised offer later.':'This closes new offers and reservations while keeping the record. A move with an unresolved payment cannot be cancelled here.'}</p>{!provider&&<Field label="Reason for cancellation"><textarea rows={2} required minLength={5} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></Field>}<div className="work-buttons"><Button type="submit" variant="secondary" busy={busy} disabled={!provider&&reason.trim().length<5}>{provider?'Confirm withdrawal':'Confirm cancellation'}</Button><Button type="button" variant="ghost" onClick={()=>setOpened(false)}>Keep {provider?'offer':'move'}</Button></div></form>}{error&&<p className="alert error" role="alert">{error}</p>}</section>;
}

export function QuoteSummary({offer,resources,hold,closed=false}){
  const team=resources.filter(r=>offer.resources.includes(r.id));
  const paid=hold?.fulfillment?.paidInFull;
  const paymentLabel=paid?`Paid in full · ${money(offer.price)}`:hold?.status==='booked'?`${money(offer.deposit)} deposit paid · ${money(offer.price-offer.deposit)} outstanding`:closed?`Recorded split: ${money(offer.deposit)} deposit · ${money(offer.price-offer.deposit)} final balance`:`${money(offer.deposit)} to book · ${money(offer.price-offer.deposit)} after acceptance`;
  return <div className="quote-summary"><div><Truck size={20}/><span><strong>{hold?.status==='booked'?'Your booked team':hold?'Your reserved team':'Your proposed team'}</strong><small>{team.map(r=>r.name).join(' · ')}</small></span></div><div><CheckCircle2 size={20}/><span><strong>{paymentLabel}</strong><small>Agreed quote {money(offer.price)} · Confirm any packing or assembly in the offer notes.</small></span></div></div>;
}
