import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import type { PddBatchResult, PddHomeStats, PddRegistration } from '../shared/waybill.ts';
import type { PddRecipientBatchResult, PddRecipientQueryResult, PddRecipientRegistration } from '../shared/recipient.ts';

const migrationName='20261007121000_home_recipient_stats.sql';
const directory=new URL('../supabase/migrations/',import.meta.url);
const capA='a'.repeat(64),capB='b'.repeat(64);
const contact={kind:'wechat',value:'synthetic_stats_person'};
let db:PGlite;
async function database(includeStats=true){
 const instance=new PGlite({extensions:{pgcrypto}});
 await instance.exec(`create schema extensions;create role anon;create role authenticated;create role service_role bypassrls;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create schema net;create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
 create schema cron;create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as 'select 1::bigint';`);
 for(const name of(await readdir(directory)).filter(name=>/^\d+_.+\.sql$/.test(name)&& (includeStats||name!==migrationName)).sort()){
  await instance.exec((await readFile(new URL(name,directory),'utf8')).replace(/^create extension if not exists pg_net.*$/m,'').replace(/^create extension if not exists pg_cron.*$/m,''));
 }
 return instance;
}
beforeAll(async()=>{db=await database();},30_000);
beforeEach(async()=>{await db.exec('begin;');});
afterEach(async()=>{await db.exec('rollback; reset role;');});
afterAll(async()=>{await db?.close();});
async function rpc<T=Record<string,any>>(name:string,payload:Record<string,unknown>={},instance=db):Promise<T>{
 return(await instance.query<{value:T}>(`select public.${name}($1::jsonb) value`,[JSON.stringify(payload)])).rows[0].value;
}
const parcelStats=(stats:PddHomeStats)=>({lostRegistered:stats.lostRegistered,receivedRegistered:stats.receivedRegistered,matchedParcels:stats.matchedParcels});
const waybillPayload=(number:string,mode='received',name?:string)=>({request_id:randomUUID(),mode,contact,capability_hash:capA,body_hash:randomUUID(),items:[{request_id:randomUUID(),number,source:'manual',...(name?{recipient_name:name}:{})}]});
async function waybill(number:string,mode='received',name?:string){return(await rpc<PddBatchResult>('pdd_batch_register',waybillPayload(number,mode,name))).items[0].registration!;}
const recipientPayload=(name:string,mode='received',person=contact.value)=>({request_id:randomUUID(),mode,contact:{...contact,value:person},capability_hash:capA,body_hash:randomUUID(),items:[{request_id:randomUUID(),recipient_name:name}]});
async function recipient(name:string,mode='received',person=contact.value){return(await rpc<PddRecipientBatchResult>('pdd_recipient_batch_register',recipientPayload(name,mode,person))).items[0].registration!;}
const queryPayload=(name:string,mode='lost')=>({query_id:randomUUID(),recipient_name:name,mode,capability_hash:capB,body_hash:randomUUID()});
const stats=()=>rpc<PddHomeStats>('pdd_home_stats');

