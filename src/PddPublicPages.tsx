import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Copy, Download, Menu, RefreshCw, X, ZoomIn } from 'lucide-react';
import type { PddHomeStats } from '../shared/waybill';
import { bangkokDay, dailyChange, historyWindow, type HistoryDay } from '../shared/insight-history';
import { publicContentDate, type OutreachItem, type PddInsightReports, type PddOutreach, type PublishedContent, type InsightReport } from '../shared/public-content';
import { publicContentApi } from './public-content-api';
import { trackPddEvent } from './pdd-analytics';
import './pdd-public.css';

export const DEVELOPER_INVITATION = '一起把 PDD404 做得更有用。\n欢迎开发者、设计者、传播志愿者，以及正在找包裹、帮忙找失主的朋友加入讨论：哪些功能还缺，现有设计哪里不顺；网站怎样连接更多人的线索；大家还能一起做哪些传播和互助行动，让更多人更快找回快递。欢迎带着真实问题来，也可以从一个具体的小改进开始。';
const statsGroups = [
  { title: '快递单号', fields: [['lostRegistered', '找包裹的单号', '条'], ['receivedRegistered', '找失主的单号', '条'], ['matchedParcels', '已匹配包裹', '件']] },
  { title: '收件人名', fields: [['lostRecipientRegistered', '找包裹的姓名线索', '条'], ['receivedRecipientRegistered', '找失主的姓名线索', '条'], ['matchedRecipientLeads', '已匹配姓名线索', '条']] },
] as const;
function dateTime(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function dayLabel(value: string) { return value.slice(5).replace('-', '/'); }
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
    {loading && <p className="pub-state" role="status">正在读取网站累计统计…</p>}{error && <p className="pub-state pub-state-error" role="status">累计统计暂时无法读取。{stats ? '下方为最近一次读取的数字。' : '无法读取不代表没有登记。'}</p>}
    {stats && <div className="pub-statistics">{statsGroups.map(group => <div className="pub-stat-group" key={group.title}><h3>{group.title}</h3><dl>{group.fields.map(([key, title, unit]) => <div key={key}><dt>{title}</dt><dd>{stats[key].toLocaleString('zh-CN')}<small>{unit}</small></dd></div>)}</dl></div>)}</div>}
    <p className="pub-note">这里是累计登记与匹配记录，不代表人数。单号匹配、同名线索和实际交还分别计算；查到线索后，仍需核实包裹归属。</p>
  </div>;
}
type Series = { key: keyof PddHomeStats; label: string; color: string };
export function HistoryChart({ title, rows, series }: { title: string; rows: HistoryDay[]; series: Series[] }) {
  const observed = rows.filter(row => row.snapshot), maximum = Math.max(1, ...observed.flatMap(row => series.map(item => row.snapshot!.stats[item.key])));
  const ceiling = maximum < 5 ? 5 : Math.ceil(maximum / Math.pow(10, Math.floor(Math.log10(maximum)))) * Math.pow(10, Math.floor(Math.log10(maximum)));
  const x = (index: number) => 10 + index / Math.max(1, rows.length - 1) * 640;
  const y = (value: number) => 194 - value / ceiling * 180;
  return <figure className="pub-chart"><figcaption><h3>{title}</h3><div className="pub-legend">{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}</div></figcaption>
    <div className="pub-chart-body"><div className="pub-chart-axis"><span>{ceiling.toLocaleString('zh-CN')}</span><span>0</span></div><svg viewBox="0 0 660 210" role="img" aria-label={title + '，未采样日期留空，具体数值可展开采样记录'}>
      {[14, 104, 194].map(value => <line key={value} x1="10" x2="650" y1={value} y2={value} className="pub-grid-line" />)}
      {series.map(item => <g key={item.key} stroke={item.color} fill={item.color}>{rows.map((row, index) => {
        if (!row.snapshot) return null;
        const previous = rows[index - 1]?.snapshot;
        return <g key={row.day}>{previous && <line x1={x(index - 1)} y1={y(previous.stats[item.key])} x2={x(index)} y2={y(row.snapshot.stats[item.key])} strokeWidth="2.5" />}
          <circle cx={x(index)} cy={y(row.snapshot.stats[item.key])} r="4"><title>{row.day} {item.label}：{row.snapshot.stats[item.key]}</title></circle></g>;
      })}</g>)}
    </svg></div><div className="pub-chart-dates"><span>{dayLabel(rows[0].day)}</span><span>{dayLabel(rows[Math.floor(rows.length / 2)].day)}</span><span>{dayLabel(rows.at(-1)!.day)}</span></div>
  </figure>;
}
function SnapshotHistory() {
  const [days, setDays] = useState<7 | 30>(7), history = usePublicResource('history-' + days, signal => publicContentApi.history(days, signal));
  const rows = historyWindow(history.value?.snapshots ?? [], days, bangkokDay()), count = rows.filter(row => row.snapshot).length;
  return <><div className="pub-reading-line"><p>每日 20:00 采样 · 曼谷时间 · 累计口径</p><div className="pub-range" role="group" aria-label="历史数据范围">{([7, 30] as const).map(value => <button type="button" key={value} aria-pressed={days === value} onClick={() => setDays(value)}>{value} 天</button>)}</div></div>
    <ReadingState resource={history} name="历史采样" />{history.value && <>
      {count < 2 ? <div className="pub-empty"><strong>{count ? '已留下第一份同口径采样' : '每日历史尚未开始积累'}</strong><p>{count ? '还需要更多日期，才能观察变化。' : '正式走势从第一次真实采样开始，过去没有采样的日期不补造数字。'}</p></div> : <div className="pub-chart-grid">
        <HistoryChart title="快递单号登记" rows={rows} series={[{ key: 'lostRegistered', label: '找包裹', color: '#674782' }, { key: 'receivedRegistered', label: '找失主', color: '#a36522' }]} />
        <HistoryChart title="收件人名登记" rows={rows} series={[{ key: 'lostRecipientRegistered', label: '找包裹', color: '#674782' }, { key: 'receivedRecipientRegistered', label: '找失主', color: '#a36522' }]} />
        <HistoryChart title="已匹配包裹" rows={rows} series={[{ key: 'matchedParcels', label: '单号匹配 · 件', color: '#674782' }]} />
        <HistoryChart title="已匹配姓名线索" rows={rows} series={[{ key: 'matchedRecipientLeads', label: '姓名线索 · 条', color: '#a36522' }]} />
      </div>}
      <p className="pub-note">所选 {days} 天有 {count} 份采样。空缺代表没有采样，不代表零；20 点采样也不是完整自然日。相邻采样间的增加量不等于当日用户人数。</p>
      <details className="pub-details"><summary>查看采样记录与变化</summary><div className="pub-table-scroll"><table><caption>网站累计快照；括号内为与前一日期采样相比的增加量。</caption><thead><tr><th scope="col">日期（曼谷）</th><th scope="col">真实采样时间</th>{statsGroups.flatMap(group => group.fields.map(([key, label, unit]) => <th key={key} scope="col">{label}（{unit}）</th>))}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.day}><th scope="row">{row.day}</th><td>{row.snapshot ? dateTime(row.snapshot.sampledAt) : '未采样'}</td>{statsGroups.flatMap(group => group.fields.map(([key]) => {
        const change = row.snapshot ? dailyChange(row.snapshot, rows[index - 1]?.snapshot ?? null, key) : null;
        return <td key={key}>{row.snapshot ? <>{row.snapshot.stats[key].toLocaleString('zh-CN')}{change !== null && <small>（+{change}）</small>}</> : '—'}</td>;
      }))}</tr>)}</tbody></table></div></details>
    </>}</>;
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
function DailyObservation({ outreach }: { outreach: Resource<PddOutreach> }) {
  const [params, setParams] = useSearchParams(), date = validDate(params.get('date') ?? ''), [chosen, setChosen] = useState(date);
  const reports = usePublicResource('reports-' + date, signal => publicContentApi.reports(date, 0, signal));
  const [archive, setArchive] = useState<PublishedContent<InsightReport>[]>([]), [next, setNext] = useState<number | null>(null), [archiveBusy, setArchiveBusy] = useState(false), [archiveError, setArchiveError] = useState(false);
  useEffect(() => { setChosen(date); }, [date]);
  useEffect(() => { if (!date && reports.value) { setArchive(reports.value.reports); setNext(reports.value.nextOffset); } }, [date, reports.value]);
  const report = reports.value?.reports[0], catalog = outreach.value?.catalog?.content.items ?? [];
  const news = report ? catalog.filter(item => report.content.newsIds.includes(item.id) && item.origin === 'third-party' && ['news','video'].includes(item.kind)) : [];
  async function more() {
    if (next === null) return;
    setArchiveBusy(true); setArchiveError(false);
    try { const value: PddInsightReports = await publicContentApi.reports('', next); setArchive(previous => [...previous, ...value.reports.filter(item => !previous.some(old => old.key === item.key))]); setNext(value.nextOffset); }
    catch { setArchiveError(true); } finally { setArchiveBusy(false); }
  }
  return <><Section number="03" title="每日观察" id="daily-observations"><div className="pub-reading-line"><p>只展示经过审核的洞察；数据与文章各自更新。</p><Link to="/insights">最新观察<ArrowRight size={16} aria-hidden="true" /></Link></div>
    <form className="pub-date-form" onSubmit={event => { event.preventDefault(); const value = validDate(chosen); if (value && value <= bangkokDay()) setParams({ date: value }); }}><label htmlFor="pub-observation-date">按日期查看<input id="pub-observation-date" type="date" value={chosen} max={bangkokDay()} onChange={event => setChosen(event.target.value)} /></label><button className="pub-quiet-button" type="submit" disabled={!validDate(chosen) || chosen > bangkokDay()}>查看</button></form>
    {archive.length > 0 && <details className="pub-details"><summary>已发布观察的日期</summary><div className="pub-date-index">{archive.map(item => <Link to={'/insights?date=' + item.key} key={item.key}>{item.key}</Link>)}{next !== null && <button type="button" className="pub-quiet-button" disabled={archiveBusy} onClick={() => void more()}>{archiveBusy ? '正在读取…' : '更早的日期'}</button>}</div>{archiveError && <p className="pub-state-error" role="status">更早的日期暂时无法读取，请重试。</p>}</details>}
    <ReadingState resource={reports} name="已审核观察" />{report ? <article className="pub-report"><div className="pub-report-date"><time dateTime={report.content.date}>{report.content.date}</time><span>采样截至 {dateTime(report.content.asOf)}（曼谷）</span></div><h3>{report.content.title}</h3><p className="pub-report-summary">{report.content.summary}</p><p className="pub-note">观察窗口：{report.content.window}<br />审核发布：{dateTime(report.publishedAt)}（曼谷）{!date && report.content.date !== bangkokDay() && '。当前保留这份已发布观察，等待新一期审核。'}</p>
      <div className="pub-findings">{report.content.findings.map((finding, index) => <section key={index}><div className="pub-finding-title"><span>{String(index + 1).padStart(2, '0')}</span><h4>{finding.title}</h4></div><dl><div><dt>数据事实</dt><dd>{finding.observed}</dd></div><div><dt>可能解释 · 推测</dt><dd>{finding.interpretation}</dd></div><div><dt>尚不能判断</dt><dd>{finding.unknown}</dd></div></dl>{finding.helpUrl && <Link className="pub-inline-link" to={finding.helpUrl}>相关使用帮助<ArrowRight size={16} aria-hidden="true" /></Link>}</section>)}</div>
      {report.content.limitations.length > 0 && <details className="pub-details"><summary>这些观察的限制</summary><ul>{report.content.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul></details>}
    </article> : reports.value && <div className="pub-empty"><strong>{date ? date + ' 暂无已发布观察' : '第一份每日观察还在准备中'}</strong><p>洞察经审核后显示在这里。上方累计数据仍会独立更新。</p></div>}</Section>
    <Section number="04" title="相关新闻" id="related-news"><ReadingState resource={outreach} name="新闻目录" />{news.length > 0 ? <NewsCards items={news} /> : outreach.value && <div className="pub-empty"><p>{report ? '这份观察暂未收录已审核的相关新闻。' : '每日观察尚未引用已审核的报道。'}没有收录不代表没有相关新闻。</p></div>}{report && news.length < report.content.newsIds.length && <p className="pub-note">部分引用资料暂未收录，或已从公开目录撤回，暂不展示。</p>}<Link className="pub-inline-link" to="/share#event">到传播工具查看全部资料<ArrowRight size={16} aria-hidden="true" /></Link></Section>
  </>;
}
const questions = [
  ['没查到，是否只是线索还没相遇？', '未命中能反映当前检索结果，无法证明包裹不存在。', '/help#not-found'],
  ['单号不对，是否找错了号码？', '国内运输单号、订单编号和集运单号需要区分。', '/help#waybill'],
  ['扫码没读出来，卡在哪一步？', '镜头、光线和条码清晰度都可能影响识别，不能仅凭一次失败判断服务故障。', '/help#scan'],
  ['查到同名，是否就是同一个人？', '同名只提供联系线索，还需要双方核实包裹信息。', '/help#recipient'],
  ['加进列表，是否已经登记成功？', '本机待提交和网站登记成功是两个状态。', '/help#registration'],
] as const;
function Questions() { return <Section number="05" title="值得继续关注的问题" id="questions"><p className="pub-note">以下是观察问题索引，不表示每种情况都已统计发生率。具体操作统一以使用帮助为准。</p><div className="pub-question-list">{questions.map(([title, text, url]) => <details key={url}><summary>{title}</summary><p>{text}</p><Link className="pub-inline-link" to={url}>查看对应帮助<ArrowRight size={16} aria-hidden="true" /></Link></details>)}</div></Section>; }

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
function DeveloperDiscussion({ outreach }: { outreach: Resource<PddOutreach> }) {
  const group = outreach.value?.developerGroup, [failed, setFailed] = useState(false), [open, setOpen] = useState(false), dialog = useRef<HTMLDialogElement>(null);
  const expired = !!group?.content.expiresAt && Date.parse(group.content.expiresAt) <= Date.now();
  useEffect(() => { setFailed(false); setOpen(false); }, [group?.content.qrUrl]);
  useEffect(() => { if (open && !dialog.current?.open) dialog.current?.showModal(); if (!open && dialog.current?.open) dialog.current?.close(); }, [open]);
  return <div className="pub-discussion"><div><h3>{group?.content.title || '参与 PDD404 项目讨论'}</h3><p className="pub-invitation">{group?.content.invitation || DEVELOPER_INVITATION}</p><Link className="pub-inline-link" to="/share">一起整理和传播线索<ArrowRight size={17} aria-hidden="true" /></Link></div><div className="pub-group-panel"><ReadingState resource={outreach} name="开发者群配置" />{group && !expired && !failed ? <><button className="pub-qr-button" type="button" onClick={() => setOpen(true)} aria-label="放大开发者微信群二维码"><img src={group.content.qrUrl} alt={group.content.title + '二维码'} onError={() => setFailed(true)} /><span><ZoomIn size={16} aria-hidden="true" />放大二维码</span></button><p className="pub-note">二维码更新：{dateTime(group.content.qrUpdatedAt)}（曼谷）{group.content.expiresAt && <><br />有效期至 {dateTime(group.content.expiresAt)}</>}</p><AssetDownload key={group.content.qrUrl} url={group.content.qrUrl} title="PDD404-开发者群二维码" label="保存二维码" /></> : !outreach.loading && <div className="pub-empty"><strong>{expired ? '群二维码已过期' : failed ? '群二维码暂时无法读取' : outreach.error ? '群配置暂时无法读取' : '开发者群二维码暂未配置'}</strong><p>邀请入口准备好后会更新在这里。查件和登记仍可正常使用。</p></div>}</div>
    <dialog className="pub-qr-dialog" ref={dialog} aria-label="开发者微信群二维码" onCancel={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}><button className="pub-dialog-close" onClick={() => setOpen(false)} aria-label="关闭二维码"><X /></button>{group && <><h3>{group.content.title}</h3><img src={group.content.qrUrl} alt={group.content.title + '放大二维码'} onError={() => { setFailed(true); setOpen(false); }} /><AssetDownload key={group.content.qrUrl} url={group.content.qrUrl} title="PDD404-开发者群二维码" label="保存二维码" /></>}</dialog>
  </div>;
}
export function InsightsPage({ stats, loading, error, readAt, refresh }: Parameters<typeof CurrentStatistics>[0]) {
  const outreach = usePublicResource('outreach', signal => publicContentApi.outreach(signal));
  useEffect(() => { refresh(); }, [refresh]);
  return <div className="pub-page"><header className="pub-page-heading"><span className="pub-kicker">PDD404 / 持续观察</span><h1>数据与洞察</h1><p>看看线索正在怎样积累，以及数据背后仍需要回答的问题。</p><nav aria-label="本页目录"><a href="#current-data">当前数据</a><a href="#data-history">每日变化</a><a href="#daily-observations">每日观察</a></nav></header>
    <Section number="01" title="当前网站数据" id="current-data"><CurrentStatistics stats={stats} loading={loading} error={error} readAt={readAt} refresh={refresh} /></Section>
    <Section number="02" title="数据如何变化" id="data-history"><SnapshotHistory /></Section>
    <DailyObservation outreach={outreach} /><Questions />
    <Section number="06" title="一起让线索连接更多人" id="project-discussion"><DeveloperDiscussion outreach={outreach} /></Section>
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
