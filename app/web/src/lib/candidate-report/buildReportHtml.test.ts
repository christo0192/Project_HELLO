// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildReportHtml,
  formatReportOffset,
  reportAssessments,
  reportIncludesTranscript,
  reportRecordingCount,
} from './buildReportHtml';
import { REPORT_SCRIPT } from './reportScript';
import {
  FAKE_MP3_B64,
  T0,
  V1_ASSESSMENT,
  V2_ASSESSMENT,
  makeCandidate,
  makeLeg,
  makeReportData,
  makeReportSession,
  makeSession,
} from '../../test/reportFixtures';
import type { Assessment } from '../../types';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function bodyText(html: string): string {
  return parse(html).body.textContent ?? '';
}

const LEGS = [
  makeLeg({ id: 'leg-1' }),
  makeLeg({
    id: 'leg-2',
    attempt_seq: 2,
    admitted_at: new Date(T0 + 70_000).toISOString(),
    connected_from: new Date(T0 + 71_000).toISOString(),
    connected_to: new Date(T0 + 90_000).toISOString(),
    recording: { state: 'unavailable', reason: 'recording_failed' },
    recording_started_at_ms: null,
  }),
];

function withAudio() {
  return makeReportData({
    sessions: [
      makeReportSession({
        legs: LEGS,
        legAudio: {
          'leg-1': { kind: 'embedded', audio: { id: 'a1', mime: 'audio/mpeg', base64: FAKE_MP3_B64 } },
        },
      }),
    ],
  });
}

describe('buildReportHtml: document shell and security', () => {
  const html = buildReportHtml(withAudio());
  const doc = parse(html);

  it('is a complete document with the privacy meta tags', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
    expect(doc.querySelector('meta[name="viewport"]')).not.toBeNull();
    expect(doc.title).toBe('Screening report: Shrinidhi Handigund');
  });

  it('carries a strict CSP whose script hash is the SHA-256 of the one inline script', () => {
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain('media-src data: blob:');
    expect(csp).toContain('img-src data:');
    expect(csp).not.toMatch(/connect-src|unsafe-eval/);
    const scripts = doc.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    const text = scripts[0].textContent ?? '';
    expect(text).toBe(REPORT_SCRIPT);
    const expected = `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
    expect(csp).toContain(`script-src ${expected}`);
  });

  it('has the confidentiality banner and no links, tokens, signed URLs or storage keys', () => {
    expect(bodyText(html)).toContain('Confidential: contains personal data and call recordings');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/[?&]token=|signed|storage|recordings_v2|access_token|bearer/i);
  });
});

describe('buildReportHtml: escaping', () => {
  const evil = `<script>alert(1)</script>`;
  const img = `<img src=x onerror=alert(2)>`;
  const data = makeReportData({
    candidate: makeCandidate({
      name: `Eve ${evil} "Quote" & 'Apos'`,
      email: `a"onfocus="alert(3)@x.com`,
      skills: [evil, img],
      parsed: { summary: `${evil}</script>`, education: [img] },
    }),
    roleTitle: `Role ${evil}`,
    assessments: [
      {
        ...(V2_ASSESSMENT as object),
        raw: {
          ...((V2_ASSESSMENT as unknown as { raw: object }).raw),
          metricResults: [
            {
              configMetricId: 'm1',
              metric: { id: 'm1', name: `Metric ${evil}`, weightBps: 10000 },
              score: 3,
              evidenceStatus: 'scored',
              rationale: `Rationale ${img}`,
              evidenceRefs: [`</script><script>evil()</script>`],
            },
          ],
        },
      } as unknown as Assessment,
    ],
    sessions: [
      makeReportSession({
        transcript: [
          { speaker: 'candidate', text: `</script><script>evil()</script> ${img}`, start_offset_sec: 3 },
          { speaker: 'bot', text: `"><svg onload=alert(4)>`, start_offset_sec: null },
        ],
      }),
    ],
    omissions: [`Omitted ${evil}`],
  });
  const html = buildReportHtml(data);
  const doc = parse(html);

  it('renders every hostile string as text, never as markup', () => {
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelectorAll('img, svg, iframe, object, embed')).toHaveLength(0);
    const withHandlers = Array.from(doc.querySelectorAll('*')).filter((el) =>
      el.getAttributeNames().some((n) => n.startsWith('on')),
    );
    expect(withHandlers).toHaveLength(0);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<script>evil()');
    // The text is still there, visibly, for the reader.
    const text = bodyText(html);
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src=x onerror=alert(2)>');
    expect(text).toContain(`Eve <script>alert(1)</script> "Quote" & 'Apos'`);
  });

  it('keeps an email with attribute-breaking quotes inside its text node', () => {
    expect(bodyText(html)).toContain(`a"onfocus="alert(3)@x.com`);
    expect(doc.querySelectorAll('[onfocus]')).toHaveLength(0);
  });
});

