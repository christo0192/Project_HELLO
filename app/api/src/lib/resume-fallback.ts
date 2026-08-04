import type { ParsedResume } from './types.js';

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

export function fallbackParseResumeText(text: string): ParsedResume {
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  const flat = normalizeWhitespace(text);
  const lower = flat.toLowerCase();

  const email = flat.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;

  const phoneCandidate = flat.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0] ?? null;
  const phone = phoneCandidate ? phoneCandidate.replace(/\s+/g, ' ').trim() : null;

  const name = (() => {
    for (const line of lines.slice(0, 8)) {
      if (email && line.includes(email)) continue;
      if (/resume|curriculum vitae|cv\b/i.test(line)) continue;
      const withoutContact = line.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '').replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '').trim();
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

  const summary = (() => {
    const explicitSummaryIndex = lines.findIndex((line) => /^summary\b/i.test(line));
    if (explicitSummaryIndex >= 0) {
      const next = lines.slice(explicitSummaryIndex, explicitSummaryIndex + 4).join(' ');
      const cleaned = normalizeWhitespace(next.replace(/^summary\b[:\s-]*/i, ''));
      if (cleaned.length >= 20) return cleaned.slice(0, 500);
    }
    const content = lines.filter((line) => line !== name && line !== current_role && !(email && line.includes(email))).join(' ');
    const cleaned = normalizeWhitespace(content);
    return cleaned ? cleaned.slice(0, 500) : null;
  })();

  return { name, email, phone, skills, experience_years, current_role, summary };
}

export function hasUsefulFallbackResume(parsed: ParsedResume): boolean {
  return Boolean(parsed.name || parsed.email || parsed.phone || parsed.current_role || parsed.summary || parsed.skills.length);
}
