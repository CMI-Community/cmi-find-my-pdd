import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('CMIBAK01');
export async function encryptFile(source, destination, password) {
  if (!password || password.length < 24) throw new Error('BACKUP_PASSWORD must have at least 24 characters.');
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  const handle = await open(destination, 'wx', 0o600);
  try {
    await handle.write(Buffer.concat([MAGIC, salt, iv]));
    await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: 'r+', start: 36 }));
    await handle.write(cipher.getAuthTag(), 0, 16, (await handle.stat()).size);
  } finally { await handle.close(); }
}
export async function decryptFile(source, destination, password) {
  const handle = await open(source, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size < 52) throw new Error('Invalid backup file.');
    const header = Buffer.alloc(36), tag = Buffer.alloc(16);
    await handle.read(header, 0, 36, 0);
    await handle.read(tag, 0, 16, stat.size - 16);
    if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid backup format.');
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, header.subarray(8, 24), 32), header.subarray(24));
    decipher.setAuthTag(tag);
    await pipeline(createReadStream(source, { start: 36, end: stat.size - 17 }), decipher, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } finally { await handle.close(); }
}
