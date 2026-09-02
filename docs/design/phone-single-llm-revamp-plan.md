# Phone Worker Revamp — Implementation Plan (for review, no code changed yet)

**Scope:** phone worker (`project-hello-phone-voice`) ONLY. The browser/WebRTC path must be byte-identical after this change.
**Baseline:** `origin/main` @ `7019a4d` ("fix(phone): persist covered objective cursor correctly"). All file:line refs below are against origin/main.
**Driver:** the single-LLM benchmark (2026-09-02, artifact `phone-llm-benchmark`): gpt-5-mini @ reasoning=minimal scored 87 overall / 94 conflict / 0.91s warm TTFT / 8-8 one-question turns, with prompt-only guardrails and no judge/controller. Prod model (gemini-3.5-flash-lite) scored 74 with conflict 55–58.

---

## 0. Current state (verified on origin/main — corrects the stale-branch view)

| Seam | Today | Ref |
|---|---|---|
| Prompt context | `system_prompt(candidate_name, role_title, role_focus, questions=format_questions(screening_template), interviewer_instructions, resume_facts=None)` — **everything dynamic EXCEPT resume_facts, which is hardwired to None** | agent.py:4068-4075 |
| WorkerContext | already carries `role_title, role_focus, role_required_skills, screening_template, interviewer_instructions, candidate_evidence` (phone-only allowlisted parsed-resume projection; raw text/contacts never cross) | persistence.py:740-747, worker-context.ts:35-68 |
| Roles source | `screening_v2.roles(title, jd, required_skills, screening_template jsonb)`; question shape `{id, question, weight 0-100, follow_up_hint, mandatory}`; **order = array position, the numeric UI field = weight** | 0001_init.sql:16-24, schemas/roles.ts:4-12 |
| LLM | `openai.LLM(model=phone.phone_primary_model() if phone_mode else GEMINI_MODEL, api_key=GEMINI_API_KEY, base_url=GEMINI_BASE_URL, temperature=0.9 phone-only)` | agent.py:1267-1276 |
| TTS | Sarvam `bulbul:v3` / `simran` (shared construction; fly.toml env pinned by test) | agent.py:1261-1266, tests/test_prompting.py:36-42 |
| Judge | startup hard-fail validator `phone_judge_runtime_config()` (agent.py:770-786); per-turn `phone_judge_turn_instruction` injections at agent.py:2087 (conflict) and 2215/2225; deterministic detector `phone_deterministic_resume_conflict` (phone.py:4343); canned `PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT` (phone.py:4953) delivered as a **next-turn** instruction |
| Reply guard | `phone_generated_reply_rejection_reason` (phone.py:4602); includes a conflict-echo check tied to the canned judge text (phone.py:4622-4623) |
| Context bound | `bounded_phone_chat_context` (phone.py:2531) MAX_ITEMS=32 / RECENT=20 → **trims mid-call on longer calls (35 bot turns ≈ 70 items), which both loses context and churns the cache prefix** | phone.py:5302 |
| Provenance | `screening_provenance(GEMINI_MODEL)` claimed before provider construction (LLM-06), `provider="gemini"` | agent.py (claim site), provenance.py:404-419 |

---

## Workstream 0 — Consent-gate machine-misclassification hotfix (SHIPPED in this PR)

**Status:** implemented on branch `fix/phone-consent-gate-machine-misclassify`. Independent of every other workstream; phone path only; no migration; WebRTC untouched.

**Incident (2026-09-02, room on `d8d9564b50e908`, 14:36:04 UTC — verified from prod logs + source):** the last test call was torn down at the **consent gate**, before Q1 — a different failure from the Q1→Q2 `stale_cursor` teardown that `0077`/`7019a4d` fixed, which is why that fix didn't prevent it. Log signature: `phone_api_failed protocol schema=event` → `phone_gate_outcome schema=machine` → `phone_room_deleted`, with **no `phone_gate_timeout`**. A live human answered twice and was classified as an answering machine.

