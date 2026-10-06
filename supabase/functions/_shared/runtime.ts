/** Vault fallback kept in memory. Hosted Edge runtimes may forbid env mutation. */
const keys = ['OPENAI_API_KEY', 'WORKER_SECRET', 'ADMIN_USER_IDS', 'APP_PUBLIC_URL', 'ALLOWED_ORIGINS', 'APP_SHA', 'APP_ENVIRONMENT', 'OCR_ENABLED'] as const;
export type RuntimeLoader = () => Promise<Record<string, unknown>>;

export function createRuntimeCache(readEnvironment: (name: string) => string | undefined = (name) => Deno.env.get(name), now: () => number = Date.now) {
  let values: Record<string, string> = Object.create(null);
  let loadedAt: number | null = null;
  let loading: Promise<void> | null = null;
  return {
    get(name: string): string | undefined { return readEnvironment(name) || values[name]; },
    async ensure(loader: RuntimeLoader): Promise<void> {
      if (loadedAt !== null && now() - loadedAt < 60_000) return;
      if (!loading) loading = (async () => {
        const response = await loader();
        const config = response?.config && typeof response.config === 'object' && !Array.isArray(response.config) ? response.config as Record<string, unknown> : response;
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('RUNTIME_CONFIG_UNAVAILABLE');
        const next: Record<string, string> = Object.create(null);
        for (const name of keys) if (typeof config[name] === 'string' && config[name]) next[name] = config[name] as string;
        values = next;
        loadedAt = now();
      })().finally(() => { loading = null; });
      await loading;
    },
  };
}

const runtime = createRuntimeCache();
export function getRuntime(name: string): string | undefined { return runtime.get(name); }
export function ensureRuntimeConfig(loader: RuntimeLoader): Promise<void> { return runtime.ensure(loader); }
