/**
 * axe-core in the real browser — the half of the accessibility audit the
 * unit suite cannot do.
 *
 * `src/test/setup.ts` runs axe in jsdom and has to switch off
 * `color-contrast`, `link-in-text-block` and `scrollable-region-focusable`
 * because jsdom has no layout or paint; its own comment says they "must be
 * verified in a real browser". This runs the SAME tag set with EVERY rule on,
 * against fully rendered pages.
 *
 * The axe-core already in devDependencies is injected directly (no wrapper
 * package) so unit and browser audits run the identical engine version.
 *
 * STRICT WHERE IT MATTERS, REPORTED ELSEWHERE. Every audit is written to
 * `.artifacts/axe/<project>/<name>.json`; `summarizeAxe` folds them into
 * `.artifacts/axe-summary.json` after the run. An audit run with
 * `{ strict: true }` also FAILS its test on any serious or critical
 * violation. app.e2e.ts makes every KEY STATE strict — those are the surfaces
 * the redesign rebuilt (the Ashby add-mapping dialog and job picker, the
 * Scorebar), where a violation is a regression, not inherited debt. The
 * legacy routes carry older debt and stay report-only, so the suite is not
 * red on day one and ignored; `E2E_AXE_STRICT=1` makes EVERY audit strict —
 * the ratchet for CI once that debt is paid down.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type TestInfo } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * Every artifact of a run. `E2E_ARTIFACTS` moves it, so two runs side by side
 * (two worktrees' agents, a shots run beside a check run) never overwrite each
 * other's report or screenshots.
 */
export const ARTIFACTS_DIR = process.env.E2E_ARTIFACTS
  ? path.resolve(process.env.E2E_ARTIFACTS)
  : path.resolve(HERE, '..', '.artifacts');
const AXE_DIR = path.join(ARTIFACTS_DIR, 'axe');

/** Mirrors `runAxe` in src/test/setup.ts, minus the jsdom-only exclusions. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

export type Impact = 'minor' | 'moderate' | 'serious' | 'critical';

export interface AxeFinding {
  id: string;
  impact: Impact | null;
  help: string;
  helpUrl: string;
  nodes: Array<{ target: string[]; html: string; failureSummary: string }>;
}

export interface AxeRecord {
  /** `E2E_RUN_ID` from global-setup; the summary only reads this run's records. */
  runId: string;
  project: string;
  name: string;
  url: string;
  /** Whether a serious/critical violation failed the test (vs. reported only). */
  strict: boolean;
  violations: AxeFinding[];
}

/** `E2E_AXE_STRICT=1`: every audit is strict, not just the ones that ask. */
export const AXE_STRICT = process.env.E2E_AXE_STRICT === '1';