describe('six lifetime homepage statistics',()=>{
 it('counts formal records from both sources and sides, with no duplicate or query-miss registration',async()=>{
  expect(await stats()).toEqual({lostRegistered:0,receivedRegistered:0,matchedParcels:0,lostRecipientRegistered:0,receivedRecipientRegistered:0,matchedRecipientLeads:0});
  const named=waybillPayload('SYNTHSTATS001','received','Shared Synthetic');
  await rpc('pdd_batch_register',named);await rpc('pdd_batch_register',named);
  await rpc('pdd_batch_register',waybillPayload('SYNTHSTATS001','received','Attempted duplicate'));
  await waybill('SYNTHSTATS002','lost','Shared Synthetic');await waybill('SYNTHSTATS003');
  const input=recipientPayload('Shared Synthetic');await rpc('pdd_recipient_batch_register',input);await rpc('pdd_recipient_batch_register',input);
  await rpc('pdd_recipient_batch_register',recipientPayload('SHARED SYNTHETIC'));
  await recipient('Shared Synthetic','received','synthetic_stats_second');await recipient('Shared Synthetic','lost');
  const before=await stats();
  expect(before).toEqual({lostRegistered:1,receivedRegistered:2,matchedParcels:0,lostRecipientRegistered:2,receivedRecipientRegistered:3,matchedRecipientLeads:0});
  expect(await rpc('pdd_recipient_query',queryPayload('Synthetic missing name'))).toMatchObject({result:'not_found',leads:[]});
  expect(await stats()).toEqual(before);
  expect(Object.keys(before).sort()).toEqual(['lostRecipientRegistered','lostRegistered','matchedParcels','matchedRecipientLeads','receivedRecipientRegistered','receivedRegistered'].sort());
 });
 it('marks a late attached name once and keeps counts through rename, clear, withdrawal and privacy cleanup',async()=>{
  let own=await waybill('SYNTHLATE001','lost');
  const before=await stats();expect(before.lostRecipientRegistered).toBe(0);
  own=await rpc<PddRegistration>('pdd_manage_update',{registration_code:own.registrationCode,capability_hash:capA,revision:own.revision,action:'contact',recipient_name:'Synthetic late name'});
  const first=(await db.query<{recipient_registered_at:string}>('select recipient_registered_at::text from public.pdd_registrations where registration_code=$1',[own.registrationCode])).rows[0].recipient_registered_at;
  expect(first).not.toBeNull();expect((await stats()).lostRecipientRegistered).toBe(1);
  for(const name of ['Synthetic renamed name',null,'Synthetic restored name']){
   own=await rpc<PddRegistration>('pdd_manage_update',{registration_code:own.registrationCode,capability_hash:capA,revision:own.revision,action:'contact',recipient_name:name});
   expect((await stats()).lostRecipientRegistered).toBe(1);
   expect((await db.query<{recipient_registered_at:string|null}>('select recipient_registered_at::text from public.pdd_registrations where registration_code=$1',[own.registrationCode])).rows[0].recipient_registered_at).toBe(first);
  }
  await rpc('pdd_recipient_query',queryPayload('Synthetic restored name','received'));
  const registered=await stats();expect(registered.matchedRecipientLeads).toBe(1);expect(parcelStats(registered)).toEqual(parcelStats(before));
  own=await rpc<PddRegistration>('pdd_manage_update',{registration_code:own.registrationCode,capability_hash:capA,revision:own.revision,action:'withdraw'});
  await db.query("update public.pdd_registrations set closed_at=now()-interval '31 days' where registration_code=$1",[own.registrationCode]);
  await rpc('pdd_cleanup');
  expect((await db.query('select recipient_name,recipient_name_key,contact,note,capability_hash,recipient_registered_at::text,recipient_matched_at::text from public.pdd_registrations where registration_code=$1',[own.registrationCode])).rows[0]).toMatchObject({recipient_name:null,recipient_name_key:null,contact:null,note:null,capability_hash:'',recipient_registered_at:first,recipient_matched_at:expect.any(String)});
  expect(await stats()).toEqual(registered);
 });
 it('marks both returned sources on both query sides and never counts identity or actual returns',async()=>{
  await waybill('SYNTHSIDES001','received','Synthetic recipient');await waybill('SYNTHSIDES002','lost','Synthetic recipient');
  await recipient('Synthetic recipient');await recipient('Synthetic recipient','lost');
  const before=await stats();
  for(const mode of ['lost','received']){
   const input=queryPayload('Synthetic recipient',mode);const result=await rpc<PddRecipientQueryResult>('pdd_recipient_query',input);
   expect(result.leads).toHaveLength(2);expect(Object.keys(result).sort()).toEqual(['leads','nextCursor','queriedAt','queryId','result']);
   expect(result.leads.every(lead=>Object.keys(lead).sort().join(',')==='contact,note,recipientName,registeredAt')).toBe(true);
   await rpc('pdd_recipient_query',input);await rpc('pdd_recipient_query',queryPayload('Synthetic recipient',mode));
  }
  expect((await stats()).matchedRecipientLeads).toBe(4);expect(parcelStats(await stats())).toEqual(parcelStats(before));
  expect((await db.query('select * from public.pdd_handovers')).rows).toHaveLength(0);
  expect((await db.query('select * from public.pdd_query_events')).rows).toHaveLength(0);
 });
 it('marks only returned pages, never the 21st probe or a withdrawn/unread/newer row, and preserves marks on page replays',async()=>{
  const name='Synthetic paged recipient';
  await waybill('SYNTHPAGE001','received',name);
  const records:PddRecipientRegistration[]=[];
  for(let i=0;i<22;i++)records.push(await recipient(name,'received',`synthetic_page_${i}`));
  const input=queryPayload(name);const first=await rpc<PddRecipientQueryResult>('pdd_recipient_query',input);
  expect(first.leads).toHaveLength(20);expect(first.nextCursor).not.toBeNull();expect((await stats()).matchedRecipientLeads).toBe(20);
  const beforeMarkers=(await db.query<{id:string;recipient_matched_at:string|null}>('select id,recipient_matched_at::text from public.pdd_recipient_leads')).rows;
  const unread=(await db.query<{registration_code:string}>('select registration_code from public.pdd_recipient_leads where recipient_matched_at is null order by created_at,id')).rows;
  // The source-independent first page can include 19 or 20 independent rows.
  const hidden=records.find(record=>record.registrationCode===unread[0].registration_code)!;
  await rpc('pdd_recipient_manage_update',{registration_code:hidden.registrationCode,capability_hash:capA,revision:hidden.revision,action:'withdraw'});
  const newer=await recipient(name,'received','synthetic_page_newer');
  await db.query("update public.pdd_recipient_leads set created_at=now()+interval '1 second' where registration_code=$1",[newer.registrationCode]);
  const page={query_id:input.query_id,cursor:first.nextCursor,capability_hash:capB};
  const second=await rpc<PddRecipientQueryResult>('pdd_recipient_query_page',page);
  expect(second.leads).toHaveLength(2);expect(second.nextCursor).toBeNull();expect((await stats()).matchedRecipientLeads).toBe(22);
  expect(await rpc('pdd_recipient_query_page',page)).toEqual(second);expect((await stats()).matchedRecipientLeads).toBe(22);
  await rpc('pdd_recipient_query',input);expect((await stats()).matchedRecipientLeads).toBe(22);
  const final=(await db.query<{id:string;recipient_matched_at:string|null}>('select id,recipient_matched_at::text from public.pdd_recipient_leads')).rows;
  for(const row of beforeMarkers.filter(row=>row.recipient_matched_at!==null))expect(final.find(after=>after.id===row.id)?.recipient_matched_at).toBe(row.recipient_matched_at);
  expect((await db.query<{recipient_matched_at:string|null}>('select recipient_matched_at from public.pdd_recipient_leads where registration_code in ($1,$2)',[hidden.registrationCode,newer.registrationCode])).rows.every(row=>row.recipient_matched_at===null)).toBe(true);
 });
 it('keeps independent lead counts and first match timestamps after closure and privacy cleanup',async()=>{
  let lead=await recipient('Synthetic cleanup recipient');await rpc('pdd_recipient_query',queryPayload('Synthetic cleanup recipient'));
  const before=await stats();const stamp=(await db.query<{recipient_matched_at:string|null}>('select recipient_matched_at::text from public.pdd_recipient_leads where registration_code=$1',[lead.registrationCode])).rows[0].recipient_matched_at;
  lead=await rpc<PddRecipientRegistration>('pdd_recipient_manage_update',{registration_code:lead.registrationCode,capability_hash:capA,revision:lead.revision,action:'update',recipient_name:'Synthetic changed recipient'});
  await rpc('pdd_recipient_query',queryPayload('Synthetic changed recipient'));
  expect(await stats()).toEqual(before);
  await rpc('pdd_recipient_manage_update',{registration_code:lead.registrationCode,capability_hash:capA,revision:lead.revision,action:'withdraw'});
  await db.query("update public.pdd_recipient_leads set closed_at=now()-interval '31 days' where registration_code=$1",[lead.registrationCode]);await rpc('pdd_cleanup');
  expect((await db.query('select recipient_name,contact,recipient_matched_at::text from public.pdd_recipient_leads where registration_code=$1',[lead.registrationCode])).rows[0]).toEqual({recipient_name:null,contact:null,recipient_matched_at:stamp});
  expect(await stats()).toEqual(before);
 });
 it('never discloses stat markers or internal references and keeps the trigger helper server-only',async()=>{
  const own=await waybill('SYNTHPRIVATE001','received','Synthetic private recipient');
  const independent=await recipient('Synthetic private recipient');
  await rpc('pdd_recipient_query',queryPayload('Synthetic private recipient'));
  for(const snapshot of [await rpc('pdd_manage',{registration_code:own.registrationCode,capability_hash:capA}),await rpc('pdd_recipient_manage',{registration_code:independent.registrationCode,capability_hash:capA})]){
   expect(JSON.stringify(snapshot)).not.toMatch(/recipient_registered_at|recipient_matched_at|returnedRefs|recipientRegisteredAt|recipientMatchedAt/);
  }
  expect((await db.query("select has_function_privilege('anon','public.pdd_recipient_stat_markers()','EXECUTE') anon,has_function_privilege('authenticated','public.pdd_recipient_stat_markers()','EXECUTE') authenticated,has_function_privilege('service_role','public.pdd_recipient_stat_markers()','EXECUTE') service")).rows[0]).toEqual({anon:false,authenticated:false,service:true});
 });
});

