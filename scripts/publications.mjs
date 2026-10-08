// Offline preview by default. A heartbeat must never add --publish by itself.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalPublicationArtifact, validatePublicationInput } from '../shared/public-content.ts';

export function publicationPreview(raw, publicBaseUrl) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A publication envelope is required.');
  const input = validatePublicationInput({ ...raw, approvalArtifactSha: raw.approvalArtifactSha ?? '0'.repeat(64) }, publicBaseUrl);
  const canonical = canonicalPublicationArtifact(input), hash = createHash('sha256').update(canonical).digest('hex');
  return { artifactSha: hash, canonical, input: { ...input, approvalArtifactSha: hash } };
}
export function independentPublicBase(value) {
  let url; try { url = new URL(value); } catch { throw new Error('The independent SUPABASE_URL is required for publication.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)
    || !/^[a-z]{20}\.supabase\.co$/.test(url.hostname) || url.hostname === 'osqyplgctlzdlpqmzfud.supabase.co') throw new Error('Independent product project URL required.');
  return url.origin;
}
export async function publishReviewed(raw, options) {
  const base = independentPublicBase(options.publicBaseUrl), preview = publicationPreview(raw, base);
  if (!/^[0-9a-f]{64}$/.test(options.approvedSha ?? '') || options.approvedSha !== preview.artifactSha) throw new Error('Approved artifact SHA does not match this exact normalized publication.');
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 || options.expectedRevision !== preview.input.expectedRevision) throw new Error('Explicit expected revision must match the reviewed artifact.');
  if (typeof options.jwt !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(options.jwt)) throw new Error('PDD_ADMIN_JWT is required; it is sent only in Authorization.');
  let response;
  try {
    response = await (options.fetch ?? fetch)(`${base}/functions/v1/api/v1/admin/publications`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.jwt}` }, body: JSON.stringify(preview.input), signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error('Publication outcome is unknown. Recheck the current revision before another approved attempt; no automatic retry was made.'); }
  if (!response.ok) throw new Error(`Publication failed (HTTP ${response.status}). Recheck the current revision; no automatic retry was made.`);
  let result; try { result = (await response.json()).data; } catch { throw new Error('Publication receipt is unreadable. Recheck before retrying.'); }
  if (!result || result.kind !== preview.input.kind || result.key !== preview.input.key || result.action !== preview.input.action || result.revision !== preview.input.expectedRevision + 1 || result.approvalArtifactSha !== preview.artifactSha || typeof result.publishedAt !== 'string') throw new Error('Publication receipt differs from the approved artifact. Recheck before retrying.');
  return { kind: result.kind, key: result.key, revision: result.revision, action: result.action, publishedAt: result.publishedAt, approvalArtifactSha: result.approvalArtifactSha };
}
export async function publicationStatus(options) {
  const base = independentPublicBase(options.publicBaseUrl);
  const checked = validatePublicationInput({ kind: options.kind, key: options.key, action: 'withdraw', expectedRevision: 0, content: null, approvalArtifactSha: '0'.repeat(64) });
  if (typeof options.jwt !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(options.jwt)) throw new Error('PDD_ADMIN_JWT is required for the read-only revision check.');
  let response;
  try { response = await (options.fetch ?? fetch)(`${base}/functions/v1/api/v1/admin/publications?kind=${checked.kind}&key=${encodeURIComponent(checked.key)}`, { headers: { Authorization: `Bearer ${options.jwt}` }, signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('Current publication revision is unknown; do not publish or retry from an assumed revision.'); }
  if (!response.ok) throw new Error(`Revision check failed (HTTP ${response.status}); publication state remains unknown.`);
  let result; try { result = (await response.json()).data; } catch { throw new Error('Current publication revision is unreadable.'); }
  if (!result || result.kind !== checked.kind || result.key !== checked.key || !Number.isSafeInteger(result.revision) || result.revision < 0
    || (result.revision === 0 ? result.action !== null || result.publishedAt !== null || result.approvalArtifactSha !== null : !['publish','withdraw'].includes(result.action) || typeof result.publishedAt !== 'string' || !/^[0-9a-f]{64}$/.test(result.approvalArtifactSha))) throw new Error('Invalid publication revision receipt.');
  return { kind: result.kind, key: result.key, revision: result.revision, action: result.action, publishedAt: result.publishedAt, approvalArtifactSha: result.approvalArtifactSha };
}
export function publicationArguments(args) {
  const options = { publish: false, status: false }; const files = [];
  for (const argument of args) {
    if (argument === '--publish') { if (options.publish) throw new Error('Duplicate --publish.'); options.publish = true; }
    else if (argument === '--status' && !options.status) options.status = true;
    else if (argument.startsWith('--kind=') && options.kind === undefined) options.kind = argument.slice(7);
    else if (argument.startsWith('--key=') && options.key === undefined) options.key = argument.slice(6);
    else if (argument.startsWith('--approved-sha=')) { if (options.approvedSha) throw new Error('Duplicate approval SHA.'); options.approvedSha = argument.slice(15); }
    else if (argument.startsWith('--expected-revision=')) { if (options.expectedRevision !== undefined) throw new Error('Duplicate expected revision.'); const value = argument.slice(20); if (!/^\d+$/.test(value)) throw new Error('Expected revision must be a nonnegative integer.'); options.expectedRevision = Number(value); }
    else if (argument.startsWith('--public-base-url=')) { if (options.publicBaseUrl) throw new Error('Duplicate project URL.'); options.publicBaseUrl = independentPublicBase(argument.slice(18)); }
    else if (argument.startsWith('-')) throw new Error('Unknown publication argument.'); else files.push(argument);
  }
  if (options.status) {
    if (options.publish || files.length || options.kind === undefined || options.key === undefined || options.approvedSha !== undefined || options.expectedRevision !== undefined) throw new Error('Read-only --status requires --kind=K --key=KEY and cannot publish.');
    return options;
  }
  if (files.length !== 1 || options.kind !== undefined || options.key !== undefined) throw new Error('Usage: node --experimental-strip-types scripts/publications.mjs artifact.json [--publish --approved-sha=SHA --expected-revision=N]');
  if (!options.publish && (options.approvedSha !== undefined || options.expectedRevision !== undefined)) throw new Error('Approval flags are only valid with explicit --publish.');
  return { file: files[0], ...options };
}
export async function publicationCli(args = process.argv.slice(2)) {
  const options = publicationArguments(args);
  const base = options.publicBaseUrl ?? process.env.SUPABASE_URL;
  if (options.status) {
    const receipt = await publicationStatus({ ...options, publicBaseUrl: base, jwt: process.env.PDD_ADMIN_JWT });
    console.log(JSON.stringify({ mode: 'read-only-status', receipt }, null, 2)); return receipt;
  }
  const bytes = await readFile(options.file); if (bytes.length > 32_768) throw new Error('Publication artifact exceeds the API size limit.');
  let raw; try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Publication artifact is not valid JSON.'); }
  if (!options.publish) {
    const preview = publicationPreview(raw, base);
    console.log(JSON.stringify({ mode: 'offline-preview', artifactSha: preview.artifactSha, canonicalPublication: JSON.parse(preview.canonical), instruction: 'Review this exact content and SHA in the owning chat. No network request or publication was made.' }, null, 2)); return preview;
  }
  const receipt = await publishReviewed(raw, { ...options, publicBaseUrl: base, jwt: process.env.PDD_ADMIN_JWT });
  console.log(JSON.stringify({ mode: 'published', receipt }, null, 2)); return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) publicationCli().catch(error => { console.error(error.message); process.exitCode = 1; });
