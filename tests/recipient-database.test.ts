import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { PddRecipientBatchResult, PddRecipientQueryResult, PddRecipientRegistration, PddRecipientAdminDetail } from '../shared/recipient.ts';
import { normalizeRecipientName, validateRecipientName } from '../shared/recipient.ts';
import type { PddBatchResult, PddRegistration } from '../shared/waybill.ts';
let db: PGlite;
const capA='a'.repeat(64),capB='b'.repeat(64),capC='c'.repeat(64);
const contact={kind:'wechat',value:'synthetic_person'};
const directory=new URL('../supabase/migrations/',import.meta.url);
beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 await db.exec(`create schema extensions;create role anon;create role authenticated;create role service_role bypassrls;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create schema net;create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
 create schema cron;create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as 'select 1::bigint';`);
 for(const name of(await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort())await db.exec((await readFile(new URL(name,directory),'utf8')).replace(/^create extension if not exists pg_net.*$/m,'').replace(/^create extension if not exists pg_cron.*$/m,''));
},30_000);
beforeEach(async()=>{await db.exec('begin;');});afterEach(async()=>{await db.exec('rollback; reset role;');});afterAll(async()=>{await db?.close();});
async function rpc<T=Record<string,any>>(name:string,payload:Record<string,unknown>={}):Promise<T>{return(await db.query<{value:T}>(`select public.${name}($1::jsonb) value`,[JSON.stringify(payload)])).rows[0].value;}
const payload=(name:string,mode='received',cap=capA,value=contact.value)=>({request_id:randomUUID(),mode,contact:{...contact,value},note:'Synthetic private note',capability_hash:cap,body_hash:randomUUID(),items:[{request_id:randomUUID(),recipient_name:name}]});
async function register(name:string,mode='received',cap=capA,value=contact.value){return(await rpc<PddRecipientBatchResult>('pdd_recipient_batch_register',payload(name,mode,cap,value))).items[0].registration!;}
const queryPayload=(name:string,mode='lost',cap=capB)=>({query_id:randomUUID(),recipient_name:name,mode,capability_hash:cap,body_hash:randomUUID()});
async function query(name:string,mode='lost',cap=capB){return rpc<PddRecipientQueryResult>('pdd_recipient_query',queryPayload(name,mode,cap));}
async function error(name:string,input:Record<string,unknown>,message:string,code?:string){await db.exec('savepoint expected_error;');try{const check=expect(rpc(name,input)).rejects;if(code)await check.toMatchObject({code,message:expect.stringContaining(message)});else await check.toThrow(message);}finally{await db.exec('rollback to savepoint expected_error;release savepoint expected_error;');}}

