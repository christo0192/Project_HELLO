/**
 * buildReportHtml: the stakeholder report as ONE self-contained HTML string.
 *
 * Pure: a function of `ReportData` only. Rules that matter:
 *  - every dynamic string goes through `escapeHtml`; nothing is concatenated
 *    into markup any other way, and no data ever reaches the inline script;
 *  - audio is embedded as `data:` URIs on `<audio controls>` so the file plays
 *    offline in any browser; no signed URL, token or storage key is written;
 *  - the document carries its own Content-Security-Policy whose `script-src`
 *    is the SHA-256 of the one inline script, so a script injected through a
 *    missed escape would not run;
 *  - leg grouping, offsets and the words used for each call come from the SAME
 *    helpers the Review tab uses (`components/talent/sessionLegs`), imported,
 *    never copied, so the two surfaces cannot drift apart.
 */

import { latestScreeningAssessment } from '../latest-screening-assessment';
import type {
  Assessment,
  CandidatePhoneAttempt,
  CandidateResumeFacts,
  ResumeConflict,
  RoleFitScore,
  Session,
} from '../../types';
import {
  LEGACY_SCORE_LABELS_5,
  SCORE_LABELS,
  isAssessmentV2,
  readScorecardAssessmentV2,
} from '../../types';
import {
  LEG_TAIL_NOTE,
  groupTurnsByLeg,
  legConnectedWords,
  legConsentTag,
  legName,
  legNoAudioLabel,
  legPlayable,
  legRecordedWords,
  legRecordingShown,
  legTitle,
  legUnobservedNote,
  sessionLengthLabel,
  sortLegs,
} from '../../components/talent/sessionLegs';
import type { LegGroup, LegSeekMode } from '../../components/talent/sessionLegs';
import {
  attemptOutcomeLabel,
  candidateDisplayStatus,
  sessionStatusLabel,
} from '../../components/talent/status';
import { candidateDisplayName } from '../../components/talent/ResumeReviewBadge';
import { SECTION_WEIGHTS } from '../../components/talent/CandidateScorecard';
import { evidenceHoldReason, isEvidenceInsufficient } from '../evidence-hold';
import { formatDateTime } from '../datetime';
import { formatPhone, humanizeEnum, shortId } from '../humanize';
import { sessionModeLabel } from '../session-mode';
import { presentTranscriptTurn } from '../transcript-presentation';
import { escapeHtml as e } from './escape';
import { REPORT_CSS } from './reportStyles';
import { REPORT_SCRIPT } from './reportScript';
import { cspScriptHash } from './sha256';
import type { ReportAudio, ReportAudioResult, ReportData, ReportSession } from './types';

/* ── small formatters ──────────────────────────────────────────────── */

