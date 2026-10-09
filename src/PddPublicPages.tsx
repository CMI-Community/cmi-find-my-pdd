import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Copy, Download, Menu, RefreshCw, X, ZoomIn } from 'lucide-react';
import type { PddHomeStats } from '../shared/waybill';
import { bangkokDay, offsetDay } from '../shared/insight-history';
import { publicContentDate, type OutreachItem, type PddOutreach } from '../shared/public-content';
import type { HourlyDashboard, PublicObservation } from '../shared/hourly-content';
import { appendObservationPage, changeRows, emptyObservationPagination, mergeObservations, nextObservationRequest, observationGroups, rangeHours, updateObservationHead, type DataGranularity, type DataRange, type HourRow } from './hourly-insight-view';
import { publicContentApi } from './public-content-api';
import { trackPddEvent } from './pdd-analytics';
import './pdd-public.css';

export const DEVELOPER_INVITATION = '一起改进 PDD404 的功能与设计，连接更多找件线索，也讨论大家可以共同参与的传播和互助行动。';
const statsGroups = [
  { title: '快递单号', fields: [['lostRegistered', '找包裹的单号', '条'], ['receivedRegistered', '找失主的单号', '条'], ['matchedParcels', '已匹配包裹', '件']] },
  { title: '收件人名', fields: [['lostRecipientRegistered', '找包裹的姓名线索', '条'], ['receivedRecipientRegistered', '找失主的姓名线索', '条'], ['matchedRecipientLeads', '已匹配姓名线索', '条']] },
] as const;
function dateTime(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function dayLabel(value: string) { return value.slice(5).replace('-', '/'); }
function hourLabel(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }); }
function validDate(value: string) { try { return publicContentDate(value); } catch { return ''; } }