/** The findings a strict audit fails on. */
export function blockingViolations(record: AxeRecord): AxeFinding[] {
  return record.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

let axeSource: string | null = null;
function loadAxeSource(): string {
  axeSource ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  return axeSource;
}

/**
 * Run axe on the current page state and persist the result for the summary.
 * With `strict` (or under `E2E_AXE_STRICT=1`), a serious or critical
 * violation also fails the test — as a soft assertion, so the rest of the
 * test's checks still run and report.
 */
export async function auditA11y(page: Page, testInfo: TestInfo, name: string, { strict = false } = {}): Promise<AxeRecord> {
  await page.addScriptTag({ content: loadAxeSource() });
  const violations = await page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<Record<string, unknown>> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map((v) => ({
      id: v.id as string,
      impact: (v.impact ?? null) as string | null,
      help: v.help as string,
      helpUrl: v.helpUrl as string,
      nodes: (v.nodes as Array<Record<string, unknown>>).map((n) => ({
        target: (n.target as unknown[]).map(String),
        html: String(n.html).slice(0, 300),
        failureSummary: String(n.failureSummary ?? ''),
      })),
    }));
  }, AXE_TAGS);

  const record: AxeRecord = {
    runId: process.env.E2E_RUN_ID ?? 'unknown',
    project: testInfo.project.name,
    name,
    url: page.url(),
    strict: strict || AXE_STRICT,
    violations: violations as AxeFinding[],
  };
  const dir = path.join(AXE_DIR, testInfo.project.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(record, null, 2));
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify(record, null, 2), contentType: 'application/json' });

  const blocking = blockingViolations(record);
  if (blocking.length) {
    testInfo.annotations.push({
      type: record.strict ? 'axe (strict)' : 'axe (report-only)',
      description: blocking.map((v) => `${v.impact} ${v.id} ×${v.nodes.length}`).join(', '),
    });
  }
  if (record.strict) {
    // One line per finding — rule, impact, where, what — so the failure
    // reads without opening the attachment.
    expect
      .soft(
        blocking.map((v) => `${v.impact} ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
        `serious/critical axe violations in "${name}" (strict audit — see axe-${name}.json)`,
      )
      .toEqual([]);
  }
  return record;
}

/**
 * Fold every per-page record into `.artifacts/axe-summary.json`: counts by
 * rule and impact, the pages each rule fires on, and the worst pages.
 * Called from the Playwright global teardown, after every worker has written.
 */
export function summarizeAxe(): void {
  if (!existsSync(AXE_DIR)) return;
  const runId = process.env.E2E_RUN_ID;
  const records: AxeRecord[] = [];
  for (const project of readdirSync(AXE_DIR)) {
    for (const file of readdirSync(path.join(AXE_DIR, project))) {
      if (!file.endsWith('.json')) continue;
      const record = JSON.parse(readFileSync(path.join(AXE_DIR, project, file), 'utf8')) as AxeRecord;
      if (record.runId === runId) records.push(record);
    }
  }
  // A run that audited nothing (the screenshot run) keeps the last summary.
  if (records.length === 0) return;

  const byRule = new Map<string, { impact: Impact | null; help: string; helpUrl: string; nodes: number; pages: Set<string> }>();
  const byImpact: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const pages = records.map((r) => {
    let seriousOrWorse = 0;
    for (const v of r.violations) {
      const entry = byRule.get(v.id) ?? { impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: 0, pages: new Set<string>() };
      entry.nodes += v.nodes.length;
      entry.pages.add(`${r.project}/${r.name}`);
      byRule.set(v.id, entry);
      byImpact[v.impact ?? 'minor'] += v.nodes.length;
      if (v.impact === 'serious' || v.impact === 'critical') seriousOrWorse += v.nodes.length;
    }
    return { page: `${r.project}/${r.name}`, url: r.url, strict: r.strict, rules: r.violations.length, nodes: r.violations.reduce((s, v) => s + v.nodes.length, 0), seriousOrWorse };
  });

  const rules = [...byRule.entries()]
    .map(([id, e]) => ({ id, impact: e.impact, help: e.help, helpUrl: e.helpUrl, nodes: e.nodes, pageCount: e.pages.size, pages: [...e.pages].sort() }))
    .sort((a, b) => rank(b.impact) - rank(a.impact) || b.nodes - a.nodes);

  const summary = {
    generatedAt: new Date().toISOString(),
    runId,
    // `E2E_AXE_STRICT=1` for the whole run; key states are strict regardless.
    strictEverywhere: AXE_STRICT,
    tags: AXE_TAGS,
    pagesAudited: records.length,
    pagesAuditedStrictly: records.filter((r) => r.strict).length,
    totals: { rules: rules.length, nodesByImpact: byImpact },
    rules,
    topOffenders: pages.sort((a, b) => b.seriousOrWorse - a.seriousOrWorse || b.nodes - a.nodes).slice(0, 10),
  };
  writeFileSync(path.join(ARTIFACTS_DIR, 'axe-summary.json'), JSON.stringify(summary, null, 2));
}

function rank(impact: Impact | null): number {
  return impact === 'critical' ? 4 : impact === 'serious' ? 3 : impact === 'moderate' ? 2 : impact === 'minor' ? 1 : 0;
}
