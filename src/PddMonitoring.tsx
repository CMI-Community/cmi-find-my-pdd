import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api';
import { TELEMETRY_DWELL_BUCKETS, type TelemetryEvent } from '../shared/telemetry';
import './pdd-monitoring.css';

type Budget = { day: string; acceptedBatches: number; acceptedEvents: number; dailyLimit: number; limitedAt: string | null };
type System = { checkedAt: string; ok: boolean; ready: boolean; sha: string; durationMs: number; warnings: string[]; database: null | { databaseBytes: number; databaseSizeLimitBytes: number | null; connections: number; maxConnections: number; reservedConnections: number; connectionUtilization: number; activeConnections: number; waitingConnections: number; longestTransactionSeconds: number }; telemetry?: null | { acceptedBatches: number; acceptedEvents: number; dailyLimit: number; batchLimit: number; limitedAt: string | null } };
export type AnalyticsRow = { day: string; event: TelemetryEvent; page: string; metadata: Record<string, string>; count: number };
type Analytics = { enabled: boolean; days: number; rows: AnalyticsRow[]; budget: Budget[]; dailyLimit: number };
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const warnings: Record<string, string> = {
  DATABASE_UNAVAILABLE: '数据库探测失败', CONFIGURATION_UNAVAILABLE: '服务配置不可用', REGISTRATION_NOT_READY: '登记暂不可用',
  CONNECTIONS_CRITICAL: '数据库连接使用达到90%', CONNECTIONS_HIGH: '数据库连接使用达到80%',
  DATABASE_SIZE_HIGH: '数据库空间使用达到70%', DATABASE_SIZE_CRITICAL: '数据库空间使用达到85%',
  LONG_TRANSACTION: '存在持续30秒以上的事务', LOCK_WAIT: '数据库有锁等待', IDLE_TRANSACTION: '存在未结束的空闲事务',
  DATABASE_SLOW: '数据库响应变慢', DATABASE_QUOTA_UNCONFIGURED: '数据库容量上限尚未配置',
  TELEMETRY_MONITOR_UNAVAILABLE: '统计采集状态暂时无法读取', TELEMETRY_BUDGET_EXHAUSTED: '今日统计采集已达上限，查询和登记仍可使用',
  TELEMETRY_BUDGET_CRITICAL: '今日统计采集已使用85%以上配额', TELEMETRY_BUDGET_HIGH: '今日统计采集已使用70%以上配额',
};
const pages: Record<string, string> = { home: '首页', help: '帮助', privacy: '隐私说明', local: '本机记录' };
export const eventLabels: Record<TelemetryEvent, string> = {
  pdd_page_view: '页面浏览', pdd_visible_dwell: '可见停留', pdd_mode_selected: '切换查询类型',
  pdd_query_started: '开始查询', pdd_query_invalid: '单号格式待修改', pdd_query_domestic_blocked: '提醒改填国内单号',
  pdd_query_matched: '查询得到精确匹配', pdd_query_possible: '查询得到疑似线索', pdd_query_duplicate: '查询得到已有登记', pdd_query_not_found: '查询暂无线索', pdd_query_closed: '查询得到已交还记录', pdd_query_error: '查询流程未完成',
  pdd_queue_added: '加入待提交列表', pdd_queue_duplicate: '单号已在待提交列表', pdd_queue_removed: '移除待提交单号',
  pdd_registration_started: '开始提交登记', pdd_registration_registered: '批次包含新登记', pdd_registration_matched: '提交时发现精确匹配', pdd_registration_duplicate: '提交时发现已有登记', pdd_registration_closed: '提交时发现已交还记录', pdd_registration_error: '登记流程未完成',
  pdd_scanner_open: '打开扫码', pdd_scanner_close: '关闭扫码', pdd_scanner_mode: '切换识别方式', pdd_scanner_capture: '拍照识别', pdd_scanner_not_found: '照片未识别出条码', pdd_scanner_decoded: '条码识别成功',
  pdd_scanner_permission_error: '相机权限未开启', pdd_scanner_camera_error: '相机或拍照未完成', pdd_scanner_reader_error: '识别组件不可用', pdd_scanner_retried: '重试扫码', pdd_scanner_camera_changed: '重开或切换相机', pdd_scanner_mirror: '翻转预览画面', pdd_scanner_focus_requested: '请求调整对焦',
  pdd_contact_copy: '复制对方联系方式', pdd_contact_saved: '保存自己的联系方式', pdd_contact_error: '联系方式保存未完成',
  pdd_feedback_open: '打开建议与反馈', pdd_feedback_started: '开始提交反馈', pdd_feedback_submitted: '反馈提交成功', pdd_feedback_error: '反馈提交未完成',
  pdd_help_open: '打开帮助', pdd_local_open: '打开本机记录', pdd_privacy_open: '打开隐私说明', pdd_community_open: '访问CMI社区官网', pdd_code_open: '查看开源代码', pdd_helper_qr_open: '查看小助手二维码',
};
const dwellLabels: Record<typeof TELEMETRY_DWELL_BUCKETS[number], string> = { '0-9s': '不足10秒', '10-29s': '10–29秒', '30-59s': '30–59秒', '1-2m': '1–3分钟', '3-9m': '3–10分钟', '10-30m': '10–30分钟（封顶）' };
function metadataText(metadata: Record<string, string>) {
  const values: Record<string, Record<string, string>> = {
    mode: { lost: '丢件查询', received: '错收件查询' }, source: { manual: '手动输入', barcode: '本机条码识别' },
    scanMode: { photo: '拍照识别', realtime: '自动扫码' }, batch: { '1': '1条', '2-5': '2–5条', '6-20': '6–20条', '21+': '21条以上' }, bucket: dwellLabels,
  };
  return Object.entries(metadata).map(([key, value]) => values[key]?.[value]).filter(Boolean).join(' · ');
}
export function monitoringSeries(rows: AnalyticsRow[]) {
  const views = new Map<string, number>(), dwell = new Map<string, number>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) continue;
    if (row.event === 'pdd_page_view') views.set(row.day, (views.get(row.day) ?? 0) + row.count);
    if (row.event === 'pdd_visible_dwell' && (TELEMETRY_DWELL_BUCKETS as readonly string[]).includes(row.metadata?.bucket)) dwell.set(row.metadata.bucket, (dwell.get(row.metadata.bucket) ?? 0) + row.count);
  }
  return { views: [...views].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
    dwell: TELEMETRY_DWELL_BUCKETS.filter(bucket => (dwell.get(bucket) ?? 0) > 0).map(bucket => ({ bucket, count: dwell.get(bucket)! })) };
}

