Natural phone opening, pre-consent scheduling, and single Q&A invitation

Phone candidates could hear repeated opening repairs, be re-asked for consent when busy, and receive another questions invitation after every answer. Generate the opening privately with the session model and validate before speech; route availability replies through the existing calendar proposal/confirmation flow without granting screening consent; invite questions once and answer follow-ups without repeating the invitation.

Scope: phone worker only. Preserve identity checking, current recording lifecycle, server scheduling constraints, and terminal playout ordering. PLAN.md: TST-01/TST-03 worker behavior and integration coverage. This does not close launch gates.

Validation: 20 focused synthetic conversation regressions cover private draft validation, single playout, busy/driving before consent, confirmed/unconfirmed callbacks, explicit exits and opt-outs, negated hang-ups, time corrections, bounded Q&A, interruptions, and watchdog-recovered answer delivery. Two independent adversarial reviews examined consent/callback safety and Q&A/turn delivery respectively; findings were fixed and re-reviewed. Merge remains conditional on all required CI passing. No live candidate calls or production configuration changes are part of validation.

CI prerequisite: patch source-map-js from 1.2.1 to 1.2.2 in API/web lockfiles for GHSA-68fv-2mgg-jv7q. No security exception or unrelated dependency upgrades.

Rollout: AI-composed gate lines are the default when PHONE_DETERMINISTIC_OPENER is unset or false. An existing true deployment override still selects the scripted rollback and must be changed to false to enable composition. Required recording disclosure and explicit consent gating remain enforced; failed or invalid drafts use a single safe scripted fallback. Callback booking does not grant screening consent. The current recording lifecycle is unchanged. Validate with an authorized test call before expanding live traffic; this PR does not authorize deployment or candidate calls.
