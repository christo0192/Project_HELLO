import type { ParsedResume, ResumeRoleEvidence } from './types.js';
import { deriveExperienceYearsFromRoles, extractPeriodFromLine } from './resume-experience.js';

const SKILL_KEYWORDS = [
  'javascript', 'typescript', 'react', 'node.js', 'node', 'python', 'java', 'sql', 'postgres',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'sales', 'consultative sales', 'customer success',
  'crm', 'salesforce', 'hubspot', 'lead generation', 'cold calling', 'counselling', 'advising',
  'program advisor', 'communication', 'negotiation', 'presentation', 'account management',
  'business development', 'recruiting', 'sourcing', 'screening', 'excel', 'analytics',
];

function normalizeWhitespace(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanLine(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f�]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

// Contact extraction is bounded to the top of the document (contact info lives
// near the top) so worst-case regex CPU stays small — this parser runs in the
// parent event loop.
const CONTACT_SLICE_LEN = 8000;

// Linear, ReDoS-safe patterns. Every quantifier is bounded; the post-@ host is
// expressed as non-overlapping label segments (no "." inside a class adjacent
// to a literal "."), and the TLD length is capped.
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,8}\.[A-Z]{2,24}/i;
const EMAIL_RE_G = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,8}\.[A-Z]{2,24}/gi;

// Anchored, bounded phone pattern: cannot start mid-digit-run, cannot absorb an
// adjacent digit run, and the interior class is length-capped so it can't
// backtrack catastrophically. Collapse "+ 91" -> "+91" before matching.
const PHONE_RE = /(?<!\d)(\+?\d[\d().\s-]{7,20}\d)(?!\d)/;
const PHONE_RE_G = /(?<!\d)(\+?\d[\d().\s-]{7,20}\d)(?!\d)/g;

function collapsePlusSpace(text: string): string {
  return text.replace(/\+\s+/g, '+');
}

