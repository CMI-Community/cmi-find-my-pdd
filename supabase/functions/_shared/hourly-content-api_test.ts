import { hourlyContentRoute, createHourlyPublicCache } from './hourly-content-api.ts';
import { hourlyDashboard } from '../../../shared/hourly-content.ts';
import { ApiError } from './http.ts';
const now=Date.parse('2026-10-09T03:05:00Z'), six={lostRegistered:3,receivedRegistered:1,matchedParcels:0,lostRecipientRegistered:2,receivedRecipientRegistered:0,matchedRecipientLeads:0};
function assert(value:unknown):asserts value{if(!value)throw new Error('assertion failed');}
const raw={sampledAt:'2026-10-09T03:05:00Z',metricVersion:'home-six-lifetime-v1',stats:six,snapshots:[{hour:'2026-10-09T03:00:00Z',sampledAt:'2026-10-09T03:00:03Z',metricVersion:'home-six-lifetime-v1',stats:six}],observations:[],nextBefore:null};
async function rejects(fn:()=>Promise<unknown>,code:string){try{await fn();throw new Error('accepted invalid');}catch(error){assert(error instanceof ApiError&&error.code===code);}}
const request=(query:string)=>new Request('https://pdd404.app/v1/insights/dashboard'+query);
Deno.test('hourly dashboard strips private fields and preserves real capture gaps',()=>{
 const value=hourlyDashboard({...raw,actorId:'private',rawInput:'private',stats:{...six,contact:'private'},snapshots:[{...raw.snapshots[0],secret:'private'}]});
 assert(!JSON.stringify(value).includes('private'));assert(value.snapshots.length===1&&value.snapshots[0].sampledAt==='2026-10-09T03:00:03Z');
});
Deno.test('hourly public routes reject unbounded, repeated and invalid date windows before RPC',async()=>{
 let calls=0;const context={now:()=>now,rpc:()=>{calls++;return Promise.resolve(raw);}};
 for(const query of ['?hours=721','?hours=0','?hours=1&hours=2','?hours=24&date=2026-10-09','?date=2026-10-10','?date=2026-09-09','?includePrivate=true','?before=secret'])await rejects(()=>hourlyContentRoute(request(query),['insights','dashboard'],{},context),'INVALID_REQUEST');
 assert(Number(calls)===0);
 await hourlyContentRoute(request('?date=2026-10-09'),['insights','dashboard'],{},context);assert(Number(calls)===1);
});
Deno.test('malformed stats, inverted samples and invalid feed chronology fail closed',async()=>{
 for(const value of [{...raw,stats:{lostRegistered:0}},{...raw,snapshots:[{...raw.snapshots[0],sampledAt:'2026-10-09T02:59:00Z'}]},{...raw,observations:[{id:'10000000-0000-4000-8000-000000000001',category:'单号登记',text:'合成事实',publishedAt:'2026-10-09T03:05:00Z',windowStart:'2026-10-09T03:00:00Z',windowEnd:'2026-10-09T04:00:00Z'}]}])await rejects(()=>hourlyContentRoute(request(''),['insights','dashboard'],{},{now:()=>now,rpc:()=>Promise.resolve(value)}),'SERVICE_UNAVAILABLE');
});
Deno.test('public cache coalesces and expires only safe successes, failed loads remain unknown',async()=>{
 let time=0,calls=0;const get=createHourlyPublicCache(30,()=>time),load=()=>{calls++;return Promise.resolve('safe');};
 assert((await Promise.all([get('one',load),get('one',load)])).length===2&&calls===1);time=31;await get('one',load);assert(Number(calls)===2);
 for(let i=0;i<2;i++){try{await get('fail',()=>{calls++;throw new Error('source unavailable');});}catch{}}assert(Number(calls)===4);
});
