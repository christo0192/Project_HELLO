import { useMemo } from 'react';
import type { R1ConsentTemplate } from '../../lib/r1/r1-api';
import { consentLabel, parseNoticeBlocks } from '../../lib/r1/r1-notice-text';
import { R1_BOOK_COPY } from './r1-book-copy';

interface R1BookNoticeProps {
  template: R1ConsentTemplate;
  /** Purpose type -> ticked. Controlled: the page owns every box. */
  checked: Readonly<Record<string, boolean>>;
  inIndia: boolean;
  onToggle: (type: string, value: boolean) => void;
  onInIndia: (value: boolean) => void;
  disabled?: boolean;
  /** Field messages (copy constants), shown under the boxes they are about. */
  errors?: { consents?: string; in_india?: string };
  /** Prefix of every control id (`${idPrefix}-consent-<type>`, `${idPrefix}-in-india`). */
  idPrefix: string;
  /** Level of the notice title: 2 on its own, 3 inside a panel that has its own heading. */
  headingLevel?: 2 | 3;
}

function isTicked(checked: Readonly<Record<string, boolean>>, type: string): boolean {
  return Object.prototype.hasOwnProperty.call(checked, type) && checked[type] === true;
}

/**
 * The notice and the candidate's own consent on the public booking pages (M035 S07, decisions
 * D-M035-6 and D-M035-8): the template's full text, one box per required purpose, and the
 * "I am in India" box.
 *
 * The notice region is the same as R1NoticeConsent.tsx (a focusable region of plain text blocks
 * from `parseNoticeBlocks`: no HTML, no link and no image from the template is ever rendered).
 * Each purpose is its own checkbox with NO select-all: the purposes are agreed to separately.
 * The component is controlled and has no submit of its own; the page validates and sends.
 * The notice's own section headings sit one level below its title.
 */
export function R1BookNotice({
  template,
  checked,
  inIndia,
  onToggle,
  onInIndia,
  disabled = false,
  errors = {},
  idPrefix,
  headingLevel = 2,
}: R1BookNoticeProps) {
  const blocks = useMemo(() => parseNoticeBlocks(template.body_md), [template.body_md]);
  const labels = useMemo(
    () => new Map(template.consent_items.map((item) => [item.type, item.label])),
    [template.consent_items],
  );
  const Title = headingLevel === 3 ? 'h3' : 'h2';
  const BlockHeading = headingLevel === 3 ? 'h4' : 'h3';
  const titleId = `${idPrefix}-notice-title`;
  const consentsErrorId = `${idPrefix}-consents-error`;
  const inIndiaId = `${idPrefix}-in-india`;
  const inIndiaErrorId = `${idPrefix}-in-india-error`;

  return (
    <div className="r1-book__section">
      <Title id={titleId}>{template.title}</Title>

      <div className="r1-notice__body" role="region" aria-label="Full notice" tabIndex={0}>
        {blocks.map((block, index) => {
          if (block.kind === 'heading') return <BlockHeading key={index}>{block.text}</BlockHeading>;
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

      <fieldset className="r1-book__field">
        <legend className="candidate-field-label">{R1_BOOK_COPY.form.purposesLegend}</legend>
        <div className="candidate-consent__items">
          {template.required_consents.map((type) => {
            const ticked = isTicked(checked, type);
            const invalid = Boolean(errors.consents) && !ticked;
            return (
              <label className="candidate-consent__item" key={type}>
                <input
                  id={`${idPrefix}-consent-${type}`}
                  type="checkbox"
                  checked={ticked}
                  disabled={disabled}
                  aria-invalid={invalid ? true : undefined}
                  aria-describedby={invalid ? consentsErrorId : undefined}
                  onChange={(event) => onToggle(type, event.target.checked)}
                />
                <span>{consentLabel(type, labels.get(type))}</span>
              </label>
            );
          })}
        </div>
        {errors.consents ? (
          <p id={consentsErrorId} className="r1-book__field-error">
            {errors.consents}
          </p>
        ) : null}
      </fieldset>

      <div className="r1-book__field">
        <div className="candidate-consent__items">
          <label className="candidate-consent__item">
            <input
              id={inIndiaId}
              type="checkbox"
              checked={inIndia}
              disabled={disabled}
              aria-invalid={errors.in_india ? true : undefined}
              aria-describedby={errors.in_india ? inIndiaErrorId : undefined}
              onChange={(event) => onInIndia(event.target.checked)}
            />
            <span>{R1_BOOK_COPY.form.indiaLabel}</span>
          </label>
        </div>
        {errors.in_india ? (
          <p id={inIndiaErrorId} className="r1-book__field-error">
            {errors.in_india}
          </p>
        ) : null}
      </div>
    </div>
  );
}
