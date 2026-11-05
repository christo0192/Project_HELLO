/**
 * Logsheet rendering checks that jsdom cannot make: real layout boxes, focus
 * rings and forced colours. The defects below were invisible to the unit suite
 * and to the screenshot run, because Playwright hides scrollbars, captures with
 * the default colour scheme and never presses Tab.
 *
 * Selectors are roles and accessible names where the element has one, as in
 * fixtures/flows.ts; a pressed chip and a bar segment use their data hooks.
 */

import type { Locator, Page } from '@playwright/test';
import { SEEK_CANDIDATE_ID, SEEK_NORMAL_SESSION_ID } from './fixtures/data';
import { KEY_STATES, openRoute } from './fixtures/flows';
import { expect, test } from './fixtures/harness';
import { ROUTES } from './fixtures/routes';

const routeNamed = (name: string) => {
  const route = ROUTES.find((candidate) => candidate.name === name);
  if (!route) throw new Error(`no route called ${name}`);
  return route;
};

type Rgb = [number, number, number];

const parseRgb = (value: string): Rgb => {
  const hit = /rgba?\((\d+), (\d+), (\d+)/.exec(value);
  if (!hit) throw new Error(`not an rgb colour: ${value}`);
  return [Number(hit[1]), Number(hit[2]), Number(hit[3])];
};

const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb
    .map((channel) => channel / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(parseRgb(a)), luminance(parseRgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The page's `Canvas`: the body is the one fill forcing always replaces. */
const canvasOf = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

const fillOf = (subject: Locator): Promise<string> =>
  subject.evaluate((el) => getComputedStyle(el).backgroundColor);

/** A token's colour with nothing forcing it, as a canvas draws it. */
const tokenColour = (page: Page, name: string): Promise<string> =>
  page.evaluate((token) => {
    const probe = document.createElement('span');
    probe.style.forcedColorAdjust = 'none';
    probe.style.color = `var(${token})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);

interface Ink {
  ink: string;
  ground: string;
  adjust: string;
}

/**
 * Every piece of text inside `subject`, with the fill it actually sits on: the
 * nearest painted ground, so a boxed child inside a selection is measured against
 * its own box. Icons count too.
 */
function inks(subject: Locator): Promise<Ink[]> {
  return subject.evaluate((el) => {
    const painted = (node: Element): string => {
      for (let at: Element | null = node; at; at = at.parentElement) {
        const fill = getComputedStyle(at).backgroundColor;
        if (!/, 0\)$/.test(fill) && fill !== 'transparent') return fill;
      }
      return 'rgb(255, 255, 255)';
    };
    return [el, ...Array.from(el.querySelectorAll('*'))]
      .filter(
        (node) =>
          node.tagName.toLowerCase() === 'svg' ||
          Array.from(node.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim()),
      )
      .map((node) => ({
        ink: getComputedStyle(node).color,
        ground: painted(node),
        adjust: getComputedStyle(node).forcedColorAdjust,
      }));
  });
}

/**
 * Text is readable on its fill, and no backplate gets in the way. Forced text is
 * painted on a `Canvas` backplate that computed style does not report, so a
 * selection that passes on colours alone can still print white on a white box:
 * only `forced-color-adjust` says the backplate is gone. An icon keeps the UA's
 * `preserve-parent-color`, and icons have no backplate.
 */
function expectReadable(pairs: Ink[]): void {
  expect(pairs.length).toBeGreaterThan(0);
  for (const { ink, ground, adjust } of pairs) {
    expect(ratio(ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    expect(adjust, 'a backplate would sit behind this text').not.toBe('auto');
  }
}

test.describe('tab rows', () => {
  for (const name of ['candidate-detail', 'mission-control', 'ashby-scoped-review']) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
      test(`${name} at ${viewport.width}: the row has no height to scroll`, async ({ app, page }) => {
        await page.setViewportSize(viewport);
        await openRoute(app, routeNamed(name));
        const rows = page.getByRole('tablist');
        expect(await rows.count()).toBeGreaterThan(0);
        for (const row of await rows.all()) {
          // A row 1px taller than its box reserves a classic Windows scrollbar.
          const box = await row.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
          expect(box.scroll, 'scrollHeight against clientHeight').toBeLessThanOrEqual(box.client);
        }
      });
    }
  }
});

test.describe('focus', () => {
  test('every nav link keeps its whole ring inside the scrolling nav', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openRoute(app, routeNamed('dashboard'));
    const links = await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').all();
    expect(links.length).toBeGreaterThan(0);
    await page.keyboard.press('Tab'); // the skip link
    for (const link of links) {
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      const room = await link.evaluate((el) => {
        // The nav is the scroller, so it clips at its own box. It has no border.
        const clip = el.closest('nav')!.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const spreads = [...getComputedStyle(el).boxShadow.matchAll(/(\d+)px(?:,|$)/g)].map((m) => Number(m[1]));
        const reach = Math.max(...spreads);
        return {
          reach,
          left: box.left - reach - clip.left,
          right: clip.right - box.right - reach,
          top: box.top - reach - clip.top,
          bottom: clip.bottom - box.bottom - reach,
        };
      });
      expect(room.reach, 'the ring').toBeGreaterThanOrEqual(2);
      for (const side of ['left', 'right', 'top', 'bottom'] as const) {
        expect(room[side], `room on the ${side}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('a selected filter chip shows a ring against its own ink fill', async ({ app, page }) => {
    await openRoute(app, routeNamed('candidates-filtered'));
    const chip = page.getByLabel('Filter by status').locator('[aria-pressed="true"]').first();
    await chip.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(chip).toBeFocused();
    const { fill, shadow } = await chip.evaluate((el) => ({
      fill: getComputedStyle(el).backgroundColor,
      shadow: getComputedStyle(el).boxShadow,
    }));
    const rings = [...shadow.matchAll(/(rgba?\([^)]*\)) 0px 0px 0px (\d+)px/g)]
      .filter((ring) => Number(ring[2]) > 0)
      .map((ring) => ring[1]);
    expect(rings.length, shadow).toBeGreaterThan(0);
    expect(Math.max(...rings.map((ring) => ratio(ring, fill))), shadow).toBeGreaterThanOrEqual(3);
  });
});

test.describe('forced colours', () => {
  test('a selected phone chip keeps its words readable', async ({ app, page }) => {
    await KEY_STATES.find((state) => state.name === 'phone-calendar-appointment-detail')!.run(app);
    await page.emulateMedia({ forcedColors: 'active' });
    const chip = page.locator('[data-appointment-id][aria-pressed="true"]').first();
    await expect(chip).toBeVisible();
    expectReadable(await inks(chip));
  });

  test('the active nav item keeps its label and its icon readable', async ({ app, page }) => {
    await openRoute(app, routeNamed('dashboard'));
    await page.emulateMedia({ forcedColors: 'active' });
    const item = page.getByRole('navigation', { name: 'Main navigation' }).locator('[aria-current="page"]');
    expectReadable(await inks(item));
  });

  test('a filled button keeps an edge, and a data fill stays drawn', async ({ app, page }) => {
    await openRoute(app, routeNamed('candidates'));
    await page.emulateMedia({ forcedColors: 'active' });
    const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const primary = page.getByRole('button', { name: 'Upload resume' }).first();
    const edge = await primary.evaluate((el) => {
      const style = getComputedStyle(el);
      return { width: style.borderTopWidth, colour: style.borderTopColor };
    });
    expect(edge.width).toBe('1px');
    expect(ratio(edge.colour, canvas), `${edge.colour} on ${canvas}`).toBeGreaterThanOrEqual(3);

    const fill = await page
      .locator('[data-pipeline-segment]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).not.toBe('rgba(0, 0, 0, 0)');
    expect(ratio(fill, canvas), `${fill} on ${canvas}`).toBeGreaterThanOrEqual(3);
  });

  test('the option the arrow keys are on keeps a mark when its shadow goes', async ({ app, page }) => {
    const listbox = await KEY_STATES.find((state) => state.name === 'ashby-add-mapping-job-picker')!.run(app);
    await page.keyboard.press('ArrowDown');
    await page.emulateMedia({ forcedColors: 'active' });
    const option = listbox.locator('[role="option"][data-active="true"]');
    await expect(option).toHaveCount(1);
    const cue = await option.evaluate((el) => {
      const style = getComputedStyle(el);
      return { width: style.outlineWidth, line: style.outlineStyle, colour: style.outlineColor };
    });
    expect(cue.line).toBe('solid');
    expect(cue.width).toBe('2px');
    const canvas = await canvasOf(page);
    expect(ratio(cue.colour, canvas), `${cue.colour} on ${canvas}`).toBeGreaterThanOrEqual(3);
  });

  test('the transcript turn being played reads as a selection, its dot still drawn', async ({ app, page }) => {
    await app.goto(`/candidates/${SEEK_CANDIDATE_ID}`);
    await page.getByRole('tab', { name: 'Review' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Review' });
    await panel.getByRole('combobox').selectOption(SEEK_NORMAL_SESSION_ID);
    const turn = panel.getByRole('group', { name: 'Call 1 of 2 · first call' }).getByRole('button', { name: /Turn 2:/ });
    await turn.click();
    await expect(turn).toHaveAttribute('aria-current', 'true');
    await page.emulateMedia({ forcedColors: 'active' });
    expectReadable(await inks(turn));
    const [canvas, fill] = [await canvasOf(page), await fillOf(turn)];
    expect(ratio(fill, canvas), `${fill} on ${canvas}`).toBeGreaterThanOrEqual(3);
    const dot = await fillOf(turn.locator('[data-active-turn-marker]'));
    expect(ratio(dot, fill), `${dot} on ${fill}`).toBeGreaterThanOrEqual(3);
  });

  test('in a dark theme a chart, its legend key and the logo keep their own ground', async ({ app, page }) => {
    await openRoute(app, routeNamed('dashboard'));
    await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active' });
    const canvas = await canvasOf(page);
    expect(ratio(canvas, 'rgb(0, 0, 0)'), `${canvas} is not a dark theme`).toBeLessThan(1.5);
    const ink = await tokenColour(page, '--ink');
    for (const drawn of [page.locator('.chart-paper').first(), page.locator('[data-series-key]').first()]) {
      await expect(drawn).toBeVisible();
      const ground = await fillOf(drawn);
      expect(ratio(ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(await fillOf(page.locator('.bg-plate').first())).toBe('rgb(255, 255, 255)');
  });
});
