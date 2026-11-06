/**
 * The R1 methods of the API client: the exact path, verb and body each one
 * sends. The server contract (routes, RBAC) is pinned in app/api; this pins
 * that the web calls those routes and nothing else, with ids encoded and the
 * India attestation carried as a literal `true`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());

vi.mock('./lib/api-client', () => ({
  apiClient: { request, BASE_URL: 'http://api.test' },
  ApiError: class extends Error {},
}));
vi.mock('./lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import { api } from './api';

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({});
});

describe('R1 api client', () => {
  it('reads availability from the rounds namespace, not the admin one', async () => {
    await api.getR1Availability();
    expect(request).toHaveBeenCalledWith('/api/interview-rounds/availability');
  });

  it('reads a review by the round, encoding the id', async () => {
    await api.getR1Review('round 1/../x');
    expect(request).toHaveBeenCalledWith('/api/interview-rounds/round%201%2F..%2Fx/review');
  });

  it('cancels a pending reject with a POST and no body', async () => {
    await api.cancelR1PendingReject('round-1');
    expect(request).toHaveBeenCalledWith('/api/interview-rounds/round-1/cancel-pending-reject', { method: 'POST' });
  });

  it('lists a candidate’s rounds, encoding the id', async () => {
    await api.listR1Rounds('cand 1/../x');
    expect(request).toHaveBeenCalledWith('/api/candidates/cand%201%2F..%2Fx/interview-rounds');
  });

  it('reads the queue with only what was asked for', async () => {
    await api.listR1Queue();
    expect(request).toHaveBeenLastCalledWith('/api/interview-rounds');
    await api.listR1Queue({ view: 'all', sort: 'newest', page: 2, pageSize: 1, includeDryRuns: true });
    expect(request).toHaveBeenLastCalledWith('/api/interview-rounds?view=all&sort=newest&page=2&page_size=1&dry_runs=include');
  });

  it('searches the queue with the name in a POST body, and in no URL', async () => {
    await api.listR1Queue({ view: 'all', sort: 'newest', page: 2, pageSize: 1, search: 'Ava & Co', includeDryRuns: true });
    expect(request).toHaveBeenLastCalledWith('/api/interview-rounds/search?view=all&sort=newest&page=2&page_size=1&dry_runs=include', {
      method: 'POST',
      body: JSON.stringify({ q: 'Ava & Co' }),
    });
    await api.listR1Queue({ search: 'Ava' });
    expect(request).toHaveBeenLastCalledWith('/api/interview-rounds/search', { method: 'POST', body: JSON.stringify({ q: 'Ava' }) });
  });

  it('sends no empty search', async () => {
    await api.listR1Queue({ view: 'to-review', search: '' });
    expect(request).toHaveBeenLastCalledWith('/api/interview-rounds?view=to-review');
  });

  it('sends with the attestation as a JSON body', async () => {
    await api.sendR1Round('c-1', { india_location_attested: true });
    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/candidates/c-1/interview-rounds');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ india_location_attested: true });
  });

  it.each([
    ['cancelR1Round', 'cancel'],
    ['reissueR1Round', 'reissue'],
    ['grantR1Retake', 'grant-retake'],
  ] as const)('%s posts to /interview-rounds/:id/%s with no body', async (method, action) => {
    await api[method]('r/1');
    expect(request).toHaveBeenCalledWith(`/api/interview-rounds/r%2F1/${action}`, {
      method: 'POST',
    });
  });

  it('reads settings and usage from the admin namespace', async () => {
    await api.getR1Settings();
    await api.getR1Usage();
    expect(request).toHaveBeenNthCalledWith(1, '/api/admin/r1/settings');
    expect(request).toHaveBeenNthCalledWith(2, '/api/admin/r1/usage');
  });

  it('writes settings with PUT and exactly the patch it was given', async () => {
    await api.updateR1Settings({ paused: true, monthly_cap_minutes: 3000 });
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/admin/r1/settings');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ paused: true, monthly_cap_minutes: 3000 });
  });

  it('mints a recording as a GET (a viewer may not POST), encoding both ids', async () => {
    await api.getR1Recording('round 1/../x', 'sess&ion=2');
    expect(request).toHaveBeenCalledTimes(1);
    // A GET: one argument, no init (no method, no body).
    expect(request).toHaveBeenCalledWith(
      '/api/interview-rounds/round%201%2F..%2Fx/recording?session_id=sess%26ion%3D2',
    );
  });

  it('returns the mint answer untouched and never adds a query of its own', async () => {
    const answer = { state: 'ready', url: 'https://r2.example.test/x?sig=1', expires_in_sec: 300 };
    request.mockResolvedValue(answer);
    await expect(api.getR1Recording('r', 's')).resolves.toBe(answer);
    const [path] = request.mock.calls[0] as [string];
    expect(new URL(path, 'http://api.test').searchParams.get('session_id')).toBe('s');
    expect([...new URL(path, 'http://api.test').searchParams.keys()]).toEqual(['session_id']);
  });

  it('returns what the request returned, untouched', async () => {
    request.mockResolvedValue({ rounds: [{ id: 'r' }] });
    await expect(api.listR1Rounds('c')).resolves.toEqual({ rounds: [{ id: 'r' }] });
  });

  it('reads one round\'s notes, encoding the id', async () => {
    await api.listRoundNotes('round 1/../x');
    expect(request).toHaveBeenCalledWith('/api/notes/rounds/round%201%2F..%2Fx');
  });

  it('sends a note with its moment', async () => {
    await api.addNote('c-1', 'Good recovery.', { round_id: 'r-1', session_id: 's-1', media_ms: 462000 });
    const [path, init] = request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/notes');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ candidate_id: 'c-1', note: 'Good recovery.', round_id: 'r-1', session_id: 's-1', media_ms: 462000 });
  });

  it('sends a candidate note as it always did', async () => {
    await api.addNote('c-1', 'Follow up.');
    const [, init] = request.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ candidate_id: 'c-1', note: 'Follow up.' });
  });
});
