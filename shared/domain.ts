import type { Extraction, FieldSource, Identifier, IdentifierType, PublicRecord, Quality, Resolution, Visibility } from './contracts.ts';

const types: IdentifierType[] = ['domestic_waybill', 'consolidation_waybill', 'last_mile_waybill', 'order_id', 'unknown_id'];
const generic = new Set(['日用品', '用品', '商品', '物品', '包裹', '其他', '快递', '生活用品', '家居', '衣服', '服装', '食品', 'unknown', 'item', 'package']);
export function normalizeIdentifier(value: string): string { return value.replace(/\s/g, '').toUpperCase(); }
const clean = (s: string) => s.trim().normalize('NFKC').toLocaleLowerCase();
const specific = (s: string) => clean(s).length >= 2 && !generic.has(clean(s));

/** Validate untrusted model output. Never infer ambiguous digits or missing fields. */
export function validateExtraction(value: unknown): Extraction {
  if (!value || typeof value !== 'object') throw new Error('INVALID_EXTRACTION');
  const v = value as Record<string, unknown>;
  const strings = (key: string, max: number) => {
    if (!Array.isArray(v[key]) || v[key].length > max || v[key].some(x => typeof x !== 'string' || x.length > 160)) throw new Error('INVALID_EXTRACTION');
    return [...new Set((v[key] as string[]).map(x => x.trim()).filter(Boolean))];
  };
  if (typeof v.validImage !== 'boolean' || !(v.recipientName === null || (typeof v.recipientName === 'string' && v.recipientName.length <= 100)) || !Array.isArray(v.identifiers) || v.identifiers.length > 12) throw new Error('INVALID_EXTRACTION');
  const identifiers = v.identifiers.map((raw: unknown, index: number): Identifier => {
    if (!raw || typeof raw !== 'object') throw new Error('INVALID_EXTRACTION');
    const r = raw as Record<string, unknown>;
    if (!types.includes(r.type as IdentifierType) || typeof r.value !== 'string' || r.value.length > 100 || !normalizeIdentifier(r.value) || !/^[A-Z0-9*?._-]+$/.test(normalizeIdentifier(r.value)) || typeof r.sourceImageId !== 'string' || r.sourceImageId.length > 100 || !(r.carrier === null || (typeof r.carrier === 'string' && r.carrier.length <= 100)) || ['complete', 'clear', 'shared'].some(k => typeof r[k] !== 'boolean')) throw new Error('INVALID_EXTRACTION');
    const id = typeof r.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(r.id) ? r.id : `identifier-${index}`;
    return { id, type: r.type as IdentifierType, value: r.value.trim(), carrier: r.carrier as string | null, complete: r.complete as boolean && !/[*?]/.test(r.value), clear: r.clear as boolean, shared: r.shared as boolean, sourceImageId: r.sourceImageId };
  });
  if (new Set(identifiers.map(x => x.id)).size !== identifiers.length) throw new Error('INVALID_EXTRACTION');
  let fieldSources: FieldSource[] | undefined;
  if (v.fieldSources !== undefined) {
    if (!Array.isArray(v.fieldSources) || v.fieldSources.length > 48) throw new Error('INVALID_EXTRACTION');
    fieldSources = v.fieldSources.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object') throw new Error('INVALID_EXTRACTION');
      const f = raw as Record<string, unknown>;
      if (!['recipientName', 'itemName', 'specification', 'tag'].includes(String(f.field)) || typeof f.value !== 'string' || f.value.length > 160 || typeof f.sourceImageId !== 'string' || f.sourceImageId.length > 100 || typeof f.clear !== 'boolean') throw new Error('INVALID_EXTRACTION');
      return { field: f.field as FieldSource['field'], value: f.value, sourceImageId: f.sourceImageId, clear: f.clear, normalizedValue: clean(f.value), ...(Number.isInteger(f.inputVersion) && Number(f.inputVersion) > 0 ? { inputVersion: Number(f.inputVersion) } : {}) };
    });
  }
  return { identifiers, recipientName: (v.recipientName as string | null)?.trim() || null, itemNames: strings('itemNames', 12), specifications: strings('specifications', 12), tags: strings('tags', 20), validImage: v.validImage, ...(fieldSources ? { fieldSources } : {}) };
}
const meaningfulNumber = (n: Identifier) => normalizeIdentifier(n.value).replace(/[^A-Z0-9]/g, '').length >= 4;
const individual = (n: Identifier) => ['domestic_waybill', 'last_mile_waybill', 'consolidation_waybill'].includes(n.type) && !n.shared && n.clear && n.complete && normalizeIdentifier(n.value).replace(/[^A-Z0-9]/g, '').length >= 6;
export function qualityOf(e: Extraction): Quality {
  if (!e.validImage) return 'unusable';
  if (e.identifiers.some(individual)) return 'complete';
  if (e.recipientName || e.identifiers.some(meaningfulNumber) || e.itemNames.some(specific) || e.tags.filter(specific).length >= 2) return 'partial';
  return 'unusable';
}
export interface EvidenceMatch { kind: 'exact' | 'possible'; reasons: string[]; rank: number }
export function matchEvidence(a: Extraction, b: Extraction): EvidenceMatch | null {
  if (qualityOf(a) === 'unusable' || qualityOf(b) === 'unusable') return null;
  const sameCarrier = (x: Identifier, y: Identifier) => !x.carrier || !y.carrier || clean(x.carrier) === clean(y.carrier);
  const pairs = a.identifiers.filter(meaningfulNumber).flatMap(x => b.identifiers.filter(y => meaningfulNumber(y) && x.type === y.type && sameCarrier(x, y)).map(y => [x, y] as const));
  if (pairs.some(([x, y]) => individual(x) && individual(y) && normalizeIdentifier(x.value) === normalizeIdentifier(y.value))) return { kind: 'exact', reasons: ['完整同类型包裹运单号一致'], rank: 100 };
  const reasons: string[] = [];
  const name = !!a.recipientName && !!b.recipientName && clean(a.recipientName) === clean(b.recipientName);
  const items = a.itemNames.filter(specific).some(x => b.itemNames.filter(specific).some(y => clean(x) === clean(y)));
  const tagCount = [...new Set(a.tags.filter(specific).map(clean))].filter(x => b.tags.filter(specific).map(clean).includes(x)).length;
  const exactWeak = pairs.some(([x, y]) => x.clear && y.clear && normalizeIdentifier(x.value) === normalizeIdentifier(y.value) && x.type !== 'unknown_id');
  const tails = pairs.some(([x, y]) => x.type !== 'order_id' && x.type !== 'unknown_id' && normalizeIdentifier(x.value).replace(/[*?]/g, '').length >= 4 && normalizeIdentifier(y.value).replace(/[*?]/g, '').length >= 4 && normalizeIdentifier(x.value).slice(-4) === normalizeIdentifier(y.value).slice(-4) && !/[*?]/.test(normalizeIdentifier(x.value).slice(-4)));
  if (exactWeak) reasons.push('相同的订单或集运线索，需要核实独立包裹');
  if (name) reasons.push('收件线索相同');
  if (items) reasons.push('具体物品名称相同');
  if (tagCount >= 2) reasons.push('多个具体物品标签相符');
  if (tails && (name || items || tagCount >= 2 || exactWeak)) reasons.push('同类型号码尾号及其他线索相符');
  if (!reasons.length) return null;
  const rank = exactWeak || (tails && reasons.length >= 2) ? 80 : name && (items || tagCount >= 2) ? 60 : 40;
  return { kind: 'possible', reasons, rank };
}

