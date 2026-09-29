/**
 * The three facts that go directly under a candidate's name: which role, how
 * long the call ran, and how much the candidate actually said.
 *
 * WHY HERE AND NOT IN A CARD. The call length used to live in the Live-call
 * panel on the far right, below the fold on a laptop — the last place someone
 * scanning a candidate looks. The role was not on this page at all. These
 * answer "who is this and did we actually talk to them", which is what a
 * manager needs before reading anything else.
 *
 * EACH BADGE IS ABSENT RATHER THAN GUESSED. A wrong role on a candidate page
 * is worse than no role, and "0m 0s" or "0 words" read as facts about the
 * candidate when they are really facts about our data.
 */
import type { ReactNode } from 'react';
import { formatDurationSec } from './status';

export interface CandidateHeadlineFactsProps {
  /** Resolved role title, or null when it could not be resolved. */
  roleTitle?: string | null;
  /**
   * Length of the screening CALL, in seconds.
   *
   * NOT "how long the candidate spoke" — no per-speaker talk-time metric
   * exists anywhere in this system. `sessions.duration_sec` is wall clock:
   * the bot's speech, the candidate's, the ring and every silence. It is
   * labelled for what it measures, because a figure captioned "candidate
   * spoke for 7m 14s" would be read as engagement and is not that.
   */
  callSeconds?: number | null;
  /**
   * Words the candidate said on that same call, or null when no transcript
   * was read. Shown BESIDE the call length because the pair is the point: a
   * long call with very few candidate words is a call where they could not
   * get a word in.
   */
  candidateWords?: number | null;
}

/**
 * One fact: the FIGURE in the ink at weight 600, its caption in secondary
 * ink. Plain text on the page ground, not a tinted capsule: three coloured
 * pills under a name read as chips to click, and colour carried no meaning
 * here anyway (role, length and words are not states).
 */
function Fact({
  attr,
  value,
  caption,
}: {
  attr: string;
  value: string;
  caption?: string;
}) {
  return (
    <span {...{ [attr]: '' }} className="whitespace-nowrap">
      <span className="font-semibold tabular-nums text-ink">{value}</span>
      {caption && <span className="text-ink-secondary"> {caption}</span>}
    </span>
  );
}

/** A hairline dot between facts; decorative, so hidden from AT. */
function Sep() {
  return (
    <span aria-hidden="true" className="text-ink-tertiary">
      ·
    </span>
  );
}

export function CandidateHeadlineFacts({
  roleTitle,
  callSeconds,
  candidateWords,
}: CandidateHeadlineFactsProps) {
  const hasCall = typeof callSeconds === 'number' && Number.isFinite(callSeconds) && callSeconds > 0;
  const hasWords = typeof candidateWords === 'number' && Number.isFinite(candidateWords);
  if (!roleTitle && !hasCall && !hasWords) return null;

  const facts: ReactNode[] = [];
  if (roleTitle) {
    facts.push(
      <span key="role" data-candidate-role-title="" className="font-medium text-ink">
        {/* The other two facts caption themselves ("on the call", "words
            spoken"); a bare role title would be heard as "Sales Advisor"
            with nothing saying what it is. `Tag` uses this idiom too. */}
        <span className="sr-only">Role: </span>
        {roleTitle}
      </span>,
    );
  }
  if (hasCall) {
    facts.push(
      <Fact
        key="call"
        attr="data-candidate-call-length"
        value={formatDurationSec(callSeconds as number)}
        // Says WHAT was measured. There is no per-speaker talk time in this
        // system, so "on the call" is the honest caption.
        caption="on the call"
      />,
    );
  }
  if (hasWords) {
    facts.push(
      <Fact
        key="words"
        attr="data-candidate-words"
        value={(candidateWords as number).toLocaleString()}
        caption={candidateWords === 1 ? 'word spoken' : 'words spoken'}
      />,
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-label">
      {facts.flatMap((fact, i) => (i === 0 ? [fact] : [<Sep key={`sep-${i}`} />, fact]))}
    </span>
  );
}
