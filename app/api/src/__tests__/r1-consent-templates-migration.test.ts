/**
 * 0123 (PR-CT): the R1 consent notices, read as TEXT.
 *
 * The behavioural proof (rows exist and are active, are immutable, and admission accepts consent
 * to them) lives in app/supabase/tests/r1_foundation_assert.sql and runs in supabase-ci against
 * the full migration chain. This file is the cheap half that runs in every API test run:
 *
 *   - the migration writes only the R1 template table, so it cannot disturb phone or the legacy
 *     browser lane, and its verification block is read-only;
 *   - the two audience rows share ONE version, because r1_admit_attempt only honours consent to
 *     the greatest active version and two versions would leave one audience unadmittable;
 *   - the consent keys the migration ships are the ones the SQL assertions prove, so the two
 *     files cannot drift apart where only supabase-ci would notice;
 *   - the itemised notice is complete, unambiguous, and stays readable when markup is stripped;
 *   - the md5 digests a sign-off is bound to are the digests of the bodies, in the migration and
 *     in the SQL assertions;
 *   - the behaviour the notices promise, and the cross-PR audience contract, are recorded as gates
 *     in the migration and in the plan, and the labels shown at the point of consent match them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  R1_CANDIDATE_LOCALE,
  R1_CONSENT_ITEMS,
  R1_STAFF_LOCALE,
  r1ConsentItems,
  type R1ConsentItem,
} from '../lib/r1/consent-items.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE = path.resolve(HERE, '../../../supabase');
const REPO = path.resolve(SUPABASE, '../..');
const MIGRATION_FILE = '0123_r1_consent_templates.sql';

/** Windows checkouts are CRLF; the repository content is LF. */
const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const MIGRATION = lf(readFileSync(path.join(SUPABASE, 'migrations', MIGRATION_FILE), 'utf8'));
const ASSERT_SQL = lf(
  readFileSync(path.join(SUPABASE, 'tests', 'r1_foundation_assert.sql'), 'utf8'),
);
const PLAN = lf(readFileSync(path.join(REPO, 'docs', 'design', 'r1', 'R1-PLAN-final.md'), 'utf8'));

const CANDIDATE_LOCALE = 'en-IN';
const STAFF_LOCALE = 'en-IN-x-staff';
const KEYS = ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'];

interface Row {
  version: string;
  locale: string;
  title: string;
  body: string;
  requiredConsents: string[];
  isActive: boolean;
}

const ROW = new RegExp(
  [
    String.raw`\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',`,
    String.raw`\s*replace\(\$notice\$([\s\S]*?)\$notice\$, chr\(13\), ''\),`,
    String.raw`\s*'(\[[^\]]*\])'::jsonb,\s*(true|false)\s*\)`,
  ].join(''),
  'g',
);

const ROWS: Row[] = [...MIGRATION.matchAll(ROW)].map((m) => ({
  version: m[1],
  locale: m[2],
  title: m[3],
  body: m[4],
  requiredConsents: JSON.parse(m[5]) as string[],
  isActive: m[6] === 'true',
}));

function row(locale: string): Row {
  const found = ROWS.find((r) => r.locale === locale);
  if (!found) throw new Error(`0123 has no ${locale} row`);
  return found;
}

const md5 = (text: string): string => createHash('md5').update(text, 'utf8').digest('hex');

/** The read-only verification block at the end of the migration (its body, between the tags). */
const VERIFY_MATCH = MIGRATION.match(/\ndo \$verify\$([\s\S]*?)\$verify\$;/);
const VERIFY = VERIFY_MATCH ? VERIFY_MATCH[1] : '';

/** The migration with comments, dollar-quoted bodies and string literals blanked out. */
const CODE = MIGRATION.replace(/\$notice\$[\s\S]*?\$notice\$/g, "''")
  .replace(/\$verify\$[\s\S]*?\$verify\$/g, "''")
  .replace(/--[^\n]*/g, '')
  .replace(/'(?:[^']|'')*'/g, "''");

