/**
 * The R1 queue in a real browser: the sidebar item, the rows, the views and the pages, at both widths.
 * What each view holds is pinned against the API's own rules in r1-queue-route.test.ts; the router here
 * applies the same rules so the wiring can be seen end to end.
 *
 * The screenshot is the look at 1440x900 and at a phone's width.
 */
import path from 'node:path';
import { ARTIFACTS_DIR, auditA11y } from './fixtures/axe';
import { R1_CANDIDATE_ID, R1_ROUND_ID } from './fixtures/data';
import { expect, test, type AppHarness } from './fixtures/harness';
import { horizontalOverflow } from './fixtures/layout';

const queueReads = (app: AppHarness) => app.calls.filter((c) => /\/api\/interview-rounds(\?|$)/.test(c.url));

async function noSideways(app: AppHarness) {
  expect(await horizontalOverflow(app.page), 'the page must not scroll sideways').toEqual({ overflowPx: 0, offenders: [] });
}

async function openMenu(app: AppHarness, project: string) {
  if (project === 'mobile') await app.page.getByRole('button', { name: 'Open navigation menu' }).click();
}

test.describe('the sidebar', () => {
  test('offers R1 interviews between Candidates and Agents, and it opens the queue', async ({ app, page }, testInfo) => {
    await app.goto('/dashboard');
    await openMenu(app, testInfo.project.name);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const item = nav.getByRole('link', { name: 'R1 interviews' });
    await expect(item).toBeVisible();
    await expect(nav.getByRole('link')).toHaveText(['Dashboard', 'Candidates', 'R1 interviews', 'Agents', 'Ashby Live Jobs', 'Mission Control', 'Phone calendar']);
    await item.click();
    await expect(page).toHaveURL(/\/interviews$/);
    await expect(page.getByRole('heading', { level: 1, name: 'R1 interviews' })).toBeVisible();
    app.expectHealthy();
  });

  test('hides it on a server that does not run R1 and has no round', async ({ app, page }, testInfo) => {
    app.db.r1.deployed = false;
    app.db.r1.queue = [];
    await app.goto('/dashboard');
    await openMenu(app, testInfo.project.name);
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Agents' })).toBeVisible();
    await expect.poll(() => queueReads(app).length).toBeGreaterThan(0);
    await expect(nav.getByRole('link', { name: 'R1 interviews' })).toHaveCount(0);
    app.expectHealthy();
  });

  test('keeps it for rounds that exist on such a server, and for a viewer', async ({ app, page }, testInfo) => {
    app.db.r1.deployed = false;
    app.db.me.role = 'viewer';
    await app.goto('/dashboard');
    await openMenu(app, testInfo.project.name);
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'R1 interviews' })).toBeVisible();
    app.expectHealthy();
  });
});

