import {z} from 'zod';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const textInput=z.object({text:z.string().trim().min(2).max(2000)});
const reasonInput=z.object({reason:z.string().trim().min(5).max(500)});

export function conversationSummaries(db,user){
  return db.prepare(`SELECT m.job,m.provider,MAX(m.id) AS lastId FROM messages m JOIN jobs j ON j.id=m.job
    WHERE ${user.role==='customer'?'j.owner=?':'m.provider=?'} GROUP BY m.job,m.provider ORDER BY lastId DESC`).all(user.id).map(c=>{
    const latest=db.prepare('SELECT text,created_at AS createdAt FROM messages WHERE id=?').get(c.lastId);
    const read=db.prepare('SELECT last_id FROM message_reads WHERE job=? AND provider=? AND user=?').get(c.job,c.provider,user.id)?.last_id||0;
    const unread=db.prepare('SELECT COUNT(*) AS count FROM messages WHERE job=? AND provider=? AND sender<>? AND id>?').get(c.job,c.provider,user.id,read).count;
    return{...c,...latest,unread};
  });
}

export function registerMarketplace(app,{db,atomic,job,offer,expire,users}){
  const activeHold=id=>db.prepare("SELECT * FROM holds WHERE job=? AND status IN ('held','booked','needs_review')").get(id);
  function thread(req){
    const j=job(req.params.id),owner=db.prepare('SELECT owner FROM jobs WHERE id=?').get(j.id).owner,provider=req.params.provider;
    if((req.user.role==='customer'&&owner!==req.user.id)||(req.user.role==='provider'&&provider!==req.user.id))throw fail('This conversation belongs to another customer or mover.',403);
    if(!users.some(u=>u.id===provider&&u.role==='provider'))throw fail('Mover not found.',404);
    if(!db.prepare('SELECT id FROM offers WHERE job=? AND provider=?').get(j.id,provider))throw fail('Send or receive an offer before starting this conversation.',409);
    expire();const hold=activeHold(j.id),selected=hold?.snapshot&&JSON.parse(hold.snapshot).provider;
    return{j,provider,writable:j.status!=='cancelled'&&(!hold||selected===provider)};
  }
  const path='/api/jobs/:id/conversations/:provider';
  app.get(path,(req,res)=>{
    const {j,provider,writable}=thread(req);
    res.json({writable,messages:db.prepare('SELECT id,sender,text,created_at AS createdAt FROM messages WHERE job=? AND provider=? ORDER BY id').all(j.id,provider)});
  });
  app.post(path,(req,res)=>{
    const {text}=textInput.parse(req.body);
    const result=atomic(()=>{
      const {j,provider,writable}=thread(req);
      if(!writable)throw fail('This conversation is read-only because the move was cancelled or assigned to another crew.',409);
      const createdAt=new Date().toISOString();
      const inserted=db.prepare('INSERT INTO messages(job,provider,sender,text,created_at) VALUES (?,?,?,?,?)').run(j.id,provider,req.user.id,text,createdAt);
      return{id:Number(inserted.lastInsertRowid),sender:req.user.id,text,createdAt};
    });res.status(201).json(result);
  });
  app.post(path+'/read',(req,res)=>{
    const {j,provider}=thread(req),last=db.prepare('SELECT MAX(id) AS id FROM messages WHERE job=? AND provider=?').get(j.id,provider).id||0;
    db.prepare('INSERT INTO message_reads(job,provider,user,last_id) VALUES (?,?,?,?) ON CONFLICT(job,provider,user) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)').run(j.id,provider,req.user.id,last);res.json({ok:true});
  });
  app.post('/api/jobs/:id/cancel',(req,res)=>{
    const j=job(req.params.id);
    if(req.user.role!=='customer'||db.prepare('SELECT owner FROM jobs WHERE id=?').get(j.id).owner!==req.user.id)throw fail('Only the posting customer can cancel this move.',403);
    const {reason}=reasonInput.parse(req.body);
    atomic(()=>{
      expire();if(j.status==='cancelled')return;
      if(activeHold(j.id))throw fail('A reserved or paid move requires an agreed recovery. It cannot be cancelled here.',409);
      if(db.prepare('SELECT id FROM holds WHERE job=? AND paypal_order IS NOT NULL').get(j.id))throw fail('A previous checkout needs payment review before this post can be cancelled. No refund or cancellation has been made.',409);
      db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({...j,status:'cancelled',cancelReason:reason,cancelledAt:new Date().toISOString()}),j.id);
    });res.json(job(j.id));
  });
  app.post('/api/offers/:id/withdraw',(req,res)=>{
    const o=offer(req.params.id);
    if(req.user.role!=='provider'||o.provider!==req.user.id)throw fail('Only the mover who sent this offer can withdraw it.',403);
    atomic(()=>{
      expire();if(activeHold(o.jobId))throw fail('A reserved or paid offer cannot be withdrawn. Coordinate with the customer.',409);
      if(job(o.jobId).status==='cancelled')throw fail('The move is already cancelled.',409);
      db.prepare('UPDATE offers SET data=? WHERE id=?').run(JSON.stringify({...o,status:'withdrawn',withdrawnAt:new Date().toISOString()}),o.id);
    });res.json({ok:true});
  });
}
