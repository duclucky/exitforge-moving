import React,{useEffect,useRef,useState} from 'react';
import {CheckCircle2,AlertCircle,Copy,ExternalLink,QrCode,ShieldCheck,Wallet,Truck,ArrowUpRight} from 'lucide-react';
import {api} from './api';
import {Button,Tag} from './ui';
import {money} from '../shared/schedule';
import './qr-payment.css';

const storageKey=id=>'exitforge-qr-payment:'+id;
export function paymentRoute(){
  const token=/^\/pay\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1];
  if(token){const params=new URLSearchParams(location.search);return {token,cancelled:params.has('cancelled'),returned:params.has('approved')};}
  const params=new URLSearchParams(location.search),id=params.get('balance_payment')||params.get('balance_cancelled');
  if(id){try{const saved=sessionStorage.getItem(storageKey(id));if(saved)return {token:saved,cancelled:params.has('balance_cancelled'),returned:params.has('balance_payment')};}catch{/* The original QR link remains available when browser storage is disabled. */}}
  if(location.pathname==='/pay'||location.pathname.startsWith('/pay/'))return {token:null};
  return null;
}

export function QrPaymentPanel({hold,onChange}){
  const [link,setLink]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false),[now,setNow]=useState(Date.now());
  const refreshing=useRef(false),change=useRef(onChange);change.current=onChange;
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    if(!link)return;
    let stopped=false;
    const check=async()=>{
      if(refreshing.current)return;refreshing.current=true;
      try{const result=await api('/public-payments/'+link.url.split('/').pop()+'/check',{});if(!stopped&&result.paid)await change.current();}
      catch(e){if(!stopped&&e.status!==410)setError(e.message);}
      finally{refreshing.current=false;}
    };
    const timer=setInterval(check,5000);window.addEventListener('focus',check);
    return()=>{stopped=true;clearInterval(timer);window.removeEventListener('focus',check);};
  },[link]);
  async function generate(){setBusy(true);setError('');setCopied(false);try{setLink(await api('/holds/'+hold.id+'/payment-link',{}));setNow(Date.now());}catch(e){setError(e.message);}finally{setBusy(false);}}
  const seconds=link?Math.max(0,Math.ceil((new Date(link.expiresAt).getTime()-now)/1000)):0;
  return <div className="qr-panel">
    <div className="qr-heading"><QrCode size={22}/><div><h4>Let the customer pay by phone</h4><p>Create a QR for this move’s remaining balance.</p></div></div>
    {!link?<Button variant="secondary" busy={busy} onClick={generate}><QrCode size={18}/>Create payment QR</Button>:<div className="qr-content">
      <div className={'qr-image-wrap '+(!seconds?'qr-expired':'')}><img src={link.qrImage} width="240" height="240" alt={`Scan to review the ${money(link.balanceDue)} final payment for this move`}/>{!seconds&&<strong>QR expired</strong>}</div>
      <div className="qr-instructions"><span className="eyebrow">FINAL PAYMENT · SANDBOX</span><strong className="qr-amount">{money(link.balanceDue)}</strong><p>The customer scans, reviews the amount, then approves in PayPal Sandbox. This screen updates after verification.</p>
        <span className="qr-expiry" role="status">{seconds?`Expires in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`:'Ask the customer to use a new QR code.'}</span>
        <div className="qr-buttons"><Button variant="secondary" disabled={!seconds} onClick={async()=>{try{await navigator.clipboard.writeText(link.url);setCopied(true);}catch{setError('Copy is unavailable. Open the payment page and copy its address.');}}}><Copy size={16}/>{copied?'Link copied':'Copy link'}</Button>
          {seconds>0&&<a className="button ghost" href={link.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16}/>Open payment page</a>}
          {!seconds&&<Button busy={busy} onClick={generate}>Create a new QR</Button>}</div>
        <small>Only share this link with the paying customer. It grants access to this payment only.</small>
      </div></div>}
    {error&&<p className="alert error" role="alert"><AlertCircle size={18}/>{error}</p>}
  </div>;
}