describe('buildReportHtml: audio embedding and click-to-seek', () => {
  const html = buildReportHtml(withAudio());
  const doc = parse(html);

  it('embeds each playable call as an <audio controls> with a data: URI', () => {
    const audios = doc.querySelectorAll('audio');
    expect(audios).toHaveLength(1);
    const audio = audios[0];
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(audio.getAttribute('src')).toBe(`data:audio/mpeg;base64,${FAKE_MP3_B64}`);
    expect(audio.getAttribute('data-audio-id')).toBe('a1');
    expect(audio.getAttribute('aria-label')).toBe('Call 1 of 2 recording');
  });

  it('puts the timestamp buttons on the call the turn belongs to, re-based on that call\'s file', () => {
    const buttons = Array.from(doc.querySelectorAll('button.ts'));
    expect(buttons.map((b) => b.getAttribute('data-audio'))).toEqual(['a1', 'a1', 'a1']);
    // started_at_ms minus the leg's recording_started_at_ms (T0 + 1500).
    expect(buttons.map((b) => b.getAttribute('data-t'))).toEqual(['0.5', '3', '8']);
    expect(buttons.map((b) => b.textContent)).toEqual(['0:00', '0:03', '0:08']);
    expect(buttons[0].getAttribute('aria-label')).toBe('Play from 0:00');
    // Every button points at a real player.
    for (const b of buttons) {
      expect(doc.querySelector(`audio[data-audio-id="${b.getAttribute('data-audio')}"]`)).not.toBeNull();
    }
  });

  it('states why a call has no player instead of leaving a gap', () => {
    const text = bodyText(html);
    expect(text).toContain('Call 2 of 2');
    expect(text).toContain('Recording unavailable (capture failed)');
  });

  it('shows a visible timestamp for print, where the buttons are hidden', () => {
    expect(doc.querySelectorAll('.ts-plain-print')).toHaveLength(3);
    expect(html).toContain('@media print');
  });

  it('counts embedded recordings and detects the transcript', () => {
    const data = withAudio();
    expect(reportRecordingCount(data)).toBe(1);
    expect(reportIncludesTranscript(data)).toBe(true);
    expect(reportRecordingCount(makeReportData())).toBe(0);
  });

  it('does not embed audio whose bytes are not clean base64', () => {
    const data = makeReportData({
      sessions: [
        makeReportSession({
          legs: [LEGS[0]],
          legAudio: { 'leg-1': { kind: 'embedded', audio: { id: 'a1', mime: 'audio/mpeg', base64: 'AAAA"onerror="x' } } },
        }),
      ],
    });
    const out = buildReportHtml(data);
    expect(parse(out).querySelectorAll('audio')).toHaveLength(0);
    expect(out).not.toContain('onerror="x');
    expect(bodyText(out)).toContain('could not be embedded');
    // No player, so no clickable timestamps either: they would point nowhere.
    expect(parse(out).querySelectorAll('button.ts')).toHaveLength(0);
  });

  it('falls back to audio/mpeg for an unusual mime and warns about OGG', () => {
    const bad = buildReportHtml(
      makeReportData({
        sessions: [
          makeReportSession({
            session: makeSession({ mode: 'browser' }),
            sessionAudio: { kind: 'embedded', audio: { id: 'a1', mime: 'text/html;x', base64: FAKE_MP3_B64 } },
          }),
        ],
      }),
    );
    expect(parse(bad).querySelector('audio')?.getAttribute('src')).toBe(`data:audio/mpeg;base64,${FAKE_MP3_B64}`);
    const ogg = buildReportHtml(
      makeReportData({
        sessions: [
          makeReportSession({
            session: makeSession({ mode: 'browser' }),
            sessionAudio: { kind: 'embedded', audio: { id: 'a1', mime: 'audio/ogg', base64: FAKE_MP3_B64 } },
          }),
        ],
      }),
    );
    expect(parse(ogg).querySelector('audio')?.getAttribute('src')).toContain('data:audio/ogg;base64,');
    expect(bodyText(ogg)).toContain('Safari cannot play it');
  });

  it('uses the session recording when no call can be played, with session offsets', () => {
    const data = makeReportData({
      sessions: [
        makeReportSession({
          session: makeSession({ mode: 'browser' }),
          transcript: [{ speaker: 'candidate', text: 'Hi', start_offset_sec: 65 }],
          sessionAudio: { kind: 'embedded', audio: { id: 'a1', mime: 'audio/mpeg', base64: FAKE_MP3_B64 } },
        }),
      ],
    });
    const out = parse(buildReportHtml(data));
    expect(out.querySelectorAll('audio')).toHaveLength(1);
    const button = out.querySelector('button.ts');
    expect(button?.getAttribute('data-t')).toBe('65');
    expect(button?.textContent).toBe('1:05');
  });

  it('stays close to the size of its audio', () => {
    const big = 'A'.repeat(3 * 1024 * 1024);
    const out = buildReportHtml(
      makeReportData({
        sessions: [
          makeReportSession({
            session: makeSession({ mode: 'browser' }),
            sessionAudio: { kind: 'embedded', audio: { id: 'a1', mime: 'audio/mpeg', base64: big } },
          }),
        ],
      }),
    );
    expect(out.length).toBeGreaterThan(big.length);
    // Everything else (styles, script, text) is a small, fixed overhead.
    expect(out.length - big.length).toBeLessThan(60_000);
  });
});

