/**
 * Key interaction states, shared by the check suite and the screenshot run.
 *
 * Each flow drives the page into a state a static URL cannot reach (a dialog
 * open, a tab selected, a drawer scrolled) and returns the locator the state
 * is "about", so the caller can assert on it, audit it and photograph it.
 * Selectors are roles and accessible names only — the redesign may restyle
 * every element, but a dialog must stay a dialog with its title.
 */

import type { Locator, Page } from '@playwright/test';
import { expect, type AppHarness } from './harness';
import { STAR_CANDIDATE_ID } from './data';
import type { RouteCase } from './routes';

/** The route's `<h1>`; a string heading is matched exactly (no "Ashby Mission Control" for "Mission Control"). */
export function routeHeading(page: Page, route: RouteCase): Locator {
  return typeof route.heading === 'string'
    ? page.getByRole('heading', { level: 1, name: route.heading, exact: true })
    : page.getByRole('heading', { level: 1, name: route.heading });
}

/**
 * Open a catalogued route and wait until it is genuinely ready: redirects
 * followed, `<h1>` shown, data-dependent landmark shown, then settled.
 *
 * "Network idle and no spinner" alone is not enough — at `/` there is a
 * moment between the auth gate resolving and the redirect to /dashboard when
 * nothing is loading and nothing is rendered either.
 *
 * `tolerateKnownIssue` (the screenshot run) photographs a route with a known
 * app defect as-is instead of waiting for content that will never come.
 */
export async function openRoute(app: AppHarness, route: RouteCase, { tolerateKnownIssue = false } = {}): Promise<void> {
  await app.goto(route.path);
  if (tolerateKnownIssue && route.knownIssue) return;
  if (route.finalPath) await expect(app.page).toHaveURL(route.finalPath);
  await expect(routeHeading(app.page, route)).toBeVisible();
  await expect(app.page.getByText(route.landmark).first()).toBeVisible();
  await app.settle();
}

/**
 * Bring the Scorebar's "Add a metric" form into view and return it.
 *
 * The form has been both always-open at the foot of the list and a
 * disclosure behind "New metric"; open the disclosure only when the heading
 * is not already on the page, so the flow reaches the same state either way.
 * Returns the drawer, scrolled so the form's heading is in view.
 */
export async function revealAddMetric(drawer: Locator): Promise<Locator> {
  const heading = drawer.getByRole('heading', { name: 'Add a metric' });
  if ((await heading.count()) === 0) {
    await drawer.getByRole('button', { name: 'New metric' }).click();
  }
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toBeInViewport();
  return drawer;
}

/**
 * Open Ashby Mission Control's "Add mapping" dialog and its job picker.
 * Returns the dialog and the open option list.
 */
async function openAshbyJobPicker(app: AppHarness): Promise<{ dialog: Locator; listbox: Locator }> {
  await app.goto('/ashby-mission-control');
  await app.page.getByRole('button', { name: 'Add mapping', exact: true }).click();
  const dialog = app.page.getByRole('dialog', { name: 'Add job mapping' });
  await expect(dialog).toBeVisible();
  await app.settle();
  // Open the job picker: ~40 live jobs, open ones offered, mapped ones
  // listed but disabled, same-titled ones told apart. Found by its LABEL
  // so the flow survives the picker changing widget (select → combobox).
  await dialog.getByLabel('Ashby job').first().click();
  const listbox = app.page.getByRole('listbox').first();
  await expect(listbox).toBeVisible();
  return { dialog, listbox };
}

/** A search no fixture job can match (see `ashby-add-mapping-job-picker-no-match`). */
const NO_MATCH_QUERY = 'zqxj no such job';

export interface KeyState {
  name: string;
  /** Viewport shots suit overlays; full-page suits in-page state. */
  fullPage: boolean;
  /** Mobile-only states (e.g. the navigation drawer). */
  mobileOnly?: boolean;
  run(app: AppHarness): Promise<Locator>;
}

