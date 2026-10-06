import { prepareZXingModule, readBarcodes, type ReaderOptions, type ReadResult } from 'zxing-wasm/reader';
import readerWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export const waybillReaderOptions: ReaderOptions = {
  formats: ['Code128', 'Code39', 'Code93', 'ITF', 'Codabar'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 8,
  // Code128's mandatory checksum is always checked by ZXing. Code39/ITF
  // labels may legitimately omit an optional checksum, so do not require one.
  validateOptionalChecksum: false,
  returnErrors: false,
};
let moduleReady: Promise<void> | undefined;
let decodeTail: Promise<void> = Promise.resolve();

export class BarcodeReaderUnavailableError extends Error {
  constructor(cause: unknown) {
    super('条形码识别组件未能加载。请刷新页面后重试，或手动输入单号。', { cause });
    this.name = 'BarcodeReaderUnavailableError';
  }
}

/** Called on page open and reused by every scanner. The binary stays on this site. */
export function preloadBarcodeReader(): Promise<void> {
  if (!moduleReady) {
    moduleReady = Promise.resolve().then(() => prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => path.endsWith('.wasm') ? readerWasmUrl : prefix + path },
      fireImmediately: true,
    })).then(() => undefined).catch(cause => { throw new BarcodeReaderUnavailableError(cause); });
  }
  return moduleReady;
}

/** A shared WASM heap is never entered by two scanner requests at once. */
export function readWaybillBarcodes(image: ImageData, isCurrent: () => boolean = () => true): Promise<ReadResult[]> {
  const operation = decodeTail.then(async () => {
    if (!isCurrent()) throw new DOMException('识别已取消。', 'AbortError');
    await preloadBarcodeReader();
    if (!isCurrent()) throw new DOMException('识别已取消。', 'AbortError');
    const results = await readBarcodes(image, waybillReaderOptions);
    if (!isCurrent()) throw new DOMException('识别已取消。', 'AbortError');
    return results;
  });
  decodeTail = operation.then(() => undefined, () => undefined);
  return operation;
}
