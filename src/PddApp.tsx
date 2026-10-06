import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { createClient, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import { ArrowLeft, ArrowRight, Camera, Check, CheckCircle2, Copy, FlipHorizontal, Heart, LoaderCircle, RefreshCw, ScanLine, ShieldCheck, Trash2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { Community } from '../shared/contracts';
import { validatePddContact, type PddAdminAction, type PddAdminDetail, type PddAdminList, type PddBatchResult, type PddContact, type PddHomeStats, type PddPublicRecord, type PddQueryLogPage, type PddQueryResult, type PddRegistration } from '../shared/waybill';
import { pddApi } from './pdd-api';
import { makeCapability } from './photos';
import { cameraConstraintsForDevice, createCameraSession, describeCamera, setCameraFocus, startBarcodeScanner, type BarcodeScanMode, type CameraDescription, type CameraFocusMode, type CameraSession } from './pdd-camera';
import { HelpPage } from './pdd-help';
import { AdminFeedbackPanel, FeedbackForm } from './pdd-feedback';
import { addQueueEntry, draftBatchNote, newPendingBatch, newQueueEntry, normalizeWaybillInput, pendingBatchInput, privateWaybillUrl, queryQueueAction, readWaybillDrafts, receiptFromRegistration, saveWaybillDrafts, setDraftBatchNote, settleQueue, waybillInputError, waybillQueryInputError, type NumberSource, type WaybillDraftState, type WaybillMode } from './waybill-drafts';

const modeLabel = { lost: '我丢件了', received: '我错收件了' };
const resolutionLabel = { open: '正在寻找', verifying: '正在核实', claimed: '已认领，待交还', resolved: '已交还' };
const resultLabel = { matched: '找到相同单号的登记', possible: '疑似线索', duplicate: '这个单号已经登记过', not_found: '暂时没有查到', closed: '包裹已经交还', registered: '登记成功' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作没有完成，请稍后重试。';
function dateText(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + '（曼谷时间）'; }
function contactLabel(contact: PddContact) { return contact.kind === 'wechat' ? '微信号' : '电话号码'; }
const localReceipt = receiptFromRegistration;
async function copy(value: string) { if (!navigator.clipboard?.writeText) throw new Error('当前浏览器无法自动复制，请长按选中内容复制。'); await navigator.clipboard.writeText(value); }

type PddContextValue = { community: Community | null; communityError: string; reloadCommunity: () => void; stats: PddHomeStats | null; statsLoading: boolean; statsError: string; reloadStats: () => void; drafts: WaybillDraftState; loaded: boolean; storageError: string; changeDrafts: (update: (state: WaybillDraftState) => WaybillDraftState) => Promise<void> };
const PddContext = createContext<PddContextValue>(null!);
function PddProvider({ children }: { children: ReactNode }) {
  const [community, setCommunity] = useState<Community | null>(null), [communityError, setCommunityError] = useState('');
  const [stats, setStats] = useState<PddHomeStats | null>(null), [statsLoading, setStatsLoading] = useState(true), [statsError, setStatsError] = useState('');
  const [drafts, setDrafts] = useState<WaybillDraftState>({ entries: [], receipts: [] }), [loaded, setLoaded] = useState(false), [storageError, setStorageError] = useState('');
  const draftRef = useRef(drafts), saves = useRef(Promise.resolve()), statsRequest = useRef(0);
  const reloadCommunity = useCallback(() => { void pddApi.community().then(value => { setCommunity(value); setCommunityError(''); }).catch(error => setCommunityError(errorMessage(error))); }, []);
  const reloadStats = useCallback(() => { const request = ++statsRequest.current; setStatsLoading(true); setStatsError(''); void pddApi.stats().then(value => { if (request === statsRequest.current) setStats(value); }).catch(error => { if (request === statsRequest.current) setStatsError(errorMessage(error)); }).finally(() => { if (request === statsRequest.current) setStatsLoading(false); }); }, []);
  useEffect(() => { let active = true; void readWaybillDrafts().then(value => { if (active) { draftRef.current = value; setDrafts(value); setLoaded(true); } }).catch(() => { if (active) { setStorageError('当前浏览器无法保存记录。请允许网站存储，或换一个浏览器后重试。'); setLoaded(true); } }); reloadCommunity(); return () => { active = false; }; }, [reloadCommunity]);
  useEffect(() => { reloadStats(); window.addEventListener('focus', reloadStats); return () => { statsRequest.current++; window.removeEventListener('focus', reloadStats); }; }, [reloadStats]);
  const changeDrafts = useCallback(async (update: (state: WaybillDraftState) => WaybillDraftState) => {
    const action = saves.current.then(async () => { const next = update(draftRef.current); await saveWaybillDrafts(next); draftRef.current = next; setDrafts(next); setStorageError(''); });
    saves.current = action.catch(() => undefined);
    try { await action; } catch { setStorageError('记录没有保存成功，请允许浏览器存储后重试。'); throw new Error('记录没有保存成功，尚未继续提交。'); }
  }, []);
  return <PddContext.Provider value={{ community, communityError, reloadCommunity, stats, statsLoading, statsError, reloadStats, drafts, loaded, storageError, changeDrafts }}>{children}</PddContext.Provider>;
}
function ErrorNote({ children }: { children?: ReactNode }) { return children ? <div className="pdd-error" role="alert">{children}</div> : null; }
function Busy({ children = '正在处理…' }: { children?: ReactNode }) { return <div className="pdd-busy" role="status"><LoaderCircle size={18} className="pdd-spin" />{children}</div>; }
function Back() { return <Link to="/" className="pdd-back"><ArrowLeft size={17} />返回查询</Link>; }
function QrPicture({ url, alt, missing, group = false }: { url: string | null | undefined; alt: string; missing: string; group?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  // This verified screenshot has a known safe crop including the quiet zone.
  // New community images keep their complete shape rather than inheriting it.
  const crop = group && !!url && url.split('?')[0].endsWith('/community-assets/group/8e25a7055606253f93cfe2c8.jpg');
  return url && !failed ? <div className={'pdd-qr-picture' + (crop ? ' pdd-qr-group-crop' : '')}><img src={url} alt={alt} onError={() => setFailed(true)} /></div> : <div className="pdd-qr-missing">{failed ? '二维码暂时无法读取' : missing}<br />{failed ? '请联系小助手' : '尚未配置'}</div>;
}
function Dialog({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const id = useId(), element = useRef<HTMLElement>(null), closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = element.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const targets = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')).filter(item => item.getClientRects().length > 0);
      const first = targets[0], last = targets[targets.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', keydown);
    return () => { dialog.removeEventListener('keydown', keydown); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);
  return <div className="pdd-overlay" onClick={onClose}><section className={'pdd-dialog ' + className} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1} ref={element} onClick={event => event.stopPropagation()}><button className="pdd-icon pdd-close" onClick={onClose} aria-label="关闭"><X /></button><h2 id={id}>{title}</h2>{children}</section></div>;
}
function CommunityCodes({ compact = false }: { compact?: boolean }) {
  const { community, communityError } = useContext(PddContext);
  return <div className={'pdd-community ' + (compact ? 'pdd-community-compact' : '')}><div className="pdd-qr-pair"><div className="pdd-qr"><span>关注 CMI 公众号</span><QrPicture url={community?.officialAccountQrUrl} alt={(community?.officialAccountName || 'CMI') + '公众号二维码'} missing="公众号二维码" /><small>{community?.officialAccountName || 'CMI Community'}</small></div><div className="pdd-qr"><span>加入找货群<small className="pdd-qr-channel">微信群</small></span><QrPicture url={community?.groupQrUrl} alt="拼多多找货微信群二维码" missing="找货微信群二维码" group /><small>保存后用微信扫一扫</small></div></div><p className="pdd-helper">群满了？联系 CMI 小助手：<strong>{community?.assistantWechat || '联系方式尚未配置'}</strong></p>{!compact && community?.assistantQrUrl && <a href={community.assistantQrUrl} target="_blank" rel="noreferrer" className="pdd-text-link">查看小助手二维码<ArrowRight size={15} /></a>}{!community && communityError && <ErrorNote>{communityError}</ErrorNote>}</div>;
}
function Footer() { const [feedbackOpen, setFeedbackOpen] = useState(false); return <><footer className="pdd-footer"><CommunityCodes compact /><div className="pdd-credit"><span className="pdd-community-wordmark">CMI <small>COMMUNITY</small></span><p>PDD404 Built by CMI Community</p><small>Connect · Make · Impact</small><nav aria-label="页脚"><Link to="/local">本机记录</Link><Link to="/privacy">隐私说明</Link><button type="button" onClick={() => setFeedbackOpen(true)}>建议与反馈</button><a href="https://github.com/CMI-Community/cmi-find-my-pdd" target="_blank" rel="noreferrer">开源代码</a></nav></div></footer>{feedbackOpen && <Dialog title="建议与反馈" className="pdd-feedback-dialog" onClose={() => setFeedbackOpen(false)}><FeedbackForm /></Dialog>}</>; }
function ContactFields({ contact, onChange, disabled = false }: { contact: PddContact; onChange: (contact: PddContact) => void; disabled?: boolean }) {
  const id = useId();
  return <div className="pdd-contact-fields"><label htmlFor={id + '-kind'}>联系方式<select id={id + '-kind'} value={contact.kind} onChange={event => onChange({ kind: event.target.value as PddContact['kind'], value: '' })} disabled={disabled}><option value="wechat">微信号</option><option value="phone">电话号码</option></select></label><label htmlFor={id + '-value'}>{contact.kind === 'wechat' ? '您的微信号' : '您的电话号码'}<input id={id + '-value'} type={contact.kind === 'phone' ? 'tel' : 'text'} value={contact.value} maxLength={contact.kind === 'phone' ? 32 : 64} onChange={event => onChange({ ...contact, value: event.target.value })} placeholder={contact.kind === 'wechat' ? '填写微信号，请勿填写昵称' : '包含国家区号，如 +66…'} autoComplete="off" disabled={disabled} required /></label><p className="pdd-privacy-hint"><ShieldCheck size={17} />相同单号的另一方可查看，用于联系、核实与交还。</p></div>;
}
function checkedContact(contact: PddContact) { try { return validatePddContact(contact); } catch { throw new Error(contact.kind === 'wechat' ? '请填写有效的微信号（字母开头，至少6位），不要填写昵称。' : '请填写有效的电话号码，可包含国家区号、空格或连字符。'); } }

export function WaybillNote({ note, label = '补充说明' }: { note?: string | null; label?: string }) {
  return note?.trim() ? <div className="pdd-waybill-note"><strong>{label}</strong><p className="pdd-selectable">{note}</p></div> : null;
}
export function BatchNoteField({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return <div className="pdd-batch-note"><label htmlFor={id}>补充说明（选填）<textarea id={id} value={value} maxLength={1000} onChange={event => onChange(Array.from(event.target.value).slice(0, 500).join(''))} disabled={disabled} aria-describedby={id + '-hint ' + id + '-count'} placeholder="例如：晚上可以领取，或包裹外观特征" /></label><p id={id + '-hint'}>可填写领取时间、包裹特征或交接提示。本次所有单号使用同一条备注，对方查到包裹时会与联系方式一起显示。</p><p id={id + '-count'} className="pdd-note-count">{Array.from(value).length}/500字</p></div>;
}
export function HomeStats({ stats, loading, error, onRefresh }: { stats: PddHomeStats | null; loading: boolean; error: string; onRefresh: () => void }) {
  return <section className="pdd-home-stats" aria-labelledby="pdd-stats-title" aria-busy={loading}><h2 id="pdd-stats-title">大家一起登记的线索</h2>{stats && <dl><div><dt>累计挂失登记</dt><dd>{stats.lostRegistered.toLocaleString('zh-CN')}</dd></div><div><dt>累计错收登记</dt><dd>{stats.receivedRegistered.toLocaleString('zh-CN')}</dd></div><div><dt>成功匹配包裹</dt><dd>{stats.matchedParcels.toLocaleString('zh-CN')}</dd></div></dl>}{loading && <p role="status">{stats ? '正在更新统计…' : '正在读取真实登记统计…'}</p>}{error && <p role="status" className="pdd-stats-error">统计暂时无法读取。{stats ? '上方为最近一次读取的数字。' : ''}<button type="button" className="pdd-text-link" onClick={onRefresh} disabled={loading}>重试读取</button></p>}{stats && <p>仅计正式登记，同一单号的每种类型只计一次；同一包裹只计一次匹配。匹配不代表已核实或已交还。</p>}</section>;
}

export function defaultPreviewMirror(camera: Pick<CameraDescription, 'facingMode'>, mobile: boolean) {
  if (camera.facingMode === 'user') return true;
  if (camera.facingMode === 'environment') return false;
  return !mobile;
}
export function scannerFocusOptions(camera: CameraDescription) {
  const automatic: CameraFocusMode | null = camera.focusModes.includes('continuous') ? 'continuous' : camera.focusModes.includes('single-shot') ? 'single-shot' : null;
  const range = camera.focusDistance;
  const manual = camera.focusModes.includes('manual') && !!range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min < range.max;
  return { automatic, manual };
}
export function initialScannerFocusDistance(camera: CameraDescription) {
  const range = camera.focusDistance;
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max) return 0;
  const value = Number.isFinite(range.current) ? Math.min(range.max, Math.max(range.min, range.current!)) : (range.min + range.max) / 2;
  if (!range.step || !Number.isFinite(range.step) || range.step <= 0) return value;
  const last = Math.floor((range.max - range.min) / range.step + 1e-8), chosen = Math.min(last, Math.max(0, Math.round((value - range.min) / range.step)));
  return Number((range.min + chosen * range.step).toPrecision(12));
}
export function observedScannerFocus(camera: CameraDescription, requested: CameraFocusMode) {
  return { confirmed: camera.focusMode === requested, manual: camera.focusMode === 'manual' && scannerFocusOptions(camera).manual };
}
/** Switching/closing always invalidates the previous session before opening another. */
export function createScannerCameraController(getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  let current: CameraSession | null = null;
  return {
    open(deviceId?: string) { const previous = current; current = null; previous?.stop(); const next = createCameraSession(getUserMedia, cameraConstraintsForDevice(deviceId)); current = next; return next; },
    isCurrent(session: CameraSession) { return current === session; },
    stop() { const previous = current; current = null; previous?.stop(); },
  };
}
export function ScannerPreview({ videoRef, mirrored }: { videoRef: RefObject<HTMLVideoElement | null>; mirrored: boolean }) {
  // The horizontal window shows the center of the camera image. CSS changes
  // only the preview; the decoder still receives the complete original video.
  return <video ref={videoRef} autoPlay playsInline muted data-preview-mirrored={mirrored ? 'true' : 'false'} aria-label="摄像头中央取景画面" />;
}
type ScannerDevice = { deviceId: string; label: string };
export function scannerReaderErrorMessage(exception: unknown) {
  return exception instanceof Error && exception.name === 'BarcodeReaderUnavailableError'
    ? '条形码识别组件未能加载。请刷新页面重试，或关闭扫码并手动输入单号。'
    : null;
}
export function scannerFailureCanEnumerate(exception: unknown) {
  const name = exception instanceof Error || exception instanceof DOMException ? exception.name : '';
  return !['NotAllowedError', 'SecurityError', 'AbortError', 'BarcodeReaderUnavailableError'].includes(name);
}
export async function refreshScannerDevices(mediaDevices: Pick<MediaDevices, 'enumerateDevices'>, isCurrent: () => boolean, onDevices: (devices: ScannerDevice[]) => void) {
  try {
    const values = await mediaDevices.enumerateDevices();
    if (!isCurrent()) return;
    const available = values.filter(device => device.kind === 'videoinput' && device.deviceId);
    onDevices(available.filter((device, index) => available.findIndex(other => other.deviceId === device.deviceId) === index).map(device => ({ deviceId: device.deviceId, label: device.label })));
  } catch { /* Enumeration failure must not hide the preview or startup error. */ }
}
export function ScannerDevicePicker({ devices, selectedDevice, onCamera }: { devices: ScannerDevice[]; selectedDevice: string; onCamera: (deviceId: string) => void }) {
  const id = useId();
  if (devices.length < 2) return null;
  return <label htmlFor={id}>选择摄像头<select id={id} className="pdd-camera-device" value={selectedDevice} onChange={event => onCamera(event.target.value)}>{!devices.some(device => device.deviceId === selectedDevice) && <option value="">请选择摄像头</option>}{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || '摄像头 ' + (index + 1)}</option>)}</select></label>;
}
type ScannerCameraControlsProps = {
  camera: CameraDescription; devices: ScannerDevice[]; selectedDevice: string; mirrored: boolean; manualFocus: boolean; focusValue: number; focusBusy: boolean; focusMessage: string; focusError: string; disabled: boolean;
  onCamera: (deviceId: string) => void; onMirror: () => void; onFocusMode: (mode: CameraFocusMode) => void; onDistance: (distance: number) => void;
};
export function ScannerCameraControls(props: ScannerCameraControlsProps) {
  const id = useId(), { automatic, manual } = scannerFocusOptions(props.camera), range = props.camera.focusDistance;
  return <div className="pdd-camera-controls">
    <div className="pdd-camera-tools"><button className="pdd-button pdd-secondary pdd-mirror-toggle" type="button" aria-pressed={props.mirrored} onClick={props.onMirror}><FlipHorizontal size={18} />左右翻转画面</button><span>方向不顺手？点此调整。</span></div>
    <ScannerDevicePicker devices={props.devices} selectedDevice={props.selectedDevice} onCamera={props.onCamera} />
    {automatic || manual ? <fieldset className="pdd-focus-controls"><legend>画面模糊？调整对焦</legend><div className="pdd-focus-buttons">{automatic && <button type="button" className="pdd-button pdd-secondary pdd-focus-auto" aria-pressed={!props.manualFocus && props.camera.focusMode === automatic} disabled={props.disabled} onClick={() => props.onFocusMode(automatic)}>自动对焦</button>}{manual && <button type="button" className="pdd-button pdd-secondary pdd-focus-manual" aria-pressed={props.manualFocus} disabled={props.disabled} onClick={() => props.onFocusMode('manual')}>手动对焦</button>}</div>{manual && props.manualFocus && range && <label htmlFor={id + '-focus'} className="pdd-focus-slider-label">慢慢拖动，直到黑白线条清楚<input id={id + '-focus'} type="range" className="pdd-focus-distance" min={range.min} max={range.max} step={range.step || 'any'} value={props.focusValue} onChange={event => props.onDistance(Number(event.target.value))} disabled={props.disabled} /></label>}<p className="pdd-camera-distance-hint">先把面单移远，直到黑白线条清楚，再稳住片刻。电脑仍模糊时，用手机扫码更方便。</p></fieldset> : <p className="pdd-camera-distance-hint">当前摄像头暂不支持在网页中调焦。请把面单移远，直到黑白线条清楚；不要继续靠近。电脑仍模糊时，用手机扫码更方便。</p>}
    {(props.focusBusy || props.focusMessage) && <p className="pdd-focus-message" role="status" aria-live="polite">{props.focusBusy ? '正在调整对焦，相机保持开启…' : props.focusMessage}</p>}
    <ErrorNote>{props.focusError}</ErrorNote>
  </div>;
}
export function ScannerReadControls({ mode, ready, busy, onMode, onCapture, onClose }: { mode: BarcodeScanMode; ready: boolean; busy: boolean; onMode: (mode: BarcodeScanMode) => void; onCapture: () => void; onClose: () => void }) {
  return <div className="pdd-scan-read-controls"><button type="button" className="pdd-button pdd-primary pdd-full pdd-capture-button" disabled={!ready || busy} onClick={onCapture}>{busy ? <LoaderCircle size={20} className="pdd-spin" /> : <Camera size={20} />}{busy ? '已拍照，正在识别…' : '拍照识别'}</button><div className="pdd-scan-secondary-actions"><button type="button" className="pdd-button pdd-secondary" aria-pressed={mode === 'realtime'} disabled={!ready || busy} onClick={() => onMode(mode === 'photo' ? 'realtime' : 'photo')}><ScanLine size={18} />{mode === 'photo' ? '开启自动扫码' : '停止自动扫码'}</button><button type="button" className="pdd-button pdd-secondary" onClick={onClose}>关闭并手动输入</button></div></div>;
}
function Scanner({ onDecoded, onClose }: { onDecoded: (number: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null), controller = useRef<ReturnType<typeof createScannerCameraController> | null>(null), streamRef = useRef<MediaStream | null>(null);
  const scannerRef = useRef<ReturnType<typeof startBarcodeScanner> | null>(null), captureBusy = useRef(false), captureSequence = useRef(0), scanModeRef = useRef<BarcodeScanMode>('photo');
  const [scanMode, setScanMode] = useState<BarcodeScanMode>('photo'), [photoBusy, setPhotoBusy] = useState(false), [photoNotice, setPhotoNotice] = useState('');
  const [request, setRequest] = useState<{ deviceId?: string; revision: number }>({ revision: 0 });
  const [error, setError] = useState(''), [phase, setPhase] = useState<'permission' | 'opening' | 'switching' | 'scanning' | 'error'>('permission');
  const [readerUnavailable, setReaderUnavailable] = useState(false);
  const [helpStage, setHelpStage] = useState(0), [devices, setDevices] = useState<ScannerDevice[]>([]), [camera, setCamera] = useState<CameraDescription | null>(null), [mirrored, setMirrored] = useState(false);
  const [manualFocus, setManualFocus] = useState(false), [focusValue, setFocusValue] = useState(0), [focusBusy, setFocusBusy] = useState(false), [focusError, setFocusError] = useState(''), [focusMessage, setFocusMessage] = useState('');
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null), focusSequence = useRef(0), cameraSequence = useRef(0), onDecodedRef = useRef(onDecoded), onCloseRef = useRef(onClose);
  onDecodedRef.current = onDecoded; onCloseRef.current = onClose;
  const clearFocusTimer = () => { if (focusTimer.current) clearTimeout(focusTimer.current); focusTimer.current = null; };
  const stopCurrent = () => { clearFocusTimer(); focusSequence.current++; captureSequence.current++; streamRef.current = null; scannerRef.current = null; captureBusy.current = false; controller.current?.stop(); };
  const close = () => { cameraSequence.current++; stopCurrent(); onCloseRef.current(); };
  const changeCamera = (deviceId?: string) => { cameraSequence.current++; stopCurrent(); setPhotoBusy(false); setPhotoNotice(''); setPhase('switching'); setError(''); setReaderUnavailable(false); setRequest(value => ({ deviceId, revision: value.revision + 1 })); };
  const changeReadMode = (mode: BarcodeScanMode) => { if (mode === scanModeRef.current) return; scanModeRef.current = mode; captureSequence.current++; scannerRef.current?.setMode(mode); captureBusy.current = false; setScanMode(mode); setPhotoBusy(false); setPhotoNotice(''); setError(''); };
  const capturePhoto = async () => {
    const controls = scannerRef.current, stream = streamRef.current, revision = cameraSequence.current;
    if (captureBusy.current) return;
    if (!controls || !stream || phase !== 'scanning') { setPhotoNotice('相机还在准备，请稍等后再拍。'); return; }
    changeReadMode('photo');
    const attempt = ++captureSequence.current;
    captureBusy.current = true;
    // Commit feedback before freezing/decoding pixels. The camera's real frame
    // is captured synchronously by capture(), then the preview pauses visibly.
    flushSync(() => { setPhotoBusy(true); setPhotoNotice(''); setError(''); });
    try {
      const pending = controls.capture();
      video.current?.pause();
      const result = await pending;
      if (scannerRef.current !== controls || streamRef.current !== stream || revision !== cameraSequence.current || attempt !== captureSequence.current) return;
      if (result.result === 'not_found') setPhotoNotice('这张照片未识别到条形码。请让黑白线条清楚后再拍，或手动输入单号。');
    } catch (exception) {
      if (scannerRef.current !== controls || streamRef.current !== stream || revision !== cameraSequence.current || attempt !== captureSequence.current) return;
      const readerError = scannerReaderErrorMessage(exception);
      if (readerError) { stopCurrent(); setPhotoBusy(false); setReaderUnavailable(true); setError(readerError); setPhase('error'); }
      else if (!(exception instanceof Error && exception.name === 'AbortError')) setError('这次拍照识别没有完成。请等画面清楚后重新拍照；也可手动输入单号。');
    } finally {
      if (scannerRef.current === controls && streamRef.current === stream && revision === cameraSequence.current && attempt === captureSequence.current) { captureBusy.current = false; setPhotoBusy(false); void video.current?.play().catch(() => { if (scannerRef.current === controls && streamRef.current === stream && revision === cameraSequence.current && attempt === captureSequence.current) setError('相机画面未恢复。请关闭后重新扫码，或手动输入单号。'); }); }
    }
  };
  const adjustFocus = async (mode: CameraFocusMode, distance?: number) => {
    const stream = streamRef.current;
    if (!stream) return;
    const current = ++focusSequence.current;
    setFocusBusy(true); setFocusError(''); setFocusMessage('');
    try {
      const description = await setCameraFocus(stream, mode, distance);
      if (streamRef.current !== stream || current !== focusSequence.current) return;
      const observed = observedScannerFocus(description, mode);
      setCamera(description); setManualFocus(observed.manual);
      if (description.focusDistance?.current !== undefined) setFocusValue(initialScannerFocusDistance(description));
      setFocusMessage(observed.confirmed ? mode === 'manual' ? '相机已确认手动对焦。慢慢拖动，直到黑白线条清楚。' : '相机已确认自动对焦。请看画面是否清楚，清楚后稳住片刻。' : description.focusMode ? '相机没有切换到所选对焦方式。请看画面是否清楚，或调整面单距离。' : '已请求调整对焦，相机暂未确认当前方式。请看画面是否清楚，或调整面单距离。');
    } catch (exception) {
      if (streamRef.current !== stream || current !== focusSequence.current) return;
      if (!(exception instanceof Error && exception.name === 'AbortError')) setFocusError('对焦调整没有成功，相机保持开启。请调整面单距离，或换一台摄像头。');
    } finally { if (streamRef.current === stream && current === focusSequence.current) setFocusBusy(false); }
  };
  const chooseFocusMode = (mode: CameraFocusMode) => { clearFocusTimer(); const range = camera?.focusDistance; void adjustFocus(mode, mode === 'manual' && range ? focusValue : undefined); };
  const changeFocusDistance = (distance: number) => {
    setFocusValue(distance); setFocusMessage(''); focusSequence.current++; clearFocusTimer();
    // Coalesce dragging without restarting the stream or pausing barcode reads.
    focusTimer.current = setTimeout(() => { focusTimer.current = null; void adjustFocus('manual', distance); }, 150);
  };
  useEffect(() => {
    setHelpStage(0);
    if (phase !== 'scanning' || scanMode !== 'realtime') return;
    const distanceHelp = window.setTimeout(() => setHelpStage(1), 4000), lightHelp = window.setTimeout(() => setHelpStage(2), 10000);
    return () => { window.clearTimeout(distanceHelp); window.clearTimeout(lightHelp); };
  }, [phase, scanMode]);
  useEffect(() => {
    let active = true, decoded = false, session: CameraSession | null = null, decoder: ReturnType<typeof startBarcodeScanner> | null = null;
    const currentRequest = ++cameraSequence.current, activeRequest = () => active && currentRequest === cameraSequence.current;
    const ownsSession = () => activeRequest() && !!session && !!controller.current?.isCurrent(session);
    const stop = () => { session?.stop(); if (scannerRef.current === decoder) scannerRef.current = null; if (session && controller.current?.isCurrent(session)) stopCurrent(); };
    const hidden = () => { if (document.hidden && ownsSession()) { stop(); onCloseRef.current(); } };
    document.addEventListener('visibilitychange', hidden);
    setFocusBusy(false); setFocusError(''); setFocusMessage(''); setManualFocus(false);
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法使用摄像头。');
        if (!controller.current) controller.current = createScannerCameraController(constraints => navigator.mediaDevices.getUserMedia(constraints));
        // First open immediately requests permission; enumeration waits until grant.
        session = controller.current.open(request.deviceId);
        const stream = await session.ready;
        if (!ownsSession()) { stop(); return; }
        streamRef.current = stream;
        const description = describeCamera(stream), range = description.focusDistance;
        setCamera(description); setManualFocus(description.focusMode === 'manual' && scannerFocusOptions(description).manual && range?.current !== undefined);
        setFocusValue(initialScannerFocusDistance(description));
        const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
        setMirrored(defaultPreviewMirror(description, mobile)); setPhase('opening');
        if (typeof navigator.mediaDevices.enumerateDevices === 'function') void refreshScannerDevices(navigator.mediaDevices, ownsSession, setDevices);
        const controls = startBarcodeScanner(stream, video.current!, text => {
          if (!ownsSession() || decoded) return;
          const number = normalizeWaybillInput(text);
          if (waybillInputError(number)) return;
          decoded = true; stop(); onDecodedRef.current(number);
        }, text => !waybillInputError(normalizeWaybillInput(text)), { mode: scanModeRef.current });
        decoder = controls; scannerRef.current = controls;
        session.attachDecoder(controls);
        await controls.ready;
        if (!ownsSession() || decoded) stop(); else setPhase('scanning');
      } catch (exception) {
        const current = ownsSession(); stop();
        if (!activeRequest() || decoded || (!current && session)) return;
        const name = exception instanceof DOMException || exception instanceof Error ? exception.name : '';
        const readerError = scannerReaderErrorMessage(exception);
        setReaderUnavailable(!!readerError);
        setError(readerError || (name === 'NotAllowedError' || name === 'SecurityError' ? '摄像头权限未开启。请在浏览器或系统设置中允许本网站使用相机，再重新扫码；也可手动输入单号。' : name === 'NotFoundError' || name === 'OverconstrainedError' ? '没有找到这台摄像头。请重新选择其他摄像头，或直接输入单号。' : name === 'NotReadableError' ? '摄像头被占用或暂时无法启动。请关闭其他使用相机的应用，再重新扫码；也可手动输入单号。' : !navigator.mediaDevices?.getUserMedia ? '当前浏览器无法使用摄像头。请用 Safari 或其他浏览器打开，也可以直接输入单号。' : '相机未能启动。请重新开启相机；仍无法使用时可直接输入单号。'));
        setPhase('error');
        if (scannerFailureCanEnumerate(exception) && typeof navigator.mediaDevices?.enumerateDevices === 'function') void refreshScannerDevices(navigator.mediaDevices, activeRequest, setDevices);
      }
    })();
    return () => { active = false; document.removeEventListener('visibilitychange', hidden); stop(); };
  }, [request]);
  const status = phase === 'permission' ? '正在申请摄像头权限…' : phase === 'switching' ? '正在切换摄像头…' : phase === 'opening' ? '相机已开启，正在准备识别…' : photoBusy ? '已拍下画面，正在本机识别…' : scanMode === 'photo' ? '对准完整条码，点击下方“拍照识别”。' : '正在自动扫描；也可以直接拍照识别。';
  const guidance = helpStage === 0 ? '把完整条码横向放入框内，两端白边不要切掉。慢慢调整距离，让黑白线条清晰。稳住片刻，避开反光。' : helpStage === 1 ? '还没识别到？先把面单移远，直到黑白线条清楚，不要继续靠近。清晰后稳住片刻。' : '仍在扫描。请调整光线、避开反光；电脑画面仍模糊时，用手机扫码更方便。';
  return <Dialog title="扫描国内快递单号" onClose={close} className="pdd-scanner-dialog">
    <div className="pdd-scanner-view">
      <div className="pdd-scanner-scroll">
      <p className="pdd-scanner-intro">把完整运输条码横向放入框内，两端白边不要切掉。</p>
      <div className="pdd-scanner" data-phase={phase}>
        <ScannerPreview videoRef={video} mirrored={mirrored} />
        {phase === 'scanning' ? <><div className="pdd-scan-frame" aria-hidden="true"><span /><span /><span /><span /></div><div className="pdd-scan-caption" aria-hidden="true"><ScanLine size={19} />整个条码放入框内</div></> : <div className="pdd-camera-stage" aria-hidden="true">{phase === 'error' ? readerUnavailable ? <ScanLine size={32} /> : <Camera size={32} /> : <LoaderCircle size={30} className="pdd-spin" />}<strong>{phase === 'error' ? readerUnavailable ? '识别组件未能加载' : '摄像头已关闭' : status}</strong>{phase === 'permission' && <span>请在浏览器提示中选择“允许”。</span>}{(phase === 'opening' || phase === 'switching') && <span>准备好后可以拍照，也可以切换实时扫码。</span>}</div>}
        {photoBusy && <div className="pdd-photo-feedback" aria-hidden="true"><LoaderCircle size={26} className="pdd-spin" /><strong>已拍照 · 正在识别</strong></div>}
      </div>
      {scanMode === 'realtime' && phase === 'scanning' && helpStage > 0 && <p className="pdd-scan-help">{guidance}</p>}
      <details className="pdd-camera-settings"><summary>画面模糊或反向？展开相机设置</summary>
      {camera && <ScannerCameraControls camera={camera} devices={devices} selectedDevice={phase === 'scanning' ? camera.deviceId || request.deviceId || '' : request.deviceId || camera.deviceId || ''} mirrored={mirrored} manualFocus={manualFocus} focusValue={focusValue} focusBusy={focusBusy} focusMessage={focusMessage} focusError={focusError} disabled={phase !== 'scanning'} onCamera={changeCamera} onMirror={() => setMirrored(value => !value)} onFocusMode={chooseFocusMode} onDistance={changeFocusDistance} />}
      {!camera && phase === 'error' && devices.length > 1 && <div className="pdd-camera-controls pdd-camera-recovery-controls"><p className="pdd-camera-distance-hint">也可以选择其他摄像头再试。</p><ScannerDevicePicker devices={devices} selectedDevice={request.deviceId || ''} onCamera={changeCamera} /></div>}
      </details>
      <p className="pdd-scanner-privacy"><ShieldCheck size={17} />仅本机识别；成功后核对单号，再点击查询。</p>
      </div>
      <div className="pdd-scanner-actions">
        <div className={'pdd-camera-status' + (error || photoNotice ? ' pdd-capture-notice' : '')} role="status" aria-live="polite" aria-atomic="true">{photoBusy || phase === 'permission' || phase === 'opening' || phase === 'switching' ? <LoaderCircle size={20} className="pdd-spin" /> : <Camera size={20} />}<span>{error || photoNotice || status}</span></div>
        {phase === 'error' && <button className="pdd-button pdd-secondary pdd-full pdd-camera-retry" onClick={() => { if (readerUnavailable) { close(); window.location.reload(); } else changeCamera(request.deviceId); }}>{readerUnavailable ? '刷新页面重试' : '重新开启相机'}</button>}
        <ScannerReadControls mode={scanMode} ready={phase === 'scanning'} busy={photoBusy} onMode={changeReadMode} onCapture={() => void capturePhoto()} onClose={close} />
      </div>
    </div>
  </Dialog>;
}

