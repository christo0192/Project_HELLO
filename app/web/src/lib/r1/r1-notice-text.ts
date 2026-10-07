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

/**
 * Fallback wording, used only when the server sent no label for a purpose.
 *
 * It covers every key the R1 notices require (migration 0123, both audiences), so the
 * generic "I agree to <key>" wording below is never reached for them. The server's own
 * `consent_items` are the wording of record and differ by audience (a staff dry run says
 * its evaluation decides nothing about the person), so the two audience-specific
 * purposes here are deliberately neutral: true for both notices, deferring to the
 * notice the person has just read for the detail.
 */
export const R1_CONSENT_FALLBACK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ai_interview:
    'I agree to take part in an interview led by an AI interviewer, including a sales role-play.',
  video_audio_recording:
    'I agree to my camera video and voice being recorded, as this notice describes.',
  ai_evaluation: 'I agree to an AI evaluation of my interview, as this notice describes.',
  data_processing:
    "I agree to the providers listed in this notice, including DeepSeek in the People's "
    + 'Republic of China, processing my data.',
});

export function consentLabel(type: string, templateLabel: string | undefined): string {
  if (templateLabel) return templateLabel;
  return R1_CONSENT_FALLBACK_LABELS[type] ?? `I agree to ${type.replace(/_/g, ' ')}.`;
}
