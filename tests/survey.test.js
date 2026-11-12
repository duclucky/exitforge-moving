import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMove, surveyInput } from '../server/survey.js';

const output={pickupStart:'09:00',pickupEnd:'10:00',dropStart:'11:00',dropEnd:'12:00',pickupEvidence:'Pickup 09:00-10:00',dropEvidence:'Destination 11:00-12:00',pickupSource:'notes',dropSource:'notes',items:[{name:'desk',quantity:1,source:'inventory',evidence:'1 desk',handling:'Confirm disassembly.'}],warnings:[],questions:[]};
const input={notes:'Pickup 09:00-10:00. Destination 11:00-12:00.',inventory:'1 desk',images:[]};
const env={AI_API_KEY:'unit-test-only',AI_MODEL:'test-model'};
const request=value=>async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})});
test('unsupported AI access and inventory evidence is removed, not silently accepted',async()=>{
  const r=await analyzeMove(input,env,request({...output,pickupEvidence:'invented quote',items:[{...output.items[0],evidence:'nonexistent chair'}]}));
  assert.equal(r.pickupStart,null);assert.equal(r.pickupEnd,null);assert.equal(r.items.length,0);assert.ok(r.warnings.length);
  assert.equal(r.dropStart,'11:00');
});
test('missing half of an access range clears both ends for manual confirmation',async()=>{
  const r=await analyzeMove(input,env,request({...output,pickupEnd:null}));
  assert.equal(r.pickupStart,null);assert.equal(r.pickupEnd,null);
});
test('an image source must actually be attached and match the building side',async()=>{
  const r=await analyzeMove(input,env,request({...output,pickupSource:'destination-message',dropSource:'destination-message'}));
  assert.equal(r.pickupStart,null);assert.equal(r.dropStart,null);
});
test('refusals and malformed model output become a recoverable AI error',async()=>{
  await assert.rejects(()=>analyzeMove(input,env,async()=>({ok:true,json:async()=>({choices:[{message:{refusal:'refused'}}]})})),e=>e.status===502);
});
test('uploaded data is restricted to valid supported local image bytes',()=>{
  assert.equal(surveyInput.safeParse({...input,images:[{id:'pickup-message',name:'bad.png',dataUrl:'data:image/png;base64,YmFk'}]}).success,false);
  assert.equal(surveyInput.safeParse({...input,images:[{id:'pickup-message',name:'bad.svg',dataUrl:'https://example.com/x.svg'}]}).success,false);
});
test('only requested inventory and building notes are included in the model request',async()=>{
  let body;
  await analyzeMove({...input,from:'private address',to:'another address'},env,async(url,options)=>{body=JSON.parse(options.body);return request(output)();});
  assert.equal(body.response_format.json_schema.strict,true);
  assert.equal(body.max_completion_tokens,2000);
  assert.ok(!JSON.stringify(body).includes('private address'));
  assert.equal(JSON.parse(body.messages[1].content[0].text).inventory,'1 desk');
});
test('text evidence with a mistaken source label is attributed to its unique actual source',async()=>{
  const r=await analyzeMove(input,env,request({...output,items:[{...output.items[0],source:'notes'}]}));
  assert.equal(r.items.length,1);assert.equal(r.items[0].source,'inventory');
});
