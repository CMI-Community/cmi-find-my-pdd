// Called only by verify-postgres.mjs with its disposable local PostgreSQL client.
// Synthetic historical clocks never write production or backfill snapshots.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const keys=['lostRegistered','receivedRegistered','matchedParcels','lostRecipientRegistered','receivedRecipientRegistered','matchedRecipientLeads'];
const sum=records=>Object.fromEntries(keys.map(key=>[key,records.hours.reduce((total,row)=>total+row.stats[key],0)]));
const zero=Object.fromEntries(keys.map(key=>[key,0]));
const ms=value=>Date.parse(value);
const truncate='truncate public.pdd_waybills,public.pdd_registrations,public.pdd_query_events,public.pdd_write_requests,public.pdd_audit_events,public.pdd_handovers,public.pdd_recipient_leads,public.pdd_recipient_query_events,public.pdd_recipient_audit_events cascade;';
export async function verifyHourlyRecordedHistory({sql,rpc,invoke},database='postgres') {
 const beforeStats=await rpc('pdd_home_stats',{},database);
 const beforeSnapshots=await sql("select coalesce(jsonb_agg(to_jsonb(t) order by hour),'[]')::text from public.pdd_stats_hourly t;",database);
 const beforeHistory=await rpc('pdd_public_hourly_history',{hours:720},database);
 const beforeRecords=beforeHistory.records;
 assert.equal(beforeRecords.metricVersion,'home-six-recorded-additions-v1');
 assert.equal(beforeRecords.until,beforeHistory.sampledAt);
 for(const role of ['anon','authenticated']) await assert.rejects(()=>sql(`set role ${role}; ${invoke('pdd_public_hourly_records',{})}`,database),/permission denied/);
 assert.equal(await sql("select has_function_privilege('service_role','public.pdd_public_hourly_records(jsonb)','EXECUTE') and not has_function_privilege('anon','public.pdd_public_hourly_records(jsonb)','EXECUTE') and not has_function_privilege('authenticated','public.pdd_public_hourly_records(jsonb)','EXECUTE');",database),'t');
 for(const payload of [null,[],{hours:0},{hours:721},{hours:1.5},{hours:'24'},{hours:1,date:'2026-01-01'},{date:'2099-01-01'},{date:'2020-01-01'},{includePrivate:true}]) await assert.rejects(()=>rpc('pdd_public_hourly_records',payload,database),/INVALID_REQUEST/);
 const emptyOut=await sql(`begin; ${truncate} set local role service_role;
 ${invoke('pdd_public_hourly_dashboard',{hours:48})}
 select jsonb_build_object('business',public.pdd_hourly_source('{}')->'businessFirstRecordedAt','queries',public.pdd_hourly_source('{}')->'queriesFirstRecordedAt')::text; rollback;`,database);
 const [empty,emptyClocks]=emptyOut.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
 assert.equal(empty.records.firstRecordedAt,null);assert.deepEqual(empty.records.hours,[]);assert.deepEqual(empty.stats,zero);
 assert.deepEqual(emptyClocks.business,Object.fromEntries(keys.map(key=>[key,null])));assert.deepEqual(emptyClocks.queries,{waybill:null,recipient:null});
 const [w1,w2,w3,r1,r2,r3,r4,r5,n1,n2,q1,q2,q3,q4]=Array.from({length:14},()=>randomUUID());
 const reg=(id,w,mode,at,visibility,registered='null',matched='null')=>`('${id}'::uuid,'${w}'::uuid,'${randomUUID()}'::uuid,'${mode}','manual','${'a'.repeat(64)}','${visibility}',${at},${registered},${matched})`;
 const query=(id,number,at)=>`('${id}'::uuid,'${number}','lost','manual','${'b'.repeat(64)}','synthetic-history-query','not_found',${at})`;
 const output=await sql(`begin; ${truncate}
 create temporary table synthetic_history_clock as select ((now() at time zone 'Asia/Bangkok')::date-2)::timestamp at time zone 'Asia/Bangkok' base;
 grant select on synthetic_history_clock to service_role;
 insert into public.pdd_waybills(id,number,created_at,matched_at) select '${w1}','SFHISTORYCLOCK01',base,base+interval '3 hours 30 minutes' from synthetic_history_clock;
 insert into public.pdd_waybills(id,number,created_at) select '${w2}'::uuid,'SFHISTORYCLOCK02',base+interval '5 hours' from synthetic_history_clock union all select '${w3}'::uuid,'SFHISTORYCLOCK03',base-interval '32 days' from synthetic_history_clock;
 insert into public.pdd_registrations(id,waybill_id,request_id,mode,source,capability_hash,visibility,created_at,recipient_registered_at,recipient_matched_at)
 select v.* from synthetic_history_clock cross join lateral(values
  ${reg(r1,w1,'lost','base','withdrawn',"base+interval '2 hours'","base+interval '4 hours'")},
  ${reg(r2,w1,'lost',"base+interval '3 hours'",'active')},
  ${reg(r3,w1,'received',"base+interval '1 hour'",'active',"base+interval '1 hour 30 minutes'","base+interval '4 hours 15 minutes'")},
  ${reg(r4,w2,'lost',"base+interval '5 hours'",'active')},
  ${reg(r5,w3,'lost',"base-interval '32 days'",'withdrawn')},
  ${reg(randomUUID(),w3,'lost',"base+interval '6 hours'",'active')})v(id,waybill_id,request_id,mode,source,capability_hash,visibility,created_at,recipient_registered_at,recipient_matched_at);
 insert into public.pdd_recipient_leads(id,request_id,mode,capability_hash,state,created_at,recipient_matched_at)
 select '${n1}'::uuid,'${randomUUID()}'::uuid,'lost','','withdrawn',base+interval '23 hours 59 minutes 59 seconds',base+interval '24 hours' from synthetic_history_clock
 union all select '${n2}'::uuid,'${randomUUID()}'::uuid,'received','','closed',base+interval '24 hours',base+interval '25 hours' from synthetic_history_clock;
 insert into public.pdd_query_events(id,number,mode,source,capability_hash,body_hash,result,queried_at)
 select v.* from synthetic_history_clock cross join lateral(values ${query(q1,'PDD404TESTCLOCK',"base-interval '2 hours'")},${query(q2,'SFQUERYCLOCK01',"base+interval '2 hours'")})v(id,number,mode,source,capability_hash,body_hash,result,queried_at);
 insert into public.pdd_recipient_query_events(id,recipient_name,recipient_name_key,mode,capability_hash,body_hash,result,queried_at)
 select '${q3}'::uuid,'合成测试时钟','合成测试时钟','lost','${'c'.repeat(64)}','synthetic-name-clock','not_found',base-interval '2 hours' from synthetic_history_clock
 union all select '${q4}'::uuid,'时钟甲','时钟甲','lost','${'c'.repeat(64)}','synthetic-name-clock-clean','not_found',base+interval '3 hours' from synthetic_history_clock;
 delete from public.pdd_telemetry_daily;
 insert into public.pdd_telemetry_daily(day,event,page,event_count)
 select (now() at time zone 'UTC')::date-i,'pdd_page_view','home',i from generate_series(0,9)i
 union all select (now() at time zone 'UTC')::date-1,'pdd_page_view','help',100
 union all select (now() at time zone 'UTC')::date-1,'pdd_scanner_open','home',999;
 set local role service_role;
 select jsonb_build_object('base',(select base from synthetic_history_clock),'records',public.pdd_public_hourly_records('{"hours":720}'),'day1',public.pdd_public_hourly_records(jsonb_build_object('date',((select base from synthetic_history_clock) at time zone 'Asia/Bangkok')::date::text)),
 'day2',public.pdd_public_hourly_records(jsonb_build_object('date',(((select base from synthetic_history_clock) at time zone 'Asia/Bangkok')::date+1)::text)),
 'businessFirstRecordedAt',public.pdd_hourly_source('{}')->'businessFirstRecordedAt','queriesFirstRecordedAt',public.pdd_hourly_source('{}')->'queriesFirstRecordedAt','legacyDailyTraffic',public.pdd_hourly_source('{}')->'legacyDailyTraffic')::text;
 reset role; delete from public.pdd_registrations where waybill_id='${w3}'; delete from public.pdd_waybills where id='${w3}';
 set local role service_role;
 select jsonb_build_object('stats',public.pdd_home_stats('{}'),'history',public.pdd_public_hourly_history('{"hours":720}'),'dashboard',public.pdd_public_hourly_dashboard('{"hours":720}'))::text;
 rollback;`,database);
 const [fixture,live]=output.split('\n').filter(line=>line.startsWith('{')).map(JSON.parse);
 const base=ms(fixture.base), records=fixture.records;
 assert.equal(ms(records.firstRecordedAt),base-32*86400000);
 assert.deepEqual(sum(records),{lostRegistered:2,receivedRegistered:1,matchedParcels:1,lostRecipientRegistered:2,receivedRecipientRegistered:2,matchedRecipientLeads:4});
 assert(records.hours.length<=721);assert(records.hours.every((row,i)=>i===0||ms(row.hour)-ms(records.hours[i-1].hour)===3600000));
 assert.deepEqual(records.hours.find(row=>ms(row.hour)===base+6*3600000).stats,zero,'A replacement whose side was first registered outside the window must not appear as a new side.');
 assert.deepEqual(records.hours.find(row=>ms(row.hour)===base+7*3600000).stats,zero,'Real empty recorded hours stay zero within the retained series.');
 assert.equal(records.hours.find(row=>ms(row.hour)===base+2*3600000).stats.lostRecipientRegistered,1,'Late-name marker is counted when recorded, not when its parcel row was created.');
 assert.equal(records.hours.find(row=>ms(row.hour)===base+3*3600000).stats.matchedParcels,1);
 assert.equal(records.hours.find(row=>ms(row.hour)===base+4*3600000).stats.matchedRecipientLeads,2);
 assert.equal(fixture.day1.hours.length,24);assert.equal(ms(fixture.day1.from),base);
 assert.deepEqual(sum(fixture.day1),{lostRegistered:2,receivedRegistered:1,matchedParcels:1,lostRecipientRegistered:2,receivedRecipientRegistered:1,matchedRecipientLeads:2});
 assert.deepEqual(sum(fixture.day2),{...zero,receivedRecipientRegistered:1,matchedRecipientLeads:2});
 assert.equal(ms(fixture.businessFirstRecordedAt.lostRegistered),base-32*86400000);
 assert.equal(ms(fixture.businessFirstRecordedAt.receivedRegistered),base+3600000);
 assert.equal(ms(fixture.businessFirstRecordedAt.matchedParcels),base+3.5*3600000);
 assert.equal(ms(fixture.businessFirstRecordedAt.lostRecipientRegistered),base+2*3600000);
 assert.equal(ms(fixture.businessFirstRecordedAt.receivedRecipientRegistered),base+1.5*3600000);
 assert.equal(ms(fixture.businessFirstRecordedAt.matchedRecipientLeads),base+4*3600000);
 assert.equal(ms(fixture.queriesFirstRecordedAt.waybill),base+2*3600000);assert.equal(ms(fixture.queriesFirstRecordedAt.recipient),base+3*3600000);
 assert.equal(fixture.legacyDailyTraffic.truncated,false);assert.equal(fixture.legacyDailyTraffic.events.length,8);
 for(const row of fixture.legacyDailyTraffic.events)assert.deepEqual(Object.keys(row).sort(),['day','count'].sort());
 assert.deepEqual(fixture.legacyDailyTraffic.events.map(row=>row.count),[8,7,6,5,4,3,2,101],'Only eight completed UTC days, combining page views and excluding scan/current/ninth-day counts.');
 assert.deepEqual(sum(live.history.records),live.stats,'Every retained fixture fact is reconciled with exactly the public lifetime six-statistics.');
 assert.deepEqual(live.dashboard.records,live.history.records);assert.equal(live.history.records.until,live.history.sampledAt);
 assert.equal(ms(live.history.records.firstRecordedAt),base);
 for(const row of live.history.records.hours) assert.deepEqual(Object.keys(row.stats).sort(),[...keys].sort());
 assert.deepEqual(Object.keys(live.history.records).sort(),['metricVersion','from','until','firstRecordedAt','hours'].sort());
 const encoded=JSON.stringify(live.history.records);for(const field of ['name','recipientName','number','contact','note','id','capability','registrationCode','businessFirstRecordedAt','queriesFirstRecordedAt','legacyDailyTraffic'])assert(!encoded.includes('"'+field+'"'));
 assert.deepEqual(await rpc('pdd_home_stats',{},database),beforeStats);
 assert.equal(await sql("select coalesce(jsonb_agg(to_jsonb(t) order by hour),'[]')::text from public.pdd_stats_hourly t;",database),beforeSnapshots,'Historical reads never insert, alter or infer hourly snapshots.');
 const restored=await rpc('pdd_public_hourly_history',{hours:720},database);assert.deepEqual(restored.snapshots,beforeHistory.snapshots);
 assert.deepEqual(sum(restored.records),sum(beforeRecords));
 console.log('Recorded-history real PostgreSQL checks passed: first-side dedup before filtering, withdrawn/cleared markers, late-name clocks, distinct first matches, Bangkok exclusive day boundary, real zero/empty hours, exact six-sum reconciliation, service-only safe projection, eight UTC-day traffic and filtered query origins, rollback preserving business/snapshots.');
}