describe('buildReportHtml: omitted sections', () => {
  it('says plainly when a transcript was not included and why', () => {
    const data = makeReportData({
      sessions: [
        makeReportSession({
          transcript: null,
          transcriptNote: 'Transcript not included: the server refused access to it (403).',
        }),
      ],
      omissions: ['Transcripts are not included: the server refused access to it (403).'],
    });
    const html = buildReportHtml(data);
    const text = bodyText(html);
    expect(text).toContain('Not in this report');
    expect(text).toContain('not included');
    expect(reportIncludesTranscript(data)).toBe(false);
  });

  it('marks a recording that could not be included where it would play', () => {
    const data = makeReportData({
      sessions: [
        makeReportSession({
          legs: [LEGS[0]],
          legAudio: { 'leg-1': { kind: 'omitted', reason: 'Recording is still processing. Export again in a few minutes to include it.' } },
        }),
      ],
    });
    const html = buildReportHtml(data);
    expect(parse(html).querySelectorAll('audio')).toHaveLength(0);
    expect(bodyText(html)).toContain('still processing');
  });

  it('suppresses scores, recommendation and scorecards while an appeal blocks decision use', () => {
    const html = buildReportHtml(
      makeReportData({ candidate: makeCandidate({ decision_use_blocked_at: '2026-10-05T00:00:00.000Z' }) }),
    );
    const text = bodyText(html);
    expect(text).toContain('suppressed while an appeal is under review');
    expect(text).not.toContain('Overall score');
    expect(text).not.toMatch(/\b39\b|\b72\b/);
    expect(text).not.toContain('Reject');
    expect(text).not.toContain('Gave some clear answers');
    expect(text).not.toContain('Solid communicator');
  });
});

