/**
 * The candidate page's headline score, top right of the header.
 *
 * The score is the first thing a reviewer wants, so it sits beside the name
 * rather than inside the Review tab (which keeps its own full scorecard). It
 * is the candidate's LATEST SCREENING: the newest phone assessment, the same
 * figure the Candidates list shows. It deliberately does not follow the
 * Review tab's session picker, so the number never changes under the reader
 * when they open an older call.
 *
 *  - an R1 (WebRTC sales role-play) assessment is never the screening score;
 *    the Candidates list drops them the same way;
 *  - never 0 for "no score": an unreadable or absent figure reads "Not scored";
 *  - the figure stays in ink and the recommendation pill carries the tone, so
 *    colour is never the only signal (same rule as ScoreVerdict);
 *  - held for evidence (C3) and provisional (incomplete metrics) are said in
 *    words, not by dimming alone.
 *
 * Hidden by the caller while decision use is blocked (an appeal): scorecards
 * are suppressed on the Review tab too.
 */

import type { Assessment, Session } from '../../types';
import { latestScreeningAssessment } from '../../lib/latest-screening-assessment';
import { finiteNumber, readRoleScorecard, recommendationMeta } from '../session/scorecard-read';
import { PILL_DOT, PILL_TONE } from '../session/ScoreVerdict';
import { SurfaceCard, Tag } from '../design/candidate';
import { cx } from '../design/cx';
import { formatDate } from '../../lib/datetime';
import { isEvidenceInsufficient } from '../../lib/evidence-hold';

interface HeaderScoreReading {
  score: number | null;
  recommendation: unknown;
  provisional: boolean;
}

function readScore(assessment: Assessment): HeaderScoreReading {
  const v2 = readRoleScorecard(assessment);
  if (v2) {
    return {
      score: finiteNumber(v2.overallScore),
      recommendation: v2.recommendation,
      provisional: v2.status === 'incomplete_evidence',
    };
  }
  return {
    score: finiteNumber(assessment.overall_score),
    recommendation: assessment.recommendation,
    provisional: false,
  };
}

export interface HeaderScoreProps {
  assessments: readonly Assessment[];
  sessions: readonly Session[];
  className?: string;
}

export function HeaderScore({ assessments, sessions, className }: HeaderScoreProps) {
  const latest = latestScreeningAssessment(assessments, sessions);
  const reading = latest ? readScore(latest) : null;
  const score = reading?.score == null ? null : Math.round(reading.score);
  const reco = reading ? recommendationMeta(reading.recommendation) : null;
  const held = latest ? isEvidenceInsufficient(latest) : false;
  const date = latest?.created_at ? formatDate(latest.created_at) : null;

  const pills =
    score != null && (reco || reading?.provisional || held) ? (
      <>
        {reco && (
          <span
            data-recommendation={reco.tone}
            className={cx(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-label font-semibold',
              PILL_TONE[reco.tone],
            )}
          >
            <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', PILL_DOT[reco.tone])} />
            {reco.label}
          </span>
        )}
        {held ? (
          <Tag tone="caution">Held: not enough evidence</Tag>
        ) : reading?.provisional ? (
          <Tag tone="caution">Provisional</Tag>
        ) : null}
      </>
    ) : null;

  return (
    <SurfaceCard
      as="section"
      label="Latest screening score"
      className={cx('w-full px-3.5 py-2.5 sm:w-auto sm:max-w-[22rem] sm:text-right', className)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:justify-end">
        {score == null ? (
          <p className="text-[15px] font-semibold leading-8 text-ink-secondary">Not scored</p>
        ) : (
          <p className={cx('flex items-baseline gap-1.5', held ? 'text-ink-secondary' : 'text-ink')}>
            <span className="text-stat leading-none tabular-nums">{score}</span>
            <span className="text-sm tabular-nums text-ink-tertiary">/ 100</span>
          </p>
        )}
        {pills && <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">{pills}</div>}
      </div>

      <p className="mt-1 text-meta text-ink-tertiary">
        {latest ? `Latest screening${date && date !== 'Not available' ? ` · ${date}` : ''}` : 'No screening yet'}
      </p>
    </SurfaceCard>
  );
}
