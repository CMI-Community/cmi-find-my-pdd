export type Rect = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export type PhotoRole = 'label' | 'item' | 'logistics' | 'product';
export type LocalPhoto = {
    id: string;
    role: PhotoRole;
    blob: Blob;
    width: number;
    height: number;
    assetPath?: string;
};
async function loadImage(blob: Blob): Promise<HTMLImageElement> {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
    }
    catch {
        throw new Error('这张照片无法读取。请使用 JPG、PNG 或重新拍照。');
    }
    finally {
        URL.revokeObjectURL(url);
    }
}
/** Canvas exports pixels rather than metadata; masks are burnt into the uploaded JPEG. */
export async function encodePhoto(blob: Blob, crop?: Rect, masks: Rect[] = []): Promise<Omit<LocalPhoto, 'id' | 'role'>> {
    if (blob.size > 30 * 1024 * 1024)
        throw new Error('照片超过 30 MB，请换一张较小的图片。');
    const image = await loadImage(blob);
    const area = crop || { x: 0, y: 0, w: 1, h: 1 };
    if (area.w < 0.02 || area.h < 0.02)
        throw new Error('裁剪区域太小，请重新框选。');
    const sw = image.naturalWidth * area.w, sh = image.naturalHeight * area.h;
    const scale = Math.min(1, 2048 / Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * scale)), height = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context)
        throw new Error('当前浏览器无法处理照片，请换一个浏览器。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, image.naturalWidth * area.x, image.naturalHeight * area.y, sw, sh, 0, 0, width, height);
    context.fillStyle = '#202922';
    for (const r of masks)
        context.fillRect((r.x - area.x) / area.w * width, (r.y - area.y) / area.h * height, r.w / area.w * width, r.h / area.h * height);
    const encoded = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('照片处理失败，请重新拍照。')), 'image/jpeg', 0.88));
    return { blob: encoded, width, height };
}
export function makeCapability() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
export function normalizedRect(a: {
    x: number;
    y: number;
}, b: {
    x: number;
    y: number;
}): Rect {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
