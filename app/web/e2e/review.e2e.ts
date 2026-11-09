/**
 * The Logsheet Review screen in a real browser: what jsdom cannot see. At 1180px and up the page does
 * not scroll and the two panes do; below that they stack. A cue moves everything at once, the strip's
 * boxes stay pressable, and the Legal-approved consent line opens to every word.
 *
 * Selectors are roles and accessible names where the element has one. A tick, a chip and the clock
 * use their data hooks.
 */

import type { Locator, Page } from '@playwright/test';
import { auditA11y } from './fixtures/axe';
import { makeReviewBusy } from './fixtures/busy-review';
import { busyReview, R1_CANDIDATE_ID, R1_ROUND_ID, SCOPED_REVIEW_LINK_ID, SEEK_CANDIDATE_ID, STAR_CANDIDATE_ID, V2_SESSION_ID } from './fixtures/data';
import type { BusyReviewOptions } from './fixtures/data';
import { expect, test, type AppHarness } from './fixtures/harness';

/** The star candidate has one completed session, so Review opens on it with nothing to pick. */
async function openReview(app: AppHarness, page: Page): Promise<Locator> {
  await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
  const panel = page.getByRole('tabpanel', { name: 'Phone screening' });
  await expect(panel.getByRole('heading', { name: 'AI recommendation' })).toBeVisible();
  await app.settle();
  return panel;
}

/**
 * The same page on a screening shaped like a real one: see `fixtures/busy-review`. The rating summary
 * sits in the name row, as it does on production, so the header is the height these layouts were
 * measured at.
 */
async function openBusy(app: AppHarness, page: Page, options?: Parameters<typeof makeReviewBusy>[1]): Promise<Locator> {
  makeReviewBusy(app.db, options);
  roomInTheNameRow(app);
  return openReview(app, page);
}

const pageScrolls = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight);

/**
 * For a test of what the press itself does. The fixture clip is shorter than any cued moment, so once
 * its link answers the seek clamps to the end of the clip, and the screen rightly follows that instead.
 */
const holdTheRecording = async (page: Page): Promise<void> => {
  await page.route(/\/api\/recordings\//, () => undefined);
};

const scrollsOnItsOwn = (pane: Locator): Promise<boolean> =>
  pane.evaluate((el) => {
    const before = window.scrollY;
    el.scrollTop = 80;
    const moved = el.scrollTop > 0 && window.scrollY === before;
    el.scrollTop = 0;
    return moved;
  });

test.describe('Review, the panes', () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
    test(`at ${viewport.width}x${viewport.height} the page stays put and each pane scrolls on its own`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      const panel = await openReview(app, page);
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
      expect(await scrollsOnItsOwn(panel.getByRole('region', { name: 'Transcript' }))).toBe(true);
      expect(await scrollsOnItsOwn(panel.getByRole('region', { name: 'AI recommendation' }))).toBe(true);
    });
  }

  test('a header of a fractional height, as on a scaled display, leaves the sheet inside its 8px inset', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBusy(app, page);
    // Rounded down, --review-top leaves the workspace taller than the window by the difference.
    for (const margin of ['0.2px', '0.4px', '0.49px']) {
      await expect
        .poll(
          () =>
            page.evaluate(async (top) => {
              document.querySelector<HTMLElement>('[role="tablist"]')!.style.marginTop = top;
              window.dispatchEvent(new Event('resize'));
              await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
              return document.querySelector('main')!.getBoundingClientRect().bottom;
            }, margin),
          { message: margin },
        )
        .toBeLessThanOrEqual(892);
    }
  });

  test('below 1180px the panes stack, the transcript first', async ({ app, page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const panel = await openReview(app, page);
    const transcript = (await panel.getByRole('region', { name: 'Transcript' }).boundingBox())!;
    const reasoning = (await panel.getByRole('region', { name: 'AI recommendation' }).boundingBox())!;
    expect(reasoning.y).toBeGreaterThanOrEqual(transcript.y + transcript.height - 1);
  });

  test('a skip link lands in each pane', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    for (const [link, pane] of [
      ['Skip to transcript', 'Transcript'],
      ['Skip to AI recommendation', 'AI recommendation'],
    ] as const) {
      await panel.getByRole('link', { name: link }).focus();
      await page.keyboard.press('Enter');
      await expect(panel.getByRole('region', { name: pane })).toBeFocused();
    }
  });
});