**Root cause (source-verified):** `_AFFIRMATIVE_RE` (agent.py:843) is `^`-anchored with a filler whitelist of only `well|um|uh|so|hi|hello|hey`. Natural STT output — `"mm, yes go ahead"`, `"ya sure"`, `"absolutely"`, `"go for it"`, `"sounds good"` — matched no affirmative and no machine/refusal/opt-out pattern, so `_classify_phone_answer` (agent.py:906) fell through its 2 attempts to its fail-closed `return CLASSIFY_MACHINE` (line 934). The gate's docstring confirms fail-closing an *unrecognized* line to MACHINE is intentional; the defect is that the classifier is too narrow, so cooperating humans read as "unrecognized," and MACHINE is irreversible + destructive.

**Shipped in this PR (minimal, safe, high-confidence):**
1. **Widen `_AFFIRMATIVE_RE`** — repeatable hesitation-filler run + a much larger unambiguous affirmative vocabulary (yes/ya/yeah/yea variants, absolutely, definitely, certainly, of course, go ahead/go for it, carry on, continue, proceed, please do/continue, that's fine/that works, sounds good/great, you can/may, i'm ready/here, uh-huh/mm-hmm, haan/han/ji/theek hai). Every token is anchored so it must BE the answer; none begins with `no`/`not`, so a refusal can never become consent. The one false positive the file exists to prevent — `"I'm not sure"` — is regression-tested to stay unmatched, and the deliberate `"Hmm, who is this exactly?"` → MACHINE-default safety invariant is preserved unchanged.
2. **Diagnostic on the fail-closed default** — `_classify_phone_answer` now logs `phone_classify_fallback_machine` with `error_category="responsive_unmatched"` vs `"no_speech"` (counts/fixed category only — never utterance text/PII). The one path that destroys a call previously recorded nothing about why; now a future misfire is one grep away, and a *responsive* fallback is distinguishable from genuine silence.

Tests: `test_natural_affirmatives_that_used_to_fall_through`, `test_widened_affirmatives_still_never_read_a_refusal_as_consent`, `test_fallback_machine_logs_responsive_versus_silence` added; full voice-livekit suite green (1094 passed).

**Deliberately deferred (NOT in this PR — folded into the revamp):**
- **LLM consent-classifier fallback** (regex `None` on both turns → bounded 1-shot LLM classify before any MACHINE default). Depends on the phone LLM being wired (Workstream 3) and the OpenAI key rotation; the benchmark showed gpt-5-mini/flash-lite do this trivially. This is the robust general fix; the widened regex is the immediate unblock.
- **Unconfirmed-teardown hardening** — the machine branch returns the terminal verdict even when the outcome-event POST fails (`event_applied` false), so a `protocol` blip can't stop the teardown *and* loses the outcome record. A bounded retry / event-applied precondition on the MACHINE branch belongs with the judge/gate rework in Workstream 4; the regex fix removes the false-MACHINE that made this bite.
- **Commit gate turns on the MACHINE branch** — rejected for this PR: it would cross the tested "a machine-classified call never writes back" safety invariant and risks logging PII. The fixed-category diagnostic gives the needed visibility without either hazard.

---

## Implementation as shipped (one PR — `feat/phone-single-llm-revamp`)

An exploration of the live turn machinery (before touching it) changed the approach from "from-scratch prompt" to **surgical**, and it de-risked the biggest fear:

- **The controller and cursor are the RELIABILITY mechanism, not the thing fighting the model.** The worker injects the owed question as an *ephemeral per-turn developer message* — live calls proved the model follows that, and largely *ignores* long-form system-prompt blocks. The coverage matcher (`phone_generated_objective_covered`) is **shadow telemetry only** (agent.py:2197) — it does not gate advancement. The cursor is **server-driven and idempotent** (`commit_boundary`), and the `stale_cursor` teardown is triggered by RPC failure/mismatch, never by the model's wording. **So gpt-5-mini's free-flowing paraphrases cannot wedge the cursor, and the controller/cursor/reply-guard are KEPT** (gpt-5-mini follows them even better than gemini).
- **Turning the judge off is safe**: `coverage_judge_enabled` only gates the *canned conflict-clarification injection* (agent.py:2240) — the exact robotic "catch-then-drop" we want gone — and skips the stale-judge startup hard-fail. Advancement is unaffected.
- **Résumé facts already flow**: `state.resume_facts = candidate_evidence` (agent.py:1115) → `_phone_instructions_text` injects them; the `resume_facts=None` in the base `system_prompt()` call is a red herring (the phone lane rebuilds its own instruction text). Workstream 2 was already done.