describe('buildReportHtml: content', () => {
  const data = makeReportData({
    attempts: [LEGS[0], LEGS[1]],
    ashby: { lifecycle: 'completed', terminalState: null, ingestionState: null, operations: [{ type: 'scorecard_write', state: 'succeeded', errorCode: null }], sessionStatus: null, updatedAt: '2026-10-04T00:00:00.000Z' },
  });
  const html = buildReportHtml(data);
  const text = bodyText(html);

  it('opens with the candidate, role and the latest score and recommendation', () => {
    expect(parse(html).querySelector('h1')?.textContent).toBe('Shrinidhi Handigund');
    expect(text).toContain('Intern Talent Acquisition');
    const strip = parse(html).querySelector('dl.strip')?.textContent ?? '';
    expect(strip).toContain('39');
    expect(strip).toContain('Reject');
    expect(strip).toContain('Role fit');
  });

  it('lists the full profile and resume details', () => {
    expect(text).toContain('shree@example.com');
    expect(text).toContain('+91 98765 43210');
    expect(text).toContain('2 years');
    expect(text).toContain('Recruiting');
    expect(text).toContain('Early-career recruiter.');
    expect(text).toContain('Intern at Acme');
    expect(text).toContain('Sourced 40 profiles');
    expect(text).toContain('BBA, Example University');
    expect(text).toContain('LinkedIn Recruiter basics');
  });

  it('renders a v2 scorecard on its own scale with provisional note, weights, rationale and evidence', () => {
    expect(text).toContain('Latest scorecard');
    expect(text).toContain('Average, 2 of 4');
    expect(text).toContain('Not scored (insufficient evidence)');
    expect(text).toContain('70%');
    expect(text).toContain('30%');
    expect(text).toContain('Gave some clear answers.');
    expect(text).toContain('"I study recruiting"');
    expect(text).toContain('Provisional: some metrics lacked enough evidence');
  });

  it('renders a legacy 5-point v2 row with the legacy labels', () => {
    const legacy = {
      ...(V2_ASSESSMENT as object),
      id: 'assess-v2-legacy',
      score_scale_max: 5,
      raw: {
        ...((V2_ASSESSMENT as unknown as { raw: object }).raw),
        scoreScaleMax: 5,
        metricResults: [
          { configMetricId: 'm1', metric: { id: 'm1', name: 'Communication', weightBps: 10000 }, score: 2, evidenceStatus: 'scored', rationale: 'r', evidenceRefs: [] },
        ],
      },
    } as unknown as Assessment;
    const out = bodyText(buildReportHtml(makeReportData({ assessments: [legacy] })));
    expect(out).toContain('Below average, 2 of 5');
  });

  it('renders a v1 scorecard with weights, notes, conflicts and summary, and role fit with its tags', () => {
    expect(text).toContain('Earlier scorecard');
    expect(text).toContain('Communication');
    expect(text).toContain('50%');
    expect(text).toContain('Answers were structured.');
    expect(text).toContain('Sentiment Positive');
    expect(text).toContain('Resume conflicts');
    expect(text).toContain('Ask again');
    expect(text).toContain('Solid communicator.');
    expect(text).toContain('Matched skills');
    expect(text).toContain('ATS depth');
    expect(text).toContain('Red flags');
    expect(text).toContain('Evasive');
  });

  it('shows the held-for-insufficient-evidence notice', () => {
    const held = {
      ...(V1_ASSESSMENT as object),
      id: 'held',
      evidence_grade: 'insufficient',
      evidence_reason: 'partial_thin',
      evidence_answered: 1,
      evidence_planned: 5,
    } as unknown as Assessment;
    const out = bodyText(buildReportHtml(makeReportData({ assessments: [held] })));
    expect(out).toContain('Held: insufficient evidence');
    expect(out).toContain('1 of 5 planned questions');
  });

  it('hides the planned-question marker, labels the turn and the consent step', () => {
    expect(text).not.toContain('[planned question]');
    expect(text).toContain('Interrupted question');
    expect(text).toContain('Tell me about yourself.');
    expect(text).toContain('(consent step)');
  });

  it('says "no timing" for an untimed turn and gives it no button', () => {
    const out = buildReportHtml(
      makeReportData({
        sessions: [
          makeReportSession({
            session: makeSession({ mode: 'browser' }),
            transcript: [{ speaker: 'bot', text: 'Hello?', start_offset_sec: null }],
          }),
        ],
      }),
    );
    expect(parse(out).querySelectorAll('button.ts')).toHaveLength(0);
    expect(bodyText(out)).toContain('no timing');
  });

  it('lists call attempts and the Ashby pipeline', () => {
    expect(parse(html).querySelector('#attempts table')).not.toBeNull();
    expect(text).toContain('Call attempts');
    expect(text).toContain('Ashby pipeline');
    expect(text).toContain('Completed');
    expect(text).toContain('Scorecard write: Succeeded');
  });

  it('renders for a candidate with no sessions, scorecards, attempts or profile detail', () => {
    const empty = makeReportData({
      candidate: makeCandidate({ name: null, email: null, phone_e164: null, skills: [], experience_years: null, parsed: null }),
      roleTitle: null,
      assessments: [],
      sessions: [],
      attempts: null,
    });
    const out = buildReportHtml(empty);
    const t = bodyText(out);
    expect(t).toContain('Awaiting resume details');
    expect(t).toContain('No scorecard has been produced');
    expect(t).toContain('no screening sessions yet');
    expect(parse(out).querySelector('#attempts')).toBeNull();
    expect(parse(out).querySelectorAll('script')).toHaveLength(1);
  });

  it('has an accessible heading outline and a footer without an email or id', () => {
    const doc = parse(html);
    expect(doc.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelectorAll('main')).toHaveLength(1);
    expect(doc.querySelector('footer')?.textContent).toContain('Admin access');
    expect(doc.querySelector('footer')?.textContent).not.toContain('@');
  });
});