test.describe('Review, in colour', () => {
  type Family = 'ready' | 'unresolved' | 'closed';
  const FAMILIES: Family[] = ['closed', 'unresolved', 'ready'];

  /** A token as the browser resolves it, as a text colour and as a fill. */
  const token = (page: Page, name: string): Promise<{ colour: string; fill: string }> =>
    page.evaluate((variable) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${variable})`;
      probe.style.backgroundColor = `var(${variable})`;
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const resolved = { colour: style.color, fill: style.backgroundColor };
      probe.remove();
      return resolved;
    }, name);

  const fill = (subject: Locator): Promise<string> => subject.evaluate((el) => getComputedStyle(el).backgroundColor);
  const ink = (subject: Locator): Promise<string> => subject.evaluate((el) => getComputedStyle(el).color);

  /** A firm, scored row of the fixture, its verdict and figure set: only the star's is provisional. */
  const NISHA = 'Nisha Menon';
  async function openFirm(app: AppHarness, page: Page, recommendation: 'advance' | 'hold' | 'reject', overall: number, held = false): Promise<Locator> {
    const candidate = app.db.candidates.find((c) => c.name === NISHA)!;
    const detail = Object.values(app.db.sessionDetails).find((d) => d.session.candidate_id === candidate.id && d.assessment)!;
    const assessment = detail.assessment!;
    assessment.recommendation = recommendation;
    assessment.overall_score = overall;
    Object.assign(assessment.raw as object, { recommendation, overallScore: overall });
    if (held) Object.assign(assessment, { evidence_grade: 'insufficient', evidence_reason: 'partial_thin' });
    await app.goto(`/candidates/${candidate.id}?tab=phone`);
    const panel = page.getByRole('tabpanel', { name: 'Phone screening' });
    await expect(panel.getByRole('heading', { name: 'AI recommendation' })).toBeVisible();
    await app.settle();
    return panel;
  }

  for (const [recommendation, overall, family, word, mark] of [
    ['advance', 86, 'ready', 'Select', '--ready-text'],
    ['hold', 58, 'unresolved', 'Borderline', '--unresolved-text'],
    ['reject', 41, 'closed', 'Reject', '--closed-text'],
  ] as const) {
    test(`a firm ${word} block, figure and ruler take the ${family} family, and axe passes`, async ({ app, page }, testInfo) => {
      const panel = await openFirm(app, page, recommendation, overall);
      const box = panel.locator('[data-verdict-box]');
      expect(await fill(box)).toBe((await token(page, `--${family}-soft`)).fill);
      const edge = await box.evaluate((el) => {
        const style = getComputedStyle(el);
        return { style: style.borderTopStyle, width: style.borderTopWidth, colour: style.borderTopColor, left: style.borderLeftWidth };
      });
      expect(edge).toEqual({ style: 'solid', width: '1px', colour: (await token(page, `--${family}`)).colour, left: '1px' });
      expect(await ink(box.getByText(String(overall), { exact: true }))).toBe((await token(page, mark)).colour);

      for (const zone of FAMILIES) {
        const paint = zone === family ? `--${zone}` : `--${zone}-light`;
        expect(await fill(box.locator(`[data-ruler-zone="${zone}"]`)), zone).toBe((await token(page, paint)).fill);
      }
      await auditA11y(page, testInfo, `review-${word.toLowerCase()}`, { strict: true });
    });
  }

  test('the star is provisional: dashed in its own family, and "Provisional" says so in unresolved', async ({ app, page }) => {
    const panel = await openReview(app, page);
    const box = panel.locator('[data-verdict-box]');
    await expect(box).toHaveAttribute('data-verdict-box', 'provisional');
    expect(await box.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
    expect(await box.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe((await token(page, '--ready')).colour);
    expect(await ink(box.getByText('Provisional', { exact: true }))).toBe((await token(page, '--unresolved-text')).colour);
  });

  test('the colour moves nothing: the rubric starts in the same place whatever the verdict, and the ruler is 6px', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const offsets: number[] = [];
    for (const [recommendation, overall] of [['advance', 86], ['hold', 58], ['reject', 41]] as const) {
      const panel = await openFirm(app, page, recommendation, overall);
      const pane = panel.getByRole('region', { name: 'AI recommendation' });
      offsets.push(
        await pane.evaluate((el) => el.querySelector('[data-rubric-row]')!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop),
      );
      const bar = (await panel.locator('[data-ruler-zone="closed"]').boundingBox())!;
      expect(bar.height).toBe(6);
    }
    expect(new Set(offsets).size).toBe(1);
  });

  test('an evidence number takes the family of the rating it cites, on the strip and in the margin', async ({ app, page }) => {
    // Nisha: Communication clarity 1 of 4 is cued on opening, Technical depth 2, Problem solving 3.
    const panel = await openFirm(app, page, 'reject', 41);
    const tick = (n: number) => panel.locator(`[data-strip-tick="${n}"]`);
    await expect(tick(1)).toHaveAttribute('aria-pressed', 'true');
    await panel.getByRole('button', { name: 'Communication clarity', exact: true }).click();
    await panel.getByRole('button', { name: 'Technical depth', exact: true }).click();
    expect(await fill(tick(1))).toBe((await token(page, '--closed-text')).fill);
    expect(await ink(tick(1))).toBe((await token(page, '--paper')).colour);
    expect(await fill(tick(2))).toBe((await token(page, '--paper')).fill);
    expect(await ink(tick(2))).toBe((await token(page, '--unresolved-text')).colour);
    // The edge is the mark: a tag has no word, and the text shades collapse for a colour-blind reader.
    expect(await tick(2).evaluate((el) => getComputedStyle(el).borderTopColor)).toBe((await token(page, '--unresolved')).colour);
    expect(await ink(tick(3))).toBe((await token(page, '--ready-text')).colour);
    expect(await ink(panel.getByRole('button', { name: /^Evidence 1, / }))).toBe((await token(page, '--paper')).colour);
    expect(await fill(panel.locator('[data-quote-button="1"] [data-evidence-number]'))).toBe((await token(page, '--closed-text')).fill);
    // The voice stays the voice.
    expect(await panel.locator('[data-strip-segment="candidate"]').first().getAttribute('fill')).toBe('var(--voice-mark)');
  });

  test('a tick that steps back keeps its place, its digit and its stem, on a faint edge', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    const quiet = panel.locator('[data-strip-tick][data-tick-quiet]').first();
    const number = await quiet.getAttribute('data-strip-tick');
    const before = (await quiet.boundingBox())!;
    const edge = () => quiet.evaluate((el) => getComputedStyle(el).borderTopColor);
    const stem = panel.locator(`[data-tick-stem="${number}"]`);

    // The first quiet tick cites a Good, 3 of 4.
    expect(await ink(quiet)).toBe((await token(page, '--ready-text')).colour);
    expect(await edge()).toBe((await token(page, '--rule')).colour);
    expect(await fill(stem)).toBe((await token(page, '--control')).fill);
    await expect(quiet).toHaveAccessibleName(/^Evidence \d+: turn \d+ at \d\d:\d\d, /);

    // Its metric opens by a press: the same box, at full weight.
    await holdTheRecording(page);
    await quiet.click();
    await expect(panel.locator(`[data-strip-tick="${number}"]`)).toHaveAttribute('aria-pressed', 'true');
    const after = (await panel.locator(`[data-strip-tick="${number}"]`).boundingBox())!;
    expect({ x: after.x, y: after.y, width: after.width, height: after.height }).toEqual({ x: before.x, y: before.y, width: before.width, height: before.height });
    expect(await fill(stem)).toBe((await token(page, '--ink')).fill);
  });

  test('"Writing results back to Ashby" is underway', async ({ app, page }) => {
    const panel = await openReview(app, page);
    const cell = panel.locator('[data-log-header]').getByText('Writing results back to Ashby');
    expect(await ink(cell)).toBe((await token(page, '--moving-text')).colour);
  });

  test('a contrast theme still draws the ruler and the pips, with a gap between the zones', async ({ app, page }) => {
    const panel = await openFirm(app, page, 'hold', 58);
    await page.emulateMedia({ forcedColors: 'active' });
    const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    for (const zone of FAMILIES) {
      expect(await fill(panel.locator(`[data-ruler-zone="${zone}"]`)), zone).not.toBe(canvas);
    }
    expect(
      await panel.locator('[data-ruler-zone="unresolved"]').evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: style.borderLeftWidth, colour: style.borderLeftColor };
      }),
    ).toEqual({ width: '2px', colour: canvas });
    expect(await fill(panel.locator('[data-score-mark]'))).not.toBe(canvas);
    expect(await fill(panel.locator('[data-rating-pips] > .data-fill').first())).not.toBe(canvas);
  });

  for (const [recommendation, overall] of [['advance', 86], ['hold', 58], ['reject', 41]] as const) {
    test(`a contrast theme forces a ${recommendation} circle along with its word`, async ({ app, page }) => {
      const panel = await openFirm(app, page, recommendation, overall);
      const verdict = panel.locator('[data-verdict-box] [data-recommendation]');
      const circle = verdict.locator('circle');
      const strokeOf = () => circle.evaluate((el) => getComputedStyle(el).stroke);
      const family = (await token(page, { advance: '--ready', hold: '--unresolved', reject: '--closed' }[recommendation])).colour;
      expect(await strokeOf()).toBe(family);
      await page.emulateMedia({ forcedColors: 'active' });
      expect(await strokeOf()).toBe(await ink(verdict));
      expect(await strokeOf()).not.toBe(family);
    });
  }

  test('a scorecard held for thin evidence has no hue, in a real browser', async ({ app, page }, testInfo) => {
    const panel = await openFirm(app, page, 'advance', 80, true);
    await expect(panel.getByText('Not enough interview evidence to decide')).toBeVisible();
    const box = panel.locator('[data-verdict-box]');
    const edge = await box.evaluate((el) => {
      const style = getComputedStyle(el);
      return { colour: style.borderTopColor, wash: style.backgroundColor };
    });
    expect(edge).toEqual({ colour: (await token(page, '--rule-2')).colour, wash: 'rgba(0, 0, 0, 0)' });
    expect(await ink(box.getByText('80', { exact: true }))).toBe((await token(page, '--ink')).colour);
    expect(await box.locator('circle').evaluate((el) => getComputedStyle(el).stroke)).toBe((await token(page, '--ink')).colour);
    for (const zone of FAMILIES) {
      expect(await fill(box.locator(`[data-ruler-zone="${zone}"]`)), zone).toBe((await token(page, '--rule-2')).fill);
    }
    expect(await fill(panel.locator('[data-rating-pips] > .data-fill').first())).toBe((await token(page, '--ink')).fill);
    await auditA11y(page, testInfo, 'review-held', { strict: true });
  });

  test('a ruler never says Select beside a Reject: the stored verdict decides, and the mark stays at the score', async ({ app, page }) => {
    const panel = await openFirm(app, page, 'reject', 72);
    const box = panel.locator('[data-verdict-box]');
    expect(await fill(box.locator('[data-ruler-zone="closed"]'))).toBe((await token(page, '--closed')).fill);
    expect(await fill(box.locator('[data-ruler-zone="ready"]'))).toBe((await token(page, '--ready-light')).fill);
    expect(await box.getByText('Select 65', { exact: true }).evaluate((el) => getComputedStyle(el).fontWeight)).toBe('400');
    expect(await box.getByText('Reject', { exact: true }).last().evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');
    const bar = (await box.locator('[data-score-ruler]').boundingBox())!;
    const mark = (await box.locator('[data-score-mark]').boundingBox())!;
    expect(Math.abs(mark.x + 1 - (bar.x + bar.width * 0.72))).toBeLessThan(2);
  });

  test('the zones of a ruler are set apart by a real gap, and it costs the ruler no height', async ({ app, page }) => {
    const panel = await openFirm(app, page, 'hold', 58);
    for (const zone of ['unresolved', 'ready']) {
      expect(
        await panel.locator(`[data-ruler-zone="${zone}"]`).evaluate((el) => {
          const style = getComputedStyle(el);
          return { width: style.borderLeftWidth, colour: style.borderLeftColor, clip: style.backgroundClip };
        }),
        zone,
      ).toEqual({ width: '2px', colour: 'rgba(0, 0, 0, 0)', clip: 'padding-box' });
    }
    expect((await panel.locator('[data-ruler-zone="closed"]').boundingBox())!.height).toBe(6);
  });

  for (const width of [360, 390, 414, 1180]) {
    test(`at ${width} wide the ruler's labels do not run together`, async ({ app, page }) => {
      await page.setViewportSize({ width, height: 900 });
      const panel = await openFirm(app, page, 'hold', 58);
      const ruler = panel.locator('[data-score-ruler]');
      const box = async (word: string) => (await ruler.getByText(word, { exact: true }).boundingBox())!;
      const [reject, borderline, select, hundred] = [await box('Reject'), await box('Borderline 45'), await box('Select 65'), await box('100')];
      expect(reject.x + reject.width).toBeLessThanOrEqual(borderline.x);
      expect(borderline.x + borderline.width).toBeLessThanOrEqual(select.x + 0.5);
      expect(select.x + select.width).toBeLessThanOrEqual(hundred.x);
      // One line each, on the ruler's own row.
      expect(borderline.height).toBe(select.height);
    });
  }
});