export function PossibleQueryDetails({ number, response }: { number: string; response: PddQueryResult }) {
  return <div className="pdd-possible-details"><p className="pdd-result-number">本次查询单号<strong>{number}</strong></p><p>下方是字符相似度超过70%、低于100%的疑似线索。<strong>字符相似度，不代表包裹归属。</strong></p><ol className="pdd-possible-clues">{response.candidates.slice(0, 5).map((item, index) => <li key={item.code}><h3>线索 {index + 1} · 字符相似度 {item.similarity.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%</h3><p>记录编号 <code className="pdd-selectable">{item.code}</code></p><p>国内单号尾号 <strong>{item.tail}</strong></p><p>登记于 {dateText(item.registeredAt)}</p></li>)}</ol><p className="pdd-possible-next">请截图保存本页，联系 CMI 小助手获取进一步核实与对接。疑似线索不会展示对方联系方式或备注。</p></div>;
}
export function PossibleRegistrationAction({ number, busy, onRegister }: { number: string; busy: boolean; onRegister: () => void }) {
  return waybillInputError(number) ? <p className="pdd-small">登记需要完整单号。请先核对不清楚的字符，再返回查询。</p> : <button type="button" className="pdd-button pdd-secondary pdd-full" disabled={busy} onClick={onRegister}>{busy ? '正在加入待提交列表…' : '仍要登记这个完整单号'}</button>;
}
type QueryView = { number: string; mode: WaybillMode; source: NumberSource; capability: string; response: PddQueryResult };
function QueryDialog({ view, onClose, onRegister }: { view: QueryView; onClose: () => void; onRegister: () => Promise<void> }) {
  const { drafts, changeDrafts, reloadStats } = useContext(PddContext);
  const [showContact, setShowContact] = useState(false), [contact, setContact] = useState<PddContact>({ kind: 'wechat', value: '' }), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [copyNotice, setCopyNotice] = useState('');
  const response = view.response;
  const matched = response.result === 'matched';
  if (response.result === 'possible') return <Dialog title="找到疑似包裹线索" onClose={onClose}><PossibleQueryDetails number={view.number} response={response} /><CommunityCodes compact /><PossibleRegistrationAction number={view.number} busy={busy} onRegister={() => { setError(''); setBusy(true); void onRegister().catch(exception => setError(errorMessage(exception))).finally(() => setBusy(false)); }} /><ErrorNote>{error}</ErrorNote><button type="button" className="pdd-button pdd-primary pdd-full" onClick={onClose} disabled={busy}>知道了，先核对单号</button></Dialog>;
  return <Dialog title={matched ? (view.mode === 'lost' ? '有线索了，找到包裹登记！' : '有线索了，找到寻件登记！') : resultLabel[response.result]} onClose={onClose}>{matched && <div className="pdd-result-mark pdd-result-good"><CheckCircle2 size={30} /></div>}<p className="pdd-result-number">国内快递单号<strong>{view.number}</strong></p>{response.registeredAt && <p className="pdd-small">登记时间：{dateText(response.registeredAt)}</p>}{matched && response.contact && <div className="pdd-contact-card"><span>对方{contactLabel(response.contact)}</span><strong>{response.contact.value}</strong><button className="pdd-text-link" onClick={() => void copy(response.contact!.value).then(() => setCopyNotice('联系方式已复制。')).catch(exception => setError(errorMessage(exception)))}><Copy size={16} />复制联系方式</button></div>}{matched && <WaybillNote note={response.note} label="对方备注" />}<p>{matched ? '请主动联系对方，核对包裹信息后再交还。单号匹配是一条线索，还需确认包裹归属。' : response.result === 'duplicate' ? '无需再次添加。您可以保存本页截图，在找货群里继续沟通。' : '这个包裹已被标记为实际交还。如果您有疑问，请联系 CMI 小助手。'}</p><p className="pdd-thanks"><Heart size={17} />感谢您一起改善物流混乱，让包裹回到主人手里。</p>{matched && !saved && !showContact && <button className="pdd-text-link" onClick={() => setShowContact(true)}>留下我的联系方式（可选）<ArrowRight size={16} /></button>}{showContact && !saved && <form onSubmit={async event => { event.preventDefault(); setError(''); setBusy(true); try { const pendingContact = drafts.pendingContacts?.find(item => item.queryId === response.queryId) || { queryId: response.queryId, capability: view.capability, contact: checkedContact(contact), number: view.number, mode: view.mode }; await changeDrafts(state => ({ ...state, pendingContacts: [...(state.pendingContacts || []).filter(item => item.queryId !== response.queryId), pendingContact] })); const result = await pddApi.queryContact(response.queryId, pendingContact.contact, view.capability); reloadStats(); await changeDrafts(state => ({ ...state, pendingContacts: state.pendingContacts?.filter(item => item.queryId !== response.queryId), receipts: result.registration ? [...state.receipts.filter(item => item.code !== result.registration!.registrationCode), localReceipt(result.registration, view.capability)] : state.receipts })); setSaved(true); } catch (exception) { setError(errorMessage(exception)); } finally { setBusy(false); } }}><ContactFields contact={contact} onChange={setContact} disabled={busy} /><button className="pdd-button pdd-primary pdd-full" disabled={busy}>{busy ? '正在保存…' : '保存联系方式'}</button></form>}{saved && <p className="pdd-success-note" role="status"><Check size={18} />联系方式已保存，感谢您的参与。<Link to="/local">查看本机回执</Link></p>}<ErrorNote>{error}</ErrorNote>{copyNotice && <p className="pdd-success-note" role="status">{copyNotice}</p>}<CommunityCodes compact /><button className="pdd-button pdd-primary pdd-full" onClick={onClose} disabled={busy}>知道了，继续查询</button></Dialog>;
}

function BatchReceipt({ receipt, onClose }: { receipt: PddBatchResult; onClose: () => void }) {
  return <Dialog title="本次登记已处理" onClose={onClose}><p>感谢您的参与！以下是每个单号的处理结果，请截图保存。</p><p className="pdd-small">{dateText(receipt.submittedAt)}</p><div className="pdd-receipt-list">{receipt.items.map(item => <article key={item.requestId}><div><code>{item.number}</code><span>{resultLabel[item.result]}</span></div>{item.result === 'matched' && item.contact && <p>对方{contactLabel(item.contact)}：<strong className="pdd-selectable">{item.contact.value}</strong>。请核实后交还。</p>}{item.result === 'matched' && <WaybillNote note={item.note} label="对方备注" />}{item.registration && <WaybillNote note={item.registration.note} label="我的备注" />}{item.registration && <Link to={'/m/' + item.registration.registrationCode}>查看、修改或撤回这条登记<ArrowRight size={15} /></Link>}</article>)}</div><p className="pdd-small">后续可从“本机记录”继续查看。匹配后页面会显示线索，管理员也可协助跟进。</p><CommunityCodes compact /><button className="pdd-button pdd-primary pdd-full" onClick={onClose}>知道了</button></Dialog>;
}

function Home() {
  const { community, communityError, stats, statsLoading, statsError, reloadStats, drafts, loaded, storageError, changeDrafts } = useContext(PddContext);
  const initialMode = new URLSearchParams(window.location.search).get('mode') === 'received' ? 'received' : 'lost';
  const [mode, setMode] = useState<WaybillMode>(initialMode), [number, setNumber] = useState(''), [source, setSource] = useState<NumberSource>('manual'), [scanning, setScanning] = useState(false), [querying, setQuerying] = useState(false), [submitting, setSubmitting] = useState(false), [queryView, setQueryView] = useState<QueryView | null>(null), [receipt, setReceipt] = useState<PddBatchResult | null>(null), [contact, setContact] = useState<PddContact>({ kind: 'wechat', value: '' }), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [noteDrafts, setNoteDrafts] = useState<Partial<Record<WaybillMode, string>>>({});
  const changeNote = (value: string) => { setNoteDrafts(current => ({ ...current, [mode]: value })); void changeDrafts(state => setDraftBatchNote(state, mode, value)).catch(exception => setError(errorMessage(exception))); };
  const entries = drafts.entries.filter(item => item.mode === mode), pending = drafts.pendingBatch;
  const note = pending?.mode === mode ? pending.note || '' : noteDrafts[mode] ?? draftBatchNote(drafts, mode);
  const busy = querying || submitting;
  const query = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice('');
    const validation = waybillQueryInputError(number);
    if (validation) { setError(validation); input.current?.focus(); return; }
    const normalized = normalizeWaybillInput(number), capability = makeCapability(), queryId = crypto.randomUUID();
    setQuerying(true);
    try {
      const response = await pddApi.query({ queryId, number: normalized, mode, source }, capability);
      reloadStats();
      const queueAction = queryQueueAction(normalized, response.result);
      if (queueAction === 'queue') {
        const entry = newQueueEntry(normalized, mode, source);
        const existed = drafts.entries.some(item => item.mode === mode && item.number === normalized);
        await changeDrafts(state => ({ ...state, entries: addQueueEntry(state.entries, entry) }));
        setNotice(existed ? '这个单号已在下方待提交列表，无需重复添加。' : '暂时没有查到，已加入下方待提交列表。填好联系方式，再点击' + (mode === 'lost' ? '“确认挂失”' : '“全部提交”') + '。');
        setNumber(''); setSource('manual'); input.current?.focus();
      } else if (queueAction === 'complete_number') { setNotice('暂未找到线索。带 ? 或 * 的不完整单号尚未加入待提交列表，请先核对完整单号，再查询和登记。'); input.current?.focus(); }
      else setQueryView({ number: normalized, mode, source, capability, response });
    } catch (exception) { setError(errorMessage(exception)); }
    finally { setQuerying(false); }
  };
  const registerPossible = async (view: QueryView) => {
    if (view.response.result !== 'possible' || waybillInputError(view.number)) throw new Error('请先核对完整单号，再登记。');
    const entry = newQueueEntry(view.number, view.mode, view.source);
    await changeDrafts(state => ({ ...state, entries: addQueueEntry(state.entries, entry) }));
    setQueryView(null); setNumber(''); setSource('manual');
    setNotice('这个完整单号已加入待提交列表，尚未正式登记。请填写联系方式，再确认提交。'); input.current?.focus();
  };
  const submitBatch = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice(''); setSubmitting(true);
    try {
      if (!entries.length) throw new Error('请先查询单号，再提交下方列表。');
      if (pending && pending.mode !== mode) throw new Error('还有一批' + modeLabel[pending.mode] + '登记等待确认，请切回该模式重试。');
      const batch = pending || newPendingBatch(mode, entries, checkedContact(contact), note);
      if (!pending) await changeDrafts(state => ({ ...state, pendingBatch: batch }));
      const response = await pddApi.batch(pendingBatchInput(batch), batch.id, batch.capability);
      reloadStats();
      await changeDrafts(state => ({ ...setDraftBatchNote(state, batch.mode, ''), pendingBatch: undefined, entries: settleQueue(state.entries, response.items.map(item => item.requestId)), receipts: [...state.receipts.filter(item => !response.items.some(result => result.registration?.registrationCode === item.code)), ...response.items.filter(item => !!item.registration).map(item => localReceipt(item.registration!, batch.capability))] }));
      setReceipt(response); setContact({ kind: 'wechat', value: '' }); setNoteDrafts(current => ({ ...current, [batch.mode]: '' }));
    } catch (exception) { setError(errorMessage(exception)); }
    finally { setSubmitting(false); }
  };
  return <div className="pdd-home"><div className="pdd-heading"><h1>我的拼多多快递<br /><span>去哪了？</span></h1></div><section className="pdd-search-section" aria-label="查找包裹"><div className="pdd-modes" role="group" aria-label="查询类型">{(['lost', 'received'] as const).map(value => <button key={value} aria-pressed={mode === value} className={mode === value ? 'selected' : ''} disabled={busy} onClick={() => { setMode(value); setNumber(''); setSource('manual'); setError(''); setNotice(''); input.current?.focus(); }}>{modeLabel[value]}</button>)}</div><form className="pdd-search-form" onSubmit={event => void query(event)}><label className="pdd-sr-only" htmlFor="waybill-input">国内快递单号</label><input ref={input} id="waybill-input" value={number} onChange={event => { setNumber(event.target.value); setSource('manual'); }} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={100} placeholder="输入或粘贴国内快递单号" disabled={busy} /><button type="button" className="pdd-scan-button" onClick={() => { setError(''); setScanning(true); }} disabled={busy} aria-label="打开摄像头扫描条形码"><ScanLine size={21} /><span>扫码</span></button><button className="pdd-query-button" disabled={busy || !loaded || !!storageError}>{querying ? <LoaderCircle size={20} className="pdd-spin" /> : '查询'}</button></form><p className="pdd-input-guide">{mode === 'lost' ? '在拼多多 App 的物流详情中复制国内运输单号。' : '扫描包裹表面的国内运输条形码，也可手动输入。'}<br />看不清的字符可用 ? 或 * 代替一位；至少保留6位清楚字符。<br />请勿填写订单编号、集运单号或末端配送单号。</p><ErrorNote>{error || storageError}</ErrorNote>{notice && <div className="pdd-notice" role="status"><CheckCircle2 size={20} /><span>{notice}</span></div>}</section>{entries.length > 0 && <section className="pdd-queue" aria-labelledby="queue-title"><div className="pdd-queue-heading"><h2 id="queue-title">{mode === 'lost' ? '待挂失' : '待登记'}单号 <span>{entries.length}</span></h2><small>仅保存在本机，尚未正式提交</small></div><ol>{entries.map(entry => <li key={entry.requestId}><code>{entry.number}</code><button disabled={submitting || pending?.items.some(item => item.requestId === entry.requestId)} onClick={() => void changeDrafts(state => ({ ...state, entries: state.entries.filter(item => item.requestId !== entry.requestId) })).catch(exception => setError(errorMessage(exception)))} aria-label={'移除单号' + entry.number}><Trash2 size={16} /><span>移除</span></button>{entry.error && <p>{entry.error}</p>}</li>)}</ol><form onSubmit={event => void submitBatch(event)}>{pending?.mode === mode ? <p className="pdd-notice">上次提交尚未确认。点击下方按钮将安全重试原批次，避免重复登记。</p> : <ContactFields contact={contact} onChange={setContact} disabled={submitting} />}<BatchNoteField value={note} onChange={changeNote} disabled={busy || pending?.mode === mode} /><button className="pdd-button pdd-primary pdd-full" disabled={busy || !community?.submissionsEnabled || !!storageError || (!!pending && pending.mode !== mode)}>{submitting ? <><LoaderCircle size={19} className="pdd-spin" />正在确认登记…</> : pending?.mode === mode ? '重试并确认上次登记' : mode === 'lost' ? '确认挂失 · ' + entries.length + ' 件' : '全部提交 · ' + entries.length + ' 件'}</button>{!community?.submissionsEnabled && <p className="pdd-service">{communityError || (community ? '登记服务暂未开放，待提交单号会保留在本机。' : '正在读取登记服务状态…')}</p>}</form><p className="pdd-thanks"><Heart size={16} />多一条准确的登记，就多一份找回包裹的可能。</p></section>}<HomeStats stats={stats} loading={statsLoading} error={statsError} onRefresh={reloadStats} /><section className="pdd-how"><span className="pdd-eyebrow">一个单号，让双方接上线索</span><h2>怎么找到包裹？</h2><div><p><strong>01</strong>丢件的人登记国内快递单号。</p><p><strong>02</strong>错收件的人扫描同一个单号。</p><p><strong>03</strong>双方匹配，联系核实后交还。</p></div><p className="pdd-small">这是 CMI Community 的公益项目。无需注册，感谢每一次参与。</p></section>{scanning && <Scanner onClose={() => setScanning(false)} onDecoded={value => { setScanning(false); setNumber(value); setSource('barcode'); setNotice('已扫描单号，请核对后点击查询。'); input.current?.focus(); }} />}{queryView && <QueryDialog view={queryView} onRegister={() => registerPossible(queryView)} onClose={() => { setQueryView(null); input.current?.focus(); }} />}{receipt && <BatchReceipt receipt={receipt} onClose={() => { setReceipt(null); input.current?.focus(); }} />}</div>;
}

