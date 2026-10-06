import { describe, it, expect } from 'vitest';
// The monitor runs on Node, independently of the public application.
// @ts-expect-error operations module is intentionally plain JavaScript
import { parseMetrics, resources, evaluate, collect, safeMonitorState, previousMonitorState } from '../scripts/monitor.mjs';
describe('private resource monitor',()=>{
  it('retains only aggregate numeric resources and uses CPU counter deltas',()=>{
    const m=parseMetrics('node_cpu_seconds_total{cpu="0",mode="idle"} 180\nnode_cpu_seconds_total{cpu="0",mode="user"} 20\nnode_memory_MemTotal_bytes 1000\nnode_memory_MemAvailable_bytes 200\npg_stat_statements_calls{query="private",userid="secret"} 4');
    expect(JSON.stringify(m)).not.toContain('private');
    expect(resources(m,{cpuTotal:100,cpuIdle:90}).cpuUtilization).toBeCloseTo(.1);
    expect(resources(m,null).cpuUtilization).toBeNull();
    expect(resources(m,null).memoryUtilization).toBe(.8);
  });
  it('does not treat missing data or a failed probe as healthy; avoids one-sample CPU noise',()=>{
    const report={checkedAt:new Date().toISOString(),website:{ok:false,durationMs:20},system:null,metricsState:'unavailable',resources:{cpuUtilization:.99,memoryUtilization:null}};
    expect(evaluate(report,null)).toEqual(['RESOURCE_METRICS_UNAVAILABLE','SERVICE_UNAVAILABLE','WEBSITE_UNAVAILABLE']);
    expect(evaluate(report,{resources:{cpuUtilization:.95}})).toContain('CPU_CRITICAL');
  });
  it('does not invent full memory use when availability is absent or malformed',()=>{
    const missing=parseMetrics('node_memory_MemTotal_bytes 1000');
    expect(resources(missing,null).memoryUtilization).toBeNull();
    for (const value of [null,undefined,-1,1001,Number.NaN,Number.POSITIVE_INFINITY]) {
      expect(resources({...missing,memoryAvailable:value},null).memoryUtilization).toBeNull();
    }
    expect(resources({...missing,memoryAvailable:0},null).memoryUtilization).toBe(1);
  });
  it('warns on verified growth approaching the DB quota',()=>{
    const report={checkedAt:new Date(172800000).toISOString(),website:{ok:true,durationMs:20},system:{ok:true,warnings:[],database:{databaseBytes:400,databaseSizeLimitBytes:500,deadlocks:1,statsResetAt:'fixed'}},metricsState:'available',resources:{}};
    expect(evaluate(report,{growthBaseline:{at:0,bytes:200},system:{database:{deadlocks:0,statsResetAt:'fixed'}}})).toEqual(['DATABASE_LIMIT_WITHIN_7_DAYS','NEW_DEADLOCK']);
  });
  it('projects cache state through a safe allowlist and rejects stale or malformed baselines',()=>{
    const now=Date.now(), report={checkedAt:new Date(now-300000).toISOString(),website:{ok:true,status:200,durationMs:10,secret:'private-secret'},system:{ok:true,ready:true,sha:'a'.repeat(40),durationMs:20,warnings:['DATABASE_SIZE_HIGH','private-sql'],database:{databaseBytes:300,deadlocks:0,statsResetAt:null,contact:'private-contact'}},metricsState:'available',metrics:{cpuTotal:200,cpuIdle:100,memoryTotal:1000,memoryAvailable:900,query:'private-sql'},resources:{cpuUtilization:.5,memoryUtilization:.1,load1:0},alerts:['DATABASE_SIZE_HIGH','private-token'],growthBaseline:{at:now-86400000,bytes:100,credential:'private-token'},MONITOR_SECRET:'private-secret'};
    const safe=safeMonitorState(report);
    expect(JSON.stringify(safe)).not.toMatch(/private-|MONITOR_SECRET|credential|query|contact/);
    expect(safe.alerts).toEqual(['DATABASE_SIZE_HIGH']);
    expect(previousMonitorState(report,now)?.metrics.cpuTotal).toBe(200);
    expect(previousMonitorState({...report,checkedAt:new Date(now-1800001).toISOString()},now)).toBeNull();
    expect(previousMonitorState({...report,checkedAt:new Date(now+1).toISOString()},now)).toBeNull();
    expect(previousMonitorState({...report,checkedAt:'invalid-date'},now)).toBeNull();
    expect(previousMonitorState(null,now)).toBeNull();
  });
  it('keeps live probes running but reports missing/cache-failed CPU history as unavailable',async()=>{
    const env={SUPABASE_PROJECT_ID:'fogncjjsnakbhfdbfvdi',SUPABASE_URL:'https://fogncjjsnakbhfdbfvdi.supabase.co',MONITOR_SECRET:'a'.repeat(64),SUPABASE_SERVICE_ROLE_KEY:'synthetic-private',MONITOR_REQUIRE_BASELINE:'true'};
    const exporter='node_cpu_seconds_total{cpu="0",mode="idle"} 180\nnode_cpu_seconds_total{cpu="0",mode="user"} 20\nnode_memory_MemTotal_bytes 1000\nnode_memory_MemAvailable_bytes 900';
    let calls=0;
    const fetcher=async(url:string)=>{calls++;return url.includes('privileged/metrics')?new Response(exporter):url.includes('ops/status')?Response.json({data:{service:'pdd404',environment:'production',ok:true,ready:true,sha:'a'.repeat(40),database:{databaseBytes:100,databaseSizeLimitBytes:500,deadlocks:0,statsResetAt:null},warnings:[]}}):new Response('<html></html>',{headers:{'content-type':'text/html'}});};
    const first=await collect(env,null,fetcher);
    expect(calls).toBe(3);expect(first.website.ok).toBe(true);expect(first.system.ok).toBe(true);
    expect(first.alerts).toEqual(['MONITOR_BASELINE_UNAVAILABLE']);
    const previous={...safeMonitorState(first),metrics:{cpuTotal:100,cpuIdle:90},resources:{cpuUtilization:.1,memoryUtilization:.1},alerts:[]};
    const second=await collect(env,previous,fetcher);expect(second.alerts).toEqual([]);
    const failed=await collect({...env,MONITOR_CACHE_RESTORE_FAILED:'true'},previous,fetcher);
    expect(failed.alerts).toContain('MONITOR_CACHE_RESTORE_FAILED');
    expect(JSON.stringify(safeMonitorState(failed))).not.toContain('synthetic-private');
    const reset=await collect(env,{...previous,metrics:{cpuTotal:300,cpuIdle:270}},fetcher);
    expect(reset.resources.cpuUtilization).toBeNull();expect(reset.alerts).toContain('MONITOR_BASELINE_UNAVAILABLE');
    const corrupted=await collect(env,{...previous,metrics:{cpuTotal:null,cpuIdle:null}},fetcher);
    expect(corrupted.resources.cpuUtilization).toBeNull();expect(corrupted.alerts).toContain('MONITOR_BASELINE_UNAVAILABLE');
    const missingCounters=await collect(env,{...previous,metrics:{cpuTotal:0,cpuIdle:0}},fetcher);
    expect(missingCounters.resources.cpuUtilization).toBeNull();expect(missingCounters.alerts).toContain('MONITOR_BASELINE_UNAVAILABLE');
  });
});