export function PublicNavigation() {
  const [open, setOpen] = useState(false), location = useLocation();
  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    const title = location.pathname === '/insights' ? '数据与洞察' : location.pathname === '/share' ? '传播工具' : location.pathname === '/help' ? '使用帮助' : '包裹寻回计划';
    document.title = title + ' · PDD404';
    if (location.hash) {
      let id: string; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
    } else if (['/insights', '/share', '/help'].includes(location.pathname)) window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);
  const links = [['/', '查件首页'], ['/insights', '数据与洞察'], ['/share', '传播工具']] as const;
  return <div className="pdd-public-navigation" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <nav className="pdd-desktop-navigation" aria-label="官网导航">{links.map(([to, title]) => <NavLink key={to} end to={to}>{title}</NavLink>)}</nav>
    <Link to="/help" className="pdd-direct-help" aria-label="帮助 Help" onClick={() => trackPddEvent('help_open')}>使用帮助<ArrowRight size={16} aria-hidden="true" /></Link>
    <button className="pdd-mobile-navigation-button" type="button" aria-expanded={open} aria-controls="pdd-mobile-navigation" aria-label={open ? '收起网站导航' : '展开网站导航'} onClick={() => setOpen(!open)}>{open ? <X size={23} /> : <Menu size={23} />}</button>
    {open && <nav id="pdd-mobile-navigation" className="pdd-mobile-navigation" aria-label="手机官网导航">{links.map(([to, title]) => <NavLink key={to} end to={to} onClick={() => setOpen(false)}>{title}<ArrowRight size={17} aria-hidden="true" /></NavLink>)}</nav>}
  </div>;
}
type Resource<T> = { value: T | null; loading: boolean; error: boolean; refresh: () => void };
function usePublicResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ key: string; value: T | null; loading: boolean; error: boolean }>({ key, value: null, loading: true, error: false });
  const [refreshId, setRefreshId] = useState(0), loader = useRef(load);
  loader.current = load;
  const refresh = useCallback(() => setRefreshId(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ key, value: previous.key === key ? previous.value : null, loading: true, error: false }));
    void loader.current(controller.signal).then(value => {
      if (!controller.signal.aborted) setState({ key, value, loading: false, error: false });
    }).catch(() => { if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: true })); });
    return () => controller.abort();
  }, [key, refreshId]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);
  return { value: state.key === key ? state.value : null, loading: state.key !== key || state.loading, error: state.key === key && state.error, refresh };
}
function ReadingState({ resource, name }: { resource: Pick<Resource<unknown>, 'loading' | 'error' | 'refresh' | 'value'>; name: string }) {
  return <>{resource.loading && <p className="pub-state" role="status">正在读取{name}…</p>}{resource.error && <p className="pub-state pub-state-error" role="status">{name}暂时无法读取。{!!resource.value && '下方保留最近一次读取的内容。'}<button type="button" onClick={resource.refresh} disabled={resource.loading}>重试读取<RefreshCw size={15} aria-hidden="true" /></button></p>}</>;
}
function Section({ number, title, children, id }: { number: string; title: string; children: ReactNode; id: string }) {
  return <section id={id} className="pub-section" aria-labelledby={id + '-title'}><div className="pub-section-heading"><span aria-hidden="true">{number}</span><h2 id={id + '-title'}>{title}</h2></div>{children}</section>;
}
export function CurrentStatistics({ stats, loading, error, readAt, refresh }: { stats: PddHomeStats | null; loading: boolean; error: string; readAt: string | null; refresh: () => void }) {
  return <div aria-busy={loading}><div className="pub-reading-line"><p>{readAt ? '最近读取：' + dateTime(readAt) + '（曼谷）' : '累计统计 · 与查件首页使用相同口径'}</p><button type="button" className="pub-quiet-button" onClick={refresh} disabled={loading}><RefreshCw size={16} aria-hidden="true" />更新数据</button></div>
    {loading && !stats && <p className="pub-state" role="status">正在读取网站累计统计…</p>}{error && <p className="pub-state pub-state-error" role="status">累计统计暂时无法读取。{stats ? '下方为最近一次读取的数字。' : '无法读取不代表没有登记。'}</p>}
    {stats && <div className="pub-statistics">{statsGroups.map(group => <div className="pub-stat-group" key={group.title}><h3>{group.title}</h3><dl>{group.fields.map(([key, title, unit]) => <div key={key}><dt>{title}</dt><dd className={stats[key] >= 1_000_000 ? 'pub-count-long' : undefined}>{stats[key].toLocaleString('zh-CN')}<small>{unit}</small></dd></div>)}</dl></div>)}</div>}
  </div>;
}
type Series = { key: keyof PddHomeStats; label: string; color: string; dash?: string };
const chartGroups: Array<{ id: string; title: string; series: Series[] }> = [
  { id: 'waybill', title: '单号登记 · 条', series: [{ key: 'lostRegistered', label: '找包裹', color: '#674782' }, { key: 'receivedRegistered', label: '找失主', color: '#a36522', dash: '7 4' }] },
  { id: 'recipient', title: '姓名线索登记 · 条', series: [{ key: 'lostRecipientRegistered', label: '找包裹', color: '#674782' }, { key: 'receivedRecipientRegistered', label: '找失主', color: '#a36522', dash: '7 4' }] },
  { id: 'match', title: '新增匹配', series: [{ key: 'matchedParcels', label: '单号匹配 · 件', color: '#20756d' }, { key: 'matchedRecipientLeads', label: '姓名线索 · 条', color: '#aa5141', dash: '7 4' }] },
];
function useDashboard(date: string, range: DataRange): Resource<HourlyDashboard> {
  const key = date || range;
  const [state, setState] = useState<{ key: string; value: HourlyDashboard | null; loading: boolean; error: boolean }>({ key, value: null, loading: true, error: false });
  const action = useRef<() => void>(() => {}), refresh = useCallback(() => action.current(), []);
  useEffect(() => {
    let active = true, pending = false, lastStarted = -Infinity;
    let requestController: AbortController | null = null;
    setState(previous => ({ key, value: previous.key === key ? previous.value : null, loading: true, error: false }));
    async function load(force = false) {
      if (!active || pending || document.visibilityState !== 'visible' || (!force && Date.now() - lastStarted < 1000)) return;
      pending = true; lastStarted = Date.now();
      const controller = new AbortController(); requestController = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      setState(previous => ({ ...previous, loading: true, error: false }));
      try {
        const value = await publicContentApi.dashboard(date ? { date } : { hours: rangeHours(range) }, controller.signal);
        if (active) setState({ key, value, loading: false, error: false });
      } catch { if (active) setState(previous => ({ ...previous, loading: false, error: true })); }
      finally { window.clearTimeout(timeout); pending = false; }
    }
    action.current = () => { void load(true); };
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    void load(); const timer = window.setInterval(visible, 60_000);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { active = false; requestController?.abort(); window.clearInterval(timer); action.current = () => {}; window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [date, range, key]);
  return { value: state.key === key ? state.value : null, loading: state.key !== key || state.loading, error: state.key === key && state.error, refresh };
}
export function HourChart({ rows, group, recorded = false, granularity = 'hour' }: { rows: HourRow[]; group: typeof chartGroups[number]; recorded?: boolean; granularity?: DataGranularity }) {
  const values = rows.flatMap(row => group.series.map(series => row.counts[series.key])).filter((value): value is number => value !== null);
  const maximum = Math.max(1, ...values), step = Math.pow(10, Math.floor(Math.log10(maximum))), ceiling = Math.max(2, Math.ceil(maximum / step) * step);
  const x = (index: number) => 14 + index / Math.max(1, rows.length - 1) * 632, y = (value: number) => 190 - value / ceiling * 168;
  return <figure className="pub-chart pub-hour-chart"><figcaption><h3>{group.title}</h3><div className="pub-legend">{group.series.map(series => <span key={series.key}><svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" stroke={series.color} strokeWidth="3" strokeDasharray={series.dash} /></svg>{series.label}</span>)}</div></figcaption>
    <div className="pub-chart-body"><div className="pub-chart-axis"><span>{ceiling.toLocaleString('zh-CN')}</span><span>0</span></div><svg viewBox="0 0 660 212" role="img" aria-label={group.title + (granularity === 'day' ? '，按日变化，' : '，按小时变化，') + (recorded ? '按登记与匹配记入时间，' : '缺采断线，') + '进行中时段使用虚线。具体数字见下方表格。'}>
      {[22, 106, 190].map(value => <line key={value} x1="14" x2="646" y1={value} y2={value} className="pub-grid-line" />)}
      {rows.length > 0 && rows.at(-1)?.status === 'current' && <rect x={x(rows.length - 1) - 12} y="10" width="24" height="188" className="pub-current-hour-band" />}
      {group.series.map(series => <g key={series.key} stroke={series.color} fill={series.color}>{rows.map((row, index) => {
        const value = row.counts[series.key]; if (value === null) return null;
        const prior = rows[index - 1]?.counts[series.key];
        return <g key={row.start}>{prior !== undefined && prior !== null && <line x1={x(index - 1)} y1={y(prior)} x2={x(index)} y2={y(value)} strokeWidth="2.5" strokeDasharray={row.status === 'current' ? '3 4' : series.dash} />}
          <circle cx={x(index)} cy={y(value)} r="3.5" fill={row.status === 'current' ? 'white' : series.color}><title>{dateTime(row.start)} {series.label}：{value}{row.status === 'current' ? '（进行中）' : ''}{row.sampledFrom && row.sampledUntil ? (row.source === 'recorded' ? '；记入时段 ' : '；采样 ') + dateTime(row.sampledFrom) + ' 至 ' + dateTime(row.sampledUntil) : ''}{row.firstRecordedAt ? '；最早记录时间：' + dateTime(row.firstRecordedAt) : ''}</title></circle></g>;
      })}</g>)}
    </svg></div>{rows.length > 0 && <div className="pub-chart-dates">{[rows[0], rows[Math.floor(rows.length / 2)], rows.at(-1)!].map((row, index) => <span key={index}>{dayLabel(bangkokDay(Date.parse(row.start)))}{granularity === 'hour' ? ' ' + hourLabel(row.start) : ''}{row.status === 'current' ? granularity === 'day' && row.sampledUntil ? ' · 截至 ' + hourLabel(row.sampledUntil) : ' · 进行中' : ''}</span>)}</div>}
  </figure>;
}
export function HourTable({ rows, mode, recorded = false, granularity = 'hour' }: { rows: HourRow[]; mode: 'waybill' | 'recipient'; recorded?: boolean; granularity?: DataGranularity }) {
  return <div className={'pub-table-scroll pub-hour-table pub-table-' + mode} tabIndex={0} aria-label={'可横向滚动的' + (granularity === 'day' ? '每日数据变化' : '小时数据变化')}><table><caption>{recorded ? '按登记与匹配记入时间' + (granularity === 'day' ? ' · 按日汇总' : '') + ' · 曼谷时间' : '采样间新增 · 曼谷时间 · — 表示该段没有可用采样'}</caption><thead><tr><th scope="col">{granularity === 'day' ? '日期' : '小时'}</th>{statsGroups.flatMap((group, index) => group.fields.map(([key, label, unit]) => <th className={index === 0 ? 'pub-waybill-column' : 'pub-recipient-column'} key={key} scope="col">{label}<small>{unit}</small></th>))}</tr></thead><tbody>{[...rows].reverse().map(row => <tr key={row.start} className={row.status === 'current' ? 'pub-current-hour' : ''}><th scope="row" title={row.firstRecordedAt ? '最早记录时间：' + dateTime(row.firstRecordedAt) : undefined}><span>{granularity === 'day' ? bangkokDay(Date.parse(row.start)).replace(/-/g, '/') : dayLabel(bangkokDay(Date.parse(row.sampledFrom ?? row.start))) + ' ' + hourLabel(row.sampledFrom ?? row.start) + '—' + hourLabel(row.sampledUntil ?? row.end)}</span>{row.status === 'current' && <small>{granularity === 'day' && row.sampledUntil ? '截至 ' + hourLabel(row.sampledUntil) : '进行中'}</small>}{granularity === 'day' && row.firstRecordedAt && <small>{hourLabel(row.firstRecordedAt)} 起</small>}</th>{statsGroups.flatMap((group, index) => group.fields.map(([key]) => <td className={index === 0 ? 'pub-waybill-column' : 'pub-recipient-column'} key={key} title={row.sampledFrom && row.sampledUntil ? (recorded ? '记入时段：' : '实际采样：') + dateTime(row.firstRecordedAt ?? row.sampledFrom) + ' 至 ' + dateTime(row.sampledUntil) : undefined}>{row.counts[key] === null ? <span aria-label="没有可用采样">—</span> : row.counts[key].toLocaleString('zh-CN')}</td>))}</tr>)}</tbody></table></div>;
}
function HourlyData({ dashboard, date, range, chooseDate, chooseRange }: { dashboard: HourlyDashboard | null; date: string; range: DataRange; chooseDate: (date: string) => void; chooseRange: (range: DataRange) => void }) {
  const [group, setGroup] = useState('waybill'), [mode, setMode] = useState<'waybill' | 'recipient'>('waybill'), [chosen, setChosen] = useState(date), [granularity, setGranularity] = useState<DataGranularity>('day');
  useEffect(() => { setChosen(date); }, [date]);
  const today = dashboard ? bangkokDay(Date.parse(dashboard.sampledAt)) : bangkokDay(), minimum = offsetDay(today, -29), cadence: DataGranularity = date || range === '24h' ? 'hour' : granularity, rows = dashboard ? changeRows(dashboard, date, range, cadence) : [];
  return <><div className="pub-hour-controls"><div className="pub-range pub-data-presets" role="group" aria-label="数据变化范围">{([['24h', '最近 24 小时'], ['3d', '最近 3 天'], ['7d', '最近 7 天']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={!date && range === value} onClick={() => chooseRange(value)}>{label}</button>)}{date && <span className="pub-selected-date">{date}</span>}</div>
    <form className="pub-date-form" onSubmit={event => { event.preventDefault(); const value = validDate(chosen); if (value && value >= minimum && value <= today) chooseDate(value); }}><label htmlFor="pub-hour-date">查看日期<input id="pub-hour-date" type="date" value={chosen} min={minimum} max={today} onChange={event => setChosen(event.target.value)} /></label><button className="pub-quiet-button" type="submit" disabled={!validDate(chosen) || chosen < minimum || chosen > today}>查看</button></form></div>
    {!date && range !== '24h' && <div className="pub-granularity-line"><p>曼谷日期 · 包含今天</p><div className="pub-range" role="group" aria-label="数据变化粒度"><button type="button" aria-pressed={cadence === 'day'} onClick={() => setGranularity('day')}>按日</button><button type="button" aria-pressed={cadence === 'hour'} onClick={() => setGranularity('hour')}>按小时</button></div></div>}
    {dashboard && <><div className="pub-range pub-chart-tabs" role="group" aria-label="小时图表类型">{chartGroups.map(item => <button type="button" key={item.id} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>{item.id === 'waybill' ? '单号登记' : item.id === 'recipient' ? '姓名线索' : '匹配'}</button>)}</div><HourChart rows={rows} group={chartGroups.find(item => item.id === group)!} recorded={!!dashboard.records} granularity={cadence} />
      <div className="pub-mobile-table-tabs pub-range" role="group" aria-label="小时表格类型"><button type="button" aria-pressed={mode === 'waybill'} onClick={() => setMode('waybill')}>单号</button><button type="button" aria-pressed={mode === 'recipient'} onClick={() => setMode('recipient')}>姓名线索</button></div>
      <HourTable rows={rows} mode={mode} recorded={!!dashboard.records} granularity={cadence} />{!rows.some(row => Object.values(row.counts).some(value => value !== null)) && <p className="pub-state" role="status">{dashboard.records ? '暂无登记与匹配记录' : '这段时间尚无连续小时采样。'}</p>}</>}
  </>;
}
export function ObservationList({ items }: { items: PublicObservation[] }) {
  return <ol className="pub-observation-list">{items.map(item => <li key={item.id}><div className="pub-observation-meta"><span>{item.category}</span><time dateTime={item.publishedAt}>{dateTime(item.publishedAt)}</time></div><p>{item.text}</p><small>数据窗口：{dateTime(item.windowStart)}—{dateTime(item.windowEnd)}（曼谷）</small></li>)}</ol>;
}
function ObservationFeed({ dashboard }: { dashboard: HourlyDashboard | null }) {
  const [pagination, setPagination] = useState(emptyObservationPagination), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!dashboard) return;
    setPagination(previous => updateObservationHead(previous, dashboard));
  }, [dashboard]);
  const shown = mergeObservations(dashboard?.observations ?? [], pagination.items), groups = observationGroups(shown), next = nextObservationRequest(pagination);
  async function more() {
    if (!next || busy) return;
    setBusy(true); setError(false); const request = new AbortController(); controller.current = request;
    try { const page = await publicContentApi.feed(next.cursor, request.signal); if (!request.signal.aborted) setPagination(previous => appendObservationPage(previous, next, page)); }
    catch { if (!request.signal.aborted) setError(true); } finally { if (!request.signal.aborted) setBusy(false); }
  }
  return <>{groups.latest.length > 0 && <ObservationList items={groups.latest} />}{groups.older.map(group => <details className="pub-details pub-observation-day" key={group.date}><summary>{group.date}<span>{group.items.length} 条观察</span></summary><ObservationList items={group.items} /></details>)}
    {!shown.length && dashboard && <p className="pub-empty-observations">暂无已发布观察。</p>}{next && <button type="button" className="pub-quiet-button pub-feed-more" disabled={busy} onClick={() => void more()}>{busy ? '正在读取…' : '查看更早的观察'}<ArrowRight size={16} aria-hidden="true" /></button>}{error && <p className="pub-state-error" role="status">更早的观察暂时无法读取，请重试。</p>}
  </>;
}

function ExternalSource({ item }: { item: OutreachItem }) {
  return item.sourceUrl ? <a className="pub-inline-link" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{item.origin === 'third-party' ? '阅读或观看原文' : '查看内容'}<ArrowUpRight size={16} aria-hidden="true" /></a> : null;
}
function ItemMetadata({ item }: { item: OutreachItem }) {
  return <div className="pub-item-meta"><span>{item.origin === 'third-party' ? '第三方' : 'PDD404 自制'} · {item.source}</span><span>{item.publishedAt ? '制作 / 发布：' + dateTime(item.publishedAt) : '制作 / 发布日期待核实'}</span><span>最近核对：{dateTime(item.checkedAt)}</span><span>适用：{item.channels.join('、')}</span></div>;
}
function NewsCards({ items }: { items: OutreachItem[] }) {
  return <div className="pub-news-list">{items.map(item => <article className="pub-news-card" key={item.id}><div className="pub-news-heading"><span>{item.kind === 'video' ? '视频' : '报道'}</span><h3>{item.title}</h3></div><p>{item.summary}</p><ItemMetadata item={item} /><ExternalSource item={item} /></article>)}</div>;
}

async function downloadAsset(url: string, filename: string) {
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) throw new Error('DOWNLOAD_FAILED');
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > 20 * 1024 * 1024) throw new Error('DOWNLOAD_FAILED');
  const objectUrl = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = objectUrl; link.download = filename; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
export function AssetDownload({ url, title, label = '下载素材' }: { url: string; title: string; label?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [done, setDone] = useState(false);
  return <div><button type="button" className="pub-quiet-button" disabled={busy} onClick={() => { setBusy(true); setError(false); setDone(false); void downloadAsset(url, title.replace(/[\\/:*?"<>|]/g, '-') + '.' + url.split('.').at(-1)).then(() => setDone(true)).catch(() => setError(true)).finally(() => setBusy(false)); }}><Download size={17} aria-hidden="true" />{busy ? '正在准备…' : label}</button>{done && <p className="pub-note" role="status">已交给浏览器下载，请查看下载列表。</p>}{error && <p className="pub-state-error" role="status">下载暂时未完成。<a href={url} target="_blank" rel="noopener noreferrer">打开原文件后保存</a></p>}</div>;
}
function useExpired(expiresAt: string | null | undefined) {
  const [checkedAt, setCheckedAt] = useState(Date.now);
  useEffect(() => {
    let timer: number | undefined;
    const check = () => {
      window.clearTimeout(timer); const now = Date.now(); setCheckedAt(now);
      const remaining = expiresAt ? Date.parse(expiresAt) - now : 0;
      if (remaining > 0) timer = window.setTimeout(check, Math.min(remaining + 1, 60_000));
    };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    check(); document.addEventListener('visibilitychange', visible); window.addEventListener('focus', check);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', check); };
  }, [expiresAt]);
  return !!expiresAt && Date.parse(expiresAt) <= Math.max(checkedAt, Date.now());
}
function DeveloperDiscussion({ outreach }: { outreach: Resource<PddOutreach> }) {
  const group = outreach.value?.developerGroup, [failed, setFailed] = useState(false), [open, setOpen] = useState(false), dialog = useRef<HTMLDialogElement>(null);
  const expired = useExpired(group?.content.expiresAt);
  useEffect(() => { setFailed(false); setOpen(false); }, [group?.content.qrUrl]);
  useEffect(() => {
    if (expired || failed || !group) setOpen(false);
    if (open && !expired && !failed && group && !dialog.current?.open) dialog.current?.showModal();
    if ((!open || expired || failed || !group) && dialog.current?.open) dialog.current?.close();
  }, [open, expired, failed, group]);
  return <div className="pub-discussion"><div><h3>{group?.content.title || '参与 PDD404 项目讨论'}</h3><p className="pub-invitation">{group?.content.invitation || DEVELOPER_INVITATION}</p><Link className="pub-inline-link" to="/share">一起整理和传播线索<ArrowRight size={17} aria-hidden="true" /></Link></div><div className="pub-group-panel"><ReadingState resource={outreach} name="开发者群配置" />{group && !expired && !failed ? <><button className="pub-qr-button" type="button" onClick={() => setOpen(true)} aria-label="放大开发者微信群二维码"><img src={group.content.qrUrl} alt={group.content.title + '二维码'} onError={() => setFailed(true)} /><span><ZoomIn size={16} aria-hidden="true" />放大二维码</span></button><p className="pub-note">二维码更新：{dateTime(group.content.qrUpdatedAt)}（曼谷）{group.content.expiresAt && <><br />有效期至 {dateTime(group.content.expiresAt)}</>}</p><AssetDownload key={group.content.qrUrl} url={group.content.qrUrl} title="PDD404-开发者群二维码" label="保存二维码" /></> : !outreach.loading && <div className="pub-empty"><strong>{expired ? '群二维码已过期' : failed ? '群二维码暂时无法读取' : outreach.error ? '群配置暂时无法读取' : '开发者群二维码暂未配置'}</strong><p>邀请入口准备好后会更新在这里。查件和登记仍可正常使用。</p></div>}</div>
    <dialog className="pub-qr-dialog" ref={dialog} aria-label="开发者微信群二维码" onClose={() => setOpen(false)} onCancel={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}><button className="pub-dialog-close" onClick={() => setOpen(false)} aria-label="关闭二维码"><X /></button>{group && !expired && !failed && <><h3>{group.content.title}</h3><img src={group.content.qrUrl} alt={group.content.title + '放大二维码'} onError={() => { setFailed(true); setOpen(false); }} /><AssetDownload key={group.content.qrUrl} url={group.content.qrUrl} title="PDD404-开发者群二维码" label="保存二维码" /></>}</dialog>
  </div>;
}
export function InsightsPage() {
  const [params, setParams] = useSearchParams(), requested = validDate(params.get('date') ?? ''), today = bangkokDay();
  const date = requested && requested >= offsetDay(today, -29) && requested <= today ? requested : '';
  const range: DataRange = params.get('range') === '24h' ? '24h' : params.get('range') === '3d' ? '3d' : '7d';
  const dashboard = useDashboard(date, range), value = dashboard.value;
  const outreach = usePublicResource('outreach', signal => publicContentApi.outreach(signal));
  const news = (outreach.value?.catalog?.content.items ?? []).filter(item => item.origin === 'third-party' && ['news', 'video'].includes(item.kind)).sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt)).slice(0, 3);
  return <div className="pub-page pub-insights-page"><header className="pub-page-heading"><h1>数据与洞察</h1><nav aria-label="本页目录"><a href="#current-data">累计数据</a><a href="#data-history">数据变化</a><a href="#observations">数据观察</a></nav></header>
    <Section number="01" title="累计登记与匹配" id="current-data"><CurrentStatistics stats={value?.stats ?? null} loading={dashboard.loading} error={dashboard.error ? '读取失败' : ''} readAt={value?.sampledAt ?? null} refresh={dashboard.refresh} /></Section>
    <Section number="02" title="数据变化" id="data-history"><HourlyData dashboard={value} date={date} range={range} chooseDate={chosen => setParams(chosen ? { date: chosen } : { range })} chooseRange={chosen => setParams({ range: chosen })} /></Section>
    <Section number="03" title="数据观察" id="observations"><ObservationFeed dashboard={value} /></Section>
    {news.length > 0 && <section className="pub-compact-news" aria-label="相关新闻"><h2>相关新闻</h2><ul>{news.map(item => <li key={item.id}><a href={item.sourceUrl!} target="_blank" rel="noopener noreferrer">{item.title}<ArrowUpRight size={16} aria-hidden="true" /></a><small>{item.source}{item.publishedAt ? ' · ' + dateTime(item.publishedAt) : ''}</small></li>)}</ul></section>}
    <div className="pub-insight-help"><Link to="/help">使用帮助<ArrowRight size={16} aria-hidden="true" /></Link><Link to="/share">传播工具<ArrowRight size={16} aria-hidden="true" /></Link></div>
    <section className="pub-section pub-insight-discussion" id="project-discussion" aria-label="参与项目讨论"><DeveloperDiscussion outreach={outreach} /></section>
  </div>;
}
export function CopyMaterial({ item }: { item: OutreachItem }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle'), text = useRef<HTMLTextAreaElement>(null);
  async function copy() {
    try { if (!navigator.clipboard?.writeText) throw new Error('COPY_UNAVAILABLE'); await navigator.clipboard.writeText(item.copyText!); setState('copied'); }
    catch { setState('manual'); text.current?.focus(); text.current?.select(); }
  }
  return <article className="pub-material"><h3>{item.title}</h3><p>{item.summary}</p><ItemMetadata item={item} /><textarea ref={text} readOnly value={item.copyText!} aria-label={item.title + '文案'} rows={6} /><div className="pub-material-actions"><button type="button" className="pub-quiet-button" onClick={() => void copy()}><Copy size={17} aria-hidden="true" />复制文案</button><button className="pub-quiet-button" type="button" onClick={() => { text.current?.focus(); text.current?.select(); setState('manual'); }}>选中文案</button></div>{state !== 'idle' && <p className="pub-note" role="status">{state === 'copied' ? '文案已复制。' : '请长按选中文案，或按 ⌘C / Ctrl+C 手动复制。'}</p>}</article>;
}
function MaterialImage({ item }: { item: OutreachItem }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [item.thumbnailUrl]);
  return <article className="pub-material">{item.thumbnailUrl && !failed ? <a className="pub-material-preview" href={item.thumbnailUrl} target="_blank" rel="noopener noreferrer"><img src={item.thumbnailUrl} alt={item.title + '预览'} loading="lazy" onError={() => setFailed(true)} /></a> : failed && <p className="pub-state-error">图片预览暂时无法读取，可尝试下载原文件。</p>}<h3>{item.title}</h3><p>{item.summary}</p><ItemMetadata item={item} />{item.downloadUrl && <AssetDownload key={item.downloadUrl} url={item.downloadUrl} title={item.id} label={item.kind === 'pack' ? '下载素材包' : '下载图片'} />}</article>;
}
export function SharePage() {
  const outreach = usePublicResource('outreach', signal => publicContentApi.outreach(signal)), items = outreach.value?.catalog?.content.items ?? [];
  const thirdParty = items.filter(item => item.origin === 'third-party'), guides = items.filter(item => item.origin === 'pdd404' && ['guide','video','comic'].includes(item.kind));
  const materials = items.filter(item => item.origin === 'pdd404' && ['copy','image','pack'].includes(item.kind));
  return <div className="pub-page"><header className="pub-page-heading"><span className="pub-kicker">PDD404 / 共同传播</span><h1>传播工具</h1><p>找到一份准确的介绍，让更多找包裹、找失主的人看到彼此。</p><nav aria-label="本页目录"><a href="#event">了解事件</a><a href="#how-it-works">介绍网站</a><a href="#materials">文案与素材</a></nav></header><ReadingState resource={outreach} name="传播目录" />
    <Section number="01" title="了解这次事件" id="event">{thirdParty.length ? <NewsCards items={thirdParty} /> : outreach.value && <div className="pub-empty"><strong>暂未收录已审核的报道或视频</strong><p>核对来源后会补充标题、摘要与原文入口。</p></div>}</Section>
    <Section number="02" title="介绍 PDD404 怎么用" id="how-it-works"><article className="pub-guide"><div><span className="pub-kicker">网站使用指南</span><h3>从查询，到保存登记回执</h3><p>两种查询方式、扫码、待提交列表和同名线索的使用说明，以最新帮助文档为准。</p></div><Link className="pub-inline-link" to="/help">阅读使用帮助<ArrowRight size={17} aria-hidden="true" /></Link></article>{guides.length ? <div className="pub-news-list">{guides.map(item => item.kind === 'comic' ? <MaterialImage key={item.id} item={item} /> : <article className="pub-news-card" key={item.id}><h3>{item.title}</h3><p>{item.summary}</p><ItemMetadata item={item} /><ExternalSource item={item} /></article>)}</div> : outreach.value && <p className="pub-note">自制演示或推广视频尚未上架，真实成片或发布链接核对后再补充。</p>}</Section>
    <Section number="03" title="复制文案 · 下载素材" id="materials"><p className="pub-note">文案不附容易过时的实时数字。转发前请保留网站入口，具体操作继续链接使用帮助。</p><a className="pub-inline-link" href="#how-it-works">说明漫画的预览与单张下载<ArrowRight size={16} aria-hidden="true" /></a>{materials.length ? <div className="pub-material-grid">{materials.map(item => item.kind === 'copy' ? <CopyMaterial key={item.id + '/' + (outreach.value?.catalog?.revision ?? 0)} item={item} /> : <MaterialImage key={item.id} item={item} />)}</div> : outreach.value && <div className="pub-empty"><strong>首批文案与漫画正在整理</strong><p>审核发布后，这里会提供可复制文案、图片预览及下载。</p></div>}{outreach.value?.catalog && <p className="pub-note">目录最近更新：{dateTime(outreach.value.catalog.publishedAt)}（曼谷）</p>}</Section>
    <Section number="04" title="参与项目讨论" id="project-discussion"><DeveloperDiscussion outreach={outreach} /></Section>
  </div>;
}
