export const APP_VERSION = '0.1.0';
export type Intent = 'received' | 'search';
export type ImageRole = 'label' | 'item' | 'logistics' | 'product';
export type IdentifierType = 'domestic_waybill' | 'consolidation_waybill' | 'last_mile_waybill' | 'order_id' | 'unknown_id';
export type Quality = 'complete' | 'partial' | 'unusable';
export type RecognitionState = 'draft' | 'queued' | 'running' | 'succeeded' | 'needs_photo' | 'deferred' | 'failed' | 'cancelled';
export type Resolution = 'open' | 'verifying' | 'claimed' | 'resolved';
export type Visibility = 'pending' | 'active' | 'withdrawn';
export type MatchKind = 'exact' | 'possible';
export interface Contact { wechat: string; other?: string; groupDeclaration: boolean }
export interface Identifier { id: string; type: IdentifierType; value: string; carrier: string | null; complete: boolean; clear: boolean; shared: boolean; sourceImageId: string }
export interface FieldSource { field: 'recipientName' | 'itemName' | 'specification' | 'tag'; value: string; sourceImageId: string; clear: boolean; normalizedValue?: string; inputVersion?: number }
export interface Extraction { identifiers: Identifier[]; recipientName: string | null; itemNames: string[]; specifications: string[]; tags: string[]; validImage: boolean; fieldSources?: FieldSource[] }
export interface PublicRecord {
  code: string; kind: 'received' | 'tracking'; title: string; recipientHint: string | null;
  identifiers: { type: IdentifierType; tail: string }[]; quality: Quality | null;
  resolution: Resolution; visibility: Visibility; updatedAt: string; url: string; imageUrl?: string | null;
}
export interface MatchResult { record: PublicRecord; kind: MatchKind; reasons: string[] }
export interface CandidatePage {
  results: MatchResult[]; nextOffset: number | null; totalMatches: number;
  imageVersion: number; selectedIdentifierId: string | null;
}
export interface ScanProgress {
  id: string; intent: Intent; imageVersion: number; state: RecognitionState; quality: Quality | null;
  extraction: Extraction | null; record: PublicRecord | null; results: MatchResult[];
  requiresSelection: boolean; selectedIdentifierId: string | null; errorCode?: string | null;
}
export interface UploadSlot { id: string; role: ImageRole; uploadUrl: string; path: string; token: string; bucket: string }
export interface ScanStart { id: string; imageVersion: number; uploads: UploadSlot[] }
export interface ScanCreate { requestId: string; intent: Intent; imageRoles: ImageRole[] }
export interface ScanSubmit { imageVersion: number; imageIds: string[]; contact?: Contact; selectedIdentifierId?: string }
export interface Community {
  groupQrUrl: string | null; assistantWechat: string | null; assistantQrUrl: string | null;
  officialAccountName: string | null; officialAccountQrUrl: string | null;
  projectUrl: string; submissionsEnabled: boolean; ready: boolean;
}
export interface Stats { recordedPackageCount: number; activeSeekerCount: number; successfulHandoverCount: number | null }
export interface PrivateRecord {
  record: PublicRecord; scanId: string; imageVersion: number; revision: number; contact: Contact;
  extraction: Extraction | null; images: { id: string; role: ImageRole; url: string }[];
  results: MatchResult[]; state: RecognitionState; canRevise: boolean;
}
export interface AdminRecord extends PrivateRecord { id: string; createdAt: string; duplicateOf: string | null }
export interface AdminTask {
  id: string; matchId: string | null; receivedCode: string; trackingCode: string | null;
  state: 'needs_review' | 'ready_to_contact' | 'contacting' | 'awaiting_handover' | 'closed';
  kind: MatchKind | null; reasons: string[]; receivedContactedAt: string | null;
  trackingContactedAt: string | null; notes: string; updatedAt: string;
}
export interface ApiError { code: string; message: string; requestId: string; retryable: boolean }
export type ApiResponse<T> = { data: T } | { error: ApiError };
export interface Health { service: 'cmi-find-my-pdd'; version: string; sha: string; ok: boolean; ready: boolean; environment: string }
