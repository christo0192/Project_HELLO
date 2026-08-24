# Phone canary verdict protocol (internal)

`canary0.sql` writes ONLY these line shapes to psql stdout. The Node runner
(`canary0.mjs`) parses them and refuses anything else, so a scenario cannot
smuggle an identifier into the manifest by printing it.

**Canary-1 extends this grammar rather than inventing a second one.** The
operator CLI (`app/api/scripts/phone-canary1.ts`) emits the same four shapes
with `canary1` in the *scenario* field, and validates every field against the
same regexes before printing. Anything that fails validation prints
`CANARY|canary1|emitter_refused|FAIL|unprintable` and never the offending
value. `app/api/src/__tests__/phone-canary1-grammar.test.ts` reads THIS FILE
and compares the patterns below against the emitter's own, so the two cannot
drift.

That matters more for Canary-1 than for Canary-0, because Canary-1 is the one
that has a phone number in memory. The grammar is what makes the terminal
transcript safe for an operator to keep, paste into a handover, or read aloud —
there is no `--out`, and the transcript IS the evidence.

    CANARY|<scenario>|<check>|PASS|<code>
    CANARY|<scenario>|<check>|FAIL|<code>
    CANARYCOUNT|<scenario>|<key>|<integer>
    CANARYDONE|<scenario-count>

Field grammar, enforced by the runner and by `manifest.mjs`:

  scenario  ^[a-z][a-z0-9_]{2,63}$
  check     ^[a-z][a-z0-9_]{2,79}$
  code      ^[a-z][a-z0-9_]{0,63}$   -- a STABLE CODE, never a value
  key       ^[a-z][a-z0-9_]{2,47}$
  integer   ^(0|[1-9][0-9]{0,8})$

There is deliberately no free-text field. A uuid, a phone number, a room
name, an object key, a transcript fragment or a provider id cannot be
expressed in this grammar, so the sanitizer is a PARSER rather than a
redactor -- there is nothing to strip because nothing else can be said.

## Scenarios

  canary0   the substrate rehearsal, driven by `canary0.sql` against a real
            Postgres. Places no call and cannot: the telephony SDK is not
            resolvable from `scripts/phone-canary/` at all.
  canary1   the owner's own-number test call, driven by the operator CLI.
            Ships DISARMED (`CANARY1_ARMED = false`), and while disarmed it
            refuses before every provider seam. Its zero-network claim is
            WEAKER than canary0's and is labelled as such: the SDK IS
            resolvable from `app/api/src/__tests__`, so the property rests on
            dependency injection and the runtime traps rather than on
            unresolvability.
