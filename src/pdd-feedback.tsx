import { useEffect, useRef, useState, type FormEvent } from 'react';
import { validateFeedbackMessage, type PddFeedbackInput, type PddFeedbackList, type PddFeedbackStatus } from '../shared/feedback';
import { validatePddContact, type PddContact } from '../shared/waybill';
import { pddApi } from './pdd-api';
import { trackPddEvent } from './pdd-analytics';
import './pdd-feedback.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请稍后重试。';
export function feedbackInput(message: string, contact: PddContact): PddFeedbackInput {
  const text = validateFeedbackMessage(message);
  if (!contact.value.trim()) return { message: text, contact: null };
  try { return { message: text, contact: validatePddContact(contact) }; }
  catch { throw new Error(contact.kind === 'wechat' ? '请填写有效的微信号（字母开头，至少6位），或留空。' : '请填写有效的电话号码，或留空。'); }
}
export function FeedbackForm({ onSubmitted }: { onSubmitted?: () => void }) {
  const [message, setMessage] = useState(''), [contact, setContact] = useState<PddContact>({ kind: 'wechat', value: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [submitted, setSubmitted] = useState(false);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null), sending = useRef(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (sending.current) return;
    try {
      const input = feedbackInput(message, contact), fingerprint = JSON.stringify(input);
      if (!pending.current || pending.current.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
      trackPddEvent('feedback_started'); sending.current = true; setBusy(true); setError('');
      const result = await pddApi.submitFeedback(input, pending.current.key);
      if (result.submitted !== true) throw new Error('尚未收到提交确认，请重试。');
      trackPddEvent('feedback_submitted'); setSubmitted(true); onSubmitted?.();
    } catch (failure) { trackPddEvent('feedback_error'); setError(errorText(failure)); } finally { sending.current = false; setBusy(false); }
  }
  if (submitted) return <div className="pdd-feedback-success" role="status"><strong>反馈已收到，谢谢你的帮助！</strong><p>社区管理员会查看你的建议。如需跟进，会通过你留下的联系方式联系你。</p></div>;
  return <form onSubmit={submit} className="pdd-feedback-form">
    <div className="pdd-feedback-form-body">
    <p>有建议，或使用时遇到问题？告诉我们，帮助 PDD404 变得更好。</p>
    <label>建议或问题说明<textarea value={message} onChange={event => setMessage(event.target.value)} disabled={busy} required rows={3} maxLength={4000} placeholder="请说明发生了什么、你希望怎样改进。" aria-describedby="pdd-feedback-count" /></label>
    <small id="pdd-feedback-count">{Array.from(message).length} / 2000 字</small>
    <div className="pdd-feedback-contact"><label>联系方式（选填）<select value={contact.kind} onChange={event => setContact({ kind: event.target.value as PddContact['kind'], value: '' })} disabled={busy}><option value="wechat">微信号</option><option value="phone">电话号码</option></select></label>
      <label>{contact.kind === 'wechat' ? '微信号（选填）' : '电话号码（选填）'}<input value={contact.value} onChange={event => setContact({ ...contact, value: event.target.value })} type={contact.kind === 'phone' ? 'tel' : 'text'} maxLength={contact.kind === 'phone' ? 32 : 64} placeholder={contact.kind === 'wechat' ? '填写微信号，方便我们跟进' : '含国家区号，例如 +66…'} disabled={busy} autoComplete="off" /></label></div>
    <p className="pdd-feedback-hint">反馈内容与联系方式仅供社区管理员查看，不会在网站公开。</p>
    {error && <p className="pdd-error" role="alert">{error}</p>}
    </div>
    <button className="pdd-button pdd-primary" type="submit" disabled={busy}>{busy ? '正在提交…' : '提交反馈'}</button>
  </form>;
}

const statusLabel = { new: '待查看', reviewed: '已查看', closed: '已处理' };
export function AdminFeedbackPanel({ token }: { token: string }) {
  const [page, setPage] = useState<PddFeedbackList | null>(null), [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<PddFeedbackStatus | ''>(''), [loading, setLoading] = useState(false), [error, setError] = useState(''), [changing, setChanging] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => { let active = true; setLoading(true); setError('');
    void pddApi.adminFeedbackList(token, offset, filter || undefined).then(value => { if (active) setPage(value); }).catch(failure => { if (active) setError(errorText(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, offset, filter, reload]);
  async function update(id: string, status: PddFeedbackStatus) {
    if (changing) return; setChanging(id); setError('');
    try { await pddApi.adminFeedbackUpdate(id, status, token); setReload(value => value + 1); }
    catch (failure) { setError(errorText(failure)); } finally { setChanging(''); }
  }
  return <section className="pdd-admin-feedback"><h2>建议与反馈</h2>
    <div className="pdd-feedback-toolbar"><label>处理状态<select value={filter} onChange={event => { setFilter(event.target.value as PddFeedbackStatus | ''); setOffset(0); }}><option value="">全部</option>{Object.entries(statusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button onClick={() => setReload(value => value + 1)} disabled={loading}>刷新</button></div>
    {error && <p className="pdd-error" role="alert">{error}</p>}{loading && <p role="status">正在读取反馈…</p>}
    {page && !loading && <><p>共 {page.total} 条反馈</p>{page.items.length === 0 && <p>暂时没有符合条件的反馈。</p>}
      {page.items.map(item => <article className="pdd-feedback-item" key={item.id}><div className="pdd-feedback-toolbar"><strong>{statusLabel[item.status]}</strong><time>{new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Bangkok' })}（曼谷时间）</time></div><p className="pdd-feedback-message">{item.message}</p><p>{item.contact ? `${item.contact.kind === 'wechat' ? '微信号' : '电话'}：${item.contact.value}` : '未留下联系方式'}</p><div className="pdd-feedback-actions">{(['new', 'reviewed', 'closed'] as const).filter(value => value !== item.status).map(value => <button key={value} disabled={!!changing} onClick={() => void update(item.id, value)}>{changing === item.id ? '正在保存…' : '标记' + statusLabel[value]}</button>)}</div></article>)}
      <div className="pdd-feedback-actions"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</button><button disabled={page.nextOffset === null} onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}>下一页</button></div></>}
  </section>;
}