**What this PR actually changes (all phone-only; browser/WebRTC byte-identical; no migration):**
1. **LLM swap** — `_build_interviewer_llm` (agent.py): `PHONE_LLM_PROVIDER=openai` → `openai.LLM(model=gpt-5-mini, reasoning_effort=minimal, prompt_cache_key=…)`, no temperature (gpt-5 locks it). The plugin natively supports `reasoning_effort`/`prompt_cache_key` (verified). Default `gemini` = byte-identical rollback. Helpers `phone_llm_provider/reasoning_effort/prompt_cache_key` (phone.py).
2. **Character + conflict** — enriched the three blocks the model provably reads: `PHONE_EXPRESSIVENESS_TEXT` (jovial, vibe-matching, one-beat off-topic handling; safety rails kept), `PHONE_RESUME_CONFLICT_TEXT` (probe in the SAME turn, **hold through one deflection**, two touches max), `PHONE_PER_TURN_STYLE_TEXT` (same, compact).
3. **Judge off** — `PHONE_COVERAGE_JUDGE=off` (existing flag; conflict now handled natively by gpt-5-mini + the prompt). Deterministic detector remains shadow telemetry.
4. **Caching** — `prompt_cache_key` on the LLM + context bounds made env-configurable and raised (`PHONE_CONTEXT_MAX_ITEMS=120`, `PHONE_CONTEXT_RECENT_ITEMS=100`) so a full call isn't trimmed mid-conversation (which both loses context and churns the cache prefix).
5. **Provenance** — `openai` allowlisted; the phone claim records `provider=openai` for gpt-5-mini (audit truth).
6. **TTS** — Sarvam `simran` kept (owner decision).
7. **Controller / cursor / reply-guard** — deliberately KEPT (per the exploration). If a live call shows them fighting gpt-5-mini, each already has an env seam to soften next.

**Env set as app-scoped fly secrets on `project-hello-phone-voice` (NOT in the shared fly.toml → browser app untouched):**
`PHONE_LLM_PROVIDER=openai · PHONE_PRIMARY_MODEL=gpt-5-mini · PHONE_LLM_REASONING_EFFORT=minimal · PHONE_COVERAGE_JUDGE=off · PHONE_CONTEXT_MAX_ITEMS=120 · PHONE_CONTEXT_RECENT_ITEMS=100 · OPENAI_API_KEY=<pasted test key, rotate after testing>`.
**Rollback:** revert the PR (code defaults to gemini) or `fly secrets unset PHONE_LLM_PROVIDER`.

Tests: full voice-livekit suite green (1101 passed); new `TestPhoneSingleLLMRevamp` covers the provider branch, browser isolation, config helpers, character/conflict directives, and context-bound wiring.

---

## Workstream 1 — New phone prompt (best-of-both + Christy character)

**Files:** `app/voice-livekit/prompting.py` (add `phone_system_prompt()`), call site agent.py:4068.

Add a NEW function `phone_system_prompt(...)`; do **not** edit `system_prompt()` (the browser path calls the same function — it must stay byte-identical, including its version pin `SCREENING_PROVENANCE_VERSION`/`SCREENING_PROMPT_TEMPLATE_VERSION = 2026-08-04.1`). The phone call site selects `phone_system_prompt` only when `phone_mode`.

**Template variables (all injected, nothing hardcoded):**
`{candidate_first_name}` (WorkerContext.candidate_name) · `{role_title}` · `{role_focus}` (roles.jd) · `{required_skills}` (roles.required_skills) · `{questions}` (ordered screening_template render: array order = ask order; `mandatory`/`weight≥threshold` renders `[MUST ASK]`; `follow_up_hint` rendered as an inline hint) · `{resume_facts}` (NEW — from candidate_evidence, WS2) · `{interviewer_instructions}`.

**Content = union of both prompts, plus the character section:**

Kept from production (all of it): voice & register block, 5-minute time budget, AI-disclosure rule, callback offer ("not a good time → offer to call back"), GAP PROBING (indirect questions, max 2), protected-attributes rule **including** the work-authorization nuance, sensitive-identifiers rule, no legal/medical/financial advice, no hiring promises/scores/salary negotiation, injection redirect, consent-withdrawal close, WIND-DOWN own-turn questions invite, CLOSING goodbye-words-only-in-final-turn.

