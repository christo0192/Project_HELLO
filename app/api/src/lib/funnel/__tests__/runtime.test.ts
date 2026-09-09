import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createFunnelRuntime } from '../runtime.js';
import type { FunnelRuntimeConfig } from '../config.js';

const ENABLED: FunnelRuntimeConfig = {
  enabled: true,
  refreshIntervalMs: 900_000,
  windowDays: 30,
};

/** A SupabaseClient stub whose only method is rpc(). */
function clientReturning(result: { data?: unknown; error?: unknown }): {
  client: SupabaseClient;
  rpc: ReturnType<typeof vi.fn>;
} {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('createFunnelRuntime', () => {
  it('constructs nothing when the gate is closed', () => {
    const handle = createFunnelRuntime({ config: { ...ENABLED, enabled: false } });
    expect(handle).toBeNull();
  });

  it('returns a handle with the single rollup loop when enabled', () => {
    const { client } = clientReturning({ data: { status: 'ok', rows: 1 } });
    const handle = createFunnelRuntime({ config: ENABLED, client });
    expect(handle).not.toBeNull();
    expect(handle!.loopIntervalsMs).toEqual({ 'funnel-rollup-refresh': 900_000 });
  });

  it('calls refresh_funnel_rollup with the configured window and reports work on ok', async () => {
    const { client, rpc } = clientReturning({ data: { status: 'ok', rows: 4 } });
    const handle = createFunnelRuntime({ config: { ...ENABLED, windowDays: 14 }, client })!;
    await expect(handle.tickOnce()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('refresh_funnel_rollup', { p_window_days: 14 });
  });

  it('treats status=busy (another replica held the lock) as no work, not an error', async () => {
    const { client } = clientReturning({ data: { status: 'busy' } });
    const handle = createFunnelRuntime({ config: ENABLED, client })!;
    await expect(handle.tickOnce()).resolves.toBe(false);
  });

  it('treats an ok result that recomputed zero rows as no work', async () => {
    const { client } = clientReturning({ data: { status: 'ok', rows: 0 } });
    const handle = createFunnelRuntime({ config: ENABLED, client })!;
    await expect(handle.tickOnce()).resolves.toBe(false);
  });

  it('never throws on an RPC error result', async () => {
    const { client } = clientReturning({ error: { message: 'boom' } });
    const handle = createFunnelRuntime({ config: ENABLED, client })!;
    await expect(handle.tickOnce()).resolves.toBe(false);
  });

  it('never throws when the client itself rejects', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('network'));
    const client = { rpc } as unknown as SupabaseClient;
    const handle = createFunnelRuntime({ config: ENABLED, client })!;
    await expect(handle.tickOnce()).resolves.toBe(false);
  });
});
