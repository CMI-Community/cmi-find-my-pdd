import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error Operational module intentionally uses native Node ESM.
import { encryptFile, decryptFile } from '../scripts/crypto.mjs';
it('authenticates encrypted backups and refuses a wrong password', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cmi-crypto-test-'));
  try {
    const original = path.join(dir, 'source'), encrypted = path.join(dir, 'sealed'), recovered = path.join(dir, 'recovered');
    await writeFile(original, 'synthetic isolated database backup');
    await encryptFile(original, encrypted, 'synthetic-test-password-at-least-24-chars');
    await decryptFile(encrypted, recovered, 'synthetic-test-password-at-least-24-chars');
    expect(await readFile(recovered, 'utf8')).toBe('synthetic isolated database backup');
    await expect(decryptFile(encrypted, path.join(dir, 'wrong'), 'another-password-at-least-24-chars')).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
