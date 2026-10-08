// Prepare the metadata-free image in memory and display its immutable identity.
// Only explicit approval of this exact public-copy hash authorizes an upload.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { approvedPublicAsset, PUBLIC_ASSET_LIMIT } from '../supabase/functions/_shared/public-assets-api.ts';
import { independentPublicBase } from './publications.mjs';

export async function publicAssetPreview(file, publicBaseUrl) {
  const info = await stat(file);
  if (!info.isFile() || info.size > PUBLIC_ASSET_LIMIT) throw new Error('Public asset must be a file no larger than 5MiB.');
  const original = new Uint8Array(await readFile(file)), image = await approvedPublicAsset(original, path.extname(file).toLowerCase() === '.zip' ? 'application/zip' : undefined);
  const base = publicBaseUrl ? independentPublicBase(publicBaseUrl) : null;
  return { image, summary: { sha256: image.sha256, key: image.key, mime: image.mime, bytes: image.bytes.length, metadataRemoved: original.length !== image.bytes.length, url: base ? `${base}/storage/v1/object/public/pdd-public-assets/${image.key}` : null } };
}
export async function uploadReviewedAsset(preview, options) {
  const base = independentPublicBase(options.publicBaseUrl);
  if (!/^[0-9a-f]{64}$/.test(options.approvedSha ?? '') || options.approvedSha !== preview.image.sha256) throw new Error('Approved public asset SHA does not match the prepared bytes.');
  if (typeof options.jwt !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(options.jwt)) throw new Error('PDD_ADMIN_JWT is required for an approved upload.');
  let response;
  try { response = await (options.fetch ?? fetch)(`${base}/functions/v1/api/v1/admin/public-assets`, { method: 'POST', headers: { Authorization: `Bearer ${options.jwt}`, 'Content-Type': preview.image.mime, 'x-content-sha256': preview.image.sha256 }, body: preview.image.bytes, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error('Upload outcome is unknown. Recheck the immutable object before another approved attempt; no automatic retry was made.'); }
  if (!response.ok) throw new Error(`Public asset upload failed (HTTP ${response.status}); no automatic retry or overwrite was made.`);
  let receipt; try { receipt = (await response.json()).data; } catch { throw new Error('Public asset receipt is unreadable; recheck before retrying.'); }
  const url = `${base}/storage/v1/object/public/pdd-public-assets/${preview.image.key}`;
  if (!receipt || receipt.url !== url || receipt.sha256 !== preview.image.sha256 || receipt.key !== preview.image.key || receipt.mime !== preview.image.mime || receipt.bytes !== preview.image.bytes.length) throw new Error('Public asset receipt differs from the reviewed copy.');
  return { url, sha256: receipt.sha256, key: receipt.key, mime: receipt.mime, bytes: receipt.bytes };
}
export async function publicAssetCli(args = process.argv.slice(2)) {
  let upload = false, approvedSha, publicBaseUrl; const files = [];
  for (const argument of args) {
    if (argument === '--upload' && !upload) upload = true;
    else if (argument.startsWith('--approved-sha=') && approvedSha === undefined) approvedSha = argument.slice(15);
    else if (argument.startsWith('--public-base-url=') && publicBaseUrl === undefined) publicBaseUrl = argument.slice(18);
    else if (argument.startsWith('-')) throw new Error('Unknown or duplicated asset argument.'); else files.push(argument);
  }
  if (files.length !== 1 || (!upload && approvedSha !== undefined)) throw new Error('Usage: node --experimental-transform-types scripts/public-assets.mjs image.png-or-pack.zip [--upload --approved-sha=SHA]');
  const base = publicBaseUrl ?? process.env.SUPABASE_URL, preview = await publicAssetPreview(files[0], base);
  if (!upload) { console.log(JSON.stringify({ mode: 'offline-preview', ...preview.summary, instruction: 'Review the public asset and this exact byte SHA in the owning chat. No upload or publication was made.' }, null, 2)); return preview.summary; }
  const receipt = await uploadReviewedAsset(preview, { approvedSha, publicBaseUrl: base, jwt: process.env.PDD_ADMIN_JWT });
  console.log(JSON.stringify({ mode: 'uploaded', receipt }, null, 2)); return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) publicAssetCli().catch(error => { console.error(error.message); process.exitCode = 1; });
