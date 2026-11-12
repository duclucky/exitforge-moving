import express from 'express';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, seed, users, resources } from './data.js';
import { planMove, resourceConflicts, minutes, todayInZone, isMoveDate, suggestPlans, diagnosePlans } from '../shared/schedule.js';
import { analyzeMove, surveyInput } from './survey.js';
import { platformFeeFor } from '../shared/payments.js';
import { PayPal } from './paypal.js';
import { fulfillmentFor, registerFulfillment } from './fulfillment.js';
import { conversationSummaries, registerMarketplace } from './marketplace.js';
import {registerPayout} from './payout.js';
import {createBalanceService} from './balance.js';
import {createQrPayments} from './qr-payment.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const jobSchema = z.object({
  title: z.string().trim().min(5).max(100), from: z.string().trim().min(3).max(200), to: z.string().trim().min(3).max(200),
  date: z.string().refine(d => isMoveDate(d) && d >= todayInZone(), 'Choose a real calendar date today or in the future.'),
  size: z.enum(['Furniture only', 'Studio apartment', '1-bedroom apartment', '2-bedroom apartment']), inventory: z.string().trim().min(3).max(3000),
  pickupStart: time, pickupEnd: time, dropStart: time, dropEnd: time, budget: z.number().int().min(20).max(10000), notes: z.string().max(6000),
}).refine(j => ['pickupStart','pickupEnd','dropStart','dropEnd'].every(k=>time.safeParse(j[k]).success) && minutes(j.pickupStart) < minutes(j.pickupEnd) && minutes(j.dropStart) < minutes(j.dropEnd), 'Access windows must end after they start.');
const offerSchema = z.object({
  price: z.number().int().min(20).max(10000), start: time,
  loadMinutes: z.number().int().min(15).max(240), travelMinutes: z.number().int().min(5).max(240), unloadMinutes: z.number().int().min(15).max(240),
  resources: z.array(z.string()).min(2).max(8), note: z.string().trim().min(10).max(1200),
});
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const parse = row => row ? JSON.parse(row.data) : null;

