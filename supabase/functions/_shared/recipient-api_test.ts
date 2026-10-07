import { recipientRoute, recipientQuery, recipientRegistration } from './recipient-api.ts';
import { pddRoute, type PddRouteContext } from './waybill-api.ts';
import { canonicalJson, sha256 } from './security.ts';
import { ApiError } from './http.ts';
function assert(value: unknown, message='assertion failed'): asserts value { if (!value) throw new Error(message); }
async function rejects(run:()=>Promise<unknown>,code:string){try{await run();}catch(error){assert(error instanceof ApiError&&error.code===code);return;}throw new Error(`expected ${code}`);}
const id='10000000-0000-4000-8000-000000000001',cursor='10000000-0000-4000-8000-000000000002',cap='a'.repeat(64),time='2026-10-07T08:00:00Z';
const contact={kind:'wechat',value:'synthetic_person'};
const lead={recipientName:'Synthetic Alex',contact,note:'Synthetic private note',registeredAt:time};
const registration={registrationCode:'PDD-N-SYNTHETIC',recipientName:'Synthetic Alex',mode:'received',contact,note:lead.note,state:'active',revision:1,createdAt:time,updatedAt:time};
function req(path:string,input:unknown,token=cap,method='POST'){return new Request(`https://pdd404.app/v1/${path}`,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,'Idempotency-Key':id},body:JSON.stringify(input)});}
const ctx=(rpc:PddRouteContext['rpc'],enabled=true,admin=false):PddRouteContext=>({rpc,canRegister:async()=>enabled,admin:async()=>{if(!admin)throw new ApiError('FORBIDDEN','admin only',403);return id;}});

