import { describe, it, expect } from 'vitest';
import { normalizeIdentifier, validateExtraction, qualityOf, matchEvidence, publicProjection, publicSummary } from '../shared/domain.ts';
import type { Extraction, Identifier } from '../shared/contracts.ts';
const id = (patch: Partial<Identifier> = {}): Identifier => ({ id: 'n1', type: 'domestic_waybill', value: '001 AB23', carrier: '测试承运商', complete: true, clear: true, shared: false, sourceImageId: 'test-label', ...patch });
const evidence = (patch: Partial<Extraction> = {}): Extraction => ({ identifiers: [id()], recipientName: null, itemNames: [], specifications: [], tags: [], validImage: true, ...patch });
describe('recognition and comparison boundaries', () => {
  it('preserves leading zeros and ambiguous characters', () => { expect(normalizeIdentifier(' 00 oI1 ')).toBe('00OI1'); expect(normalizeIdentifier('O')).not.toBe(normalizeIdentifier('0')); });
  it('validates model output, rejects invalid types and does not trust completion claims', () => { expect(() => validateExtraction(evidence({ identifiers: [id({ type: 'phone' as never })] }))).toThrow(); expect(validateExtraction(evidence({ identifiers: [id({ value: '00??1234' })] })).identifiers[0].complete).toBe(false); });
  it('keeps weak meaningful evidence, rejects generic content', () => { expect(qualityOf(evidence({ identifiers: [], recipientName: '测试人' }))).toBe('partial'); expect(qualityOf(evidence({ identifiers: [], itemNames: ['日用品'] }))).toBe('unusable'); expect(qualityOf(evidence({ validImage: false }))).toBe('unusable'); });
  it('matches clear independent same-type identifiers', () => { expect(matchEvidence(evidence(), evidence())?.kind).toBe('exact'); });
  it('punctuation is not a parcel identifier', () => { const fake = evidence({ identifiers: [id({ value: '....' })] }); expect(qualityOf(fake)).toBe('unusable'); expect(matchEvidence(fake, fake)).toBeNull(); });
  it('never compares identifiers across types or known carrier conflicts', () => { expect(matchEvidence(evidence(), evidence({ identifiers: [id({ type: 'last_mile_waybill' })] }))).toBeNull(); expect(matchEvidence(evidence(), evidence({ identifiers: [id({ carrier: '另一承运商' })] }))).toBeNull(); });
  it('master consolidation and orders are candidates only', () => { for (const patch of [{ shared: true, type: 'consolidation_waybill' as const }, { type: 'order_id' as const }]) expect(matchEvidence(evidence({ identifiers: [id(patch)] }), evidence({ identifiers: [id(patch)] }))?.kind).toBe('possible'); });
  it('tail alone is insufficient, tail plus a name is a candidate', () => { const b = evidence({ identifiers: [id({ value: 'ZZ1234' })] }); const a = evidence({ identifiers: [id({ value: 'AA1234' })] }); expect(matchEvidence(a, b)).toBeNull(); expect(matchEvidence({ ...a, recipientName: '测试' }, { ...b, recipientName: '测试' })?.kind).toBe('possible'); });
  it('same item or name cannot assert ownership; generic tags cannot match', () => { expect(matchEvidence(evidence({ identifiers: [], itemNames: ['不锈钢汤锅'] }), evidence({ identifiers: [], itemNames: ['不锈钢汤锅'] }))?.kind).toBe('possible'); expect(matchEvidence(evidence({ identifiers: [], tags: ['日用品'] }), evidence({ identifiers: [], tags: ['日用品'] }))).toBeNull(); });
});
describe('public projection', () => {
  it('strips identifiers and recipients copied into model item names', () => { const text = publicSummary(evidence({ identifiers: [id({value:'ABCD12345'})], recipientName:'测试名字', itemNames:['测试名字 汤锅 ABCD12345'] })); expect(text).toBe('汤锅'); });
  it('uses an allowlist, masks names/numbers and contains no raw evidence or contacts', () => {
    const out = publicProjection({ code: 'CMI-TEST', kind: 'received', extraction: evidence({ recipientName: '测试名字', itemNames: ['汤锅 电话:13800138000'] }), quality: 'complete', resolution: 'open', visibility: 'active', updatedAt: '2026-10-05T00:00:00Z' }, 'https://example.test');
    const json = JSON.stringify(out); expect(json).not.toContain('13800138000'); expect(json).not.toContain('测试名字'); expect(json).not.toContain('001 AB23'); expect(out.imageUrl).toBeNull(); expect(out.url).toBe('https://example.test/p/CMI-TEST');
  });
  it('withdrawn records erase original public content', () => { const out = publicProjection({ code: 'CMI-TEST', kind: 'received', extraction: evidence({ itemNames: ['汤锅'] }), quality: 'complete', resolution: 'open', visibility: 'withdrawn', updatedAt: '', approvedImageUrl: 'https://example.test/image' }, 'https://example.test'); expect(out.title).toBe('记录已撤回'); expect(out.identifiers).toEqual([]); expect(out.imageUrl).toBeNull(); });
});