export default function PddMonitoring({ token }: { token: string }) {
  const [system, setSystem] = useState<System | null>(null), [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [days, setDays] = useState<7 | 30>(7);
  const generation = useRef(0);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    setLoading(true); setError('');
    const result = await Promise.allSettled([request<System>('/v1/admin/system', { token, signal }), request<Analytics>('/v1/admin/analytics?days=' + days, { token, signal })]);
    if (signal?.aborted || current !== generation.current) return;
    setSystem(result[0].status === 'fulfilled' ? result[0].value : null);
    setAnalytics(result[1].status === 'fulfilled' ? result[1].value : null);
    if (result.some(item => item.status === 'rejected')) setError('部分监控数据读取失败，请刷新重试。缺少数据不代表服务正常。');
    setLoading(false);
  }, [token, days]);
  useEffect(() => { const controller = new AbortController(); setSystem(null); setAnalytics(null); void reload(controller.signal); return () => { generation.current++; controller.abort(); }; }, [reload]);
  const db = system?.database, rows = Array.isArray(analytics?.rows) ? analytics.rows : [], series = monitoringSeries(rows);
  const views = series.views.reduce((sum, row) => sum + row.count, 0), queries = rows.filter(row => row.event === 'pdd_query_started').reduce((sum, row) => sum + row.count, 0);
  const dwellTotal = series.dwell.reduce((sum, row) => sum + row.count, 0), maxViews = Math.max(1, ...series.views.map(row => row.count));
  const today = (system?.checkedAt ?? new Date().toISOString()).slice(0, 10);
  const budget = Array.isArray(analytics?.budget) ? analytics.budget.find(row => row.day === today) : null;
  return <section className="pdd-monitor" aria-label="数据与监控">
    <div className="pdd-monitor-heading"><div><h2>数据与监控</h2><p>仅管理员可见。点击刷新读取当前状态。</p></div><button className="pdd-button pdd-secondary" disabled={loading} onClick={() => void reload()}>{loading ? '读取中…' : '刷新监控'}</button></div>
    {error && <p className="pdd-error" role="alert">{error}</p>}
    {system ? <><p className="pdd-monitor-state">{system.ok ? '服务探测正常' : '服务异常'} · {system.ready ? '可接收登记' : '登记未就绪'} · {new Date(system.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' })}（曼谷）</p>
      {!!system.warnings.length && <ul className="pdd-monitor-warnings" role="alert">{system.warnings.map(warning => <li key={warning}>{warnings[warning] ?? '发现其他监控异常，请查看平台记录。'}</li>)}</ul>}
      {db && <div className="pdd-monitor-cards"><article><span>数据库空间</span><strong>{(db.databaseBytes / 1e6).toFixed(1)} MB</strong><small>{db.databaseSizeLimitBytes ? `容量上限 ${(db.databaseSizeLimitBytes / 1e6).toFixed(0)} MB` : '容量上限未配置'}</small></article><article><span>数据库连接</span><strong>{db.connections} / {db.maxConnections - db.reservedConnections}</strong><small>上限已扣除预留 · 活跃 {db.activeConnections} · 等锁 {db.waitingConnections}</small></article><article><span>服务响应</span><strong>{number(system.durationMs)} ms</strong><small>最近一次探测，不是全站响应分布</small></article></div>}
    </> : !loading && <p>服务状态暂不可用。</p>}
    <div className="pdd-monitor-heading"><h3>最近 {analytics?.days ?? days} 天的站内统计</h3><label className="pdd-monitor-period">统计范围<select aria-label="统计范围" value={days} disabled={loading} onChange={event => setDays(event.target.value === '30' ? 30 : 7)}><option value="7">最近7天</option><option value="30">最近30天</option></select></label></div>
    <p>按UTC日期汇总页面浏览、操作次数及可见停留片段。隐藏标签页时间不计入停留；一次访问可产生多个片段。</p>
    {analytics?.enabled === false && <p className="pdd-notice" role="status">站内埋点尚未启用。</p>}
    {analytics && <>
      <div className="pdd-monitor-budget"><h4>今日统计采集配额（UTC）</h4>{budget ? <><p>已收到 <strong>{number(budget.acceptedEvents)} / {number(budget.dailyLimit)}</strong> 次统计事件 · {number(budget.acceptedBatches)} 个批次</p><progress aria-label="今日统计事件配额" value={budget.acceptedEvents} max={budget.dailyLimit} />{budget.limitedAt ? <p role="alert">今日采集已暂停，次日恢复。查询和登记仍可使用。</p> : <p>每日采集上限用于保护登记服务，达到上限后统计可能漏计。</p>}</> : <p>今日尚无采集配额记录。{analytics.dailyLimit > 0 && `每日事件上限 ${number(analytics.dailyLimit)} 次。`}</p>}</div>
      <div className="pdd-monitor-cards"><article><span>收到的页面浏览</span><strong>{number(views)}</strong><small>非独立访客人数</small></article><article><span>开始查询</span><strong>{number(queries)}</strong><small>客户端动作次数</small></article><article><span>可见停留片段</span><strong>{number(dwellTotal)}</strong><small>停留分布见下方</small></article></div>
      <div className="pdd-monitor-charts"><figure><figcaption>每日页面浏览</figcaption>{views > 0 ? <div className="pdd-monitor-bars">{series.views.map(row => <div className="pdd-monitor-bar-row" key={row.day}><span>{row.day.slice(5)}</span><div className="pdd-monitor-bar-track"><div style={{ width: `${row.count / maxViews * 100}%` }} /></div><strong>{number(row.count)}</strong></div>)}</div> : <p>该范围尚未收到页面浏览数据。</p>}</figure><figure><figcaption>可见停留分布</figcaption>{dwellTotal > 0 ? <div className="pdd-monitor-bars">{series.dwell.map(row => <div className="pdd-monitor-bar-row pdd-monitor-dwell-row" key={row.bucket}><span>{dwellLabels[row.bucket]}</span><div className="pdd-monitor-bar-track"><div style={{ width: `${row.count / dwellTotal * 100}%` }} /></div><strong>{number(row.count)} <small>（{Math.round(row.count / dwellTotal * 100)}%）</small></strong></div>)}</div> : <p>该范围尚未收到停留片段数据。</p>}</figure></div>
      <div className="pdd-monitor-table"><table><caption>操作明细（最多展示500行）</caption><thead><tr><th>日期（UTC）</th><th>页面</th><th>操作 / 停留区间</th><th>次数</th></tr></thead><tbody>{rows.slice(0, 500).map((row, index) => <tr key={index}><td>{row.day}</td><td>{pages[row.page] ?? '其他页面'}</td><td>{eventLabels[row.event] ?? '其他操作'}<small className="pdd-monitor-metadata">{metadataText(row.metadata ?? {})}</small></td><td>{number(row.count)}</td></tr>)}</tbody></table></div>{!rows.length && <p>尚未收到埋点数据。</p>}
    </>}
    <p className="pdd-monitor-note">浏览器拒绝跟踪、网络失败、拦截扩展或采集预算用尽时会漏计。操作统计不替代正式登记和实际交还事实，批次结果的次数也不等于包裹数量。CPU、内存和月用量需结合平台指标与定时告警查看。</p>
    <p><a href="https://vercel.com/guanchao71-gmailcoms-projects/pdd404/observability" target="_blank" rel="noreferrer">Vercel 流量与日志</a> · <a href="https://supabase.com/dashboard/project/fogncjjsnakbhfdbfvdi/reports" target="_blank" rel="noreferrer">Supabase 资源与性能</a></p>
  </section>;
}
