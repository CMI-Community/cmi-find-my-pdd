import { ApiError, onlyKeys, stringValue } from './http.ts';

export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function bearer(request: Request): string {
  const match = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/);
  if (!match) throw new ApiError('FORBIDDEN', '缺少访问凭证。', 401);
  return match[1];
}

export function capability(request: Request): string {
  const token = bearer(request);
  // Accept exactly 32 random bytes, encoded as hexadecimal or base64url.
  if (/^[0-9a-f]{64}$/i.test(token)) return token;
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    try {
      const bytes = atob(token.replace(/-/g, '+').replace(/_/g, '/') + '=');
      if (bytes.length === 32) return token;
    } catch { /* invalid encoding */ }
  }
  throw new ApiError('FORBIDDEN', '访问凭证格式有误。', 401);
}

export function contact(input: unknown): { wechat: string; other: string; groupDeclaration: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('INVALID_REQUEST', '请填写本人的微信号。');
  const data = input as Record<string, unknown>;
  onlyKeys(data, ['wechat', 'other', 'groupDeclaration']);
  const wechat = stringValue(data.wechat, '微信号', 64);
  if (!/^[a-zA-Z][-_a-zA-Z0-9]{5,63}$/.test(wechat)) throw new ApiError('INVALID_REQUEST', '请输入微信号，不要填写昵称。');
  const other = data.other == null || data.other === '' ? '' : stringValue(data.other, '其他联系方式', 160);
  if (data.groupDeclaration !== true) throw new ApiError('INVALID_REQUEST', '请先加入寻货群，或群满时添加小助手。');
  return { wechat, other, groupDeclaration: true };
}

export function fingerprint(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim() || request.headers.get('cf-connecting-ip') || 'unknown';
}

export async function dimensions(bytes: Uint8Array): Promise<{ mime: string; width: number; height: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 45 && bytes.slice(0, 8).every((v, i) => v === [137, 80, 78, 71, 13, 10, 26, 10][i])) {
    let offset = 8, hasPixels = false, ended = false;
    if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new ApiError('INVALID_IMAGE', 'PNG 图片结构不完整。');
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) break;
      const kind = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (kind === 'IDAT' && length > 0) hasPixels = true;
      offset += length + 12;
      if (kind === 'IEND' && length === 0) { ended = true; break; }
    }
    if (hasPixels && ended && offset === bytes.length) return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
    throw new ApiError('INVALID_IMAGE', 'PNG 图片没有完整像素内容。');
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p++] !== 255) break;
      while (p < bytes.length && bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > bytes.length) break;
      const length = view.getUint16(p);
      if (length < 2 || p + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        return { mime: 'image/jpeg', width: view.getUint16(p + 5), height: view.getUint16(p + 3) };
      }
      p += length;
    }
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' && view.getUint32(4, true) + 8 === bytes.length) {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return { mime: 'image/webp', width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (kind === 'VP8L' && bytes[20] === 47) return { mime: 'image/webp', width: 1 + bytes[21] + ((bytes[22] & 63) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10) };
  }
  throw new ApiError('INVALID_IMAGE', '图片格式无法验证，请重新保存为 JPEG、PNG 或 WebP。');
}

/** Remove hidden EXIF/IPTC/text metadata from an administrator-approved copy. */
export function withoutMetadata(bytes: Uint8Array, mime: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments: Uint8Array[] = [];
  if (mime === 'image/png') {
    segments.push(bytes.slice(0, 8));
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const kind = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (offset + length + 12 > bytes.length) throw new ApiError('INVALID_IMAGE', 'PNG 图片结构损坏。');
      // Preserve only pixel data and rendering information, not eXIf/text chunks.
      if (['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM'].includes(kind)) segments.push(bytes.slice(offset, offset + length + 12));
      offset += length + 12;
    }
  } else if (mime === 'image/jpeg') {
    segments.push(bytes.slice(0, 2));
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      const start = offset;
      if (bytes[offset++] !== 255) throw new ApiError('INVALID_IMAGE', 'JPEG 图片结构损坏。');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) { segments.push(bytes.slice(start)); break; }
      if (marker === 1 || marker >= 208 && marker <= 215) { segments.push(bytes.slice(start, offset)); continue; }
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw new ApiError('INVALID_IMAGE', 'JPEG 图片结构损坏。');
      if (!(marker >= 225 && marker <= 239) && marker !== 254) segments.push(bytes.slice(start, offset + length));
      offset += length;
    }
  } else if (mime === 'image/webp') {
    segments.push(bytes.slice(0, 12));
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = String.fromCharCode(...bytes.slice(offset, offset + 4));
      const length = view.getUint32(offset + 4, true);
      const end = offset + 8 + length + length % 2;
      if (end > bytes.length) throw new ApiError('INVALID_IMAGE', 'WebP 图片结构损坏。');
      if (!['EXIF', 'XMP ', 'ICCP'].includes(kind)) {
        const chunk = bytes.slice(offset, end);
        if (kind === 'VP8X') chunk[8] &= ~0x2c;
        segments.push(chunk);
      }
      offset = end;
    }
  } else throw new ApiError('INVALID_IMAGE', '不支持公开此图片格式。');
  const result = new Uint8Array(segments.reduce((sum, segment) => sum + segment.length, 0));
  let offset = 0;
  for (const segment of segments) { result.set(segment, offset); offset += segment.length; }
  if (mime === 'image/webp') new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}
