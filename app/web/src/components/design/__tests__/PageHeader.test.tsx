/**
 * PageHeader — the page's title block (M007/S05 T6).
 *
 * The review found page descriptions cut mid-word ("…through screen…"). This
 * header shows its description in full: it wraps at a reading measure and is
 * never truncated or clamped, and the title sits on the shared type scale.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PageHeader } from '../PageHeader';

const LONG =
  'Upload resumes, review parsed profiles, and move candidates through screening, one decision at a time.';

describe('PageHeader', () => {
  it('shows the whole description, wrapping at a reading measure', () => {
    render(<PageHeader title="Candidates" description={LONG} />);
    const description = screen.getByText(LONG);
    expect(description.textContent).toBe(LONG);
    // Never cut to one line or clamped to a few.
    expect(description.className).not.toMatch(/\b(truncate|line-clamp-\d|text-ellipsis|whitespace-nowrap)\b/);
    expect(description.className).toContain('max-w-[70ch]');
  });

  it('sets the title on the shared scale as the page h1', () => {
    render(<PageHeader title="Phone calendar" />);
    const title = screen.getByRole('heading', { level: 1, name: 'Phone calendar' });
    expect(title.className).toContain('text-title');
    expect(title.className).not.toMatch(/\b(truncate|uppercase)\b/);
  });

  it('keeps the eyebrow sentence case, never an uppercase tracked label', () => {
    render(<PageHeader eyebrow="Operations" title="Mission Control" />);
    const eyebrow = screen.getByText('Operations');
    expect(eyebrow.className).not.toMatch(/\b(uppercase|tracking-wide|tracking-wider|tracking-widest)\b/);
  });

  it('keeps actions in their own slot beside the text', () => {
    render(
      <PageHeader
        title="Roles"
        description="Short."
        actions={<button type="button">New role</button>}
      />,
    );
    const action = screen.getByRole('button', { name: 'New role' });
    expect(action.parentElement?.className).toContain('shrink-0');
  });
});
