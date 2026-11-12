export class PayPal {
  constructor(env = process.env) { this.env = env; }
  get configured() { return Boolean(this.env.PAYPAL_CLIENT_ID && this.env.PAYPAL_CLIENT_SECRET); }
  async request(path, { method = 'GET', body, requestId } = {}) {
    if (!this.configured) throw Object.assign(new Error('PayPal Sandbox is not configured yet.'), { status: 503 });
    if (!this.token || this.expiry < Date.now()) {
      const response = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
        method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(this.env.PAYPAL_CLIENT_ID + ':' + this.env.PAYPAL_CLIENT_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('PayPal Sandbox authentication failed. Check the server configuration.'), { status: 502 });
      this.token = data.access_token; this.expiry = Date.now() + (data.expires_in - 60) * 1000;
    }
    const response = await fetch('https://api-m.sandbox.paypal.com' + path, {
      method, headers: { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json', ...(requestId ? { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(`PayPal ${data.details?.[0]?.issue || data.name || 'request failed'}. Please retry checking this payment.`), { status: 502,code:data.name,details:data.details,links:data.links });
    return data;
  }
  create(hold, offer, title) {
    return this.request('/v2/checkout/orders', { method: 'POST', requestId: `create-${hold.id}`, body: {
      intent: 'CAPTURE', purchase_units: [{ custom_id: hold.id, description: `ExitForge reservation · ${title}`.slice(0,127), amount: { currency_code: 'USD', value: offer.deposit.toFixed(2) } }],
      payment_source: { paypal: { experience_context: { brand_name: 'ExitForge Sandbox', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', return_url: `${this.env.APP_URL || 'http://127.0.0.1:4174'}/?payment=${encodeURIComponent(hold.id)}`, cancel_url: `${this.env.APP_URL || 'http://127.0.0.1:4174'}/?cancelled=${encodeURIComponent(hold.id)}` } } },
    } });
  }
  get(id) { return this.request(`/v2/checkout/orders/${encodeURIComponent(id)}`); }
  async createPayout(row){
    try{return await this.request('/v1/payments/payouts',{method:'POST',requestId:row.batch_key,body:{
      sender_batch_header:{sender_batch_id:row.batch_key,email_subject:'ExitForge Sandbox move payment'},
      items:[{recipient_type:'PAYPAL_ID',receiver:row.receiver,amount:{currency:'USD',value:(row.amount_cents/100).toFixed(2)},sender_item_id:row.item_key,note:'ExitForge completed move · Sandbox test money only'}],
    }});}catch(error){
      if(error.code!=='DUPLICATE_BATCH_ID'&&!error.details?.some(d=>d.issue==='DUPLICATE_BATCH_ID'))throw error;
      const links=[...(error.links||[]),...(error.details||[]).flatMap(d=>d.links||[])];
      const original=links.find(l=>l.rel==='original_payout_batch');
      if(!original)throw error;
      const url=new URL(original.href);
      const match=/^\/v1\/payments\/payouts\/([A-Za-z0-9]+)$/.exec(url.pathname);
      if(url.protocol!=='https:'||!['api-m.sandbox.paypal.com','api.sandbox.paypal.com'].includes(url.hostname)||!match)throw error;
      return this.getPayout(match[1]);
    }
  }
  getPayout(id){return this.request(`/v1/payments/payouts/${encodeURIComponent(id)}`);}
  createBalance(hold, offer, title, context={}) {
    const balance=(Math.round(offer.price*100)-Math.round(offer.deposit*100))/100;
    return this.request('/v2/checkout/orders',{method:'POST',requestId:`balance-create-${hold.id}`,body:{
      intent:'CAPTURE',purchase_units:[{custom_id:hold.id+':balance',description:`ExitForge final balance · ${title}`.slice(0,127),amount:{currency_code:'USD',value:balance.toFixed(2)}}],
      payment_source:{paypal:{experience_context:{brand_name:'ExitForge Sandbox',user_action:'PAY_NOW',shipping_preference:'NO_SHIPPING',return_url:context.returnUrl||`${this.env.APP_URL||'http://127.0.0.1:4174'}/?balance_payment=${encodeURIComponent(hold.id)}`,cancel_url:context.cancelUrl||`${this.env.APP_URL||'http://127.0.0.1:4174'}/?balance_cancelled=${encodeURIComponent(hold.id)}`}}},
    }});
  }
  capture(id, holdId) { return this.request(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, { method: 'POST', requestId: `capture-${holdId}`, body: {} }); }
}
