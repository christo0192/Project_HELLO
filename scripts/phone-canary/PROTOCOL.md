# Canary-0 verdict protocol (internal)

`canary0.sql` writes ONLY these line shapes to psql stdout. The Node runner
(`canary0.mjs`) parses them and refuses anything else, so a scenario cannot
smuggle an identifier into the manifest by printing it.

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