export default function PublicPaymentPage({token,cancelled=false,returned=false}){
  const [info,setInfo]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(''),[loading,setLoading]=useState(true),[now,setNow]=useState(Date.now());
  const path='/public-payments/'+token;
  useEffect(()=>{
    let stopped=false;
    (async()=>{try{
      if(!token)throw new Error('This payment link is incomplete. Ask your mover for a new QR code.');
      if(returned||cancelled)history.replaceState(null,'','/pay/'+token);
      const data=await api(path);if(stopped)return;setInfo(data);
      if(returned&&!data.paid){try{const result=await api(path+'/check',{});if(!stopped)setInfo(result);}catch(e){if(!stopped)setError(e.message);}}
    }catch(e){if(!stopped)setError(e.message);}finally{if(!stopped)setLoading(false);}})();
    const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{stopped=true;clearInterval(timer);};
  },[token,returned,path]);
  useEffect(()=>{
    if(!info||info.paid)return;
    let stopped=false;
    const timer=setInterval(async()=>{try{const data=await api(path);if(!stopped)setInfo(data);}catch{/* Keep the last verified state visible during a brief connection failure. */}},10000);
    return()=>{stopped=true;clearInterval(timer);};
  },[info?.paid,path,Boolean(info)]);
  async function check(){setBusy('check');setError('');try{const data=await api(path+'/check',{});setInfo(data);if(!data.paid)setError('Payment is not approved yet. Continue to PayPal, or retry after approval.');}catch(e){setError(e.message);}finally{setBusy('');}}
  async function pay(){
    setBusy('pay');setError('');
    try{
      const order=await api(path+'/paypal-order',{});
      if(order.paid){setInfo(await api(path));setBusy('');return;}
      if(!order.approvalUrl){await check();return;}
      const url=new URL(order.approvalUrl);
      if(url.protocol!=='https:'||!['www.sandbox.paypal.com','sandbox.paypal.com'].includes(url.hostname))throw new Error('Unexpected payment destination.');
      try{sessionStorage.setItem(storageKey(info.reservationId),token);}catch{throw new Error('Allow site storage in this browser so PayPal can return to your payment.');}
      location.assign(url.href);
    }catch(e){setError(e.message);setBusy('');}
  }
  const expired=info&&!info.paid&&new Date(info.expiresAt).getTime()<=now;
  return <main className="public-payment">
    <header className="payment-brand"><span className="brand-mark"><Truck size={22}/></span><strong>ExitForge</strong><Tag>Sandbox demo</Tag></header>
    <section className="public-payment-card" aria-busy={loading}>
      {loading?<p role="status">Loading your payment…</p>:info?<>
        <div className={'payment-state-icon '+(info.paid?'success':'')}>{info.paid?<CheckCircle2 size={30}/>:<Wallet size={30}/>}</div>
        <span className="eyebrow">{info.paid?'PAYMENT VERIFIED':'YOUR MOVE · FINAL PAYMENT'}</span>
        <h1>{info.paid?'You’re all paid up.':expired?'This QR has expired.':'A smooth finish to your move.'}</h1>
        <p className="payment-intro">{info.paid?'Your final payment is verified. The moving team can see the update.':expired?'Ask your moving team for a fresh QR. Your agreed amount stays the same.':'Your completed work has been accepted. Review the remaining amount before continuing to PayPal.'}</p>
        <div className="payment-job"><Truck size={20}/><div><strong>{info.title}</strong><span>Moving team · {info.provider}</span></div></div>
        <dl className="public-payment-totals"><div><dt>Agreed total</dt><dd>{money(info.total)}</dd></div><div><dt>Deposit already paid</dt><dd>−{money(info.deposit)}</dd></div><div className="payment-due"><dt>{info.paid?'Amount due':'Pay today'}</dt><dd>{money(info.balanceDue)} <small>USD</small></dd></div></dl>
        {!info.paid&&<>
          {cancelled&&<p className="alert" role="status">Checkout was cancelled. This balance is still unpaid; you can try again.</p>}
          <Button className="public-pay-button" onClick={pay} busy={busy==='pay'} disabled={Boolean(busy)||expired}>Continue to PayPal Sandbox <ArrowUpRight size={18}/></Button>
          <Button variant="ghost" onClick={check} busy={busy==='check'} disabled={Boolean(busy)}>Already approved? Check payment</Button>
          {!expired&&<p className="payment-link-expiry">Link expires at {new Date(info.expiresAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})} on this device.</p>}
        </>}
        <p className="payment-trust"><ShieldCheck size={18}/>{info.paid?'No further payment is required for this move.':'Approve securely on PayPal. Scanning this QR does not charge you.'}</p>
      </>:<><AlertCircle size={32}/><h1>Payment link unavailable</h1><p>Ask the moving team for a fresh payment QR.</p></>}
      {error&&<p className="alert error" role="alert"><AlertCircle size={18}/>{error}</p>}
    </section>
    <footer className="payment-disclosure">PayPal Sandbox · test money only. Payments go to the platform test merchant; moving-team settlement is tracked separately. You never enter a PayPal password on ExitForge.</footer>
  </main>;
}
