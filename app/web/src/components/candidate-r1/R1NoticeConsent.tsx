import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { R1ConsentTemplate } from '../../lib/r1/r1-api';
import { consentLabel, parseNoticeBlocks } from '../../lib/r1/r1-notice-text';
import { Button } from '../ui';

interface R1NoticeConsentProps {
  template: R1ConsentTemplate;
  roleTitle: string;
  /** Plain-language format facts shown above the legal text. */
  facts: readonly string[];
  busy: boolean;
  error: string | null;
  /** Called with the purposes the candidate agreed to (always every required one). */
  onGrant: (consents: string[]) => void;
  onDecline: () => void;
}

/**
 * The itemised notice and the per-purpose consents (plan section 7.8).
 *
 * Each purpose is its own checkbox with no "select all": the plan requires the
 * purposes to be consented to separately. The notice text is the template's own
 * and is shown in full, as plain text, in a focusable scroll region. Agreeing
 * is enabled only when every required purpose is ticked; declining is always
 * available and is a first-class choice, not a hidden link.
 */
export function R1NoticeConsent({
  template,
  roleTitle,
  facts,
  busy,
  error,
  onGrant,
  onDecline,
}: R1NoticeConsentProps) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const blocks = useMemo(() => parseNoticeBlocks(template.body_md), [template.body_md]);
  const labels = useMemo(
    () => new Map(template.consent_items.map((item) => [item.type, item.label])),
    [template.consent_items],
  );
  const allChecked = template.required_consents.every((type) => checked[type] === true);

  return (
    <section className="candidate-glass-card r1-notice" aria-labelledby="r1-notice-title">
      <p className="candidate-eyebrow">Step 1 of 3 · Notice and consent</p>
      <h1 id="r1-notice-title">{template.title}</h1>
      <p className="candidate-muted">Interview for {roleTitle}</p>

      {facts.length > 0 && (
        <ul className="r1-notice__facts" aria-label="What to expect">
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}

      <div
        className="r1-notice__body"
        role="region"
        aria-label="Full notice"
        tabIndex={0}
      >
        {blocks.map((block, index) => {
          if (block.kind === 'heading') return <h2 key={index}>{block.text}</h2>;
          if (block.kind === 'list') {
            return (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{item}</li>
                ))}
              </ul>
            );
          }
          return <p key={index}>{block.text}</p>;
        })}
      </div>

      <fieldset>
        <legend className="candidate-field-label">
          Please agree to each purpose separately
        </legend>
        <div className="candidate-consent__items">
          {template.required_consents.map((type) => (
            <label className="candidate-consent__item" key={type}>
              <input
                type="checkbox"
                checked={checked[type] === true}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.checked;
                  setChecked((previous) => ({ ...previous, [type]: value }));
                }}
              />
              <span>{consentLabel(type, labels.get(type))}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {error && (
        <p className="candidate-error" role="alert">
          {error}
        </p>
      )}

      <div className="r1-actions">
        <Button
          className="candidate-primary-cta"
          disabled={!allChecked}
          loading={busy}
          onClick={() => onGrant([...template.required_consents])}
        >
          I agree and continue
        </Button>
        <button type="button" className="r1-secondary-cta" disabled={busy} onClick={onDecline}>
          I do not agree
        </button>
      </div>
      <p className="candidate-privacy-note">
        Questions? <Link to="/privacy-notice">Review the privacy notice</Link>.
      </p>
    </section>
  );
}
