import { useEffect, useRef, useState } from 'react';
import { API_BASE } from './api';
import { preparePublication, preparePublicFile, readPublicationStatus, submitPublication, submitPublicAsset, type ReviewedAsset, type ReviewedPublication } from './public-content-admin-api';
import type { PublicationStatus } from '../shared/public-content';
import './public-content-admin.css';

export default function PddPublicContentAdmin({ token }: { token: string }) {
  const [review, setReview] = useState<ReviewedPublication | null>(null), [asset, setAsset] = useState<ReviewedAsset | null>(null);
  const [status, setStatus] = useState<PublicationStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [contentSha, setContentSha] = useState(''), [assetSha, setAssetSha] = useState(''), [previewUrl, setPreviewUrl] = useState('');
  const [receipt, setReceipt] = useState<{ url: string; sha256: string; bytes: number } | null>(null);
  const [assetAttempted, setAssetAttempted] = useState(false);
  const generation = useRef(0), locked = useRef(false), inputs = useRef<HTMLDivElement>(null);
  useEffect(() => { generation.current++; locked.current = false; setReview(null); setAsset(null); setStatus(null); setReceipt(null); setAssetAttempted(false); setBusy(false); setError(''); setNotice(''); setContentSha(''); setAssetSha(''); inputs.current?.querySelectorAll('input[type=file]').forEach(input => { (input as HTMLInputElement).value = ''; }); return () => { generation.current++; }; }, [token]);
  useEffect(() => {
    if (!asset || asset.mime === 'application/zip') { setPreviewUrl(''); return; }
    const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime })); setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [asset]);
  async function run(operation: (isCurrent: () => boolean) => Promise<void>) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(''); setNotice(''); const current = ++generation.current;
    try { await operation(() => generation.current === current); }
    catch (exception) { if (generation.current === current) setError(exception instanceof Error ? exception.message : '操作未完成，请重新核对。'); }
    finally { if (generation.current === current) { locked.current = false; setBusy(false); } }
  }
  const options = { apiBase: API_BASE, token };
  return <div ref={inputs} className="pdd-public-content-admin">
    <h2>公开内容与项目群</h2><p>传播目录和开发者群独立更新。先在聊天审核具体公开副本及SHA，再提交；不会更改首页找货群。</p>
    {error && <p className="pdd-error" role="alert">{error}</p>}{notice && <p className="pdd-notice" role="status">{notice}</p>}
    <section className="pdd-panel"><h3>上传已审核素材</h3><p className="pdd-small">使用已去除隐藏元数据的PNG、JPEG、WebP，或整包审核的ZIP，最大5MiB。按SHA保存，不能覆盖已有文件。</p>
      <label>公开素材文件<input type="file" accept="image/png,image/jpeg,image/webp,application/zip" disabled={busy} onChange={event => { const file = event.target.files?.[0]; setAsset(null); setReceipt(null); setAssetSha(''); setAssetAttempted(false); if (file) void run(async isCurrent => { const value = await preparePublicFile(file); if (isCurrent()) setAsset(value); }); }} /></label>
      {asset && <><p className="pdd-small">{asset.bytes.length.toLocaleString()} 字节 · {asset.mime}</p>{previewUrl && <img className="pdd-public-asset-preview" src={previewUrl} alt="待审核公开素材预览" />}<label>素材SHA<textarea aria-label="素材SHA" readOnly rows={2} value={asset.sha} /></label><label>已在聊天审核的素材SHA<input value={assetSha} onChange={event => setAssetSha(event.target.value.trim())} disabled={busy} autoComplete="off" spellCheck={false} /></label>
        <button type="button" className="pdd-button pdd-primary" disabled={busy || assetAttempted || assetSha !== asset.sha} onClick={() => void run(async isCurrent => { setAssetAttempted(true); const value = await submitPublicAsset(asset, assetSha, options); if (isCurrent()) { setReceipt(value); setNotice('素材已上传；群配置或目录仍需单独发表。'); } })}>{busy ? '正在处理…' : '上传已审核公开副本'}</button></>}
      {receipt && <label>已上传素材地址<textarea aria-label="已上传素材地址" readOnly rows={3} value={receipt.url} /></label>}
    </section>
    <section className="pdd-panel"><h3>发表公开配置</h3><p className="pdd-small">JSON须包含类型、目标、动作、预期修订和完整正文。修改内容、撤回或修订冲突后须重新审核。</p>
      <label>已准备的公开内容JSON<input type="file" accept="application/json,.json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; setReview(null); setStatus(null); setContentSha(''); if (file) void run(async isCurrent => { if (file.size > 32768) throw new Error('内容文件不能超过32KiB。'); let raw: unknown; try { raw = JSON.parse(await file.text()); } catch { throw new Error('内容JSON格式无效。'); } const value = await preparePublication(raw, API_BASE); if (isCurrent()) setReview(value); }); }} /></label>
      {review && <><label>完整公开内容预览<textarea aria-label="完整公开内容预览" readOnly rows={12} value={JSON.stringify(JSON.parse(review.canonical), null, 2)} /></label><label>内容SHA<textarea aria-label="内容SHA" readOnly rows={2} value={review.sha} /></label>
        <button type="button" className="pdd-button pdd-secondary" disabled={busy} onClick={() => void run(async isCurrent => { const value = await readPublicationStatus(review.input, options); if (isCurrent()) { setStatus(value); setNotice('已读取当前修订 ' + value.revision + '。'); } })}>读取当前修订</button>
        {status && <p className="pdd-small">当前修订 {status.revision} · 本文件要求 {review.input.expectedRevision}{status.revision !== review.input.expectedRevision && '；请重新准备并审核文件。'}</p>}
        <label>已在聊天审核的内容SHA<input value={contentSha} onChange={event => setContentSha(event.target.value.trim())} disabled={busy} autoComplete="off" spellCheck={false} /></label>
        <button type="button" className="pdd-button pdd-primary" disabled={busy || !status || status.revision !== review.input.expectedRevision || contentSha !== review.sha} onClick={() => void run(async isCurrent => {
          const current = status!; setStatus(null); const result = await submitPublication(review, current, contentSha, options);
          if (isCurrent()) { setContentSha(''); setNotice((result.action === 'publish' ? '已发表' : '已撤回') + '，修订 ' + result.revision + '。管理员与审核SHA已记录。'); }
        })}>{review.input.action === 'withdraw' ? '撤回已审核版本' : '发表已审核版本'}</button></>}
    </section>
  </div>;
}
