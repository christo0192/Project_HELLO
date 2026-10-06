/**
 * The synthetic world the offline harness serves.
 *
 * EVERYTHING HERE IS INVENTED. Names are fictional composites, every email is
 * on `example.com` (RFC 2606), every phone number is in the NANP 555-01xx
 * range reserved for fiction, and every id is a deterministic, obviously
 * synthetic UUID. No row was copied from, or shaped after, a real candidate,
 * recruiter, job or company tenant — so a screenshot of any route can be
 * shared without review.
 *
 * TYPED AGAINST THE APP, NOT RE-DECLARED. Every collection is annotated with
 * the wire type from `src/types.ts` (type-only import, erased at runtime), so
 * a contract change there breaks `npm run e2e:typecheck` here instead of
 * silently rendering a half-populated page.
 *
 * DETERMINISTIC. Every instant is an offset from `FROZEN_NOW_MS` (the clock
 * the browser is pinned to) and the few "random" series come from a seeded
 * PRNG, so two runs render byte-identical pages.
 *
 * `createDataset()` returns a FRESH deep copy per page: write endpoints may
 * mutate it (a created note shows up on reload) without leaking into the next
 * test.
 */

import type {
  AdminAllowlistEntry,
  AdminAuditRow,
  AdminMember,
  AdminSessionRow,
  AppealRow,
  Assessment,
  AshbyCandidateWorkflow,
  AshbyFeedbackForm,
  AshbyJob,
  AshbyMcMapping,
  AshbyMcWorkflow,
  AshbyScorecardBindingPreviewResponse,
  Candidate,
  CandidateDetail,
  CandidatePhoneAttempt,
  CandidateResumeFacts,
  FunnelCandidateRow,
  FunnelDailyRow,
  FunnelFailuresResponse,
  FunnelSummaryResponse,
  FunnelSummaryTotals,
  MeResponse,
  Note,
  NotificationIntent,
  PhoneCalendarAppointment,
  PhoneScreeningCycle,
  PhoneSlot,
  PhoneWindow,
  PublicStatus,
  QuotaPolicy,
  Recommendation,
  Role,
  RoleScorecardMetric,
  RoleScorecardVersion,
  ScorecardMetricTemplate,
  ScorecardRubric,
  ScreeningCategory,
  ScreeningQuestion,
  Session,
  SessionDetail,
  TranscriptLine,
} from '../../src/types';
import { FROZEN_NOW_MS } from './env';

/* ── Time + id helpers ────────────────────────────────────────────────── */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** IST is a fixed +05:30 offset (no DST), so it can be applied arithmetically. */
const IST_OFFSET = 5.5 * HOUR;

const iso = (ms: number): string => new Date(ms).toISOString();
/** An instant `ms` before the frozen "now". */
const ago = (ms: number): string => iso(FROZEN_NOW_MS - ms);

