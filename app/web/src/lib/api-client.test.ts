import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    },
  },
}));

import { ApiError, apiClient } from './api-client';

describe('apiClient error parsing', () => {
  beforeEach(() => {
    (globalThis as any).__resetNetworkCount?.();
  });

  it('uses nested error.message instead of rendering [object Object]', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { type: 'maintenance_mode', message: 'Service temporarily unavailable' } }),
      { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

    await expect(apiClient.request('/api/admin/sessions')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: 'Service temporarily unavailable',
    } satisfies Partial<ApiError>);
    (globalThis as any).__resetNetworkCount?.();
  });

  it('falls back to nested error.type when message is absent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { type: 'quota_exceeded' } }),
      { status: 429, statusText: 'Too Many Requests', headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

    await expect(apiClient.request('/api/admin/sessions')).rejects.toMatchObject({
      status: 429,
      message: 'quota_exceeded',
    });
    (globalThis as any).__resetNetworkCount?.();
  });
});