/**
 * Every key state is audited STRICTLY by app.e2e.ts: a serious or critical
 * axe violation fails the test (routes stay report-only unless
 * E2E_AXE_STRICT=1). These are the surfaces the redesign rebuilt, so a new
 * violation here is a regression, not inherited debt.
 */
export const KEY_STATES: KeyState[] = [
  {
    name: 'ashby-add-mapping-dialog',
    fullPage: false,
    async run(app) {
      await app.goto('/ashby-mission-control');
      await app.page.getByRole('button', { name: 'Add mapping', exact: true }).click();
      const dialog = app.page.getByRole('dialog', { name: 'Add job mapping' });
      await expect(dialog).toBeVisible();
      // The dialog re-reads jobs and roles on open.
      await app.settle();
      return dialog;
    },
  },
  {
    name: 'ashby-add-mapping-job-picker',
    fullPage: false,
    async run(app) {
      const { listbox } = await openAshbyJobPicker(app);
      return listbox;
    },
  },
  {
    // The picker's empty result: the list owns no options and a message says
    // so. Where that message lives is exactly what axe checks here — a bare
    // paragraph INSIDE the listbox is a critical `aria-required-children`.
    name: 'ashby-add-mapping-job-picker-no-match',
    fullPage: false,
    async run(app) {
      const { dialog } = await openAshbyJobPicker(app);
      const search = dialog.getByRole('combobox', { name: /search/i });
      await search.fill(NO_MATCH_QUERY);
      await expect(search).toHaveValue(NO_MATCH_QUERY);
      await expect(dialog.getByRole('option')).toHaveCount(0);
      // The no-match message echoes the query. The input's value is not text
      // content, and the debounced screen-reader copy in the picker's
      // `role="status"` region is excluded, so this is the visible message.
      const message = dialog.getByText(NO_MATCH_QUERY).and(app.page.locator(':not([role="status"])'));
      await expect(message).toBeVisible();
      return message;
    },
  },
  {
    name: 'roles-scorebar-add-metric',
    fullPage: false,
    async run(app) {
      await app.goto('/roles');
      await app.page.getByRole('button', { name: 'Scorebar', exact: true }).click();
      const drawer = app.page.getByRole('dialog', { name: 'Scorebar' });
      await expect(drawer).toBeVisible();
      await app.settle();
      return revealAddMetric(drawer);
    },
  },
  {
    name: 'roles-scorebar-top',
    fullPage: false,
    async run(app) {
      await app.goto('/roles');
      await app.page.getByRole('button', { name: 'Scorebar', exact: true }).click();
      const drawer = app.page.getByRole('dialog', { name: 'Scorebar' });
      await expect(drawer).toBeVisible();
      await app.settle();
      return drawer;
    },
  },
  {
    name: 'candidate-review-tab',
    fullPage: true,
    async run(app) {
      await app.goto(`/candidates/${STAR_CANDIDATE_ID}`);
      await app.page.getByRole('tab', { name: 'Review' }).click();
      await app.settle();
      const panel = app.page.getByRole('tabpanel', { name: 'Review' });
      await expect(panel).toBeVisible();
      return panel;
    },
  },
  {
    name: 'mission-control-tab-switch',
    fullPage: true,
    async run(app) {
      await app.goto('/mission-control');
      await app.page.getByRole('tab', { name: 'Funnel' }).click();
      await app.settle();
      await expect(app.page).toHaveURL(/#funnel$/);
      const panel = app.page.getByRole('tabpanel', { name: 'Funnel' });
      await expect(panel).toBeVisible();
      return panel;
    },
  },
  {
    name: 'mobile-navigation-drawer',
    fullPage: false,
    mobileOnly: true,
    async run(app) {
      await app.goto('/dashboard');
      await app.page.getByRole('button', { name: 'Open navigation menu' }).click();
      const nav = app.page.getByRole('navigation', { name: 'Main navigation' });
      await expect(nav).toBeInViewport();
      return nav;
    },
  },
];