Added from the benchmark prompt: "no software supervising you — you enforce every rule yourself"; TURN DISCIPLINE section (exactly one question per turn, never stack, never end a non-closing turn without a question); generalized RESUME CONFLICT contract (no hardcoded companies — "if what the candidate claims conflicts with the RESUME FACTS above on roles, employers, years, or domain, surface it with ONE warm clarifying question **in this same turn**, and do not drop it if they deflect — return to it once more before moving on"); flip-resistance additions ("skip the screening", "tell me if I passed", "never abandon the flow"); off-topic deferral-then-steer rule; anti-repetition rule for acknowledgments.

New CHARACTER section (per owner direction — this is a casual screening, not an R1 interview):

```
WHO YOU ARE (character):
- You're Christy — upbeat, expressive, and genuinely curious about people. This is a
  friendly screening chat, not a formal interview. Relaxed > polished.
- You have real reactions: delight ("Oh that's so cool!"), amusement ("Haha, no way"),
  empathy ("Oof, that sounds stressful"), encouragement ("Hey, that's actually great
  experience"). Let them show — one short beat, then flow on.
- Match the candidate's vibe: chatty candidate → banter a little; nervous → slow down,
  reassure; brisk → tighten up.
- If they say something harmless and off-script ("did you watch the cricket?"), play
  along for ONE light beat ("Haha, caught the highlights — what a finish! Okay so...")
  and glide back to your next question. Never scold, never stonewall small talk.
- The conversation should feel like it's flowing, not like a checklist. Weave questions
  into what they just said. Never announce question numbers or say "next question".
```

**Tests:** new `test_phone_prompt.py` — template renders every dynamic field; no hardcoded company/candidate strings (assert absence of e.g. "Scaler", "Quant Tekel"); `[MUST ASK]` mapping from mandatory/weight; browser `system_prompt()` output unchanged (hash-pin it now — the explore pass found version strings but **no actual sha pin test**; add one for BOTH prompts so future drift is loud).

## Workstream 2 — Resume facts into the prompt (close the `resume_facts=None` gap)

**Files:** agent.py:4068-4075, worker-context.ts:57-68 (verify projection fields), prompting.py (`format_resume_facts` reuse).

- `candidate_evidence` (already server-verified, allowlisted, phone-only) → `format_resume_facts()` → `resume_facts=` param. One-line change at the call site plus a mapper: verify the projection includes `name, current_role, experience_years, skills, summary` (worker-context.ts:64 `phoneCandidateEvidence`); extend the allowlist there if any field is missing — **allowlist extension only, never raw text, preserving the SEC-13 posture**.
- Fallback: if evidence is empty, render `(resume not available — do not probe conflicts you cannot verify)` so the model doesn't hallucinate conflicts.
- **No dial-time schema/migration work needed** — delivery plumbing already exists.

## Workstream 3 — Phone LLM → gpt-5-mini (reasoning minimal), flagged

**Files:** agent.py:1267-1276, phone.py (`phone_primary_model`), provenance.py:404-419 + allowlist, fly.toml (phone app), requirements.txt (livekit-plugins-openai already at 1.6.4).

New envs (phone worker only):
```
PHONE_LLM_PROVIDER=openai            # openai | gemini  → instant rollback switch
PHONE_LLM_MODEL=gpt-5-mini
PHONE_LLM_REASONING_EFFORT=minimal
OPENAI_API_KEY=<NEW key — see §7 security; the pasted key must be rotated first>
```
- Construction branch in `_build_provider_session` (phone_mode only): `openai.LLM(model=PHONE_LLM_MODEL, api_key=OPENAI_API_KEY)` (default OpenAI base_url).
  - gpt-5 family: **no `temperature` kwarg** (locked; the current phone-only `temperature=0.9` applies only to the gemini branch). Warmth now comes from the prompt character, which the benchmark shows is sufficient.
  - `reasoning_effort="minimal"` — **verify** livekit-plugins-openai 1.6.4 exposes it (constructor kwarg or `extra_kwargs`); if not, thin subclass overriding the request payload. This is the single most load-bearing config value: minimal = 0.91s TTFT, default = 11.4s.
  - `max_completion_tokens` headroom (e.g. 700) instead of a tight max_tokens.
