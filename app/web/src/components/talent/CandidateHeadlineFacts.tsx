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

/** Shared shape; tone is the only thing that varies. */
function Pill({
  tone,
  attr,
  value,
  caption,
}: {
  tone: 'info' | 'success';
  attr: string;
  value: string;
  caption?: string;
}) {
  return (
    <span
      {...{ [attr]: '' }}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums text-ink ${
        tone === 'success' ? 'bg-success-soft' : 'bg-info-soft'
      }`}
    >
      {value}
      {caption && <span className="font-normal text-ink-secondary">{caption}</span>}
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {roleTitle && (
        <span
          data-candidate-role-title=""
          className="inline-flex items-center rounded-full bg-info-soft px-2.5 py-1 text-[13px] font-medium text-ink"
        >
          {/* The other two pills caption themselves ("on the call", "words
              spoken"); this one is bare text in a coloured capsule, so a
              screen reader would hear "Sales Advisor" with nothing saying
              what it is. `Tag` already uses this idiom with srPrefix. */}
          <span className="sr-only">Role: </span>
          {roleTitle}
        </span>
      )}
      {hasCall && (
        <Pill
          tone="success"
          attr="data-candidate-call-length"
          value={formatDurationSec(callSeconds as number)}
          // Says WHAT was measured. There is no per-speaker talk time in this
          // system, so "on the call" is the honest caption.
          caption="on the call"
        />
      )}
      {hasWords && (
        <Pill
          tone="info"
          attr="data-candidate-words"
          value={(candidateWords as number).toLocaleString()}
          caption={candidateWords === 1 ? 'word spoken' : 'words spoken'}
        />
      )}
    </div>
  );
}