function LocalPage() {
  const { drafts, loaded, storageError, changeDrafts, reloadStats } = useContext(PddContext), [notice, setNotice] = useState(''), [recovering, setRecovering] = useState('');
  return <div className="pdd-page"><Back /><span className="pdd-eyebrow">仅保存在当前浏览器</span><h1>本机记录</h1><p>换设备或清理浏览器后，这些管理入口不会自动恢复。请保存自己的私密管理链接。</p><ErrorNote>{storageError}</ErrorNote>{!loaded && <Busy />}<div className="pdd-local-list">{drafts.receipts.slice().reverse().map(item => <article key={item.code}><span className="pdd-status">{modeLabel[item.mode]}</span><code>{item.number}</code><small>{dateText(item.createdAt)}</small><WaybillNote note={item.note} label="我的备注" /><div><Link className="pdd-button pdd-secondary" to={'/m/' + item.code}>查看登记<ArrowRight size={16} /></Link><button className="pdd-text-link" onClick={() => void copy(privateWaybillUrl(item.code, item.capability)).then(() => setNotice('私密管理链接已复制，请妥善保存，不要发到群里。')).catch(exception => setNotice(errorMessage(exception)))}><Copy size={16} />保存管理链接</button></div></article>)}</div>{loaded && !drafts.receipts.length && <div className="pdd-empty"><p>本机还没有正式登记回执。</p><Link to="/" className="pdd-text-link">查询并登记单号<ArrowRight size={16} /></Link></div>}{drafts.pendingContacts?.map(item => <article className="pdd-panel" key={item.queryId}><h2>联系方式提交等待确认</h2><p><code>{item.number}</code></p><p>上次提交未收到完整回执，可安全重试原提交。</p><button className="pdd-button pdd-primary" disabled={!!recovering} onClick={async () => { setRecovering(item.queryId); try { const result = await pddApi.queryContact(item.queryId, item.contact, item.capability); reloadStats(); await changeDrafts(state => ({ ...state, pendingContacts: state.pendingContacts?.filter(pending => pending.queryId !== item.queryId), receipts: result.registration ? [...state.receipts.filter(receipt => receipt.code !== result.registration!.registrationCode), localReceipt(result.registration, item.capability)] : state.receipts })); setNotice('联系方式已确认保存。'); } catch (exception) { setNotice(errorMessage(exception)); } finally { setRecovering(''); } }}>{recovering === item.queryId ? '正在确认…' : '重试并获取回执'}</button></article>)}{drafts.entries.length > 0 && <p>还有 {drafts.entries.length} 个单号待提交。<Link to="/">返回首页继续登记</Link></p>}{notice && <p className="pdd-notice" role="status">{notice}</p>}</div>;
}

