import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const sdk = vi.hoisted(() => ({ createClient: vi.fn(() => ({ auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } })) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: sdk.createClient }));
import { createAdminAuthObserver, needsPasswordRecovery, newPasswordError, passwordRecoveryEntry, saveRecoveryPassword } from '../src/PddApp';

function syntheticSession(id = 'synthetic-admin'): Session {
  return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, email: 'admin@example.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-06T10:00:00Z' } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }
function fixture(entry = { requested: false, invalid: false }) {
  const initial = deferred<{ data: { session: Session | null }; error: unknown }>();
  let listener!: (event: AuthChangeEvent, session: Session | null) => void;
  const unsubscribe = vi.fn();
  const client = { getSession: vi.fn(() => initial.promise), onAuthStateChange: vi.fn((callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe } } }; }) };
  const observer = createAdminAuthObserver(client, entry);
  observers.add(observer);
  return { observer, client, initial, emit: (event: AuthChangeEvent, session: Session | null) => listener(event, session), unsubscribe };
}
const observers = new Set<ReturnType<typeof createAdminAuthObserver>>();
async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function readyRecovery() {
  vi.useFakeTimers();
  const value = fixture(), session = syntheticSession();
  value.client.getSession.mockResolvedValue({ data: { session }, error: null });
  value.emit('PASSWORD_RECOVERY', session);
  await vi.advanceTimersByTimeAsync(0);
  expect(value.observer.getSnapshot().recovery).toBe('ready');
  return { ...value, session };
}
afterEach(() => { observers.forEach(observer => observer.dispose()); observers.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); sdk.createClient.mockReset(); });

describe('administrator password recovery session', () => {
  it('captures recovery and expired-link intent without retaining token values', () => {
    expect(passwordRecoveryEntry('#type=recovery&access_token=synthetic-access')).toEqual({ requested: true, invalid: false });
    expect(passwordRecoveryEntry('#error=access_denied&error_code=otp_expired')).toEqual({ requested: true, invalid: true });
    expect(passwordRecoveryEntry('#type=signup')).toEqual({ requested: false, invalid: false });
    expect(newPasswordError('short', 'short')).toContain('12');
    expect(newPasswordError('a long synthetic password', 'different')).toContain('不一致');
    expect(newPasswordError('a long synthetic password', 'a long synthetic password')).toBe('');
    expect(newPasswordError('            ', '            ')).toContain('12');
  });
  it('subscribes before getting the initial session and never treats a stored session as recovery', async () => {
    const value = fixture({ requested: true, invalid: false }), session = syntheticSession();
    expect(value.client.onAuthStateChange.mock.invocationCallOrder[0]).toBeLessThan(value.client.getSession.mock.invocationCallOrder[0]);
    expect(value.observer.getSnapshot().recovery).toBe('pending');
    value.initial.resolve({ data: { session }, error: null }); await flush();
    expect(value.observer.getSnapshot().recovery).toBe('expired');
    expect(value.observer.canSetPassword(session)).toBe(false);
  });
  it('requires a fresh same-user session after PASSWORD_RECOVERY', async () => {
    vi.useFakeTimers();
    const value = fixture(), session = syntheticSession();
    const confirmation = deferred<{ data: { session: Session | null }; error: unknown }>();
    value.client.getSession.mockReturnValue(confirmation.promise);
    value.emit('PASSWORD_RECOVERY', session);
    expect(value.observer.canSetPassword(session)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.observer.getSnapshot().recovery).toBe('pending');
    confirmation.resolve({ data: { session }, error: null }); await flush();
    expect(value.observer.canSetPassword(session)).toBe(true);
  });
  it('ignores stale initial getter and INITIAL_SESSION after a confirmed recovery event', async () => {
    const value = await readyRecovery();
    value.initial.resolve({ data: { session: null }, error: null });
    value.emit('INITIAL_SESSION', null); await flush();
    expect(value.observer.getSnapshot().recovery).toBe('ready');
    expect(value.observer.canSetPassword(value.session)).toBe(true);
  });
  it('refreshes confirmation if token renewal interrupts the first recovery getter', async () => {
    vi.useFakeTimers();
    const value = fixture(), session = syntheticSession();
    const stale = deferred<{ data: { session: Session | null }; error: unknown }>();
    value.client.getSession.mockReturnValueOnce(stale.promise).mockResolvedValue({ data: { session }, error: null });
    value.emit('PASSWORD_RECOVERY', session); await vi.advanceTimersByTimeAsync(0);
    value.emit('TOKEN_REFRESHED', session); await vi.advanceTimersByTimeAsync(0);
    stale.resolve({ data: { session: null }, error: null }); await flush();
    expect(value.observer.getSnapshot().recovery).toBe('ready');
  });
  it('does not resurrect a signed-out recovery session when verification finishes late', async () => {
    vi.useFakeTimers();
    const value = fixture(), session = syntheticSession();
    const confirmation = deferred<{ data: { session: Session | null }; error: unknown }>();
    value.client.getSession.mockReturnValue(confirmation.promise);
    value.emit('PASSWORD_RECOVERY', session); await vi.advanceTimersByTimeAsync(0);
    value.emit('SIGNED_OUT', null);
    confirmation.resolve({ data: { session }, error: null }); await flush();
    expect(value.observer.getSnapshot().recovery).toBe('expired');
    expect(value.observer.canSetPassword(session)).toBe(false);
  });
  it('rejects confirmation for another user and already expired sessions', async () => {
    vi.useFakeTimers();
    const value = fixture(), session = syntheticSession();
    value.client.getSession.mockResolvedValue({ data: { session: syntheticSession('different-user') }, error: null });
    value.emit('PASSWORD_RECOVERY', session); await vi.advanceTimersByTimeAsync(0);
    expect(value.observer.getSnapshot().recovery).toBe('expired');
    value.emit('PASSWORD_RECOVERY', { ...session, expires_at: Math.floor(Date.now() / 1000) - 1 });
    expect(value.observer.getSnapshot().recovery).toBe('expired');
  });
  it('keeps ordinary sign-in usable when an old getter finishes later', async () => {
    const value = fixture(), session = syntheticSession();
    value.emit('SIGNED_IN', session);
    value.initial.resolve({ data: { session: null }, error: null }); value.emit('INITIAL_SESSION', null); await flush();
    expect(value.observer.getSnapshot()).toMatchObject({ session, recovery: 'none', loading: false });
    expect(value.observer.canSetPassword(session)).toBe(false);
    value.emit('SIGNED_OUT', null);
    expect(value.observer.getSnapshot()).toMatchObject({ session: null, recovery: 'none' });
  });
  it('returns an invalid link to the request form without reusing a stored session', async () => {
    const value = fixture({ requested: true, invalid: true });
    value.initial.resolve({ data: { session: syntheticSession() }, error: null }); await flush();
    value.observer.dismissRecovery();
    expect(value.observer.getSnapshot()).toMatchObject({ session: null, recovery: 'none', loading: false });
    expect(needsPasswordRecovery(value.observer.getSnapshot())).toBe(false);
    expect(createAdminAuthObserver(null, { requested: true, invalid: false }).getSnapshot().recovery).toBe('expired');
  });
  it('captures the root recovery fragment before client creation consumes it and renders recovery at /', async () => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { hash: '#type=recovery', origin: 'https://pdd404.example.test' } });
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.example.test'); vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'synthetic-public-key');
    sdk.createClient.mockImplementationOnce(() => {
      window.location.hash = '';
      return { auth: { getSession: () => new Promise(() => {}), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } };
    });
    const module = await import('../src/PddApp');
    expect(module.initialPasswordRecovery).toEqual({ requested: true, invalid: false });
    expect(window.location.hash).toBe('');
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/'] }, createElement(module.default)));
    expect(html).toContain('验证密码设置链接');
    expect(html).not.toContain('我的拼多多快递去哪了');
  });
});

