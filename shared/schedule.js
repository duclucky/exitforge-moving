const SHIFT_START = 360;
const SHIFT_END = 1200;
const ACCESS_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACCESS_FIELDS = ['pickupStart', 'pickupEnd', 'dropStart', 'dropEnd'];
export const DEFAULT_RESCHEDULE_NOTICE_HOURS = 24;
const deadlineFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23',
});

export function rescheduleDeadline(date, quote) {
  if (!Number.isInteger(quote?.rescheduleNoticeHours) || quote.rescheduleNoticeHours < 1) return null;
  const start = Date.parse(date + 'T' + quote.start + ':00+07:00');
  return Number.isFinite(start) ? start - quote.rescheduleNoticeHours * 3600000 : null;
}

export function formatRescheduleDeadline(deadline) {
  return deadlineFormat.format(deadline) + ' GMT+7';
}

export const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
export function todayInZone(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
}
export function isMoveDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function minutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  if (!match || +match[1] > 23 || +match[2] > 59) throw new Error('Enter a valid 24-hour time.');
  return +match[1] * 60 + +match[2];
}
export function planMove(job, offer) {
  if (!job || !ACCESS_FIELDS.every(key => ACCESS_TIME.test(job[key] || ''))) return {valid:false,errors:['Confirm complete access windows at both buildings first.'],start:0,end:0,reserveEnd:0,phases:[]};
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(offer.start || '') || ![offer.loadMinutes,offer.travelMinutes,offer.unloadMinutes].every(n=>Number.isFinite(n)&&n>0)) return {valid:false,errors:['Enter a valid start time and positive task durations.'],start:0,end:0,reserveEnd:0,phases:[]};
  const start = minutes(offer.start);
  const loaded = start + offer.loadMinutes;
  const arrived = loaded + offer.travelMinutes;
  const unloadStart = Math.max(arrived, minutes(job.dropStart));
  const end = unloadStart + offer.unloadMinutes;
  const errors = [];
  if (start < minutes(job.pickupStart)) errors.push(`Loading begins before the pickup window opens at ${job.pickupStart}.`);
  if (loaded > minutes(job.pickupEnd)) errors.push(`Loading ends at ${clock(loaded)}, after pickup access closes at ${job.pickupEnd}.`);
  if (end > minutes(job.dropEnd)) errors.push(`Unloading ends at ${clock(end)}, after destination access closes at ${job.dropEnd}.`);
  if (start < SHIFT_START || end + 15 > SHIFT_END) errors.push('The move must fit the operator shift of 06:00–20:00, including a 15-minute return buffer.');
  const phases = [
    { name: 'Load', start, end: loaded, kind: 'load' },
    { name: 'Travel', start: loaded, end: arrived, kind: 'travel' },
    ...(unloadStart > arrived ? [{ name: 'Wait for access', start: arrived, end: unloadStart, kind: 'wait' }] : []),
    { name: 'Unload', start: unloadStart, end, kind: 'unload' },
  ];
  return { valid: errors.length === 0, errors, start, end, reserveEnd: end + 15, phases };
}
export function resourceConflicts(date, resourceIds, plan, allocations, excludeHold = null) {
  return allocations.filter(a => a.date === date && resourceIds.includes(a.resourceId) && a.holdId !== excludeHold && plan.start < a.end && a.start < plan.reserveEnd);
}
export function suggestPlans(job, estimate, allocations, limit = 3, notBefore = SHIFT_START) {
  if (!job || !ACCESS_FIELDS.every(key => ACCESS_TIME.test(job[key] || ''))) return [];
  const result=[];
  for (let start=Math.max(SHIFT_START,notBefore,minutes(job.pickupStart)); start<minutes(job.pickupEnd); start+=15) {
    const candidate={...estimate,start:clock(start)};
    const plan=planMove(job,candidate);
    if (plan.valid&&!resourceConflicts(job.date,candidate.resources,plan,allocations).length) result.push(candidate);
    if(result.length===limit)break;
  }
  return result;
}

export function diagnosePlans(job, estimate, teams, allocations, notBefore = SHIFT_START) {
  if (!ACCESS_FIELDS.every(key => ACCESS_TIME.test(job[key] || '')) ||
      job.pickupStart >= job.pickupEnd || job.dropStart >= job.dropEnd) {
    return { diagnosis: {
      code: 'missing_access',
      message: 'Ask the customer to confirm both building access windows before quoting.',
      changes: [],
    } };
  }
  const pickupEnd = minutes(job.pickupEnd);
  const dropEnd = minutes(job.dropEnd);
  const busy = allocations.filter(allocation => allocation.date === job.date);
  let confirmedWindowsFit = false;
  let nearestChange = null;
  let availableChange = null;

  // The normal search uses 15-minute steps. Check each minute here so a narrow
  // availability gap cannot be misreported as a building or crew conflict.
  for (let start = Math.max(SHIFT_START, notBefore, minutes(job.pickupStart)); start < SHIFT_END; start++) {
    const offer = { ...estimate, start: clock(start) };
    const plan = planMove(job, offer);
    if (!plan.phases.length || plan.reserveEnd > SHIFT_END) break;
    const resources = teams.find(team => !resourceConflicts(job.date, team, plan, busy).length);

    if (plan.valid) {
      if (resources) return { plan: { ...offer, resources } };
      confirmedWindowsFit = true;
      continue;
    }

    const changes = [
      { side: 'pickup', end: pickupEnd, needed: plan.phases[0].end },
      { side: 'drop', end: dropEnd, needed: plan.end },
    ].filter(window => window.needed > window.end).map(({ side, end, needed }) => ({
      side, confirmedEnd: clock(end), requestedEnd: clock(needed), minutes: needed - end,
    }));
    const addedMinutes = changes.reduce((total, change) => total + change.minutes, 0);
    if (!nearestChange || addedMinutes < nearestChange.addedMinutes) {
      nearestChange = { changes, addedMinutes };
    }
    if (resources && (!availableChange || addedMinutes < availableChange.addedMinutes)) {
      availableChange = { changes, addedMinutes, preview: { ...offer, resources } };
    }
  }

  const code = confirmedWindowsFit ? 'resources' : nearestChange ? 'access' : 'shift';
  const message = {
    resources: 'Every start that fits both confirmed windows overlaps a truck or crew reservation.',
    access: 'The confirmed building windows do not leave enough time for these task estimates.',
    shift: 'The move and its return buffer do not fit within the remaining 06:00–20:00 shift. Review the durations or ask for another date.',
  }[code];
  return {
    diagnosis: {
      code,
      message,
      changes: availableChange?.changes || (code === 'access' ? nearestChange.changes : []),
      preview: availableChange?.preview,
    },
  };
}
