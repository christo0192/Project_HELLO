/**
 * Ashby invite delivery domain — mode fan-out, one-active-invite gate,
 * token-free manual channel, provider-gated email, idempotent key, reissue
 * (revoke-then-issue). (Wave 2 work item 5.)
 */

import { describe, it, expect } from 'vitest';
import {
  channelsForMode,
  isValidDeliveryMode,
  decideInviteIssue,
  buildManualDelivery,
  isManualArtifactSafe,
  decideEmailSend,
  inviteDeliveryOperationKey,
  planReissue,
  INVITE_TTL_HOURS,
} from '../integrations/ashby/invite-delivery.js';

describe('delivery modes', () => {
  it('validates modes and fans out channels', () => {
    expect(isValidDeliveryMode('both')).toBe(true);
    expect(isValidDeliveryMode('sms')).toBe(false);
    expect(channelsForMode('email')).toEqual({ email: true, manual: false });
    expect(channelsForMode('manual')).toEqual({ email: false, manual: true });
    expect(channelsForMode('both')).toEqual({ email: true, manual: true });
  });
  it('fixes the TTL at 24h', () => {
    expect(INVITE_TTL_HOURS).toBe(24);
  });
});

describe('decideInviteIssue — one active invite per application', () => {
  it('reuses an active invite, issues when none, blocks when terminal', () => {
    expect(decideInviteIssue(null, false)).toEqual({ action: 'issue' });
    expect(decideInviteIssue({ status: 'active' }, false)).toEqual({ action: 'reuse_active' });
    expect(decideInviteIssue({ status: 'revoked' }, false)).toEqual({ action: 'issue' });
    expect(decideInviteIssue({ status: 'active' }, true)).toEqual({ action: 'blocked_terminal' });
  });
});

describe('manual channel — token-free indirection', () => {
  it('builds a blocked artifact carrying only a relative reissue path', () => {
    const r = buildManualDelivery({ externalApplicationId: 'app_1', recruiterReissuePath: '/mission-control/ashby/app_1/reissue' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.artifact.deliveryState).toBe('blocked');
      expect(r.artifact.recruiterReissuePath.startsWith('/')).toBe(true);
      expect(isManualArtifactSafe(r.artifact)).toBe(true);
    }
  });

  it('rejects an absolute reissue URL', () => {
    expect(buildManualDelivery({ externalApplicationId: 'app_1', recruiterReissuePath: 'https://x/y' })).toEqual({
      ok: false,
      reason: 'invalid_reissue_path',
    });
  });

  it('rejects an empty application id', () => {
    expect(buildManualDelivery({ externalApplicationId: '', recruiterReissuePath: '/x' })).toEqual({
      ok: false,
      reason: 'invalid_application_id',
    });
  });

  it('flags any token-shaped field in a manual artifact', () => {
    expect(isManualArtifactSafe({ token: 'abc' })).toBe(false);
    expect(isManualArtifactSafe({ invite_url: 'https://x' })).toBe(false);
    expect(isManualArtifactSafe({ bearer: 'x' })).toBe(false);
    expect(isManualArtifactSafe({ note: 'manual_reissue_required', path: '/x' })).toBe(true);
  });
});

describe('email provider gate', () => {
  it('sends only when provider approved AND domain verified', () => {
    expect(decideEmailSend({ providerApproved: true, domainVerified: true })).toEqual({ action: 'send' });
    expect(decideEmailSend({ providerApproved: true, domainVerified: false })).toEqual({
      action: 'blocked',
      reason: 'provider_gated',
    });
    expect(decideEmailSend({ providerApproved: false, domainVerified: true })).toEqual({
      action: 'blocked',
      reason: 'provider_gated',
    });
  });
});

describe('idempotency + reissue', () => {
  it('produces a stable, token-free delivery operation key', () => {
    const k1 = inviteDeliveryOperationKey({ externalApplicationId: 'app_1', channel: 'email', inviteId: 'inv_1' });
    const k2 = inviteDeliveryOperationKey({ externalApplicationId: 'app_1', channel: 'email', inviteId: 'inv_1' });
    expect(k1).toBe(k2);
    expect(k1).not.toContain('token');
    expect(inviteDeliveryOperationKey({ externalApplicationId: 'app_1', channel: 'manual', inviteId: 'inv_1' })).not.toBe(k1);
  });

  it('reissue revokes the prior invite then issues a new one', () => {
    expect(planReissue('inv_old')).toEqual({ revokeInviteId: 'inv_old', issueNew: true });
    expect(planReissue(null)).toEqual({ revokeInviteId: null, issueNew: true });
  });
});
