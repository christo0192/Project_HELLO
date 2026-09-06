/**
 * GOV-08: Privacy notice page scaffold.
 *
 * Displays a placeholder privacy notice with accept/decline consent options.
 * Legal copy is UNVERIFIED — do not use in production.
 *
 * INVARIANTS:
 * 1. All legal copy is placeholder only (GOV-08).
 * 2. Accept requires explicit consent for AI interview and recording (GOV-10).
 * 3. Decline navigates back to join page without consent.
 * 4. join_fails without consent evidence (GOV-09).
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Button, GlassPanel, InlineNotice } from '../components/design';
import type { ConsentType } from '../types';

/** Placeholder privacy notice body — NOT Legal-approved. */
const PLACEHOLDER_NOTICE = `# Privacy Notice

**PLACEHOLDER — Legal copy unapproved.**
This privacy notice is a scaffold for the consent flow.
Legal-approved copy must replace this before production use.

## Data Collected
- Name, email, phone number
- Resume and work history
- Voice recording and transcript from AI screening interview
- Assessment scorecard

## Purpose
Your data is processed for recruitment screening purposes only.

## Data Processors
- In-region hosting (India)
- Axiom (US) — redacted operational logs only

## Retention
Data is retained for the duration of the recruitment process
and as required by applicable law.

## Your Rights
You may access, correct, delete, or port your data.
Contact the hiring team to exercise your rights.

## Consent
By accepting, you consent to AI-conducted voice interview,
recording, and data processing for recruitment purposes.
You may decline or withdraw consent at any time.`;

const REQUIRED_CONSENTS: ConsentType[] = [
  'ai_interview',
  'recording',
  'purpose',
  'data_processing',
];

/**
 * Renders the placeholder notice with document typography.
 *
 * The notice constant above stays the single, byte-identical source of the
 * copy; this only chooses the element for each line (`#`/`##` headings,
 * `-` list items, `**…**` lead-in, paragraphs). No words are added,
 * removed or reordered.
 */
function NoticeBody({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(
      <p key={`p-${blocks.length}`} className="text-sm leading-6 text-ink-secondary">
        {paragraph.join(' ')}
      </p>,
    );
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="ml-5 list-disc space-y-1 text-sm leading-6 text-ink-secondary">
        {bullets.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flush = () => {
    flushParagraph();
    flushBullets();
  };

  for (const line of source.split('\n')) {
    const text = line.trim();
    if (text === '') {
      flush();
    } else if (text.startsWith('## ')) {
      flush();
      blocks.push(
        <h2
          key={`h2-${blocks.length}`}
          className="mt-6 text-[15px] font-semibold tracking-[-0.01em] text-ink first:mt-0"
        >
          {text.slice(3)}
        </h2>,
      );
    } else if (text.startsWith('# ')) {
      flush();
      blocks.push(
        <h1 key={`h1-${blocks.length}`} className="text-title text-ink">
          {text.slice(2)}
        </h1>,
      );
    } else if (text.startsWith('- ')) {
      flushParagraph();
      bullets.push(text.slice(2));
    } else if (text.startsWith('**') && text.endsWith('**')) {
      flush();
      blocks.push(
        <p key={`lead-${blocks.length}`} className="text-sm font-semibold leading-6 text-ink">
          {text.slice(2, -2)}
        </p>,
      );
    } else {
      flushBullets();
      paragraph.push(text);
    }
  }
  flush();

  return <div className="space-y-3">{blocks}</div>;
}

interface PrivacyNoticePageProps {
  /** Override candidate_id for testing. */
  candidateId?: string;
  /** Override consent submission for testing. */
  onSubmitConsent?: (
    candidateId: string,
    consents: ConsentType[],
    status: 'granted' | 'declined',
  ) => Promise<void>;
}

export function PrivacyNoticePage({
  candidateId: propCandidateId,
  onSubmitConsent,
}: PrivacyNoticePageProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const candidateId = propCandidateId ?? searchParams.get('candidate_id') ?? '';

  const [status, setStatus] = useState<'idle' | 'accepting' | 'declining'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    if (!candidateId) {
      setError('Missing candidate identifier.');
      return;
    }
    setStatus('accepting');
    setError(null);
    try {
      if (onSubmitConsent) {
        await onSubmitConsent(candidateId, REQUIRED_CONSENTS, 'granted');
      } else {
        await api.submitConsent({
          candidate_id: candidateId,
          version: '1.0',
          consents: REQUIRED_CONSENTS,
          status: 'granted',
          proof: {
            notice_version: '1.0',
            captured_at: new Date().toISOString(),
          },
        });
      }
      // Navigate to join with consent
      navigate(`/candidate/join?candidate_id=${encodeURIComponent(candidateId)}&consent=true`);
    } catch (err) {
      setStatus('idle');
      setError(err instanceof ApiError ? err.message : 'Failed to record consent.');
    }
  }

  async function handleDecline() {
    if (!candidateId) {
      setError('Missing candidate identifier.');
      return;
    }
    setStatus('declining');
    setError(null);
    try {
      if (onSubmitConsent) {
        await onSubmitConsent(candidateId, [], 'declined');
      } else {
        await api.submitConsent({
          candidate_id: candidateId,
          version: '1.0',
          consents: [],
          status: 'declined',
          proof: {
            notice_version: '1.0',
            captured_at: new Date().toISOString(),
            note: 'Candidate declined all consent types.',
          },
        });
      }
      // Navigate back to join with declined status
      navigate(`/candidate/join?candidate_id=${encodeURIComponent(candidateId)}&consent=declined`);
    } catch (err) {
      setStatus('idle');
      setError(err instanceof ApiError ? err.message : 'Failed to record consent decline.');
    }
  }

  return (
    <div className="app-ground flex min-h-screen items-start justify-center px-4 py-10">
      <main className="w-full max-w-3xl">
        <GlassPanel level="strong" padding="lg">
          <NoticeBody source={PLACEHOLDER_NOTICE} />

          <div className="mt-8 flex flex-wrap gap-3">
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              onClick={handleAccept}
              loading={status === 'accepting'}
              disabled={status === 'declining'}
            >
              Accept
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={handleDecline}
              loading={status === 'declining'}
              disabled={status === 'accepting'}
            >
              Decline
            </Button>
          </div>

          {error && (
            <InlineNotice tone="danger" role="alert" className="mt-4">
              {error}
            </InlineNotice>
          )}

          <p className="mt-4 text-xs leading-5 text-ink-tertiary">
            This is a placeholder privacy notice. Legal-approved copy is pending.
          </p>
        </GlassPanel>
      </main>
    </div>
  );
}
