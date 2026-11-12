import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, ArrowRight, AlertCircle, FileImage, X, CheckCircle2 } from 'lucide-react';
import { Button, Field, Modal, Tag } from './ui';
import { api } from './api';
import { todayInZone, minutes } from '../shared/schedule';
import {draftKeyFor,readDraft,clearDraft} from '../shared/drafts';

const sampleNotes='Pickup building: service elevator available 09:00–10:00. Destination building: elevator available 11:00–12:00. Please protect the wooden desk. Everything is packed.';
const windowKeys=['pickupStart','pickupEnd','dropStart','dropEnd'];
const sourceName={notes:'Building notes',inventory:'Item list','inventory-photo':'Room photo','pickup-message':'Pickup message image','destination-message':'Destination message image'};
function ImageInput({id,label,images,onChange,onError}){
  const image=images.find(i=>i.id===id);
  async function read(e){
    const file=e.target.files?.[0];e.target.value='';if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024){onError('Choose a PNG, JPEG or WebP image up to 2 MB.');return;}
    try{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});onChange([...images.filter(i=>i.id!==id),{id,name:file.name,dataUrl}]);}
    catch{onError('This image could not be read. Choose another file or enter its details manually.');}
  }
  return <div className="upload-slot">{image?<><img src={image.dataUrl} alt={label+' preview'}/><div><strong>{label}</strong><small>{image.name}</small><span>Ready for review · not yet saved</span></div><button type="button" className="icon-button" aria-label={'Remove '+label.toLowerCase().replace(/^add /,'')} onClick={()=>onChange(images.filter(i=>i.id!==id))}><X size={18}/></button></>:<label className="upload-label"><FileImage size={21}/><span><strong>{label}</strong><small>Optional · PNG, JPG or WebP · 2 MB max</small></span><input type="file" accept="image/png,image/jpeg,image/webp" aria-label={label} onChange={read}/></label>}</div>;
}
export default function PostMove({status,onClose,onPosted,initial}){
  const defaults=initial||{title:'',from:'',to:'',date:todayInZone(new Date(Date.now()+3*86400000)),size:'1-bedroom apartment',inventory:'',pickupStart:'',pickupEnd:'',dropStart:'',dropEnd:'',budget:220,notes:''};
  const draftKey=draftKeyFor(initial?.id);
  const [restored]=useState(()=>{try{const draft=readDraft(localStorage,draftKey);if(!initial&&!['title','from','to','inventory','notes'].some(k=>typeof draft?.form?.[k]==='string'&&draft.form[k].trim()))return null;return !initial||draft?.version===(initial.version||0)?draft:null;}catch{return null;}});
  const [form,setForm]=useState(()=>restored?.form?{...defaults,...restored.form}:defaults);
  const [step,setStep]=useState(1),[draftSaved,setDraftSaved]=useState(false),[discarding,setDiscarding]=useState(false),[recovered,setRecovered]=useState(Boolean(restored));
  const formRef=useRef(null),headingRef=useRef(null);
  const [images,setImages]=useState([]),[analysis,setAnalysis]=useState(null),[analyzing,setAnalyzing]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [reviewNotes,setReviewNotes]=useState(restored?.reviewNotes||'');
  useEffect(()=>{try{localStorage.setItem(draftKey,JSON.stringify({form,reviewNotes,version:initial?.version||0}));setDraftSaved(true);}catch{setDraftSaved(false);}},[form,reviewNotes,draftKey]);
  function goTo(next){setStep(next);requestAnimationFrame(()=>headingRef.current?.focus());}
  function resetDraft(){setForm(defaults);setReviewNotes('');setAnalysis(null);setImages([]);setConfirmed(false);setDiscarding(false);setRecovered(false);setError('');goTo(1);}
  function next(){if(!formRef.current.reportValidity())return;if(step===2&&!ordered){setError('Enter valid access windows at both buildings before reviewing.');return;}setError('');goTo(step+1);}
  const complete=windowKeys.every(k=>/^([01]\d|2[0-3]):[0-5]\d$/.test(form[k]));
  const ordered=complete&&minutes(form.pickupStart)<minutes(form.pickupEnd)&&minutes(form.dropStart)<minutes(form.dropEnd);
  function change(key,value){setForm(f=>({...f,...(key==='notes'&&analysis?Object.fromEntries(windowKeys.map(k=>[k,''])):{}),[key]:value}));setConfirmed(false);if(['notes','inventory'].includes(key))setAnalysis(null);}
  function input(key,type='text',extra={}){return <input type={type} value={form[key]} onInput={e=>change(key,type==='number'?Number(e.target.value):e.target.value)} onChange={e=>change(key,type==='number'?Number(e.target.value):e.target.value)} required {...extra}/>;}
  function updateImages(next){if(analysis)setForm(f=>({...f,...Object.fromEntries(windowKeys.map(k=>[k,'']))}));setImages(next);setAnalysis(null);setConfirmed(false);setError('');}
  async function analyze(){
    setAnalyzing(true);setError('');
    try{const result=await api('/survey',{notes:form.notes,inventory:form.inventory,images});setAnalysis(result);setReviewNotes([...result.warnings.filter(w=>!w.startsWith('Image readings')&&!w.startsWith('Some inventory items')), ...result.questions].join('\n'));setForm(f=>({...f,...Object.fromEntries(windowKeys.map(k=>[k,result[k]||'']))}));setConfirmed(false);}
    catch(e){setError(e.message);}finally{setAnalyzing(false);}
  }
  async function submit(e){
    e.preventDefault();if(step<3){next();return;}if(!confirmed||!ordered){setError('Review the inventory and valid access windows at both buildings before posting.');return;}
    setSaving(true);setError('');
    try{
      const readings=analysis?['pickup','drop'].filter(side=>analysis[side+'Source']?.endsWith('message')&&analysis[side+'Evidence']).map(side=>`${sourceName[analysis[side+'Source']]} (customer-reviewed transcription): ${analysis[side+'Evidence']}`):[];
      await api(initial?`/jobs/${initial.id}/update`:'/jobs',{...form,notes:[form.notes,...readings,reviewNotes.trim()?'Customer-reviewed notes and questions for mover:\n'+reviewNotes.trim():''].filter(Boolean).join('\n\n')});try{clearDraft(localStorage,draftKey);}catch{}await onPosted();
    }catch(e){setError(e.message);}finally{setSaving(false);}
  }
  return <Modal title={initial?'Update your move.':'Tell us about your move.'} subtitle={initial?'Saving changes requires operators to review and renew their offers. Existing quotes cannot be booked.':'A clear inventory and confirmed building access help movers prepare an accurate offer.'} onClose={onClose} wide><form ref={formRef} onSubmit={submit} className="post-form">
    <ol className="post-steps" aria-label="Posting progress">{['Move details','Inventory & access','Review & post'].map((label,i)=><li key={label} aria-current={step===i+1?'step':undefined} className={step===i+1?'current':step>i+1?'done':''}><span>{i+1}</span>{label}</li>)}</ol><div className="draft-status" role="status">{draftSaved?'Text draft saved in this browser. Images stay in this session only.':'Draft storage unavailable. Keep this form open until you finish.'}{recovered&&<span>Recovered your saved draft.</span>}{!initial&&<button type="button" className="text-button draft-reset" onClick={()=>setDiscarding(v=>!v)}>Start over</button>}</div>{discarding&&<div className="draft-discard"><p>Discard this text draft and start a new move? Posted moves are unaffected.</p><Button type="button" variant="secondary" onClick={resetDraft}>Discard draft</Button><Button type="button" variant="ghost" onClick={()=>setDiscarding(false)}>Keep draft</Button></div>}<h3 ref={headingRef} tabIndex={-1} className="post-step-title">{step===1?'Where are you moving?':step===2?'What does your crew need to know?':'One last look before you post.'}</h3>
    <fieldset disabled={analyzing||saving}><legend className="sr-only">Move details</legend>{step===1&&<div className="form-grid">
      <Field label="Give your move a name" wide>{input('title','text',{placeholder:'A fresh start in Thao Dien',minLength:5,maxLength:100})}</Field>
      <Field label="Moving from">{input('from','text',{placeholder:'Neighborhood, city',minLength:3,maxLength:200})}</Field><Field label="Moving to">{input('to','text',{placeholder:'Neighborhood, city',minLength:3,maxLength:200})}</Field>
      <Field label="Move date">{input('date','date',{min:todayInZone()})}</Field><Field label="Home size"><select value={form.size} onChange={e=>change('size',e.target.value)}>{['Furniture only','Studio apartment','1-bedroom apartment','2-bedroom apartment'].map(s=><option key={s}>{s}</option>)}</select></Field>
      <Field label="Maximum budget · USD">{input('budget','number',{min:20,max:10000,step:1})}</Field>
    </div>}
    {step===2&&<><section className="access-section"><h3>Your inventory</h3><p>List what you need moved. A room photo can help identify visible items; you review the list.</p><Field label="What needs moving?" wide><textarea value={form.inventory} onChange={e=>change('inventory',e.target.value)} required minLength={3} maxLength={3000} placeholder="12 packed boxes, a desk, 2 chairs and a bookshelf" rows={3}/></Field><ImageInput id="inventory-photo" label="Add a room photo" images={images} onChange={updateImages} onError={setError}/></section>
    <section className="access-section"><div className="section-title"><h3>Building access instructions</h3><button type="button" className="text-button" onClick={()=>change('notes',sampleNotes)}>Use sample notes</button></div><Field label="Messages from both buildings"><textarea rows={3} value={form.notes} onChange={e=>change('notes',e.target.value)} maxLength={6000} placeholder="Pickup elevator is available… Destination allows unloading…"/></Field><div className="upload-grid"><ImageInput id="pickup-message" label="Add pickup message" images={images} onChange={updateImages} onError={setError}/><ImageInput id="destination-message" label="Add destination message" images={images} onChange={updateImages} onError={setError}/></div>
      <p className="privacy-note">Only the inventory, building notes and chosen images are sent to OpenAI when you click Analyze. Addresses are excluded. Original images are not stored with the post.</p>
      <Button type="button" variant="secondary" onClick={analyze} busy={analyzing} disabled={!status?.ai||(!images.length&&form.notes.length+form.inventory.length<10)}><Sparkles size={17}/>{analyzing?'Reading your details…':'Analyze move details'}</Button>
      {!status?.ai&&<p className="muted">AI is unavailable. You can enter and confirm every detail manually.</p>}
    </section>
    {analysis&&<section className="extraction" aria-label="AI review"><div className="section-title"><h3><Sparkles size={17}/>Review the AI draft</h3><Tag>{analysis.model}</Tag></div>{analysis.items.length>0&&<><ul className="inventory-review">{analysis.items.map((item,i)=><li key={i}><strong>{item.quantity??'?'} × {item.name}</strong><small>{item.handling||'Review quantity and handling.'}</small><span>{sourceName[item.source]} · {item.evidence}</span></li>)}</ul><Button type="button" variant="secondary" onClick={()=>{setForm(f=>({...f,inventory:analysis.items.map(i=>`${i.quantity??'Quantity to confirm'} × ${i.name}${i.handling?' — '+i.handling:''}`).join('\n')}));setConfirmed(false);}}>Use this item list</Button></>}
      {['pickup','drop'].map(side=>analysis[side+'Evidence']&&<blockquote key={side}><strong>{side==='pickup'?'Pickup':'Destination'} · {sourceName[analysis[side+'Source']]}</strong><p>{analysis[side+'Evidence']}</p></blockquote>)}
      {analysis.warnings.map((w,i)=><p className="review-warning" key={i}><AlertCircle size={16}/>{w}</p>)}{analysis.questions.length>0&&<div className="review-questions"><strong>Before your crew quotes</strong><ul>{analysis.questions.map((q,i)=><li key={i}>{q}</li>)}</ul></div>}
      <Field label="Notes and questions to share with your mover"><textarea rows={3} value={reviewNotes} maxLength={2000} onChange={e=>{setReviewNotes(e.target.value);setConfirmed(false);}} placeholder="Review the draft: keep useful restrictions and questions, and remove anything you have resolved."/></Field>
    </section>}
    {!analysis&&reviewNotes&&<Field label="Recovered notes and questions for your mover"><textarea value={reviewNotes} rows={3} maxLength={2000} onChange={e=>setReviewNotes(e.target.value)}/></Field>}
    <section className="access-section"><h3>Confirm access at both ends</h3><p>Use the confirmed elevator or loading access windows for your move date. Missing AI readings stay blank.</p><div className="form-grid access-fields">{[['pickupStart','Pickup access opens'],['pickupEnd','Pickup access closes'],['dropStart','Destination access opens'],['dropEnd','Destination access closes']].map(([key,label])=><Field key={key} label={label}>{input(key,'time')}</Field>)}</div>
      {complete&&!ordered&&<p role="alert" className="alert error">Each access window must end after it starts.</p>}
    </section></>}</fieldset>
    {step===3&&<section className="post-review"><dl><div><dt>Move</dt><dd>{form.title}</dd></div><div><dt>Route</dt><dd>{form.from}<br/>→ {form.to}</dd></div><div><dt>Date & size</dt><dd>{form.date} · {form.size}</dd></div><div><dt>Budget</dt><dd>Up to ${form.budget} USD</dd></div><div><dt>Pickup access</dt><dd>{form.pickupStart}–{form.pickupEnd}</dd></div><div><dt>Destination access</dt><dd>{form.dropStart}–{form.dropEnd}</dd></div><div className="full"><dt>Inventory</dt><dd>{form.inventory}</dd></div>{(form.notes||reviewNotes)&&<div className="full"><dt>Instructions & questions for the mover</dt><dd>{[form.notes,reviewNotes].filter(Boolean).join('\n\n')}</dd></div>}</dl><p className="review-payment-note">Movers send a reviewed quote after you post. You choose a crew, pay a 20% Sandbox deposit, then approve the remaining 80% after accepting the completed work.</p>      <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} required disabled={!ordered||analyzing||saving}/>I reviewed the inventory and confirmed both building access windows for this date.</label>
      {!ordered&&<p className="muted">Enter all four access times to enable your final review.</p>}
</section>}
    {error&&<p className="alert error" role="alert"><AlertCircle size={18}/>{error}</p>}
    <div className="modal-actions"><Button type="button" variant="ghost" onClick={onClose}>Save draft & close</Button>{step>1&&<Button type="button" variant="secondary" disabled={saving||analyzing} onClick={()=>goTo(step-1)}>Back</Button>}{step<3?<Button type="button" onClick={next} disabled={analyzing}>Continue <ArrowRight size={17}/></Button>:<Button type="submit" busy={saving} disabled={!confirmed||analyzing}><CheckCircle2 size={17}/>{initial?'Save move & request fresh offers':'Post my move'} <ArrowRight size={17}/></Button>}</div>
  </form></Modal>;
}