test.describe('Review, the log header', () => {
  /** What the sheet leaves for the panes: the window, less all that sits above them and the 9px below. */
  const panesFill = async (panel: Locator, height: number): Promise<void> => {
    const pane = (await panel.getByRole('region', { name: 'AI recommendation' }).boundingBox())!;
    expect(pane.y + pane.height).toBe(height - 9);
  };

  test('at 1440x900 it is one ruled line of 30px, and the tape is 113px', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    const header = panel.locator('[data-log-header]');
    expect((await header.boundingBox())!.height).toBe(30);
    expect((await panel.getByRole('region', { name: 'Call recording and strip' }).boundingBox())!.height).toBe(113);
    await panesFill(panel, 900);
    // Every label stays printed, on the same line as its value.
    for (const label of ['Role', 'Screening', 'Length', 'In Ashby']) {
      const printed = header.getByText(label, { exact: true });
      await expect(printed).toBeVisible();
      const value = printed.locator('xpath=following-sibling::dd');
      const [labelBox, valueBox] = [(await printed.boundingBox())!, (await value.boundingBox())!];
      expect(labelBox.x + labelBox.width, label).toBeLessThanOrEqual(valueBox.x);
      expect(Math.abs(labelBox.y + labelBox.height - (valueBox.y + valueBox.height)), label).toBeLessThan(4);
    }
    await expect(header).not.toContainText('Interviewer');
  });

  test('at 1366 wide the line wraps to about 58px, and nothing is cut', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openBusy(app, page);
    const header = panel.locator('[data-log-header]');
    expect((await header.boundingBox())!.height).toBe(58);
    await panesFill(panel, 768);
    for (const value of await header.locator('dd').all()) {
      const cut = await value.evaluate((el) => el.scrollWidth > el.clientWidth || getComputedStyle(el).textOverflow === 'ellipsis');
      expect(cut, 'a value is cut').toBe(false);
    }
    await expect(header).toContainText('AI scorecard sent');
  });

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1024, height: 768 }]) {
    test(`at ${viewport.width} wide a wrapped line never ends on a rule with nothing beside it`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      const panel = await openBusy(app, page);
      const { lines, stray } = await panel.locator('[data-log-header]').evaluate((header) => {
        const list = header.matches('dl') ? header : header.querySelector('dl')!;
        const clip = getComputedStyle(list).overflowX === 'visible' ? { left: 0, right: window.innerWidth } : list.getBoundingClientRect();
        const words = [...list.querySelectorAll('dt, dd')].map((el) => el.getBoundingClientRect());
        const found: string[] = [];
        for (const cell of list.children) {
          const box = cell.getBoundingClientRect();
          const style = getComputedStyle(cell);
          const rules = [
            parseFloat(style.borderLeftWidth) > 0 ? box.left : null,
            parseFloat(style.borderRightWidth) > 0 ? box.right - parseFloat(style.borderRightWidth) : null,
          ];
          for (const x of rules) {
            if (x === null || x < clip.left || x >= clip.right) continue;
            const onLine = words.filter((w) => w.top + w.height / 2 > box.top && w.top + w.height / 2 < box.bottom);
            const before = onLine.some((w) => w.right <= x + 0.5);
            const after = onLine.some((w) => w.left >= x + 0.5);
            if (!before || !after) found.push(`${cell.querySelector('dt')!.textContent} at ${Math.round(x)}`);
          }
        }
        return { lines: new Set([...list.children].map((cell) => Math.round(cell.getBoundingClientRect().top))).size, stray: found };
      });
      expect(lines, 'the header did not wrap, so this proves nothing').toBeGreaterThan(1);
      expect(stray).toEqual([]);
    });
  }

  test('a role too long for the line wraps inside the sheet, and the panes still fill the window', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    makeReviewBusy(app.db);
    const role = app.db.roles.find((r) => r.id === app.db.candidates.find((c) => c.id === STAR_CANDIDATE_ID)!.role_id)!;
    role.title = 'Senior Inside Sales Program Advisor for Working Professionals, Upskilling and Career Transitions';
    const panel = await openReview(app, page);
    const header = panel.locator('[data-log-header]');
    await expect(header).toContainText(role.title);
    const headerBox = (await header.boundingBox())!;
    for (const value of await header.locator('dd').all()) {
      const box = (await value.boundingBox())!;
      expect(box.x + box.width, 'a value runs out of the sheet').toBeLessThanOrEqual(headerBox.x + headerBox.width);
    }
    await panesFill(panel, 900);
  });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1440, height: 768 }, { width: 1366, height: 768 }]) {
    test(`at ${viewport.width}x${viewport.height} the panes do not jump when the tape replaces its placeholder`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      makeReviewBusy(app.db);
      let release = (): void => undefined;
      const answered = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(/\/api\/screening\/[^/]+$/, async (route) => {
        await answered;
        await route.fallback();
      });
      const going = app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
      const placeholder = page.locator('[data-tape-placeholder]');
      await expect(placeholder).toBeVisible();
      const waiting = (await placeholder.boundingBox())!;
      const paneWaiting = (await page.locator('[data-review-pane="reasoning"]').boundingBox())!;

      release();
      await going;
      const tape = page.getByRole('region', { name: 'Call recording and strip' });
      await expect(tape).toBeVisible();
      expect((await tape.boundingBox())!.height).toBe(waiting.height);
      expect((await page.locator('[data-review-pane="reasoning"]').boundingBox())!.y).toBe(paneWaiting.y);
    });
  }

  test('reads the length from the session list: GET /api/screening/:id has no recorded total', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    await expect(panel.locator('[data-log-header]')).toContainText(/Length\s*Recorded \d+m \d+s/);
  });

  test('one session is a line of text, and two are a picker that opens over the page', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const one = await openReview(app, page);
    await expect(one.getByRole('button', { name: /^Screening/ })).toHaveCount(0);
    await expect(one.locator('[data-session-text]')).toContainText('Live voice');

    await app.goto(`/candidates/${SEEK_CANDIDATE_ID}?tab=phone`);
    const two = page.getByRole('tabpanel', { name: 'Phone screening' });
    const transcript = two.getByRole('region', { name: 'Transcript' });
    await expect(two.getByRole('heading', { name: 'Transcript' })).toBeVisible();
    await app.settle();
    const before = (await transcript.boundingBox())!;
    await two.getByRole('button', { name: /^Screening/ }).click();
    await expect(two.getByRole('listbox', { name: 'Sessions' })).toBeVisible();
    // In flow, the list would push the tape and both panes down the page.
    expect((await transcript.boundingBox())!.y).toBe(before.y);
    const option = two.getByRole('option', { name: /Recorded 1m 30s/ });
    await expect(option).toBeInViewport();
    // Over the page, edge to edge: the header clips nothing of it, and nothing below paints over it.
    const reachable = await option.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const y = box.top + box.height / 2;
      return [box.left + 2, box.left + box.width / 2, box.right - 2].map((x) => el.contains(document.elementFromPoint(x, y)));
    });
    expect(reachable).toEqual([true, true, true]);
  });
});

/** What the reasoning pane shows on arrival: each row's height, and how many stand whole above its fold. */
async function rubricOnArrival(panel: Locator): Promise<{ heights: number[]; whole: number; firstTop: number }> {
  const pane = panel.getByRole('region', { name: 'AI recommendation' });
  const paneBox = (await pane.boundingBox())!;
  const boxes = await Promise.all((await pane.locator('[data-rubric-row]').all()).map(async (row) => (await row.boundingBox())!));
  return {
    heights: boxes.map((box) => box.height),
    whole: boxes.filter((box) => box.y >= paneBox.y && box.y + box.height <= paneBox.y + paneBox.height).length,
    firstTop: boxes[0].y,
  };
}

/**
 * The name row with room for the rating summary, so the header is the height it was without one: no
 * email, and only Export report, which is all production has until an API sends the Ashby link.
 */
function roomInTheNameRow(app: AppHarness): void {
  const read = app.db.candidateDetail;
  app.db.candidateDetail = (id) => {
    const detail = read(id);
    if (detail && id === STAR_CANDIDATE_ID) detail.candidate.email = null;
    return detail;
  };
  const readWorkflow = app.db.ashbyWorkflowFor;
  app.db.ashbyWorkflowFor = (id) => {
    const workflow = readWorkflow(id);
    return workflow && { ...workflow, ashbyProfileUrl: undefined };
  };
}

/** The five rows of the star candidate's plain screening, each whole above the pane's fold and on one line. */
async function allFiveRowsFit(panel: Locator): Promise<void> {
  const pane = panel.getByRole('region', { name: 'AI recommendation' });
  const rows = pane.locator('[data-rubric-row]');
  await expect(rows).toHaveCount(5);
  const paneBox = (await pane.boundingBox())!;
  for (const row of await rows.all()) {
    const box = (await row.boundingBox())!;
    expect(box.y + box.height, 'a rubric row is below the fold').toBeLessThanOrEqual(paneBox.y + paneBox.height);
    expect((await row.locator('h4').boundingBox())!.height, 'a metric name wrapped').toBeLessThan(26);
  }
}