/** Public text is an allowlisted summary, never arbitrary OCR or contact text. */
export function publicSummary(e: Extraction | null): string {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const knownPrivate = [...(e?.identifiers.map(n => normalizeIdentifier(n.value)).filter(Boolean) ?? []), ...(e?.recipientName ? [e.recipientName.trim()] : [])];
  const candidates = e?.itemNames.filter(specific).map(s => {
    let safe = s.replace(/(?:https?:\/\/|www\.)\S+|\S+@\S+|\+?\d[\d\s-]{6,}\d|(?:微信|wechat|电话|地址|收件人|联系人)\s*[:：]?\s*\S+/gi, '');
    for (const value of knownPrivate) safe = safe.replace(new RegExp(Array.from(value).map(escape).join('\\s*'), 'gi'), '');
    return safe.trim();
  }).filter(s => s && !/[<>]/.test(s)) ?? [];
  return candidates.slice(0, 2).join('、').slice(0, 48) || '待核实包裹';
}
export interface ProjectionInput {
  code: string; kind: 'received' | 'tracking'; extraction?: Extraction | null; quality: Quality | null;
  resolution: Resolution; visibility: Visibility; updatedAt: string;
  approvedImageUrl?: string | null;
}
export function publicProjection(raw: ProjectionInput, baseUrl: string): PublicRecord {
  const withdrawn = raw.visibility === 'withdrawn';
  const name = raw.extraction?.recipientName;
  const recipientHint = !withdrawn && name ? `${name.slice(0, 1)}${'•'.repeat(Math.min(Math.max(name.length - 1, 1), 3))}` : null;
  return {
    code: raw.code, kind: raw.kind, title: withdrawn ? '记录已撤回' : publicSummary(raw.extraction ?? null),
    recipientHint, identifiers: withdrawn ? [] : (raw.extraction?.identifiers.filter(x => x.type !== 'order_id' && x.type !== 'unknown_id').map(x => ({ type: x.type, tail: normalizeIdentifier(x.value).slice(-4) })) ?? []),
    quality: withdrawn ? null : raw.quality, resolution: raw.resolution, visibility: raw.visibility,
    updatedAt: raw.updatedAt, url: `${baseUrl.replace(/\/$/, '')}/p/${encodeURIComponent(raw.code)}`,
    imageUrl: withdrawn ? null : raw.approvedImageUrl ?? null
  };
}
