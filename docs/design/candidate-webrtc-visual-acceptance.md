# Candidate WebRTC visual acceptance

The supplied screenshots are visual references only. They are not committed and their visible candidate PII is not reproduced.

## Acceptance checklist

### Invite

- Interview Kickstart logo and name are visible.
- Role title is the dominant content.
- The page communicates audio-only screening and does not request camera permission.
- One clear review-consent action is present.

### Consent

- Legal copy is concise by default.
- Each required consent is individually visible and keyboard operable.
- Select all is checked only when all items are checked and is indeterminate for partial selection.
- Accept is disabled until every required item is selected.
- Full details are available through a disclosure without executing markdown/HTML.

### Audio readiness

- Microphone selector and readable live level meter are prominent.
- The selected role remains visible.
- Connection and microphone states are explicit: waiting, checking, stable, or retry.
- Continue is impossible until the minimum audio and network checks pass.
- No camera preview or video wording appears.

### Interview

- Large central IK identity is the visual anchor.
- The right-side caption card contains interviewer speech only.
- The aura reacts to actual interviewer audio, settles at silence, and has a visible speaking/listening status.
- No candidate transcript, download, edit, copy, or export controls appear.
- Mobile layout places captions below the aura without horizontal scrolling.

## Accessibility acceptance

- Keyboard order follows the visual order and focus moves to the next stage heading.
- Every input and button has an accessible name.
- Final interviewer captions are announced politely; interim updates do not create repeated announcements.
- Reduced motion removes aura transforms and infinite animation.
- Forced-colors and reduced-transparency modes remain readable.
- Text and controls meet WCAG AA contrast; control boundaries and focus indicators meet the non-text contrast requirement.
- Verify at 320px, 390px, 768px, 1024px, and 1440px widths and at 200%/400% zoom.
