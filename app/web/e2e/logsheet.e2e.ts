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
import { SEEK_CANDIDATE_ID } from './fixtures/data';
import { KEY_STATES, openRoute, pickSession } from './fixtures/flows';
import { expect, test, type AppHarness } from './fixtures/harness';
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

/** Keyboard focus: `.focus()` alone is not `:focus-visible` after a pointer click. */
async function tabTo(page: Page, subject: Locator): Promise<void> {
  await subject.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(subject).toBeFocused();
}

/** How many pixels of a screenshot of `subject` are exactly `colour`. */
async function pixelsOf(page: Page, subject: Locator, colour: string): Promise<number> {
  const png = (await subject.screenshot()).toString('base64');
  return page.evaluate(
    async ({ data, rgb }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        if (pixels[at] === rgb[0] && pixels[at + 1] === rgb[1] && pixels[at + 2] === rgb[2]) count += 1;
      }
      return count;
    },
    { data: png, rgb: parseRgb(colour) },
  );
}

/** Open the Review tab and start a transcript turn, which marks it `aria-current`. */
async function playTurn(app: AppHarness, page: Page): Promise<Locator> {
  await app.goto(`/candidates/${SEEK_CANDIDATE_ID}`);
  await page.getByRole('tab', { name: 'Review' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Review' });
  await pickSession(panel, /Recorded 2m 0s/);
  const turn = panel.getByRole('group', { name: 'Call 1 of 2 · first call' }).getByRole('button', { name: /Turn 2:/ });
  await turn.click();
  await expect(turn).toHaveAttribute('aria-current', 'true');
  return turn;
}

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1366, height: 768 }];