/** `YYYY-MM-DD` and `HH:MM` of an instant, on the IST wall clock. */
function istParts(ms: number): { date: string; time: string } {
  const shifted = new Date(ms + IST_OFFSET).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

/** UTC instant of an IST wall-clock time (`date` YYYY-MM-DD, `time` HH:MM). */
export function istToUtcMs(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00Z`) - IST_OFFSET;
}

/**
 * A synthetic UUID: the first hex digit names the kind of record, the next
 * seven carry its ordinal in hex, the tail repeats it in decimal. Shaped like
 * a v4 UUID, unmistakably generated when read — and distinct in its first
 * eight characters, because that is the prefix the UI prints
 * ("Session 30000002"), so two records never look like one on screen.
 */
function uid(kind: string, n: number): string {
  return `${kind}${n.toString(16).padStart(7, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Tiny seeded PRNG (mulberry32): the funnel series must be identical every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Identity ─────────────────────────────────────────────────────────── */

export const ADMIN_USER_ID = uid('f', 1);
export const ADMIN_EMAIL = 'e2e.admin@example.com';

const ME: MeResponse = { userId: ADMIN_USER_ID, email: ADMIN_EMAIL, role: 'admin', active: true };

/* ── Roles ────────────────────────────────────────────────────────────── */

type Q = [ScreeningCategory | undefined, string, number?, boolean?];

function template(rows: Q[]): ScreeningQuestion[] {
  return rows.map(([category, question, weight = 1, mandatory = false], i) => ({
    id: `q${i + 1}`,
    question,
    weight,
    ...(mandatory ? { mandatory: true } : {}),
    ...(category ? { category } : {}),
  }));
}

/** Shared closing compartment: every role asks pay and notice, and must. */
const PAY_AND_NOTICE: Q[] = [
  ['compensation', 'What is your current CTC, and what range are you expecting for this move?', 1, true],
  ['compensation', 'What is your notice period, and is any part of it negotiable?', 1, true],
];

export const ROLE_IDS = {
  backend: uid('1', 1),
  frontend: uid('1', 2),
  data: uid('1', 3),
  sre: uid('1', 4),
  support: uid('1', 5),
  qa: uid('1', 6),
} as const;

const ROLES: Role[] = [
  {
    id: ROLE_IDS.backend,
    title: 'Senior Backend Engineer',
    agent_name: 'Asha · backend screens',
    jd: 'Own the services behind a live interview-preparation platform: design APIs in Go and TypeScript, run PostgreSQL at scale and keep p99 latency honest. You will pair with product on roadmap trade-offs and mentor two mid-level engineers.',
    required_skills: ['Go', 'PostgreSQL', 'Kubernetes', 'gRPC', 'System design'],
    screening_template: template([
      ['introduction', 'Could you walk me through your current role and the systems you own day to day?'],
      ['profile_relevance', 'Tell me about a service you designed that had to absorb a sudden jump in traffic. What did you change?', 2],
      ['profile_relevance', 'How do you decide whether a slow PostgreSQL query needs an index or a schema change?', 2],
      ['shift_fit', 'This role overlaps with a US team until 10 pm IST twice a week. How would that work for you?', 1, true],
      ['stability', 'What would keep you in your next role for the next three years?'],
      ...PAY_AND_NOTICE,
    ]),
    interviewer_instructions: 'Keep the call under ten minutes. Probe for concrete numbers on scale.',
    is_active: true,
    created_at: ago(62 * DAY),
  },
  {
    id: ROLE_IDS.frontend,
    title: 'Frontend Engineer',
    agent_name: 'Kiran · web',
    jd: 'Build the recruiter workspace in React and TypeScript. You care about accessible, fast interfaces and you test the behaviour users rely on rather than implementation details.',
    required_skills: ['React', 'TypeScript', 'Accessibility', 'Testing Library'],
    screening_template: template([
      ['introduction', 'Could you give me a quick overview of your experience building web applications?'],
      ['profile_relevance', 'How do you make sure a new component works for keyboard and screen-reader users?', 2],
      ['profile_relevance', 'Tell me about a performance problem you found in a React app and how you fixed it.', 2],
      ['stability', 'Why are you looking for a change at this point in your career?'],
      ...PAY_AND_NOTICE,
    ]),
    interviewer_instructions: '',
    is_active: true,
    created_at: ago(48 * DAY),
  },
  {
    id: ROLE_IDS.data,
    title: 'Data Analyst',
    agent_name: 'Meera · analytics',
    jd: 'Turn funnel and engagement data into decisions. Strong SQL, comfortable in Python notebooks, and able to explain a confidence interval to a non-technical stakeholder.',
    required_skills: ['SQL', 'Python', 'Looker', 'Statistics'],
    screening_template: template([
      ['introduction', 'Could you tell me about the kind of analysis you do in your current role?'],
      ['profile_relevance', 'Walk me through a metric you defined from scratch. How did you validate it?', 2],
      ['shift_fit', 'The team works a 10 am to 7 pm IST day with one on-call weekend a month. Does that suit you?'],
      ...PAY_AND_NOTICE,
    ]),
    interviewer_instructions: '',
    is_active: true,
    created_at: ago(40 * DAY),
  },
  {
    id: ROLE_IDS.sre,
    title: 'Site Reliability Engineer',
    agent_name: 'Dev · infra',
    jd: 'Keep a multi-region platform boring. Terraform, AWS, Prometheus and a calm head during incidents. You will own the on-call rotation tooling.',
    required_skills: ['Terraform', 'AWS', 'Prometheus', 'Incident response'],
    screening_template: template([
      ['introduction', 'Could you describe the infrastructure you are responsible for today?'],
      ['profile_relevance', 'Tell me about the last incident you led. What did the timeline look like?', 2],
      ['shift_fit', 'This role includes a weekly on-call shift. How have you handled on-call before?', 1, true],
      ...PAY_AND_NOTICE,
    ]),
    interviewer_instructions: '',
    is_active: true,
    created_at: ago(33 * DAY),
  },
  {
    id: ROLE_IDS.support,
    title: 'Customer Success Associate',
    agent_name: 'Tara · support',
    jd: 'Be the first voice learners hear. Resolve questions over chat and phone in English and Hindi, and turn repeated issues into help-centre articles.',
    required_skills: ['Communication', 'CRM', 'English', 'Hindi'],
    screening_template: template([
      ['introduction', 'Could you tell me a little about yourself and your customer-facing experience?'],
      ['profile_relevance', 'Describe a time you calmed down an upset customer. What did you say?', 2],
      ['shift_fit', 'Shifts rotate between 7 am and 11 pm IST. Which shifts could you commit to?', 1, true],
      ['stability', 'Where do you see yourself growing in a support career?'],
      ...PAY_AND_NOTICE,
    ]),
    interviewer_instructions: '',
    is_active: true,
    created_at: ago(21 * DAY),
  },
  {
    // A retired role authored before compartments existed: no categories,
    // no agent name. Kept so the list shows an "Inactive" card and the
    // ungrouped question layout.
    id: ROLE_IDS.qa,
    title: 'QA Automation Engineer',
    agent_name: null,
    jd: 'Maintain the end-to-end suite for the legacy assessment product.',
    required_skills: ['Selenium', 'Java'],
    screening_template: template([
      [undefined, 'Tell me about the test automation framework you know best.'],
      [undefined, 'How do you decide what not to automate?'],
    ]),
    interviewer_instructions: '',
    is_active: false,
    created_at: ago(180 * DAY),
  },
];

/* ── Scorecard metric library ("Scorebar") + role scorecards ─────────── */

function rubric(poor: string, average: string, good: string, excellent: string): ScorecardRubric {
  return { 1: poor, 2: average, 3: good, 4: excellent };
}

const METRICS: ScorecardMetricTemplate[] = [
  {
    key: 'communication_clarity',
    name: 'Communication clarity',
    description: 'How clearly the candidate explains their own work.',
    default_instruction: 'Assess whether answers are structured, specific and easy to follow. Penalise rambling, reward concrete examples.',
    rubric: rubric('Hard to follow; answers drift', 'Understandable with effort', 'Clear and mostly structured', 'Crisp, structured, example-led'),
  },
  {
    key: 'technical_depth',
    name: 'Technical depth',
    description: 'Depth of understanding in the core skills of the role.',
    default_instruction: 'Look for reasoning about trade-offs, failure modes and numbers — not just tool names.',
    rubric: rubric('Names tools only', 'Explains the basics', 'Reasons about trade-offs', 'Anticipates failure modes with evidence'),
  },
  {
    key: 'problem_solving',
    name: 'Problem solving',
    description: 'Approach to unfamiliar or ambiguous problems.',
    default_instruction: 'Assess how the candidate breaks down a problem they described, including what they tried first and why.',
    rubric: rubric('No clear approach', 'Trial and error', 'Structured approach', 'Structured, hypothesis-driven, measured'),
  },
  {
    key: 'role_motivation',
    name: 'Role motivation',
    description: 'Why this role, and why now.',
    default_instruction: 'Assess whether the motivation for the move is specific to this role rather than generic.',
    rubric: rubric('No stated reason', 'Generic reasons', 'Specific to the role', 'Specific, researched and consistent'),
  },
  {
    key: 'ownership',
    name: 'Ownership',
    description: 'Evidence of owning outcomes end to end.',
    default_instruction: 'Credit examples where the candidate drove an outcome past the edge of their assigned task.',
    rubric: rubric('Describes tasks only', 'Owns assigned tasks', 'Owns outcomes', 'Owns outcomes and follow-through'),
  },
  {
    key: 'stakeholder_management',
    name: 'Stakeholder management',
    description: 'Working with product, design and non-technical partners.',
    default_instruction: 'Assess how the candidate negotiates scope and communicates trade-offs with non-engineers.',
    rubric: rubric('Avoids stakeholders', 'Reactive updates', 'Proactive updates', 'Shapes decisions with partners'),
  },
  {
    key: 'english_proficiency',
    name: 'English proficiency',
    description: 'Spoken English for a client-facing context.',
    default_instruction: 'Assess grammar, vocabulary and fluency on the call. Do not penalise accent.',
    rubric: rubric('Frequent breakdowns', 'Understandable, many errors', 'Fluent, minor errors', 'Fluent and precise'),
  },
  {
    key: 'availability_fit',
    name: 'Availability and notice',
    description: 'Shift fit and how soon the candidate can join.',
    default_instruction: 'Assess shift compatibility and notice period against the role requirements stated on the call.',
    rubric: rubric('Incompatible', 'Needs major exceptions', 'Minor adjustments', 'Fully compatible'),
  },
].map((m, i) => ({
  ...m,
  id: uid('d', i + 1),
  archived_at: null,
  version: i === 1 ? 3 : i === 0 ? 2 : 1,
  created_at: ago((90 - i) * DAY),
  updated_at: ago((20 - i) * DAY),
  created_by: ADMIN_USER_ID,
}));

function roleScorecard(roleId: string, n: number, picks: Array<[key: string, weightBps: number]>): RoleScorecardVersion {
  const metrics: RoleScorecardMetric[] = picks.map(([key, weightBps], i) => {
    const lib = METRICS.find((m) => m.key === key)!;
    return {
      id: uid('e', n * 100 + i + 1),
      libraryMetricId: lib.id,
      key: lib.key,
      name: lib.name,
      instruction: lib.default_instruction,
      rubric: lib.rubric,
      weightBps,
      displayOrder: i,
    };
  });
  return { id: uid('e', n), roleId, version: 2, configurationHash: `sha256:e2e${n}`, metrics };
}

const ROLE_SCORECARDS: Record<string, RoleScorecardVersion> = {
  [ROLE_IDS.backend]: roleScorecard(ROLE_IDS.backend, 1, [
    ['communication_clarity', 2500],
    ['technical_depth', 3000],
    ['problem_solving', 2000],
    ['role_motivation', 1000],
    ['ownership', 1500],
  ]),
  [ROLE_IDS.data]: roleScorecard(ROLE_IDS.data, 2, [
    ['communication_clarity', 3000],
    ['problem_solving', 3000],
    ['english_proficiency', 2000],
    ['role_motivation', 2000],
  ]),
};

/* ── Candidates ───────────────────────────────────────────────────────── */

type RoleKey = keyof typeof ROLE_IDS;

interface CandidateSeed {
  name: string | null;
  status: string;
  role: RoleKey;
  exp: number | null;
  rec: Recommendation | null;
  score: number | null;
  review: Candidate['resume_review'];
  daysAgo: number;
  skills: string[];
  /** Phone-screen progress, when the default for the status is not the story. */
  phone?: PhoneProgress;
}

/** The four phone-progress fields `GET /api/candidates` (and detail) carry. */
type PhoneProgress = Required<Pick<Candidate, 'dial_count' | 'phone_state' | 'phone_state_reason' | 'last_dialed_at'>>;

/** Newest first, which is the order `GET /api/candidates` returns. */
const CANDIDATE_SEEDS: CandidateSeed[] = [
  // Three reached dials (no answer, dropped at the consent check, the full
  // screen): see phoneAttempts. A settled status, so no "(dialed N)" suffix.
  { name: 'Meera Iyer', status: 'screened', role: 'backend', exp: 7, rec: 'advance', score: 86, review: 'ready', daysAgo: 0.2, skills: ['Go', 'PostgreSQL', 'Kafka', 'Kubernetes'], phone: { dial_count: 3, phone_state: 'completed', phone_state_reason: null, last_dialed_at: ago(4 * HOUR) } },
  { name: 'Rohan Deshpande', status: 'advanced', role: 'backend', exp: 9, rec: 'advance', score: 91, review: 'ready', daysAgo: 1, skills: ['Java', 'PostgreSQL', 'gRPC', 'AWS'] },
  // A PII-minimal Ashby import shell: no name until the resume parses.
  { name: null, status: 'new', role: 'frontend', exp: null, rec: null, score: null, review: 'processing', daysAgo: 0.1, skills: [] },
  { name: 'Ananya Chaudhary', status: 'screening', role: 'data', exp: 3, rec: null, score: null, review: 'ready', daysAgo: 0.5, skills: ['SQL', 'Python', 'Tableau'] },
  // Mid-cycle: "Queued (dialed 2)". Two dials reached the phone (a no answer
  // and a lease-reclaimed "Call interrupted"); a third was deferred by our
  // infrastructure before ringing and does not count. See phoneAttempts.
  { name: 'Vikram Pillai', status: 'queued', role: 'sre', exp: 6, rec: null, score: null, review: 'ready', daysAgo: 1.2, skills: ['Terraform', 'AWS', 'Grafana'], phone: { dial_count: 2, phone_state: 'awaiting_retry', phone_state_reason: null, last_dialed_at: ago(3 * HOUR) } },
  { name: 'Sara Lindqvist', status: 'rejected', role: 'frontend', exp: 2, rec: 'reject', score: 38, review: 'ready', daysAgo: 2, skills: ['Vue', 'CSS'] },
  { name: 'Diego Ferreira', status: 'screened', role: 'sre', exp: 8, rec: 'hold', score: 64, review: 'ready', daysAgo: 2.5, skills: ['Kubernetes', 'GCP', 'Prometheus'] },
  { name: 'Wei Zhang', status: 'new', role: 'backend', exp: 5, rec: null, score: null, review: 'needs_review', daysAgo: 3, skills: ['Rust', 'PostgreSQL'] },
  { name: 'Fatima Qureshi', status: 'advanced', role: 'data', exp: 4, rec: 'advance', score: 82, review: 'ready', daysAgo: 3.5, skills: ['SQL', 'dbt', 'Looker'] },
  { name: 'Arjun Rao', status: 'screened', role: 'support', exp: 1, rec: 'hold', score: 58, review: null, daysAgo: 4, skills: ['Zendesk', 'Hindi', 'English'] },
  { name: 'Nisha Menon', status: 'rejected', role: 'backend', exp: 3, rec: 'reject', score: 41, review: 'ready', daysAgo: 4.5, skills: ['Node.js', 'MongoDB'] },
  { name: 'Kabir Anand', status: 'consent_declined', role: 'frontend', exp: 4, rec: null, score: null, review: null, daysAgo: 5, skills: ['React', 'Redux'] },
  { name: 'Isha Kulkarni', status: 'screened', role: 'frontend', exp: 5, rec: 'advance', score: 79, review: 'ready', daysAgo: 6, skills: ['React', 'TypeScript', 'Playwright'] },
  { name: 'Omar Haddad', status: 'new', role: 'support', exp: 2, rec: null, score: null, review: 'cancelled', daysAgo: 6.5, skills: ['Freshdesk', 'English', 'Arabic'] },
  { name: 'Tanvi Joshi', status: 'advanced', role: 'frontend', exp: 6, rec: 'advance', score: 88, review: 'ready', daysAgo: 7, skills: ['React', 'TypeScript', 'WCAG'] },
  { name: 'Rahul Bhatia', status: 'screening', role: 'backend', exp: 10, rec: null, score: null, review: 'ready', daysAgo: 8, skills: ['Go', 'Redis', 'Kubernetes'] },
  { name: "Leena D'Souza", status: 'screened', role: 'data', exp: 2, rec: 'reject', score: 45, review: 'ready', daysAgo: 9, skills: ['Excel', 'SQL'] },
  { name: 'Karthik Subramanian', status: 'advanced', role: 'sre', exp: 11, rec: 'advance', score: 90, review: 'ready', daysAgo: 9.5, skills: ['AWS', 'Terraform', 'Incident response'] },
  { name: 'Zoya Mirza', status: 'rejected', role: 'support', exp: 1, rec: 'reject', score: 33, review: null, daysAgo: 10, skills: ['English'] },
  { name: 'Aditya Ghosh', status: 'new', role: 'sre', exp: 4, rec: null, score: null, review: 'ready', daysAgo: 11, skills: ['Ansible', 'Linux'] },
  { name: 'Neha Saxena', status: 'queued', role: 'data', exp: 3, rec: null, score: null, review: 'ready', daysAgo: 12, skills: ['Python', 'pandas', 'SQL'] },
  { name: 'Samuel Okafor', status: 'screened', role: 'backend', exp: 7, rec: 'hold', score: 67, review: 'ready', daysAgo: 12.5, skills: ['C#', '.NET', 'SQL Server'] },
  { name: 'Priya Natarajan', status: 'rejected', role: 'frontend', exp: 5, rec: 'reject', score: 49, review: 'ready', daysAgo: 13, skills: ['Angular', 'RxJS'] },
  { name: 'Harsh Vora', status: 'new', role: 'qa', exp: 3, rec: null, score: null, review: null, daysAgo: 13.5, skills: ['Selenium', 'Java'] },
  // Appended (oldest) so every index above keeps its id, phone and sessions.
  // The stored status stays "queued" for the whole cycle; the ended cycle
  // makes it "Abandoned: no answer". The accented name exercises the
  // diacritic-insensitive search (`?q=lucia`).
  { name: 'Lucía Fernández', status: 'queued', role: 'backend', exp: 4, rec: null, score: null, review: 'ready', daysAgo: 14, skills: ['Python', 'Django', 'PostgreSQL'], phone: { dial_count: 3, phone_state: 'abandoned_no_answer', phone_state_reason: 'no_answer_budget_exhausted', last_dialed_at: ago(2 * DAY) } },
];

function emailFor(name: string | null): string | null {
  if (!name) return null;
  const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return `${ascii.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.')}@example.com`;
}

/**
 * The default phone progress for a seed's status. No usable phone → never
 * dialled. A decided or in-flight screen was reached on one dial, at the
 * moment its session started (see addSession). Everyone else is undialled.
 */
function defaultPhoneProgress(s: CandidateSeed, hasPhone: boolean, createdMs: number): PhoneProgress {
  const none: PhoneProgress = { dial_count: 0, phone_state: null, phone_state_reason: null, last_dialed_at: null };
  if (!hasPhone) return none;
  const dialedAt = iso(createdMs + 3 * HOUR);
  if (['screened', 'advanced', 'rejected'].includes(s.status)) {
    return { dial_count: 1, phone_state: 'completed', phone_state_reason: null, last_dialed_at: dialedAt };
  }
  if (s.status === 'consent_declined') {
    return { dial_count: 1, phone_state: 'opted_out', phone_state_reason: 'disclosure_refused', last_dialed_at: dialedAt };
  }
  if (s.status === 'screening') return { dial_count: 1, phone_state: 'in_call', phone_state_reason: null, last_dialed_at: dialedAt };
  return none;
}

const CANDIDATES: Candidate[] = CANDIDATE_SEEDS.map((s, i) => {
  // Every third candidate has no usable phone: a real, common state that the
  // phone surfaces must render truthfully.
  const hasPhone = s.name !== null && i % 3 !== 2;
  const createdMs = FROZEN_NOW_MS - s.daysAgo * DAY;
  return {
    id: uid('2', i + 1),
    name: s.name,
    email: emailFor(s.name),
    phone_e164: hasPhone ? `+1202555${String(100 + i).padStart(4, '0')}` : null,
    phone_valid: hasPhone,
    skills: s.skills,
    experience_years: s.exp,
    status: s.status,
    role_id: ROLE_IDS[s.role],
    created_at: ago(s.daysAgo * DAY),
    latest_recommendation: s.rec,
    latest_score: s.score,
    resume_review: s.review,
    ...(s.phone ?? defaultPhoneProgress(s, hasPhone, createdMs)),
  };
});

/** The richly populated candidate the detail-page tests open. */
export const STAR_CANDIDATE_ID = CANDIDATES[0].id;
/** An advanced candidate whose only assessment is a legacy (v1) scorecard. */
export const LEGACY_CANDIDATE_ID = CANDIDATES[1].id;
/** Stored "queued", mid-cycle after two reached dials: "Queued (dialed 2)". */
export const DIALED_CANDIDATE_ID = CANDIDATES.find((c) => c.name === 'Vikram Pillai')!.id;
/** Stored "queued", cycle ended on the no-answer budget: "Abandoned: no answer". */
export const ABANDONED_CANDIDATE_ID = CANDIDATES.find((c) => c.name === 'Lucía Fernández')!.id;

/* ── Sessions, transcripts and assessments ───────────────────────────── */

const ANSWERS: Record<ScreeningCategory | 'none', string[]> = {
  introduction: [
    'Sure. I lead a team of four and own the payments reconciliation services end to end.',
    'I have spent the last few years building internal tools, mostly on the analytics side.',
  ],
  profile_relevance: [
    'During a sale our checkout traffic went up about eight times. We moved the hot path behind a queue and added read replicas, which kept p99 under 300 milliseconds.',
    'I usually start with EXPLAIN ANALYZE. If the plan shows a sequential scan on a selective filter, an index is enough; if the access pattern itself is wrong, I change the schema.',
  ],
  shift_fit: ['Two late evenings a week is fine for me, as long as the rest of the week is flexible.'],
  stability: ['I want to stay somewhere I can grow into a staff role and see a product through several years.'],
  compensation: ['My current CTC is in line with the market for my level, and I am looking for a reasonable hike.', 'My notice period is sixty days, and I can negotiate it down to about forty-five.'],
  none: ['I have mostly worked with Selenium and a page-object framework in Java.'],
};

/** A realistic transcript for a role: disclosure gate, then each question and answer. */
function transcriptFor(role: Role, gateOnly = false): TranscriptLine[] {
  const lines: TranscriptLine[] = [
    { speaker: 'bot', text: `Hello, this is ${role.agent_name?.split(' ·')[0] ?? 'the screening assistant'}, an AI interviewer calling about the ${role.title} role. This call is recorded. Is now a good time?`, start_offset_sec: 0, is_gate: true },
    { speaker: 'candidate', text: 'Yes, now is fine.', start_offset_sec: 7.4, is_gate: true },
    { speaker: 'bot', text: 'Thank you. Do you consent to this call being recorded and assessed?', start_offset_sec: 9.1, is_gate: true },
  ];
  if (gateOnly) return lines;
  lines.push({ speaker: 'candidate', text: 'Yes, I consent.', start_offset_sec: 13.2, is_gate: true });
  let t = 16;
  const used: Record<string, number> = {};
  for (const q of role.screening_template) {
    const cat = q.category ?? 'none';
    const pool = ANSWERS[cat];
    const answer = pool[(used[cat] = (used[cat] ?? -1) + 1) % pool.length];
    lines.push({ speaker: 'bot', text: q.question, start_offset_sec: t });
    t += 6 + q.question.length / 18;
    lines.push({ speaker: 'candidate', text: answer, start_offset_sec: Math.round(t * 10) / 10 });
    t += 8 + answer.length / 14;
  }
  lines.push({ speaker: 'bot', text: 'Thank you, that is everything from my side. The hiring team will be in touch.', start_offset_sec: Math.round(t) });
  return lines;
}

/** A four-level (v2) role-scorecard assessment, carried in `raw` as the API stores it. */
function v2Assessment(
  id: string,
  scorecard: RoleScorecardVersion,
  scores: Array<1 | 2 | 3 | 4 | null>,
  recommendation: 'advance' | 'hold' | 'reject',
  overall: number,
): Assessment {
  const metricResults = scorecard.metrics.map((metric, i) => {
    const score = scores[i] ?? null;
    return {
      configMetricId: metric.id,
      score,
      evidenceStatus: score === null ? ('insufficient_evidence' as const) : ('scored' as const),
      rationale:
        score === null
          ? 'The call ran out of time before this topic was covered.'
          : `${metric.name}: ${metric.rubric[score]}. Answers stayed specific and consistent with the resume.`,
      evidenceRefs: score === null ? [] : ['Described moving the hot path behind a queue', 'Quoted p99 latency before and after'],
      metric,
    };
  });
  const scored = metricResults.filter((r) => r.score !== null);
  const weightTotal = scored.reduce((s, r) => s + r.metric.weightBps, 0);
  const weighted = scored.reduce((s, r) => s + (r.score ?? 0) * r.metric.weightBps, 0) / (weightTotal || 1);
  const status = scored.length === metricResults.length ? 'complete' : 'incomplete_evidence';
  return {
    id,
    schema_version: 2,
    scorecard_version_id: scorecard.id,
    revision: 1,
    scoring_status: status,
    weighted_score_5: Math.round(weighted * 100) / 100,
    score_scale_max: 4,
    overall_score: overall,
    recommendation,
    summary: 'Strong, specific answers on scaling and data modelling; motivation is clear and consistent with the resume.',
    metric_results: metricResults.map(({ metric: _metric, ...rest }) => rest),
    // v1 dimension fields are NOT populated on a v2 row; the cast mirrors the
    // wire exactly rather than inventing them.
    raw: {
      schemaVersion: 2,
      scorecardVersionId: scorecard.id,
      revision: 1,
      status,
      scoreScaleMax: 4,
      metricResults,
      weightedScore5: Math.round(weighted * 100) / 100,
      overallScore: overall,
      recommendation,
    } as unknown as Assessment['raw'],
  } as Assessment;
}

/** A legacy (v1) dimension assessment: the 0–10 bars and the English band. */
function v1Assessment(id: string, overall: number, recommendation: Recommendation, role: Role): Assessment {
  const lean = overall / 10;
  const r1 = (n: number) => Math.max(1, Math.min(10, Math.round(n)));
  return {
    id,
    schema_version: 1,
    overall_score: overall,
    recommendation,
    summary:
      recommendation === 'advance'
        ? 'Confident, well-structured answers with concrete metrics. Recommended for the technical round.'
        : recommendation === 'hold'
          ? 'Relevant experience but thin detail on scale. Worth a second look against the shortlist.'
          : 'Answers stayed generic and did not match the depth the role needs.',
    english: { band: lean >= 7 ? 'C1' : lean >= 5 ? 'B2' : 'B1', grammar: r1(lean), vocabulary: r1(lean - 0.5), fluency: r1(lean + 0.3), coherence: r1(lean), notes: 'Clear pronunciation; occasional filler words under pressure.' },
    tone: { clarity: r1(lean), confidence: r1(lean + 0.5), professionalism: r1(lean + 1), sentiment: 'positive', notes: 'Calm and courteous throughout.' },
    communication: {
      score: r1(lean),
      notes: 'Structured answers with examples.',
      clarity: r1(lean),
      structure: r1(lean - 0.4),
      listening: r1(lean + 0.2),
      rapport: r1(lean + 0.6),
      filler_usage: { level: 'low', examples: ['you know'], impact_score: 2, notes: 'Rare, did not affect clarity.' },
      native_language_usage: { level: 'none', examples: [], impact_score: 0, notes: 'Answered entirely in English.' },
    },
    motivation: { score: r1(lean + 0.5), notes: 'Wants ownership of a product area and a longer tenure.' },
    role_fit: {
      score: r1(lean),
      matched_skills: role.required_skills.slice(0, 3),
      gaps: role.required_skills.slice(3),
      red_flags: recommendation === 'reject' ? ['Could not describe their own contribution to the project they led'] : [],
      notes: `Evaluated against the ${role.title} requirements.`,
    },
    resume_conflicts: [
      { topic: 'Team size', resume_says: 'Led a team of 6', candidate_said: 'Led a team of 4', resolved: true, note: 'Two engineers moved teams mid-year.' },
    ],
  };
}

const sessions: Session[] = [];
const sessionDetails: Record<string, SessionDetail> = {};
const candidateAssessments: Record<string, Assessment[]> = {};

function addSession(candidate: Candidate, n: number, over: Partial<Session> & { gateOnly?: boolean; assessment?: Assessment | null }): Session {
  const role = ROLES.find((r) => r.id === candidate.role_id)!;
  const startedMs = Date.parse(candidate.created_at) + 3 * HOUR + n * 17 * MIN;
  const { gateOnly = false, assessment = null, ...rest } = over;
  const session: Session = {
    id: uid('3', n),
    candidate_id: candidate.id,
    role_id: candidate.role_id,
    status: 'completed',
    mode: 'live',
    duration_sec: gateOnly ? 9 : 400 + (n % 5) * 37,
    created_at: iso(startedMs - 2 * MIN),
    started_at: iso(startedMs),
    ended_at: iso(startedMs + (gateOnly ? 9_000 : (400 + (n % 5) * 37) * 1000)),
    candidate_words: gateOnly ? 4 : 640 + (n % 7) * 45,
    done: true,
    ...rest,
  };
  // M013 S02: the candidate read's per-session roll-up. A one-leg phone call
  // whose end was observed: connected = the call, recorded about a second
  // shorter (the worker starts recording after the answer). A call that has
  // not ended yet has no figures.
  const length = session.duration_sec;
  if (session.mode === 'live' && typeof length === 'number' && length > 0) {
    Object.assign(session, {
      duration_unobserved_legs: 0,
      recorded_total_sec: Math.max(1, length - 1),
      recorded_legs: 1,
      connected_complete: true,
      connected_total_sec: length,
    } satisfies Partial<Session>);
  }
  sessions.push(session);
  const transcript = session.status === 'created' || session.status === 'waiting' ? [] : transcriptFor(role, gateOnly || session.status === 'in_progress');
  sessionDetails[session.id] = { session, transcript, assessment };
  if (assessment) (candidateAssessments[candidate.id] ??= []).push(assessment);
  return session;
}

let sessionSeq = 1;
let assessmentSeq = 1;
CANDIDATES.forEach((c, i) => {
  const role = ROLES.find((r) => r.id === c.role_id)!;
  const scorecard = ROLE_SCORECARDS[role.id];
  if (i === 0) {
    // The star candidate: a call that died at the consent gate, then a full
    // screen scored on the role's v2 scorecard (one metric short on evidence).
    addSession(c, sessionSeq++, { gateOnly: true, status: 'failed', duration_sec: 9 });
    addSession(c, sessionSeq++, { assessment: v2Assessment(uid('4', assessmentSeq++), ROLE_SCORECARDS[ROLE_IDS.backend], [4, 3, 4, 3, null], 'advance', 86) });
    return;
  }
  if (['screened', 'advanced', 'rejected'].includes(c.status) && c.latest_score != null && c.latest_recommendation) {
    // Alternate the two scorecard generations where the role supports v2.
    const useV2 = scorecard && i % 2 === 0;
    // Metric scores sit around the overall score (0–100 → 1–4), nudged per
    // metric so the rubric bars are not one flat line.
    const base = Math.round(c.latest_score / 25);
    const levels = scorecard?.metrics.map((_, k) => Math.max(1, Math.min(4, base + (k % 3) - 1)) as 1 | 2 | 3 | 4) ?? [];
    const assessment = useV2
      ? v2Assessment(uid('4', assessmentSeq++), scorecard, levels, c.latest_recommendation as 'advance' | 'hold' | 'reject', c.latest_score)
      : v1Assessment(uid('4', assessmentSeq++), c.latest_score, c.latest_recommendation, role);
    addSession(c, sessionSeq++, { assessment });
    return;
  }
  if (c.status === 'screening') addSession(c, sessionSeq++, { status: 'in_progress', ended_at: null, duration_sec: null, candidate_words: null, done: false });
  if (c.status === 'queued') addSession(c, sessionSeq++, { status: 'created', started_at: null, ended_at: null, duration_sec: null, candidate_words: null, done: false });
  if (c.status === 'consent_declined') addSession(c, sessionSeq++, { gateOnly: true, status: 'cancelled', duration_sec: 21, candidate_words: 6 });
});

/** Session whose assessment is the legacy v1 dimension scorecard. */
export const LEGACY_SESSION_ID = sessions.find((s) => s.candidate_id === LEGACY_CANDIDATE_ID)!.id;
/** The star candidate's full, v2-scored session. */
export const V2_SESSION_ID = sessions.filter((s) => s.candidate_id === STAR_CANDIDATE_ID)[1].id;

/*
 * M013 S02 (T08a): the legacy candidate's screening spans TWO phone legs.
 * The first call dropped (its end is on the ledger; a legacy worker MP3, so
 * its length is an estimate and its tail may be missing), and the reconnect
 * then dropped with NO observed end (closed only by the lease reclaim about
 * six minutes later). Its turns carry their own start, so the Review tab can
 * place each on its leg and seek within that leg's file. Synthetic timings.
 */
const legacySession = sessions.find((s) => s.id === LEGACY_SESSION_ID)!;
const legacyTurns = sessionDetails[LEGACY_SESSION_ID].transcript;
const LEGACY_A_ANSWERED_MS = Date.parse(legacySession.started_at!);
/** Session offsets past this were spoken on the reconnect. */
const LEGACY_SPLIT_SEC = (legacyTurns[Math.floor(legacyTurns.length / 2)].start_offset_sec ?? 0) - 0.5;
const LEGACY_LAST_SEC = legacyTurns[legacyTurns.length - 1].start_offset_sec ?? 0;
const LEGACY_A_CONNECTED_SEC = Math.round(LEGACY_SPLIT_SEC + 8);
const LEGACY_B_ADMITTED_MS = LEGACY_A_ANSWERED_MS + (LEGACY_A_CONNECTED_SEC + 40) * 1000;
const LEGACY_B_ANSWERED_MS = LEGACY_B_ADMITTED_MS + 12_000;
const LEGACY_B_RECORDING_MS = LEGACY_B_ANSWERED_MS + 900;
const LEGACY_A_RECORDED_SEC = Math.round((LEGACY_SPLIT_SEC + 2) * 10) / 10;
const LEGACY_B_RECORDED_SEC = Math.round((LEGACY_LAST_SEC - LEGACY_SPLIT_SEC + 12) * 10) / 10;
sessionDetails[LEGACY_SESSION_ID].transcript = legacyTurns.map((t) => {
  const offset = t.start_offset_sec ?? 0;
  const startedAt = offset <= LEGACY_SPLIT_SEC
    ? LEGACY_A_ANSWERED_MS + 1000 + offset * 1000
    : LEGACY_B_RECORDING_MS + 2000 + (offset - LEGACY_SPLIT_SEC) * 1000;
  // No session egress anchor on a worker in-band session: no session offset.
  return { ...t, start_offset_sec: null, started_at_ms: Math.round(startedAt) };
});
Object.assign(legacySession, {
  // 0118: the unobserved reconnect is left out of duration_sec.
  duration_sec: LEGACY_A_CONNECTED_SEC,
  duration_unobserved_legs: 1,
  recorded_total_sec: Math.round((LEGACY_A_RECORDED_SEC + LEGACY_B_RECORDED_SEC) * 10) / 10,
  recorded_legs: 2,
  connected_complete: false,
  connected_total_sec: null,
  recording_egress_started_at_ms: null,
} satisfies Partial<Session>);

function legacyTwoLegAttempts(): CandidatePhoneAttempt[] {
  const legA: CandidatePhoneAttempt = {
    id: uid('7', 31), attempt_seq: 1,
    admitted_at: iso(LEGACY_A_ANSWERED_MS - 14_000), answered_at: iso(LEGACY_A_ANSWERED_MS),
    ended_at: iso(LEGACY_A_ANSWERED_MS + LEGACY_A_CONNECTED_SEC * 1000),
    state: 'completed', abandon_reason: null, outcome_class: 'disconnected', duration_sec: LEGACY_A_CONNECTED_SEC,
    connected_from: iso(LEGACY_A_ANSWERED_MS), connected_to: iso(LEGACY_A_ANSWERED_MS + LEGACY_A_CONNECTED_SEC * 1000),
    connected_to_source: 'ledger', connected_sec: LEGACY_A_CONNECTED_SEC,
    recorded_sec: LEGACY_A_RECORDED_SEC, recorded_sec_estimated: true, recording_started_at_ms: null,
    tail_may_be_missing: true, session_ref: LEGACY_SESSION_ID,
    recording: { state: 'ready' }, consent_stage: 'after_consent',
    transcript: { href: `/sessions/${LEGACY_SESSION_ID}`, scope: 'session', kind: 'session', shared_session: true },
  };
  const legB: CandidatePhoneAttempt = {
    id: uid('7', 32), attempt_seq: 2,
    admitted_at: iso(LEGACY_B_ADMITTED_MS), answered_at: iso(LEGACY_B_ANSWERED_MS),
    // The lease reclaim DETECTED the drop about six minutes later.
    ended_at: iso(LEGACY_B_ANSWERED_MS + 6 * MIN),
    state: 'abandoned', abandon_reason: null, outcome_class: null, duration_sec: null,
    connected_from: iso(LEGACY_B_ANSWERED_MS), connected_to: iso(LEGACY_B_ANSWERED_MS + 6 * MIN),
    connected_to_source: 'unobserved', connected_sec: null,
    recorded_sec: LEGACY_B_RECORDED_SEC, recorded_sec_estimated: false, recording_started_at_ms: LEGACY_B_RECORDING_MS,
    tail_may_be_missing: false, session_ref: LEGACY_SESSION_ID,
    recording: { state: 'ready' }, consent_stage: 'after_consent',
    transcript: { href: `/sessions/${LEGACY_SESSION_ID}`, scope: 'session', kind: 'session', shared_session: true },
  };
  // Newest first, as the unfiltered history route lists them.
  return [legB, legA];
}

const PARSED: CandidateResumeFacts = {
  current_role: 'Staff Engineer, Payments Platform',
  recent_role: {
    title: 'Staff Engineer',
    employer: 'Northwind Retail Labs',
    period: '2022 – present',
    highlights: ['Led the move of reconciliation to an event-driven pipeline', 'Cut p99 checkout latency from 900 ms to 280 ms'],
  },
  prior_roles: [
    { title: 'Senior Software Engineer', employer: 'Contoso Logistics', period: '2019 – 2022', highlights: ['Owned the shipment-tracking API (40k rpm)'] },
    { title: 'Software Engineer', employer: 'Fabrikam Analytics', period: '2017 – 2019', highlights: [] },
  ],
  career_highlights: ['Speaker at a regional Go meetup', 'Mentored six engineers to promotion'],
  education: ['B.Tech, Computer Science — 2017'],
  certifications: ['AWS Certified Solutions Architect – Associate'],
  summary: 'Backend engineer with seven years in high-throughput transactional systems.',
};

function candidateDetail(c: Candidate): CandidateDetail {
  return {
    candidate: {
      ...c,
      decision_use_blocked_at: null,
      parsed: c.id === STAR_CANDIDATE_ID ? PARSED : c.name ? { current_role: c.skills[0] ? `${c.skills[0]} engineer` : null, summary: null } : null,
    },
    sessions: sessions.filter((s) => s.candidate_id === c.id).slice().reverse(),
    assessments: (candidateAssessments[c.id] ?? []).slice().reverse(),
  };
}

/* ── Candidate-side extras ────────────────────────────────────────────── */

const NOTES: Note[] = [
  { id: uid('5', 1), candidate_id: STAR_CANDIDATE_ID, author_id: ADMIN_USER_ID, note: 'Strong on scaling stories. Check salary expectation against band before the tech round.', created_at: ago(3 * HOUR) },
  { id: uid('5', 2), candidate_id: STAR_CANDIDATE_ID, author_id: uid('f', 2), note: 'Candidate asked for a Friday afternoon slot for the next round.', created_at: ago(1 * HOUR) },
  { id: uid('5', 3), candidate_id: LEGACY_CANDIDATE_ID, author_id: ADMIN_USER_ID, note: 'Moved to technical round.', created_at: ago(20 * HOUR) },
];

const APPEALS: AppealRow[] = [
  {
    id: uid('a', 901),
    candidate_id: STAR_CANDIDATE_ID,
    session_id: sessions.find((s) => s.candidate_id === STAR_CANDIDATE_ID)!.id,
    assessment_id: null,
    category: 'recording',
    description: 'The first call dropped during the consent question; please disregard it.',
    status: 'under_review',
    created_at: ago(2 * HOUR),
    updated_at: ago(90 * MIN),
  },
];

function phoneCycles(c: Candidate): PhoneScreeningCycle[] {
  if (c.id === DIALED_CANDIDATE_ID) {
    return [
      {
        cycle_number: 1,
        state: 'awaiting_retry',
        state_reason: null,
        version: 5,
        no_answer_attempts: 1,
        no_answer_limit: 3,
        reconnects_used: 1,
        provider_failures: 0,
        next_eligible_at: iso(FROZEN_NOW_MS + 2 * HOUR),
        last_attempt_at: ago(1 * HOUR),
        terminal_at: null,
        created_at: ago(22 * HOUR),
        updated_at: ago(1 * HOUR),
        has_session: false,
        has_assessment: false,
        appointment: null,
      },
    ];
  }
  if (c.id === ABANDONED_CANDIDATE_ID) {
    return [
      {
        cycle_number: 1,
        state: 'abandoned_no_answer',
        state_reason: 'no_answer_budget_exhausted',
        version: 7,
        no_answer_attempts: 3,
        no_answer_limit: 3,
        reconnects_used: 0,
        provider_failures: 0,
        next_eligible_at: null,
        last_attempt_at: ago(2 * DAY),
        terminal_at: ago(2 * DAY - 45_000),
        created_at: ago(4 * DAY),
        updated_at: ago(2 * DAY - 45_000),
        has_session: false,
        has_assessment: false,
        appointment: null,
      },
    ];
  }
  if (c.id !== STAR_CANDIDATE_ID) return [];
  return [
    {
      cycle_number: 1,
      state: 'completed',
      state_reason: 'screening_completed',
      version: 4,
      no_answer_attempts: 1,
      no_answer_limit: 3,
      reconnects_used: 0,
      provider_failures: 0,
      next_eligible_at: null,
      last_attempt_at: ago(4 * HOUR),
      terminal_at: ago(3.8 * HOUR),
      created_at: ago(5 * HOUR),
      updated_at: ago(3.8 * HOUR),
      has_session: true,
      has_assessment: true,
      appointment: { appointment_id: uid('6', 1), starts_at: ago(4 * HOUR), ends_at: ago(3.5 * HOUR), status: 'fulfilled', source: 'hr_manual', version: 2 },
    },
  ];
}

function phoneAttempts(c: Candidate): CandidatePhoneAttempt[] {
  if (c.id === DIALED_CANDIDATE_ID) {
    // Newest first. Attempt 3 was deferred by our infrastructure before any
    // carrier was contacted ("Not placed", not a reached dial). Attempt 2 was
    // answered, then its worker lease was reclaimed mid-call: abandoned with
    // a NULL reason reads "Call interrupted" and DOES count, as does the
    // no answer. So dial_count is 2.
    return [
      { id: uid('7', 13), attempt_seq: 3, admitted_at: ago(1 * HOUR), answered_at: null, ended_at: ago(1 * HOUR - 2_000), state: 'abandoned', abandon_reason: 'infra_deferred', outcome_class: null, duration_sec: null, recording: { state: 'unavailable', reason: 'no_recording' }, consent_stage: null, transcript: null },
      { id: uid('7', 12), attempt_seq: 2, admitted_at: ago(3 * HOUR), answered_at: ago(3 * HOUR - 11_000), ended_at: ago(3 * HOUR - 95_000), state: 'abandoned', abandon_reason: null, outcome_class: null, duration_sec: 84, recording: { state: 'ready' }, consent_stage: 'before_consent', transcript: null },
      { id: uid('7', 11), attempt_seq: 1, admitted_at: ago(20 * HOUR), answered_at: null, ended_at: ago(20 * HOUR - 38_000), state: 'completed', abandon_reason: null, outcome_class: 'no_answer', duration_sec: null, recording: { state: 'unavailable', reason: 'no_recording' }, consent_stage: null, transcript: null },
    ];
  }
  if (c.id === LEGACY_CANDIDATE_ID) return legacyTwoLegAttempts();
  if (c.id === ABANDONED_CANDIDATE_ID) {
    // The whole no-answer budget: three rings, nobody picked up.
    return [3, 2, 1].map((seq) => {
      const at = (2 + (3 - seq)) * DAY;
      return { id: uid('7', 20 + seq), attempt_seq: seq, admitted_at: ago(at), answered_at: null, ended_at: ago(at - 40_000), state: 'completed', abandon_reason: null, outcome_class: 'no_answer', duration_sec: null, recording: { state: 'unavailable', reason: 'no_recording' }, consent_stage: null, transcript: null };
    });
  }
  const own = sessions.filter((s) => s.candidate_id === c.id);
  if (c.id !== STAR_CANDIDATE_ID || own.length < 2) return [];
  return [
    { id: uid('7', 3), attempt_seq: 3, admitted_at: ago(4 * HOUR), answered_at: ago(4 * HOUR - 12_000), ended_at: ago(3.8 * HOUR), state: 'completed', abandon_reason: null, outcome_class: 'answered', duration_sec: own[1].duration_sec ?? null, recording: { state: 'ready' }, consent_stage: 'after_consent', transcript: { href: `/sessions/${own[1].id}`, scope: 'session', kind: 'session', shared_session: false } },
    { id: uid('7', 2), attempt_seq: 2, admitted_at: ago(5 * HOUR), answered_at: ago(5 * HOUR - 9_000), ended_at: ago(5 * HOUR - 18_000), state: 'completed', abandon_reason: null, outcome_class: 'dropped_at_gate', duration_sec: 9, recording: { state: 'ready' }, consent_stage: 'before_consent', transcript: { href: `/sessions/${own[0].id}`, scope: 'session', kind: 'gate_only', shared_session: false } },
    { id: uid('7', 1), attempt_seq: 1, admitted_at: ago(26 * HOUR), answered_at: null, ended_at: ago(26 * HOUR - 40_000), state: 'completed', abandon_reason: null, outcome_class: 'no_answer', duration_sec: null, recording: { state: 'unavailable', reason: 'no_recording' }, transcript: null },
  ];
}

const STAR_ASHBY_WORKFLOW: AshbyCandidateWorkflow = {
  lifecycle: 'writeback_pending',
  terminalState: null,
  ingestionState: 'parsed',
  operations: [
    { type: 'invite_delivery', state: 'succeeded', errorCode: null },
    { type: 'scorecard_write', state: 'failed', errorCode: 'provider_5xx' },
  ],
  sessionStatus: 'completed',
  updatedAt: ago(35 * MIN),
};

/* ── Dashboard: intents + funnel ─────────────────────────────────────── */

const INTENTS: NotificationIntent[] = [
  { id: uid('b', 101), kind: 'assessment_ready', candidate_id: CANDIDATES[0].id, consent_verified: true, created_at: ago(3.7 * HOUR) },
  { id: uid('b', 102), kind: 'assessment_ready', candidate_id: CANDIDATES[6].id, consent_verified: true, created_at: ago(2.4 * DAY) },
  { id: uid('b', 103), kind: 'quota_warning', candidate_id: null, consent_verified: false, created_at: ago(1.1 * DAY) },
  { id: uid('b', 104), kind: 'appeal_resolved', candidate_id: CANDIDATES[10].id, consent_verified: true, created_at: ago(3 * DAY) },
  { id: uid('b', 105), kind: 'assessment_ready', candidate_id: CANDIDATES[12].id, consent_verified: true, created_at: ago(5.8 * DAY) },
  { id: uid('b', 106), kind: 'assessment_ready', candidate_id: CANDIDATES[21].id, consent_verified: false, created_at: ago(12 * DAY) },
];

const TOTAL_KEYS: Array<keyof FunnelSummaryTotals> = [
  'entered_parse', 'parsed_ok', 'needs_review', 'parse_failed', 'dialed', 'connected', 'consent_passed', 'consent_dropped',
  'answered_ge1', 'scored', 'qualified', 'on_hold', 'disqualified', 'human_review', 'reached_reference_check',
  'attempts_total', 'connects_total', 'total_call_seconds', 'hr_qualified', 'hr_disqualified', 'hr_awaiting', 'hr_unknown', 'candidates_total',
];

/** One plausible day of the funnel, every stage a filtered subset of the one before. */
function funnelDay(day: string, seed: number): FunnelDailyRow {
  const r = prng(seed);
  const entered = 6 + Math.floor(r() * 14);
  const parsed = entered - Math.floor(r() * 3);
  const dialed = Math.max(0, parsed - Math.floor(r() * 3));
  const connected = Math.floor(dialed * (0.55 + r() * 0.3));
  const consent = Math.floor(connected * (0.8 + r() * 0.15));
  const answered = Math.floor(consent * (0.85 + r() * 0.1));
  const scored = Math.max(0, answered - (r() > 0.5 ? 1 : 0));
  const qualified = Math.floor(scored * (0.35 + r() * 0.25));
  const hold = Math.floor((scored - qualified) * 0.4);
  const disq = Math.max(0, scored - qualified - hold - 1);
  const attempts = dialed + Math.floor(dialed * 0.8);
  return {
    cohort_day: day,
    role_id: null,
    median_ttfc_sec: 180 + Math.floor(r() * 240),
    p95_ttfc_sec: 900 + Math.floor(r() * 1800),
    entered_parse: entered,
    parsed_ok: parsed,
    needs_review: Math.floor(r() * 2),
    parse_failed: entered - parsed,
    dialed,
    connected,
    consent_passed: consent,
    consent_dropped: connected - consent,
    answered_ge1: answered,
    scored,
    qualified,
    on_hold: hold,
    disqualified: disq,
    human_review: Math.max(0, scored - qualified - hold - disq),
    reached_reference_check: Math.floor(qualified * 0.5),
    attempts_total: attempts,
    connects_total: connected + Math.floor(r() * 2),
    total_call_seconds: connected * (380 + Math.floor(r() * 120)),
    hr_qualified: Math.floor(qualified * 0.6),
    hr_disqualified: Math.floor(qualified * 0.2),
    hr_awaiting: qualified - Math.floor(qualified * 0.6) - Math.floor(qualified * 0.2),
    hr_unknown: 0,
    candidates_total: entered,
  };
}

/**
 * `GET /api/funnel/summary` and `/api/admin/funnel/summary` over [from, to].
 * `recruiterView` drops the latency percentiles exactly as the recruiter route
 * does, so the dashboard is rendered against the payload it really receives.
 */
export function funnelSummary(from: string | null, to: string | null, roleId: string | null, recruiterView: boolean): FunnelSummaryResponse {
  const toDay = to ?? iso(FROZEN_NOW_MS).slice(0, 10);
  const fromDay = from ?? iso(Date.parse(`${toDay}T00:00:00Z`) - 29 * DAY).slice(0, 10);
  const series: FunnelDailyRow[] = [];
  for (let d = Date.parse(`${fromDay}T00:00:00Z`); d <= Date.parse(`${toDay}T00:00:00Z`) && series.length < 400; d += DAY) {
    const day = iso(d).slice(0, 10);
    // A role filter narrows the cohort; seeding by role keeps it stable.
    const row = funnelDay(day, Math.floor(d / DAY) + (roleId ? roleId.charCodeAt(roleId.length - 1) * 7 : 0));
    if (roleId) for (const k of TOTAL_KEYS) row[k] = Math.floor((row[k] ?? 0) / 3);
    if (recruiterView) { row.median_ttfc_sec = null; row.p95_ttfc_sec = null; }
    series.push({ ...row, role_id: roleId });
  }
  const totals = Object.fromEntries(TOTAL_KEYS.map((k) => [k, series.reduce((s, r) => s + ((r[k] as number) ?? 0), 0)])) as unknown as FunnelSummaryTotals;
  const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : null);
  return {
    range: { from: fromDay, to: toDay },
    totals,
    conversions: {
      parse_to_dial: rate(totals.dialed, totals.parsed_ok),
      dial_to_connect: rate(totals.connected, totals.dialed),
      connect_to_consent: rate(totals.consent_passed, totals.connected),
      consent_to_answered: rate(totals.answered_ge1, totals.consent_passed),
      answered_to_scored: rate(totals.scored, totals.answered_ge1),
      scored_to_qualified: rate(totals.qualified, totals.scored),
      qualified_to_reference_check: rate(totals.reached_reference_check, totals.qualified),
      hr_advance_rate: rate(totals.hr_qualified, totals.hr_qualified + totals.hr_disqualified),
    },
    series,
    refreshed_at: ago(12 * MIN),
    meta: {
      hr_tracking_configured: true,
      schema_current: true,
      rollup_refreshed_at: ago(12 * MIN),
      rollup_freshness_known: true,
      refresh_window_days: 30,
    },
  };
}

const FUNNEL_FAILURES: FunnelFailuresResponse = {
  groups: [
    { stage: 'dial', code: 'no_answer', count: 41 },
    { stage: 'dial', code: 'busy', count: 9 },
    { stage: 'consent', code: 'declined', count: 7 },
    { stage: 'parse', code: 'resume_unreadable', count: 5 },
    { stage: 'dial', code: 'invalid_number', count: 4 },
    { stage: 'score', code: 'insufficient_evidence', count: 3 },
  ],
  recent: Array.from({ length: 10 }, (_, i) => ({
    stage: ['dial', 'consent', 'parse', 'dial', 'score'][i % 5],
    code: ['no_answer', 'declined', 'resume_unreadable', 'busy', 'insufficient_evidence'][i % 5],
    entity_id: uid('9', 500 + i),
    occurred_at: ago((i * 5 + 2) * HOUR),
  })),
  truncated: false,
  range: { from: ago(30 * DAY).slice(0, 10), to: iso(FROZEN_NOW_MS).slice(0, 10) },
};

const FUNNEL_CANDIDATES: FunnelCandidateRow[] = CANDIDATES.slice(0, 12).map((c, i) => ({
  candidate_id: c.id,
  role_id: c.role_id,
  role_title: ROLES.find((r) => r.id === c.role_id)?.title ?? null,
  resume_role_class: 'engineering',
  intake_at: c.created_at,
  furthest_stage: ['scored', 'qualified', 'intake', 'connected', 'dialed', 'scored'][i % 6],
  drop_reason: i % 4 === 3 ? 'no_answer' : null,
  missing_phone: !c.phone_valid,
  dialed: c.phone_valid,
  connected: c.phone_valid && i % 4 !== 3,
  consent_passed: c.phone_valid && i % 4 !== 3,
  answered_questions: c.latest_score != null ? 6 : 0,
  attempts_total: c.phone_valid ? 1 + (i % 3) : 0,
  connects_total: c.phone_valid && i % 4 !== 3 ? 1 : 0,
  recommendation: c.latest_recommendation ?? null,
  scoring_status: c.latest_score != null ? 'complete' : null,
  reached_reference_check: c.status === 'advanced',
}));

/* ── Admin ────────────────────────────────────────────────────────────── */

const STATUS: PublicStatus = {
  status: 'ok',
  maintenance: { enabled: false, reason: null, updated_at: ago(9 * DAY) },
  updated_at: ago(40_000),
};

const ALLOWLIST: AdminAllowlistEntry[] = [
  { id: uid('c', 1), email: ADMIN_EMAIL, role: 'admin', active: true, linked_user_id: ADMIN_USER_ID, linked_at: ago(120 * DAY) },
  { id: uid('c', 2), email: 'hiring.lead@example.com', role: 'admin', active: true, linked_user_id: uid('f', 2), linked_at: ago(80 * DAY) },
  { id: uid('c', 3), email: 'recruiter.north@example.com', role: 'interviewer', active: true, linked_user_id: uid('f', 3), linked_at: ago(45 * DAY) },
  { id: uid('c', 4), email: 'recruiter.south@example.com', role: 'interviewer', active: true, linked_user_id: null, linked_at: null },
  { id: uid('c', 5), email: 'panel.observer@example.com', role: 'viewer', active: true, linked_user_id: uid('f', 5), linked_at: ago(12 * DAY) },
  { id: uid('c', 6), email: 'former.recruiter@example.com', role: 'interviewer', active: false, linked_user_id: uid('f', 6), linked_at: ago(200 * DAY) },
];

const MEMBERS: AdminMember[] = ALLOWLIST.filter((e) => e.linked_user_id).map((e) => ({ user_id: e.linked_user_id!, role: e.role, active: e.active }));

const ADMIN_SESSIONS: AdminSessionRow[] = sessions
  .slice()
  .reverse()
  .map((s) => ({ id: s.id, candidate_id: s.candidate_id, role_id: s.role_id, status: s.status, created_at: s.created_at ?? ago(DAY), started_at: s.started_at ?? null, ended_at: s.ended_at ?? null }));

const AUDIT_ACTIONS: Array<[action: string, targetType: string, result: string]> = [
  ['allowlist.add', 'allowlist_entry', 'success'],
  ['session.override', 'call_session', 'success'],
  ['scorecard_metric.update', 'scorecard_metric', 'success'],
  ['ashby_mapping.pause', 'ashby_mapping', 'success'],
  ['quota.update', 'quota_policy', 'success'],
  ['maintenance.toggle', 'system', 'denied'],
  ['recording.download', 'call_session', 'success'],
  ['export.csv', 'candidate', 'success'],
];

const AUDIT: AdminAuditRow[] = Array.from({ length: 64 }, (_, i) => {
  const [action, target_type, result] = AUDIT_ACTIONS[i % AUDIT_ACTIONS.length];
  return {
    id: uid('b', 1000 + i),
    action,
    actor_type: i % 5 === 4 ? 'system' : 'user',
    actor_id: i % 5 === 4 ? 'scheduler' : i % 2 ? uid('f', 2) : ADMIN_USER_ID,
    target_type,
    target_id: uid('9', 2000 + i),
    result,
    created_at: ago((i * 47 + 5) * MIN),
  };
});

const QUOTAS: QuotaPolicy[] = [
  { id: uid('9', 1), scope: 'global', scope_id: null, mode: 'live', max_sessions: 500, max_cost_units: 12000, cost_units_per_session: 20, warning_percentage: 80, period_days: 30, enabled: true, created_at: ago(90 * DAY), updated_at: ago(6 * DAY) },
  { id: uid('9', 2), scope: 'global', scope_id: null, mode: 'simulation', max_sessions: 2000, max_cost_units: null, cost_units_per_session: null, warning_percentage: 90, period_days: 30, enabled: true, created_at: ago(90 * DAY), updated_at: ago(90 * DAY) },
  { id: uid('9', 3), scope: 'candidate', scope_id: STAR_CANDIDATE_ID, mode: 'live', max_sessions: 3, max_cost_units: null, cost_units_per_session: null, warning_percentage: null, period_days: 7, enabled: false, created_at: ago(4 * DAY), updated_at: ago(4 * DAY) },
];

/* ── Phone calendar ───────────────────────────────────────────────────── */

export const PHONE_WINDOW: PhoneWindow = {
  time_zone: 'Asia/Kolkata',
  open_ist: '09:00:00',
  close_ist: '21:00:00',
  // Already in the past at the frozen clock: the normal schedule applies.
  temporary_247_until_ist: '2026-09-06',
};

/**
 * Appointments across the frozen week (Mon 14 – Sun 20 Sep 2026, IST), on
 * both sides of "now" (Wed 12:00 IST) so the week grid, the overdue count and
 * the "next appointments" list all have something truthful to show.
 */
const APPOINTMENT_SEEDS: Array<[date: string, time: string, status: PhoneCalendarAppointment['status'], state: PhoneCalendarAppointment['engagement_state'], candidateIdx: number, source: PhoneCalendarAppointment['source']]> = [
  ['2026-09-14', '10:00', 'fulfilled', 'completed', 1, 'hr_manual'],
  ['2026-09-14', '15:30', 'missed', 'awaiting_retry', 6, 'candidate_voice'],
  ['2026-09-15', '11:00', 'fulfilled', 'completed', 8, 'hr_manual'],
  ['2026-09-15', '18:00', 'cancelled', 'cancelled', 13, 'hr_manual'],
  ['2026-09-16', '09:30', 'fulfilled', 'completed', 0, 'hr_manual'],
  ['2026-09-16', '11:30', 'scheduled', 'dialing', 3, 'system_deferral'],
  ['2026-09-16', '14:00', 'scheduled', 'scheduled', 15, 'hr_manual'],
  ['2026-09-16', '16:30', 'confirmed', 'scheduled', 4, 'candidate_voice'],
  ['2026-09-17', '10:30', 'scheduled', 'scheduled', 20, 'hr_manual'],
  ['2026-09-17', '10:30', 'superseded', 'scheduled', 21, 'hr_manual'],
  ['2026-09-17', '17:00', 'scheduled', 'eligible', 7, 'candidate_voice'],
  ['2026-09-18', '12:00', 'confirmed', 'scheduled', 19, 'hr_manual'],
  ['2026-09-19', '10:00', 'scheduled', 'pending_prereqs', 2, 'system_deferral'],
  ['2026-09-20', '19:30', 'scheduled', 'scheduled', 9, 'hr_manual'],
];

const APPOINTMENTS: PhoneCalendarAppointment[] = APPOINTMENT_SEEDS.map(([date, time, status, state, ci, source], i) => {
  const startMs = istToUtcMs(date, time);
  const endMs = startMs + 30 * MIN;
  const c = CANDIDATES[ci];
  return {
    id: uid('6', i + 1),
    engagement_id: uid('7', 100 + i),
    starts_at: iso(startMs),
    ends_at: iso(endMs),
    ist_date: date,
    ist_start: time,
    ist_end: istParts(endMs).time,
    status,
    source,
    confirmed_at: null,
    cancel_reason: status === 'cancelled' ? 'candidate_request' : status === 'superseded' ? 'superseded' : null,
    version: status === 'scheduled' ? 1 : 2,
    created_at: iso(startMs - 2 * DAY),
    updated_at: iso(Math.min(startMs, FROZEN_NOW_MS) - HOUR),
    engagement_state: state,
    role_id: c.role_id,
    candidate: { id: c.id, name: c.name, status: c.status, reference: i % 3 === 0 ? null : `ASHBY-${10400 + i * 7}` },
  };
});

/** `GET /api/phone/calendar/slots?date=` — 30-minute grid across the IST window. */
export function phoneSlots(date: string, appointments: PhoneCalendarAppointment[]): PhoneSlot[] {
  const slots: PhoneSlot[] = [];
  for (let minutes = 9 * 60; minutes < 21 * 60; minutes += 30) {
    const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const startMs = istToUtcMs(date, hhmm);
    const endMs = startMs + 30 * MIN;
    const booked = appointments.filter((a) => (a.status === 'scheduled' || a.status === 'confirmed') && Date.parse(a.starts_at) < endMs && Date.parse(a.ends_at) > startMs).length;
    const refusals: PhoneSlot['refusals'] = [];
    if (startMs < FROZEN_NOW_MS) refusals.push('slot_in_past');
    if (booked >= 2) refusals.push('at_projected_capacity');
    slots.push({ starts_at: iso(startMs), ends_at: iso(endMs), ist_start: hhmm, ist_end: istParts(endMs).time, booked, remaining: Math.max(0, 2 - booked), bookable: refusals.length === 0, refusals });
  }
  return slots;
}

/* ── Ashby Mission Control ────────────────────────────────────────────── */

type JobSeed = [title: string | null, status: AshbyJob['status'], openedDaysAgo: number | null];

/**
 * ~40 live jobs, every status, with the awkward cases the picker exists for:
 * exact-title duplicates told apart only by opening date, an open job sharing
 * its title with a closed one, drafts with no opening date, and one untitled.
 */
const JOB_SEEDS: JobSeed[] = [
  ['Senior Backend Engineer', 'Open', 46],
  ['Senior Backend Engineer', 'Open', 9],
  ['Frontend Engineer', 'Open', 38],
  ['Data Analyst', 'Open', 30],
  ['Data Analyst', 'Closed', 210],
  ['Site Reliability Engineer', 'Open', 27],
  ['Customer Success Associate', 'Open', 20],
  ['Customer Success Associate', 'Open', 20],
  ['Account Executive, Enterprise', 'Open', 55],
  ['Account Executive, Mid-Market', 'Open', 41],
  ['Android Engineer', 'Open', 33],
  ['iOS Engineer', 'Open', 33],
  ['Engineering Manager, Platform', 'Open', 70],
  ['Product Designer', 'Open', 18],
  ['Product Manager, Growth', 'Open', 25],
  ['Technical Writer', 'Open', 12],
  ['Learning Experience Designer', 'Open', 15],
  ['Career Coach (Contract)', 'Open', 8],
  ['Machine Learning Engineer', 'Open', 60],
  ['Security Engineer', 'Open', 44],
  ['Solutions Engineer', 'Open', 29],
  ['Talent Acquisition Partner', 'Open', 6],
  ['Finance Associate', 'Open', 14],
  ['Sales Development Representative', 'Open', 3],
  ['Sales Development Representative', 'Closed', 140],
  ['Frontend Engineer', 'Closed', 190],
  ['QA Automation Engineer', 'Closed', 400],
  ['Business Analyst', 'Closed', 160],
  ['DevOps Engineer', 'Closed', 230],
  ['Marketing Analyst', 'Closed', 120],
  ['Content Strategist', 'Closed', 95],
  ['HR Generalist', 'Closed', 300],
  ['Support Team Lead', 'Archived', 500],
  ['Payments Engineer', 'Archived', 450],
  ['Mobile QA Engineer', 'Archived', 380],
  ['Principal Engineer', 'Draft', null],
  ['Staff Data Scientist', 'Draft', null],
  ['Office Manager', 'Draft', null],
  [null, 'Open', 2],
  ['Partnerships Manager', 'Open', 11],
];

const JOBS: AshbyJob[] = JOB_SEEDS.map(([title, status, opened], i) => ({
  id: uid('8', 700 + i),
  title,
  status,
  openedAt: opened === null ? null : ago(opened * DAY),
}));

const MAPPINGS: AshbyMcMapping[] = [
  { id: uid('8', 1), externalJobId: JOBS[0].id, status: 'enabled', statusReason: null, deliveryMode: 'email', hasAiStage: true, hasTaStage: true, label: 'Senior Backend Engineer', roleId: ROLE_IDS.backend, updatedAt: ago(2 * DAY) },
  { id: uid('8', 2), externalJobId: JOBS[3].id, status: 'paused', statusReason: 'Paused while the question bank is reviewed', deliveryMode: 'both', hasAiStage: true, hasTaStage: true, label: 'Data Analyst', roleId: ROLE_IDS.data, updatedAt: ago(5 * HOUR) },
  { id: uid('8', 3), externalJobId: JOBS[2].id, status: 'drift', statusReason: 'The TA screening stage no longer exists on this job', deliveryMode: 'manual', hasAiStage: true, hasTaStage: false, label: 'Frontend Engineer', roleId: ROLE_IDS.frontend, updatedAt: ago(26 * HOUR) },
];

export const SCOPED_REVIEW_LINK_ID = uid('a', 1);

const WORKFLOWS: AshbyMcWorkflow[] = [
  { applicationLinkId: SCOPED_REVIEW_LINK_ID, externalApplicationId: 'app_7Qm2Lk9x', externalJobId: JOBS[0].id, lifecycle: 'writeback_pending', terminalState: null, ingestionState: 'parsed', operations: [{ id: uid('a', 101), type: 'invite_delivery', state: 'succeeded', errorCode: null }, { id: uid('a', 102), type: 'scorecard_write', state: 'failed', errorCode: 'provider_5xx' }], sessionStatus: 'completed', sessionId: V2_SESSION_ID, updatedAt: ago(35 * MIN) },
  { applicationLinkId: uid('a', 2), externalApplicationId: 'app_3Rf8Hc2p', externalJobId: JOBS[0].id, lifecycle: 'ready', terminalState: null, ingestionState: 'parsed', operations: [{ id: uid('a', 103), type: 'invite_delivery', state: 'succeeded', errorCode: null }], sessionStatus: 'in_progress', sessionId: null, updatedAt: ago(50 * MIN) },
  { applicationLinkId: uid('a', 3), externalApplicationId: 'app_9Tb4Wq1z', externalJobId: JOBS[0].id, lifecycle: 'processing', terminalState: null, ingestionState: 'scanning', operations: [], sessionStatus: null, sessionId: null, updatedAt: ago(70 * MIN) },
  { applicationLinkId: uid('a', 4), externalApplicationId: 'app_2Kd7Ys5m', externalJobId: JOBS[3].id, lifecycle: 'processing', terminalState: null, ingestionState: 'failed_review', operations: [{ id: uid('a', 104), type: 'stage_move', state: 'failed', errorCode: 'rate_limited' }], sessionStatus: null, sessionId: null, updatedAt: ago(3 * HOUR) },
  { applicationLinkId: uid('a', 5), externalApplicationId: 'app_5Hn1Vx8c', externalJobId: JOBS[0].id, lifecycle: 'ready', terminalState: null, ingestionState: 'parsed', operations: [{ id: uid('a', 105), type: 'invite_delivery', state: 'pending', errorCode: null }], sessionStatus: 'completed', sessionId: uid('3', 2), updatedAt: ago(4 * HOUR) },
  { applicationLinkId: uid('a', 6), externalApplicationId: 'app_8Wc3Pz6r', externalJobId: JOBS[2].id, lifecycle: 'cancelled', terminalState: 'withdrawn', ingestionState: 'parsed', operations: [{ id: uid('a', 106), type: 'invite_delivery', state: 'succeeded', errorCode: null }], sessionStatus: null, sessionId: null, updatedAt: ago(1.5 * DAY) },
  { applicationLinkId: uid('a', 7), externalApplicationId: 'app_4Jm6Td2e', externalJobId: JOBS[0].id, lifecycle: 'completed', terminalState: 'scorecard_written', ingestionState: 'parsed', operations: [{ id: uid('a', 107), type: 'invite_delivery', state: 'succeeded', errorCode: null }, { id: uid('a', 108), type: 'scorecard_write', state: 'succeeded', errorCode: null }], sessionStatus: 'completed', sessionId: null, updatedAt: ago(2 * DAY) },
  { applicationLinkId: uid('a', 8), externalApplicationId: 'app_6Lp9Ka3u', externalJobId: JOBS[3].id, lifecycle: 'ready', terminalState: null, ingestionState: 'parsed', operations: [], sessionStatus: null, sessionId: null, updatedAt: ago(2.2 * DAY) },
];

const FEEDBACK_FORM: AshbyFeedbackForm = {
  formDefinitionId: uid('8', 9001),
  title: 'AI screening scorecard',
  interviewId: uid('8', 9002),
  interviewTitle: 'AI phone screen',
  stageId: uid('8', 9003),
  stageTitle: 'AI Screening',
  schemaAvailable: true,
  fieldCount: 6,
  sections: [
    {
      id: uid('8', 9010),
      title: 'Overall',
      fields: [
        { id: uid('8', 9011), title: 'Overall recommendation', path: 'overall', type: 'Score', required: true, options: [1, 2, 3, 4].map((v) => ({ value: String(v), label: ['Strong no', 'No', 'Yes', 'Strong yes'][v - 1] })), optionsTruncated: false },
        { id: uid('8', 9012), title: 'Summary', path: 'summary', type: 'RichText', required: true, options: [], optionsTruncated: false },
      ],
    },
    {
      id: uid('8', 9020),
      title: 'Competencies',
      fields: ['Communication clarity', 'Technical depth', 'Problem solving', 'Ownership'].map((t, k) => ({ id: uid('8', 9021 + k), title: t, path: `competency_${k + 1}`, type: 'Score', required: false, options: [1, 2, 3, 4].map((v) => ({ value: String(v), label: String(v) })), optionsTruncated: false })),
    },
  ],
};

const BINDING_PREVIEW: AshbyScorecardBindingPreviewResponse = {
  ok: true,
  scoringPath: 'v2_autobind',
  mappingFormBound: true,
  preview: {
    formDefinitionId: FEEDBACK_FORM.formDefinitionId,
    formTitle: FEEDBACK_FORM.title,
    schemaAvailable: true,
    archived: false,
    formMatchesBinding: true,
    fixedFields: [
      { name: 'overall', path: 'overall', expectedType: 'Score', status: 'present', actualType: 'Score' },
      { name: 'summary', path: 'summary', expectedType: 'RichText', status: 'present', actualType: 'RichText' },
      { name: 'redFlags', path: 'red_flags', expectedType: 'RichText', status: 'missing', actualType: null },
      { name: 'detailedReport', path: 'detailed_report', expectedType: 'RichText', status: 'present', actualType: 'RichText' },
    ],
    metrics: ROLE_SCORECARDS[ROLE_IDS.backend].metrics.map((m, k) => ({ key: m.key, name: m.name, status: k < 4 ? ('bound' as const) : ('no_field' as const), fieldPath: k < 4 ? `competency_${k + 1}` : null, scale: k < 4 ? { min: 1, max: 4 } : null })),
    unusedScoreFields: [],
    ready: false,
  },
};

/* ── The dataset ──────────────────────────────────────────────────────── */

export interface Dataset {
  me: MeResponse;
  status: PublicStatus;
  roles: Role[];
  metrics: ScorecardMetricTemplate[];
  roleScorecards: Record<string, RoleScorecardVersion>;
  candidates: Candidate[];
  candidateDetail: (id: string) => CandidateDetail | null;
  sessionDetails: Record<string, SessionDetail>;
  notes: Note[];
  appeals: AppealRow[];
  phoneCycles: (c: Candidate) => PhoneScreeningCycle[];
  phoneAttempts: (c: Candidate) => CandidatePhoneAttempt[];
  ashbyWorkflowFor: (candidateId: string) => AshbyCandidateWorkflow | null;
  intents: NotificationIntent[];
  funnelFailures: FunnelFailuresResponse;
  funnelCandidates: FunnelCandidateRow[];
  allowlist: AdminAllowlistEntry[];
  members: AdminMember[];
  adminSessions: AdminSessionRow[];
  audit: AdminAuditRow[];
  quotas: QuotaPolicy[];
  appointments: PhoneCalendarAppointment[];
  ashby: {
    mappings: AshbyMcMapping[];
    jobs: AshbyJob[];
    withheld: number;
    workflows: AshbyMcWorkflow[];
    feedbackForm: AshbyFeedbackForm;
    bindingPreview: AshbyScorecardBindingPreviewResponse;
  };
}

/** A fresh, independently mutable copy of the synthetic world. */
export function createDataset(): Dataset {
  const d = structuredClone({
    me: ME,
    status: STATUS,
    roles: ROLES,
    metrics: METRICS,
    roleScorecards: ROLE_SCORECARDS,
    candidates: CANDIDATES,
    sessionDetails,
    notes: NOTES,
    appeals: APPEALS,
    intents: INTENTS,
    funnelFailures: FUNNEL_FAILURES,
    funnelCandidates: FUNNEL_CANDIDATES,
    allowlist: ALLOWLIST,
    members: MEMBERS,
    adminSessions: ADMIN_SESSIONS,
    audit: AUDIT,
    quotas: QUOTAS,
    appointments: APPOINTMENTS,
    ashby: { mappings: MAPPINGS, jobs: JOBS, withheld: 3, workflows: WORKFLOWS, feedbackForm: FEEDBACK_FORM, bindingPreview: BINDING_PREVIEW },
  });
  return {
    ...d,
    // Derived views read the LIVE (cloned) collections, so a mutation made
    // by a write handler is visible to the next read.
    candidateDetail: (id) => {
      const c = d.candidates.find((x) => x.id === id);
      // Cloned: the sessions and assessments are shared module-level rows.
      return c ? structuredClone(candidateDetail(c)) : null;
    },
    phoneCycles,
    phoneAttempts,
    ashbyWorkflowFor: (candidateId) => (candidateId === STAR_CANDIDATE_ID ? structuredClone(STAR_ASHBY_WORKFLOW) : null),
  };
}
