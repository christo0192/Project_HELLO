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
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Button, Card } from '../components/ui';
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
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-4 py-8">
      <Card className="w-full p-6">
        <h1 className="text-xl font-semibold text-gray-900">Privacy Notice</h1>
        <div className="mt-4 prose prose-sm max-w-none text-gray-700 whitespace-pre-line">
          {PLACEHOLDER_NOTICE}
        </div>

        <div className="mt-6 flex gap-4">
          <Button
            className="flex-1"
            onClick={handleAccept}
            loading={status === 'accepting'}
            disabled={status === 'declining'}
          >
            Accept
          </Button>
          <Button
            className="flex-1"
            variant="secondary"
            onClick={handleDecline}
            loading={status === 'declining'}
            disabled={status === 'accepting'}
          >
            Decline
          </Button>
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>
        )}

        <p className="mt-4 text-xs text-gray-500">
          This is a placeholder privacy notice. Legal-approved copy is pending.
        </p>
      </Card>
    </main>
  );
}
