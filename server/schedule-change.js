import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { clock, planMove, resourceConflicts } from '../shared/schedule.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const windowsSchema = z.object({ pickupStart: time, pickupEnd: time, dropStart: time, dropEnd: time });
const requestSchema = windowsSchema.extend({
  note: z.string().trim().min(10).max(2000),
  confirmed: z.literal(true),
  expectedChangeId: z.uuid().nullable(),
});
const revisionSchema = z.object({ id: z.uuid(), version: z.number().int().positive() });

const latestChange = (db, holdId) => db.prepare(
  'SELECT * FROM booking_schedule_changes WHERE hold_id=? ORDER BY rowid DESC LIMIT 1',
).get(holdId);

export function bookingScheduleFor(db, holdId) {
  const latest = latestChange(db, holdId);
  if (!latest) return { schedule: null, scheduleChange: null, scheduleChangePending: false };

  const approved = latest.status === 'approved' ? latest : db.prepare(
    "SELECT * FROM booking_schedule_changes WHERE hold_id=? AND status='approved' ORDER BY rowid DESC LIMIT 1",
  ).get(holdId);
  return {
    schedule: approved ? { windows: JSON.parse(approved.windows), start: approved.start } : null,
    scheduleChange: {
      id: latest.id, version: latest.version, status: latest.status,
      windows: JSON.parse(latest.windows), note: latest.note, start: latest.start,
    },
    scheduleChangePending: latest.status !== 'approved',
  };
}

export function registerScheduleChanges(app, { db, authorized, atomic, job, allocations, receipt, event }) {
  const conflict = message => Object.assign(new Error(message), { status: 409 });

  function requireScheduled(hold) {
    const row = db.prepare('SELECT stage FROM fulfillments WHERE hold_id=?').get(hold.id);
    if (row && row.stage !== 'scheduled') throw conflict('Only a move that has not started can be rescheduled.');
  }

  function requireCurrent(hold, { id, version }) {
    const current = latestChange(db, hold.id);
    if (current?.id !== id || current.version !== version) {
      throw conflict('The schedule request changed. Reopen the move to review the latest version.');
    }
    return current;
  }

  function checkPlan(hold, change, start) {
    const revised = { ...job(hold.job), ...JSON.parse(change.windows) };
    if (Date.parse(revised.date + 'T' + start + ':00+07:00') <= Date.now()) {
      throw conflict('Choose a start time that is still in the future.');
    }
    const quote = { ...JSON.parse(hold.snapshot), start };
    const plan = planMove(revised, quote);
    if (!plan.valid) throw conflict(plan.errors.join(' '));
    if (resourceConflicts(revised.date, quote.resources, plan, allocations(), hold.id).length) {
      throw conflict('This truck or crew is reserved during the proposed schedule. Choose another start time.');
    }
    return { date: revised.date, resources: quote.resources, plan };
  }

  app.post('/api/holds/:id/schedule-change/request', (req, res) => {
    const hold = authorized(req, 'customer');
    const { expectedChangeId, note, confirmed, ...windows } = requestSchema.parse(req.body);
    if (windows.pickupStart >= windows.pickupEnd || windows.dropStart >= windows.dropEnd) {
      throw conflict('Each building access window must end after it opens.');
    }
    atomic(() => {
      requireScheduled(hold);
      if (Date.parse(job(hold.job).date + 'T20:00:00+07:00') <= Date.now()) {
        throw conflict('The booked day has passed. Contact your mover to agree on a new date.');
      }
      const current = latestChange(db, hold.id);
      const serialized = JSON.stringify(windows);
      if (current?.status !== 'approved' && current?.windows === serialized && current.note === note) return;
      if ((current?.id ?? null) !== expectedChangeId) {
        throw conflict('The schedule request changed. Reopen the move to review the latest version.');
      }
      if (current && current.status !== 'approved') {
        db.prepare("UPDATE booking_schedule_changes SET status='superseded' WHERE id=?").run(current.id);
      }
      db.prepare("INSERT INTO booking_schedule_changes (id,hold_id,status,windows,note) VALUES (?,?,'requested',?,?)")
        .run(randomUUID(), hold.id, serialized, note);
      event(hold, req, 'schedule_change_requested', note);
    });
    res.json(receipt(hold));
  });

  app.post('/api/holds/:id/schedule-change/propose', (req, res) => {
    const hold = authorized(req, 'provider');
    const input = revisionSchema.extend({ start: time }).parse(req.body);
    atomic(() => {
      requireScheduled(hold);
      const current = requireCurrent(hold, input);
      if (current.status === 'approved') throw conflict('This schedule has already been approved.');
      const { plan } = checkPlan(hold, current, input.start);
      db.prepare("UPDATE booking_schedule_changes SET status='proposed',start=?,version=version+1 WHERE id=?")
        .run(input.start, current.id);
      event(hold, req, 'schedule_change_proposed', `${input.start}–${clock(plan.end)} · GMT+7`);
    });
    res.json(receipt(hold));
  });

  app.post('/api/holds/:id/schedule-change/approve', (req, res) => {
    const hold = authorized(req, 'customer');
    const input = revisionSchema.parse(req.body);
    atomic(() => {
      const current = requireCurrent(hold, input);
      if (current.status === 'approved') return;
      requireScheduled(hold);
      if (current.status !== 'proposed') throw conflict('Your mover needs to propose a schedule first.');
      const { date, resources, plan } = checkPlan(hold, current, current.start);
      db.prepare('DELETE FROM allocations WHERE hold_id=?').run(hold.id);
      const insert = db.prepare('INSERT INTO allocations VALUES (?,?,?,?,?,?)');
      for (const resource of resources) insert.run(randomUUID(), hold.id, date, resource, plan.start, plan.reserveEnd);
      db.prepare("UPDATE booking_schedule_changes SET status='approved' WHERE id=?").run(current.id);
      event(hold, req, 'schedule_changed', `${current.start}–${clock(plan.end)} · GMT+7`);
    });
    res.json(receipt(hold));
  });
}