function PublicPage({ share = false }: { share?: boolean }) {
  const { code } = useParams(), [record, setRecord] = useState<PddPublicRecord | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { let active = true; setRecord(null); void pddApi.publicRecord(code || '').then(value => { if (active) setRecord(value); }).catch(exception => { if (active) setError(errorMessage(exception)); }); return () => { active = false; }; }, [code]);
  const url = window.location.origin + '/p/' + encodeURIComponent(code || '');
  return <div className={'pdd-page pdd-public ' + (share ? 'pdd-share' : '')}><Back /><ErrorNote>{error}</ErrorNote>{!record && !error && <Busy />}{record && <><section className="pdd-public-card"><span className="pdd-eyebrow">PDD404 · CMI 公益包裹互助</span><h1>{record.visibility === 'withdrawn' ? '登记已撤回' : resolutionLabel[record.resolution]}</h1><p>记录编号 <code>{record.code}</code></p>{record.visibility !== 'withdrawn' && <p>国内快递单号尾号 <strong>{record.tail}</strong></p>}<p className="pdd-small">更新于 {dateText(record.updatedAt)}</p><p>{record.visibility === 'withdrawn' ? '这条登记不再参与找货。' : '用完整的国内快递单号查询，即可查看对应的登记线索。请双方核实包裹归属后交还。'}</p><div className="pdd-public-qr"><QRCodeSVG value={url} size={112} /><small>本条记录二维码<br />打开查看最新进展</small></div><p className="pdd-url">{url}</p><p className="pdd-small">Connect · Make · Impact</p></section><div className="pdd-actions"><button className="pdd-button pdd-primary" onClick={() => void copy(url).then(() => setNotice('公开记录链接已复制。')).catch(exception => setNotice(errorMessage(exception)))}><Copy size={17} />复制公开链接</button>{!share && <Link className="pdd-button pdd-secondary" to={'/p/' + code + '/share'}>打开截图卡片</Link>}</div>{notice && <p className="pdd-notice" role="status">{notice}</p>}</>}</div>;
}

