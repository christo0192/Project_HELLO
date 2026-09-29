/**
 * After every worker has finished: fold the per-page axe records written
 * during THIS run into `.artifacts/axe-summary.json`.
 *
 * Runs in the runner process, so it sees the run id global-setup put in the
 * environment and ignores records left behind by earlier runs (a screenshot
 * run, which audits nothing, therefore leaves the last audit's summary alone).
 */
import { summarizeAxe } from './axe';

export default function globalTeardown(): void {
  summarizeAxe();
}