Deno.test('complete name POST query and result use explicit privacy allowlists',async()=>{
 const input={queryId:id,recipientName:'  Synthetic\u00a0Alex ',mode:'lost'};
 const response=await recipientRoute(req('recipient-queries',input),['recipient-queries'],{'Cache-Control':'no-store'},ctx(async(name,payload)=>{
  assert(name==='pdd_recipient_query'&&payload.recipient_name==='Synthetic Alex'&&payload.mode==='lost');assert(payload.body_hash===await sha256(canonicalJson(input)));assert(payload.capability_hash!==cap&&payload.capability_hash.length===64);
  return {queryId:id,result:'leads_found',queriedAt:time,leads:[{...lead,number:'SYNTH12345',registrationCode:registration.registrationCode,capability_hash:cap,address:'Synthetic address'}],nextCursor:cursor,capability:cap};
 }));
 const value=(await response!.json()).data;assert(value.leads[0].contact.value===contact.value);assert(Object.keys(value.leads[0]).sort().join(',')==='contact,note,recipientName,registeredAt');assert(!JSON.stringify(value).includes('PDD-N-')&&!JSON.stringify(value).includes('SYNTH12345')&&!JSON.stringify(value).includes(cap));assert(response?.headers.get('Cache-Control')==='no-store');
});
Deno.test('name input, request flags, capability and output size are fenced',async()=>{
 const never=ctx(async()=>{throw new Error('must not call DB');});const input={queryId:id,recipientName:'Synthetic Alex',mode:'lost'};
 await rejects(()=>recipientRoute(req('recipient-queries',input,'short'),['recipient-queries'],{},never),'FORBIDDEN');
 for(const name of ['','\nSynthetic','😀'.repeat(81)])await rejects(()=>recipientRoute(req('recipient-queries',{...input,recipientName:name}),['recipient-queries'],{},never),'INVALID_RECIPIENT_NAME');
 await rejects(()=>recipientRoute(req('recipient-queries',{...input,allowPossible:true}),['recipient-queries'],{},never),'INVALID_REQUEST');
 await rejects(async()=>recipientQuery({queryId:id,result:'leads_found',queriedAt:time,leads:Array(21).fill(lead)}),'SERVICE_UNAVAILABLE');
 await rejects(async()=>recipientQuery({queryId:id,result:'not_found',queriedAt:time,leads:[lead]}),'SERVICE_UNAVAILABLE');
 await rejects(()=>recipientRoute(new Request('https://pdd404.app/v1/recipient-queries'),['recipient-queries'],{},never),'NOT_FOUND');
});
Deno.test('page input is bound to original query, no alternate name or mode',async()=>{
 await recipientRoute(req(`recipient-queries/${id}/pages`,{cursor}),['recipient-queries',id,'pages'],{},ctx(async(name,payload)=>{
  assert(name==='pdd_recipient_query_page'&&payload.query_id===id&&payload.cursor===cursor&&!('mode'in payload));return {queryId:id,result:'not_found',queriedAt:time,leads:[],nextCursor:null};
 }));
 await rejects(()=>recipientRoute(req(`recipient-queries/${id}/pages`,{cursor,recipientName:'Other'}),['recipient-queries',id,'pages'],{},ctx(async()=>{throw new Error('must not call DB');})),'INVALID_REQUEST');
});
Deno.test('shared contact batch keeps original body hash, validates each row and respects paused service',async()=>{
 const input={mode:'received',contact,note:'  Shared note ',items:[{requestId:id,recipientName:' Synthetic Alex '}]};
 const response=await recipientRoute(req('recipient-batches',input),['recipient-batches'],{},ctx(async(name,payload)=>{
  assert(name==='pdd_recipient_batch_register'&&payload.items[0].recipient_name==='Synthetic Alex'&&payload.note==='Shared note'&&payload.request_id===id);assert(payload.body_hash===await sha256(canonicalJson(input)));return {submittedAt:time,items:[{requestId:id,recipientName:'Synthetic Alex',result:'registered',registration:{...registration,address:'secret',capability_hash:cap}}]};
 }));
 assert((await response!.json()).data.items[0].registration.registrationCode===registration.registrationCode);
 await rejects(()=>recipientRoute(req('recipient-batches',input),['recipient-batches'],{},ctx(async()=>{throw new Error('must not call DB');},false)),'SERVICE_UNAVAILABLE');
 await rejects(()=>recipientRoute(req('recipient-batches',{...input,items:Array(51).fill(input.items[0])}),['recipient-batches'],{},ctx(async()=>{throw new Error('must not call DB');})),'INVALID_REQUEST');
 await rejects(()=>recipientRoute(req('recipient-batches',{...input,items:[{...input.items[0],number:'SYNTH12345'}]}),['recipient-batches'],{},ctx(async()=>{throw new Error('must not call DB');})),'INVALID_REQUEST');
});
Deno.test('private management updates own name/contact only and withdrawal uses revision',async()=>{
 for(const input of [{revision:1,recipientName:'Corrected Synthetic'},{revision:1,contact},{revision:1,recipientName:'Corrected Synthetic',contact}]){
  await recipientRoute(req(`recipient-manage/${registration.registrationCode}`,input,cap,'PATCH'),['recipient-manage',registration.registrationCode],{},ctx(async(name,payload)=>{assert(name==='pdd_recipient_manage_update'&&payload.action==='update'&&payload.revision===1);return registration;}));
 }
 await rejects(()=>recipientRoute(req(`recipient-manage/${registration.registrationCode}`,{revision:1},cap,'PATCH'),['recipient-manage',registration.registrationCode],{},ctx(async()=>{throw new Error('must not call DB');})),'INVALID_REQUEST');
 await recipientRoute(req(`recipient-manage/${registration.registrationCode}/withdraw`,{revision:1}),['recipient-manage',registration.registrationCode,'withdraw'],{},ctx(async(name,payload)=>{assert(name==='pdd_recipient_manage_update'&&payload.action==='withdraw');return {...registration,state:'withdrawn'};}));
 const projected=recipientRegistration({...registration,capability_hash:cap,number:'SYNTH12345'});assert(!('capability_hash'in projected)&&!('number'in projected));
});
Deno.test('administrative list/log/action requires admin and never projects capability or snapshots',async()=>{
 const never=ctx(async()=>{throw new Error('must not call DB');});
 for(const path of ['recipients','recipient-queries'])await rejects(()=>recipientRoute(new Request(`https://pdd404.app/v1/admin/${path}`),['admin',path],{},never),'FORBIDDEN');
 const response=await recipientRoute(new Request('https://pdd404.app/v1/admin/recipient-queries'),['admin','recipient-queries'],{},ctx(async()=>({items:[{queryId:id,recipientName:lead.recipientName,mode:'lost',result:'leads_found',queriedAt:time,contact,capability_hash:cap}],nextOffset:null}),true,true));
 const value=(await response!.json()).data;assert(!('contact'in value.items[0])&&!('capability_hash'in value.items[0]));
 await recipientRoute(req(`admin/recipients/${registration.registrationCode}/actions`,{revision:1,action:'close'}),['admin','recipients',registration.registrationCode,'actions'],{},ctx(async(name,payload)=>{assert(name==='pdd_recipient_admin_action'&&payload.actor_id===id);return {registration,events:[{id,action:'admin_close',actorId:id,notes:'private accidental note',createdAt:time,contact}]};},true,true));
});
Deno.test('optional attached name is validated without changing old batch body hashes',async()=>{
 const original={mode:'received',contact,items:[{requestId:id,number:'SYNTH12345',source:'manual'}]};
 for(const input of [original,{...original,items:[{...original.items[0],recipientName:' Synthetic Alex '}]}])await pddRoute(req('waybill-batches',input),['waybill-batches'],{},ctx(async(name,payload)=>{assert(name==='pdd_batch_register'&&payload.body_hash===await sha256(canonicalJson(input)));if('recipientName'in input.items[0])assert(payload.items[0].recipient_name==='Synthetic Alex');else assert(!('recipient_name'in payload.items[0]));return{submittedAt:time,items:[]};}));
});

Deno.test('optional waybill name treats noncontrol whitespace as empty without changing the body hash', async () => {
 const input={mode:'received',contact,items:[{requestId:id,number:'SYNTH12345',source:'manual',recipientName:' \u00a0\u2003\uFEFF '}]};
 await pddRoute(req('waybill-batches',input),['waybill-batches'],{},ctx(async(name,payload)=>{
  assert(name==='pdd_batch_register'&&payload.items[0].recipient_name===null);
  assert(payload.body_hash===await sha256(canonicalJson(input)));
  return{submittedAt:time,items:[]};
 }));
 await rejects(()=>pddRoute(req('waybill-batches',{...input,items:[{...input.items[0],recipientName:' \t '}]}),['waybill-batches'],{},ctx(async()=>{throw new Error('must not call DB');})),'INVALID_RECIPIENT_NAME');
});