test.describe('Review, the rubric', () => {
  test('at 1440x900 the rows of a busy screening are 72, 27, 30, 30, 30 and 30, each name on one line', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    expect((await rubricOnArrival(panel)).heights).toEqual([72, 27, 30, 30, 30, 30]);
    for (const name of await panel.locator('[data-rubric-row] h4').all()) {
      expect((await name.boundingBox())!.height, 'a metric name wrapped').toBeLessThan(26);
    }
  });

  test('at 1440x900 four whole rows stand on arrival when Check before deciding has five lines', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page, { redFlags: 4 });
    expect((await rubricOnArrival(panel)).whole).toBe(4);
  });

  for (const viewport of [{ width: 1440, height: 768 }, { width: 1366, height: 768 }]) {
    test(`below 820px tall, at ${viewport.width}x${viewport.height}, the weakest metric's reasoning takes one line`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      const panel = await openBusy(app, page);
      expect((await rubricOnArrival(panel)).heights[0]).toBe(52);
    });
  }

  test('the weakest metric takes two lines again at 820px tall', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 820 });
    const panel = await openBusy(app, page);
    expect((await rubricOnArrival(panel)).heights[0]).toBe(72);
  });

  test('its quotes wait behind the chevron, and a tick reaches them', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    await expect(panel.locator('[data-quote-button]')).toHaveCount(0);

    await holdTheRecording(page);
    const weakest = panel.locator('[data-rubric-row]').first();
    const tick = panel.locator('[data-strip-tick][aria-pressed="true"]');
    const number = await tick.getAttribute('data-strip-tick');
    await tick.click();
    await expect(weakest.locator(`[data-quote-button="${number}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(weakest.locator('[data-quote-button]')).toHaveCount(3);
  });

  test('its chevron opens the same quotes, with nothing played', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    const weakest = panel.locator('[data-rubric-row]').first();
    await weakest.getByRole('button', { name: 'Communication', exact: true }).click();
    await expect(weakest.locator('[data-quote-button]')).toHaveCount(3);
    expect(app.calls.filter((c) => /\/api\/recordings\//.test(new URL(c.url).pathname))).toEqual([]);
  });

  test('arrival stays cued: chip and tick pressed, the turn lit, nothing played', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    const pressed = await panel.locator('[data-strip-tick][aria-pressed="true"]').getAttribute('data-strip-tick');
    await expect(panel.locator('[data-rubric-row]').first().locator(`[data-seek-chip="${pressed}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('[data-turn-row] [aria-current="true"]')).toBeInViewport();
    await expect(panel.getByRole('button', { name: /^Play from/ })).toBeVisible();
    expect(app.calls.filter((c) => /\/api\/recordings\//.test(new URL(c.url).pathname))).toEqual([]);
  });

  test('Check before deciding carries one alert icon, and "Red flag:" stays on every line', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    const heading = panel.getByRole('heading', { name: 'Check before deciding' });
    await expect(heading.locator('svg')).toHaveCount(1);
    const list = heading.locator('xpath=ancestor::div[2]').locator('ul');
    await expect(list.locator('svg')).toHaveCount(0);
    await expect(list.getByText('Red flag:', { exact: true })).toHaveCount(5);
  });

  test('all five rows are on screen when Review opens at 1440x900, each on one line', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a touch screen keeps its 44px target, so the summary takes two of them');
    await page.setViewportSize({ width: 1440, height: 900 });
    roomInTheNameRow(app);
    const panel = await openReview(app, page);
    await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'row');
    await allFiveRowsFit(panel);
  });

  test('with the summary on its own line the pane gives up that line and no more, and every name stays on one line', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a phone stacks the panes');
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'line');
    const pane = panel.getByRole('region', { name: 'AI recommendation' });
    const rows = pane.locator('[data-rubric-row]');
    await expect(rows).toHaveCount(5);
    const paneBox = (await pane.boundingBox())!;
    const last = (await rows.last().boundingBox())!;
    // The own line costs the pane its height, so the last row can fall a scroll away. What it says is in
    // the header. This pins that the cost stops at the line.
    expect(last.y + last.height, 'more than the summary\'s 20px line went').toBeLessThanOrEqual(paneBox.y + paneBox.height + 20);
    for (const row of await rows.all()) {
      expect((await row.locator('h4').boundingBox())!.height, 'a metric name wrapped').toBeLessThan(26);
    }
  });

  test('a second session keeps them there: the picker in the log header stays one line', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a touch screen keeps its 44px target');
    await page.setViewportSize({ width: 1440, height: 900 });
    makeReviewBusy(app.db, { redFlags: 4 });
    roomInTheNameRow(app);
    const read = app.db.candidateDetail;
    app.db.candidateDetail = (id) => {
      const detail = read(id);
      if (detail && id === STAR_CANDIDATE_ID) {
        detail.sessions = [...detail.sessions, { ...detail.sessions[0], id: '33333333-3333-4333-8333-333333333333', created_at: '2026-01-05T10:00:00.000Z' }];
      }
      return detail;
    };
    const panel = await openReview(app, page);
    const picker = panel.locator('#sync-session-select');
    await expect(picker).toBeVisible();
    expect((await picker.boundingBox())!.height, 'the picker wrapped').toBeLessThanOrEqual(26);
    expect((await panel.locator('[data-log-header]').boundingBox())!.height).toBe(34);
    expect((await rubricOnArrival(panel)).whole).toBe(4);
  });

  test('metric names stay on one line at 1366x768', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    for (const name of await panel.locator('[data-rubric-row] h4').all()) {
      expect((await name.boundingBox())!.height, 'a metric name wrapped').toBeLessThan(26);
    }
  });
});

