/**
 * InlineNotice layout: the tone dot marks the FIRST line of the message.
 *
 * jsdom has no layout, so this pins the rule that produces it: the dot and
 * the message share a top-aligned row, and the dot is nudged down to the
 * centre of a 20px line. Centred on the whole block instead, a four-line
 * notice floated its dot beside the middle of the paragraph.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, InlineNotice } from '..';

const LONG =
  'Not tracked yet. Reporting what the team did after screening needs each candidate’s Ashby stage to be kept up to date here; today it is only recorded when they are first imported.';

describe('InlineNotice', () => {
  it('pins its dot to the first line of a long message, not the middle of the block', () => {
    render(<InlineNotice tone="info">{LONG}</InlineNotice>);
    const notice = screen.getByRole('status');
    const dot = notice.querySelector('[aria-hidden="true"]') as HTMLElement;
    const row = dot.parentElement as HTMLElement;
    // Dot and message top-aligned together…
    expect(row).toHaveClass('items-start');
    expect(row).not.toHaveClass('items-center');
    expect(row).toHaveTextContent(LONG);
    // …and the dot nudged to the first line's centre: (20px − 8px) / 2.
    expect(dot).toHaveClass('mt-1.5', 'h-2', 'w-2');
  });

  it('still centres an action against the message', () => {
    render(
      <InlineNotice tone="danger" role="alert" action={<Button size="sm">Retry</Button>}>
        Ingestion failed.
      </InlineNotice>,
    );
    const notice = screen.getByRole('alert');
    expect(notice).toHaveClass('items-center');
    const button = within(notice).getByRole('button', { name: 'Retry' });
    // The action is the row's own item, beside (not inside) the dot + message group.
    expect(button.parentElement).toBe(notice);
  });
});