/** The migration's own comment text: the header and the notes around the statements. */
const COMMENTS = MIGRATION.replace(/\$notice\$[\s\S]*?\$notice\$/g, '')
  .split('\n')
  .filter((line) => line.startsWith('--'))
  .map((line) => line.replace(/^--\s?/, ''))
  .join('\n');

/** What the SQL assertions prove; the shipped keys must be exactly these. */
function sqlConstant(pattern: RegExp): string {
  const m = ASSERT_SQL.match(pattern);
  if (!m) throw new Error(`r1_foundation_assert.sql is missing ${pattern}`);
  return m[1];
}

/** A section of the plan, from its heading line up to the next heading of the same level. */
function planSection(heading: string): string {
  const start = PLAN.indexOf(heading);
  if (start < 0) throw new Error(`the plan has no section ${heading}`);
  const next = PLAN.indexOf('\n### ', start + heading.length);
  return PLAN.slice(start, next < 0 ? undefined : next);
}

describe('0123 file frame', () => {
  it('is an R1-lane migration (phone-0114-scaffold lets only `_r1_` files follow 0114)', () => {
    expect(MIGRATION_FILE).toMatch(/^0123_.*\.sql$/);
    expect(MIGRATION_FILE).toContain('_r1_');
  });

  it('sets a LOCAL lock_timeout before the only write', () => {
    const lock = MIGRATION.indexOf("set local lock_timeout = '10s';");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(MIGRATION.indexOf('insert into'));
  });

  it('keeps every line within 100 columns', () => {
    const long = MIGRATION.split('\n').filter((line) => line.length > 100);
    expect(long).toEqual([]);
  });

  it('is data only: one INSERT, then one verification block; no DDL, function or grant', () => {
    const statements = CODE.split(';')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^set local lock_timeout = ''$/);
    expect(statements[1]).toMatch(
      /^insert into screening_v2\.interview_round_consent_templates\b/,
    );
    expect(statements[2]).toBe("do ''");
    expect(CODE).not.toMatch(/\b(create|alter|drop|grant|revoke|truncate|update|delete)\b/i);
  });

  it('never writes the global consent tables phone and the legacy browser lane read', () => {
    expect(CODE).not.toMatch(/\bconsent_templates\b/);
    expect(CODE).not.toMatch(/\bconsent_records\b/);
    expect(CODE.match(/screening_v2\.\w+/g)).toEqual([
      'screening_v2.interview_round_consent_templates',
    ]);
  });

  it('re-applies as a no-op on the (version, locale) key', () => {
    expect(CODE).toMatch(/on conflict \(version, locale\) do nothing/);
  });

  it('strips the carriage returns of a Windows checkout from the immutable text', () => {
    expect(MIGRATION.match(/replace\(\$notice\$/g)).toHaveLength(2);
    expect(MIGRATION.match(/, chr\(13\), ''\)/g)).toHaveLength(2);
  });
});

describe('0123 rows', () => {
  it('ships exactly a candidate row and a staff dry-run row, both active', () => {
    expect(ROWS.map((r) => r.locale)).toEqual([CANDIDATE_LOCALE, STAFF_LOCALE]);
    expect(ROWS.every((r) => r.isActive)).toBe(true);
  });

  it('puts both audiences on ONE version so both stay authoritative for admission', () => {
    expect(new Set(ROWS.map((r) => r.version)).size).toBe(1);
    expect(ROWS[0].version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d$/);
  });

  it('requires the same four keys for both audiences', () => {
    for (const r of ROWS) {
      expect([...r.requiredConsents].sort()).toEqual([...KEYS].sort());
    }
  });

  it('keeps the phone-only audio `recording` key out of the R1 vocabulary', () => {
    for (const r of ROWS) {
      expect(r.requiredConsents).not.toContain('recording');
    }
  });

  it('gives each audience its own title, and the body starts with the same heading', () => {
    expect(row(CANDIDATE_LOCALE).title).not.toBe(row(STAFF_LOCALE).title);
    for (const r of ROWS) {
      expect(r.body.startsWith(`# ${r.title}\n`)).toBe(true);
    }
  });
});

