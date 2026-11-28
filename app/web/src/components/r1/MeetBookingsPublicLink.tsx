/**
 * The public booking link card on the Meet bookings page (M035 S08): the one address any candidate can
 * book an R1 interview with Lexy on, for HR to paste into the Ashby email template.
 *
 * Invariants:
 *  - Static. It makes no request, reads no flag and no env, starts no timer and touches no storage. The
 *    page shows it only while the server's last answer says Meet is on (D-S08-1); nothing here asks.
 *  - The address is this page's own origin plus `/book` (`meetPublicBookingUrl`), the same page for every
 *    candidate. It never names a manage link, a token or a Meet link.
 *  - The outcome of a copy is announced politely, in a line mounted for the life of the card, and stays
 *    until the next press (no timer clears it). Every press puts a new text node in that line, so a
 *    second copy in a row is announced too (the same words in the same node would change nothing).
 *  - The hint states the condition (bookings only while public booking is switched on), never a state:
 *    the card cannot read the flag, so the words hold before and after go-live alike.
 *  - When the clipboard is refused, or there is none, the field takes the focus with the address
 *    selected, so it can be copied by hand.
 *
 * Renders inside `.candidate-scope`: design primitives and existing tokens only, no colour of its own and
 * no motion import (see candidate-scope-palette.test.ts).
 */
import { useId, useRef, useState } from 'react';
import { Button, Field, TextField } from '../design';
import { meetPublicBookingUrl } from '../../lib/r1-meet-bookings';

type CopyState = 'idle' | 'copied' | 'refused';

const COPY_WORDS: Readonly<Record<CopyState, string>> = {
  idle: '',
  copied: 'Link copied to the clipboard.',
  refused: 'Copy failed. The link is selected; press Ctrl+C (or Cmd+C) to copy it.',
};

export function MeetBookingsPublicLink() {
  const headingId = `meet-public-link-${useId().replace(/:/g, '')}-heading`;
  const boxRef = useRef<HTMLElement>(null);
  // `press` counts presses: the key of the announced words, so each outcome is a new node.
  const [copy, setCopy] = useState<{ state: CopyState; press: number }>({ state: 'idle', press: 0 });
  const url = meetPublicBookingUrl(window.location.origin);

  async function copyLink() {
    try {
      // A browser with no clipboard API throws here too, and gets the same way out.
      await navigator.clipboard.writeText(url);
      setCopy(({ press }) => ({ state: 'copied', press: press + 1 }));
    } catch {
      setCopy(({ press }) => ({ state: 'refused', press: press + 1 }));
      // TextField takes no ref, so the field is found in the card.
      const input = boxRef.current?.querySelector('input');
      input?.focus();
      input?.select();
    }
  }

  return (
    <section ref={boxRef} aria-labelledby={headingId} className="glass-sunken p-4">
      <h2 id={headingId} className="text-label font-medium text-ink">
        Public booking link
      </h2>
      <div className="mt-2 flex flex-wrap items-start gap-3">
        <Field
          id="meet-bookings-public-link"
          label="Link for candidates"
          hint="Paste it into the Ashby email template. Candidates can book on it only while public booking is switched on."
          className="min-w-0 flex-1 basis-64"
        >
          {({ id, describedBy }) => (
            <TextField
              id={id}
              readOnly
              value={url}
              aria-describedby={describedBy}
              autoComplete="off"
              spellCheck={false}
              onFocus={({ currentTarget }) => currentTarget.select()}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          // Level with the field, under a label's height.
          className="sm:mt-[1.375rem]"
          onClick={() => void copyLink()}
        >
          Copy link
        </Button>
      </div>
      {/* Mounted for the life of the card, so the announcement is reliable; a new node per press. */}
      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-ink-secondary">
        {copy.state !== 'idle' && <span key={copy.press}>{COPY_WORDS[copy.state]}</span>}
      </p>
    </section>
  );
}
