# HELLO visual acceptance

## Source references

The approved direction is **Logsheet with Readout's scorecard panel**, recorded in
[logsheet-decision-2026-11-05.md](logsheet-decision-2026-11-05.md) and specified in
[hello-glass-design-system.md](hello-glass-design-system.md).

The owner and the stakeholder approved static mocks on invented data. They
accept the built screens themselves, on real data, after deploy. That acceptance
replaces September's AI-judged one: an AI review and a slop detector stay as
lint, and neither can accept a change to the look.

## Who accepts a change to the look

The owner and the stakeholder, live or on redacted captures, with a dated
decision record in `docs/design`. Real-data screenshots contain candidate PII,
so they are never committed. Fixture screenshots use synthetic data only.

## Covered surfaces

The contract covers Dashboard, Candidates, Candidate Detail, Agents, Phone
Calendar, Session Detail, Screening, Mission Control, Ashby Live Jobs, scoped
review, Login, Candidate Join/live interview, the R1 candidate pages, Privacy,
Status, Appeal, Unauthorized, Not Found, MFA compatibility routes and the
exported candidate report.

## Automated gate

```bash
node scripts/validate-hr-design-system.mjs
node scripts/validate-hr-design-system.test.mjs
cd app/web && npm run lint && npm run test:typecheck && npm test && npm run build
```

The validator is intentionally offline. It checks every palette anchor at its
approved value, computes the declared contrast pairs, refuses any alternate dark
surface, keeps the voice hue to one pair of tokens and a verdict and a rating
to their family, never crimson, refuses
raw colours and stock Tailwind hues, refuses blur, gradients, a fixed ground,
resting shadows, entrance motion and radii or type off the scale in every
stylesheet and in source, and verifies every routed surface remains present. Its
test seeds one fault per rule and fails if the gate does not name it, so the gate
cannot pass vacuously.

The Web E2E workflow (`.github/workflows/web-e2e.yml`) runs the whole Playwright
suite, on both the desktop and the mobile project with no tolerated failures, on
any pull request that touches `app/web`. It is path-filtered, so it is not a
required check: read its result before merging. Browser checks (axe, keyboard
navigation, focus return, reduced motion, loading/error/empty states, narrow
layouts) also run locally from `app/web`: `npx --no-install playwright test
--config e2e/playwright.config.ts --project=desktop --workers=1 <spec>`, and
again with `--project=mobile`, because the workflow runs both.

## Release acceptance

Before broad recruiter rollout, capture each route at 1440×900, 1366×768 and
390×844 with deterministic fixtures, fixed locale/timezone, reduced motion, and
the following state set where applicable: loading, empty, error, unauthorized,
maintenance, confirmed/due/missed callback, consent, connecting, live, ending,
and failed call. Check for:

- one opaque sheet on the desk, inset 8px, with no blur, gradient or glow;
- printed 1px rules, and shadows on floating layers only;
- orange only on the candidate's voice; a verdict and a rating in their family,
  never crimson; crimson only on a fault;
- a word on every status;
- nothing entering, revealing or counting up, and no layout shift on arrival;
- the IK logo on its white plate, never inverted;
- a 2px ink focus ring, and states that survive Windows contrast themes.

Commit no screenshot baselines until the owner and the stakeholder have accepted
the built screens on real data.

No screenshot gate authorizes a real call. Phone validation uses fake clocks,
network traps, worker route seams, SQL policy tests, and the existing halt.
Production calling remains separately authorized and protected by the existing
admission controls.