function ManagePage() {
  const { code } = useParams(), { drafts, loaded } = useContext(PddContext);
  const [capability, setCapability] = useState(''), [registration, setRegistration] = useState<PddRegistration | null>(null), [contact, setContact] = useState<PddContact>({ kind: 'wechat', value: '' }), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async (cap: string) => { const result = await pddApi.manage(code || '', cap); setRegistration(result); setContact(result.contact || { kind: 'wechat', value: '' }); }, [code]);
  useEffect(() => { if (!loaded) return; const key = new URLSearchParams(window.location.hash.slice(1)).get('key') || drafts.receipts.find(item => item.code === code)?.capability; if (!key) { setError('请在原设备打开本机记录，或使用您保存的私密管理链接。'); return; } setCapability(key); setError(''); void load(key).catch(exception => setError(errorMessage(exception))); }, [code, loaded, drafts.receipts, load]);
  return <div className="pdd-page"><Back /><span className="pdd-eyebrow">PRIVATE · 仅本人管理</span><h1>管理我的登记</h1><ErrorNote>{error}</ErrorNote>{!registration && !error && <Busy />}{registration && <><section className="pdd-panel"><span className="pdd-status">{modeLabel[registration.mode]}</span><h2 className="pdd-selectable">{registration.number}</h2><p>{registration.visibility === 'withdrawn' ? '本人的登记已撤回' : resolutionLabel[registration.record.resolution]}</p><p className="pdd-small">登记于 {dateText(registration.createdAt)}</p><button className="pdd-text-link" disabled={busy} onClick={() => void load(capability).catch(exception => setError(errorMessage(exception)))}><RefreshCw size={16} />刷新进展</button>{registration.record.lostRegistered && registration.record.receivedRegistered && registration.visibility === 'active' && <p className="pdd-notice">已有另一方登记相同单号。请返回首页，用完整单号再次查询联系方式，并核实交还。</p>}</section><WaybillNote note={registration.note} label="我的备注" />{!registration.contact && <p className="pdd-small">联系方式已按保留期清理。</p>}{registration.visibility === 'active' && registration.contact && <form className="pdd-panel" onSubmit={async event => { event.preventDefault(); setError(''); setBusy(true); try { const result = await pddApi.updateContact(registration.registrationCode, registration.revision, checkedContact(contact), capability); setRegistration(result); setContact(result.contact || { kind: 'wechat', value: '' }); setNotice('联系方式已更新。'); } catch (exception) { setError(errorMessage(exception)); } finally { setBusy(false); } }}><h2>修改联系方式</h2><ContactFields contact={contact} onChange={setContact} disabled={busy} /><button className="pdd-button pdd-primary" disabled={busy}>保存修改</button></form>}<div className="pdd-actions"><button className="pdd-button pdd-secondary" onClick={() => void copy(privateWaybillUrl(registration.registrationCode, capability)).then(() => setNotice('私密管理链接已复制，请勿分享到群里。')).catch(exception => setNotice(errorMessage(exception)))}><Copy size={17} />保存私密管理链接</button><Link to={'/p/' + registration.record.code} className="pdd-button pdd-secondary">公开分享页</Link>{registration.visibility === 'active' && <button className="pdd-button pdd-danger" disabled={busy} onClick={async () => { if (!window.confirm('撤回后，这条登记不再参与找货。确定撤回吗？')) return; setBusy(true); setError(''); try { const result = await pddApi.withdraw(registration.registrationCode, registration.revision, capability); setRegistration(result); setNotice('您的登记已撤回。感谢您的参与。'); } catch (exception) { setError(errorMessage(exception)); } finally { setBusy(false); } }}>撤回我的登记</button>}</div>{notice && <p className="pdd-notice" role="status">{notice}</p>}</>}</div>;
}

