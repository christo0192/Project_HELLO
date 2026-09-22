/**
 * The three pills under a candidate's name, tested directly.
 *
 * WHY DIRECTLY. Every assertion about these badges went through
 * `CandidateDetailPage`, and the page applies its own guard first:
 * `longestSession` skips any session with `duration_sec <= 0`, so a
 * zero-length call never reaches this component at all. The two guards are
 * mutually redundant through that path, and a review proved it — relaxing
 * `callSeconds > 0` to `>= 0` here kept the page suite green.
 *
 * They are not redundant in principle: this component is exported and the
 * page's rule could change. Zero is reachable —
 * `0024_recovery_audit_system_actor.sql` writes
 * `greatest(0, floor(extract(epoch from (ended_at - started_at))))` — so a
 * badge reading "0m 0s on the call" is a real possibility, and it is a claim
 * that is both precise and wrong.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CandidateHeadlineFacts } from '../CandidateHeadlineFacts';

describe('CandidateHeadlineFacts', () => {
  it('shows NO call badge for a zero-length call', () => {
    render(<CandidateHeadlineFacts callSeconds={0} />);
    expect(document.querySelector('[data-candidate-call-length]')).toBeNull();
  });

  it('shows NO call badge for a negative duration either', () => {
    // A clock that went backwards is not a call that lasted a negative time.
    render(<CandidateHeadlineFacts callSeconds={-5} />);
    expect(document.querySelector('[data-candidate-call-length]')).toBeNull();
  });

  it('shows NO call badge for a non-finite duration', () => {
    // `Number.isFinite` is the only guard that catches Infinity — `NaN > 0`
    // is already false, so the `> 0` test covers that half on its own. Pinned
    // because a badge reading "Infinitym Infinitys on the call" is the kind
    // of thing that only ever appears in a screenshot from a customer.
    render(<CandidateHeadlineFacts callSeconds={Number.POSITIVE_INFINITY} />);
    expect(document.querySelector('[data-candidate-call-length]')).toBeNull();
  });

  it('SHOWS one for a real call, captioned for what it measures', () => {
    render(<CandidateHeadlineFacts callSeconds={434} />);
    const badge = document.querySelector('[data-candidate-call-length]');
    expect(badge?.textContent).toContain('7m 14s');
    // "on the call", never "spoke": `duration_sec` is wall clock — bot speech,
    // candidate speech, ring and silence — and no per-speaker talk time is
    // stored anywhere in this system.
    expect(badge?.textContent).toContain('on the call');
    expect(badge?.textContent).not.toMatch(/spoke|talk/i);
  });

  it('shows a REAL ZERO for words, which is a fact about the candidate', () => {
    // Unlike the duration, zero words on a call that has a transcript is a
    // true and useful statement: they said nothing.
    render(<CandidateHeadlineFacts callSeconds={434} candidateWords={0} />);
    expect(document.querySelector('[data-candidate-words]')?.textContent).toContain('0');
  });

  it('shows NOTHING about words when the count is unknown', () => {
    // Null is not zero. Zero accuses the candidate of silence; null says we
    // hold no transcript, which is a fact about us.
    render(<CandidateHeadlineFacts callSeconds={434} candidateWords={null} />);
    expect(document.querySelector('[data-candidate-words]')).toBeNull();
  });

  it('singularises one word', () => {
    render(<CandidateHeadlineFacts callSeconds={434} candidateWords={1} />);
    expect(document.querySelector('[data-candidate-words]')?.textContent).toContain(
      'word spoken',
    );
  });

  it('LABELS the role for a screen reader', () => {
    // The other two pills caption themselves; this one is bare text in a
    // coloured capsule.
    render(<CandidateHeadlineFacts roleTitle="Sales Advisor" />);
    const pill = document.querySelector('[data-candidate-role-title]');
    expect(pill?.textContent).toContain('Role:');
    expect(pill?.textContent).toContain('Sales Advisor');
  });

  it('renders NOTHING AT ALL when there is nothing true to say', () => {
    const { container } = render(<CandidateHeadlineFacts />);
    expect(container.firstChild).toBeNull();
  });
});
