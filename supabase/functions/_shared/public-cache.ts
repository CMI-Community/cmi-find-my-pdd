type Key = 'community' | 'waybill-stats' | 'stats';
type Entry = { expiresAt: number; value: unknown };

/** Three public allowlisted DTOs only. No private/contact-match response is cached. */
export function createPublicCache(ttlMs = 30_000, now: () => number = Date.now) {
  const values = new Map<Key, Entry>();
  const loading = new Map<Key, Promise<unknown>>();
  let generation = 0;
  return {
    clear(): void { generation++; values.clear(); loading.clear(); },
    async get<T>(key: Key, load: () => Promise<T>): Promise<T> {
      const entry = values.get(key);
      if (entry && entry.expiresAt > now()) return entry.value as T;
      let pending = loading.get(key) as Promise<T> | undefined;
      if (!pending) {
        const currentGeneration = generation;
        pending = load().then(value => {
          if (currentGeneration === generation) values.set(key, { value, expiresAt: now() + ttlMs });
          return value;
        }).finally(() => { if (loading.get(key) === pending) loading.delete(key); });
        loading.set(key, pending);
      }
      return await pending;
    },
  };
}
