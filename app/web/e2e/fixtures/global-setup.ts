/**
 * Before any worker starts: stamp this run with an id.
 *
 * Workers inherit the runner's environment at spawn, so every axe record
 * written during the run carries this id and the teardown summarises exactly
 * this run's audits — never a stale file from a route that has since been
 * renamed or removed.
 */
export default function globalSetup(): void {
  process.env.E2E_RUN_ID = `${Date.now()}`;
}