describe('helpers', () => {
  it('formats offsets as m:ss', () => {
    expect(formatReportOffset(0)).toBe('0:00');
    expect(formatReportOffset(59.9)).toBe('0:59');
    expect(formatReportOffset(754)).toBe('12:34');
    expect(formatReportOffset(-3)).toBe('0:00');
  });

  it('merges the session scorecard into the list once, newest first as given', () => {
    const data = makeReportData({
      assessments: [V2_ASSESSMENT],
      sessions: [makeReportSession({ assessment: V2_ASSESSMENT }), makeReportSession({ assessment: V1_ASSESSMENT })],
    });
    expect(reportAssessments(data).map((a) => a.id)).toEqual(['assess-v2', 'assess-v1']);
  });
});


describe('buildReportHtml: R1 role-play scores are never the screening score', () => {
  const r1Assessment = {
    ...V1_ASSESSMENT,
    id: 'assess-r1',
    session_id: 'session-r1',
    overall_score: 11,
    recommendation: 'reject',
    summary: 'R1 ROLEPLAY SUMMARY',
  } as unknown as Assessment;
  const screening = { ...V1_ASSESSMENT, id: 'assess-scr', session_id: 'session-1', overall_score: 72 } as unknown as Assessment;
  const data = makeReportData({
    // R1 is the newest, as in the real list (newest first).
    assessments: [r1Assessment, screening],
    sessions: [
      makeReportSession({ session: makeSession({ id: 'session-1' }) }),
      makeReportSession({ session: makeSession({ id: 'session-r1', interview_round_id: 'round-1' }), assessment: r1Assessment }),
    ],
  });

  it('excludes the R1 scorecard from the list and says so', () => {
    expect(reportAssessments(data).map((a) => a.id)).toEqual(['assess-scr']);
    const html = buildReportHtml(data);
    expect(bodyText(html)).not.toContain('R1 ROLEPLAY SUMMARY');
    expect(bodyText(html)).toContain('R1 sales role-play sessions (scorecards, transcripts and recordings) are not included');
  });

  it('the headline score is the screening one, not the newer R1 result', () => {
    const doc = parse(buildReportHtml(data));
    const strip = doc.querySelector('dl.strip')?.textContent ?? '';
    expect(strip).toContain('72');
    expect(strip).not.toContain('11');
    expect(doc.body.textContent).toContain('Latest scorecard');
  });
});
