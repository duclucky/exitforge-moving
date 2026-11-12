import React, { useState } from 'react';
import { Button, Field } from './ui';
import { api } from './api';

export default function AccessNotice({ onApply }) {
  const [side, setSide] = useState('drop');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function readNotice() {
    setBusy(true);
    setDraft(null);
    setError('');
    try {
      const result = await api('/survey', { notes: notice, accessSide: side });
      const start = result[side + 'Start'];
      const end = result[side + 'End'];
      const evidence = result[side + 'Evidence'];
      if (start && end && evidence) setDraft({ start, end, evidence });
      else setError('No complete window found. Enter the confirmed hours below.');
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <details className="schedule-access-notice">
    <summary>Read a building notice with AI</summary>
    <Field label="Building"><select value={side} disabled={busy} onChange={event => { setSide(event.target.value); setDraft(null); setError(''); }}>
      <option value="pickup">Pickup</option><option value="drop">Destination</option>
    </select></Field>
    <Field label="Building notice"><textarea value={notice} disabled={busy} rows={3} maxLength={6000}
      placeholder="Elevator access is available from 11:30 to 12:30."
      onChange={event => { setNotice(event.target.value); setDraft(null); setError(''); }}/>
    </Field>
    <p>Only paste the hours and relevant notice text. Remove access codes and personal details.</p>
    <Button type="button" variant="secondary" busy={busy} disabled={notice.trim().length < 10} onClick={readNotice}>Read access hours</Button>
    {draft && <div className="schedule-access-draft">
      <strong>{side === 'drop' ? 'Destination' : 'Pickup'} · {draft.start}–{draft.end}</strong>
      <blockquote>{draft.evidence}</blockquote>
      <Button type="button" variant="secondary" onClick={() => { onApply(side, draft.start, draft.end); setDraft(null); }}>Use these hours</Button>
    </div>}
    {error && <p role="status">{error}</p>}
  </details>;
}