export function createApp({ database = 'data/exitforge.sqlite', env = process.env, paymentService, setup = false } = {}) {
  const platformFeeBps = Number(env.PLATFORM_FEE_BPS ?? 50);
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps >= 10000) {
    throw new Error('PLATFORM_FEE_BPS must be a whole number from 0 to 9999.');
  }
  const db = openDatabase(database); seed(db);
  const paypal = paymentService || new PayPal(env);
  const app = express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});
    res.set('Cache-Control','public, max-age=0, no-transform');
    if(req.path.startsWith('/pay/')||req.query.balance_payment||req.query.balance_cancelled){
      res.set('Cache-Control','private, no-store, no-transform');
      res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'");
    }
    next();
  });
  app.get('/healthz',(req,res)=>res.json({application:'ExitForge moving marketplace',release:env.RELEASE_ID||'local',status:'ok',payments:'sandbox'}));
  app.use(express.json({ limit: '10mb' }));
  let rateWindow=0,apiCalls=0;
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-transform');
    const origin = req.get('origin');
    const allowed=env.NODE_ENV==='production'?[]:['http://127.0.0.1:4173', `http://127.0.0.1:${env.PORT || 4174}`, 'http://localhost:4173'];
    if(env.APP_URL)allowed.push(new URL(env.APP_URL).origin);
    if (origin && !allowed.includes(origin)) return res.status(403).json({ error: 'Origin is not allowed.' });
    if(req.method==='POST'&&!req.is('application/json'))return res.status(415).json({error:'Send this action as JSON.'});
    if(env.NODE_ENV==='production'){
      const minute=Math.floor(Date.now()/60000);if(minute!==rateWindow){rateWindow=minute;apiCalls=0;}
      if(++apiCalls>400)return res.status(429).set('Retry-After','60').json({error:'The demo is busy. Please retry in a minute.'});
    }
    next();
  });
  function expire() {
    db.prepare("UPDATE holds SET status='expired' WHERE status='held' AND expires < ?").run(Date.now());
  }
  function atomic(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function allocations() {
    expire();
    return db.prepare("SELECT a.*,h.job FROM allocations a JOIN holds h ON h.id=a.hold_id WHERE h.status IN ('held','booked')").all().map(a => ({ resourceId: a.resource, date: a.date, start: a.start, end: a.end, holdId: a.hold_id, jobId: a.job, jobTitle:job(a.job).title }));
  }
  function job(id) { const j = parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(id)); if (!j) throw fail('Move not found.',404); return j; }
  function offer(id) { const o = parse(db.prepare('SELECT data FROM offers WHERE id=?').get(id)); if (!o) throw fail('Offer not found.',404); return o; }
  const balance=createBalanceService({db,paypal,atomic,job});
  const qr=createQrPayments({db,balance,job,env});
  qr.registerPublic(app);
  function checkAvailability(j, o, excluding = null) {
    if(j.status==='cancelled')throw fail('This move was cancelled and is no longer accepting offers or reservations.',409);
    if(new Date(`${j.date}T${o.start}:00+07:00`).getTime()<=Date.now())throw fail('This move’s start time has passed. Ask the customer to update the date and request fresh quotes.',409);
    const plan = planMove(j,o);
    if (!plan.valid) throw fail(plan.errors.join(' '),409);
    const chosen = resources.filter(r => o.resources.includes(r.id) && r.provider === o.provider);
    if (new Set(o.resources).size !== o.resources.length || chosen.length !== o.resources.length || chosen.filter(r => r.kind === 'truck').length !== 1 || chosen.filter(r => r.kind === 'mover').length < 1) throw fail('Select one of your trucks and at least one mover.');
    const conflicts = resourceConflicts(j.date, o.resources, plan, allocations(), excluding);
    if (conflicts.length) throw fail('This crew or truck has just been reserved. Choose a different time or team.',409);
    return plan;
  }
  function ownHold(id, user) {
    expire(); const h = db.prepare('SELECT * FROM holds WHERE id=?').get(id);
    if (!h || h.owner !== user.id) throw fail('Reservation not found.',404);
    return h;
  }
  app.get('/api/status', (req,res) => res.json({ paypal: paypal.configured, clientId: env.PAYPAL_CLIENT_ID || null, ai: Boolean(env.AI_API_KEY && env.AI_MODEL), aiModel: env.AI_MODEL || null, platformFeeBps, demo: env.DEMO_MODE !== 'false', timezone: 'Asia/Ho_Chi_Minh', currency: 'USD' }));
  app.post('/api/demo-session', (req,res) => {
    if (env.DEMO_MODE === 'false') throw fail('Demo identity switching is disabled.',403);
    const user = users.find(u => u.id === req.body.userId);
    if (!user) throw fail('Choose a demo identity.');
    const old = /mw_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (old) db.prepare('DELETE FROM sessions WHERE token=?').run(old);
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token,user.id,Date.now()+86400000);
    res.cookie('mw_session',token,{ httpOnly:true,sameSite:'strict',secure:env.APP_URL?.startsWith('https://')||false,maxAge:86400000 });res.json(user);
  });
  app.use('/api', (req,res,next) => {
    const token = /mw_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    const session = token && db.prepare('SELECT user FROM sessions WHERE token=? AND expires>?').get(token,Date.now());
    req.user = users.find(u => u.id === session?.user);
    if (!req.user) return res.status(401).json({ error:'Choose a demo identity to continue.' });
    next();
  });
  app.get('/api/workspace', (req,res) => {
    expire(); const active = db.prepare("SELECT * FROM holds WHERE status IN ('held','booked','needs_review')").all();
    const fulfillmentByHold = new Map(active.filter(h => h.status === 'booked').map(h => [h.id, fulfillmentFor(db,h,env)]));
    const jobs = db.prepare('SELECT * FROM jobs ORDER BY rowid DESC').all().map(row => {
      const j = parse(row); const h = active.find(h => h.job === j.id);
      const fulfillment=fulfillmentByHold.get(h?.id);
      return { ...j, ...fulfillment?.schedule?.windows, owner:row.owner, status:h ? (h.status === 'booked' ? (fulfillment.stage==='scheduled'?'booked':fulfillment.stage) : h.status === 'needs_review' ? 'needs_review' : 'reserved') : j.status==='cancelled'?'cancelled':'open' };
    });
    const offers = db.prepare('SELECT data FROM offers').all().map(parse).filter(o => req.user.role === 'provider' ? o.provider === req.user.id : jobs.some(j => j.id === o.jobId && j.owner === req.user.id));
    const approvedStarts = new Map(active.flatMap(hold => {
      const schedule = fulfillmentByHold.get(hold.id)?.schedule;
      return schedule ? [[hold.offer, schedule.start]] : [];
    }));
    for (const offer of offers) {
      if (approvedStarts.has(offer.id)) offer.start = approvedStarts.get(offer.id);
    }
    const paymentHistory=req.user.role==='customer'?db.prepare("SELECT * FROM holds WHERE owner=? AND status='expired' AND paypal_order IS NOT NULL ORDER BY rowid DESC").all(req.user.id):[];
    // Closed assignments are private; preserve only an unselected mover's own quote/thread context.
    const visibleJobs=req.user.role==='customer'?jobs.filter(j=>j.owner===req.user.id):jobs.flatMap(j=>{
      const hold=active.find(h=>h.job===j.id),selected=hold?.snapshot&&JSON.parse(hold.snapshot).provider;
      if(j.status==='open'||selected===req.user.id)return[j];
      if(!offers.some(o=>o.jobId===j.id))return[];
      if(!hold)return[j];
      return[{id:j.id,title:j.title,date:j.date,size:j.size,budget:j.budget,status:j.status,owner:j.owner,createdAt:j.createdAt,restricted:true}];
    });
    res.json({ user:req.user, users, conversations:conversationSummaries(db,req.user), jobs:visibleJobs, offers, resources:resources.filter(r=>req.user.role==='customer'||r.provider===req.user.id), allocations:allocations().filter(a=>req.user.role==='provider'?resources.some(r=>r.id===a.resourceId&&r.provider===req.user.id):true), holds:active.filter(h=>h.owner===req.user.id || offers.some(o=>o.id===h.offer)).map(h=>({...h,...(h.status==='booked'?{fulfillment:fulfillmentByHold.get(h.id)}:{})})), paymentHistory });
  });
  app.post('/api/jobs', (req,res) => {
    if(req.user.role!=='customer')throw fail('Only customers can post moves.',403);
    const j={ ...jobSchema.parse(req.body),id:randomUUID(),sample:false,status:'open',createdAt:new Date().toISOString() };
    db.prepare('INSERT INTO jobs VALUES (?,?,?)').run(j.id,req.user.id,JSON.stringify(j));res.status(201).json(j);
  });
  app.post('/api/jobs/:id/update',(req,res)=>{
    const current=job(req.params.id);
    if(current.status==='cancelled')throw fail('Cancelled posts cannot be edited. Create a new move instead.',409);
    if(req.user.role!=='customer'||db.prepare('SELECT owner FROM jobs WHERE id=?').get(current.id).owner!==req.user.id)throw fail('Only the customer who posted this move can edit it.',403);
    const changes=jobSchema.parse(req.body);
    atomic(()=>{
      expire();
      if(db.prepare("SELECT id FROM holds WHERE job=? AND status IN ('held','booked','needs_review')").get(current.id))throw fail('A reserved or paid move cannot be changed. Resolve the reservation with the operator first.',409);
      db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({...current,...changes,version:(current.version||0)+1,updatedAt:new Date().toISOString()}),current.id);
      for(const row of db.prepare('SELECT id,data FROM offers WHERE job=?').all(current.id).filter(row=>parse(row).status!=='withdrawn'))db.prepare('UPDATE offers SET data=? WHERE id=?').run(JSON.stringify({...parse(row),status:'outdated'}),row.id);
    });
    res.json(job(current.id));
  });
  app.post('/api/jobs/:id/offers', (req,res) => {
    if(req.user.role!=='provider')throw fail('Choose a mover account to make an offer.',403);
    const j=job(req.params.id);
    const input = offerSchema.parse(req.body);
    const o = {
      ...input, id: randomUUID(), jobId: j.id, provider: req.user.id, status: 'offered',
      deposit: Math.round(input.price * 20) / 100, platformFeeCents: platformFeeFor(input.price, platformFeeBps),
    };
    atomic(()=>{
      expire();
      if(db.prepare("SELECT id FROM holds WHERE job=? AND status IN ('held','booked','needs_review')").get(j.id))throw fail('This move already has a reservation.',409);
      checkAvailability(j,o);
      const existing=db.prepare('SELECT id FROM offers WHERE job=? AND provider=?').get(j.id,req.user.id);
      if(existing){o.id=existing.id;db.prepare('UPDATE offers SET data=? WHERE id=?').run(JSON.stringify(o),o.id);}
      else db.prepare('INSERT INTO offers VALUES (?,?,?,?)').run(o.id,j.id,req.user.id,JSON.stringify(o));
    });res.status(201).json(o);
  });
  app.post('/api/jobs/:id/suggestions',(req,res)=>{
    if(req.user.role!=='provider')throw fail('Choose a mover account to prepare a proposal.',403);
    const j=job(req.params.id),estimate={...offerSchema.parse(req.body),provider:req.user.id};
    if(j.status==='cancelled'||j.date<todayInZone())throw fail('This move is closed or its date has passed.',409);
    expire();
    if(db.prepare("SELECT id FROM holds WHERE job=? AND status IN ('held','booked','needs_review')").get(j.id))throw fail('This move already has a reservation.',409);
    const owned=resources.filter(r=>r.provider===req.user.id);
    if(estimate.resources.some(id=>!owned.some(r=>r.id===id))||new Set(estimate.resources).size!==estimate.resources.length||estimate.resources.filter(id=>owned.some(r=>r.id===id&&r.kind==='truck')).length!==1)throw fail('Select one of your trucks and your crew.');
    const count=estimate.resources.filter(id=>owned.some(r=>r.id===id&&r.kind==='mover')).length;
    if(!count)throw fail('Select at least one mover.');
    const movers=owned.filter(r=>r.kind==='mover'),teams=[];
    function combine(start,team){if(team.length===count){teams.push(team);return;}for(let i=start;i<movers.length;i++)combine(i+1,[...team,movers[i].id]);}
    combine(0,[]);
    const now = new Date();
    const notBefore = j.date === todayInZone(now)
      ? Math.floor((now.getTime() - Date.parse(j.date + 'T00:00:00+07:00')) / 60000) + 1
      : 0;
    const teamOptions = owned.filter(r => r.kind === 'truck').flatMap(truck => teams.map(crew => [truck.id, ...crew]));
    const busy = allocations();
    const candidates = teamOptions.flatMap(resources => suggestPlans(j, { ...estimate, resources }, busy, 3, notBefore));
    candidates.sort((a,b)=>a.start.localeCompare(b.start));
    const plans = candidates.filter((p,i)=>candidates.findIndex(q=>q.start===p.start)===i).slice(0,3);
    const explanation = 'Based on your reviewed durations and crew size. Resource availability will be checked again on send and reservation.';
    if (plans.length) return res.json({ plans, explanation });

    const { plan, diagnosis } = diagnosePlans(j, estimate, teamOptions, busy, notBefore);
    if (plan) return res.json({ plans: [plan], explanation });
    res.json({ plans, explanation: diagnosis.message, diagnosis });
  });
  app.post(['/api/survey','/api/extract'],async(req,res)=>{
    if(req.user.role!=='customer')throw fail('Only customers can analyze their move details.',403);
    const input=surveyInput.parse(req.body);
    if(env.NODE_ENV==='production'){
      const day=new Date().toISOString().slice(0,10),key='hosted-ai:'+day;
      atomic(()=>{
        const used=Number(db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value||0);
        const configured=Number(env.AI_DAILY_LIMIT||30),limit=Number.isInteger(configured)&&configured>=0?Math.min(configured,100):30;
        if(used>=limit)throw fail('The shared demo AI allowance is used for today. You can still enter move details manually.',429);
        db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(used+1));
      });
    }
    const result=await analyzeMove(input,env);
    res.json(result);
  });
  app.post('/api/offers/:id/reserve', (req,res) => {
    const o=offer(req.params.id),j=job(o.jobId);
    if(db.prepare('SELECT owner FROM jobs WHERE id=?').get(j.id).owner!==req.user.id)throw fail('Only the person who posted this move can choose an offer.',403);
    const result=atomic(()=>{
      expire();const existing=db.prepare("SELECT * FROM holds WHERE job=? AND status IN ('held','booked','needs_review')").get(j.id);
      if(existing){if(existing.offer===o.id)return existing;throw fail('Another offer is already reserved.',409);}
      if(o.status!=='offered')throw fail('Move details changed. Ask the operator for an updated offer.',409);
      const plan=checkAvailability(j,o);const id=randomUUID();
      db.prepare("INSERT INTO holds(id,job,offer,owner,expires,status,snapshot) VALUES (?,?,?,?,?,'held',?)").run(id,j.id,o.id,req.user.id,Date.now()+600000,JSON.stringify({...o,jobVersion:j.version||0}));
      for(const resource of o.resources)db.prepare('INSERT INTO allocations VALUES (?,?,?,?,?,?)').run(randomUUID(),id,j.date,resource,plan.start,plan.reserveEnd);
      return ownHold(id,req.user);
    });res.json(result);
  });
  app.post('/api/holds/:id/release', (req,res) => {
    const h=ownHold(req.params.id,req.user);
    if(h.paypal_order)throw fail('A payment has been initiated. Reconcile it or allow the reservation to expire.',409);
    if(h.status!=='held')throw fail('Only an unpaid active reservation can be released.',409);
    db.prepare("UPDATE holds SET status='released' WHERE id=?").run(h.id);res.json({ok:true});
  });
  app.post('/api/holds/:id/confirm-late',(req,res)=>{
    const h=db.prepare('SELECT * FROM holds WHERE id=?').get(req.params.id);
    const snapshot=h?.snapshot?JSON.parse(h.snapshot):null;
    if(req.user.role!=='provider'||!snapshot||snapshot.provider!==req.user.id)throw fail('Only the selected operator can review this reservation.',403);
    const result=atomic(()=>{
      const latest=db.prepare('SELECT * FROM holds WHERE id=?').get(h.id);
      if(latest.status==='booked')return latest;
      if(latest.status!=='needs_review'||!latest.paid||!latest.capture)throw fail('Only a verified late deposit can be reviewed.',409);
      const j=job(h.job);
      if(!Number.isInteger(snapshot.jobVersion)||snapshot.jobVersion!==(j.version||0))throw fail('Move details changed since payment. Contact the customer to agree on a recovery or refund; this plan cannot be confirmed automatically.',409);
      const plan=checkAvailability(j,snapshot,h.id);
      if(new Date(`${j.date}T${snapshot.start}:00+07:00`).getTime()<=Date.now())throw fail('The original start time has passed. Agree on a recovery with the customer.',409);
      if(db.prepare("SELECT id FROM holds WHERE job=? AND id<>? AND status IN ('held','booked','needs_review')").get(j.id,h.id))throw fail('This move already has another reservation or payment review. Resolve it with the customer first.',409);
      db.prepare("UPDATE holds SET status='booked' WHERE id=?").run(h.id);
      return db.prepare('SELECT * FROM holds WHERE id=?').get(h.id);
    });
    res.json(result);
  });
  app.post('/api/holds/:id/paypal-order', async(req,res) => {
    const h=ownHold(req.params.id,req.user);
    if(h.status!=='held')throw fail('This reservation is no longer payable.',409);
    if(db.prepare("SELECT id FROM holds WHERE job=? AND id<>? AND status='needs_review'").get(h.job,h.id))throw fail('An earlier deposit needs operator review. Do not pay again.',409);
    const previous=db.prepare("SELECT * FROM holds WHERE job=? AND id<>? AND status='expired' AND paypal_order IS NOT NULL").all(h.job,h.id);
    for(const prior of previous){
      const order=await paypal.get(prior.paypal_order);
      if(order.status!=='COMPLETED')continue;
      const quoted=prior.snapshot?JSON.parse(prior.snapshot):null,unit=order.purchase_units?.[0],capture=unit?.payments?.captures?.find(c=>c.status==='COMPLETED');
      if(!quoted||!capture?.id||unit.custom_id!==prior.id||capture.amount?.currency_code!=='USD'||capture.amount?.value!==quoted.deposit.toFixed(2))throw fail('An earlier completed payment needs manual review before another checkout.',409);
      atomic(()=>{
        db.prepare("UPDATE holds SET status='needs_review',paid=1,capture=? WHERE id=?").run(capture.id,prior.id);
        if(!h.paypal_order)db.prepare("UPDATE holds SET status='released' WHERE id=?").run(h.id);
      });
      throw fail('An earlier deposit was completed. It is now awaiting operator review. Do not pay again.',409);
    }
    if(h.paypal_order){const order=await paypal.get(h.paypal_order);return res.json({id:h.paypal_order,approvalUrl:order.links?.find(l=>['payer-action','approve'].includes(l.rel))?.href});}
    const o=h.snapshot?JSON.parse(h.snapshot):offer(h.offer);const order=await paypal.create(h,o,job(h.job).title);
    db.prepare('UPDATE holds SET paypal_order=? WHERE id=?').run(order.id,h.id);res.json({id:order.id,approvalUrl:order.links?.find(l=>['payer-action','approve'].includes(l.rel))?.href});
  });
  app.post('/api/holds/:id/capture',async(req,res)=>{
    let h=ownHold(req.params.id,req.user);
    if(!h.paypal_order)throw fail('No PayPal order exists for this reservation.');
    if(h.status==='booked')return res.json(h);
    let order=await paypal.get(h.paypal_order);
    if(order.status!=='COMPLETED') {
      if(h.status!=='held')throw fail('Reservation expired. Payment status will be checked before any further charge.',409);
      if(db.prepare("SELECT id FROM holds WHERE job=? AND id<>? AND status='needs_review'").get(h.job,h.id))throw fail('An earlier deposit needs operator review. Do not pay again.',409);
      order=await paypal.capture(h.paypal_order,h.id);
    }
    const unit=order.purchase_units?.[0];const cap=unit?.payments?.captures?.find(c=>c.status==='COMPLETED');const o=h.snapshot?JSON.parse(h.snapshot):offer(h.offer);
    if(!cap||unit.custom_id!==h.id||cap.amount.currency_code!=='USD'||cap.amount.value!==o.deposit.toFixed(2)||!cap.id)throw fail('Payment is not a verified completed deposit for this reservation.',409);
    const result=atomic(()=>{
      h=ownHold(h.id,req.user);
      if(h.status==='booked')return h;
      const other=db.prepare("SELECT id FROM holds WHERE job=? AND id<>? AND status IN ('held','booked','needs_review')").get(h.job,h.id);
      const status=h.status==='held'&&!other?'booked':'needs_review';
      db.prepare('UPDATE holds SET status=?,capture=?,paid=1 WHERE id=?').run(status,cap.id,h.id);
      return ownHold(h.id,req.user);
    });res.json(result);
  });
  registerFulfillment(app,{db,balance,atomic,job,allocations,env});
  qr.registerPrivate(app);
  registerPayout(app,{db,paypal,atomic,env});
  registerMarketplace(app,{db,atomic,job,offer,expire,users});
  if(setup&&env.NODE_ENV!=='production'){
    const setupToken=randomBytes(24).toString('hex');
    const setupPath='/local-setup-'+setupToken;
    app.get(setupPath,(req,res)=>res.type('html').send('<!doctype html><html><title>ExitForge local setup</title><body><h1>Local integration setup</h1><form method="post"><label>PayPal client ID<input name="PAYPAL_CLIENT_ID" type="password"></label><label>PayPal secret<input name="PAYPAL_CLIENT_SECRET" type="password"></label><label>OpenAI key<input name="AI_API_KEY" type="password"></label><label>AI model<input name="AI_MODEL" value="gpt-4.1-mini"></label><button>Save locally</button></form></body></html>'));
    app.post(setupPath,express.urlencoded({extended:false}),(req,res)=>{
      const file=resolve('.env');let content=existsSync(file)?readFileSync(file,'utf8'):'';
      for(const key of ['PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','AI_API_KEY','AI_MODEL']){
        const value=req.body[key];if(typeof value!=='string'||!value.trim())continue;
        if(!/^[A-Za-z0-9_.-]+$/.test(value))throw fail('Invalid configuration value.');
        env[key]=value;
        const line=key+'='+value;
        content=new RegExp('^'+key+'=.*$','m').test(content)?content.replace(new RegExp('^'+key+'=.*$','m'),line):content+'\n'+line;
      }
      writeFileSync(file,content+'\n',{mode:0o600});res.type('html').send('<h1>Configuration saved locally</h1><p>Secret values are hidden.</p>');
    });
    app.locals.setupPath=setupPath;
  }
  app.use('/api',(req,res)=>res.status(404).json({error:'This action is unavailable. Refresh the workspace and retry.'}));
  app.use((req,res,next)=>{
    if(/^\/(?:\.|server(?:\/|$)|shared(?:\/|$)|src(?:\/|$)|data(?:\/|$)|deploy(?:\/|$)|node_modules(?:\/|$)|package(?:-lock)?\.json)/i.test(req.path))return res.status(404).send('Not found.');
    next();
  });
  app.use(express.static(resolve('dist')));
  app.get('/{*splat}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'Route not found.'});if(existsSync('dist/index.html'))return res.sendFile(resolve('dist/index.html'));res.status(404).send('Start the frontend with npm run web.');});
  app.use((error,req,res,next)=>{res.status(error instanceof z.ZodError?400:error.status||500).json({error:error instanceof z.ZodError?error.issues.map(i=>i.message).join(' '):error.status?error.message:'Request failed. Please retry or check the server.'});});
  app.locals.db=db;return app;
}
