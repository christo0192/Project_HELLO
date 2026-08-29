# HELLO dashboard visual acceptance

## Source references

The approved HR palette and visual direction are the four owner-provided light
screenshots:

- `C:\Users\Admin\Pictures\Screenshots\Screenshot 2026-08-21 171140.png`
- `C:\Users\Admin\Pictures\Screenshots\Screenshot 2026-08-21 171205.png`
- `C:\Users\Admin\Pictures\Screenshots\Screenshot 2026-08-21 171215.png`
- `C:\Users\Admin\Pictures\Screenshots\Screenshot 2026-08-21 171223.png`

They define the application palette, spacing feel, rounded surfaces, restrained
status color, and light-first presentation. They do not define a separate dark
product theme.

## Covered surfaces

The redesign contract covers Dashboard, Candidates, Candidate Detail, Roles,
Phone Calendar, Session Detail, Screening, Mission Control, Ashby Mission
Control, scoped review, Login, Candidate Join/live interview, Privacy, Status,
Appeal, Unauthorized, Not Found, and MFA compatibility routes.

## Automated gate

```bash
node scripts/validate-hr-design-system.mjs
cd app/web && npm run lint && npm run test:typecheck && npm test && npm run build
```

The route and token validator is intentionally offline. It checks the approved
palette anchors, refuses the former alternate dark surface, and verifies every
routed surface remains present. Browser accessibility tests additionally cover
axe, keyboard navigation, focus return, reduced motion, loading/error/empty
states, and narrow layouts.

## Release acceptance

Before broad recruiter rollout, capture each route at 1440×900 and 390×844
with deterministic fixtures, fixed locale/timezone, reduced motion, and the
following state set where applicable: loading, empty, error, unauthorized,
maintenance, confirmed/due/missed callback, consent, connecting, live, ending,
and failed call. Compare against the four references for palette and hierarchy;
record approved baselines in the deployment artifact.

No screenshot gate authorizes a real call. Phone validation uses fake clocks,
network traps, worker route seams, SQL policy tests, and the existing halt.
Production calling remains separately authorized and protected by the existing
admission controls.
