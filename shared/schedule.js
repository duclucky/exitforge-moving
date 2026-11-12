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
  if (!job || !['pickupStart','pickupEnd','dropStart','dropEnd'].every(k => /^([01]\d|2[0-3]):[0-5]\d$/.test(job[k] || ''))) return {valid:false,errors:['Confirm complete access windows at both buildings first.'],start:0,end:0,reserveEnd:0,phases:[]};
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
  if (start < 360 || end + 15 > 1200) errors.push('The move must fit the operator shift of 06:00–20:00, including a 15-minute return buffer.');
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
export function suggestPlans(job, estimate, allocations, limit = 3) {
  if (!job || !['pickupStart','pickupEnd'].every(k => /^([01]\d|2[0-3]):[0-5]\d$/.test(job[k] || ''))) return [];
  const result=[];
  for (let start=Math.max(360,minutes(job.pickupStart)); start<minutes(job.pickupEnd); start+=15) {
    const candidate={...estimate,start:clock(start)};
    const plan=planMove(job,candidate);
    if (plan.valid&&!resourceConflicts(job.date,candidate.resources,plan,allocations).length) result.push(candidate);
    if(result.length===limit)break;
  }
  return result;
}