/** `m:ss` from seconds. */
export function formatReportOffset(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const RECOMMENDATION_WORDS: Record<string, string> = {
  advance: 'Advance',
  hold: 'Hold',
  reject: 'Reject',
  human_review: 'Human review',
};

function recommendationWords(rec: string | null | undefined): string {
  if (!rec) return 'Unassessed';
  return RECOMMENDATION_WORDS[rec] ?? humanizeEnum(rec);
}

function recommendationTone(rec: string | null | undefined): 'pos' | 'warn' | 'neg' | '' {
  if (rec === 'advance') return 'pos';
  if (rec === 'reject') return 'neg';
  if (rec === 'hold' || rec === 'human_review') return 'warn';
  return '';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function list(items: readonly unknown[] | null | undefined): string[] {
  return Array.isArray(items) ? items.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function tags(items: readonly string[], tone: '' | 'pos' | 'warn' | 'neg' = ''): string {
  return items.map((item) => `<span class="tag${tone ? ` ${tone}` : ''}">${e(item)}</span>`).join('');
}

function bullets(items: readonly string[]): string {
  if (items.length === 0) return '';
  return `<ul>${items.map((item) => `<li>${e(item)}</li>`).join('')}</ul>`;
}

/** An audio mime that is safe to place in a `data:` URI; anything else is treated as MP3. */
function safeAudioMime(mime: string): string {
  return /^audio\/[a-z0-9][a-z0-9.+-]{0,40}$/i.test(mime) ? mime.toLowerCase() : 'audio/mpeg';
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** One `<audio>` element, or null when the bytes are not clean base64. */
function audioElement(audio: ReportAudio, label: string): string | null {
  if (!BASE64_RE.test(audio.base64) || audio.base64.length === 0) return null;
  const mime = safeAudioMime(audio.mime);
  const oggNote = mime.includes('ogg')
    ? '<p class="muted small">This recording is in OGG format. Safari cannot play it; open this file in Chrome, Edge or Firefox.</p>'
    : '';
  return (
    `<audio controls preload="metadata" data-audio-id="${e(audio.id)}" aria-label="${e(label)}" ` +
    `src="data:${mime};base64,${audio.base64}"></audio>${oggNote}`
  );
}

/** The recording's player, or the plain-words reason there is none. */
function playerOrNote(result: ReportAudioResult | undefined, label: string, absentNote: string): string {
  if (!result) return `<p class="muted small">${e(absentNote)}</p>`;
  if (result.kind === 'omitted') return `<p class="muted small">${e(result.reason)}</p>`;
  return (
    audioElement(result.audio, label) ??
    '<p class="muted small">Recording could not be embedded (unreadable audio data).</p>'
  );
}

function embeddedId(result: ReportAudioResult | null | undefined): string | null {
  return result && result.kind === 'embedded' && BASE64_RE.test(result.audio.base64) && result.audio.base64
    ? result.audio.id
    : null;
}

/* ── scorecards ────────────────────────────────────────────────────── */

function resumeConflictsOf(a: Assessment): ResumeConflict[] {
  const raw = a.raw as { resume_conflicts?: ResumeConflict[] } | null | undefined;
  const found = a.resume_conflicts ?? raw?.resume_conflicts;
  return Array.isArray(found) ? found : [];
}

function roleFitHasContent(rf: RoleFitScore | null | undefined): rf is RoleFitScore {
  if (!rf || typeof rf !== 'object') return false;
  return (
    list(rf.matched_skills).length > 0 ||
    list(rf.gaps).length > 0 ||
    list(rf.red_flags).length > 0 ||
    (typeof rf.notes === 'string' && rf.notes.trim() !== '') ||
    isFiniteNumber(rf.score)
  );
}

function scoreWords(score: number | null, scale: 4 | 5): string {
  if (score === null || !isFiniteNumber(score)) return 'Not scored (insufficient evidence)';
  const labels = (scale === 4 ? SCORE_LABELS : LEGACY_SCORE_LABELS_5) as Record<number, string>;
  const label = labels[score];
  return `${label ? `${label}, ` : ''}${score} of ${scale}`;
}

function roleFitBlock(rf: RoleFitScore | null | undefined): string {
  if (!roleFitHasContent(rf)) return '';
  const score = isFiniteNumber(rf.score) ? `<p><span class="score">${e(rf.score)}</span> <span class="muted">/ 10 role fit</span></p>` : '';
  const matched = list(rf.matched_skills);
  const gaps = list(rf.gaps);
  const flags = list(rf.red_flags);
  return (
    `<h4>Role fit</h4>${score}` +
    (matched.length ? `<p class="small muted">Matched skills</p><p>${tags(matched, 'pos')}</p>` : '') +
    (gaps.length ? `<p class="small muted">Gaps</p><p>${tags(gaps, 'warn')}</p>` : '') +
    (flags.length ? `<p class="small muted">Red flags</p><p>${tags(flags, 'neg')}</p>` : '') +
    (rf.notes && rf.notes.trim() ? `<p>${e(rf.notes)}</p>` : '')
  );
}

function conflictsBlock(a: Assessment): string {
  const conflicts = resumeConflictsOf(a);
  if (conflicts.length === 0) return '';
  const rows = conflicts
    .map(
      (c) =>
        `<tr><td>${e(c.topic)}</td><td>${e(c.resume_says)}</td><td>${e(c.candidate_said)}</td>` +
        `<td>${c.resolved ? 'Resolved' : 'Open'}${c.note ? `<br><span class="muted small">${e(c.note)}</span>` : ''}</td></tr>`,
    )
    .join('');
  return (
    `<h4>Resume conflicts</h4><div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Topic</th><th>Resume says</th>` +
    `<th>Candidate said</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

interface AssessmentMeta {
  createdAt: string | null;
  sessionId: string | null;
}

function assessmentMeta(a: Assessment): AssessmentMeta {
  const row = a as unknown as { created_at?: unknown; session_id?: unknown };
  return {
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
  };
}

function v1Dimensions(a: Assessment): string {
  const raw = (a.raw ?? {}) as Partial<Assessment>;
  const communication = a.communication ?? raw.communication;
  const english = communication?.english_proficiency ?? a.english;
  const motivation = a.motivation ?? raw.motivation;
  const tone = a.tone;
  const out10 = (v: unknown) => (isFiniteNumber(v) ? `${v} / 10` : 'Not available');
  const row = (name: string, weight: string, score: string, notes: string) =>
    `<tr><td>${e(name)}</td><td class="num">${e(weight)}</td><td class="score">${e(score)}</td><td>${e(notes)}</td></tr>`;
  const rows: string[] = [];
  rows.push(row('Communication', SECTION_WEIGHTS.communication, out10(communication?.score), communication?.notes ?? ''));
  rows.push(row('Motivation', SECTION_WEIGHTS.motivation, out10(motivation?.score), motivation?.notes ?? ''));
  if (tone) {
    const toneScore = [tone.clarity, tone.confidence, tone.professionalism].filter(isFiniteNumber);
    const mean = toneScore.length ? Math.round((toneScore.reduce((s, n) => s + n, 0) / toneScore.length) * 10) / 10 : null;
    rows.push(
      row(
        'Tone',
        SECTION_WEIGHTS.tone,
        out10(mean),
        [
          isFiniteNumber(tone.clarity) ? `Clarity ${tone.clarity}` : '',
          isFiniteNumber(tone.confidence) ? `Confidence ${tone.confidence}` : '',
          isFiniteNumber(tone.professionalism) ? `Professionalism ${tone.professionalism}` : '',
          tone.sentiment ? `Sentiment ${humanizeEnum(tone.sentiment)}` : '',
          tone.notes ?? '',
        ]
          .filter(Boolean)
          .join('. '),
      ),
    );
  }
  if (a.role_fit && isFiniteNumber(a.role_fit.score)) {
    rows.push(row('Role fit', SECTION_WEIGHTS.role_fit, out10(a.role_fit.score), a.role_fit.notes ?? ''));
  }
  const englishLine = english
    ? `<p class="small"><span class="muted">English band</span> ${e(english.band)}` +
      ` (grammar ${e(english.grammar)}, vocabulary ${e(english.vocabulary)}, fluency ${e(english.fluency)}, coherence ${e(english.coherence)})</p>`
    : '';
  return (
    `<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Signal</th><th>Weight</th><th>Score</th><th>Notes</th></tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table></div>${englishLine}`
  );
}

function v2Metrics(a: Assessment): string {
  const display = readScorecardAssessmentV2(a);
  if (!display) return '';
  const rows = display.metrics
    .map((m) => {
      const refs = list(m.evidenceRefs);
      const weight = m.weightBps !== null && isFiniteNumber(m.weightBps) ? `${Math.round(m.weightBps) / 100}%` : 'Not available';
      return (
        `<tr><td>${e(m.name)}</td><td class="score">${e(scoreWords(m.score as number | null, display.scoreScaleMax))}</td>` +
        `<td class="num">${e(weight)}</td><td>${e(m.rationale)}</td><td>${bullets(refs)}</td></tr>`
      );
    })
    .join('');
  return (
    `<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>Metric</th><th>Score</th><th>Weight</th><th>Rationale</th><th>Evidence</th></tr></thead>` +
    `<tbody>${rows || '<tr><td colspan="5" class="muted">No metrics were recorded.</td></tr>'}</tbody></table></div>`
  );
}

function scorecardBlock(a: Assessment, index: number, data: ReportData): string {
  const v2 = isAssessmentV2(a) ? readScorecardAssessmentV2(a) : null;
  const overall = v2 ? v2.overallScore : isFiniteNumber(a.overall_score) ? a.overall_score : null;
  const rec = v2 ? v2.recommendation : a.recommendation;
  const meta = assessmentMeta(a);
  const session = meta.sessionId ? data.sessions.find((s) => s.session.id === meta.sessionId)?.session ?? null : null;
  const titleParts = [index === 0 ? 'Latest scorecard' : 'Earlier scorecard'];
  if (meta.createdAt) titleParts.push(formatDateTime(meta.createdAt));
  const forSession = session ? `<p class="muted small">Scored from the ${e(sessionHeading(session))} session.</p>` : '';
  const provisional =
    v2 && v2.status === 'incomplete_evidence'
      ? '<p class="notice warn" role="note">Provisional: some metrics lacked enough evidence and are left out of the weighted score. Confirm before deciding.</p>'
      : '';
  const held = isEvidenceInsufficient(a)
    ? `<p class="notice warn" role="note">Held: insufficient evidence. ${e(evidenceHoldReason(a))}</p>`
    : '';
  const summary = typeof a.summary === 'string' && a.summary.trim() ? `<h4>Summary</h4><p>${e(a.summary)}</p>` : '';
  const weighted = v2 && isFiniteNumber(v2.weightedScore5)
    ? `<p class="muted small">Weighted score ${e(Math.round(v2.weightedScore5 * 100) / 100)} of ${e(v2.scoreScaleMax)} on the rubric.</p>`
    : '';
  return (
    `<div><h3>${e(titleParts.join(' · '))}</h3>${forSession}` +
    `<p><span class="score" style="font-size:1.5rem">${overall === null ? 'Not scored' : e(Math.round(overall))}</span>` +
    `${overall === null ? '' : ' <span class="muted">/ 100</span>'} ` +
    `<span class="tag ${recommendationTone(rec)}">${e(recommendationWords(rec))}</span></p>` +
    `${weighted}${provisional}${held}` +
    `${v2 ? v2Metrics(a) : v1Dimensions(a)}` +
    `${roleFitBlock(a.role_fit)}${conflictsBlock(a)}${summary}</div>`
  );
}

/** Ids of the R1 sales role-play sessions: their scores are not screening scores. */
function r1SessionIds(data: ReportData): Set<string> {
  const ids = data.sessions.filter((s) => s.session.interview_round_id != null).map((s) => s.session.id);
  (data.r1Sessions ?? []).forEach((s) => ids.push(s.id));
  return new Set(ids);
}

function isR1Assessment(a: Assessment, r1: Set<string>): boolean {
  return !!a.session_id && r1.has(a.session_id);
}

/**
 * Every SCREENING scorecard: the candidate's list, plus any session scorecard
 * not in it. R1 role-play assessments are left out (the same rule as the page
 * header's latestScreeningAssessment); the report says so.
 */
export function reportAssessments(data: ReportData): Assessment[] {
  const r1 = r1SessionIds(data);
  const seen = new Set<string>();
  const out: Assessment[] = [];
  const add = (a: Assessment | null | undefined) => {
    if (!a || isR1Assessment(a, r1)) return;
    const key = a.id ?? `${assessmentMeta(a).createdAt ?? ''}:${JSON.stringify([a.overall_score, a.recommendation])}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };
  data.assessments.forEach(add);
  data.sessions.forEach((s) => add(s.assessment));
  return out;
}

/* ── sessions, calls, transcript ───────────────────────────────────── */

function sessionHeading(session: Session): string {
  return `${formatDateTime(session.created_at ?? session.started_at)} · ${sessionModeLabel(session.mode)}`;
}

function turnRow(
  turn: { speaker: 'bot' | 'candidate'; text: string; start_offset_sec?: number | null; is_gate?: boolean },
  audioId: string | null,
  approximate: boolean,
): string {
  const presented = presentTranscriptTurn(turn.speaker, turn.text);
  const who = presented.label + (turn.is_gate ? ' (consent step)' : '');
  const offset = turn.start_offset_sec;
  let cell: string;
  if (isFiniteNumber(offset) && offset >= 0) {
    const stamp = `${approximate ? '≈' : ''}${formatReportOffset(offset)}`;
    cell = audioId
      ? `<button type="button" class="ts" data-audio="${e(audioId)}" data-t="${e(Math.round(offset * 1000) / 1000)}" ` +
        `aria-label="${e(`Play from ${stamp}`)}">${e(stamp)}</button><span class="ts-plain-print">${e(stamp)}</span>`
      : `<span class="ts-plain">${e(stamp)}</span>`;
  } else {
    cell = '<span class="ts-plain">no timing</span>';
  }
  return (
    `<li data-who="${e(presented.label === 'Candidate' ? 'Candidate' : 'Bot')}"><div class="tcell">${cell}</div>` +
    `<div><span class="who">${e(who)}</span><p class="turn-text">${e(presented.text)}</p></div></li>`
  );
}

function legCard(leg: CandidatePhoneAttempt, index: number, total: number, rs: ReportSession): string {
  const facts: string[] = [e(legConnectedWords(leg))];
  const recorded = legRecordingShown(leg) ? legRecordedWords(leg) : null;
  if (recorded) facts.push(e(recorded));
  const unobserved = legUnobservedNote(leg);
  const consent = legConsentTag(leg.consent_stage);
  let player: string;
  if (!legPlayable(leg)) {
    player = `<p class="muted small">${e(legNoAudioLabel(leg.recording.reason))}</p>`;
  } else {
    player = playerOrNote(rs.legAudio[leg.id], `${legName(index, total)} recording`, 'Recording not included in this report.');
  }
  return (
    `<div class="call"><h4>${e(legTitle(index, total))}</h4>` +
    `<p class="small muted">${facts.join(' · ')}</p>` +
    (unobserved ? `<p class="small muted">${e(unobserved)}</p>` : '') +
    (consent ? `<p><span class="tag warn">${e(consent.label)}</span> <span class="small muted">${e(consent.note)}</span></p>` : '') +
    (leg.tail_may_be_missing ? `<p class="small muted">${e(LEG_TAIL_NOTE)}</p>` : '') +
    `${player}</div>`
  );
}

function transcriptHtml(rs: ReportSession, legs: CandidatePhoneAttempt[], seekMode: LegSeekMode): string {
  if (rs.transcript === null) {
    return `<h3>Transcript</h3><p class="notice">${e(rs.transcriptNote ?? 'The transcript is not included.')}</p>`;
  }
  if (rs.transcript.length === 0) return '<h3>Transcript</h3><p class="muted">No transcript was recorded for this session.</p>';
  const sessionAudioId = embeddedId(rs.sessionAudio);
  const header = `<h3>Transcript <span class="muted small">(${rs.transcript.length} turns)</span></h3>`;
  const hint = '<p class="muted small">Select a timestamp to play the call from that moment.</p>';
  if (legs.length === 0) {
    const rows = rs.transcript.map((t) => turnRow(t, sessionAudioId, false)).join('');
    return `${header}${hint}<ol class="transcript">${rows}</ol>`;
  }
  const groups: LegGroup[] = groupTurnsByLeg(rs.transcript, legs, rs.session.recording_egress_started_at_ms, seekMode);
  const blocks = groups
    .map((g) => {
      const leg = g.legIndex === null ? null : legs[g.legIndex];
      const heading =
        g.legIndex === null
          ? 'No timing available'
          : legTitle(g.legIndex, legs.length);
      const audioId =
        seekMode === 'session'
          ? sessionAudioId
          : leg
            ? embeddedId(rs.legAudio[leg.id])
            : null;
      const rows = g.turns.map((lt) => turnRow(lt.turn, audioId, g.approximate)).join('');
      const note =
        leg && seekMode === 'leg' && !legPlayable(leg)
          ? '<p class="muted small">This call has no playable recording, so its turns cannot start playback.</p>'
          : '';
      return `<h4>${e(heading)}</h4>${note}<ol class="transcript">${rows}</ol>`;
    })
    .join('');
  return `${header}${hint}${blocks}`;
}

function sessionBlock(rs: ReportSession, index: number): string {
  const s = rs.session;
  const length = sessionLengthLabel(s);
  const legs = sortLegs(rs.legs);
  const seekMode: LegSeekMode = legs.some(legPlayable) ? 'leg' : 'session';
  const facts = [sessionStatusLabel(s.status), length].filter(Boolean).join(' · ');

  let calls = '';
  if (legs.length > 0) {
    calls = `<h3>Calls</h3>${legs.map((leg, i) => legCard(leg, i, legs.length, rs)).join('')}`;
  } else if (rs.legsNote) {
    calls = `<p class="notice">${e(rs.legsNote)}</p>`;
  }
  // The session recording plays when no leg can be played (or there are no legs).
  let sessionPlayer = '';
  if (seekMode === 'session' && rs.sessionAudio) {
    sessionPlayer = `<h3>Recording</h3>${playerOrNote(rs.sessionAudio, 'Session recording', 'Recording not included in this report.')}`;
  }
  return (
    `<div class="session" id="session-${index + 1}"><h3 style="margin-top:22px;font-size:1.1rem">${e(sessionHeading(s))}</h3>` +
    `<p class="muted small">${e(facts)}</p>${calls}${sessionPlayer}${transcriptHtml(rs, legs, seekMode)}</div>`
  );
}

/* ── page sections ─────────────────────────────────────────────────── */

function profileSection(data: ReportData): string {
  const c = data.candidate;
  const status = candidateDisplayStatus({ ...c });
  const phone = c.phone_e164
    ? `${formatPhone(c.phone_e164)}${c.phone_valid ? '' : ' (not verified)'}`
    : 'Not available';
  const rows: Array<[string, string]> = [
    ['Name', candidateDisplayName(c.name)],
    ['Email', c.email ?? 'Not available'],
    ['Phone', phone],
    ['Role applied for', data.roleTitle ?? 'Not available'],
    ['Status', status.detail ? `${status.label} (${status.detail})` : status.label],
    ['Experience', isFiniteNumber(c.experience_years) ? `${c.experience_years} years` : 'Not available'],
    ['Added', formatDateTime(c.created_at)],
    ['Candidate reference', shortId(c.id)],
  ];
  const skills = list(c.skills);
  return (
    `<section class="panel" id="profile" aria-labelledby="h-profile"><h2 id="h-profile">Candidate profile</h2>` +
    `<dl class="facts">${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join('')}` +
    `<dt>Skills</dt><dd>${skills.length ? tags(skills) : 'Not available'}</dd></dl>` +
    `${resumeSection(c.parsed)}</section>`
  );
}

function roleLine(r: { title?: string | null; employer?: string | null; period?: string | null; highlights?: string[] } | null | undefined): string {
  if (!r) return '';
  const head = [r.title, r.employer].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' at ');
  const body = `${e(head || 'Role')}${r.period ? ` <span class="muted">(${e(r.period)})</span>` : ''}`;
  return `<li>${body}${bullets(list(r.highlights))}</li>`;
}

function resumeSection(parsed: CandidateResumeFacts | null | undefined): string {
  if (!parsed) return '';
  const parts: string[] = [];
  if (parsed.summary && parsed.summary.trim()) parts.push(`<h3>Resume summary</h3><p>${e(parsed.summary)}</p>`);
  const roles: string[] = [];
  if (parsed.current_role && parsed.current_role.trim()) roles.push(`<li>${e(parsed.current_role)} <span class="muted">(current)</span></li>`);
  if (parsed.recent_role) roles.push(roleLine(parsed.recent_role));
  (parsed.prior_roles ?? []).forEach((r) => roles.push(roleLine(r)));
  if (roles.length) parts.push(`<h3>Experience</h3><ul>${roles.join('')}</ul>`);
  const highlights = list(parsed.career_highlights);
  if (highlights.length) parts.push(`<h3>Career highlights</h3>${bullets(highlights)}`);
  const education = list(parsed.education);
  if (education.length) parts.push(`<h3>Education</h3>${bullets(education)}`);
  const certs = list(parsed.certifications);
  if (certs.length) parts.push(`<h3>Certifications</h3>${bullets(certs)}`);
  return parts.join('');
}

function summaryStrip(data: ReportData, scorecards: Assessment[], recordings: number): string {
  // The same selection as the page header, never an R1 role-play score.
  const latest = latestScreeningAssessment(scorecards, [...data.sessions.map((s) => s.session), ...(data.r1Sessions ?? [])]);
  const blocked = data.candidate.decision_use_blocked_at != null;
  const cells: string[] = [];
  if (!blocked && latest) {
    const v2 = isAssessmentV2(latest) ? readScorecardAssessmentV2(latest) : null;
    const overall = v2 ? v2.overallScore : isFiniteNumber(latest.overall_score) ? latest.overall_score : null;
    const rec = v2 ? v2.recommendation : latest.recommendation;
    cells.push(
      `<div><dt>Overall score</dt><dd>${overall === null ? 'Not scored' : `${e(Math.round(overall))} <small>/ 100</small>`}</dd></div>`,
      `<div><dt>Recommendation</dt><dd>${e(recommendationWords(rec))}</dd></div>`,
    );
    if (latest.role_fit && isFiniteNumber(latest.role_fit.score)) {
      cells.push(`<div><dt>Role fit</dt><dd>${e(latest.role_fit.score)} <small>/ 10</small></dd></div>`);
    }
  }
  cells.push(
    `<div><dt>Sessions</dt><dd>${e(data.sessions.length)}</dd></div>`,
    `<div><dt>Recordings</dt><dd>${e(recordings)}</dd></div>`,
  );
  return `<section class="panel" aria-label="At a glance"><dl class="strip">${cells.join('')}</dl></section>`;
}

function scorecardsSection(data: ReportData, scorecards: Assessment[]): string {
  if (data.candidate.decision_use_blocked_at != null) {
    return (
      `<section class="panel" id="scorecards" aria-labelledby="h-score"><h2 id="h-score">Scorecards</h2>` +
      `<p class="notice warn" role="note">Scorecards, scores and recommendations are suppressed while an appeal is under review.</p></section>`
    );
  }
  const body = scorecards.length
    ? scorecards.map((a, i) => scorecardBlock(a, i, data)).join('')
    : '<p class="muted">No scorecard has been produced for this candidate yet.</p>';
  const r1 = r1SessionIds(data);
  const r1Note =
    r1.size > 0 ||
    data.assessments.some((a) => isR1Assessment(a, r1)) ||
    data.sessions.some((s) => s.assessment && isR1Assessment(s.assessment, r1))
      ? '<p class="notice" role="note">R1 sales role-play sessions (scorecards, transcripts and recordings) are not included here; they are not screening material.</p>'
      : '';
  return `<section class="panel" id="scorecards" aria-labelledby="h-score"><h2 id="h-score">Scorecards</h2>${r1Note}${body}</section>`;
}

function attemptsSection(data: ReportData): string {
  if (data.attempts === null) return '';
  const attempts = sortLegs(data.attempts);
  const body = attempts.length
    ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Scrollable table"><table><thead><tr><th>#</th><th>Placed</th><th>Outcome</th><th>Connected</th><th>Recording</th></tr></thead><tbody>` +
      attempts
        .map((a, i) => {
          const recording = legPlayable(a)
            ? legRecordedWords(a) ?? (a.recording.state === 'processing' ? 'Processing' : 'Available')
            : legNoAudioLabel(a.recording.reason);
          return (
            `<tr><td class="num">${i + 1}</td><td>${e(formatDateTime(a.admitted_at))}</td>` +
            `<td>${e(attemptOutcomeLabel(a.outcome_class, a.state, a.abandon_reason))}</td>` +
            `<td>${e(legConnectedWords(a))}</td><td>${e(recording)}</td></tr>`
          );
        })
        .join('') +
      `</tbody></table></div>`
    : '<p class="muted">No call attempts have been recorded.</p>';
  return `<section class="panel" id="attempts" aria-labelledby="h-att"><h2 id="h-att">Call attempts</h2>${body}</section>`;
}

function pipelineSection(data: ReportData): string {
  const w = data.ashby;
  if (!w) return '';
  const ops = w.operations
    .map((o) => `<li>${e(humanizeEnum(o.type))}: ${e(humanizeEnum(o.state))}${o.errorCode ? ` <span class="muted">(${e(humanizeEnum(o.errorCode))})</span>` : ''}</li>`)
    .join('');
  return (
    `<section class="panel" id="pipeline" aria-labelledby="h-pipe"><h2 id="h-pipe">Ashby pipeline</h2>` +
    `<dl class="facts"><dt>Stage</dt><dd>${e(humanizeEnum(w.lifecycle))}</dd>` +
    (w.terminalState ? `<dt>Outcome</dt><dd>${e(humanizeEnum(w.terminalState))}</dd>` : '') +
    (w.updatedAt ? `<dt>Last updated</dt><dd>${e(formatDateTime(w.updatedAt))}</dd>` : '') +
    `</dl>${ops ? `<h3>Operations</h3><ul>${ops}</ul>` : ''}</section>`
  );
}

function countEmbedded(data: ReportData): number {
  let n = 0;
  for (const rs of data.sessions) {
    for (const r of Object.values(rs.legAudio)) if (r.kind === 'embedded') n += 1;
    if (rs.sessionAudio?.kind === 'embedded') n += 1;
  }
  return n;
}

/** Whether any session's transcript made it into the file. */
export function reportIncludesTranscript(data: ReportData): boolean {
  return data.sessions.some((s) => s.transcript !== null && s.transcript.length > 0);
}

/** Recordings embedded in the file. */
export function reportRecordingCount(data: ReportData): number {
  return countEmbedded(data);
}

const ROLE_WORDS: Record<string, string> = { admin: 'Admin', interviewer: 'Interviewer', viewer: 'Viewer' };

/** The complete, self-contained report document. */
export function buildReportHtml(data: ReportData): string {
  const name = candidateDisplayName(data.candidate.name);
  const scorecards = data.candidate.decision_use_blocked_at != null ? [] : reportAssessments(data);
  const recordings = countEmbedded(data);
  const omissions = [...data.omissions];
  if (data.candidate.decision_use_blocked_at != null) {
    omissions.push('Scores and recommendations are left out while an appeal is under review.');
  }
  const generated = `${formatDateTime(data.generatedAt)} (${data.generatedAt.toISOString()})`;
  const status = candidateDisplayStatus({ ...data.candidate });
  const sub = [data.roleTitle, status.label].filter(Boolean).join(' · ');
  const scriptHash = cspScriptHash(REPORT_SCRIPT);
  const csp =
    `default-src 'none'; style-src 'unsafe-inline'; media-src data: blob:; img-src data:; ` +
    `script-src ${scriptHash}; base-uri 'none'; form-action 'none'`;

  const sessionsHtml = data.sessions.length
    ? data.sessions.map((s, i) => sessionBlock(s, i)).join('')
    : '<p class="muted">This candidate has no screening sessions yet.</p>';

  const toc = [
    ['profile', 'Profile'],
    ['scorecards', 'Scorecards'],
    ['sessions', 'Sessions and transcripts'],
    ...(data.attempts !== null ? [['attempts', 'Call attempts']] : []),
    ...(data.ashby ? [['pipeline', 'Ashby pipeline']] : []),
  ]
    .map(([id, label]) => `<a href="#${id}">${e(label)}</a>`)
    .join('');

  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="${e(csp)}">` +
    `<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">` +
    `<title>${e(`Screening report: ${name}`)}</title><style>${REPORT_CSS}</style></head><body><main>` +
    `<header><p class="eyebrow">Candidate screening report</p><h1>${e(name)}</h1>` +
    `<p class="sub">${e(sub)}</p><p class="sub small">Generated ${e(generated)}</p></header>` +
    `<p class="banner" role="note">Confidential: contains personal data and call recordings. Share only with selection stakeholders.</p>` +
    `<nav class="toc" aria-label="On this page">${toc}</nav>` +
    summaryStrip(data, scorecards, recordings) +
    (omissions.length
      ? `<section class="panel" aria-labelledby="h-omit"><h2 id="h-omit">Not in this report</h2><ul>${omissions.map((o) => `<li>${e(o)}</li>`).join('')}</ul></section>`
      : '') +
    profileSection(data) +
    scorecardsSection(data, scorecards) +
    `<section class="panel" id="sessions" aria-labelledby="h-sess"><h2 id="h-sess">Sessions and transcripts</h2>${sessionsHtml}</section>` +
    attemptsSection(data) +
    pipelineSection(data) +
    `<footer class="report-foot"><p>Generated ${e(generated)} from the HELLO recruiting workspace` +
    `${data.generatedByRole ? ` by a user with ${e(ROLE_WORDS[data.generatedByRole] ?? data.generatedByRole)} access` : ''}.` +
    ` Candidate reference ${e(shortId(data.candidate.id))}.</p></footer>` +
    `</main><script>${REPORT_SCRIPT}</script></body></html>`
  );
}
