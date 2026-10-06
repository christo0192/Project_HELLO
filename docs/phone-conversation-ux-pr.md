Natural phone opening, pre-consent scheduling, and single Q&A invitation

Phone candidates could hear repeated opening repairs, be re-asked for consent when busy, and receive another questions invitation after every answer. Generate the opening privately with the session model and validate before speech; route availability replies through the existing calendar proposal/confirmation flow without granting screening consent; invite questions once and answer follow-ups without repeating the invitation.

Scope: phone worker only. Preserve identity checking, current recording lifecycle, server scheduling constraints, and terminal playout ordering. PLAN.md: TST-01/TST-03 worker behavior and integration coverage. This does not close launch gates.

Validation in progress: synthetic worker regression suite, focused conversation tests, two independent adversarial reviews, and required CI. Do not merge until these pass. No live candidate calls or production configuration changes are part of validation.
