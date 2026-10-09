import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OBSERVATION_MODEL, OBSERVATION_PROMPT_VERSION } from '../shared/hourly-observer';

const migration = readFileSync(new URL('../supabase/migrations/20261009050000_hourly_insights_worker.sql', import.meta.url), 'utf8');

describe('hourly worker and database activation contract', () => {
  it.each(['pdd_insights_reserve', 'pdd_insights_configure_worker'])('%s accepts the compiled model and prompt version', name => {
    const body = migration.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?end\\$\\$;`))?.[0];
    expect(body, 'the actual migration must contain the private RPC').toBeDefined();
    const model = body!.match(/p_payload->>'model' is distinct from '([^']+)'/)?.[1];
    const prompt = body!.match(/p_payload->>'prompt_version' is distinct from '([^']+)'/)?.[1];
    expect(model, 'compiled model must pass the database allowlist').toBe(OBSERVATION_MODEL);
    expect(prompt, 'compiled prompt must pass both configuration and reservation').toBe(OBSERVATION_PROMPT_VERSION);
  });
});