describe('0123 itemised notice', () => {
  const COMMON: [string, RegExp][] = [
    ['AI interviewer', /An AI interviewer, not a person/],
    ['sales role-play', /announces a role-play/],
    ['transcript', /A written transcript of the conversation/],
    ['camera video and voice', /Your camera video and your voice/],
    ['recording for review', /camera video and voice may be recorded/],
    ['DeepSeek in the PRC', /DeepSeek processes and stores data in the People's Republic of China/],
    ['DeepSeek gets text only', /DeepSeek receives the text of your conversation/],
    [
      'other processors',
      new RegExp(
        [
          'Sarvam AI', 'LiveKit', 'Cloudflare R2', String.raw`Fly\.io \(Singapore\)`,
          'Vercel', 'Supabase',
        ].join(String.raw`[\s\S]*`),
      ),
    ],
    ['LiveKit mode and place', /LiveKit runs on a server we operate at Fly\.io \(Singapore\) or/],
    ['LiveKit Cloud fallback', /as a fallback, on LiveKit Cloud/],
    ['Vercel hosting', /Vercel: hosts the interview web page and passes your requests/],
    ['90-day video retention', /Video recording: 90 days, then it is deleted/],
    ['transcript and score retention', /Transcript and scores:/],
    ['withdrawal path', /## Withdraw your consent[\s\S]*delete any video recording/],
    ['withdrawal ends scoring', /After you withdraw, we will not score the (interview|dry run)/],
    ['withdrawal is not penalised', /Withdrawing will not count against you\./],
    [
      'contact',
      /Contact the Interview Kickstart (hiring team that|project team member who) sent you/,
    ],
    ['complaints go to the contact first', /complaints about your data to the same contact first/],
    ['Data Protection Board', /Data Protection Board of India/],
  ];

  it.each(COMMON)('the candidate notice states: %s', (_label, pattern) => {
    expect(row(CANDIDATE_LOCALE).body).toMatch(pattern);
  });

  it.each(COMMON)('the staff dry-run notice states: %s', (_label, pattern) => {
    expect(row(STAFF_LOCALE).body).toMatch(pattern);
  });

  it('the candidate notice offers the human-interview alternative and the right to contest', () => {
    const body = row(CANDIDATE_LOCALE).body;
    expect(body).toMatch(/hiring team will arrange a human interview with you instead/);
    expect(body).toMatch(/prefer not to use your camera or not to be evaluated by AI/);
    expect(body).toMatch(/may automatically update your application status/);
    expect(body).toMatch(/The hiring team can review and change that status/);
    expect(body).toMatch(/You can contest it/);
  });

  it('the staff notice says it is a dry run, not an application, and is voluntary', () => {
    const body = row(STAFF_LOCALE).body;
    expect(body).toMatch(/It is not a real job application/);
    expect(body).toMatch(/Taking part is voluntary, and you can decline/);
    expect(body).toMatch(/It is not used to make any decision about you/);
  });

  it('states each of the four agreements as its own line', () => {
    for (const r of ROWS) {
      expect(r.body).toMatch(/^- AI interview: /m);
      expect(r.body).toMatch(/^- Video and audio recording: /m);
      expect(r.body).toMatch(/^- AI evaluation: /m);
      expect(r.body).toMatch(/^- Data processing: /m);
    }
  });

  it('carries no placeholder, CR, non-ASCII or markup the plain renderer strips', () => {
    for (const r of ROWS) {
      expect(r.body).not.toMatch(/placeholder|todo|tbd|lorem|[[\]{}]/i);
      expect(r.body).not.toContain('\r');
      expect(r.body).toMatch(/^[\x20-\x7E\n]+$/);
      // The legacy join page strips `* _ ~ > backtick # before showing a body as plain text.
      expect(r.body.replace(/^#{1,2} /gm, '')).not.toMatch(/[*_`~>#]/);
    }
  });

  it('keeps headings, bullets and paragraphs on one line each', () => {
    for (const r of ROWS) {
      for (const line of r.body.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(100);
        expect(line).not.toMatch(/^\s+/);
      }
    }
  });
});

describe('P2 audience is chosen by the server, not by the client locale', () => {
  /** The validator PR-3 shipped for the client `locale` field (r1-candidate.ts, as reviewed). */
  const NARROW_CLIENT_LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
  /** BCP 47 with the private-use extension, the form a client locale must take if one stays. */
  const PRIVATE_USE_LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*(-x(-[A-Za-z0-9]{1,8})+)?$/;

  it('states the contract in the migration: server-owned; a blocker for PR-3, 6, 7', () => {
    expect(COMMENTS).toContain('AUDIENCE CONTRACT');
    expect(COMMENTS).toMatch(/blocker for PR-3, PR-6 and PR-7/);
    expect(COMMENTS).toMatch(/owned by the server, never chosen by the client/);
    expect(COMMENTS).toContain('consent_locale');
    expect(COMMENTS).toMatch(/drop the\s+client locale/);
    expect(COMMENTS).toContain("'en-IN-x-staff'");
  });

  it('records the same contract and blocker in the plan, in 7.8 and in the stage gates', () => {
    const consent = planSection('### 7.8 Consent and notice');
    expect(consent).toContain('Audience is server-owned (PR-CT blocker for PR-3, PR-6 and PR-7)');
    expect(consent).toContain('interview_rounds.consent_locale');
    expect(consent).toMatch(/drop the client `locale`/);
    const exits = planSection('### 10.4 Stage exits (numeric)');
    expect(exits).toMatch(/Consent-notice gates[\s\S]*round audience is server-owned/);
    expect(exits.indexOf('Consent-notice gates')).toBeLessThan(exits.indexOf('**Stage A0**'));
  });

  it('explains the locale trap: the staff tag is private use, which a narrow regex rejects', () => {
    expect(NARROW_CLIENT_LOCALE.test(CANDIDATE_LOCALE)).toBe(true);
    expect(NARROW_CLIENT_LOCALE.test(STAFF_LOCALE)).toBe(false);
    expect(PRIVATE_USE_LOCALE.test(CANDIDATE_LOCALE)).toBe(true);
    expect(PRIVATE_USE_LOCALE.test(STAFF_LOCALE)).toBe(true);
    expect(PRIVATE_USE_LOCALE.test('en-IN-x-')).toBe(false);
  });

  it('uses one locale pair everywhere: migration rows, API constants and SQL assertions', () => {
    expect(R1_CANDIDATE_LOCALE).toBe(CANDIDATE_LOCALE);
    expect(R1_STAFF_LOCALE).toBe(STAFF_LOCALE);
    expect(sqlConstant(/candidate_locale constant text := '([^']+)'/)).toBe(CANDIDATE_LOCALE);
    expect(sqlConstant(/staff_locale constant text := '([^']+)'/)).toBe(STAFF_LOCALE);
  });

  it('keeps the known gap visible where the staff scenarios admit a candidate round', () => {
    expect(ASSERT_SQL).toContain('KNOWN GAP');
    expect(ASSERT_SQL).toMatch(/blocker for PR-3, PR-6 and PR-7/);
  });
});

describe('P2 grievance route', () => {
  it('routes complaints to the contact that sent the link, first, in both notices', () => {
    for (const r of ROWS) {
      expect(r.body).toMatch(
        /^- Send questions and complaints about your data to the same contact first\.$/m,
      );
    }
  });

  it('records the named grievance officer as OPEN, needing the owner, before Stage B', () => {
    expect(COMMENTS).toMatch(/grievance\s+OPEN, needs the owner: a named grievance officer/);
    expect(COMMENTS).toMatch(/naming the officer is a new release of BOTH rows/);
    expect(PLAN).toMatch(/Open owner inputs: a named grievance officer/);
    expect(planSection('### 10.4 Stage exits (numeric)')).toMatch(
      /before Stage B: the named grievance officer is in the notice/,
    );
  });

  // The owner has not supplied a name and a monitored address, and the notice is immutable once
  // applied, so none is invented here. Turn this into a real assertion when the owner does.
  it.todo('both notices name the grievance officer and a monitored address (OPEN: owner input)');
});

describe('P2 sign-off, and what the notices claim about providers', () => {
  it('says the wording is a draft and binds a sign-off to the md5 digests of the bodies', () => {
    expect(COMMENTS).toMatch(/implementer's draft/);
    expect(COMMENTS).toMatch(/not Legal's\s+verbatim text/);
    expect(COMMENTS).toMatch(/bound to the\s+md5 digests/);
    expect(VERIFY).toContain(md5(row(CANDIDATE_LOCALE).body));
    expect(VERIFY).toContain(md5(row(STAFF_LOCALE).body));
  });

  it('words the withdrawal consequences without the ambiguous "because of it"', () => {
    for (const r of ROWS) {
      expect(r.body).not.toMatch(/because of it/i);
    }
    expect(row(CANDIDATE_LOCALE).body).toMatch(
      new RegExp(
        'After you withdraw, we will not score the interview or change your application '
          + String.raw`status from it\.`,
      ),
    );
    expect(row(STAFF_LOCALE).body).toMatch(
      /After you withdraw, we will not score the dry run or use it to test or tune the interview\./,
    );
  });

  it('names every provider the interview touches, now including Vercel', () => {
    for (const r of ROWS) {
      for (const provider of ['Sarvam AI', 'DeepSeek', 'LiveKit', 'Cloudflare R2', 'Fly.io']) {
        expect(r.body).toContain(provider);
      }
      expect(r.body).toContain('Vercel');
      expect(r.body).toContain('Supabase (Mumbai, India)');
    }
  });

  it('records the provider gates: regions per Legal, a model change re-ships both rows', () => {
    expect(COMMENTS).toMatch(
      /regions\s+the notice names Cloudflare R2 and LiveKit Cloud without a region/,
    );
    expect(COMMENTS).toMatch(/created only after Legal's jurisdiction advice/);
    expect(COMMENTS).toMatch(/model\s+DeepSeek is named because the owner and Legal approved it/);
    expect(COMMENTS).toMatch(/a new release re-ships BOTH rows before that provider/);
    expect(COMMENTS).toMatch(/retention\s+transcript and score retention rests on D-009/);
  });
});

describe('P3 the notices promise features other PRs build', () => {
  it('lists the withdraw and recording gates in the migration', () => {
    expect(COMMENTS).toContain('RELEASE GATES');
    expect(COMMENTS).toMatch(/POST \/api\/r1\/consent\/withdraw \(PR-3, PR-6\)/);
    expect(COMMENTS).toMatch(/live before ANY participant sees these notices/);
    expect(COMMENTS).toMatch(/R1_VIDEO_RECORDING stays off until r1\.sweep \(90 days\)/);
    expect(COMMENTS).toMatch(/R2 lifecycle rule\s+on prefix r1\/ \(PR-8\)/);
  });

  it('puts the same gates in the plan stage exits, ahead of Stage A0', () => {
    const exits = planSection('### 10.4 Stage exits (numeric)');
    const gates = exits.slice(0, exits.indexOf('**Stage A0**'));
    expect(gates).toMatch(/withdraw control and `POST \/api\/r1\/consent\/withdraw` are live:/);
    expect(gates).toMatch(/stops the session with no upload and blocks scoring and status writes/);
    expect(gates).toMatch(
      /`R1_VIDEO_RECORDING` stays off, and no R2 bucket exists, until `r1\.sweep`/,
    );
    expect(gates).toMatch(/R2 `r1\/` lifecycle rule \(N\+7 days; abort multipart after 1 day\)/);
  });

  it('keeps the promises the notices make in step with the gates', () => {
    for (const r of ROWS) {
      expect(r.body).toMatch(/Use the withdraw option on your interview page/);
      expect(r.body).toMatch(/Video recording: 90 days, then it is deleted/);
    }
  });
});

describe('P3 verification block: drift in production fails the migration', () => {
  it('is a read-only block that follows the insert', () => {
    expect(VERIFY).not.toBe('');
    expect(MIGRATION.indexOf('do $verify$')).toBeGreaterThan(MIGRATION.indexOf('insert into'));
    const code = VERIFY.replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toMatch(/\b(insert|update|delete|create|alter|drop|grant|revoke|truncate)\b/i);
    expect(code.match(/screening_v2\.\w+/g)).toEqual([
      'screening_v2.interview_round_consent_templates',
      'screening_v2.interview_round_consent_templates',
      'screening_v2.interview_round_consent_templates',
      'screening_v2.interview_round_consent_templates',
    ]);
  });

  it('raises unless exactly two rows exist at the release and both are active', () => {
    expect(VERIFY).toMatch(/v_rows <> 2 or v_active <> 2/);
    expect(VERIFY).toMatch(/count\(\*\) filter \(where is_active\)/);
    expect(VERIFY).toMatch(/raise exception '0123: expected exactly 2 active rows at version/);
  });

  it('raises unless each audience row carries the shipped keys and the shipped body digest', () => {
    expect(VERIFY).toMatch(/locale = 'en-IN' and is_active\s+and required_consents = v_keys/);
    expect(VERIFY).toMatch(
      /locale = 'en-IN-x-staff' and is_active\s+and required_consents = v_keys/,
    );
    expect(VERIFY).toMatch(/md5\(body_md\) = v_candidate_md5/);
    expect(VERIFY).toMatch(/md5\(body_md\) = v_staff_md5/);
    expect(VERIFY.match(/raise exception '0123: the en-IN/g)).toHaveLength(2);
  });

  it('raises unless the release is the greatest ACTIVE version, as admission reads it', () => {
    expect(VERIFY).toMatch(/select max\(version\) into v_newest[\s\S]*where is_active;/);
    expect(VERIFY).toMatch(/v_newest is distinct from v_release/);
    expect(VERIFY).toMatch(/is not the greatest active template version/);
  });

  it('pins the same release and keys the rows ship', () => {
    expect(VERIFY).toContain(`v_release constant text := '${ROWS[0].version}'`);
    const keys = VERIFY.match(/v_keys constant jsonb :=\s*'(\[[^\]]*\])'::jsonb/);
    expect(keys && (JSON.parse(keys[1]) as string[])).toEqual(ROWS[0].requiredConsents);
  });

  it('carries the md5 digest of each body as shipped: an edit must refresh the digests', () => {
    const candidate = VERIFY.match(/v_candidate_md5 constant text := '([0-9a-f]{32})'/);
    const staff = VERIFY.match(/v_staff_md5 constant text := '([0-9a-f]{32})'/);
    expect(candidate && candidate[1]).toBe(md5(row(CANDIDATE_LOCALE).body));
    expect(staff && staff[1]).toBe(md5(row(STAFF_LOCALE).body));
    expect(candidate && candidate[1]).not.toBe(staff && staff[1]);
  });

  it('is repeated in the SQL assertions, which compare the stored bodies to the digests', () => {
    expect(sqlConstant(/\bcandidate_md5 constant text := '([0-9a-f]{32})'/)).toBe(
      md5(row(CANDIDATE_LOCALE).body),
    );
    expect(sqlConstant(/\bstaff_md5 constant text := '([0-9a-f]{32})'/)).toBe(
      md5(row(STAFF_LOCALE).body),
    );
    expect(ASSERT_SQL).toContain('the shipped bodies are the signed-off text (md5 digests)');
  });
});

describe('P3 consent items: every key has its own label at the point of consent', () => {
  const AGREEMENT_LINE: Record<string, string> = {
    ai_interview: '- AI interview: ',
    video_audio_recording: '- Video and audio recording: ',
    ai_evaluation: '- AI evaluation: ',
    data_processing: '- Data processing: ',
  };
  /** The generic text a page shows when it has no label for a key. */
  const generic = (type: string): string => `I agree to ${type.replace(/_/g, ' ')}.`;

  it('ships one item set per audience locale, with the keys of its row in row order', () => {
    expect(Object.keys(R1_CONSENT_ITEMS).sort()).toEqual([CANDIDATE_LOCALE, STAFF_LOCALE].sort());
    for (const r of ROWS) {
      expect(R1_CONSENT_ITEMS[r.locale].map((item) => item.type)).toEqual(r.requiredConsents);
      expect(r1ConsentItems(r.locale, r.requiredConsents)).toEqual(R1_CONSENT_ITEMS[r.locale]);
    }
  });

  it('gives every key a non-generic, one-line, ASCII label that names its own purpose', () => {
    for (const items of Object.values(R1_CONSENT_ITEMS)) {
      for (const item of items) {
        expect(item.label).not.toBe(generic(item.type));
        expect(item.label).toMatch(/^I agree to [\x20-\x7E]{20,}$/);
        expect(item.label.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('keeps the separate agreement to DeepSeek and the PRC in the data-processing label', () => {
    for (const items of Object.values(R1_CONSENT_ITEMS)) {
      const label = items.find((item) => item.type === 'data_processing')?.label ?? '';
      expect(label).toContain('DeepSeek');
      expect(label).toContain("People's Republic of China");
    }
  });

  it('says what each recording and evaluation label means for that audience', () => {
    const labelOf = (locale: string, type: string): string =>
      R1_CONSENT_ITEMS[locale].find((item) => item.type === type)?.label ?? '';
    expect(labelOf(CANDIDATE_LOCALE, 'video_audio_recording')).toMatch(
      /camera video and voice[\s\S]*hiring team/,
    );
    expect(labelOf(STAFF_LOCALE, 'video_audio_recording')).toMatch(
      /camera video and voice[\s\S]*project team/,
    );
    expect(labelOf(CANDIDATE_LOCALE, 'ai_evaluation')).toMatch(/may update my application status/);
    expect(labelOf(STAFF_LOCALE, 'ai_evaluation')).not.toMatch(/application status/);
    expect(labelOf(STAFF_LOCALE, 'ai_evaluation')).toMatch(/not used to make any decision/);
  });

  it('matches an agreement line of the notice the same audience is shown', () => {
    for (const r of ROWS) {
      for (const key of r.requiredConsents) {
        expect(r.body, `${r.locale} ${key}`).toContain(AGREEMENT_LINE[key]);
      }
    }
  });

  it('refuses to present an unknown locale, an unknown key, or a prototype name', () => {
    expect(r1ConsentItems('hi-IN', KEYS)).toBeNull();
    expect(r1ConsentItems('constructor', KEYS)).toBeNull();
    expect(r1ConsentItems('__proto__', KEYS)).toBeNull();
    expect(r1ConsentItems(CANDIDATE_LOCALE, [...KEYS, 'recording'])).toBeNull();
    expect(r1ConsentItems(CANDIDATE_LOCALE, ['recording'])).toBeNull();
  });

  it('returns copies in the requested order and supports a required subset', () => {
    const picked = r1ConsentItems(CANDIDATE_LOCALE, ['data_processing', 'ai_interview']);
    expect(picked?.map((item) => item.type)).toEqual(['data_processing', 'ai_interview']);
    expect(picked).not.toBeNull();
    (picked as R1ConsentItem[])[0].label = 'changed';
    expect(R1_CONSENT_ITEMS[CANDIDATE_LOCALE][3].label).not.toBe('changed');
    expect(r1ConsentItems(CANDIDATE_LOCALE, [])).toEqual([]);
  });

  it('names the file that holds the labels in the migration, and the labels are frozen', () => {
    expect(COMMENTS).toContain('app/api/src/lib/r1/consent-items.ts');
    expect(Object.isFrozen(R1_CONSENT_ITEMS)).toBe(true);
    expect(Object.isFrozen(R1_CONSENT_ITEMS[CANDIDATE_LOCALE])).toBe(true);
    expect(Object.isFrozen(R1_CONSENT_ITEMS[STAFF_LOCALE])).toBe(true);
  });

  it('is required by the plan gates: PR-3 returns the items, PR-6 shows no generic label', () => {
    expect(planSection('### 10.4 Stage exits (numeric)')).toMatch(
      /PR-3 returns `consent_items` \(type and label\) for all four consent keys/,
    );
  });
});

describe('0123 versus the SQL assertions', () => {
  const release = sqlConstant(/release constant text := '([^']+)'/);

  it('proves the shipped release, locales and keys', () => {
    expect(release).toBe(ROWS[0].version);
    expect(sqlConstant(/candidate_locale constant text := '([^']+)'/)).toBe(CANDIDATE_LOCALE);
    expect(sqlConstant(/staff_locale constant text := '([^']+)'/)).toBe(STAFF_LOCALE);
    const contract = JSON.parse(
      sqlConstant(/contract constant jsonb :=\s*'(\[[^\]]*\])'::jsonb/),
    ) as string[];
    expect(contract).toEqual(ROWS[0].requiredConsents);
  });

  it('runs the PR-CT block before the fixtures that insert later, higher versions', () => {
    const prct = ASSERT_SQL.indexOf('-- PR-CT (0123)');
    const firstFixtureBlock = ASSERT_SQL.indexOf(
      "owner constant uuid := '10000000-0000-4000-8000-000000000001';",
    );
    expect(prct).toBeGreaterThan(-1);
    expect(firstFixtureBlock).toBeGreaterThan(prct);
  });

  it('documents the rebase rule for the capacity migration that edits the same spot (P3)', () => {
    expect(ASSERT_SQL).toContain('REBASE RULE');
    expect(ASSERT_SQL).toMatch(/PR-2b \(0119\)[\s\S]*r1_capacity_snapshot gate/);
    expect(ASSERT_SQL).toMatch(/Keep this block FIRST in the file/);
    expect(ASSERT_SQL).toMatch(/merge only on green/);
  });

  it('keeps every foundation fixture version above the shipped release', () => {
    const versions = [...ASSERT_SQL.matchAll(/\(template_\w+, '([^']+)', '/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThanOrEqual(4);
    for (const version of versions) {
      // Plain code-unit order equals the C collation for these ASCII strings; a date-based
      // release starts with '2', so fixtures must start with a greater character.
      expect(version > release, `${version} must sort above ${release}`).toBe(true);
    }
  });

  it('proves admission for both audiences, every key, and the phone vocabulary', () => {
    for (const label of [
      'admission accepts consent to the candidate notice',
      'admission accepts consent to the staff dry-run notice',
      "a candidate consent without ' || consent_key",
      "a staff consent without ' || consent_key",
      'the phone consent vocabulary does not satisfy an R1 round',
      'a withdrawn consent to the new release refuses admission',
    ]) {
      expect(ASSERT_SQL, label).toContain(label);
    }
  });

  it('proves the reviewed text changes: providers, withdrawal wording, complaints route', () => {
    for (const label of [
      "('Vercel hosting', '%Vercel: hosts the interview web page%')",
      "('LiveKit mode', '%LiveKit runs on a server we operate at Fly.io (Singapore) or%')",
      "('withdrawal ends scoring', '%After you withdraw, we will not score the %')",
      "('withdrawal not penalised', '%Withdrawing will not count against you%')",
      "('complaints route', '%questions and complaints about your data to the same contact%')",
      'notice has no ambiguous withdrawal sentence',
      "body not ilike '%because of it%'",
    ]) {
      expect(ASSERT_SQL, label).toContain(label);
    }
  });
});