type RecoveryEntry = { requested: boolean; invalid: boolean };
type AdminAuthSnapshot = { session: Session | null; loading: boolean; recovery: 'none' | 'pending' | 'ready' | 'expired' | 'complete'; authIssue: boolean };
type AuthObserverClient = {
  getSession: () => Promise<{ data: { session: Session | null }; error: unknown }>;
  onAuthStateChange: (callback: (event: AuthChangeEvent, session: Session | null) => void) => { data: { subscription: { unsubscribe: () => void } } };
};
export function passwordRecoveryEntry(hash: string): RecoveryEntry {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const invalid = params.has('error') || params.has('error_code');
  return { requested: params.get('type') === 'recovery' || invalid, invalid };
}
export function needsPasswordRecovery(snapshot: Pick<AdminAuthSnapshot, 'recovery'>) { return ['pending', 'ready', 'expired'].includes(snapshot.recovery); }
export function newPasswordError(password: string, confirmation: string) {
  if ([...password].length < 12 || !password.trim()) return '请设置至少12个字符的新密码。';
  if (password !== confirmation) return '两次输入的密码不一致，请核对后再保存。';
  return '';
}
// Preserve only link intent before the SDK consumes/removes the token fragment.
export const initialPasswordRecovery = passwordRecoveryEntry(typeof window === 'undefined' ? '' : window.location.hash);

