/**
 * Phone fence: PR-R1 must not change the shared worker-context lookup shape or
 * payload for canonical phone rooms. This is deliberately a call-log assertion,
 * not merely a successful mock response.
 */
import { describe, expect, it, vi } from 'vitest';

const SID = '7c2a2b21-5826-4d81-b1e0-24a5f3ce3f11';
const ROOM = `phone-${SID}`;
const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

function query(table: string): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  q.select = (...args: unknown[]) => { calls.push({ table, method: 'select', args }); return q; };
  q.eq = (...args: unknown[]) => { calls.push({ table, method: 'eq', args }); return q; };
  q.maybeSingle = async () => {
    calls.push({ table, method: 'maybeSingle', args: [] });
    if (table === 'call_sessions') return { data: { id: SID, candidate_id: 'candidate-1', role_id: 'role-1', status: 'waiting', external_call_id: ROOM }, error: null };
    return { data: { title: 'Phone role', jd: 'Screen calls', required_skills: ['sales'], screening_template: [], interviewer_instructions: 'Be concise' }, error: null };
  };
  q.single = async () => {
    calls.push({ table, method: 'single', args: [] });
    return { data: { name: 'Phone Candidate', parsed: null }, error: null };
  };
  return q;
}

vi.mock('../lib/supabase.js', () => ({ supabase: { from: (table: string) => query(table) } }));

import { resolveWorkerContext } from '../lib/worker-context.js';

describe('phone worker-context fence', () => {
  it('keeps the phone PostgREST calls and returned payload byte-for-byte shaped', async () => {
    calls.length = 0;
    await expect(resolveWorkerContext(SID, ROOM)).resolves.toEqual({
      ok: true,
      context: {
        session_id: SID, candidate_id: 'candidate-1', role_id: 'role-1', candidate_name: 'Phone Candidate',
        room_name: ROOM, status: 'waiting', role_title: 'Phone role', role_focus: 'Screen calls',
        role_required_skills: ['sales'], screening_template: [], interviewer_instructions: 'Be concise', candidate_evidence: {},
      },
    });
    expect(calls).toEqual([
      { table: 'call_sessions', method: 'select', args: ['id, candidate_id, role_id, status, external_call_id'] },
      { table: 'call_sessions', method: 'eq', args: ['id', SID] },
      { table: 'call_sessions', method: 'maybeSingle', args: [] },
      { table: 'candidates', method: 'select', args: ['name,parsed'] },
      { table: 'candidates', method: 'eq', args: ['id', 'candidate-1'] },
      { table: 'candidates', method: 'single', args: [] },
      { table: 'roles', method: 'select', args: ['title,jd,required_skills,screening_template,interviewer_instructions'] },
      { table: 'roles', method: 'eq', args: ['id', 'role-1'] },
      { table: 'roles', method: 'maybeSingle', args: [] },
    ]);
  });
});