test.describe('the queue', () => {
  test('opens on To review, oldest first, and reads, fits and passes axe', async ({ app, page }, testInfo) => {
    await app.goto('/interviews');
    await expect(page.getByRole('button', { name: 'To review' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Oldest first' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('queue-summary')).toHaveText('3 interviews to review, oldest first');
    await expect(page.getByRole('link', { name: /Kapoor|Ferreira|Rao/ })).toHaveText(['Naveen Kapoor', 'Diego Ferreira', 'Arjun Rao']);

    await noSideways(app);
    await auditA11y(page, testInfo, 'r1-interviews', { strict: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'r1-interviews', testInfo.project.name, 'to-review.png'), animations: 'disabled', caret: 'hide' });
    app.expectHealthy();
  });

  test('a row opens its review, and the breadcrumb comes back', async ({ app, page }) => {
    await app.goto('/interviews');
    await page.getByRole('link', { name: 'Naveen Kapoor' }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/${R1_ROUND_ID}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sales Program Advisor role-play');
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'R1 interviews' }).click();
    await expect(page).toHaveURL(/\/interviews$/);
    app.expectHealthy();
  });

  test('the breadcrumb comes back to the same view and page, through a change of tab', async ({ app, page }) => {
    const [first] = app.db.r1.queue;
    app.db.r1.queue = Array.from({ length: 30 }, (_, i) => ({
      ...first,
      // The only round with a review behind it sits on the second page.
      id: i === 27 ? R1_ROUND_ID : `round-${i}`,
      candidate_name: `Candidate ${String(i).padStart(2, '0')}`,
      created_at: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
    }));
    const place = '?view=all&sort=oldest&page=2&dry_runs=include';
    await app.goto(`/interviews${place}`);
    await page.getByRole('link', { name: 'Candidate 27' }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/${R1_ROUND_ID}$`));
    await page.getByRole('tab', { name: 'Briefing' }).click();
    await expect(page).toHaveURL(/tab=briefing/);
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'R1 interviews' }).click();
    await expect(page).toHaveURL(/\/interviews\?view=all&sort=oldest&page=2&dry_runs=include$/);
    await expect(page.getByRole('link', { name: 'Candidate 27' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('switch', { name: 'Show staff dry runs' })).toBeChecked();
    app.expectHealthy();
  });

  test('the name on the review goes to the R1 tab of the candidate', async ({ app, page }) => {
    await app.goto(`/interviews/${R1_ROUND_ID}`);
    await page.getByRole('heading', { level: 1 }).getByRole('link', { name: 'Naveen Kapoor' }).click();
    await expect(page).toHaveURL(new RegExp(`/candidates/${R1_CANDIDATE_ID}\\?tab=r1$`));
    await expect(page.getByRole('tab', { selected: true })).toHaveText('R1 interview');
    app.expectHealthy();
  });

  test('each view shows its own rows, and the address follows', async ({ app, page }) => {
    await app.goto('/interviews');
    await expect(page.getByRole('link', { name: 'Naveen Kapoor' })).toBeVisible();
    await page.getByRole('button', { name: 'In progress' }).click();
    await expect(page.getByRole('link', { name: 'Wei Zhang' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Naveen Kapoor' })).toHaveCount(0);
    await expect(page).toHaveURL(/view=in-progress/);
    await page.getByRole('button', { name: 'Reviewed' }).click();
    await expect(page.getByRole('link', { name: 'Isha Kulkarni' })).toBeVisible();
    await expect(page.getByTestId('queue-summary')).toHaveText('1 interview with a settled outcome');
    await page.getByRole('button', { name: 'All' }).click();
    await expect(page.getByTestId('queue-summary')).toHaveText('7 interviews, newest first');
    // A withheld row says so, and prints no score.
    await expect(page.getByRole('row').filter({ hasText: 'Tanvi Joshi' })).toContainText('Scorecards are suppressed while an appeal is under review.');
    app.expectHealthy();
  });

  test('a lapsed link leaves In progress and reads Expired, and a lapsed retake comes back to To review', async ({ app, page }) => {
    const lapsed = new Date(Date.parse(app.db.r1.queue[0].created_at)).toISOString();
    const byName = (name: string) => app.db.r1.queue.find((round) => round.candidate_name === name)!;
    Object.assign(byName('Meera Iyer'), { expires_at: lapsed });
    Object.assign(byName('Wei Zhang'), { status: 'invited', attempts_counted: 1, recommendation: 'hold', overall: 58, status_write: 'hold_flag', expires_at: lapsed, attempts: [] });

    await app.goto('/interviews?view=in-progress');
    await expect(page.getByTestId('queue-summary')).toHaveText('0 interviews in progress');
    await page.getByRole('button', { name: 'To review' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Wei Zhang' })).toContainText('Expired');
    await expect(page.getByRole('link', { name: 'Meera Iyer' })).toHaveCount(0);
    await page.getByRole('button', { name: 'All' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Meera Iyer' })).toContainText('Expired');
    app.expectHealthy();
  });

  test('a staff dry run shows only when asked for, and is marked', async ({ app, page }) => {
    await app.goto('/interviews?view=all');
    await expect(page.getByRole('link', { name: 'Tanvi Joshi' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Omar Haddad' })).toHaveCount(0);
    await page.getByRole('switch', { name: 'Show staff dry runs' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Omar Haddad' })).toContainText('Staff dry run');
    await expect(page).toHaveURL(/dry_runs=include/);
    app.expectHealthy();
  });

  test('the search asks the API and leaves the address alone', async ({ app, page }) => {
    await app.goto('/interviews');
    await expect(page.getByRole('link', { name: 'Naveen Kapoor' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Find a candidate by name' }).fill('diego');
    await expect(page.getByRole('link', { name: 'Diego Ferreira' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Naveen Kapoor' })).toHaveCount(0);
    expect(page.url()).not.toContain('diego');
    await page.getByRole('searchbox', { name: 'Find a candidate by name' }).fill('nobody at all');
    await expect(page.getByText('No interview in this view matches that name.')).toBeVisible();
    app.expectHealthy();
  });

  test('pages through a long queue on the server, and a stale page lands on the last', async ({ app, page }) => {
    const [first] = app.db.r1.queue;
    app.db.r1.queue = Array.from({ length: 30 }, (_, i) => ({
      ...first,
      id: `round-${i}`,
      candidate_name: `Candidate ${String(i).padStart(2, '0')}`,
      created_at: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
    }));
    await app.goto('/interviews');
    await expect(page.getByRole('link', { name: 'Candidate 00' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Showing' })).toHaveText('Showing 1–25 of 30 interviews');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByRole('link', { name: 'Candidate 29' })).toBeVisible();
    await expect(page).toHaveURL(/page=2/);
    await noSideways(app);

    await app.goto('/interviews?page=9');
    await expect(page.getByRole('link', { name: 'Candidate 29' })).toBeVisible();
    await expect(page).toHaveURL(/page=2/);
    app.expectHealthy();
  });

  test('says so when there is nothing to review', async ({ app, page }, testInfo) => {
    app.db.r1.queue = [];
    await app.goto('/interviews');
    await expect(page.getByText('Nothing is waiting for review.')).toBeVisible();
    await noSideways(app);
    await auditA11y(page, testInfo, 'r1-interviews-empty', { strict: true });
    app.expectHealthy();
  });
});