export function createAdminAuthObserver(client: AuthObserverClient | null, entry: RecoveryEntry = { requested: false, invalid: false }) {
  let active = true, generation = 0, authEventObserved = false, recoveryRequested = entry.requested, recoveryUserId: string | null = null;
  let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  let state: AdminAuthSnapshot = { session: null, loading: !!client && !entry.invalid, recovery: entry.requested ? entry.invalid || !client ? 'expired' : 'pending' : 'none', authIssue: false };
  const listeners = new Set<() => void>();
  const usable = (session: Session | null) => !!session?.access_token && !!session.user?.id && (session.expires_at === undefined || session.expires_at > Date.now() / 1000);
  const update = (next: AdminAuthSnapshot) => { if (!active) return; state = next; listeners.forEach(listener => listener()); };
  const confirmSession = async () => {
    if (!client || !active) return;
    const request = ++generation;
    try {
      const result = await client.getSession();
      if (!active || request !== generation) return;
      const session = !result.error && usable(result.data.session) ? result.data.session : null;
      update({ session, loading: false, authIssue: !!result.error, recovery: recoveryRequested ? session && recoveryUserId === session.user.id ? 'ready' : 'expired' : state.recovery === 'complete' ? 'complete' : 'none' });
    } catch {
      if (active && request === generation) update({ session: null, loading: false, recovery: recoveryRequested ? 'expired' : 'none', authIssue: true });
    }
  };
  // Register immediately after client creation, before any React mount/getter.
  const subscription = client?.onAuthStateChange((event, value) => {
    if (!active) return;
    // SDK initialization/getter notifications can finish after a newer event.
    if (event === 'INITIAL_SESSION' && authEventObserved) return;
    if (event !== 'INITIAL_SESSION') { authEventObserved = true; generation++; }
    const session = usable(value) ? value : null;
    if (event === 'PASSWORD_RECOVERY') {
      recoveryRequested = true; recoveryUserId = session?.user.id || null;
      update({ session, loading: !!session, recovery: session ? 'pending' : 'expired', authIssue: false });
      if (confirmationTimer) clearTimeout(confirmationTimer);
      // Do not call/await SDK methods inside its auth-state callback/lock.
      if (session) confirmationTimer = setTimeout(() => { confirmationTimer = null; void confirmSession(); }, 0);
    } else if (event === 'SIGNED_OUT') {
      if (confirmationTimer) clearTimeout(confirmationTimer);
      recoveryUserId = null;
      update({ session: null, loading: false, recovery: recoveryRequested ? 'expired' : 'none', authIssue: false });
    } else if (recoveryRequested && recoveryUserId && session?.user.id !== recoveryUserId) {
      generation++; recoveryUserId = null;
      update({ session, loading: false, recovery: 'expired', authIssue: false });
    } else {
      // A stored session or normal SIGNED_IN event does not prove recovery.
      const unconfirmed = recoveryRequested && !recoveryUserId;
      update({ ...state, session, loading: event === 'INITIAL_SESSION' ? state.loading : unconfirmed ? false : state.loading && state.recovery === 'pending', recovery: unconfirmed && event !== 'INITIAL_SESSION' ? 'expired' : state.recovery, authIssue: false });
      if (event !== 'INITIAL_SESSION' && recoveryUserId && state.recovery === 'pending') {
        if (confirmationTimer) clearTimeout(confirmationTimer);
        confirmationTimer = setTimeout(() => { confirmationTimer = null; void confirmSession(); }, 0);
      }
    }
  }).data.subscription;
  if (client) void confirmSession();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    canSetPassword: (session: Session | null) => state.recovery === 'ready' && usable(session) && session?.user.id === recoveryUserId && state.session?.user.id === recoveryUserId,
    expireRecovery: () => { generation++; if (confirmationTimer) clearTimeout(confirmationTimer); recoveryRequested = true; recoveryUserId = null; update({ ...state, loading: false, recovery: 'expired' }); },
    dismissRecovery: () => { generation++; if (confirmationTimer) clearTimeout(confirmationTimer); recoveryRequested = false; recoveryUserId = null; update({ ...state, session: null, loading: false, recovery: 'none' }); },
    completeRecovery: (session: Session) => {
      if (state.recovery !== 'ready' || !usable(session) || session.user.id !== recoveryUserId) throw new Error('密码设置会话已失效，请重新申请设置邮件。');
      generation++; recoveryRequested = false; recoveryUserId = null;
      update({ session, loading: false, recovery: 'complete', authIssue: false });
    },
    dispose: () => { active = false; generation++; if (confirmationTimer) clearTimeout(confirmationTimer); subscription?.unsubscribe(); listeners.clear(); },
  };
}
export async function saveRecoveryPassword(client: Pick<AuthObserverClient, 'getSession'> & { updateUser: (attributes: { password: string }) => Promise<{ error: { status?: number; code?: string } | null }> }, observer: ReturnType<typeof createAdminAuthObserver>, password: string, confirmation: string) {
  const validation = newPasswordError(password, confirmation);
  if (validation) throw new Error(validation);
  let current: Awaited<ReturnType<AuthObserverClient['getSession']>>;
  try { current = await client.getSession(); } catch { throw new Error('会话验证没有完成，请检查网络后重试。'); }
  if (current.error || !observer.canSetPassword(current.data.session)) { observer.expireRecovery(); throw new Error('密码设置链接已失效，请重新申请设置邮件。'); }
  let result: { error: { status?: number; code?: string } | null };
  try { result = await client.updateUser({ password }); } catch { throw new Error('密码保存结果未确认。请用新密码尝试登录，或重新申请设置邮件。'); }
  if (result.error) {
    if (result.error.status === 401 || result.error.status === 403 || ['bad_jwt', 'session_not_found', 'session_expired'].includes(result.error.code || '')) { observer.expireRecovery(); throw new Error('密码设置会话已失效，请重新申请设置邮件。'); }
    throw new Error(result.error.code === 'weak_password' ? '这个密码不符合安全要求，请换一个更长的密码。' : result.error.code === 'same_password' ? '请设置一个与旧密码不同的新密码。' : '密码没有保存成功，请稍后重试。');
  }
  observer.completeRecovery(current.data.session!);
}
const auth = (() => { const url = import.meta.env.VITE_SUPABASE_URL, key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY; if (!url || !key) return null; try { return createClient(url, key); } catch { return null; } })();
const adminAuth = createAdminAuthObserver(auth?.auth || null, initialPasswordRecovery);
function AdminPage() {
  const authState = useSyncExternalStore(adminAuth.subscribe, adminAuth.getSnapshot, adminAuth.getSnapshot), { session, loading: authLoading } = authState;
  const navigate = useNavigate();
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [newPassword, setNewPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [authAction, setAuthAction] = useState<'login' | 'email' | 'password' | null>(null), [tab, setTab] = useState<'waybills' | 'queries' | 'community' | 'feedback'>('waybills'), [offset, setOffset] = useState(0), [list, setList] = useState<PddAdminList | PddQueryLogPage | null>(null), [detail, setDetail] = useState<PddAdminDetail | null>(null), [community, setCommunity] = useState<Community | null>(null), [notes, setNotes] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(authState.recovery === 'complete' ? '密码设置成功，已进入管理员工作台。' : '');
  const sequence = useRef(0), emailInput = useRef<HTMLInputElement>(null), authBusy = useRef(false);
  useEffect(() => { if (authState.recovery === 'expired') { setNewPassword(''); setConfirmation(''); } }, [authState.recovery]);
  const reload = useCallback(async () => { if (!session || authLoading || needsPasswordRecovery(authState)) return; const current = ++sequence.current; setError(''); if (tab === 'feedback') { setBusy(false); return; } setBusy(true); try { if (tab === 'community') { const value = await pddApi.adminCommunity(session.access_token); if (current === sequence.current) setCommunity(value); } else { const value = tab === 'waybills' ? await pddApi.adminList(session.access_token, offset) : await pddApi.adminQueries(session.access_token, offset); if (current === sequence.current) setList(value); } } catch (exception) { if (current === sequence.current) setError(errorMessage(exception)); } finally { if (current === sequence.current) setBusy(false); } }, [session, authLoading, authState.recovery, tab, offset]);
  useEffect(() => { void reload(); }, [reload]);
  const action = async (actionName: PddAdminAction, registrationCode?: string) => { if (!session || !detail) return; if (actionName === 'return' && !window.confirm('仅在包裹已实际交还后确认。确定已完成交还吗？')) return; if (actionName === 'withdraw' && !window.confirm('确定撤回这条登记吗？此操作将被审计。')) return; setBusy(true); setError(''); try { await pddApi.adminAction(session.access_token, detail.record.code, detail.record.revision, actionName, notes, registrationCode); setDetail(await pddApi.adminDetail(session.access_token, detail.record.code)); setNotes(''); setNotice('管理员操作已保存并记录审计。'); await reload(); } catch (exception) { setError(errorMessage(exception)); } finally { setBusy(false); } };
  if (authState.recovery === 'pending') return <div className="pdd-page pdd-auth"><span className="pdd-eyebrow">CMI 管理员</span><h1>验证密码设置链接</h1><Busy>正在验证邮件中的安全链接…</Busy><p>验证完成后即可设置密码。</p></div>;
  if (authState.recovery === 'expired') return <div className="pdd-page pdd-auth"><span className="pdd-eyebrow">CMI 管理员</span><h1>密码设置链接已失效</h1><section className="pdd-panel pdd-recovery-invalid"><p>链接可能已经使用、过期，或没有有效的密码设置会话。请重新申请设置邮件，并使用最新邮件中的链接。</p><ErrorNote>{!auth ? '管理员认证服务尚未配置。' : ''}</ErrorNote><button className="pdd-button pdd-primary pdd-full" onClick={() => { adminAuth.dismissRecovery(); setError(''); setNotice('请填写管理员邮箱，然后点击“设置或重置密码”。'); navigate('/admin', { replace: true }); }}>重新申请密码设置邮件</button></section></div>;
  if (authState.recovery === 'ready' && session) return <div className="pdd-page pdd-auth"><span className="pdd-eyebrow">CMI 管理员</span><h1>设置管理员密码</h1><p>邮件链接已验证。请为自己的管理员账号设置密码。</p><form className="pdd-panel pdd-password-form" onSubmit={async event => {
    event.preventDefault(); if (!auth || authBusy.current) return;
    const validation = newPasswordError(newPassword, confirmation);
    if (validation) { setError(validation); return; }
    authBusy.current = true; setBusy(true); setAuthAction('password'); setError('');
    try { await saveRecoveryPassword(auth.auth, adminAuth, newPassword, confirmation); setNotice('密码设置成功，已进入管理员工作台。'); navigate('/admin', { replace: true }); }
    catch (exception) { setError(errorMessage(exception)); }
    finally { setNewPassword(''); setConfirmation(''); setPassword(''); authBusy.current = false; setBusy(false); setAuthAction(null); }
  }}><p className="pdd-auth-account">当前账号<strong>{session.user.email || '已验证的管理员账号'}</strong></p><label>新密码<input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} autoComplete="new-password" minLength={12} aria-describedby="pdd-password-help" disabled={busy} required /></label><label>再次输入新密码<input type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" minLength={12} disabled={busy} required /></label><p id="pdd-password-help" className="pdd-auth-help">至少12个字符。请使用只由您保管的密码。</p><ErrorNote>{error}</ErrorNote><button className="pdd-button pdd-primary pdd-full" disabled={busy || !auth}>{authAction === 'password' ? '正在保存密码…' : '保存密码并进入工作台'}</button></form></div>;
  if (authLoading) return <div className="pdd-page"><Busy>正在验证管理员会话…</Busy></div>;
  if (!session) return <div className="pdd-page pdd-auth"><Back /><span className="pdd-eyebrow">CMI 管理员</span><h1>工作台登录</h1><p>公众无需注册。此入口仅供授权管理员。</p><form className="pdd-panel" onSubmit={async event => {
    event.preventDefault(); if (!auth || authBusy.current) return;
    authBusy.current = true; setBusy(true); setAuthAction('login'); setError(''); setNotice('');
    try { const result = await auth.auth.signInWithPassword({ email: email.trim(), password }); if (result.error) throw result.error; setPassword(''); }
    catch { setError('登录未完成，请核对邮箱和密码，或通过邮件设置密码。'); }
    finally { authBusy.current = false; setBusy(false); setAuthAction(null); }
  }}><label>邮箱<input ref={emailInput} type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" disabled={busy} required /></label><label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" disabled={busy} required /></label><ErrorNote>{error || (!auth ? '管理员认证服务尚未配置。' : authState.authIssue ? '管理员会话读取失败，请检查网络后重新登录。' : '')}</ErrorNote>{notice && <p className="pdd-notice" role="status">{notice}</p>}<button className="pdd-button pdd-primary pdd-full" disabled={busy || !auth}>{authAction === 'login' ? '正在登录…' : '登录工作台'}</button><div className="pdd-auth-reset"><p>第一次使用或忘记密码？填写邮箱后，通过邮件设置密码。</p><button type="button" className="pdd-button pdd-secondary pdd-full" disabled={busy || !auth} onClick={async () => {
    if (!auth || authBusy.current || !emailInput.current?.reportValidity()) return;
    authBusy.current = true; setBusy(true); setAuthAction('email'); setError(''); setNotice('');
    try { const result = await auth.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin + '/admin' }); if (result.error) throw result.error; setPassword(''); setNotice('如果这个邮箱可用于登录，我们会发送密码设置邮件。请检查收件箱和垃圾邮件，并打开最新邮件中的链接。'); }
    catch { setError('密码设置邮件申请没有完成，请检查网络后稍后重试。'); }
    finally { authBusy.current = false; setBusy(false); setAuthAction(null); }
  }}>{authAction === 'email' ? '正在申请设置邮件…' : '设置或重置密码'}</button></div></form></div>;
  return <div className="pdd-page pdd-admin"><div className="pdd-admin-header"><div><span className="pdd-eyebrow">PDD404 · OPERATIONS</span><h1>管理员工作台</h1><p className="pdd-small">{session.user.email}</p></div><button className="pdd-button pdd-secondary" onClick={() => void auth?.auth.signOut().catch(exception => setError(errorMessage(exception)))}>退出登录</button></div><nav className="pdd-admin-tabs" aria-label="工作台模块">{([['waybills', '单号与跟进'], ['queries', '查询日志'], ['community', '社区入口'], ['feedback', '建议与反馈']] as const).map(([value, label]) => <button key={value} className={tab === value ? 'selected' : ''} onClick={() => { setTab(value); setOffset(0); setList(null); setDetail(null); setNotes(''); setNotice(''); }} disabled={busy}>{label}</button>)}{tab !== 'feedback' && <button className="pdd-text-link" onClick={() => void reload()} disabled={busy}><RefreshCw size={16} />刷新</button>}</nav><ErrorNote>{error}</ErrorNote>{notice && <p className="pdd-notice" role="status">{notice}</p>}{busy && <Busy>正在读取或保存…</Busy>}{tab === 'feedback' ? <AdminFeedbackPanel token={session.access_token} /> : tab === 'community' && community ? <AdminCommunity community={community} token={session.access_token} onSaved={reload} /> : <div className="pdd-admin-columns"><div><div className="pdd-admin-list">{list?.items.map((item, index) => 'number' in item && 'resolution' in item ? <article key={item.code}><div><code>{item.number}</code><span className="pdd-status">{resolutionLabel[item.resolution]}</span></div><p className="pdd-small">丢件：{item.lostContact?.value || '未登记'} · 错收件：{item.receivedContact?.value || '未登记'}</p><p className="pdd-small">查询 {item.queryCount} 次 · {dateText(item.updatedAt)}</p><button className="pdd-text-link" onClick={() => void pddApi.adminDetail(session.access_token, item.code).then(value => { setDetail(value); setNotes(''); }).catch(exception => setError(errorMessage(exception)))}>查看全部记录与处理状态<ArrowRight size={16} /></button></article> : 'queryId' in item ? <article key={item.queryId || index}><div><code>{item.number}</code><span className="pdd-status">{modeLabel[item.mode]}</span></div><p>{resultLabel[item.result]} · {item.source === 'barcode' ? '扫码' : '手动输入'}</p><p className="pdd-small">{dateText(item.queriedAt)}</p>{item.contact && <p>{contactLabel(item.contact)}：{item.contact.value}</p>}{item.code && <button className="pdd-text-link" onClick={() => void pddApi.adminDetail(session.access_token, item.code!).then(setDetail).catch(exception => setError(errorMessage(exception)))}>查看这个单号的处理记录<ArrowRight size={16} /></button>}</article> : null)}</div>{!busy && list?.items.length === 0 && <div className="pdd-empty">目前没有记录。</div>}<div className="pdd-pagination"><button className="pdd-button pdd-secondary" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><span>第 {Math.floor(offset / 50) + 1} 页</span><button className="pdd-button pdd-secondary" disabled={busy || list?.nextOffset == null} onClick={() => setOffset(list!.nextOffset!)}>下一页</button></div></div>{detail && <section className="pdd-panel pdd-admin-detail"><button className="pdd-icon pdd-close" onClick={() => setDetail(null)} aria-label="关闭单号详情"><X /></button><span className="pdd-eyebrow">{detail.record.code}</span><h2>{detail.record.number}</h2><p>{resolutionLabel[detail.record.resolution]} · 版本 {detail.record.revision}</p><h3>双方登记</h3>{detail.registrations.map(item => <article className="pdd-admin-registration" key={item.registrationCode}><strong>{modeLabel[item.mode]} · {item.visibility === 'withdrawn' ? '已撤回' : '有效'}</strong><p>{item.contact ? contactLabel(item.contact) + '：' + item.contact.value : '联系方式已按保留期清理'}</p><WaybillNote note={item.note} label="登记备注" /><small>{dateText(item.createdAt)}</small>{item.visibility === 'active' && <button className="pdd-text-link pdd-danger" disabled={busy} onClick={() => void action('withdraw', item.registrationCode)}>撤回此登记</button>}</article>)}<label>跟进备注<textarea maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} placeholder="记录核实、联系或交还进展" /></label><div className="pdd-actions"><button className="pdd-button pdd-secondary" disabled={busy || detail.record.resolution !== 'open'} onClick={() => void action('verify')}>开始核实</button><button className="pdd-button pdd-secondary" disabled={busy || !['open', 'verifying'].includes(detail.record.resolution)} onClick={() => void action('claim')}>确认归属，待交还</button><button className="pdd-button pdd-primary" disabled={busy || detail.record.resolution !== 'claimed'} onClick={() => void action('return')}>确认实际交还</button></div><h3>查询时间线</h3>{detail.queries.map(query => <div className="pdd-timeline-item" key={query.queryId}><strong>{modeLabel[query.mode]} · {resultLabel[query.result]}</strong><p>{dateText(query.queriedAt)}</p>{query.contact && <p>{contactLabel(query.contact)}：{query.contact.value}</p>}</div>)}<h3>管理操作记录</h3>{detail.events.map(item => <div className="pdd-timeline-item" key={item.id}><strong>{item.action}</strong><p>{item.notes}</p><small>{dateText(item.createdAt)}</small></div>)}</section>}</div>}</div>;
}

