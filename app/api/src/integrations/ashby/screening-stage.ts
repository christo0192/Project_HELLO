/**
 * ashby/screening-stage.ts — the one Ashby interview stage the bot screens in.
 */

/**
 * The Hello Christy AI screening stage.
 *
 * OWNER DECISION (2026-09-29): this is the ONLY Ashby stage the bot screens
 * in, so every NEW mapping uses it as BOTH its AI screening stage and its TA
 * screening stage. The Mission Control "Add mapping" form therefore stops
 * asking for stage ids at all; `POST /mappings` fills this in on create when
 * the caller sends none. An explicit, valid stage id is still honoured, and an
 * UPDATE never has it applied (the upsert RPC keeps a mapping's current stage
 * ids when it is sent null).
 *
 * WHY AI = TA IS SAFE: the TA stage id is read in exactly one place — the
 * enable-time completeness gate (the `chk_ashby_job_mappings_enabled_completeness`
 * CHECK and `set_ashby_mapping_status`), which only asks that both ids be
 * present. Nothing moves a candidate INTO the TA stage — the operation worker
 * never claims a `stage_move` (operation-worker.ts) — and admission keys on
 * the AI stage alone. Giving the TA slot the AI stage's id satisfies the gate
 * without pointing any action at a second stage.
 *
 * It is an opaque tenant id (it matches the route's opaque-id pattern) and is
 * not a secret; it identifies configuration, never a candidate.
 */
export const HELLO_CHRISTY_SCREENING_STAGE_ID = '2358dbcc-394f-45d5-90e4-2bc9af468740';
