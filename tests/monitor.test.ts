import { describe, it, expect } from 'vitest';
// The monitor runs on Node, independently of the public application.
// @ts-expect-error operations module is intentionally plain JavaScript
import { parseMetrics, resources, evaluate } from '../scripts/monitor.mjs';
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
});