describe('administrator password update boundary', () => {
  it('never calls updateUser without a confirmed recovery session or with invalid passwords', async () => {
    const value = fixture(), session = syntheticSession(), updateUser = vi.fn().mockResolvedValue({ error: null });
    value.client.getSession.mockResolvedValue({ data: { session }, error: null });
    await expect(saveRecoveryPassword({ ...value.client, updateUser }, value.observer, 'a long synthetic password', 'a long synthetic password')).rejects.toThrow('失效');
    await expect(saveRecoveryPassword({ ...value.client, updateUser }, value.observer, 'short', 'short')).rejects.toThrow('12');
    expect(updateUser).not.toHaveBeenCalled();
  });
  it('rechecks the current user immediately before saving and rejects a replaced session', async () => {
    const value = await readyRecovery(), updateUser = vi.fn().mockResolvedValue({ error: null });
    value.client.getSession.mockResolvedValue({ data: { session: syntheticSession('another-user') }, error: null });
    await expect(saveRecoveryPassword({ ...value.client, updateUser }, value.observer, 'a long synthetic password', 'a long synthetic password')).rejects.toThrow('失效');
    expect(updateUser).not.toHaveBeenCalled();
    expect(value.observer.getSnapshot().recovery).toBe('expired');
  });
  it('saves only the user-entered password and completes recovery after success', async () => {
    const value = await readyRecovery(), updateUser = vi.fn().mockResolvedValue({ error: null });
    await saveRecoveryPassword({ ...value.client, updateUser }, value.observer, 'a long synthetic password', 'a long synthetic password');
    expect(updateUser).toHaveBeenCalledOnce();
    expect(updateUser).toHaveBeenCalledWith({ password: 'a long synthetic password' });
    expect(value.observer.getSnapshot()).toMatchObject({ session: value.session, recovery: 'complete', loading: false });
    expect(value.observer.canSetPassword(value.session)).toBe(false);
  });
  it('expires a rejected server session and never claims password success', async () => {
    const value = await readyRecovery(), updateUser = vi.fn().mockResolvedValue({ error: { status: 401, code: 'bad_jwt' } });
    await expect(saveRecoveryPassword({ ...value.client, updateUser }, value.observer, 'a long synthetic password', 'a long synthetic password')).rejects.toThrow('失效');
    expect(value.observer.getSnapshot().recovery).toBe('expired');
  });
});
