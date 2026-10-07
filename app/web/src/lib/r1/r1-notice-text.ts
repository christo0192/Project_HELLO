/**
 * Turn the notice template's `body_md` into a few safe, structured blocks.
 *
 * The notice is Legal's text, stored as an immutable versioned row (plan
 * section 7.8). The page must show all of it, readable, but must never execute
 * anything inside it: no HTML, no links, no images. This parser therefore
 * returns plain strings in three block kinds and the page renders them as text
 * nodes. Inline emphasis markers are dropped; a link keeps its label and shows
 * its address in brackets so the candidate can still read where it points.
 */

export type NoticeBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEADING_RE = /^#{1,6}\s+(.*)$/;
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

export function parseNoticeBlocks(markdown: string): NoticeBlock[] {
  const blocks: NoticeBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = (): void => {
    const text = plainInline(paragraph.join(' '));
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length) blocks.push({ kind: 'list', items: list });
    list = [];
  };

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = HEADING_RE.exec(line);
    const bullet = BULLET_RE.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const text = plainInline(heading[1]);
      if (text) blocks.push({ kind: 'heading', text });
    } else if (bullet) {
      flushParagraph();
      const text = plainInline(bullet[1]);
      if (text) list.push(text);
    } else if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Fallback wording for the purposes the plan names, used only when the template has no label. */
export const R1_CONSENT_FALLBACK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ai_interview:
    'I agree to an interview conducted by an AI interviewer, including a sales role-play.',
  recording:
    'I agree to my video and audio being recorded for review by the hiring team.',
  ai_evaluation:
    'I agree to an AI evaluation of my interview that may update my application status, '
    + 'which the hiring team can review and change and which I can contest.',
});

export function consentLabel(type: string, templateLabel: string | undefined): string {
  if (templateLabel) return templateLabel;
  return R1_CONSENT_FALLBACK_LABELS[type] ?? `I agree to ${type.replace(/_/g, ' ')}.`;
}