test.describe('Review, the ratings in the header', () => {
  const SCREENS = [
    { width: 1440, height: 900 },
    { width: 1440, height: 768 },
    { width: 1366, height: 768 },
  ];
  const EMAIL = 'firstname.lastname@example.com';
  const LONG_NAME = 'Venkatanarasimha Raghavendra Subramanyam Iyengar';
  const LONG_EMAIL = 'firstname.middlename.lastname.someone.long@example-company-domain.com';
  /** The own line: a 44px action row and one 24px line, where a plain row is 44 and 4 of padding. */
  const OWN_LINE_GROWTH = 20;
  /** The same, on two lines. */
  const TWO_LINE_GROWTH = 44;

  const desktopOnly = (testInfo: { project: { name: string } }) =>
    test.skip(testInfo.project.name !== 'desktop', 'a phone stacks the summary, and has its own test');

  async function openBusy(app: AppHarness, page: Page, options: BusyReviewOptions): Promise<Locator> {
    busyReview(app.db, options);
    await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
    const panel = page.getByRole('tabpanel', { name: 'Phone screening' });
    await expect(panel.getByRole('heading', { name: 'AI recommendation' })).toBeVisible();
    await app.settle();
    return panel;
  }

  const ratings = (page: Page): Locator => page.locator('[data-header-ratings]');
  const items = (page: Page): Locator => page.locator('[data-header-rating]');
  const exportReport = (page: Page): Locator => page.getByRole('button', { name: /Export report/ });
  /** As it reads on screen: `innerText` leaves out what the layout hides, and keeps a stacked line break. */
  const leadAsPrinted = (page: Page): Promise<string> => page.locator('[data-header-ratings-lead]').evaluate((el) => (el as HTMLElement).innerText);
  const workspaceTop = async (page: Page): Promise<number> => (await page.locator('[data-review-workspace]').boundingBox())!.y;
  const edgesOf = async (subject: Locator) => {
    const box = (await subject.boundingBox())!;
    return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height, width: box.width, height: box.height };
  };

  /** The header's height with no summary in it, for the same candidate in the same window. */
  async function plainTop(app: AppHarness, page: Page, options: BusyReviewOptions): Promise<number> {
    busyReview(app.db, { ...options, noScorecard: true });
    await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
    await expect(page.locator('[data-review-workspace]')).toBeVisible();
    await app.settle();
    return workspaceTop(page);
  }

  /** Nothing covers it: `toBeInViewport` passes a control under a sticky bar. */
  const onTop = async (subject: Locator) => {
    const hit = await subject.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { itself: top !== null && (top === el || el.contains(top)), found: top?.outerHTML.slice(0, 80) };
    });
    expect(hit.itself, `covered by ${hit.found}`).toBe(true);
  };

  const clearOf = async (page: Page) => {
    const summary = await edgesOf(ratings(page));
    const action = await edgesOf(exportReport(page));
    const apart = summary.right <= action.left || summary.top >= action.bottom;
    expect(apart, `the summary runs over Export report: ${JSON.stringify({ summary, action })}`).toBe(true);
  };

  const r1Line = (page: Page): Locator => page.locator('[data-header-r1-line]');
  const R1_LINE = 'R1 role-play: Borderline 58 (AI)';

  /** Neither box touches the other, on either axis. */
  const noOverlap = async (one: Locator, other: Locator, what: string) => {
    const a = await edgesOf(one);
    const b = await edgesOf(other);
    const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    expect(apart, `${what}: ${JSON.stringify({ a, b })}`).toBe(true);
  };

  /** The rounds wait for the test, so the page settles on what it has before the R1 line arrives. */
  async function openBeforeTheRounds(app: AppHarness, page: Page, options: BusyReviewOptions): Promise<() => void> {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/candidates/${STAR_CANDIDATE_ID}/interview-rounds`, async (route) => {
      await held;
      await route.fallback();
    });
    busyReview(app.db, { ...options, r1: true });
    await page.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
    await expect(items(page)).toHaveCount(options.metrics ?? 6);
    // Not `app.settle()`: the held read is what keeps the network busy.
    await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
    return release;
  }

  for (const screen of SCREENS) {
    test(`at ${screen.width}x${screen.height} with no email it sits in the name row, three by two, and the header does not grow`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize(screen);
      const plain = await plainTop(app, page, {});
      await openBusy(app, page, {});

      await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'row');
      expect(await workspaceTop(page), 'the header grew').toBe(plain);
      await expect(items(page)).toHaveCount(6);

      const summary = await edgesOf(ratings(page));
      expect(summary.height).toBeLessThanOrEqual(48);
      await clearOf(page);
      const heading = await edgesOf(page.getByRole('heading', { level: 1 }));
      expect(summary.left).toBeGreaterThanOrEqual(heading.right);
      // Filled across, in rubric order: three on each of two rows.
      const boxes = await Promise.all((await items(page).all()).map(edgesOf));
      expect(new Set(boxes.map((box) => box.top)).size).toBe(2);
      expect(boxes[0].top).toBe(boxes[2].top);
      expect(boxes[3].top).toBeGreaterThan(boxes[2].top);
      expect(boxes[0].left).toBeLessThan(boxes[1].left);
      expect(boxes[1].left).toBeLessThan(boxes[2].left);
      expect(boxes[3].left).toBe(boxes[0].left);
      // Stacked, so the line break parts the words the box's dot parts.
      expect((await leadAsPrinted(page)).split('\n')).toEqual(['Provisional', '5 of 6 metrics']);
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
    });

    test(`at ${screen.width}x${screen.height} with an email it takes its own line, and grows the header by that line alone`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize(screen);
      const plain = await plainTop(app, page, { email: EMAIL });
      await openBusy(app, page, { email: EMAIL });

      await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'line');
      expect(await workspaceTop(page)).toBe(plain + OWN_LINE_GROWTH);
      const boxes = await Promise.all((await items(page).all()).map(edgesOf));
      expect(boxes).toHaveLength(6);
      expect(new Set(boxes.map((box) => box.top)).size, 'six across, on one line').toBe(1);
      await clearOf(page);
      const summary = await edgesOf(ratings(page));
      expect(summary.top).toBeGreaterThanOrEqual((await edgesOf(exportReport(page))).bottom);
      expect(summary.height).toBe(24);
      expect(await leadAsPrinted(page)).toBe('Provisional · 5 of 6 metrics');
      await expect(page.getByRole('group', { name: 'Provisional · 5 of 6 metrics' })).toBeVisible();
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
    });

    test(`at ${screen.width}x${screen.height} a long name with no email behaves as an email does`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize(screen);
      await openBusy(app, page, { name: LONG_NAME });
      await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'line');
      await clearOf(page);
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
    });
  }

  for (const screen of SCREENS) {
    for (const options of [{}, { email: EMAIL }, { name: LONG_NAME }, { name: LONG_NAME, email: LONG_EMAIL }, { statusDetail: true }] as BusyReviewOptions[]) {
      test(`at ${screen.width}x${screen.height} an R1 result stands beside the summary, and nothing moves when it arrives: ${JSON.stringify(options)}`, async ({ app, page }, testInfo) => {
        desktopOnly(testInfo);
        await page.setViewportSize(screen);
        const release = await openBeforeTheRounds(app, page, options);
        if (options.statusDetail) await expect(page.locator('[data-phone-status-detail]')).toBeVisible();
        await expect(r1Line(page)).toBeEmpty();
        const fit = await page.locator('[data-ratings-fit]').getAttribute('data-ratings-fit');
        const before = await workspaceTop(page);
        const room = await edgesOf(r1Line(page));

        release();
        await expect(r1Line(page)).toHaveText(R1_LINE);
        await app.settle();

        expect(await workspaceTop(page), 'the panes moved').toBe(before);
        await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', fit!);
        expect((await edgesOf(r1Line(page))).width, 'the line outgrew the room kept for it').toBe(room.width);
        expect((await edgesOf(r1Line(page))).height, 'the line grew taller than the room kept for it').toBe(room.height);
        await expect(items(page)).toHaveCount(6);
        await clearOf(page);
        await noOverlap(r1Line(page), ratings(page), 'the R1 line runs into the summary');
        await noOverlap(r1Line(page), exportReport(page), 'the R1 line runs into Export report');
        expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
      });
    }

    test(`at ${screen.width}x${screen.height} the Ashby action keeps clear of the summary and the R1 line`, async ({ app, page }, testInfo) => {
      test.info().annotations.push({ type: 'fixture-only', description: 'No API supplies ashbyProfileUrl yet.' });
      desktopOnly(testInfo);
      await page.setViewportSize(screen);
      await openBusy(app, page, { email: EMAIL, r1: true, ashbyLink: true });
      await expect(r1Line(page)).toHaveText(R1_LINE);
      const decide = page.getByRole('link', { name: /^Open in Ashby to decide/ });
      await expect(decide).toBeVisible();
      await noOverlap(ratings(page), decide, 'the summary runs into the Ashby action');
      await noOverlap(r1Line(page), decide, 'the R1 line runs into the Ashby action');
      await noOverlap(r1Line(page), page.getByText('The decision is made in Ashby.'), 'the R1 line runs into the sentence beside the action');
      await clearOf(page);
      await noOverlap(r1Line(page), ratings(page), 'the R1 line runs into the summary');
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
    });
  }

  test('the room kept for the R1 line holds the widest line there can be', async ({ app, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBusy(app, page, { r1: true });
    await expect(r1Line(page)).toHaveText(R1_LINE);
    const room = (await edgesOf(r1Line(page))).width;
    await r1Line(page).evaluate((el) => { el.textContent = 'R1 role-play: Borderline 100 (AI)'; });
    expect((await edgesOf(r1Line(page))).width, 'the widest line outgrew its room').toBe(room);
  });

  // Every R1 round in production is unscored today, so this is the common case: once the rounds answer
  // with nothing to print, the header is the one a candidate with no R1 session gets.
  for (const screen of SCREENS) {
    test(`at ${screen.width}x${screen.height} a round with no result gives its room back, and the summary returns to the name row`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize(screen);
      await openBusy(app, page, {});
      await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'row');
      const withoutR1 = await workspaceTop(page);

      const release = await openBeforeTheRounds(app, page, {});
      await expect(r1Line(page)).toBeEmpty();
      app.db.r1.otherRounds[STAR_CANDIDATE_ID] = app.db.r1.otherRounds[STAR_CANDIDATE_ID].map((round) => ({ ...round, recommendation: null, overall: null }));
      release();
      await expect(r1Line(page)).toHaveCount(0);
      await app.settle();

      await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'row');
      expect(await workspaceTop(page), 'the header kept room for a line it has nothing to print in').toBe(withoutR1);
      await expect(items(page)).toHaveCount(6);
      await clearOf(page);
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
    });
  }

  // A status with a detail line wraps the facts, so the room kept for the R1 line can take a line of its own.
  for (const screen of [{ width: 1280, height: 720 }, { width: 1180, height: 720 }]) {
    test(`at ${screen.width}x${screen.height} with a status detail line, nothing moves when the R1 line arrives`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize(screen);
      const release = await openBeforeTheRounds(app, page, { statusDetail: true });
      await expect(page.locator('[data-phone-status-detail]')).toBeVisible();
      await expect(r1Line(page)).toBeEmpty();
      const before = await workspaceTop(page);
      const scrolled = await pageScrolls(page);

      release();
      await expect(r1Line(page)).toHaveText(R1_LINE);
      await app.settle();

      expect(await workspaceTop(page), 'the panes moved').toBe(before);
      expect(await pageScrolls(page), 'the page began to scroll, or stopped').toBe(scrolled);
    });
  }

  for (const options of [{}, { email: EMAIL }, { name: LONG_NAME }, { statusDetail: true }] as BusyReviewOptions[]) {
    test(`a phone keeps the R1 line's room as well, so nothing moves when it arrives: ${JSON.stringify(options)}`, async ({ app, page }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'the phone layout');
      // From the top of the document: the phone's page scrolls.
      const top = () => page.locator('[data-review-workspace]').evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
      const release = await openBeforeTheRounds(app, page, options);
      await expect(r1Line(page)).toBeEmpty();
      const before = await top();
      const room = await edgesOf(r1Line(page));

      release();
      await expect(r1Line(page)).toHaveText(R1_LINE);
      await app.settle();

      expect(await top(), 'the panes moved').toBe(before);
      const line = await edgesOf(r1Line(page));
      expect(line.height, 'the line grew taller than the room kept for it').toBe(room.height);
      expect(line.width, 'the line outgrew the room kept for it').toBe(room.width);
    });
  }

  test('a phone stacks the R1 line among the facts and the summary under the actions', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'the phone layout');
    await openBusy(app, page, { email: EMAIL, r1: true });
    await expect(r1Line(page)).toHaveText(R1_LINE);
    await noOverlap(r1Line(page), ratings(page), 'the R1 line runs into the summary');
    await noOverlap(r1Line(page), exportReport(page), 'the R1 line runs into Export report');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  // Six columns need 1350 wide beside the Provisional words, so a smaller window pays for a second line.
  for (const screen of [{ width: 1280, height: 720 }, { width: 1180, height: 800 }]) {
    test(`at ${screen.width}x${screen.height} the own line wraps to two rows beside Provisional, and the page stays put`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize(screen);
      const plain = await plainTop(app, page, { email: EMAIL });
      await openBusy(app, page, { email: EMAIL });

      await expect(page.locator('[data-ratings-fit]')).toHaveAttribute('data-ratings-fit', 'line');
      expect(await workspaceTop(page)).toBe(plain + TWO_LINE_GROWTH);
      const boxes = await Promise.all((await items(page).all()).map(edgesOf));
      expect(new Set(boxes.map((box) => box.top)).size).toBe(2);
      await clearOf(page);
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
    });
  }

  // What the summary adds comes out of the panes' floor, so the page holds wherever it held without one.
  for (const [width, height, options] of [
    [1180, 720, { name: LONG_NAME }],
    [1180, 720, { email: LONG_EMAIL }],
    [1180, 720, { name: LONG_NAME, email: LONG_EMAIL }],
    // The tightest window with the R1 line among the facts as well.
    [1180, 720, { email: EMAIL, r1: true }],
    [1180, 720, { name: LONG_NAME, email: LONG_EMAIL, r1: true }],
    [1280, 720, { name: LONG_NAME, email: LONG_EMAIL, r1: true }],
    // The API's limit, and the owner's question 6. Six is what a real role has.
    [1440, 900, { metrics: 20 }],
    [1366, 768, { metrics: 20 }],
    [1280, 720, { metrics: 20 }],
    [1180, 720, { metrics: 20, name: LONG_NAME, email: LONG_EMAIL }],
  ] as Array<[number, number, BusyReviewOptions]>) {
    test(`at ${width}x${height} the page does not scroll: ${JSON.stringify(options)}`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize({ width, height });
      const panel = await openBusy(app, page, options);
      await expect(items(page)).toHaveCount(options.metrics ?? 6);
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
      expect(await scrollsOnItsOwn(panel.getByRole('region', { name: 'AI recommendation' }))).toBe(true);
    });
  }

  test('a name cut short keeps its pips and its figure, and says the rest in its title and name', async ({ app, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1366, height: 768 });
    await openBusy(app, page, {});
    const long = page.getByRole('button', { name: 'Work from office fitment, Good, 3 of 4' });
    await expect(long).toHaveAttribute('title', 'Work from office fitment, Good, 3 of 4');
    await expect(long.getByText('3/4')).toBeVisible();
    await expect(long.locator('[data-rating-pips]')).toBeVisible();
    const name = long.getByText('Work from office fitment');
    expect(await name.evaluate((el) => el.scrollWidth > el.clientWidth), 'the name should be cut with an ellipsis').toBe(true);
    const row = await edgesOf(long);
    expect((await edgesOf(long.locator('[data-rating-pips]'))).right).toBeLessThanOrEqual(row.right);
  });

  // Beside the Provisional words the columns change at 1350 wide, and a count of two digits is wider.
  for (const [width, height, options] of [
    [1440, 900, {}],
    [1440, 900, { email: EMAIL }],
    [1440, 900, { name: LONG_NAME }],
    [1349, 768, { email: EMAIL }],
    [1350, 768, { email: EMAIL }],
    [1360, 768, { email: EMAIL }],
    [1366, 768, { email: EMAIL, metrics: 12 }],
    [1440, 900, { email: EMAIL, metrics: 20 }],
  ] as Array<[number, number, BusyReviewOptions]>) {
    test(`the panes do not move when the scorecard arrives at ${width}x${height}: ${JSON.stringify(options)}`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize({ width, height });
      // The read waits for the test, so the page shows what it has before the scorecard.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**/api/screening/${V2_SESSION_ID}`, async (route) => {
        await held;
        await route.fallback();
      });
      busyReview(app.db, options);
      await page.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=phone`);
      await expect(page.locator('[data-review-workspace]')).toBeVisible();
      await expect(page.locator('[data-header-ratings-reserve]')).toHaveCount(1);
      await expect(items(page)).toHaveCount(0);
      const before = await workspaceTop(page);

      release();
      await expect(items(page)).toHaveCount(options.metrics ?? 6);
      await app.settle();
      expect(await workspaceTop(page)).toBe(before);
    });
  }

  for (const options of [{ email: EMAIL, metrics: 20 }, { metrics: 20 }] as BusyReviewOptions[]) {
    test(`the lead's fixed room holds its widest count: ${JSON.stringify(options)}`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openBusy(app, page, options);
      const fits = await page.locator('[data-header-ratings-lead]').evaluate((lead) => {
        lead.lastElementChild!.textContent = '20 of 20 metrics';
        return lead.scrollWidth <= lead.clientWidth;
      });
      expect(fits, 'the count runs out of the room the blank kept for it').toBe(true);
    });
  }

  test('pressing an item opens that row in the pane and moves focus to it, and mints nothing', async ({ app, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openBusy(app, page, { email: EMAIL });
    const pane = panel.getByRole('region', { name: 'AI recommendation' });
    const row = pane.locator('[data-rubric-row="busy-office"]');
    const toggle = row.getByRole('button', { name: 'Work from office fitment', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const box = (await pane.boundingBox())!;
    expect((await row.boundingBox())!.y, 'on this short window the last row starts out of the pane').toBeGreaterThan(box.y + box.height);

    await page.getByRole('button', { name: 'Work from office fitment, Good, 3 of 4' }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    const head = (await row.getByRole('heading', { level: 4 }).boundingBox())!;
    expect(head.y).toBeGreaterThanOrEqual(box.y);
    expect(head.y + head.height).toBeLessThanOrEqual(box.y + box.height);
    expect(app.calls.filter((c) => /\/api\/recordings\/|\/recording/.test(new URL(c.url).pathname))).toEqual([]);
    await expect(panel.locator('[data-tape-status]')).toHaveAttribute('data-tape-status', 'idle');
  });

  test('it is on Phone screening alone, and passes axe there', async ({ app, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBusy(app, page, { r1: true });
    await auditA11y(page, testInfo, 'review-header-ratings', { strict: true });
    await page.getByRole('tab', { name: 'R1 interview' }).click();
    await expect(items(page)).toHaveCount(0);
    await page.getByRole('tab', { name: 'Profile' }).click();
    await expect(items(page)).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Latest screening score' })).toBeVisible();
    await page.getByRole('tab', { name: 'Phone screening' }).click();
    await expect(items(page)).toHaveCount(6);
  });

  test('the old links land where they always did: review on the summary, overview off it', async ({ app, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1440, height: 900 });
    busyReview(app.db, {});
    await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=review`);
    await expect(page.getByRole('tab', { name: 'Phone screening' })).toHaveAttribute('aria-selected', 'true');
    await expect(items(page)).toHaveCount(6);
    await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=overview`);
    await expect(page.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'Latest screening score' })).toBeVisible();
    await expect(items(page)).toHaveCount(0);
  });

  test('a candidate with an R1 interview and no phone screening shows no summary, whatever the tab says', async ({ app, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const tab of ['phone', 'review']) {
      await app.goto(`/candidates/${R1_CANDIDATE_ID}?tab=${tab}`);
      await expect(page.getByRole('tab', { name: 'Phone screening' })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-review-workspace]')).toHaveCount(0);
      await expect(page.locator('[data-ratings-fit]')).toHaveCount(0);
      await expect(ratings(page)).toHaveCount(0);
      await expect(items(page)).toHaveCount(0);
    }
  });

  test('a contrast theme still draws the pips and the dashed mark', async ({ app, page }, testInfo) => {
    desktopOnly(testInfo);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openBusy(app, page, {});
    await page.emulateMedia({ forcedColors: 'active' });
    const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const pip = items(page).first().locator('[data-rating-pips] > .data-fill').first();
    expect(await pip.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(canvas);
    const dashed = page.locator('[data-header-ratings] [data-rating-none]');
    expect(await dashed.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed');
    expect(await dashed.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(canvas);
  });

  test('on a phone it stacks under the header, every target reachable, and the page does not scroll sideways', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'the phone layout');
    await openBusy(app, page, { email: EMAIL });
    const summary = await edgesOf(ratings(page));
    expect(summary.top).toBeGreaterThanOrEqual((await edgesOf(exportReport(page))).bottom);
    expect(summary.right).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(items(page)).toHaveCount(6);
    for (const item of await items(page).all()) {
      expect((await item.boundingBox())!.height, 'a touch screen keeps its 44px target').toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    const toggle = page.locator('[data-rubric-row="busy-office"]').getByRole('button', { name: 'Work from office fitment', exact: true });
    await page.getByRole('button', { name: 'Work from office fitment, Good, 3 of 4' }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await onTop(toggle);
  });

  // Below `lg` the app bar sticks over the top of the page, and `toBeInViewport` cannot see that.
  for (const [width, metric] of [[1023, 'Communication'], [768, 'Communication'], [640, 'Communication'], [639, 'Stability']] as const) {
    test(`at ${width} wide a press leaves ${metric} clear of the app bar, with focus on what can be seen`, async ({ app, page }, testInfo) => {
      desktopOnly(testInfo);
      await page.setViewportSize({ width, height: 900 });
      await openBusy(app, page, { email: EMAIL });
      await items(page).filter({ hasText: metric }).click();
      const toggle = page.locator('[data-rubric-row]').getByRole('button', { name: metric, exact: true });
      await expect(toggle).toBeFocused();
      await onTop(toggle);
    });
  }
});

test.describe('Review, a call past the hour', () => {
  test('a seek chip stays clear of the rating on every row', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    for (const detail of Object.values(app.db.sessionDetails)) {
      detail.transcript = detail.transcript.map((turn) => ({
        ...turn,
        start_offset_sec: (turn.start_offset_sec ?? 0) + 25 * 3600,
      }));
    }
    const panel = await openReview(app, page);
    const chips = panel.locator('[data-seek-chip]');
    await expect(chips.first()).toContainText(/\d+:\d\d:\d\d/);
    for (const chip of await chips.all()) {
      const clear = await chip.evaluate(
        (el) => el.getBoundingClientRect().right <= el.parentElement!.nextElementSibling!.getBoundingClientRect().left,
      );
      expect(clear, 'a chip runs over the rating').toBe(true);
    }
  });
});

test.describe('Review, the Ashby deep link', () => {
  test('its log header is the same one line: no role to print, and the tape names the interviewer', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.goto(`/ashby/review/${SCOPED_REVIEW_LINK_ID}`);
    await app.settle();
    await page.getByRole('tab', { name: 'Review' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Review' });
    const header = panel.locator('[data-log-header]');
    await expect(panel.locator('[data-call-strip]')).toBeVisible();
    expect((await header.boundingBox())!.height).toBe(30);
    await expect(header).not.toContainText('Role');
    await expect(header).not.toContainText('Interviewer');
    await expect(header.getByText('Length', { exact: true })).toBeVisible();
    await expect(header.getByText('In Ashby', { exact: true })).toBeVisible();
    expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
  });

  test('the Review tab is on paper, so its sticky head and labels are no patches on the desk', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await app.goto(`/ashby/review/${SCOPED_REVIEW_LINK_ID}`);
    await app.settle();
    await page.getByRole('tab', { name: 'Review' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Review' });

    const workspace = panel.locator('[data-review-workspace]');
    const ground = await workspace.evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor);
    const head = await panel.getByRole('heading', { name: 'Transcript' }).evaluate((el) => getComputedStyle(el.parentElement!).backgroundColor);
    expect(ground).toBe(head);
    expect(await page.locator('main').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(head);

    // The sheet reaches both edges of the workspace, and adds nothing to the page's height.
    const sheetBox = (await workspace.evaluate((el) => {
      const { left, right } = el.parentElement!.getBoundingClientRect();
      return { left, right };
    }))!;
    const box = (await workspace.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(sheetBox.left);
    expect(box.x + box.width).toBeLessThanOrEqual(sheetBox.right);
    expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
  });

  // The workspace has about 5px to spare over its height floor at 1366x768, so the sentence that says
  // where the R1 interview is cannot stand above it.
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1180, height: 800 }]) {
    test(`at ${viewport.width}x${viewport.height} a candidate with an R1 session keeps the page still too`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      const read = app.db.candidateDetail;
      app.db.candidateDetail = (id) => {
        const detail = read(id);
        if (detail && id === STAR_CANDIDATE_ID) {
          detail.sessions = [...detail.sessions, { ...detail.sessions[0], id: '44444444-4444-4444-8444-444444444444', interview_round_id: R1_ROUND_ID }];
        }
        return detail;
      };
      await app.goto(`/ashby/review/${SCOPED_REVIEW_LINK_ID}`);
      await app.settle();
      await page.getByRole('tab', { name: 'Review' }).click();
      const panel = page.getByRole('tabpanel', { name: 'Review' });
      await expect(panel.locator('[data-review-workspace]')).toBeVisible();
      await expect(page.getByText('The R1 interview for this candidate is on the candidate page, under R1 interview.')).toBeVisible();
      expect(await pageScrolls(page), 'the page itself scrolls').toBe(false);
    });
  }
});