function AdminCommunity({ community, token, onSaved }: { community: Community; token: string; onSaved: () => Promise<void> }) {
  const { reloadCommunity } = useContext(PddContext), [form, setForm] = useState(community), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => { setForm(community); }, [community]);
  const fields = [['groupQrUrl', '找货群二维码图片 URL'], ['assistantWechat', 'CMI 小助手微信号'], ['assistantQrUrl', '小助手二维码图片 URL'], ['officialAccountName', '公众号名称'], ['officialAccountQrUrl', '公众号二维码图片 URL']] as const;
  return <form className="pdd-panel pdd-community-settings" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await pddApi.updateCommunity(token, form); await onSaved(); reloadCommunity(); setNotice('社区入口已保存并记录审计。'); } catch (exception) { setError(errorMessage(exception)); } finally { setBusy(false); } }}><h2>真实社区入口</h2><p>二维码到期后及时更换。未配置的入口会在网站明确显示。</p>{fields.map(([key, label]) => <label key={key}>{label}<input type={key.endsWith('Url') ? 'url' : 'text'} value={form[key] || ''} onChange={event => setForm({ ...form, [key]: event.target.value || null })} disabled={busy} /></label>)}<label className="pdd-checkbox"><input type="checkbox" checked={form.submissionsEnabled} onChange={event => setForm({ ...form, submissionsEnabled: event.target.checked })} disabled={busy} />开放正式登记</label><ErrorNote>{error}</ErrorNote>{notice && <p className="pdd-notice" role="status">{notice}</p>}<button className="pdd-button pdd-primary" disabled={busy}>保存社区设置</button></form>;
}

function PrivacyPage() { return <div className="pdd-page pdd-privacy"><Back /><span className="pdd-eyebrow">PDD404 · CMI COMMUNITY</span><h1>隐私与使用说明</h1><section className="pdd-panel"><h2>不用注册，凭单号找货</h2><p>请填写完整的国内运输单号，不要填写订单编号、集运单号或末端配送单号。相同完整单号的登记会提供联系线索。看不清的字符可用 ? 或 * 代替一位；至少保留6位已知字符。疑似线索只显示记录编号、尾号、字符相似度和登记时间，不提供对方联系方式或备注；请截图联系 CMI 小助手核实。登记仍需要完整单号，包裹归属与实际交还由双方核实。</p><h2>联系方式用于配对联系</h2><p>登记时填写的本人微信号、电话号码和选填备注保存在本项目服务器。查询到相同完整单号的另一方可查看，用于联系、核实和交还；公开分享页不展示联系方式、备注和完整单号。管理员可查看登记与查询处理记录。</p><h2>查询留下日志，待提交列表先存本机</h2><p>每次点击查询，服务器记录单号、查询类型、来源、查询日期时间和结果。暂未匹配的单号保存在当前浏览器，填写联系方式并确认提交后才成为正式登记。</p><p>查询日志保留30天；正式联系方式和备注在登记有效期间保留，包裹交还或登记撤回30天后清理。匹配弹窗内的可选联系方式可在查询后24小时内补充。</p><h2>建议与反馈仅供管理员查看</h2><p>反馈内容与选填联系方式只用于管理员查看、跟进和回复，不会出现在公开页面，也不参与包裹匹配。反馈关闭30天后清理。</p><h2>扫码画面不上传</h2><p>扫码需要摄像头权限。可拍下当前画面识别，也可选择实时扫码；条形码在当前设备上读取，网站不上传或保存画面。识别后只填入号码，您核对后手动点击查询。</p><h2>保存好私密管理链接</h2><p>本机回执与管理凭证保存在当前浏览器。私密管理链接可修改联系方式、查看进展或撤回本人登记。请勿发到群里。换设备或清理浏览器不会自动恢复凭证，丢失时请联系 CMI 小助手。</p><h2>社区共同跟进</h2><p>这是 CMI Community 的公益项目，不收取登记费用。页面提供匹配线索，管理员可协助跟进，不承诺自动发送微信消息。请保存重要回执截图。</p></section><CommunityCodes /></div>; }
function MissingPage() { return <div className="pdd-page"><h1>这个页面不存在</h1><p>请检查链接，或返回首页继续查询单号。</p><Back /></div>; }
export default function PddApp() {
  const authState = useSyncExternalStore(adminAuth.subscribe, adminAuth.getSnapshot, adminAuth.getSnapshot);
  return <PddProvider><a className="pdd-skip" href="#pdd-main">跳到内容</a><header className="pdd-header"><Link to="/" className="pdd-brand" aria-label="PDD404 首页">pdd<span>404</span><small>包裹寻回计划</small></Link><Link to="/help" className="pdd-header-community" aria-label="帮助 Help">帮助 Help<ArrowRight size={16} /></Link></header><main id="pdd-main">{needsPasswordRecovery(authState) ? <AdminPage /> : <Routes><Route path="/" element={<Home />} /><Route path="/local" element={<LocalPage />} /><Route path="/p/:code" element={<PublicPage />} /><Route path="/p/:code/share" element={<PublicPage share />} /><Route path="/m/:code" element={<ManagePage />} /><Route path="/manage/:code" element={<ManagePage />} /><Route path="/admin" element={<AdminPage />} /><Route path="/admin/login" element={<AdminPage />} /><Route path="/help" element={<HelpPage />} /><Route path="/community" element={<HelpPage />} /><Route path="/privacy" element={<PrivacyPage />} /><Route path="/received/*" element={<Navigate to="/?mode=received" replace />} /><Route path="/search/*" element={<Navigate to="/" replace />} /><Route path="/queue" element={<Navigate to="/local" replace />} /><Route path="/success" element={<Navigate to="/local" replace />} /><Route path="*" element={<MissingPage />} /></Routes>}</main><Footer /></PddProvider>;
}
