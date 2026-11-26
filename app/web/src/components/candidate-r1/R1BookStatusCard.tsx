import { useEffect, useRef, type ReactNode } from 'react';

interface R1BookStatusCardProps {
  /** The heading's id, which also labels the card. Unique on the page. */
  id: string;
  eyebrow: string;
  title: string;
  /** Body paragraphs, in order. Copy constants only (r1-book-copy.ts), never server text. */
  body: readonly string[];
  /** The interview's time in India time (`formatBookSlot`), shown large under the heading. */
  when?: string | null;
  /** The card's actions (buttons), laid out one per row. */
  children?: ReactNode;
}

/**
 * One result of the public booking pages (M035 S07, decision D-S07-M12): booked, not found,
 * not open, temporarily unavailable, a manage-link state.
 *
 * The heading takes focus once, when the card mounts, so a keyboard or screen reader user lands
 * on the outcome of what they just did instead of on a control that has gone. A page that shows
 * several states in the same place gives each its own `key`, so every new state mounts (and
 * focuses) its own card.
 */
export function R1BookStatusCard({ id, eyebrow, title, body, when, children }: R1BookStatusCardProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      className="candidate-glass-card candidate-landing candidate-status-card"
      aria-labelledby={id}
    >
      <p className="candidate-eyebrow">{eyebrow}</p>
      <h1 id={id} ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      {when ? <p className="r1-book__when">{when}</p> : null}
      {body.map((paragraph, index) => (
        <p className="candidate-muted" key={index}>
          {paragraph}
        </p>
      ))}
      {children ? <div className="r1-book__actions">{children}</div> : null}
    </section>
  );
}