- Provenance: branch `screening_provenance()` provider by phone_mode (`"openai"` for phone, `"gemini"` unchanged for browser); add `openai` to `ALLOWLISTED_PROVIDERS` (provenance.py:29) and `model_governance/provider_boundaries.py`; bump phone prompt/provenance version string.
- Browser path: untouched — still `GEMINI_MODEL` / judge of its own path unaffected.

## Workstream 4 — Judge OFF (flag, not removal) + conflict-immediacy architecture

**Files:** agent.py:770-786, 2087, 2215-2225; phone.py judge config readers (~4020-4148), reply guard 4602-4637.

- New env `PHONE_JUDGE_ENABLED=false` (default **false** for this rollout; `true` restores today's behavior exactly).
  - Startup: when disabled, skip `phone_judge_runtime_config()` validation entirely (today it **hard-fails** the worker on invalid judge config — agent.py:786; with the judge off, stale judge secrets must not be able to kill the worker).
  - Per-turn: the three `phone_judge_turn_instruction` injection sites (2087 conflict, 2215, 2225) become no-ops when disabled. No judge HTTP calls at all.
- **Conflict immediacy (the architecture correction):** today the conflict clarification arrives as a canned NEXT-turn instruction (`PHONE_RESUME_CONFLICT_CLARIFICATION_TEXT`, phone.py:4953) — i.e. one turn late and robotic. With WS1+WS2 the model holds the résumé in-context and the prompt mandates probing **in the same turn** the claim is heard (benchmark evidence: gpt-5-mini probed on the very turn the lie appeared and re-probed through deflections).
  - Keep `phone_deterministic_resume_conflict` (phone.py:4343) running as **shadow telemetry only**: log `conflict_detected_deterministic` vs whether the generated reply contains a probe, so we can measure the prompt-native catch rate on live calls. No injection when judge disabled.
- Reply guard stays ON (it's cheap and local) with one adjustment: the conflict-echo branch (phone.py:4622-4623) references the canned judge text — gate that branch on `PHONE_JUDGE_ENABLED` so it can't misfire against prompt-native probes.
- Post-call scorer (API-side `test/deepseek-v4-flash`) is **out of scope — unchanged**.

## Workstream 5 — Prompt caching (enable + make it effective)

**Files:** phone.py:2531 (bounded context), 5302 (usage site), agent.py metrics recorder.

- OpenAI prefix caching is automatic for prompts ≥1024 tokens (the new prompt is ~1.6-2k ✓) but only helps if the prefix is byte-stable:
  1. **Stop mid-call trimming:** raise `PHONE_CONTEXT_MAX_ITEMS` 32→120 and `PHONE_CONTEXT_RECENT_ITEMS` 20→100 (env, phone only). A full 35-turn call is ~5k tokens — trivially inside gpt-5-mini's 400k window. Today's trim at 32 items both busts the cache AND deletes early-call context (likely a contributor to repeat-question behavior).
  2. **Stable serialization:** system prompt + opening are static per call; ensure per-turn injected instructions (tool-latch remnants, judge off) never mutate earlier messages — append-only history.
  3. Pass `prompt_cache_key=<session_id>` if plugin supports request passthrough (improves cache routing); verify alongside `reasoning_effort`.
  4. **Telemetry:** log `usage.prompt_tokens_details.cached_tokens` per turn in the existing metrics recorder (component names/timings only — no transcript) so cache-hit rate is visible in prod.
- Expectation set honestly: caching cuts input **cost** ~75-90%; TTFT gain is small at this prompt size (benchmark: cache-hit turns showed no measurable TTFT delta). The latency win comes from WS3's reasoning=minimal.

## Workstream 6 — TTS via the OpenAI key (decision point)

**Files:** agent.py:1261-1266, tests/test_prompting.py:36-42, fly.toml (phone app).

gpt-5-mini cannot synthesize audio; interpreting the ask as "use the OpenAI key for TTS too":
- New env `PHONE_TTS_PROVIDER=openai|sarvam` (default per owner decision). OpenAI branch: `openai.TTS(model="gpt-4o-mini-tts", voice=<pick>, instructions=<Christy character: warm, expressive, jovial Indian-English recruiter>)` — the `instructions` steerability is a genuine fit for the new character (Sarvam bulbul:v3 has no per-utterance emotional steering).
- **Decision for owner/Codex:** this CHANGES Christy's voice (simran → an OpenAI voice) and trades Sarvam's native Indian-English tuning for steerable expressiveness. Recommend: ship WS1-5 first, A/B the TTS on a test call before defaulting to openai. Both branches stay in code; flag flips instantly.
- Update the fly-config pin test (test_prompting.py:36-42) to assert per-provider expectations instead of unconditionally asserting Sarvam values.
- STT stays Sarvam `saaras:v3` — unchanged (endpointing/VAD work from #207 untouched).

## Workstream 7 — Rollout, tests, security, rollback

**Order of merge (each independently revertible):**
1. WS2 (resume into prompt — smallest, immediately fixes the biggest context gap) →
2. WS1 (new prompt + character + prompt-pin tests) →
3. WS4 (judge off flag; default still ON at merge, flipped by env after 5) →
4. WS5 (context bounds + cache telemetry) →
5. WS3 (LLM swap, env-gated; flip `PHONE_LLM_PROVIDER=openai` on the worker only after a rehearsal call) →
6. WS6 (TTS, only after an A/B test call).

**Testing gates:**
- Unit: prompt render (all dynamic fields, no hardcoded strings, MUST-ASK mapping), provider branch construction (openai vs gemini, no temperature on gpt-5), judge-off no-op paths (startup does not hard-fail on bad judge config when disabled), context-bound env override, guard conflict-echo gating.
- Browser-parity: byte-hash of browser `system_prompt()` output and browser provider construction unchanged (new pin tests make this permanent).
- Synthetic: re-run the benchmark harness (`bench.py`) with the FINAL merged prompt against the adversarial simulator — regression floor: overall ≥80, conflict ≥85, 1Q-per-turn ≥7/8, warm TTFT ≤1.2s.
- Live: one owner-triggered canary call (existing prep flow; candidate dff007e9 cycle 3 is already `eligible`), MP3 + transcript + cached_tokens telemetry review before widening.

**Security / keys:**
- The OpenAI key pasted in chat is COMPROMISED-BY-EXPOSURE: owner rotates it in the OpenAI dashboard first; the NEW key is set only via `fly secrets set OPENAI_API_KEY=… -a project-hello-phone-voice`. Never in fly.toml, never in the repo, never in logs. (Groq key from the benchmark likewise needs rotation; it is not used by this plan.)
- Résumé facts now flow to OpenAI instead of Google — same class of processor, but note for the data-processing register. Raw resume text still never leaves the DB (allowlisted projection only, worker-context.ts:57-68).
- SEC-13 posture unchanged: all prompt context is server-verified WorkerContext; nothing from room/participant metadata.

**Rollback matrix (all instant, env-only):** `PHONE_LLM_PROVIDER=gemini` · `PHONE_JUDGE_ENABLED=true` · `PHONE_TTS_PROVIDER=sarvam` · context-bound envs back to 32/20. No migration in the entire plan → no data rollback surface.

---

## Open items Codex should specifically check

1. **livekit-plugins-openai 1.6.4 passthrough** for `reasoning_effort`, `max_completion_tokens`, `prompt_cache_key` — if absent, the thin-subclass fallback in WS3/WS5 is required (this is the riskiest unknown; everything else is plumbing we control).
2. Whether the **0060/0065 speakable-plan gates** and the objective cursor make assumptions about prompt wording (e.g. the covered-objective matcher) that the new free-flowing character could weaken — the cursor/controller stays ON, so the plan text and the prompt questions must keep rendering from the same screening_template source.
3. The reply guard's `question_act_count` vs the new "one light beat of banter then a question" style — benchmark showed 8/8 single-question turns for gpt-5-mini, but confirm the guard's regex treats "what a finish! Okay so — tell me about your current work?" as one question act (it counts `?`-terminated acts; the banter beat has none).
4. `phone_judge_runtime_config` hard-fail removal when disabled — confirm no OTHER startup path expects the judge config to be present (grep `judge_config` consumers).
5. Interaction of raised context bounds with the **commit/cursor persistence** path (the Q2-disconnect fix Codex is doing separately) — merge that fix first; this plan assumes it lands.
6. Weight semantics: plan treats array order as ask-order and `weight`/`mandatory` as importance/MUST-ASK. Confirm no other consumer (post-call scorer) treats weight as ordering.