describe('recipient-stat migration retained evidence',()=>{
 it('rolls back atomically and only backfills proven saves, never historical name-query hits',async()=>{
  const old=await database(false);
  try{
   const fixtures: {input:ReturnType<typeof waybillPayload>;registration:PddRegistration}[]=[];
   for(const [number,name] of [['SYNTHBACK001','Retained Synthetic'],['SYNTHBACK002','Receipt Synthetic'],['SYNTHBACK003','Ambiguous Synthetic'],['SYNTHBACK004',undefined]] as const){
    const input=waybillPayload(number,'received',name);const result=await rpc<PddBatchResult>('pdd_batch_register',input,old);fixtures.push({input,registration:result.items[0].registration!});
   }
   await rpc('pdd_recipient_batch_register',recipientPayload('Independent retained'),old);
   await rpc('pdd_recipient_query',queryPayload('Retained Synthetic'),old);
   // Existing attached name with no surviving receipt is evidence, but its first
   // save time cannot be inferred from the original parcel creation timestamp.
   await old.query('delete from public.pdd_write_requests where key=$1',[fixtures[0].input.request_id]);
   await old.query("update public.pdd_registrations set recipient_name=null,recipient_name_key=null where registration_code in ($1,$2)",[fixtures[1].registration.registrationCode,fixtures[2].registration.registrationCode]);
   await old.query('delete from public.pdd_write_requests where key=$1',[fixtures[2].input.request_id]);
   await old.query("update public.pdd_registrations set created_at=now()-interval '5 days' where registration_code=$1",[fixtures[0].registration.registrationCode]);
   const oldStats=await rpc('pdd_home_stats',{},old);
   const migration=await readFile(new URL(migrationName,directory),'utf8');
   await old.exec('begin;');await old.exec(migration);expect((await rpc('pdd_home_stats',{},old)).receivedRecipientRegistered).toBe(3);await old.exec('rollback;');
   expect((await old.query("select column_name from information_schema.columns where table_name='pdd_registrations' and column_name='recipient_registered_at'")).rows).toHaveLength(0);
   expect(await rpc('pdd_home_stats',{},old)).toEqual(oldStats);
   await old.exec(migration);
   expect(await rpc('pdd_home_stats',{},old)).toEqual({...oldStats,lostRecipientRegistered:0,receivedRecipientRegistered:3,matchedRecipientLeads:0});
   const evidence=(await old.query<{registration_code:string;current_time:boolean;receipt_time:boolean;recipient_registered_at:string|null;recipient_matched_at:string|null}>(`select r.registration_code,r.recipient_registered_at>r.created_at current_time,r.recipient_registered_at=w.created_at receipt_time,r.recipient_registered_at::text,r.recipient_matched_at::text from public.pdd_registrations r left join public.pdd_write_requests w on w.scope='batch' and exists(select 1 from jsonb_array_elements(w.receipt) item where item->>'registrationCode'=r.registration_code) order by r.registration_code`)).rows;
   expect(evidence.find(row=>row.registration_code===fixtures[0].registration.registrationCode)).toMatchObject({current_time:true,recipient_registered_at:expect.any(String),recipient_matched_at:null});
   expect(evidence.find(row=>row.registration_code===fixtures[1].registration.registrationCode)).toMatchObject({receipt_time:true,recipient_registered_at:expect.any(String),recipient_matched_at:null});
   for(const fixture of fixtures.slice(2))expect(evidence.find(row=>row.registration_code===fixture.registration.registrationCode)).toMatchObject({recipient_registered_at:null,recipient_matched_at:null});
  }finally{await old.close();}
 },30_000);
});
