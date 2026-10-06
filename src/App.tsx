import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Camera, Package, ArrowRight, ArrowLeft, Plus, Trash2, RotateCcw, Crop, Square, X, Check, LoaderCircle, AlertCircle, Copy, Share2, ShieldCheck, LogOut, RefreshCw, ImagePlus, ExternalLink } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { createClient, type Session } from '@supabase/supabase-js';
import type { Community, Stats, PublicRecord, ScanProgress, MatchResult, PrivateRecord, AdminTask, AdminRecord, Contact as ServerContact } from '../shared/contracts';
import { APP_VERSION } from '../shared/contracts';
import { api, API_BASE, ApiFailure, processDraft, uploadPhoto, retryDraft } from './api';
import { getDraft, listDrafts, newDraft, removeDraft, saveDraft, updateDraft, managementUrl, type Draft, type Contact } from './drafts';
import { encodePhoto, normalizedRect, type LocalPhoto, type PhotoRole, type Rect } from './photos';
type AppContextValue = {
    drafts: Draft[];
    refresh: () => Promise<void>;
    community: Community | null;
    communityError: string;
    reloadCommunity: () => void;
};
const AppContext = createContext<AppContextValue>(null!);
const statusText = { draft: '本机草稿', queued: '等待上传', uploading: '正在上传', recognizing: '正在识别', done: '处理完成', error: '需要处理' };
const stateText: Record<string, string> = { draft: '待提交', queued: '等待识别', running: '正在识别', succeeded: '识别完成', needs_photo: '需要补拍', deferred: '等待识别服务恢复', failed: '识别失败', cancelled: '已取消' };
const resolutionText: Record<string, string> = { open: '正在寻找', verifying: '正在核实', claimed: '已认领，待交还', resolved: '已交还' };
const typeText: Record<string, string> = { domestic_waybill: '国内快递单号', consolidation_waybill: '集运单号', last_mile_waybill: '本地配送单号', order_id: '订单编号', unknown_id: '待确认编号' };
const roleText: Record<PhotoRole, string> = { label: '快递面单', item: '物品照片', logistics: '物流详情截图', product: '商品截图' };
function message(error: unknown) { return error instanceof Error ? error.message : '操作没有完成，请重试。'; }
function formatDate(date: string) { return new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
function useObjectUrl(blob?: Blob) {
    const [url, setUrl] = useState('');
    useEffect(() => {
        if (!blob) {
            setUrl('');
            return;
        }
        const u = URL.createObjectURL(blob);
        setUrl(u);
        return () => URL.revokeObjectURL(u);
    }, [blob]);
    return url;
}
function ErrorNote({ text }: {
    text?: string;
}) { return text ? <div className="error-note" role="alert"><AlertCircle size={17}/><span>{text}</span></div> : null; }
function Spinner({ text = '正在处理，请耐心等待…' }: {
    text?: string;
}) { return <div className="loading" role="status"><LoaderCircle className="spin" size={20}/>{text}</div>; }
function Back({ to = '/' }: {
    to?: string;
}) { return <Link to={to} className="back-link"><ArrowLeft size={16}/>返回</Link>; }
function Empty({ children }: {
    children: ReactNode;
}) { return <div className="empty"><Package size={28}/><p>{children}</p></div>; }
function AppProvider({ children }: {
    children: ReactNode;
}) {
    const [drafts, setDrafts] = useState<Draft[]>([]), [community, setCommunity] = useState<Community | null>(null), [communityError, setCommunityError] = useState('');
    const running = useRef(new Set<string>());
    const refresh = useCallback(async () => {
        try {
            setDrafts(await listDrafts());
        }
        catch {
            setCommunityError('本机储存不可用，请允许浏览器存储后重试。');
        }
    }, []);
    const reloadCommunity = useCallback(() => { api.community().then(c => { setCommunity(c); setCommunityError(''); }).catch(e => setCommunityError(message(e))); }, []);
    useEffect(() => { void refresh(); reloadCommunity(); const onChange = () => void refresh(); window.addEventListener('drafts-changed', onChange); return () => window.removeEventListener('drafts-changed', onChange); }, [refresh, reloadCommunity]);
    useEffect(() => {
        for (const d of drafts) {
            if (!['queued', 'uploading', 'recognizing'].includes(d.status) || running.current.has(d.id))
                continue;
            running.current.add(d.id);
            void processDraft(d).catch(e => updateDraft(d.id, { status: 'error', error: message(e) })).finally(() => running.current.delete(d.id));
        }
    }, [drafts]);
    return <AppContext.Provider value={{ drafts, refresh, community, communityError, reloadCommunity }}>{children}</AppContext.Provider>;
}
function Footer() { return <footer><span>本应用由 CMI 社区进行开发</span><span>Connect, Make, Impact</span><Link to="/local">本机记录</Link><Link to="/community">入群</Link><Link to="/privacy">隐私说明</Link><a href="https://github.com/CMI-Community/cmi-find-my-pdd" target="_blank" rel="noreferrer">开源代码</a><small>v{APP_VERSION}</small></footer>; }
function Shell() { const location = useLocation(); const screenshot = (location.pathname.startsWith('/share/') || /^\/p\/[^/]+\/share$/.test(location.pathname)); return <><a className="skip-link" href="#main">跳到内容</a>{!screenshot && <header><Link className="brand" to="/"><span className="brand-mark">cmi</span><span>CMI-Find my pdd</span></Link><span className="header-note">清迈包裹互助</span></header>}<main id="main"><Routes><Route path="/" element={<Home />}/><Route path="/received" element={<CaptureRedirect target="/received/new"/>}/><Route path="/received/new" element={<Capture key="received" intent="received"/>}/><Route path="/received/batch" element={<Capture key="received" intent="received" batch/>}/><Route path="/search" element={<CaptureRedirect target="/search/new"/>}/><Route path="/search/new" element={<Capture key="search" intent="search"/>}/><Route path="/search/:scanId" element={<SearchResult />}/><Route path="/search/:scanId/track" element={<SearchResult trackingIntent/>}/><Route path="/queue" element={<QueuePage />}/><Route path="/success" element={<SuccessPage />}/><Route path="/local" element={<LocalPage />}/><Route path="/p/:code" element={<PublicPage />}/><Route path="/share/:code" element={<PublicShareRedirect />}/><Route path="/p/:code/share" element={<PublicPage share/>}/><Route path="/manage/:code" element={<ManagePage />}/><Route path="/m/:code" element={<ManagePage />}/><Route path="/admin" element={<AdminPage />}/><Route path="/admin/login" element={<AdminPage />}/><Route path="/community" element={<CommunityPage />}/><Route path="/privacy" element={<PrivacyPage />}/><Route path="*" element={<MissingPage />}/></Routes></main>{!screenshot && <Footer />}</>; }
export default function App() { return <AppProvider><Shell /></AppProvider>; }
function Home() { const [stats, setStats] = useState<Stats | null>(null), [error, setError] = useState(''); const { communityError } = useContext(AppContext); useEffect(() => { api.stats().then(setStats).catch(e => setError(message(e))); }, []); return <div className="home entrance"><div className="home-title"><span className="eyebrow">CMI 社区公益包裹互助项目</span><h1>CMI-Find my pdd</h1></div><div className="home-actions"><Link to="/search/new" className="scan-entry" aria-label="我丢件了，拍照或上传物流截图查询"><span>我丢件了</span><span className="camera-entry"><Camera size={24}/></span></Link><Link to="/received/new" className="button primary received-entry"><Package size={21}/>我误收了快递<ArrowRight size={18}/></Link></div>{stats ? <div className="stats"><div><strong>{stats.recordedPackageCount}</strong><span>已录入包裹</span></div><div><strong>{stats.activeSeekerCount}</strong><span>正在找包裹的人</span></div>{stats.successfulHandoverCount !== null && stats.successfulHandoverCount > 5 && <div><strong>{stats.successfulHandoverCount}</strong><span>已确认交还</span></div>}</div> : <p className="service-note">{error || '正在读取社区数据…'}</p>}{communityError && communityError !== error && <p className="service-note">{communityError}</p>}</div>; }
function CommunityBlock({ compact = false }: {
    compact?: boolean;
}) { const { community: c, communityError } = useContext(AppContext); return <div className={`community-block ${compact ? 'compact' : ''}`}><div className="community-heading"><span className="eyebrow">在群里接上线索</span><strong>拼多多找货群</strong></div><div className="community-codes"><div>{c?.groupQrUrl ? <img src={c.groupQrUrl} alt="拼多多找货群二维码"/> : <div className="qr-missing">群二维码<br />尚未配置</div>}<span>保存二维码，微信扫一扫</span></div><div className="helper"><strong>群满了？找小助手</strong>{c?.assistantQrUrl && <img src={c.assistantQrUrl} alt="微信小助手二维码"/>}<span>{c?.assistantWechat || '小助手微信尚未配置'}</span></div></div>{!compact && <p className="muted">在群里说明情况，并发送这条记录的截图。管理员核实后会提供联系人信息。</p>}{!c && <ErrorNote text={communityError}/>}</div>; }
function AccountBlock() { const { community: c } = useContext(AppContext); return <div className="account-block"><span>这是 CMI 社区的公益项目</span><strong>Connect, Make an Impact</strong><p>关注 {c?.officialAccountName || 'CMI 社区公众号'}</p>{c?.officialAccountQrUrl ? <img src={c.officialAccountQrUrl} alt="CMI 社区公众号二维码"/> : <small>公众号二维码尚未配置</small>}</div>; }
function ContactDrawer({ initial, onClose, onConfirm, busy = false, error = '', title = '留下私人联系方式' }: {
    initial?: Contact;
    onClose: () => void;
    onConfirm: (contact: Contact, group: boolean) => void;
    busy?: boolean;
    error?: string;
    title?: string;
}) {
    const { community } = useContext(AppContext);
    const [wechat, setWechat] = useState(initial?.wechat || ''), [other, setOther] = useState(initial?.other || ''), [declared, setDeclared] = useState(false), [localError, setLocalError] = useState('');
    return <div className="modal-backdrop" onClick={onClose}><section className="drawer" role="dialog" aria-modal="true" aria-labelledby="contact-title" onClick={e => e.stopPropagation()}><button className="icon-button close" onClick={onClose} aria-label="关闭"><X /></button><span className="eyebrow">只填一次，连续提交沿用</span><h2 id="contact-title">{title}</h2><form onSubmit={e => {
            e.preventDefault();
            if (!wechat.trim()) {
                setLocalError('请填写你本人的微信号。');
                return;
            }
            if (!declared) {
                setLocalError('请先入群，或添加小助手后确认。');
                return;
            }
            setLocalError('');
            onConfirm({ wechat: wechat.trim(), other: other.trim() || undefined }, declared);
        }}><label>你的微信号<span className="required">必填</span><input value={wechat} maxLength={64} onChange={e => setWechat(e.target.value)} autoComplete="off" placeholder="本人微信号" required/></label><label>其他联系方式<span className="muted">可选</span><input value={other} maxLength={200} onChange={e => setOther(e.target.value)} placeholder="电话或其他联系方法"/></label><p className="privacy-line"><ShieldCheck size={16}/>仅管理员可查看，页面与截图不公开。</p><CommunityBlock compact/><label className="checkbox"><input type="checkbox" checked={declared} onChange={e => setDeclared(e.target.checked)}/><span>我已入群，或已添加小助手请求协助入群。<small>这是本人声明，网页无法验证群成员身份。</small></span></label><ErrorNote text={localError || error}/><button className="button primary full" disabled={busy || !community?.submissionsEnabled}>{busy ? <LoaderCircle className="spin" size={18}/> : <Check size={18}/>}确认并继续</button>{!community?.submissionsEnabled && <p className="service-note">登记服务尚未开放，照片仍保存在本机。</p>}</form></section></div>;
}
function PhotoEditor({ photo, onSave, onClose }: {
    photo: LocalPhoto;
    onSave: (p: LocalPhoto) => Promise<void>;
    onClose: () => void;
}) {
    const url = useObjectUrl(photo.blob);
    const [mode, setMode] = useState<'crop' | 'mask'>('crop'), [crop, setCrop] = useState<Rect>(), [masks, setMasks] = useState<Rect[]>([]), [drag, setDrag] = useState<Rect>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const start = useRef<{
        x: number;
        y: number;
    } | undefined>(undefined);
    const point = (e: PointerEvent<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; };
    return <div className="modal-backdrop"><section className="photo-editor" role="dialog" aria-modal="true" aria-label="裁剪和遮挡照片"><div className="editor-heading"><h2>{roleText[photo.role]}</h2><button className="icon-button" aria-label="关闭照片编辑" onClick={onClose}><X /></button></div><div className="editor-toolbar"><button className={mode === 'crop' ? 'active' : ''} onClick={() => setMode('crop')}><Crop size={17}/>裁剪</button><button className={mode === 'mask' ? 'active' : ''} onClick={() => setMode('mask')}><Square size={17}/>遮挡</button><button onClick={() => { setCrop(undefined); setMasks([]); }}><RotateCcw size={17}/>重置</button>{masks.length > 0 && <button onClick={() => setMasks(masks.slice(0, -1))}>撤销遮挡</button>}</div><p className="muted">在照片上拖动框选。请保留完整快递单号；可遮挡电话、详细地址等内容。</p><div className="edit-surface" style={{ width: Math.min(500, window.innerHeight * .5 * photo.width / photo.height) }}><img src={url || undefined} alt="待编辑照片" draggable={false}/><svg viewBox="0 0 1000 1000" preserveAspectRatio="none" onPointerDown={e => { start.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => {
            if (start.current)
                setDrag(normalizedRect(start.current, point(e)));
        }} onPointerUp={e => {
            if (start.current) {
                const r = normalizedRect(start.current, point(e));
                if (r.w > .02 && r.h > .02) {
                    if (mode === 'crop')
                        setCrop(r);
                    else
                        setMasks([...masks, r]);
                }
                start.current = undefined;
                setDrag(undefined);
            }
        }}>{masks.map((r, i) => <rect key={i} x={r.x * 1000} y={r.y * 1000} width={r.w * 1000} height={r.h * 1000} fill="#202922"/>)}{crop && <rect x={crop.x * 1000} y={crop.y * 1000} width={crop.w * 1000} height={crop.h * 1000} fill="transparent" stroke="white" strokeWidth="5" strokeDasharray="12 6"/>}{drag && <rect x={drag.x * 1000} y={drag.y * 1000} width={drag.w * 1000} height={drag.h * 1000} fill={mode === 'mask' ? '#202922' : '#ffffff30'} stroke="white" strokeWidth="3"/>}</svg></div><ErrorNote text={error}/><div className="button-row"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
                const output = await encodePhoto(photo.blob, crop, masks);
                await onSave({ ...photo, ...output });
                onClose();
            }
            catch (e) {
                setError(message(e));
            }
            finally {
                setBusy(false);
            }
        }}>{busy ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>}保存处理后的照片</button></div><small className="muted">裁剪和遮挡会写入实际上传的图片，并移除图片元数据。</small></section></div>;
}
function PhotoTile({ photo, onEdit, onDelete }: {
    photo: LocalPhoto;
    onEdit: () => void;
    onDelete: () => void;
}) { const url = useObjectUrl(photo.blob); return <article className="photo-tile"><button className="photo-open" onClick={onEdit}><img src={url || undefined} alt={roleText[photo.role]}/><span>{roleText[photo.role]}</span></button><div><button onClick={onEdit}><Crop size={15}/>查看／编辑</button><button onClick={onDelete} aria-label={`删除${roleText[photo.role]}`}><Trash2 size={16}/></button></div></article>; }
function Capture({ intent, batch = false }: {
    intent: 'received' | 'search';
    batch?: boolean;
}) {
    const { drafts, community } = useContext(AppContext);
    const navigate = useNavigate();
    const location = useLocation();
    const [draft, setDraft] = useState<Draft>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [editor, setEditor] = useState<LocalPhoto>(), [contactOpen, setContactOpen] = useState(false);
    const [pendingAction, setPendingAction] = useState<'finish' | 'next'>('finish');
    const contactRef = useRef<{
        contact: Contact;
        group: boolean;
    } | undefined>(undefined);
    const initialRef = useRef(false);
    useEffect(() => {
        if (initialRef.current)
            return;
        initialRef.current = true;
        const resumeId = new URLSearchParams(location.search).get('draft');
        void (resumeId ? getDraft(resumeId).then(d => {
            if (!d || d.kind !== intent)
                throw new Error('草稿不存在或类型不一致，请重新拍图。');
            if (d.contact)
                contactRef.current = { contact: d.contact, group: !!d.groupDeclared };
            return d;
        }) : newDraft(intent)).then(d => {
            setDraft(d);
            if (!resumeId)
                navigate(`${location.pathname}?draft=${d.id}`, { replace: true });
        }).catch(e => setError(message(e)));
    }, [intent]);
    const primaryRole: PhotoRole = intent === 'received' ? 'label' : 'logistics', secondaryRole: PhotoRole = intent === 'received' ? 'item' : 'product';
    const put = async (patch: Partial<Draft>) => {
        if (!draft)
            return;
        const next = { ...draft, ...patch, ...(patch.photos && draft.scanId ? { needsRevision: true } : {}) };
        await saveDraft(next);
        setDraft(next);
    };
    const addPhoto = async (file: File | undefined, role: PhotoRole) => {
        if (!file || !draft)
            return;
        setBusy(true);
        setError('');
        try {
            const photo = { id: crypto.randomUUID(), role, ...await encodePhoto(file) };
            await put({ photos: [...draft.photos.filter(p => p.role !== role), photo] });
            setEditor(photo);
        }
        catch (e) {
            setError(message(e));
        }
        finally {
            setBusy(false);
        }
    };
    const submit = async (action: 'finish' | 'next', contact?: Contact, group?: boolean) => {
        if (!draft?.photos.some(p => p.role === primaryRole))
            return;
        setError('');
        if (!API_BASE) {
            setError('服务尚未配置，照片已保存在本机。');
            return;
        }
        if (intent === 'received' && !community?.submissionsEnabled) {
            setError('登记服务尚未开放，请稍后从本机记录继续。');
            return;
        }
        if (intent === 'received' && !contact && !contactRef.current) {
            setPendingAction(action);
            setContactOpen(true);
            return;
        }
        setBusy(true);
        try {
            const info = contact ? { contact, group: !!group } : contactRef.current;
            if (info)
                contactRef.current = info;
            await put({ status: 'queued', ...(info ? { contact: info.contact, groupDeclared: info.group } : {}) });
            setContactOpen(false);
            if (intent === 'search') {
                navigate(`/search/${draft.id}`);
                return;
            }
            if (action === 'next') {
                const next = await newDraft('received');
                if (info) {
                    next.contact = info.contact;
                    next.groupDeclared = info.group;
                    await saveDraft(next);
                }
                setDraft(next);
                navigate(`/received/batch?draft=${next.id}`);
            }
            else
                navigate('/success');
        }
        catch (e) {
            setError(message(e));
        }
        finally {
            setBusy(false);
        }
    };
    const submitted = drafts.filter(d => d.kind === intent && d.status !== 'draft' && (intent !== 'received' || !draft?.batchId || d.batchId === draft.batchId));
    return <div className="page capture-page entrance"><Back /><div className="page-heading"><span className="eyebrow">{intent === 'received' ? '把错收到的包裹交回去' : '先查询，再决定是否登记'}</span><h1>{intent === 'received' ? '我误收了快递' : '我丢件了'}</h1><p>{intent === 'received' ? '每包 1—2 张：面单必拍，拆开后可补拍物品。' : '上传物流详情截图，商品截图可补充。无需填写快递单号。'}</p></div><div className="capture-layout"><section className="panel"><div className="step-label"><span>01</span>拍照与检查</div><div className="photo-grid">{[primaryRole, secondaryRole].map((role, index) => { const photo = draft?.photos.find(p => p.role === role); return <div key={role}>{photo && <PhotoTile photo={photo} onEdit={() => setEditor(photo)} onDelete={() => void put({ photos: draft!.photos.filter(p => p.id !== photo.id) })}/>}<label className={`photo-input ${photo ? 'retake' : 'empty-photo'}`}>{photo ? <RotateCcw size={18}/> : index === 0 ? <Camera size={28}/> : <ImagePlus size={26}/>}<strong>{photo ? '重新拍摄／上传' : roleText[role]}</strong>{!photo && <small>{index === 0 ? '必需 · 信息清楚完整' : '可选 · 最多补充 1 张'}</small>}<input type="file" accept="image/*" {...(intent === 'received' ? { capture: 'environment' as const } : {})} disabled={busy} onChange={e => { void addPhoto(e.target.files?.[0], role); e.target.value = ''; }}/></label></div>; })}</div><p className="privacy-line"><ShieldCheck size={16}/>点击提交才上传；面单与联系方式不公开。</p>{busy && <Spinner text="正在处理照片，请稍候…"/>}<ErrorNote text={error}/><div className="button-row"><button className="button primary" disabled={busy || !draft?.photos.some(p => p.role === primaryRole)} onClick={() => void submit('finish')}>{intent === 'received' ? '提交这包' : '识别并查询'}<ArrowRight size={18}/></button>{intent === 'received' && <button className="button secondary" disabled={busy || !draft?.photos.some(p => p.role === primaryRole)} onClick={() => void submit('next')}><Plus size={18}/>提交并拍下一包</button>}</div></section>{intent === 'received' && <aside className={`queue-aside ${batch ? 'batch-queue' : ''}`}><div className="step-label"><span>02</span>本次提交进度</div>{submitted.length ? <>{(batch ? submitted : submitted.slice(0, 6)).map(d => <QueueItem key={d.id} draft={d} compact={!batch}/>)}<button className="text-button" onClick={() => {
                    if (draft?.batchId)
                        sessionStorage.setItem('cmi-pdd-completed-batch', draft.batchId);
                    sessionStorage.removeItem('cmi-pdd-active-batch');
                    navigate('/success');
                }}>完成本批，查看提交结果</button><Link to="/queue" className="text-button">查看完整队列<ArrowRight size={15}/></Link></> : <p className="muted">提交后自动上传、识别和匹配。你可以继续拍下一包。</p>}</aside>}</div>{editor && <PhotoEditor photo={editor} onClose={() => setEditor(undefined)} onSave={async (p) => { await put({ photos: draft!.photos.map(x => x.id === p.id ? p : x) }); }}/>}{contactOpen && <ContactDrawer initial={contactRef.current?.contact} busy={busy} error={error} onClose={() => setContactOpen(false)} onConfirm={(c, g) => void submit(pendingAction, c, g)}/>}</div>;
}
function QueueItem({ draft: d, compact = false }: {
    draft: Draft;
    compact?: boolean;
}) { const image = useObjectUrl(d.photos[0]?.blob); const [error, setError] = useState(''); return <article className={`queue-item ${compact ? 'compact' : ''}`}><img src={image || undefined} alt="本机包裹照片"/><div><strong>{d.response?.record?.title || d.response?.extraction?.itemNames?.join('、') || (d.kind === 'received' ? '误收包裹' : '物流查询')}</strong><span className={`status status-${d.status}`}>{['queued', 'uploading', 'recognizing'].includes(d.status) && <LoaderCircle className="spin" size={13}/>} {statusText[d.status]}</span>{d.response?.record && <Link to={`/p/${d.response.record.code}`}>记录 {d.response.record.code}</Link>}{d.response?.results.length ? <Link className="match-notice" to={d.kind === 'search' ? `/search/${d.id}` : '/success'}><Check size={14}/>发现 {d.response.results.length} 条对应登记，查看并入群核实</Link> : null}{!compact && <><small>{formatDate(d.createdAt)}</small><ErrorNote text={error || d.error}/>{d.status === 'error' && <button className="text-button" onClick={() => { setError(''); void retryDraft(d).catch(e => setError(message(e))); }}><RefreshCw size={14}/>重试／继续识别</button>}{d.response?.state === 'needs_photo' && <Link className="text-button" to={`/${d.kind === 'received' ? 'received' : 'search'}/new?draft=${d.id}`}>重新拍图</Link>}{d.response?.record && <Link className="text-button" to={`/m/${d.response.record.code}#key=${d.cap}`}>私密管理</Link>}{d.kind === 'search' && d.status === 'done' && <Link className="text-button" to={`/search/${d.id}`}>查看查询结果</Link>}</>}</div></article>; }
function QueuePage() { const { drafts } = useContext(AppContext); const records = drafts.filter(d => d.status !== 'draft'); return <div className="page"><Back /><div className="page-heading"><h1>提交队列</h1><p>离开拍照页不会停止当前页面内的上传。关闭浏览器可能中断，请从这里重试。</p></div><div className="queue-list">{records.length ? records.map(d => <QueueItem key={d.id} draft={d}/>) : <Empty>还没有提交记录。</Empty>}</div><Link className="button primary" to="/received/new"><Camera size={17}/>继续拍下一包</Link></div>; }
function SuccessPage() { const { drafts } = useContext(AppContext); const batchId = sessionStorage.getItem('cmi-pdd-completed-batch'); const received = drafts.filter(d => d.kind === 'received' && d.status !== 'draft' && (!batchId || d.batchId === batchId)); const completed = received.filter(d => !!d.response?.record); const matches = received.flatMap(d => d.response?.results || []); const [show, setShow] = useState(true); return <div className="page narrow success-page"><div className="success-stamp"><Check size={32}/></div><span className="eyebrow">{received.length ? '感谢你多走这一步' : '本次提交'}</span><h1>{received.length ? '让包裹回到主人手里。' : '还没有提交包裹'}</h1><p>CMI 代表 <strong>Connect, Make an Impact</strong>。</p><p>{received.length ? <>{completed.length ? `${completed.length} 个包裹信息已收录。` : '提交正在处理中。'}若后续有人寻找并匹配成功，管理员会通过微信联系你。</> : '请先拍摄快递面单，检查照片后提交。'}</p>{matches.length > 0 && <div className="match-banner"><strong>发现对应寻件登记</strong><p>请把本页截图发到群里，由管理员核实。</p><div>{received.filter(d => !!d.response?.results.length).map(d => <section key={d.id}><span className="record-code">{d.response?.record?.code || '本次包裹'}</span><CandidateMatches progress={d.response!} cap={d.cap} draftId={d.id}/></section>)}</div></div>}{received.slice(0, 4).map(d => <QueueItem key={d.id} draft={d}/>)}<CommunityBlock /><AccountBlock /><div className="button-row"><Link to="/received/new" className="button primary">继续提交<Plus size={16}/></Link><Link to="/queue" className="button secondary">查看完整队列</Link></div>{matches.length > 0 && show && <div className="modal-backdrop"><section className="dialog" role="dialog" aria-modal="true"><button aria-label="关闭匹配提示" className="icon-button close" onClick={() => setShow(false)}><X /></button><span className="eyebrow">有线索了</span><h2>找到对应的寻件登记</h2><p>这是号码对应的登记线索，还需要在群里核实归属。</p><button className="button primary full" onClick={() => setShow(false)}>查看结果并入群核实</button></section></div>}</div>; }
function LocalPage() {
    const { drafts } = useContext(AppContext);
    const [error, setError] = useState('');
    return <div className="page"><Back /><div className="page-heading"><h1>本机记录</h1><p>只保存在当前浏览器。请保存私密管理链接，换设备或清理浏览器后不会自动恢复。</p></div><ErrorNote text={error}/>{drafts.length ? drafts.map(d => <div key={d.id} className="local-record"><QueueItem draft={d}/>{d.status === 'draft' && <div className="button-row"><Link className="button secondary" to={`/${d.kind === 'received' ? 'received' : 'search'}/new?draft=${d.id}`}>继续编辑照片</Link><button className="text-button" onClick={async () => {
                    try {
                        if (!d.photos.length) {
                            setError('这份草稿没有照片，请重新拍摄。');
                            return;
                        }
                        if (d.kind === 'received' && !d.contact) {
                            setError('这份草稿尚未填写联系方式，请重新进入误收拍照流程。');
                            return;
                        }
                        await updateDraft(d.id, { status: 'queued' });
                    }
                    catch (e) {
                        setError(message(e));
                    }
                }}>继续提交</button><button className="text-button danger" onClick={() => void removeDraft(d.id).catch(e => setError(message(e)))}>删除本机草稿</button></div>}</div>) : <Empty>这里还没有草稿或提交记录。</Empty>}</div>;
}
function ReadFields({ progress: p, images = [] }: {
    progress: ScanProgress;
    images?: {
        id: string;
        role: PhotoRole;
    }[];
}) {
    const sourceRole = (id: string) => { const image = images.find(i => i.id === id); return image ? roleText[image.role] : `来源图片 ${id.slice(0, 8)}`; };
    const labels = { recipientName: '收件名', itemName: '物品名称', specification: '规格', tag: '标签' };
    return p.extraction ? <details className="recognized-fields"><summary>查看识别信息与来源</summary><p className="muted">快递字段来自照片；识别错误请补拍，不能手动输入。</p>
      {p.extraction.identifiers.map(i => <div className="evidence-row" key={i.id}><div className="field-row"><span>{typeText[i.type]}</span><code>{i.value}</code>{(!i.clear || !i.complete) && <small>待补拍</small>}</div><small>来源：{sourceRole(i.sourceImageId)} · 版本 {p.imageVersion} · {i.clear ? '清晰' : '不清晰'} · {i.complete ? '完整' : '部分号码'}{i.shared ? ' · 共享号码' : ''}</small></div>)}
      {p.extraction.fieldSources?.map((field, index) => <div className="evidence-row" key={`${field.sourceImageId}-${index}`}><strong>{labels[field.field]}</strong><p>原值：{field.value}</p>{field.normalizedValue && <p>规范值：{field.normalizedValue}</p>}<small>来源：{sourceRole(field.sourceImageId)} · 版本 {field.inputVersion || p.imageVersion} · {field.clear ? '清晰' : '不清晰'}</small></div>)}
      {p.extraction.itemNames.length > 0 && <p>物品：{p.extraction.itemNames.join('、')}</p>}{p.extraction.tags.length > 0 && <p className="tag-list">{p.extraction.tags.map(t => <span key={t}>{t}</span>)}</p>}
    </details> : null;
}
function MatchList({ results }: {
    results: MatchResult[];
}) { return <div className="match-list">{results.map((m, i) => <Link className="match-card" key={`${m.record.code}-${i}`} to={`/p/${m.record.code}`}><div><span className={`match-kind ${m.kind}`}>{m.kind === 'exact' ? '号码对应' : '可能相关，需核实'}</span><span className="record-code">{m.record.code}</span></div><h3>{m.record.title}</h3><p>{m.reasons.join(' · ')}</p><span>{resolutionText[m.record.resolution]}<ArrowRight size={15}/></span></Link>)}</div>; }
function CandidateMatches({ progress, cap, draftId }: {
    progress: ScanProgress;
    cap: string;
    draftId: string;
}) {
    const snapshotKey = JSON.stringify([progress.id, progress.imageVersion, progress.selectedIdentifierId, progress.results]);
    const initial = () => ({ key: snapshotKey, results: progress.results, nextOffset: progress.results.length >= 20 ? 20 as number | null : null, loading: false, error: '' });
    const [page, setPage] = useState(initial);
    const generation = useRef(0);
    const activeRequest = useRef<AbortController | null>(null);
    useEffect(() => {
        generation.current++;
        activeRequest.current?.abort();
        activeRequest.current = null;
        setPage(initial());
        return () => {
            generation.current++;
            activeRequest.current?.abort();
            activeRequest.current = null;
        };
    }, [snapshotKey]);
    // Rendering a new recognition/selection must not briefly display the previous page.
    const shown = page.key === snapshotKey ? page : initial();
    const loadMore = async () => {
        if (shown.nextOffset === null || activeRequest.current)
            return;
        const currentGeneration = generation.current;
        const controller = new AbortController();
        activeRequest.current = controller;
        setPage({ ...shown, loading: true, error: '' });
        try {
            const next = await api.candidates(progress.id, progress.imageVersion, progress.selectedIdentifierId, shown.nextOffset, cap, controller.signal);
            if (currentGeneration !== generation.current)
                return;
            if (next.imageVersion !== progress.imageVersion || next.selectedIdentifierId !== progress.selectedIdentifierId)
                throw new ApiFailure('识别信息已经更新，请重新查看候选。', 'VERSION_CONFLICT', undefined, false);
            setPage(current => {
                const unique = new Map(current.results.map(result => [result.record.code, result]));
                for (const result of next.results)
                    unique.set(result.record.code, result);
                return { ...current, results: [...unique.values()], nextOffset: next.nextOffset, loading: false, error: '' };
            });
        }
        catch (error) {
            if (controller.signal.aborted || currentGeneration !== generation.current)
                return;
            if (error instanceof ApiFailure && error.code === 'VERSION_CONFLICT') {
                setPage({ ...initial(), error: '包裹信息已经更新，正在刷新当前识别结果…' });
                try {
                    const latest = await api.progress(progress.id, cap);
                    if (currentGeneration === generation.current)
                        await updateDraft(draftId, { response: latest, inputVersion: latest.imageVersion });
                }
                catch (refreshError) {
                    if (currentGeneration === generation.current)
                        setPage({ ...initial(), error: message(refreshError) });
                }
            }
            else
                setPage(current => ({ ...current, loading: false, error: message(error) }));
        }
        finally {
            if (activeRequest.current === controller)
                activeRequest.current = null;
        }
    };
    return <div className="candidate-results"><MatchList results={shown.results}/><ErrorNote text={shown.error}/>{shown.nextOffset !== null && <button className="button secondary full" disabled={shown.loading} onClick={() => void loadMore()}>{shown.loading ? <LoaderCircle className="spin" size={18}/> : <Plus size={18}/>} {shown.loading ? '正在加载更多候选…' : '加载更多候选'}</button>}</div>;
}
function SearchResult({ trackingIntent = false }: {
    trackingIntent?: boolean;
}) {
    const params = useParams();
    const id = params.scanId || params.id;
    const navigate = useNavigate();
    const { drafts } = useContext(AppContext);
    const draft = drafts.find(d => d.id === id);
    const [contactOpen, setContactOpen] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [tracked, setTracked] = useState<PublicRecord>();
    const p = draft?.response;
    useEffect(() => {
        if (trackingIntent && draft?.status === 'done' && p && !p.requiresSelection && !p.results.length && !tracked)
            setContactOpen(true);
    }, [trackingIntent, draft?.status, p?.requiresSelection, p?.results.length, tracked]);
    useEffect(() => {
        if (draft?.recordId)
            void api.publicRecord(draft.recordId).then(record => {
                if (record.kind === 'tracking')
                    setTracked(record);
            }).catch(() => { });
    }, [draft?.recordId]);
    const select = async (identifierId: string) => {
        if (!draft || !p)
            return;
        setBusy(true);
        try {
            const result = await import('./api').then(({ request }) => request<ScanProgress>(`/v1/scans/${p.id}/select`, { method: 'POST', body: { imageVersion: p.imageVersion, selectedIdentifierId: identifierId }, cap: draft.cap }));
            await updateDraft(draft.id, { response: result });
        }
        catch (e) {
            setError(message(e));
        }
        finally {
            setBusy(false);
        }
    };
    if (!draft)
        return <div className="page narrow"><Back to="/search/new"/><h1>查询记录不在当前浏览器</h1><p>请使用原浏览器查看，或重新上传物流截图。</p><Link to="/search/new" className="button primary">重新查询</Link></div>;
    return <div className="page narrow"><Back to="/search/new"/><span className="eyebrow">我丢件了</span><h1>{tracked ? '追踪申请已收录' : p?.requiresSelection ? '请选择要核对的号码' : p?.results.length ? (p.results.some(r => r.kind === 'exact') ? '发现对应的登记' : '发现相关线索，需要核实') : p?.quality === 'partial' ? '已识别部分线索，暂时无法确认包裹' : draft.status === 'done' ? '暂时没有查到匹配' : draft.status === 'error' ? '查询需要处理' : '正在核对你的包裹'}</h1>{['queued', 'uploading', 'recognizing'].includes(draft.status) && <Spinner text={`${statusText[draft.status]}，请耐心等待…`}/>}<ErrorNote text={error || draft.error}/>{p?.requiresSelection && <section className="panel"><h2>截图里有多个号码</h2><p>选择要查询的快递单号，不需要手动输入。</p>{p.extraction?.identifiers.filter(i => ['domestic_waybill', 'consolidation_waybill', 'last_mile_waybill'].includes(i.type)).map(i => <button className="identifier-option" key={i.id} disabled={busy} onClick={() => void select(i.id)}><span>{typeText[i.type]}</span><code>{i.value}</code><ArrowRight size={17}/></button>)}</section>}{p && !p.requiresSelection && p.results.length > 0 && <><CandidateMatches progress={p} cap={draft.cap} draftId={draft.id}/><div className="panel"><h2>入群核实，联系对方</h2><p>为保护隐私，这里不展示对方微信。请把对应记录页面的截图发到拼多多找货群，管理员核实后提供联系人信息。</p></div><CommunityBlock /></>}{p && !p.requiresSelection && draft.status === 'done' && !p.results.length && !tracked && <section className="panel"><h2>{p.quality === 'partial' ? '要保留这些识别线索吗？' : '要留下这条寻件信息吗？'}</h2><p>之后有人提交对应包裹，提交页面会出现匹配提示。管理员也会通过微信联系你告知线索。</p><p>建议先加入拼多多找货群，方便后续核实和联系。</p><button className="button primary" onClick={() => navigate(`/search/${draft.id}/track`)}>申请追踪<ArrowRight size={17}/></button><Link to="/" className="text-button">暂不登记</Link></section>}{tracked && <><Link to={`/p/${tracked.code}`} className="button primary">查看寻件记录</Link><button className="text-button" onClick={() => void copyText(managementUrl(tracked.code, draft.cap)).then(() => setError('私密管理链接已复制，请妥善保存。'))}>保存私密管理链接</button><CommunityBlock /><AccountBlock /></>}{p && <ReadFields progress={p} images={draft.uploadSlots || []}/>}<Link className="button secondary" to="/search/new"><Camera size={17}/>重新拍图查询</Link>{contactOpen && <ContactDrawer title="提交寻件追踪申请" busy={busy} error={error} onClose={() => {
                setContactOpen(false);
                if (trackingIntent)
                    navigate(`/search/${draft.id}`);
            }} onConfirm={async (c, g) => {
                if (!p)
                    return;
                setBusy(true);
                setError('');
                try {
                    const result = await api.track({ scanId: p.id, imageVersion: p.imageVersion, selectedIdentifierId: p.selectedIdentifierId || undefined, contact: { ...c, groupDeclaration: g } }, draft.cap);
                    setTracked(result.record);
                    await updateDraft(draft.id, { recordId: result.record.code, contact: c, groupDeclared: g });
                    setContactOpen(false);
                }
                catch (e) {
                    setError(message(e));
                }
                finally {
                    setBusy(false);
                }
            }}/>}</div>;
}
async function copyText(text: string) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied)
        throw new Error('复制不可用，请手动保存链接。');
}
function RecordCard({ record: r }: {
    record: PublicRecord;
}) { const { community: c } = useContext(AppContext); const url = r.url || `${window.location.origin}/p/${r.code}`; return <article className="screenshot-card"><div className="share-brand"><span className="brand-mark">cmi</span><strong>CMI-Find my pdd</strong><span>{r.kind === 'received' ? '误收包裹' : '寻件追踪'}</span></div><div className="share-body">{r.imageUrl && <img className="public-photo" src={r.imageUrl} alt="已处理的物品照片"/>}<span className="record-code">{r.code}</span><h2>{r.title}</h2>{r.recipientHint && <p>收件线索：{r.recipientHint}</p>}<div className="share-identifiers">{r.identifiers.slice(0, 3).map((i, n) => <span key={n}>{typeText[i.type]} ···{i.tail}</span>)}</div><span className="resolution-badge">{r.visibility === 'withdrawn' ? '记录已撤回' : resolutionText[r.resolution]}</span><p className="share-instruction">截图发到「拼多多找货群」<br />由管理员核实并提供联系人信息</p></div><div className="share-qr-row"><div className="record-qr"><QRCodeSVG value={url} size={68} level="M" marginSize={2}/><span>打开本条记录</span></div><div className="group-qr">{c?.groupQrUrl ? <img src={c.groupQrUrl} alt="找货群二维码"/> : <div className="qr-missing small">群码待配置</div>}<span>微信扫码入群</span></div><div className="share-helper"><strong>群满请加小助手</strong><span>{c?.assistantWechat || '联系方式待配置'}</span></div></div><div className="share-url">{url}</div><div className="share-bottom"><span>更新 {formatDate(r.updatedAt)}</span><span>CMI · Connect, Make, Impact</span></div></article>; }
function PublicPage({ share = false }: {
    share?: boolean;
}) {
    const { code } = useParams();
    const [record, setRecord] = useState<PublicRecord>(), [error, setError] = useState(''), [notice, setNotice] = useState('');
    useEffect(() => {
        if (code)
            api.publicRecord(code).then(setRecord).catch(e => setError(message(e)));
    }, [code]);
    return <div className={`page public-page ${share ? 'share-page' : ''}`}>{!share && <Back />}{error ? <><ErrorNote text={error}/><Link to="/" className="button secondary">返回首页</Link></> : !record ? <Spinner text="正在读取最新记录…"/> : <><RecordCard record={record}/><div className="share-actions">{!share && <Link to={`/p/${record.code}/share`} className="button primary">打开一屏截图版</Link>}<button className="button secondary" onClick={() => void copyText(record.url).then(() => setNotice('公开链接已复制')).catch(e => setNotice(message(e)))}><Copy size={16}/>复制链接</button><button className="button secondary" onClick={async () => {
                try {
                    if (navigator.share)
                        await navigator.share({ title: record.title, url: record.url });
                    else {
                        await copyText(record.url);
                        setNotice('公开链接已复制');
                    }
                }
                catch (e) {
                    if (!(e instanceof DOMException && e.name === 'AbortError'))
                        setNotice(message(e));
                }
            }}><Share2 size={16}/>分享</button>{share && <Link to={`/p/${record.code}`} className="text-button">返回详情</Link>}</div>{notice && <p role="status" className="notice">{notice}</p>}{!share && <><p className="muted">这张卡片可一屏截图。请打开原链接查看最新进展，联系方式不会出现在截图中。</p><AccountBlock /></>}</>}</div>;
}
function ManagePage() {
    const { code } = useParams();
    const [cap, setCap] = useState(''), [record, setRecord] = useState<PrivateRecord>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [wechat, setWechat] = useState(''), [other, setOther] = useState(''), [notice, setNotice] = useState(''), [editor, setEditor] = useState<LocalPhoto>();
    const refresh = useCallback(async (token: string) => {
        if (!code)
            return;
        const result = await api.privateRecord(code, token);
        setRecord(result);
        setWechat(result.contact.wechat);
        setOther(result.contact.other || '');
    }, [code]);
    useEffect(() => {
        void (async () => {
            const hashCap = (new URLSearchParams(window.location.hash.slice(1)).get('key') || new URLSearchParams(window.location.hash.slice(1)).get('cap'));
            const local = (await listDrafts()).find(d => d.recordId === code);
            const token = hashCap || local?.cap;
            if (!token) {
                setError('此页面需要私密管理凭证。请使用原设备或保存的私密管理链接。');
                return;
            }
            setCap(token);
            try {
                await refresh(token);
            }
            catch (e) {
                setError(message(e));
            }
        })();
    }, [code, refresh]);
    const editImage = async (file: File | undefined, role: PhotoRole) => {
        if (!file)
            return;
        try {
            setEditor({ id: crypto.randomUUID(), role, ...await encodePhoto(file) });
        }
        catch (e) {
            setError(message(e));
        }
    };
    return <div className="page narrow"><Back to="/local"/><span className="eyebrow">PRIVATE · 仅本人可见</span><h1>管理这条记录</h1><ErrorNote text={error}/>{!record && !error && <Spinner />}{record && <><div className="panel"><span className="record-code">{record.record.code}</span><h2>{record.record.title}</h2><p>{stateText[record.state]} · {resolutionText[record.record.resolution]}</p><button className="text-button" onClick={() => void refresh(cap).catch(e => setError(message(e)))}><RefreshCw size={15}/>刷新状态</button><div className="private-images">{record.images.map(image => <figure key={image.id}><img src={image.url} alt={roleText[image.role]}/><figcaption>{roleText[image.role]}{record.canRevise && <label className="text-button">重新拍图<input hidden type="file" accept="image/*" onChange={e => { void editImage(e.target.files?.[0], image.role); e.target.value = ''; }}/></label>}</figcaption></figure>)}</div>{record.extraction && <ReadFields progress={{ id: record.scanId, intent: record.record.kind === 'received' ? 'received' : 'search', imageVersion: record.imageVersion, state: record.state, quality: record.record.quality, extraction: record.extraction, record: record.record, results: record.results, requiresSelection: false, selectedIdentifierId: null }} images={record.images}/>}</div><form className="panel" onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError('');
                try {
                    await api.contact(code!, record.revision, { wechat: wechat.trim(), other: other.trim() || undefined, groupDeclaration: record.contact.groupDeclaration }, cap);
                    await refresh(cap);
                    setNotice('私人联系方式已更新。');
                }
                catch (e) {
                    setError(message(e));
                }
                finally {
                    setBusy(false);
                }
            }}><h2>私人联系方式</h2><label>本人微信<input required maxLength={64} value={wechat} onChange={e => setWechat(e.target.value)}/></label><label>其他联系方式<input maxLength={200} value={other} onChange={e => setOther(e.target.value)}/></label><button className="button primary" disabled={busy}>保存联系方式</button></form><div className="button-row"><button className="button secondary" onClick={() => void copyText(managementUrl(code!, cap)).then(() => setNotice('私密管理链接已复制。请勿分享到群里。')).catch(e => setError(message(e)))}>保存私密管理链接</button><Link className="button secondary" to={`/p/${code}`}>打开公开分享页</Link>{record.record.visibility !== 'withdrawn' && <button className="button danger" disabled={busy} onClick={async () => {
                    if (!window.confirm('撤回后，这条记录不再参与查找。确定撤回吗？'))
                        return;
                    setBusy(true);
                    try {
                        await api.withdraw(code!, record.revision, cap);
                        await refresh(cap);
                        setNotice('记录已撤回。');
                    }
                    catch (e) {
                        setError(message(e));
                    }
                    finally {
                        setBusy(false);
                    }
                }}>撤回记录</button>}</div>{notice && <p className="notice" role="status">{notice}</p>}<CommunityBlock compact/></>}{editor && record && <PhotoEditor photo={editor} onClose={() => setEditor(undefined)} onSave={async (photo) => {
                setBusy(true);
                try {
                    let local = (await listDrafts()).find(d => d.recordId === code);
                    if (!local) {
                        const restored = await Promise.all(record.images.map(async (i) => {
                            const result = await fetch(i.url);
                            if (!result.ok)
                                throw new Error('原照片链接已过期，请刷新后重试。');
                            return { id: i.id, role: i.role, ...await encodePhoto(await result.blob()) };
                        }));
                        const now = new Date().toISOString();
                        local = { id: record.scanId, cap, kind: record.record.kind === 'received' ? 'received' : 'search', photos: restored, status: 'draft', createdAt: now, updatedAt: now, inputVersion: record.imageVersion, scanId: record.scanId, recordId: code, contact: { wechat: record.contact.wechat, other: record.contact.other }, groupDeclared: record.contact.groupDeclaration };
                        await saveDraft(local);
                    }
                    const allPhotos = [...local.photos.filter(p => p.role !== photo.role), photo];
                    const revision = await api.revise(record.scanId, record.imageVersion, allPhotos.map(p => p.role), cap);
                    for (const slot of revision.uploads) {
                        const p = allPhotos.find(x => x.role === slot.role)!;
                        await uploadPhoto(slot.uploadUrl, slot.token, p.blob);
                    }
                    await updateDraft(local.id, { photos: allPhotos, scanId: revision.id, imageIds: revision.uploads.map(u => u.id), inputVersion: revision.imageVersion, status: 'queued', error: undefined });
                    setNotice('新照片已上传，正在重新识别。');
                }
                finally {
                    setBusy(false);
                }
            }}/>}</div>;
}
const supabaseClient = (() => {
    const url = import.meta.env.VITE_SUPABASE_URL, key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key)
        return null;
    try {
        return createClient(url, key);
    }
    catch {
        return null;
    }
})();
const adminTabs = [['records', '包裹与寻件'], ['tasks', '联系工作队列'], ['recognition', '识别异常'], ['duplicates', '重复记录'], ['community', '群与公众号'], ['audit', '操作记录']] as const;
function listItems(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data))
        return data as Record<string, unknown>[];
    if (data && typeof data === 'object') {
        const d = data as Record<string, unknown>;
        for (const key of ['items', 'records', 'tasks', 'events', 'logs', 'entries'])
            if (Array.isArray(d[key]))
                return d[key] as Record<string, unknown>[];
    }
    return [];
}
function AdminPage() {
    const requestSeq = useRef(0);
    const [offset, setOffset] = useState(0), [scanDetailId, setScanDetailId] = useState(''), [taskNotes, setTaskNotes] = useState<Record<string, string>>({});
    const [session, setSession] = useState<Session | null>(null), [loading, setLoading] = useState(true), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [tab, setTab] = useState<typeof adminTabs[number][0]>('tasks'), [data, setData] = useState<unknown>([]), [detail, setDetail] = useState<AdminRecord>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
    useEffect(() => {
        if (!supabaseClient) {
            setLoading(false);
            return;
        }
        void supabaseClient.auth.getSession().then(r => { setSession(r.data.session); setLoading(false); });
        const { data: { subscription } } = supabaseClient.auth.onAuthStateChange((_event, s) => setSession(s));
        return () => subscription.unsubscribe();
    }, []);
    const reload = useCallback(async () => {
        if (!session)
            return;
        setBusy(true);
        setError('');
        const sequence = ++requestSeq.current;
        try {
            const result = await api.admin(`/${tab}?offset=${offset}`, session.access_token);
            if (sequence === requestSeq.current)
                setData(result);
        }
        catch (e) {
            if (sequence === requestSeq.current)
                setError(message(e));
        }
        finally {
            if (sequence === requestSeq.current)
                setBusy(false);
        }
    }, [session, tab, offset]);
    useEffect(() => { void reload(); }, [reload]);
    const taskAction = async (id: string, action: string, notes: string) => {
        if (!session)
            return;
        if (action === 'confirm_handover' && !window.confirm('仅在双方确认实际交还后才能计为成功。确定这件包裹已经交还吗？'))
            return;
        setBusy(true);
        setError('');
        try {
            await api.admin(`/tasks/${id}`, session.access_token, 'PATCH', { action, notes });
            setNotice('已保存管理员操作。');
            await reload();
        }
        catch (e) {
            setError(message(e));
        }
        finally {
            setBusy(false);
        }
    };
    if (loading)
        return <div className="page"><Spinner text="正在验证管理员会话…"/></div>;
    if (!session)
        return <div className="page narrow"><Back /><span className="eyebrow">CMI 管理员</span><h1>工作台登录</h1><p className="muted">公众无需注册。此入口仅供授权管理员使用。</p><form className="panel" onSubmit={async (e) => {
                e.preventDefault();
                if (!supabaseClient)
                    return;
                setBusy(true);
                setError('');
                try {
                    const r = await supabaseClient.auth.signInWithPassword({ email, password });
                    if (r.error)
                        throw r.error;
                    setPassword('');
                    setSession(r.data.session);
                }
                catch (e) {
                    setError(message(e));
                }
                finally {
                    setBusy(false);
                }
            }}><label>邮箱<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required/></label><label>密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required/></label><ErrorNote text={error || (!supabaseClient ? '管理员认证服务尚未配置。' : '')}/><button className="button primary full" disabled={busy || !supabaseClient}>{busy ? '正在登录…' : '登录工作台'}</button></form></div>;
    return <div className="page admin-page"><div className="admin-heading"><div><span className="eyebrow">CMI · OPERATIONS</span><h1>管理员工作台</h1></div><button className="button secondary" onClick={() => void supabaseClient?.auth.signOut().catch(e => setError(message(e)))}><LogOut size={16}/>退出</button></div><nav className="admin-tabs" aria-label="工作台模块">{adminTabs.map(([key, label]) => <button className={tab === key ? 'active' : ''} key={key} onClick={() => { setTab(key); setOffset(0); setDetail(undefined); setScanDetailId(''); setNotice(''); }}>{label}</button>)}</nav><div className="admin-toolbar"><span>{session.user.email}</span><button className="text-button" onClick={() => void reload()} disabled={busy}><RefreshCw size={16}/>刷新</button></div><ErrorNote text={error}/>{notice && <p className="notice" role="status">{notice}</p>}{busy && <Spinner text="正在读取或保存…"/>}{tab === 'community' ? <AdminCommunity data={data as Community} session={session} onSaved={reload}/> : <div className="admin-workspace"><div className="admin-list">{listItems(data).length ? listItems(data).map((item, index) => {
                if (tab === 'tasks') {
                    const task = item as unknown as AdminTask;
                    return <article className="admin-row" key={task.id}><div><strong>{task.receivedCode} ↔ {task.trackingCode || '待寻找'}</strong><span className="status">{({ needs_review: '待核实', ready_to_contact: '待联系', contacting: '联系中', awaiting_handover: '待交还', closed: '已关闭' } as Record<string, string>)[task.state] || task.state}</span></div><p>{task.reasons?.join(' · ')}</p><div className="task-actions">{(['verify', 'contact_received', 'contact_tracking', 'mark_claimed', 'confirm_handover', 'reject'] as const).map(action => <button disabled={busy || task.state === 'closed' || (action === 'contact_tracking' && !task.trackingCode)} key={action} onClick={() => void taskAction(task.id, action, taskNotes[task.id] ?? task.notes)}>{({ verify: '确认待联系', contact_received: '已联系持有人', contact_tracking: '已联系寻件人', mark_claimed: '确认认领', confirm_handover: '确认实际交还', reject: '排除匹配' } as Record<string, string>)[action]}</button>)}</div><label className="task-note">跟进备注<textarea maxLength={2000} value={taskNotes[task.id] ?? task.notes} onChange={e => setTaskNotes({ ...taskNotes, [task.id]: e.target.value })} placeholder="如实记录已联系哪一方、约定交还时间"/></label></article>;
                }
                const entry = item.record as PublicRecord | undefined;
                const code = entry?.code || String(item.code || item.recordCode || '');
                return <article className="admin-row" key={String(item.id || code || index)}><div><strong>{entry?.title || String(item.title || item.action || item.eventType || code || '记录')}</strong><span className="record-code">{code}</span></div><p>{String(item.state || item.message || item.createdAt || item.created_at || '')}</p>{tab === 'recognition' && <><code>{String(item.id || '')}</code><p>{item.contact && typeof item.contact === 'object' ? `本人微信：${String((item.contact as Record<string, unknown>).wechat || '')}` : '匿名查询，未留联系方式'}</p><button className="text-button" disabled={busy} onClick={() => { setDetail(undefined); setScanDetailId(String(item.id)); }}>查看异常详情<ArrowRight size={15}/></button></>}{code && <button className="text-button" disabled={busy} onClick={() => void api.admin<AdminRecord>(`/records/${encodeURIComponent(code)}`, session.access_token).then(r => { setScanDetailId(''); setDetail(r); }).catch(e => setError(message(e)))}>查看私人详情<ArrowRight size={15}/></button>}</article>;
            }) : !busy && !error && <Empty>目前没有待处理记录。</Empty>}<div className="pagination"><button className="button secondary" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><span>第 {Math.floor(offset / 50) + 1} 页</span><button className="button secondary" disabled={busy || listItems(data).length < 50} onClick={() => setOffset(offset + 50)}>下一页</button></div></div>{scanDetailId && <AdminScanPanel id={scanDetailId} session={session} onClose={() => setScanDetailId('')}/>} {detail && <section className="panel admin-detail"><button aria-label="关闭详情" className="icon-button close" onClick={() => setDetail(undefined)}><X /></button><span className="record-code">{detail.record.code}</span><h2>{detail.record.title}</h2><div className="private-contact"><strong>本人微信：{detail.contact.wechat}</strong><p>{detail.contact.other}</p><span>入群声明：{detail.contact.groupDeclaration ? '已声明' : '未声明'}（未验证）</span></div><div className="private-images">{detail.images.map(i => <a key={i.id} href={i.url} target="_blank" rel="noreferrer"><img src={i.url} alt={roleText[i.role]}/></a>)}</div>{detail.extraction?.identifiers.map(i => <div className="field-row" key={i.id}><span>{typeText[i.type]}</span><code>{i.value}</code></div>)}{detail.extraction && <ReadFields images={detail.images} progress={{ id: detail.scanId, intent: detail.record.kind === 'received' ? 'received' : 'search', imageVersion: detail.imageVersion, state: detail.state, quality: detail.record.quality, extraction: detail.extraction, record: detail.record, results: detail.results, requiresSelection: false, selectedIdentifierId: null }}/>}<div className="button-row">{['retry', 'rotate'].map(action => <button key={action} className="button secondary" disabled={busy} onClick={async () => {
                        setBusy(true);
                        try {
                            const result = await api.admin<{
                                privateLink?: string;
                            }>(`/records/${detail.record.code}/${action}`, session.access_token, 'POST', { revision: detail.revision });
                            if (result.privateLink)
                                await copyText(result.privateLink);
                            setNotice(action === 'retry' ? '识别重试已请求。' : '新管理凭证已生成，请私人交给本人。');
                            await reload();
                        }
                        catch (e) {
                            setError(message(e));
                        }
                        finally {
                            setBusy(false);
                        }
                    }}>{action === 'retry' ? '重试识别' : '重置私密管理凭证'}</button>)}</div><AdminRecordActions record={detail} session={session} onChanged={async () => { const next = await api.admin<AdminRecord>(`/records/${detail.record.code}`, session.access_token); setDetail(next); await reload(); }}/></section>}</div>}</div>;
}
function AdminCommunity({ data, session, onSaved }: {
    data: Community;
    session: Session;
    onSaved: () => Promise<void>;
}) {
    const [form, setForm] = useState<Community | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => {
        if (data && typeof data === 'object' && !Array.isArray(data) && 'projectUrl' in data)
            setForm(data);
    }, [data]);
    if (!form)
        return <Empty>社区设置尚未载入。请先配置服务。</Empty>;
    const labels: Record<string, string> = { groupQrUrl: '找货群二维码图片 URL', assistantWechat: '小助手微信号', assistantQrUrl: '小助手二维码图片 URL', officialAccountName: '公众号名称', officialAccountQrUrl: '公众号二维码图片 URL', projectUrl: '项目公开地址' };
    return <form className="panel admin-community" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
                await api.admin('/community', session.access_token, 'PATCH', { groupQrUrl: form.groupQrUrl, assistantWechat: form.assistantWechat, assistantQrUrl: form.assistantQrUrl, officialAccountName: form.officialAccountName, officialAccountQrUrl: form.officialAccountQrUrl, submissionsEnabled: form.submissionsEnabled });
                await onSaved();
            }
            catch (e) {
                setError(message(e));
            }
            finally {
                setBusy(false);
            }
        }}>{Object.entries(labels).map(([key, label]) => <label key={key}>{label}<input type={key.includes('Url') ? 'url' : 'text'} readOnly={key === 'projectUrl'} value={String(form[key as keyof Community] || '')} onChange={e => setForm({ ...form, [key]: e.target.value || null })} required={key === 'projectUrl'}/></label>)}<label className="checkbox"><input type="checkbox" checked={form.submissionsEnabled} onChange={e => setForm({ ...form, submissionsEnabled: e.target.checked })}/><span>开放正式登记</span></label><ErrorNote text={error}/><button className="button primary" disabled={busy}>保存社区设置</button></form>;
}
function MissingPage() { return <div className="page narrow"><h1>页面不存在</h1><p>请检查链接，或回到首页继续查找包裹。</p><Link className="button primary" to="/">返回首页</Link></div>; }
function CaptureRedirect({ target }: {
    target: string;
}) { const location = useLocation(); return <Navigate to={`${target}${location.search}`} replace/>; }
function PublicShareRedirect() { const { code } = useParams(); return <Navigate to={`/p/${encodeURIComponent(code || '')}/share`} replace/>; }
function CommunityPage() { return <div className="page narrow"><Back /><span className="eyebrow">连接，创造影响力</span><h1>一起找到包裹</h1><p className="muted">无论你是寻找自己的包裹，还是误收了别人的包裹，都请加入找货群，方便核实和交还。</p><CommunityBlock /><AccountBlock /></div>; }
function PrivacyPage() { return <div className="page narrow privacy-page"><Back /><span className="eyebrow">CMI-Find my pdd</span><h1>隐私与信息使用</h1><section className="panel"><h2>不用注册，也不公开微信</h2><p>公众不需要登录。你本人填写的微信和其他联系方式仅授权管理员可见，用于核实包裹、联系和交还。包裹面单上的收件人信息不会自动填成你的联系方式。</p><h2>照片用于扫描与核对</h2><p>点击提交前，照片只保存在当前浏览器。提交后，照片传至本项目服务器，并由识别服务（OpenAI）提取单号和物品线索，进行匹配。你可在提交前裁剪或遮挡电话、地址等信息，但请保留用于核对的完整单号。</p><p>原始面单和订单截图存放在私人图片库。公开页面只显示脱敏线索；物品照片必须由管理员明确检查没有私人信息后才公开。</p><h2>查询与正式登记分开</h2><p>只查询时不收联系方式，也不自动发布寻件信息。未转为正式登记的查询在 24 小时后过期，原照片由服务器清理任务处理。正式记录用于持续找货，直到交还或撤回；可通过私密管理链接撤回。</p><h2>保存好私密管理链接</h2><p>本机草稿和管理凭证保存在当前浏览器。清理浏览器或换设备不会自动恢复。私密链接不要发到群里，公开页面的分享按钮不会携带管理凭证。找不到管理链接时，请联系小助手协助。</p><h2>加群与后续联系</h2><p>入群确认是用户本人的声明，网页无法验证是否实际入群。页面内会提示匹配线索，管理员会通过微信手动联系；本项目不承诺自动发送微信消息。</p><Link className="text-button" to="/community">联系 CMI 小助手<ArrowRight size={15}/></Link></section></div>; }
function AdminRecordActions({ record: r, session, onChanged }: {
    record: AdminRecord;
    session: Session;
    onChanged: () => Promise<void>;
}) {
    const [safe, setSafe] = useState(false), [imageId, setImageId] = useState(''), [duplicateId, setDuplicateId] = useState(''), [records, setRecords] = useState<AdminRecord[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    useEffect(() => { setSafe(false); setImageId(''); setDuplicateId(''); setNotice(''); void api.admin<AdminRecord[]>('/records', session.access_token).then(setRecords).catch(() => { }); }, [r.id, session.access_token]);
    const mutate = async (action: string, body: unknown) => {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await api.admin(action, session.access_token, 'POST', body);
            await onChanged();
            setNotice('操作已保存。');
        }
        catch (e) {
            setError(message(e));
        }
        finally {
            setBusy(false);
        }
    };
    return <div className="admin-extra-actions">
    {r.record.kind === 'received' && r.record.visibility === 'active' && <div><h3>群内核实跟进</h3><p className="muted">有人直接在群里寻找本包裹时，可建立人工核实任务。</p><button className="button secondary full" disabled={busy} onClick={() => void mutate('/tasks', { receivedCode: r.record.code, trackingCode: null })}>建立群内核实跟进</button></div>}
    <div><h3>标记重复登记</h3><select aria-label="选择重复记录" value={duplicateId} onChange={e => setDuplicateId(e.target.value)}><option value="">选择对应的原始登记</option>{records.filter(other => other.id !== r.id && other.record.kind === r.record.kind).map(other => <option value={other.id} key={other.id}>{other.record.code} · {other.record.title}</option>)}</select><button className="text-button" disabled={busy || !duplicateId} onClick={() => void mutate(`/records/${r.record.code}/duplicate`, { revision: r.revision, duplicateOf: duplicateId })}>确认此条为重复登记</button></div>
    {r.images.some(image => ['item', 'product'].includes(image.role)) && <div><h3>审核公开物品照片</h3><select aria-label="选择可公开的物品照片" value={imageId} onChange={e => { setImageId(e.target.value); setSafe(false); }}><option value="">选择物品照片</option>{r.images.filter(image => ['item', 'product'].includes(image.role)).map(image => <option key={image.id} value={image.id}>{roleText[image.role]}</option>)}</select><label className="checkbox"><input type="checkbox" checked={safe} onChange={e => setSafe(e.target.checked)}/><span>我已检查照片，不含面单、地址、微信或电话等私人信息。</span></label><button className="button secondary full" disabled={busy || !safe || !imageId} onClick={() => void mutate(`/records/${r.record.code}/imageapproval`, { revision: r.revision, imageId, confirmedSafe: true })}>审核并公开这张物品照片</button></div>}
    <ErrorNote text={error}/>{notice && <p className="notice">{notice}</p>}
  </div>;
}
type AdminScan = {
    scan: ScanProgress;
    images: {
        id: string;
        role: PhotoRole;
        url: string;
    }[];
    contact: ServerContact | null;
    recordCode: string | null;
};
function AdminScanPanel({ id, session, onClose }: {
    id: string;
    session: Session;
    onClose: () => void;
}) {
    const [scan, setScan] = useState<AdminScan>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        try {
            setScan(await api.admin<AdminScan>(`/scans/${id}`, session.access_token));
        }
        catch (e) {
            setError(message(e));
        }
    }, [id, session.access_token]);
    useEffect(() => { setScan(undefined); setError(''); void load(); }, [load]);
    return <section className="panel admin-detail"><button className="icon-button close" onClick={onClose} aria-label="关闭识别异常"><X /></button><h2>识别异常</h2><code className="record-code">{id}</code><ErrorNote text={error}/>{!scan && !error && <Spinner />}{scan && <><p>{stateText[scan.scan.state]} · 照片版本 {scan.scan.imageVersion}</p>{scan.contact ? <div className="private-contact"><strong>本人微信：{scan.contact.wechat}</strong><p>{scan.contact.other}</p><span>需要补拍时，请微信联系本人。</span></div> : <p className="muted">这是匿名查询，尚未提供联系方式。</p>}<div className="private-images">{scan.images.map(image => <a href={image.url} key={image.id} target="_blank" rel="noreferrer"><img src={image.url} alt={roleText[image.role]}/></a>)}</div><ReadFields progress={scan.scan} images={scan.images}/><button className="button secondary" disabled={busy || !['failed', 'deferred'].includes(scan.scan.state)} onClick={async () => {
                setBusy(true);
                setError('');
                try {
                    await api.admin(`/scans/${id}/retry`, session.access_token, 'POST', { imageVersion: scan.scan.imageVersion });
                    await load();
                }
                catch (e) {
                    setError(message(e));
                }
                finally {
                    setBusy(false);
                }
            }}>请求识别重试</button><button className="text-button" disabled={busy} onClick={() => void load()}>刷新状态</button></>}</section>;
}