describe('recipient leads transactional boundaries',()=>{
 it('uses identical NFC/whitespace/ASCII-case rules at DB and JS boundaries',async()=>{
  for(const name of [' ALEX\u00a0\u2003 Chen\uFEFF','Jose\u0301','ÄLEX 小明 สมชาย-二','A\u2028\u2029B','😀'.repeat(80)]){
   expect((await db.query<{value:string}>('select public.pdd_recipient_name($1) value',[name])).rows[0].value).toBe(validateRecipientName(name));
   expect((await db.query<{value:string}>('select public.pdd_recipient_key($1) value',[name])).rows[0].value).toBe(normalizeRecipientName(name));
  }
  for(const name of ['', ' ', '小明\n','小明\u0085','😀'.repeat(81)])await error('pdd_recipient_query',queryPayload(name),'INVALID_RECIPIENT_NAME','22023');
 });
 it('does not manufacture parcels, ownership, match or return statistics from same names',async()=>{
  const before=await rpc('pdd_home_stats');
  await register('合成小明');await register('合成小明','lost',capB);
  expect((await query('合成小明')).result).toBe('leads_found');
  expect(await rpc('pdd_home_stats')).toEqual(before);
  expect((await db.query('select * from public.pdd_waybills')).rows).toHaveLength(0);
  expect((await db.query('select * from public.pdd_handovers')).rows).toHaveLength(0);
 });
 it('union-queries valid opposite attached names and independent names without public identifiers',async()=>{
  const wb=await rpc<PddBatchResult>('pdd_batch_register',{request_id:randomUUID(),mode:'received',contact,note:'Attached note',capability_hash:capA,body_hash:'waybill-name',items:[{request_id:randomUUID(),number:'SYNTHNAME001',source:'barcode',recipient_name:'Synthetic Alex'}]});
  await register('Synthetic Alex','received',capC,'synthetic_other');await register('Synthetic Alex','lost',capB,'synthetic_owner');
  const found=await query('synthetic alex');expect(found.leads).toHaveLength(2);
  for(const lead of found.leads)expect(Object.keys(lead).sort()).toEqual(['contact','note','recipientName','registeredAt']);
  expect(JSON.stringify(found)).not.toContain('SYNTHNAME001');expect(JSON.stringify(found)).not.toContain('PDD-');expect(JSON.stringify(found)).not.toContain(capA);
  expect(wb.items[0]).toMatchObject({recipientNameSaved:true,registration:{recipientName:'Synthetic Alex'}});
  expect(await rpc('pdd_home_stats')).toEqual({lostRegistered:0,receivedRegistered:1,matchedParcels:0});
  expect(await query('Alex')).toMatchObject({result:'not_found',leads:[]});
  await db.exec("update public.pdd_waybills set resolution='resolved',closed_at=now();");
  expect((await query('Synthetic Alex')).leads).toHaveLength(1);
  const publicRecord=await rpc('pdd_public',{public_code:wb.items[0].record.code});expect(publicRecord).not.toHaveProperty('recipientName');
 });
 it('persists every row name and refuses overwriting duplicate/closed sides',async()=>{
  const input={request_id:randomUUID(),mode:'lost',contact,capability_hash:capA,body_hash:'10names',items:Array.from({length:10},(_,i)=>({request_id:randomUUID(),number:`NAMEBATCH${String(i).padStart(3,'0')}`,source:'manual',recipient_name:`合成收件人${i}`}))};
  const first=await rpc<PddBatchResult>('pdd_batch_register',input);expect(first.items.every(item=>item.recipientNameSaved)).toBe(true);
  expect(first.items.map(item=>item.registration!.recipientName)).toEqual(input.items.map(item=>item.recipient_name));
  expect(await rpc('pdd_batch_register',input)).toEqual(first);
  const changed={...input,request_id:randomUUID(),body_hash:'duplicates',items:input.items.map(i=>({...i,request_id:randomUUID(),recipient_name:'Attempted overwrite'}))};
  const duplicate=await rpc<PddBatchResult>('pdd_batch_register',changed);expect(duplicate.items.every(item=>item.recipientNameSaved===false&&item.registration===null)).toBe(true);
  await db.exec("update public.pdd_waybills set resolution='resolved',closed_at=now();");
  const closed=await rpc<PddBatchResult>('pdd_batch_register',{...changed,request_id:randomUUID(),body_hash:'closed'});expect(closed.items.every(item=>item.result==='closed'&&item.recipientNameSaved===false)).toBe(true);
  const names=(await db.query<{recipient_name:string}>('select recipient_name from public.pdd_registrations order by recipient_name')).rows;expect(names.every(row=>row.recipient_name.startsWith('合成收件人'))).toBe(true);
 });
 it('saves a new side name even when transactional recheck finds an exact opposite match',async()=>{
  const opposite=await rpc<PddBatchResult>('pdd_batch_register',{request_id:randomUUID(),mode:'received',contact,capability_hash:capA,body_hash:'holder-side',items:[{request_id:randomUUID(),number:'MATCHNAMES001',source:'manual',recipient_name:'Holder Synthetic'}]});
  const first=await rpc<PddBatchResult>('pdd_batch_register',{request_id:randomUUID(),mode:'lost',contact:{...contact,value:'synthetic_owner'},capability_hash:capB,body_hash:'owner-side',items:[{request_id:randomUUID(),number:'MATCHNAMES001',source:'manual',recipient_name:'Owner Synthetic'}]});
  expect(first.items[0]).toMatchObject({result:'matched',recipientNameSaved:true,registration:{recipientName:'Owner Synthetic'}});
  expect(await rpc('pdd_manage',{registration_code:opposite.items[0].registration!.registrationCode,capability_hash:capA})).toMatchObject({recipientName:'Holder Synthetic'});
  expect((await query('Holder Synthetic','lost')).leads).toHaveLength(1);expect((await query('Owner Synthetic','received')).leads).toHaveLength(1);
 });
 it('allows opposite-name registration, deduplicates exact contact and preserves own-only receipts',async()=>{
  const input=payload('合成小明');const first=await rpc<PddRecipientBatchResult>('pdd_recipient_batch_register',input);
  expect(await rpc('pdd_recipient_batch_register',input)).toEqual(first);
  const duplicate=await rpc<PddRecipientBatchResult>('pdd_recipient_batch_register',payload('合成小明','received',capB));expect(duplicate.items[0]).toMatchObject({result:'duplicate',registration:null});
  await register('合成小明','received',capC,'synthetic_second');await register('合成小明','lost',capB);
  expect((await db.query('select * from public.pdd_recipient_leads')).rows).toHaveLength(3);
  await error('pdd_recipient_batch_register',{...input,capability_hash:capB},'IDEMPOTENCY_CONFLICT','P0001');
  await error('pdd_recipient_batch_register',{...input,body_hash:'changed'},'IDEMPOTENCY_CONFLICT','P0001');
  await error('pdd_recipient_manage',{registration_code:first.items[0].registration!.registrationCode,capability_hash:capB},'FORBIDDEN','42501');
 });
 it('validates entire batch and boundaries before committing a partial registration',async()=>{
  const invalid=payload('Valid Name');invalid.items.push({request_id:randomUUID(),recipient_name:'bad\tname'});
  await error('pdd_recipient_batch_register',invalid,'INVALID_RECIPIENT_NAME');expect((await db.query('select * from public.pdd_recipient_leads')).rows).toHaveLength(0);
  await error('pdd_recipient_batch_register',{...payload('A'),items:Array.from({length:51},(_,i)=>({request_id:randomUUID(),recipient_name:`Person ${i}`}))},'INVALID_REQUEST');
  await error('pdd_recipient_batch_register',{...payload('A'),note:'😀'.repeat(501)},'INVALID_REQUEST');
  await error('pdd_recipient_batch_register',{...payload('A'),items:[{request_id:randomUUID(),recipient_name:'Alex'},{request_id:randomUUID(),recipient_name:'ALEX'}]},'INVALID_REQUEST');
 });
 it('uses opaque query-bound keyset pages and rechecks withdrawals without skipping subsequent rows',async()=>{
  const regs=[];for(let i=0;i<25;i++)regs.push(await register('Shared Synthetic Name','received',capA,`synthetic_person_${String(i).padStart(2,'0')}`));
  const input=queryPayload('Shared Synthetic Name');const first=await rpc<PddRecipientQueryResult>('pdd_recipient_query',input);expect(first.leads).toHaveLength(20);expect(first.nextCursor).toMatch(/^[0-9a-f-]{36}$/);
  const next=await rpc<PddRecipientQueryResult>('pdd_recipient_query_page',{query_id:input.query_id,cursor:first.nextCursor,capability_hash:capB});expect(next.leads).toHaveLength(5);expect(next.nextCursor).toBeNull();
  await error('pdd_recipient_query_page',{query_id:input.query_id,cursor:first.nextCursor,capability_hash:capC},'FORBIDDEN');
  const other=await query('Shared Synthetic Name');await error('pdd_recipient_query_page',{query_id:other.queryId,cursor:first.nextCursor,capability_hash:capB},'INVALID_REQUEST');
  const removed=regs.find(r=>r.contact!.value===next.leads[0].contact.value)!;
  await rpc('pdd_recipient_manage_update',{registration_code:removed.registrationCode,capability_hash:capA,revision:removed.revision,action:'withdraw'});
  const fresh=await rpc<PddRecipientQueryResult>('pdd_recipient_query_page',{query_id:input.query_id,cursor:first.nextCursor,capability_hash:capB});expect(fresh.leads).toHaveLength(4);expect(fresh.leads.every(l=>l.contact.value!==removed.contact!.value)).toBe(true);
  const logged=(await db.query('select * from public.pdd_recipient_query_events')).rows;expect(JSON.stringify(logged)).not.toContain('synthetic_person_');expect(JSON.stringify(logged)).not.toContain('Synthetic private note');
 });
 it('renames and updates contact atomically, rejects collisions without changing revision, and stops disclosure',async()=>{
  const first=await register('First Synthetic');const second=await register('Second Synthetic');
  await error('pdd_recipient_manage_update',{registration_code:second.registrationCode,capability_hash:capA,revision:second.revision,action:'update',recipient_name:'First Synthetic'},'DUPLICATE_RECIPIENT','P0001');
  expect(await rpc('pdd_recipient_manage',{registration_code:second.registrationCode,capability_hash:capA})).toEqual(second);
  const changed=await rpc<PddRecipientRegistration>('pdd_recipient_manage_update',{registration_code:first.registrationCode,capability_hash:capA,revision:first.revision,action:'update',recipient_name:'Renamed Synthetic',contact:{kind:'phone',value:'+66 81 234 5678'}});
  expect((await query('First Synthetic')).result).toBe('not_found');expect((await query('Renamed Synthetic')).leads[0].contact.kind).toBe('phone');
  await error('pdd_recipient_manage_update',{registration_code:changed.registrationCode,capability_hash:capA,revision:first.revision,action:'withdraw'},'VERSION_CONFLICT','P0001');
  await rpc('pdd_recipient_manage_update',{registration_code:changed.registrationCode,capability_hash:capA,revision:changed.revision,action:'withdraw'});expect((await query('Renamed Synthetic')).result).toBe('not_found');
  const events=(await db.query('select * from public.pdd_recipient_audit_events')).rows;expect(JSON.stringify(events)).not.toContain('Synthetic');expect(JSON.stringify(events)).not.toContain('81 234');
 });
 it('lets a waybill owner change their own name without touching the opposite registration',async()=>{
  const initial=await rpc<PddBatchResult>('pdd_batch_register',{request_id:randomUUID(),mode:'received',contact,capability_hash:capA,body_hash:'attached',items:[{request_id:randomUUID(),number:'MANAGENAME123',source:'manual',recipient_name:'Original Synthetic'}]});
  const own=initial.items[0].registration!;
  const changed=await rpc<PddRegistration>('pdd_manage_update',{registration_code:own.registrationCode,capability_hash:capA,revision:own.revision,action:'contact',recipient_name:'New Synthetic'});
  expect(changed).toMatchObject({recipientName:'New Synthetic',contact});expect((await query('Original Synthetic')).result).toBe('not_found');expect((await query('New Synthetic')).leads).toHaveLength(1);
 });
 it('audits individual administrator closure, clears all private data at retention, keeps statistics',async()=>{
  const a=await register('Shared Private');await register('Shared Private','received',capC,'synthetic_other');
  const actor=randomUUID();const detail=await rpc<PddRecipientAdminDetail>('pdd_recipient_admin_action',{registration_code:a.registrationCode,revision:a.revision,actor_id:actor,action:'close'});
  expect(detail.registration.state).toBe('closed');expect(detail.events.some(e=>e.action==='admin_close'&&e.actorId===actor&&e.notes==='')).toBe(true);
  expect((await query('Shared Private')).leads).toHaveLength(1);const before=await rpc('pdd_home_stats');
  await db.exec("update public.pdd_recipient_leads set closed_at=now()-interval '31 days' where state='closed';update public.pdd_recipient_query_events set queried_at=now()-interval '31 days';");
  await rpc('pdd_cleanup');const cleaned=(await db.query('select recipient_name,recipient_name_key,contact,note,capability_hash from public.pdd_recipient_leads where registration_code=$1',[a.registrationCode])).rows[0];
  expect(cleaned).toEqual({recipient_name:null,recipient_name_key:null,contact:null,note:null,capability_hash:''});expect((await db.query('select * from public.pdd_recipient_query_events')).rows).toHaveLength(0);expect(await rpc('pdd_home_stats')).toEqual(before);
  await error('pdd_recipient_manage_update',{registration_code:a.registrationCode,capability_hash:capA,revision:detail.registration.revision,action:'update',recipient_name:'Unauthorized Revival'},'FORBIDDEN');
 });
 it('clears duplicate and registered name receipts after 30 days but preserves nonpersonal retry tombstones',async()=>{
  const originalInput=payload('Retention Duplicate Synthetic');
  const original=(await rpc<PddRecipientBatchResult>('pdd_recipient_batch_register',originalInput)).items[0].registration!;
  const duplicateInput=payload('Retention Duplicate Synthetic','received',capB);
  expect((await rpc<PddRecipientBatchResult>('pdd_recipient_batch_register',duplicateInput)).items[0]).toMatchObject({result:'duplicate',registration:null});
  const duplicateReceipt=(await db.query<{receipt:Record<string,unknown>}>('select receipt from public.pdd_write_requests where key=$1',[duplicateInput.request_id])).rows[0].receipt;
  expect(JSON.stringify(duplicateReceipt)).toContain('Retention Duplicate Synthetic');
  await db.exec("update public.pdd_write_requests set created_at=now()-interval '31 days' where scope='recipient-batch';");
  await rpc('pdd_cleanup');
  const requests=(await db.query<{key:string;capability_hash:string;body_hash:string;receipt:unknown}>('select key,capability_hash,body_hash,receipt from public.pdd_write_requests where scope=\'recipient-batch\' order by key')).rows;
  expect(requests).toHaveLength(2);expect(requests.every(row=>Array.isArray(row.receipt)&&row.receipt.length===0)).toBe(true);
  expect(requests.find(row=>row.key===duplicateInput.request_id)).toMatchObject({capability_hash:capB,body_hash:duplicateInput.body_hash});
  expect(JSON.stringify(requests)).not.toContain('Retention Duplicate Synthetic');
  await rpc('pdd_recipient_manage_update',{registration_code:original.registrationCode,capability_hash:capA,revision:original.revision,action:'withdraw'});
  await error('pdd_recipient_batch_register',duplicateInput,'IDEMPOTENCY_CONFLICT','P0001');
  await error('pdd_recipient_batch_register',originalInput,'IDEMPOTENCY_CONFLICT','P0001');
  expect((await db.query('select * from public.pdd_recipient_leads')).rows).toHaveLength(1);
  expect((await query('Retention Duplicate Synthetic')).result).toBe('not_found');
  expect((await rpc<PddRecipientBatchResult>('pdd_recipient_batch_register',payload('Retention Duplicate Synthetic','received',capB))).items[0].result).toBe('registered');
 });
 it('keeps new RLS tables and every helper inaccessible to browser roles',async()=>{
  for(const table of ['pdd_recipient_leads','pdd_recipient_query_events','pdd_recipient_audit_events']){
   expect((await db.query("select has_table_privilege('anon',$1,'SELECT') anon,has_table_privilege('authenticated',$1,'SELECT') authenticated,(select relrowsecurity from pg_class where oid=$1::regclass) rls",[`public.${table}`])).rows[0]).toEqual({anon:false,authenticated:false,rls:true});
  }
  const roles=(await db.query<{anon:boolean;authenticated:boolean}>("select has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'pdd_recipient_%'")).rows;expect(roles.length).toBeGreaterThan(10);expect(roles.every(r=>!r.anon&&!r.authenticated)).toBe(true);
 });
});
