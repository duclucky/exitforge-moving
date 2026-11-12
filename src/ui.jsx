import React, { useEffect, useId, useRef } from 'react';
import { Loader2, X } from 'lucide-react';

export function Button({children,variant='',className='',busy=false,...props}) {
  return <button {...props} aria-busy={busy||undefined} disabled={props.disabled||busy} className={`button ${variant} ${className}`}>{busy&&<Loader2 size={17} className="spin" aria-hidden="true"/>}{children}</button>;
}
export function Tag({children,tone=''}) {return <span className={`tag ${tone}`}>{children}</span>;}
export function Field({label,children,wide=false}) {return <label className={`field ${wide?'full':''}`}><span>{label}</span>{children}</label>;}
export function Modal({title,subtitle,onClose,children,wide=false}) {
  const dialog=useRef(null),titleId=useId(),subtitleId=useId();
  useEffect(()=>{
    const previous=document.activeElement;
    dialog.current.showModal();
    const oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=oldOverflow;previous?.focus?.();};
  },[]);
  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={subtitle?subtitleId:undefined} className={`modal ${wide?'wide':''}`} onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{
    if(e.target!==dialog.current)return;
    const r=dialog.current.getBoundingClientRect();
    if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)onClose();
  }}><div className="modal-head"><div><h2 id={titleId}>{title}</h2>{subtitle&&<p id={subtitleId}>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}
