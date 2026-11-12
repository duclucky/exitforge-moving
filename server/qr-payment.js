import {createHash,randomBytes} from 'node:crypto';
import QRCode from 'qrcode';
import {users} from './data.js';

const fail=(message,status)=>Object.assign(new Error(message),{status});
const hash=token=>createHash('sha256').update(token).digest('hex');
const lifetime=30*60*1000;

export function createQrPayments({db,balance,job,env}){
  const origin=new URL(env.APP_URL||`http://127.0.0.1:${env.PORT||4174}`).origin;
  function lookup(token){
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw fail('Payment link not found.',404);
    const link=db.prepare('SELECT * FROM payment_links WHERE token_hash=?').get(hash(token));
    if(!link)throw fail('Payment link not found.',404);
    const hold=db.prepare('SELECT * FROM holds WHERE id=?').get(link.hold_id);
    if(!hold)throw fail('Payment link not found.',404);
    const f=balance.current(hold);return {link,hold,f};
  }
  function info({link,hold,f}){
    return {reservationId:hold.id,title:job(hold.job).title,provider:users.find(u=>u.id===JSON.parse(hold.snapshot).provider)?.name||'Selected mover',
      currency:'USD',environment:'PayPal Sandbox',total:f.total,deposit:f.deposit,balanceDue:f.balanceDue,paid:f.paidInFull,
      expiresAt:new Date(link.expires).toISOString(),expired:Date.now()>link.expires};
  }
  function registerPublic(app){
    app.get('/api/public-payments/:token',(req,res)=>res.json(info(lookup(req.params.token))));
    app.post('/api/public-payments/:token/paypal-order',async(req,res)=>{
      const ctx=lookup(req.params.token);
      if(!ctx.f.paidInFull&&Date.now()>ctx.link.expires)throw fail('This payment link expired. Ask the mover for a new QR code.',410);
      const page=origin+'/pay/'+req.params.token;
      res.json(await balance.order(ctx.hold,{returnUrl:page+'?approved=1',cancelUrl:page+'?cancelled=1'}));
    });
    app.post('/api/public-payments/:token/check',async(req,res)=>{
      const ctx=lookup(req.params.token);
      if(!ctx.f.paidInFull&&Date.now()>ctx.link.expires&&!ctx.f.balanceOrder)throw fail('This payment link expired. Ask the mover for a new QR code.',410);
      await balance.check(ctx.hold,'Customer · QR payment',{allowCapture:Date.now()<=ctx.link.expires});
      res.json(info(lookup(req.params.token)));
    });
  }
  function registerPrivate(app){
    app.post('/api/holds/:id/payment-link',async(req,res)=>{
      const hold=db.prepare('SELECT * FROM holds WHERE id=?').get(req.params.id);
      if(!hold?.snapshot)throw fail('Booked move not found.',404);
      if(req.user.role!=='provider'||JSON.parse(hold.snapshot).provider!==req.user.id)throw fail('Only the selected mover can create this payment QR.',403);
      const f=balance.current(hold);if(f.paidInFull)throw fail('This move is already paid in full.',409);
      const token=randomBytes(32).toString('base64url'),expires=Date.now()+lifetime,url=origin+'/pay/'+token;
      const qrImage=await QRCode.toDataURL(url,{errorCorrectionLevel:'M',margin:4,width:320,color:{dark:'#102e25',light:'#ffffff'}});
      db.prepare('INSERT INTO payment_links(token_hash,hold_id,expires,created_at) VALUES (?,?,?,?)').run(hash(token),hold.id,expires,Date.now());
      res.json({url,qrImage,expiresAt:new Date(expires).toISOString(),balanceDue:f.balanceDue});
    });
  }
  return {registerPublic,registerPrivate};
}