test.describe('Review, the cue', () => {
  test('pressing a tick moves everything before the audio answers, and the row comes into view', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    const transcript = panel.getByRole('region', { name: 'Transcript' });
    const clock = panel.locator('[data-tape-clock]');
    const before = await clock.textContent();
    // The mint never answers, so everything below can only have come from the press itself.
    await holdTheRecording(page);

    const ticks = panel.locator('[data-strip-tick]');
    expect(await ticks.count()).toBeGreaterThanOrEqual(2);
    const tick = (await ticks.first().getAttribute('aria-pressed')) === 'true' ? ticks.last() : ticks.first();
    await tick.click();
    await expect(tick).toHaveAttribute('aria-pressed', 'true');
    await expect(clock).not.toHaveText(before!);

    const row = transcript.locator('[data-turn-row] [aria-current="true"]');
    await expect(row).toHaveCount(1);
    await expect(row).toBeInViewport();
    const pressed = await tick.getAttribute('data-strip-tick');
    await expect(panel.locator(`[data-quote-button="${pressed}"]`)).toHaveAttribute('aria-pressed', 'true');
  });

  test('pressing the cued quote again brings its row back after scrolling away', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    const transcript = panel.getByRole('region', { name: 'Transcript' });
    const row = transcript.locator('[data-turn-row] [aria-current="true"]');
    await expect(row).toHaveCount(1);
    await transcript.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(row).not.toBeInViewport();
    await holdTheRecording(page);
    await panel.locator('[data-strip-tick][aria-pressed="true"]').click();
    await expect(row).toBeInViewport();
  });

  test('entering Review from another tab lands on the cued row', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await app.goto(`/candidates/${STAR_CANDIDATE_ID}?tab=profile`);
    await app.settle();
    await page.getByRole('tab', { name: 'Phone screening' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Phone screening' });
    await expect(panel.locator('[data-turn-row] [aria-current="true"]')).toBeInViewport();
  });

  test('the Ashby deep link says where the candidate stands, and lands on the cued row', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    // A worker session as GET /api/screening/:id sends it: stamps and no offsets. This page lists no
    // calls, so those stamps are all it has to place a turn with.
    const stampFrom = Date.parse('2026-10-05T03:30:00.000Z');
    for (const detail of Object.values(app.db.sessionDetails)) {
      detail.transcript = detail.transcript.map((turn) => ({
        ...turn,
        start_offset_sec: null,
        started_at_ms: stampFrom + (turn.start_offset_sec ?? 0) * 1000,
      }));
    }
    await app.goto(`/ashby/review/${SCOPED_REVIEW_LINK_ID}`);
    await app.settle();
    await page.getByRole('tab', { name: 'Review' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Review' });
    const header = panel.locator('[data-log-header]');
    await expect(header).toContainText('Writing results back to Ashby');
    await expect(header).not.toContainText('Not linked');
    await expect(header).not.toContainText('Role');
    await expect(header).toContainText(/Length\s*≈\d/);
    await expect(panel.locator('[data-call-strip]')).toBeVisible();
    await expect(panel.locator('[data-turn-active]')).toBeInViewport();
    await expect(panel.getByText('no timing data')).toHaveCount(0);

    // The clock is for reading: it says so, and a press plays nothing.
    const chip = panel.locator('[data-seek-chip]').first();
    await expect(chip).toContainText('≈');
    await expect(chip).toHaveAccessibleName(/Go to this turn\.$/);
    await chip.click();
    const mints = app.calls.filter((c) => /\/api\/recordings\//.test(new URL(c.url).pathname));
    expect(mints).toEqual([]);
  });

  test('a recording that will not mint says so on the tape, in view, with Try again', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    await page.route(/\/api\/recordings\/.*\/download/, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { type: 'not_found', message: 'Recording not found' } }) }),
    );
    await panel.getByRole('button', { name: /^Play from/ }).click();
    const failure = panel.locator('[data-tape-status]').getByRole('alert');
    await expect(failure).toHaveText('Recording not found');
    await expect(failure).toBeInViewport();
    await expect(panel.locator('[data-tape-status]').getByRole('button', { name: 'Try again' })).toBeInViewport();
  });

  test('Play leaves the verdict where it is', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const panel = await openReview(app, page);
    const pane = panel.getByRole('region', { name: 'AI recommendation' });
    await panel.getByRole('button', { name: /^Play from/ }).click();
    await expect(panel.locator('[data-tape-status]')).not.toHaveAttribute('data-tape-status', 'idle');
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(pane.locator('[data-verdict-box]')).toBeInViewport();
  });

  test('below 1180px a press in the reasoning pane brings its row into the window', async ({ app, page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const panel = await openReview(app, page);
    const chips = panel.locator('[data-seek-chip]');
    const chip = chips.nth((await chips.count()) - 1);
    await chip.scrollIntoViewIfNeeded();
    await holdTheRecording(page);
    await chip.click();
    await expect(panel.locator('[data-turn-row] [aria-current="true"]')).toBeInViewport();
  });

  test('Review opens cued and mints nothing until a press', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    await expect(panel.getByRole('button', { name: /^Play from/ })).toBeVisible();
    const mints = () => app.calls.filter((c) => /\/api\/recordings\/|\/recording/.test(new URL(c.url).pathname));
    expect(mints()).toEqual([]);
    await panel.getByRole('button', { name: /^Play from/ }).click();
    await expect.poll(() => mints().length).toBeGreaterThan(0);
  });
});

