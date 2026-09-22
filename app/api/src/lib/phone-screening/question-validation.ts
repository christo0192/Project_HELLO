/** Validation shared by role writes and phone admission boundaries. */

const META_RE = /\b(?:system|developer|assistant|model|prompt|instruction|interviewer|recruiter)\b|\b(?:must|should|do not|don't)\s+(?:ask|say|tell|mention|reveal|ignore)|\b(?:read|repeat|output|respond)\s+(?:the|this)\b/i;
const DIRECTIVE_MARKER_RE = /[\[\]{}<>]|```|\b(?:json|xml|yaml)\b/i;
const QUESTION_RE = /\?|\b(?:tell|describe|walk|explain|what|how|why|when|where|which|could|can|have|did|would|are|do|is)\b/i;

export type PhoneQuestionIssue =
  | 'empty'
  | 'too_long'
  | 'directive'
  | 'not_speakable'
  | 'duplicate_key'
  | 'duplicate_text';

export interface PhoneQuestionLike {
  id?: unknown;
  question?: unknown;
}

export function normalizeSpokenQuestion(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-IN')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function validatePhoneQuestion(value: unknown): PhoneQuestionIssue[] {
  if (typeof value !== 'string' || !value.trim()) return ['empty'];
  const text = value.trim();
  const issues: PhoneQuestionIssue[] = [];
  if (text.length > 2_000) issues.push('too_long');
  if (META_RE.test(text) || DIRECTIVE_MARKER_RE.test(text)) issues.push('directive');
  if (!QUESTION_RE.test(text)) issues.push('not_speakable');
  return issues;
}

export function validatePhoneQuestionTemplate(template: readonly PhoneQuestionLike[]): Map<number, PhoneQuestionIssue[]> {
  const result = new Map<number, PhoneQuestionIssue[]>();
  const ids = new Map<string, number>();
  const texts = new Map<string, number>();
  template.forEach((entry, index) => {
    const issues = validatePhoneQuestion(entry?.question);
    const id = typeof entry?.id === 'string' ? entry.id.trim().toLocaleLowerCase('en-IN') : '';
    const text = typeof entry?.question === 'string' ? normalizeSpokenQuestion(entry.question) : '';
    if (id && ids.has(id)) issues.push('duplicate_key');
    if (text && texts.has(text)) issues.push('duplicate_text');
    if (id) ids.set(id, index);
    if (text) texts.set(text, index);
    if (issues.length) result.set(index, [...new Set(issues)]);
  });
  return result;
}

export function phoneQuestionIssueMessage(index: number, issues: readonly PhoneQuestionIssue[]): string {
  const labels: Record<PhoneQuestionIssue, string> = {
    empty: 'is empty',
    too_long: 'is too long',
    directive: 'contains recruiter/model instructions or markup',
    not_speakable: 'must be a candidate-facing question',
    duplicate_key: 'duplicates another question id',
    duplicate_text: 'duplicates another question',
  };
  return `Question ${index + 1} ${issues.map((issue) => labels[issue]).join('; ')}.`;
}
