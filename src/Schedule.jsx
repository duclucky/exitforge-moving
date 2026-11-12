import React, { useEffect, useRef, useState } from 'react';
import { Scheduler } from '@bryntum/scheduler-enterprise';
import '@bryntum/scheduler-enterprise/scheduler.css';
import '@bryntum/scheduler-enterprise/svalbard.css';
import '@bryntum/core-enterprise/fontawesome/css/fontawesome.css';
import '@bryntum/core-enterprise/fontawesome/css/solid.css';
import { planMove, clock } from '../shared/schedule';

// Bryntum client keys belong in the ignored local environment, not in source.
if(import.meta.env.VITE_BRYNTUM_LICENSE_KEY){
  window.bryntum.licenseKey=import.meta.env.VITE_BRYNTUM_LICENSE_KEY;
}
// Official one-hour presentation mode; this does not change trial entitlement.
if(import.meta.env.VITE_BRYNTUM_PRESENTATION_MODE==='true'){
  window.bryntum.demoMode();
}

const colors={load:'#366c52',travel:'#526b7b',wait:'#896132',unload:'#366c52',buffer:'#66717f'};
const labels={load:'Loading',travel:'Travel',wait:'Wait for access',unload:'Unloading',buffer:'Return buffer'};

export default function Schedule({job,offer,resources=[],allocations=[]}) {
  const host=useRef(null),instance=useRef(null);
  const [view,setView]=useState('plan');
  const [smallScreen,setSmallScreen]=useState(()=>window.matchMedia('(max-width:760px)').matches);
  useEffect(()=>{const query=window.matchMedia('(max-width:760px)'),update=()=>setSmallScreen(query.matches);query.addEventListener('change',update);return()=>query.removeEventListener('change',update);},[]);
  const plan=offer?planMove(job,offer):null;
  const compact=Boolean(plan)&&view==='plan';
  const showTimeline=!compact||!smallScreen;
  const selected=offer?resources.filter(r=>offer.resources.includes(r.id)):resources;
  const phases=plan?.phases.length?[...plan.phases,{name:'Return buffer',kind:'buffer',start:plan.end,end:plan.reserveEnd}]:[];
  const [timelineError,setTimelineError]=useState(false);

  useEffect(()=>{
    if(!host.current)return;
    setTimelineError(false);
    const day=job.date,at=m=>new Date(new Date(`${day}T00:00:00`).getTime()+m*60000);
    const rows=compact?[
      {id:'move-plan',name:'Your move'},
      {id:'pickup-access',name:`Pickup: ${job.pickupStart}–${job.pickupEnd}`},
      {id:'drop-access',name:`Drop-off: ${job.dropStart}–${job.dropEnd}`},
    ]:selected.map(r=>({id:r.id,name:r.name}));
    const events=[],assignments=[],dependencies=[];
    phases.forEach((phase,index)=>{
      const id='phase-'+index;
      events.push({id,name:`${index+1}. ${labels[phase.kind]} · ${clock(phase.start)}–${clock(phase.end)}`,startDate:at(phase.start),endDate:at(phase.end),manuallyScheduled:true,eventColor:plan.valid?colors[phase.kind]:'#a94a32',eventStyle:'filled'});
      const assigned=compact?[{id:'move-plan'}]:selected;
      assigned.forEach(r=>assignments.push({id:id+r.id,event:id,resource:r.id}));
      if(index)dependencies.push({id:'dep-'+index,fromEvent:'phase-'+(index-1),toEvent:id,type:2});
    });
    if(!compact)allocations.filter(a=>a.date===day&&selected.some(r=>r.id===a.resourceId)).forEach((a,index)=>{
      events.push({id:'busy-'+index,name:`${a.jobTitle||'Reserved move'} · ${clock(a.start)}–${clock(a.end)}`,startDate:at(a.start),endDate:at(a.end),manuallyScheduled:true,eventColor:'#66717f',eventStyle:'filled'});
      assignments.push({id:'a-'+index,event:'busy-'+index,resource:a.resourceId});
    });
    try{
      const rowHeight=compact?64:58;
      const scheduler=new Scheduler({
        appendTo:host.current,height:Math.max(260,Math.min(500,rows.length*rowHeight+112)),readOnly:true,rowHeight,barMargin:compact?14:12,
        startDate:at(phases.length?Math.max(360,plan.start-30):360),endDate:at(phases.length?Math.min(1440,Math.max(plan.reserveEnd+30,plan.start+180)):1200),
        viewPreset:'hourAndDay',tickSize:110,
        columns:[{text:compact?'Move & building access':'Crew & vehicle',field:'name',width:compact?175:170}],
        features:{eventEdit:false,eventTooltip:true,dependencies:false,resourceTimeRanges:compact},
        eventRenderer:({eventRecord,renderData})=>{
          if(!String(eventRecord.id).startsWith('phase-'))return {tag:'span',className:'calendar-booking-label',text:eventRecord.name};
          renderData.ariaLabel=eventRecord.name;
          return {tag:'span',className:'phase-number',text:String(Number(String(eventRecord.id).replace('phase-',''))+1)};
        },
        resourceTimeRanges:compact?[
          {id:'pickup-window',resourceId:'pickup-access',startDate:new Date(day+'T'+job.pickupStart+':00'),endDate:new Date(day+'T'+job.pickupEnd+':00'),name:'',timeRangeColor:'light-green'},
          {id:'drop-window',resourceId:'drop-access',startDate:new Date(day+'T'+job.dropStart+':00'),endDate:new Date(day+'T'+job.dropEnd+':00'),name:'',timeRangeColor:'light-green'},
        ]:[],
        project:{resources:rows,events,assignments,dependencies},
      });
      instance.current=scheduler;
    }catch(e){setTimelineError(true);console.error(e);}
    return()=>{instance.current?.destroy();instance.current=null;};
  },[compact,showTimeline,JSON.stringify(job),JSON.stringify(offer),JSON.stringify(resources),JSON.stringify(allocations)]);

  return <section className="schedule-wrap schedule-clean" aria-label={plan?'Moving plan and resource timeline':'Resource calendar'}>
    {plan&&<><div className="schedule-toolbar"><div><strong>Your moving plan</strong><span>{clock(plan.start)}–{clock(plan.end)} · GMT+7</span></div><div className="schedule-view-switch" role="group" aria-label="Timeline view"><button type="button" aria-pressed={view==='plan'} onClick={()=>setView('plan')}>Move plan</button><button type="button" aria-pressed={view==='resources'} onClick={()=>setView('resources')}>Crew & vehicle</button></div></div>
    <p className="crew-summary">{selected.map(r=>r.name).join(' · ')}</p></>}
    {showTimeline?<div ref={host} className="scheduler-host" aria-label={compact?'One moving timeline and two building access windows':'Individual crew and vehicle availability'}/>:<div className="mobile-access-windows"><div><span>Pickup access</span><strong>{job.pickupStart}–{job.pickupEnd}</strong></div><div><span>Drop-off access</span><strong>{job.dropStart}–{job.dropEnd}</strong></div></div>}
    {timelineError&&<p className="timeline-error" role="status">The visual timeline is unavailable. The reviewed steps and times are listed below.</p>}
    {plan&&<ol className="schedule-steps" aria-label="Moving steps">{phases.map((p,i)=><li key={p.kind}><span style={{background:colors[p.kind]}}>{i+1}</span><div><strong>{labels[p.kind]}</strong><time>{clock(p.start)}–{clock(p.end)}</time></div></li>)}</ol>}
    <div className="timeline-foot"><span>{compact?(smallScreen?'Building access windows are customer-confirmed.':'Shaded building rows show the allowed access windows.'):'All selected resources stay reserved through the return buffer. Scroll sideways for more hours.'}</span>{showTimeline&&<span>Bryntum Scheduler · Trial</span>}</div>
  </section>;
}