test.describe('Review, a cue keeps the pane clear', () => {
  const row = (panel: Locator, id: string): Locator => panel.locator(`[data-rubric-row="${id}"]`);
  const arrow = (panel: Locator, id: string): Locator => row(panel, id).locator('h4 button');
  const chip = (panel: Locator, id: string): Locator => row(panel, id).locator('[data-seek-chip]');
  const tickOf = async (panel: Locator, id: string): Promise<Locator> => {
    const number = await chip(panel, id).getAttribute('data-seek-chip');
    return panel.locator(`[data-strip-tick="${number}"]`);
  };

  test('a cue closes the row the last cue opened, and never one opened with its arrow', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    await holdTheRecording(page);

    await arrow(panel, 'm-logistics').click();
    await (await tickOf(panel, 'm-communication')).click();
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'true');
    await (await tickOf(panel, 'm-relevance')).click();
    await expect(arrow(panel, 'm-relevance')).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'false');
    await expect(arrow(panel, 'm-logistics')).toHaveAttribute('aria-expanded', 'true');
  });

  test('a pressed chip stays under the pointer when the row above it closes', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    await holdTheRecording(page);
    await (await tickOf(panel, 'm-communication')).click();
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'true');

    // Read down to it, with the row above still open.
    const pressed = chip(panel, 'm-stability');
    await pressed.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect(pressed).toBeInViewport();
    const pane = panel.getByRole('region', { name: 'AI recommendation' });
    const scrolled = (): Promise<number> => pane.evaluate((el) => el.scrollTop);
    const [before, scrolledBefore] = [(await pressed.boundingBox())!, await scrolled()];
    await pressed.click();
    await expect(arrow(panel, 'm-stability')).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'false');
    const after = (await pressed.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    // The chip stayed because the pane moved, not because nothing shifted.
    expect(await scrolled()).toBeLessThan(scrolledBefore - 50);
  });

  test('when the pane cannot absorb the shift the row stays open until the next cue', async ({ app, page }) => {
    // Tall enough that nothing scrolls, so there is no room to give back.
    await page.setViewportSize({ width: 1440, height: 1500 });
    const panel = await openBusy(app, page);
    await holdTheRecording(page);
    await (await tickOf(panel, 'm-communication')).click();
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'true');

    const pressed = chip(panel, 'm-relevance');
    const before = (await pressed.boundingBox())!;
    await pressed.click();
    await expect(arrow(panel, 'm-relevance')).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'true');
    expect(Math.abs((await pressed.boundingBox())!.y - before.y)).toBeLessThan(1);

    await (await tickOf(panel, 'm-stability')).click();
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'false');
    await expect(arrow(panel, 'm-relevance')).toHaveAttribute('aria-expanded', 'false');
  });

  test('below 1180px the page scrolls and the pane does not, so a chip press closes the last cue\'s row', async ({ app, page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    const panel = await openBusy(app, page);
    await holdTheRecording(page);
    await (await tickOf(panel, 'm-communication')).click();
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'true');

    await chip(panel, 'm-stability').click();
    await expect(arrow(panel, 'm-stability')).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'false');

    await chip(panel, 'm-logistics').click();
    await expect(arrow(panel, 'm-logistics')).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow(panel, 'm-stability')).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('[data-rubric-row] h4 button[aria-expanded="true"]')).toHaveCount(1);
  });

  test('pressing the cued chip on arrival leaves it where it is, with its quote opened under it', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    await holdTheRecording(page);
    const pressed = chip(panel, 'm-communication');
    const number = await pressed.getAttribute('data-seek-chip');
    const before = (await pressed.boundingBox())!;
    await pressed.click();

    const quote = panel.locator(`[data-quote-button="${number}"]`);
    await expect(quote).toHaveAttribute('aria-pressed', 'true');
    const [quoteBox, after] = [(await quote.boundingBox())!, (await pressed.boundingBox())!];
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    expect(quoteBox.y, 'the quote is not under its chip').toBeGreaterThan(after.y + after.height);
  });

  // The fourth row stands at the foot of the pane on arrival, so its quote opens below the fold. Bringing
  // that quote up would put another one under the pointer, and a double-click would cue it. The same holds
  // when the press also closes a row above it, and the pane scrolls by what that row gave back.
  for (const { id, closesAbove } of [
    { id: 'm-objections', closesAbove: false },
    { id: 'm-stability', closesAbove: true },
  ]) {
    test(`a chip at the foot of the pane stays under the pointer, and a second press cues the same quote: ${id}`, async ({ app, page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const panel = await openBusy(app, page);
      await holdTheRecording(page);
      if (closesAbove) {
        await (await tickOf(panel, 'm-communication')).click();
        await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'true');
      }
      const pane = panel.getByRole('region', { name: 'AI recommendation' });
      const pressed = chip(panel, id);
      // Its foot 20px above the pane's.
      await pressed.evaluate((el) => {
        const scroller = el.closest<HTMLElement>('[data-review-pane="reasoning"]')!;
        scroller.scrollTop += el.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 20;
      });
      const paneBox = (await pane.boundingBox())!;
      const before = (await pressed.boundingBox())!;
      expect(before.y + before.height, 'the chip is not at the foot of the pane').toBeGreaterThan(paneBox.y + paneBox.height - 60);
      const number = await pressed.getAttribute('data-seek-chip');
      const [x, y] = [before.x + before.width / 2, before.y + before.height / 2];

      await page.mouse.click(x, y);
      await expect(arrow(panel, id)).toHaveAttribute('aria-expanded', 'true');
      if (closesAbove) await expect(arrow(panel, 'm-communication')).toHaveAttribute('aria-expanded', 'false');
      expect(Math.abs((await pressed.boundingBox())!.y - before.y)).toBeLessThan(1);

      await page.mouse.click(x, y);
      await expect(panel.locator(`[data-strip-tick="${number}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(pressed).toHaveAttribute('aria-pressed', 'true');
      expect(Math.abs((await pressed.boundingBox())!.y - before.y)).toBeLessThan(1);
    });
  }

  test('sections stand 16px apart, so spacing groups them', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    for (const name of ['Check before deciding', 'Rubric']) {
      const section = panel.getByRole('heading', { name, exact: true }).locator('xpath=ancestor::div[2]');
      expect(await section.evaluate((el) => getComputedStyle(el).marginTop), name).toBe('16px');
    }
  });

  test('a quote is a ruled line and the pressed one a box, and neither moves when pressed', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    await holdTheRecording(page);
    await panel.locator('[data-strip-tick][aria-pressed="true"]').click();
    const quotes = panel.locator('[data-rubric-row="m-communication"] [data-quote-button]');
    await expect(quotes).toHaveCount(3);
    const edges = (quote: Locator) =>
      quote.evaluate((el) => {
        const style = getComputedStyle(el);
        return { top: style.borderTopColor, bottom: style.borderBottomColor };
      });
    const pressed = panel.locator('[data-rubric-row="m-communication"] [data-quote-button][aria-pressed="true"]');
    const rest = panel.locator('[data-rubric-row="m-communication"] [data-quote-button][aria-pressed="false"]').first();
    const clear = 'rgba(0, 0, 0, 0)';
    expect((await edges(rest)).top).toBe(clear);
    expect((await edges(rest)).bottom).not.toBe(clear);
    expect((await edges(pressed)).top).toBe((await edges(pressed)).bottom);
    expect((await edges(pressed)).top).not.toBe(clear);

    const before = (await rest.boundingBox())!;
    const number = await rest.getAttribute('data-quote-button');
    await rest.click();
    const after = (await panel.locator(`[data-quote-button="${number}"]`).boundingBox())!;
    expect({ x: after.x, width: after.width, height: after.height }).toEqual({ x: before.x, width: before.width, height: before.height });
  });

  test('a cited turn prints one Cited label for each metric, every number still its own button', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    const turn = panel.locator('[data-turn-row]', { has: page.getByRole('button', { name: /^Evidence 1, / }) });
    await expect(turn.getByText('Cited · Profile relevance')).toHaveCount(1);
    await expect(turn.getByRole('button', { name: /^Evidence \d+, Profile relevance$/ })).toHaveCount(2);
  });

  test('the one-cue path holds: the press lands the turn, the tick and the quote together', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openBusy(app, page);
    await holdTheRecording(page);
    const tick = await tickOf(panel, 'm-relevance');
    const number = await tick.getAttribute('data-strip-tick');
    await tick.click();
    await expect(tick).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator(`[data-quote-button="${number}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator(`[data-quote-button="${number}"]`)).toBeInViewport();
    await expect(panel.locator('[data-turn-row] [aria-current="true"]')).toBeInViewport();
  });
});

test.describe('Review, the wording Legal approved', () => {
  test('the consent line opens to the full gate', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    const transcript = panel.getByRole('region', { name: 'Transcript' });
    const line = transcript.locator('[data-consent-line]');
    await expect(line).toContainText(/Consent given at \d\d:\d\d/);
    await line.getByRole('button', { name: /^Show \d+ turns$/ }).click();
    await expect(transcript.getByText('Do you consent to this call being recorded and assessed?')).toBeVisible();
    await expect(transcript.getByText('Yes, I consent.')).toBeVisible();
  });

  test('the what-if line is one line of text, and only on a provisional score', async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openReview(app, page);
    await expect(panel.locator('[data-what-if]')).toHaveText(
      /^Once .+ (is|are) scored it would read \d+ to \d+; at \w+, \d+ \((Select|Borderline|Reject)\)$/,
    );
  });

  // FIXTURE ONLY, not evidence the feature works: no API supplies `ashbyProfileUrl` yet, so production
  // never shows this link or the sentence beside it. e2e/fixtures/data.ts adds the field by hand. Whether
  // the workflow projection may carry a link is the owner's decision (see types.ts).
  test('fixture only: given a link, the decision goes to Ashby as the one filled action', async ({ app, page }) => {
    test.info().annotations.push({ type: 'fixture-only', description: 'No API supplies ashbyProfileUrl yet.' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReview(app, page);
    const decide = page.getByRole('link', { name: /^Open in Ashby to decide/ });
    await expect(decide).toHaveAttribute('href', /^https:\/\/app\.ashbyhq\.com\//);
    await expect(decide).toHaveAttribute('target', '_blank');
    await expect(page.getByText('The decision is made in Ashby.')).toBeVisible();
  });
});
