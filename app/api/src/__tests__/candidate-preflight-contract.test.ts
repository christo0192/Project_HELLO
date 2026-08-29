import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/routes/invites.ts'), 'utf8');
const auth = readFileSync(resolve(process.cwd(), 'src/lib/auth.ts'), 'utf8');

describe('candidate LiveKit preflight contract', () => {
  it('is a public, strict, non-consuming route', () => {
    expect(source).toContain("'/preflight'");
    expect(source).toContain('invitePreflightSchema');
    expect(source).toContain('validateInvite(invite_token)');
    expect(source).toContain("res.status(409).json({ error: 'consent_required' })");
    expect(source).toContain("res.set('Cache-Control', 'no-store')");
    expect(auth).toContain("{ method: 'POST', path: '/api/livekit/preflight' }");
  });

  it('restricts diagnostic credentials to microphone publish', () => {
    expect(source).toContain("metadata: JSON.stringify({ channel: 'preflight', schema: 1 })");
    expect(source).toContain('canPublishSources: [TrackSource.MICROPHONE]');
    expect(source).toContain('canSubscribe: false');
    expect(source).toContain('canPublishData: false');
    expect(source).toContain("ttl: '2m'");
    expect(source).not.toContain('startAuthoritativeRecording(diagnosticRoom');
  });

  it('does not bind the diagnostic room to a candidate or screening session', () => {
    const block = source.slice(source.indexOf('const rooms = new RoomServiceClient'), source.indexOf("'/exchange'"));
    expect(block).not.toContain('candidate_id');
    expect(block).not.toContain('session_id');
    expect(block).not.toContain('createGrant');
    expect(block).not.toContain('consumed_at');
  });
});