// Prose role-mining: "<Title> at/with <Employer>". Bounded character classes on
// both sides so this stays linear. Case-insensitive; spans are copied verbatim
// (evidence-only, no invented dates).
//   Title: no sentence-ending punctuation inside (the class excludes '.'), so it
//     cannot cross a sentence boundary; length-capped.
//   Employer: 1..4 Capitalized tokens; a token may end in '.' ("Corp.") but that
//     terminal dot does not permit continuation into the next sentence.
//
// CONSERVATIVE BY DESIGN: a FALSE role is worse than a missed one, because it
// becomes a fabricated résumé fact the live conflict judge then challenges the
// candidate about. So every gate below fails CLOSED — when the title or the
// employer looks even slightly wrong we emit nothing.
const ROLE_AT_RE =
  /([A-Z][A-Za-z][A-Za-z /&'-]{2,60}?)\s+(?:at|with)\s+([A-Z][A-Za-z0-9&'-]*(?:\s+[A-Z0-9][A-Za-z0-9&'-]*){0,3}\.?)/g;
// Role words matched on WORD BOUNDARIES so a title is only accepted when a whole
// role noun is present. Substring matching mis-fired ("Leadership" contains
// "lead", "Confidence" is not a role) — the \b anchors reject those.
const ROLE_TITLE_WORD =
  /\b(engineer|developer|manager|advisor|consultant|analyst|specialist|associate|lead|recruiter|sales|support|representative|executive|trader|officer|director|coordinator|administrator|designer|scientist|architect|accountant|technician|marketer|strategist)\b/i;
// A real job title is short and single-clause. A capture containing a connective
// (" to ", " with ", " and ") or running long ("Strategist with vision",
// "Reported to the Manager") is a sentence fragment, not a title — reject it.
const TITLE_MULTICLAUSE = /\s(?:to|with|and)\s/i;
const MAX_TITLE_WORDS = 5;
// An employer is a run of Capitalized proper-noun tokens. A trailing lowercase
// run ("Google as a manager") is prose that leaked past the proper noun; a
// clean employer has no interior lowercase word.
const EMPLOYER_LOWERCASE_TAIL = /\s+[a-z]/;

function cleanEmployer(raw: string): string | null {
  // Trim a connective/lowercase tail: "Google as a manager" -> "Google". The
  // employer is the leading Capitalized proper-noun run only.
  let employer = raw.trim().replace(/[.,]+$/, '');
  const tail = employer.search(EMPLOYER_LOWERCASE_TAIL);
  if (tail !== -1) employer = employer.slice(0, tail).trim();
  if (!employer) return null;
  // After trimming, every remaining token must be a Capitalized proper noun (or
  // an all-caps acronym / ampersand). If anything lowercase survives, the span
  // was prose, not a company name — fail closed.
  const tokens = employer.split(/\s+/);
  for (const tok of tokens) {
    if (tok === '&') continue;
    if (!/^[A-Z][A-Za-z0-9&'.-]*$/.test(tok)) return null;
  }
  return employer;
}

// bareAt qualifier: an explicit employment verb, or the candidate's OWN role
// word (a role word NOT sitting behind an article — "the Manager"/"a director"
// is a referent, not a held title).
const EMPLOY_VERB_TAIL =
  /(?:^|\s)(?:work|worked|working|employed|joined|serve|served|serving|hired|based)$/i;
const ROLE_WORD_TAIL =
  /(?:^|\s)[A-Za-z-]*(?:engineer|developer|manager|advisor|consultant|analyst|specialist|associate|lead|recruiter|sales|support|representative|executive|trader|officer|director|coordinator|administrator|designer|scientist|architect|accountant|technician|marketer|strategist)$/i;
const ROLE_WORD_AFTER_ARTICLE =
  /\b(?:the|a|an)\s+[A-Za-z-]*(?:engineer|developer|manager|advisor|consultant|analyst|specialist|associate|lead|recruiter|sales|support|representative|executive|trader|officer|director|coordinator|administrator|designer|scientist|architect|accountant|technician|marketer|strategist)$/i;

function bareAtIsEmployerContext(before: string): boolean {
  const b = before.trimEnd();
  if (EMPLOY_VERB_TAIL.test(b)) return true;
  if (ROLE_WORD_TAIL.test(b) && !ROLE_WORD_AFTER_ARTICLE.test(b)) return true;
  return false;
}

function cleanTitle(rawTitle: string): string | null {
  // Keep only the last clause if the span crossed a sentence boundary, then
  // trim leading filler adjectives ("Dynamic proprietary trader" -> keep;
  // "Experienced Customer service associate" -> "Customer service associate").
  const lastClause = rawTitle.split(/[.!?]\s+/).pop()!.trim();
  const title =
    lastClause.replace(/^(?:an?|the|dynamic|experienced|proven|seasoned|results[- ]driven)\s+/i, '').trim() ||
    lastClause;
  // Require a whole role word (boundary-anchored, so "Leadership" is rejected).
  if (!ROLE_TITLE_WORD.test(title)) return null;
  // Reject a multi-clause phrase or an over-long span — a real title is short.
  if (TITLE_MULTICLAUSE.test(title)) return null;
  if (title.split(/\s+/).length > MAX_TITLE_WORDS) return null;
  return title;
}

function extractProseRoles(
  text: string,
  roleIndicators: RegExp,
): { recent: ResumeRoleEvidence | null; prior: ResumeRoleEvidence[] } {
  const slice = text.slice(0, CONTACT_SLICE_LEN);
  const found: ResumeRoleEvidence[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  ROLE_AT_RE.lastIndex = 0;
  while ((m = ROLE_AT_RE.exec(slice)) !== null) {
    // Both a boundaried role-word title AND a clean proper-noun employer must be
    // found. When either gate fails we emit nothing for this span.
    const title = cleanTitle(m[1].trim());
    if (title === null) continue;
    const employer = cleanEmployer(m[2]);
    if (employer === null) continue;
    const key = `${title.toLowerCase()}|${employer.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ title, employer, period: null, highlights: [] });
    if (found.length >= 8) break;
  }
  // Fallback: bare "at <Employer>" when no title+employer pair was found but the
  // prose clearly names an employer. This is the WEAKEST path (no title to
  // corroborate), so the gate is the strictest: the word immediately before
  // "at" must be an employment verb ("worked at Google") or the candidate's OWN
  // role word ("proprietary trader at Quant Tekel"). A bare role word behind an
  // article ("Reported to the Manager at ...") is a referent, not the
  // candidate's title, and does NOT qualify — nor does an ordinary noun
  // ("expert at ...", "vision at ..."). Uncertain -> emit nothing.
  if (found.length === 0) {
    const bareAt = /\bat\s+([A-Z][A-Za-z0-9][A-Za-z0-9 .,&'-]{1,60})/g;
    let b: RegExpExecArray | null;
    while ((b = bareAt.exec(slice)) !== null) {
      const start = Math.max(0, b.index - 80);
      const context = slice.slice(start, b.index + b[0].length);
      if (!roleIndicators.test(context)) continue;
      // The word directly preceding "at" decides whether this is an employment
      // mention at all. Everything up to (not including) the matched "at ...".
      const before = slice.slice(start, b.index).trimEnd();
      if (!bareAtIsEmployerContext(before)) continue;
      // Same clean-employer gate: "at Google as a manager" -> "Google", and a
      // span that does not resolve to a proper-noun run emits nothing.
      const employer = cleanEmployer(b[1]);
      if (employer === null) continue;
      const key = `|${employer.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ title: null, employer, period: null, highlights: [] });
      if (found.length >= 8) break;
    }
  }
  if (found.length === 0) return { recent: null, prior: [] };
  return { recent: found[0], prior: found.slice(1) };
}

export function fallbackParseResumeText(text: string): ParsedResume {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const flat = normalizeWhitespace(text);
  const lower = flat.toLowerCase();

  // Contact regexes run over a bounded top-slice with "+ 91" collapsed to "+91"
  // (so the leading "+" is retained and the number can't fuse to a preceding
  // pincode). This bounds worst-case CPU in the parent event loop.
  const contactSlice = collapsePlusSpace(flat.slice(0, CONTACT_SLICE_LEN));

  const email = contactSlice.match(EMAIL_RE)?.[0] ?? null;

  const phoneCandidate = contactSlice.match(PHONE_RE)?.[1] ?? null;
  const phone = phoneCandidate
    ? phoneCandidate.replace(/\s+/g, ' ').trim()
    : null;

  const name = (() => {
    for (const line of lines.slice(0, 8)) {
      if (email && line.includes(email)) continue;
      if (/resume|curriculum vitae|cv\b/i.test(line)) continue;
      const withoutContact = collapsePlusSpace(line)
        .replace(EMAIL_RE_G, '')
        .replace(PHONE_RE_G, '')
        .trim();
      if (/^[A-Za-z][A-Za-z .'’-]{2,80}$/.test(withoutContact)) return withoutContact;
    }
    return null;
  })();

  const roleIndicators = /(engineer|developer|manager|advisor|consultant|analyst|specialist|associate|lead|recruiter|sales|support|representative|executive)/i;
  const current_role = (() => {
    for (const line of lines.slice(0, 15)) {
      if (line === name || (email && line.includes(email))) continue;
      if (roleIndicators.test(line) && line.length <= 100) return line;
    }
    return null;
  })();

  const experience_years = (() => {
    const patterns = [
      /(\d+(?:\.\d+)?)\+?\s*(?:years|yrs)\s+(?:of\s+)?(?:professional\s+)?experience/i,
      /experience\s*(?:of|:)?\s*(\d+(?:\.\d+)?)\+?\s*(?:years|yrs)/i,
      /(\d+(?:\.\d+)?)\+?\s*(?:years|yrs)\b/i,
    ];
    for (const pattern of patterns) {
      const match = flat.match(pattern);
      if (match) return Number(match[1]);
    }
    return null;
  })();

  const skills = unique(
    SKILL_KEYWORDS.filter((skill) => lower.includes(skill.toLowerCase()))
      .map((skill) => (skill === 'node' && lower.includes('node.js') ? 'Node.js' : skill))
      .map((skill) => skill.replace(/\b\w/g, (c) => c.toUpperCase())),
  ).slice(0, 30);

  // A line is "contact-shaped" (and excluded from the summary prose) when it
  // carries a phone or email, or is a genuine address/postal line. The postal
  // heuristic is deliberately NARROW: a 5-6 digit number ALONE is not a postal
  // code — "Increased revenue by 250000" and "portfolios worth 500000 dollars"
  // are prose achievements that happen to contain a big number. A line is only
  // treated as postal when a 5-6 digit token co-occurs with an address cue
  // (city/state/country/PIN/postal/ZIP or a two-letter state code), OR the line
  // is SHORT and is mostly the contact tokens themselves. "+ 91" is collapsed
  // first so the phone matcher fires on spaced-plus forms.
  const ADDRESS_CUE =
    /\b(?:india|usa|u\.s\.a|uk|street|st\.|road|rd\.|avenue|ave\.|lane|city|state|district|pin(?:code)?|postal|zip|nagar|colony|sector|block|pincode)\b/i;
  // A line carries "prose" when it has a role word or a narrative/achievement
  // verb. Shared by the postal heuristic (prose lines are never postal) and the
  // empty-summary guard (only prose-bearing lines are resurrected, so a pure
  // address residual stays dropped).
  const PROSE_VERBS =
    /\b(?:experience|manage|lead|develop|drove|built|building|responsible|achieved|delivered|increased|revenue|handled|portfolio|portfolios|grew|reduced|worth|dollars|profit|sales|quarter|driving|growth|across|resilient|services|products|clients)\b/i;
  const hasProseContent = (line: string): boolean =>
    roleIndicators.test(line) || PROSE_VERBS.test(line);
  const isContactLine = (line: string): boolean => {
    const collapsed = collapsePlusSpace(line);
    if (EMAIL_RE.test(collapsed)) return true;
    if (PHONE_RE.test(collapsed)) return true;
    const hasPostal = /\b\d{5,6}\b/.test(line);
    if (!hasPostal) return false;
    // A prose sentence with a big number is content, never a postal line.
    if (hasProseContent(line)) return false;
    // With no prose, require an explicit address cue, or a short line that is
    // essentially just the postal/contact tokens (a real address line is short).
    if (ADDRESS_CUE.test(line)) return true;
    if (line.length <= 40) return true;
    return false;
  };

  const summary = (() => {
    const explicitSummaryIndex = lines.findIndex((line) => /^summary\b/i.test(line));
    if (explicitSummaryIndex >= 0) {
      const next = lines.slice(explicitSummaryIndex, explicitSummaryIndex + 4).join(' ');
      const cleaned = normalizeWhitespace(next.replace(/^summary\b[:\s-]*/i, ''));
      if (cleaned.length >= 20) return cleaned.slice(0, 500);
    }
    const isBoilerplate = (line: string): boolean =>
      line === name ||
      line === current_role ||
      Boolean(email && line.includes(email));
    const content = lines
      .filter((line) => !isBoilerplate(line) && !isContactLine(line))
      .join(' ');
    const cleaned = normalizeWhitespace(content);
    if (cleaned) return cleaned.slice(0, 500);
    // EMPTY-SUMMARY GUARD. Stripping contact lines emptied the summary — this
    // happens for a single physical line (PDF-to-text with no newlines) that
    // carries both a phone/email and the bio prose. Never return an empty
    // summary when there was substantive PROSE: recover the prose-bearing
    // non-boilerplate lines with only the contact TOKENS (phone/email) removed,
    // preserving the bio words the line also carries. A line with no prose
    // content (a pure address/postal residual) is NOT resurrected — a bio has
    // words, and an address is not a summary.
    //
    // The boilerplate test here is deliberately NARROWER than the first pass: it
    // excludes only an exact name/current_role line, NOT any line that merely
    // CONTAINS the email. In the single-line case the bio and the email share
    // one physical line, so the broad `line.includes(email)` rule would discard
    // the whole bio — the very thing this guard exists to rescue. The email
    // token itself is stripped below, so keeping the line is safe.
    const isNameOrRole = (line: string): boolean =>
      line === name || line === current_role;
    const recoverable = lines.filter(
      (line) => !isNameOrRole(line) && hasProseContent(line),
    );
    if (recoverable.length === 0) return null;
    const stripped = recoverable
      .map((line) => collapsePlusSpace(line).replace(EMAIL_RE_G, ' ').replace(PHONE_RE_G, ' '))
      .join(' ');
    const fallback = normalizeWhitespace(stripped);
    return fallback ? fallback.slice(0, 500) : null;
  })();

  // Prose fallback for role/employer evidence. The dated/section-header paths
  // above populate current_role for structured resumes; prose bios don't have
  // that shape, so mine "<title> at/with <employer>" spans. Only used to fill
  // gaps — a structured current_role still wins for recent_role.title.
  const prose = extractProseRoles(flat, roleIndicators);

  // When current_role captured a whole prose sentence (contains " at "/" with "
  // and is long), the prose-mined title is a cleaner recent_role.title. Prefer
  // it there while leaving the separate current_role field untouched.
  const currentIsMessyProse =
    !!current_role && /\s(?:at|with)\s/i.test(current_role) && current_role.length > 40;
  const recentTitle =
    currentIsMessyProse && prose.recent?.title ? prose.recent.title : current_role;

  // The role line a structured résumé puts its dates on ("Senior Sales
  // Executive, Acme — Bengaluru   Jan 2021 – Present") carries the one thing
  // the prose miner never sees: a PERIOD. Copy that substring verbatim so the
  // total-years derivation has evidence to add up on the deterministic path
  // too — otherwise every model-outage upload keeps showing "—" for experience.
  const recentPeriod = current_role ? extractPeriodFromLine(current_role) : null;

  const recent_role: ResumeRoleEvidence | null = current_role
    ? {
        title: recentTitle,
        employer: prose.recent?.employer ?? null,
        period: recentPeriod,
        highlights: [],
      }
    : prose.recent;

  const prior_roles: ResumeRoleEvidence[] = current_role
    ? // current_role became recent_role; prose.recent + prose.prior are the
      // additional evidence roles.
      [prose.recent, ...prose.prior].filter(
        (r): r is ResumeRoleEvidence => Boolean(r),
      )
    : prose.prior;

  // Dated role lines beyond the first: any line in the top of the document
  // that names a role word AND carries a date range is a stint the recruiter
  // would count. Bounded to the first 60 lines and 8 spans, evidence-only.
  const datedLinePeriods: string[] = [];
  for (const line of lines.slice(0, 60)) {
    if (datedLinePeriods.length >= 8) break;
    if (line === current_role || !roleIndicators.test(line) || line.length > 200) continue;
    const p = extractPeriodFromLine(line);
    if (p) datedLinePeriods.push(p);
  }

  return {
    name,
    email,
    phone,
    skills,
    // The stated phrase ("5+ years of experience") when the résumé has one;
    // otherwise the sum of the dated role lines, exactly as the model tier's
    // derivation does. Null when neither exists — never a guess.
    experience_years: experience_years
      ?? deriveExperienceYearsFromRoles([
        recent_role,
        ...datedLinePeriods.map((period) => ({ title: null, employer: null, period, highlights: [] })),
      ]),
    current_role,
    summary,
    recent_role,
    prior_roles,
    career_highlights: [],
    education: [],
    certifications: [],
  };
}

export function hasUsefulFallbackResume(parsed: ParsedResume): boolean {
  return Boolean(parsed.name || parsed.email || parsed.phone || parsed.current_role || parsed.summary || parsed.skills.length);
}