test.describe('the sheet at both desk sizes', () => {
  for (const viewport of VIEWPORTS) {
    test(`at ${viewport.width} the Candidates table fits its panel, with no sideways scroll`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      await openRoute(app, routeNamed('candidates'));
      const box = await page.getByRole('table').evaluate((table) => {
        const scroller = table.parentElement!;
        return { table: table.scrollWidth, panel: scroller.clientWidth, scrolled: scroller.scrollWidth };
      });
      expect(box.table, 'the table against its panel').toBeLessThanOrEqual(box.panel);
      expect(box.scrolled).toBeLessThanOrEqual(box.panel);
    });

    test(`at ${viewport.width} no page scrolls sideways`, async ({ app, page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(viewport);
      for (const name of [
        'candidates',
        'roles',
        'phone-calendar',
        'mission-control',
        'mission-control-sessions',
        'mission-control-access',
        'mission-control-audit',
        'ashby-mission-control',
        'session-v2',
      ]) {
        await openRoute(app, routeNamed(name));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, name).toBeLessThanOrEqual(0);
      }
    });
  }

  test('at 1366 Mission Control Sessions shows every column inside its own column', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openRoute(app, routeNamed('mission-control-sessions'));
    const box = await page.getByRole('table').evaluate((table) => ({
      table: table.scrollWidth,
      panel: table.parentElement!.clientWidth,
    }));
    expect(box.table).toBeLessThanOrEqual(box.panel);
  });

  test('a toolbar picker floats, so opening it moves nothing', async ({ app, page }) => {
    await openRoute(app, routeNamed('candidates'));
    const table = page.getByRole('table');
    const before = (await table.boundingBox())!;
    await page.getByRole('button', { name: /^Filter by role/ }).click();
    await expect(page.getByRole('listbox').first()).toBeVisible();
    expect((await table.boundingBox())!.y).toBe(before.y);
  });

  test('the first Candidates row is on the first screen at 1366x768', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openRoute(app, routeNamed('candidates'));
    await expect(page.getByRole('table').getByRole('row').nth(1)).toBeInViewport();
  });

  test('a page number survives a trip to a candidate and back', async ({ app, page }) => {
    await openRoute(app, routeNamed('candidates'));
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page).toHaveURL(/page=2/);
    await page.getByRole('table').getByRole('link').first().click();
    await page.getByRole('link', { name: /Back to candidates/ }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByRole('navigation', { name: 'candidates pagination' })).toContainText(/11–20/);
  });

  test('a verdict is a circle and a word, in ink, with no hue', async ({ app, page }) => {
    await openRoute(app, routeNamed('candidates'));
    const mark = page.locator('tbody [data-verdict-mark]').first();
    await expect(mark).toBeVisible();
    const [ink, stroke] = await Promise.all([
      tokenColour(page, '--ink'),
      mark.evaluate((el) => getComputedStyle(el.querySelector('circle')!).stroke),
    ]);
    expect(stroke).toBe(ink);
  });
});

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
  // The short window scrolls the nav, and focus scrolling sets a link's box against
  // the edge. Each direction meets the other edge, so the walk goes down and back.
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1100, height: 380 }]) {
    test(`at ${viewport.width}x${viewport.height} every nav link keeps its whole ring inside the nav`, async ({ app, page }) => {
      await page.setViewportSize(viewport);
      await openRoute(app, routeNamed('dashboard'));
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      const links = await nav.getByRole('link').all();
      expect(links.length).toBeGreaterThan(0);
      if (viewport.height < 400) {
        expect(await nav.evaluate((el) => el.scrollHeight > el.clientHeight), 'the nav scrolls here').toBe(true);
      }
      await page.keyboard.press('Tab'); // the skip link
      const walks = [
        { key: 'Tab', stops: links },
        { key: 'Shift+Tab', stops: [...links].reverse().slice(1) },
      ];
      for (const { key, stops } of walks) {
        for (const link of stops) {
          await page.keyboard.press(key);
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
            expect(room[side], `${key}: room on the ${side}`).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  }

  test('a selected filter chip shows a ring against its own ink fill', async ({ app, page }) => {
    await openRoute(app, routeNamed('candidates-filtered'));
    const chip = page.getByLabel('Filter by status').locator('[aria-pressed="true"]').first();
    await tabTo(page, chip);
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
    await openRoute(app, routeNamed('mission-control'));
    await page.emulateMedia({ forcedColors: 'active' });
    const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const primary = page.getByRole('button', { name: 'Halt all calling' }).first();
    const edge = await primary.evaluate((el) => {
      const style = getComputedStyle(el);
      return { width: style.borderTopWidth, colour: style.borderTopColor };
    });
    expect(edge.width).toBe('1px');
    expect(ratio(edge.colour, canvas), `${edge.colour} on ${canvas}`).toBeGreaterThanOrEqual(3);

    await openRoute(app, routeNamed('candidates'));
    await page.emulateMedia({ forcedColors: 'active' });
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
    const turn = await playTurn(app, page);
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

  test('in a dark theme the completion ring keeps its arc', async ({ app, page }) => {
    await openRoute(app, routeNamed('dashboard'));
    await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'active' });
    const ring = page.getByText(/% complete/).locator('svg');
    await expect(ring).toBeVisible();
    const arc = await ring.locator('circle').last().evaluate((el) => getComputedStyle(el).stroke);
    const ground = await fillOf(ring);
    expect(ratio(arc, ground), `${arc} on ${ground}`).toBeGreaterThanOrEqual(3);
  });

  /**
   * `forced-color-adjust: none` on a selection stops the browser forcing its focus
   * outline too, so computed style alone can pass a line nobody sees: the pixels
   * have to change as well.
   */
  const SELECTIONS: { name: string; open: (app: AppHarness, page: Page) => Promise<Locator> }[] = [
    {
      name: 'a selected tab',
      open: async (app, page) => {
        await openRoute(app, routeNamed('mission-control'));
        return page.getByRole('tab', { selected: true }).first();
      },
    },
    {
      name: 'a pressed segment',
      open: async (app, page) => {
        await openRoute(app, routeNamed('roles'));
        return page.getByRole('group', { name: 'Filter agents by status' }).locator('[aria-pressed="true"]');
      },
    },
    {
      name: 'the current nav item',
      open: async (app, page) => {
        await openRoute(app, routeNamed('dashboard'));
        return page.getByRole('navigation', { name: 'Main navigation' }).locator('[aria-current="page"]');
      },
    },
    { name: 'the transcript turn being played', open: playTurn },
  ];

  for (const colorScheme of ['light', 'dark'] as const) {
    for (const { name, open } of SELECTIONS) {
      test(`in a ${colorScheme} theme, keyboard focus shows on ${name}`, async ({ app, page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const subject = await open(app, page);
        await page.emulateMedia({ colorScheme, forcedColors: 'active' });
        await tabTo(page, subject);

        const cue = await subject.evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            line: style.outlineStyle,
            width: parseFloat(style.outlineWidth),
            offset: parseFloat(style.outlineOffset),
            colour: style.outlineColor,
            fill: style.backgroundColor,
          };
        });
        expect(cue.line).toBe('solid');
        expect(cue.width).toBeGreaterThanOrEqual(2);
        expect(cue.colour, 'a transparent outline').not.toBe('rgba(0, 0, 0, 0)');
        // Drawn on the fill: the rows these sit in scroll, and would clip it outside.
        expect(cue.offset, 'the outline is inset').toBeLessThanOrEqual(-cue.width);
        expect(ratio(cue.colour, cue.fill), `${cue.colour} on ${cue.fill}`).toBeGreaterThanOrEqual(3);
        expectReadable(await inks(subject));
        // The outline ends 4px in, so anything closer than that runs under it.
        const room = await subject.evaluate((el) => {
          const contents = document.createRange();
          contents.selectNodeContents(el);
          const [edge, words] = [el.getBoundingClientRect(), contents.getBoundingClientRect()];
          return Math.min(words.left - edge.left, edge.right - words.right, words.top - edge.top, edge.bottom - words.bottom);
        });
        expect(room, 'room between the edge and the words').toBeGreaterThanOrEqual(4);

        const box = (await subject.boundingBox())!;
        const focused = await pixelsOf(page, subject, cue.colour);
        await subject.evaluate((el) => (el as HTMLElement).blur());
        const resting = await pixelsOf(page, subject, cue.colour);
        expect(focused - resting, 'pixels the outline adds').toBeGreaterThan(box.width + box.height);
      });
    }
  }
});
