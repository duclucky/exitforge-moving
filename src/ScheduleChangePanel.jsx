import React, { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Button, Field, Tag } from './ui';
import { api } from './api';
import { clock, money, planMove } from '../shared/schedule';

const accessFields = [
  ['pickupStart', 'Pickup opens'], ['pickupEnd', 'Pickup closes'],
  ['dropStart', 'Destination opens'], ['dropEnd', 'Destination closes'],
];

function AccessSummary({ title, job, plan }) {
  return <div className="schedule-change-option">
    <strong>{title}</strong>
    <dl>
      <div><dt>Pickup access</dt><dd>{job.pickupStart}–{job.pickupEnd}</dd></div>
      <div><dt>Destination access</dt><dd>{job.dropStart}–{job.dropEnd}</dd></div>
      {plan && <div><dt>Crew schedule</dt><dd>{clock(plan.start)}–{clock(plan.end)} · GMT+7</dd></div>}
    </dl>
  </div>;
}

export default function ScheduleChangePanel({ hold, job, provider, onChange, onToast, renderTimeline }) {
  const { schedule, scheduleChange: change, scheduleChangePending: pending, deposit } = hold.fulfillment;
  const quote = JSON.parse(hold.snapshot);
  const [editing, setEditing] = useState(false);
  const [windows, setWindows] = useState(() => Object.fromEntries(accessFields.map(([key]) => [
    key, (pending ? change.windows : job)[key] || '',
  ])));
  const [note, setNote] = useState(pending ? change.note : '');
  const [confirmed, setConfirmed] = useState(false);
  const [start, setStart] = useState(change?.start || change?.windows.pickupStart || '');
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (provider && !change) return null;

  const currentPlan = planMove(job, { ...quote, start: schedule?.start || quote.start });
  const revisedJob = pending ? { ...job, ...change.windows } : null;
  const proposedOffer = change?.start ? { ...quote, start: change.start } : null;
  const proposedPlan = revisedJob && proposedOffer ? planMove(revisedJob, proposedOffer) : null;
  const draftPlan = provider && revisedJob && start ? planMove(revisedJob, { ...quote, start }) : null;

  function updateWindow(key, value) {
    setWindows(current => ({ ...current, [key]: value }));
    setConfirmed(false);
  }

  async function send(action, body, message) {
    setBusy(true);
    setError('');
    try {
      await api(`/holds/${hold.id}/schedule-change/${action}`, body);
      await onChange();
      setEditing(false);
      onToast(message);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="schedule-change" aria-label="Booking schedule change">
    <div className="schedule-change-heading">
      <CalendarClock size={21} aria-hidden="true"/>
      <h4>{pending ? 'Building access changed' : schedule ? 'New schedule confirmed' : 'Need to change building access?'}</h4>
      {pending && <Tag tone="amber">{change.status === 'proposed' ? 'Customer approval needed' : 'Mover proposal needed'}</Tag>}
    </div>
    {pending ? <>
      <p>The current truck and crew stay reserved until the customer approves a new schedule. The {money(deposit)} deposit still applies.</p>
      <div className="schedule-change-comparison">
        <AccessSummary title="Current booking" job={job} plan={currentPlan.valid ? currentPlan : null}/>
        <AccessSummary title={proposedPlan ? 'Proposed schedule' : 'New building hours'} job={revisedJob} plan={proposedPlan}/>
      </div>
      <p className="schedule-change-note">{change.note}</p>
      {proposedPlan && <details className="booked-timeline" onToggle={event => setExpanded(event.currentTarget.open)}>
        <summary>Preview proposed timeline</summary>
        {expanded && renderTimeline(revisedJob, proposedOffer)}
      </details>}
    </> : schedule && <p>Start at <strong>{schedule.start} GMT+7</strong>. The {money(deposit)} deposit still applies.</p>}

    {provider && pending && <form className="schedule-change-form" onSubmit={event => {
      event.preventDefault();
      if (draftPlan?.valid) send('propose', { id: change.id, version: change.version, start }, 'New schedule sent for customer approval.');
    }}>
      <Field label="Proposed start"><input type="time" value={start} required onInput={event => setStart(event.currentTarget.value)} onChange={event => setStart(event.target.value)}/></Field>
      {draftPlan && !draftPlan.valid && <p role="status">{draftPlan.errors.join(' ')}</p>}
      <Button type="submit" busy={busy} disabled={!draftPlan?.valid}>Send proposed schedule</Button>
    </form>}

    {!provider && !editing && <div className="work-buttons">
      {change?.status === 'proposed' && <Button type="button" busy={busy} onClick={() =>
        send('approve', { id: change.id, version: change.version }, 'New schedule confirmed. Your deposit still applies.')
      }>Approve new schedule</Button>}
      <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
        {pending ? 'Update building hours' : 'Report changed access'}
      </Button>
    </div>}
    {!provider && editing && <form className="schedule-change-form" onSubmit={event => {
      event.preventDefault();
      if (confirmed) send('request', { ...windows, note, confirmed, expectedChangeId: change?.id ?? null }, 'Updated building hours sent to your mover.');
    }}>
      <div className="schedule-change-fields">{accessFields.map(([key, label]) => <Field key={key} label={label}>
        <input type="time" required value={windows[key]} onInput={event => updateWindow(key, event.currentTarget.value)} onChange={event => updateWindow(key, event.target.value)}/>
      </Field>)}</div>
      <Field label="What changed?"><textarea rows={2} minLength={10} maxLength={2000} required value={note} onChange={event => setNote(event.target.value)}/></Field>
      <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I confirmed both access windows with the buildings.</label>
      <div className="work-buttons">
        <Button type="submit" busy={busy} disabled={!confirmed}>Send updated hours</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Cancel edit</Button>
      </div>
    </form>}
    {error && <p className="alert error" role="alert">{error}</p>}
  </section>;
}
