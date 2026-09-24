import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateParams } from '../lib/validation.js';
import {
  createRoleSchema,
  roleDraftSchema,
  rephraseQuestionSchema,
  roleIdParamSchema,
  updateRoleSchema,
} from '../schemas/roles.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import {
  cancelRoleDraft,
  readActiveRoleDraft,
  readRoleDraft,
  RoleDraftBusyError,
  startRoleDraft,
} from '../lib/role-draft-jobs.js';
import { rephraseQuestion, RoleDraftError } from '../lib/role-authoring.js';

export const rolesRouter = Router();

// List roles — viewer and above
// Interviewer sees only own records; admin sees all
rolesRouter.get('/', requireRole('viewer'), async (req, res, next) => {
  let q = supabase
    .from('roles')
    .select('*')
    .order('created_at', { ascending: false });

  // Interviewer: filter by owner_id
  if (req.authUser?.appRole === 'interviewer') {
    q = q.eq('owner_id', req.authUser.id);
  }

  const { data, error } = await q;
  if (error) return next(error);
  res.json(data);
});

// ── Ask Hello ────────────────────────────────────────────────────────────
//
// DECLARED BEFORE `GET '/:id'`, AND THAT IS LOAD-BEARING.
//
// Express matches in declaration order, and `/:id` matches ANY single
// segment — including the literal `draft`. With the id route first,
// `GET /api/roles/draft` never reached this handler at all: it landed in
// `/:id`, `roleIdParamSchema` rejected `"draft"` as a non-uuid, and the
// caller got a 400. The client swallows that (a failed resume is not worth
// an error banner), so the symptom was a refresh that silently did not
// resume, and a job that kept billing with nobody watching.
//
// An earlier comment here claimed the two could not collide because "Express
// does not match a `:param` across a `/`". That is true of `/draft/:id`,
// which is two segments — and irrelevant to `/draft`, which is one.

/**
 * Ask Hello — START a drafting job. Answers immediately with its id.
 *
 * NOT a streamed ten-minute response. Drafting runs v4-pro up to three times
 * at 133-206s a call, and tying that to one socket meant nothing survived a
 * refresh, the stream sat silent for a whole model call between phases (so any
 * proxy idle timeout reaped it mid-draft), and Cancel stopped the writes while
 * the generation carried on billing. The work now outlives the request.
 *
 * WRITES NO ROLE. The draft goes to the operator, who reviews it and presses
 * Save — which re-validates everything through the same schema. A generator
 * that wrote directly would be a model authoring a live screening script with
 * no human in between.
 */
rolesRouter.post(
  '/draft',
  requireRole('interviewer'),
  validateBody(roleDraftSchema),
  async (req, res, next) => {
    const { job_role: jobRole } = req.body as { job_role: string };
    try {
      const job = await startRoleDraft(req.authUser!.id, jobRole);
      // AUDITED, but not fail-closed. This writes no role, so a dead audit
      // sink must not block it the way it blocks a mutation — but a
      // privileged, model-invoking action whose output is one Save away from
      // being spoken to a candidate needs a record of who asked for what.
      try {
        await recordAudit(req, 'resource.generate', 202, {
          metadata: { draft_id: job.id, job_role: jobRole },
        });
      } catch {
        /* the draft is not a mutation; an audit sink failure must not lose it */
      }
      res.status(202).json(job);
    } catch (err) {
      // A LIVE DRAFT FOR ANOTHER ROLE IS A CONFLICT, NOT A CRASH. One draft
      // per owner is a real constraint, and the honest answer names the role
      // that is holding it — handing back the other job instead is how a
      // Sales Advisor script ended up in a form headed "Data Engineer".
      if (err instanceof RoleDraftBusyError) {
        return res.status(409).json({
          error: {
            type: 'conflict',
            message: err.message,
            details: { job_role: err.liveJobRole },
          },
        });
      }
      next(err);
    }
  },
);

/**
 * Rewrite ONE question so the phone gate will read it aloud.
 *
 * SYNCHRONOUS, unlike `/draft`. One short sentence comes back in a single
 * short generation, so there is no row, no poll and nothing to cancel — the
 * button sits beside the field it fixes and behaves like it.
 *
 * 422, NOT 500, when the model cannot manage it. "Hello could not rephrase
 * that" is a true statement about a working system; an Internal Server Error
 * would send the operator to look for an outage that is not there.
 */
rolesRouter.post(
  '/questions/rephrase',
  requireRole('interviewer'),
  validateBody(rephraseQuestionSchema),
  async (req, res, next) => {
    const { question } = req.body as { question: string };
    try {
      const rephrased = await rephraseQuestion(question);
      try {
        await recordAudit(req, 'resource.generate', 200, {
          metadata: { action: 'question_rephrase' },
        });
      } catch {
        /* as with /draft: this writes no role, so a dead sink must not lose it */
      }
      res.json({ question: rephrased });
    } catch (err) {
      if (err instanceof RoleDraftError) {
        // THE OFFENDING WORD TRAVELS. `rephraseQuestion` works out exactly
        // which banned word the text uses, and dropping it here left a TA
        // recruiter who wrote "applicant tracking system" with "Hello could
        // not rephrase that" and no clue which word `META_RE` refuses — the
        // wording trap this button exists for.
        const detail = err.detail?.[0];
        return res.status(422).json({
          error: {
            type: 'unprocessable_entity',
            message: detail ? `${err.message} It says ${detail}.` : err.message,
            details: { reason: err.reason },
          },
        });
      }
      next(err);
    }
  },
);

/**
 * The caller's LIVE drafting job, if they have one.
 *
 * This is what a reload asks. The browser keeps the job id in component state
 * and nowhere else, so a refresh, a navigation, or switching to another role
 * in the list loses the only handle to a job that keeps running and keeps
 * billing — and the finished draft would land in a row nobody could name.
 * The row is the durable copy, which is the whole reason this stopped being a
 * streamed response; this endpoint is how the client gets back to it.
 *
 * Declared BEFORE `/draft/:id` for readability only — Express does not match
 * a `:param` across a `/`, so the two cannot shadow each other.
 */
rolesRouter.get('/draft', requireRole('interviewer'), async (req, res, next) => {
  try {
    const job = await readActiveRoleDraft(req.authUser!.id);
    // 200 with an explicit null rather than 404: "you have no draft running"
    // is a normal answer to this question, not a missing resource.
    res.json({ active: job });
  } catch (err) {
    next(err);
  }
});

/** Poll a drafting job. A dead one reads as failed, never as still running. */
rolesRouter.get(
  '/draft/:id',
  requireRole('interviewer'),
  validateParams(roleIdParamSchema),
  async (req, res, next) => {
    try {
      const job = await readRoleDraft(req.authUser!.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'Draft not found' });
      res.json(job);
    } catch (err) {
      next(err);
    }
  },
);

/** Stop a running job. The generator reads this between attempts. */
rolesRouter.post(
  '/draft/:id/cancel',
  requireRole('interviewer'),
  validateParams(roleIdParamSchema),
  async (req, res, next) => {
    try {
      const cancelled = await cancelRoleDraft(req.authUser!.id, req.params.id);
      // Idempotent: cancelling a job that already finished is not an error,
      // it is a race the operator cannot be blamed for.
      res.json({ cancelled });
    } catch (err) {
      next(err);
    }
  },
);

// Get one role — viewer and above
// Interviewer sees only own records; admin sees all
rolesRouter.get('/:id', requireRole('viewer'), validateParams(roleIdParamSchema), async (req, res) => {
  let q = supabase
    .from('roles')
    .select('*')
    .eq('id', req.params.id);

  // Interviewer: must own the record
  if (req.authUser?.appRole === 'interviewer') {
    q = q.eq('owner_id', req.authUser.id);
  }

  const { data, error } = await q.single();
  if (error) return res.status(404).json({ error: 'Role not found' });
  res.json(data);
});

// Create role (with screening template) — interviewer and above
// Stamps owner_id from the authenticated user
rolesRouter.post('/', requireRole('interviewer'), validateBody(createRoleSchema), async (req, res, next) => {
  const { title, agent_name, jd, required_skills, screening_template, interviewer_instructions } =
    req.body;
  const ownerId = req.authUser!.id;

  const { data, error } = await supabase
    .from('roles')
    .insert({
      title,
      // Blank stores as NULL so "unset" has one representation, matching `jd`
      // and the column's own check constraint — but the KEY IS OMITTED
      // ENTIRELY when the client did not send the field.
      //
      // `agent_name?.trim() ? … : null` put the key in the payload on EVERY
      // create, which defeated the client-side guard completely: if the API
      // ships before `supabase db push` of 0100, PostgREST rejects the unknown
      // column (PGRST204) and every role creation 500s — including for the
      // roles that never wanted an agent name, which is all of them. The PATCH
      // below was already conditional; this was not.
      ...(agent_name === undefined
        ? {}
        : { agent_name: agent_name?.trim() ? agent_name.trim() : null }),
      jd: jd ?? null,
      required_skills: required_skills ?? [],
      screening_template: screening_template ?? [],
      interviewer_instructions: interviewer_instructions ?? '',
      owner_id: ownerId,
    })
    .select()
    .single();
  if (error) return next(error);

  // Audit: record resource creation (fail-closed — if audit fails, mutation is aborted)
  try {
    await recordAudit(req, 'resource.create', 201, {
      metadata: { role_id: data.id, title },
    });
  } catch {
    // Audit sink failure with fail-closed policy; abort the mutation
    return res.status(500).json({
      error: { type: 'internal_error', message: 'Internal server error' },
    });
  }

  res.status(201).json(data);
});

// Update role — interviewer and above
// Interviewer can only update own records; admin sees all
rolesRouter.put(
  '/:id',
  requireRole('interviewer'),
  validateParams(roleIdParamSchema),
  validateBody(updateRoleSchema),
  async (req, res, next) => {
    const { title, agent_name, jd, required_skills, screening_template, interviewer_instructions, is_active } =
      req.body;
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (agent_name !== undefined) patch.agent_name = agent_name?.trim() ? agent_name.trim() : null;
    if (jd !== undefined) patch.jd = jd;
    if (required_skills !== undefined) patch.required_skills = required_skills;
    if (screening_template !== undefined) patch.screening_template = screening_template;
    if (interviewer_instructions !== undefined) patch.interviewer_instructions = interviewer_instructions;
    if (is_active !== undefined) patch.is_active = is_active;

    let q = supabase
      .from('roles')
      .update(patch)
      .eq('id', req.params.id);

    // Interviewer: must own the record
    if (req.authUser?.appRole === 'interviewer') {
      q = q.eq('owner_id', req.authUser.id);
    }

    const { data, error } = await q.select().single();
    if (error) return next(error);
    if (!data) return res.status(404).json({ error: 'Role not found' });

    // Audit: record resource update (fail-closed)
    try {
      await recordAudit(req, 'resource.update', 200, {
        metadata: { role_id: req.params.id },
      });
    } catch {
      return res.status(500).json({
        error: { type: 'internal_error', message: 'Internal server error' },
      });
    }

    res.json(data);
  },
);

/**
 * Remove a role — by ARCHIVING it when anything depends on it, and only
 * deleting outright when nothing does.
 *
 * WHY NOT A PLAIN DELETE. `screening_v2.roles` is referenced six ways, and the
 * foreign keys disagree about what should happen:
 *
 *   candidates.role_id          on delete SET NULL
 *   sessions.role_id            on delete SET NULL
 *   assessments / phone rows    on delete SET NULL
 *   role_scorecards             on delete CASCADE
 *   ashby_job_mappings.role_id  on delete RESTRICT   (and NOT NULL)
 *
 * So a hard delete would silently detach every candidate who ever applied for
 * this job from the job they applied for — the record would still exist and
 * would no longer say what it was for — and it would cascade away the
 * scorecard the historical assessments were scored against. That is not a
 * delete, it is quiet history loss, and "poor product management" is the
 * charge this endpoint is answering rather than earning.
 *
 * The rule, therefore:
 *   - referenced by an Ashby mapping -> 409, name it, change nothing. The
 *     database would refuse anyway (RESTRICT); answering with the reason is
 *     more useful than surfacing a constraint error.
 *   - referenced by candidates or call sessions -> ARCHIVE
 *     (`is_active = false`). It is marked Inactive and stops being offered
 *     anywhere new, and every historical record still says which job it
 *     belonged to. It does NOT leave the roles list — `GET /api/roles` has no
 *     `is_active` filter — so the response names the outcome and the client
 *     is what tells the operator.
 *   - referenced by nothing -> DELETE. A role created by mistake, or an Ask
 *     Hello draft saved and thought better of, genuinely goes away.
 *
 * The response says which of the three happened, because "gone from the list"
 * looks identical to the operator and the difference matters when they come
 * back looking for it.
 */
rolesRouter.delete(
  '/:id',
  requireRole('interviewer'),
  validateParams(roleIdParamSchema),
  async (req, res, next) => {
    const roleId = req.params.id;
    const isInterviewer = req.authUser?.appRole === 'interviewer';

    // OWNERSHIP FIRST, and as its own read. Every branch below has to be
    // scoped to a role this caller may touch, and doing it once here keeps a
    // later branch from forgetting.
    let owned = supabase.from('roles').select('id').eq('id', roleId);
    if (isInterviewer) owned = owned.eq('owner_id', req.authUser!.id);
    const { data: role, error: roleError } = await owned.maybeSingle();
    if (roleError) return next(roleError);
    if (!role) return res.status(404).json({ error: 'Role not found' });

    // An Ashby mapping is a hard stop in the database, so it is a hard stop
    // here — with the reason spelled out rather than a 500 from a constraint.
    const { count: mappingCount, error: mappingError } = await supabase
      .from('ashby_job_mappings')
      .select('id', { count: 'exact', head: true })
      .eq('role_id', roleId);
    if (mappingError) return next(mappingError);
    if ((mappingCount ?? 0) > 0) {
      return res.status(409).json({
        error: {
          type: 'conflict',
          message:
            'This role is mapped to an Ashby job. Remove the mapping in Ashby Mission Control first.',
        },
      });
    }

    const { count: candidateCount, error: candidateError } = await supabase
      .from('candidates')
      .select('id', { count: 'exact', head: true })
      .eq('role_id', roleId);
    if (candidateError) return next(candidateError);

    // `call_sessions`, NOT `sessions`. There is no `screening_v2.sessions`;
    // every other call site in this API says `call_sessions`, and this route
    // was the only `from('sessions')` in it. PostgREST answers PGRST205, the
    // error propagates, and EVERY delete and archive returned 500 — the
    // feature was inert 100% of the time. The unit test pinned the same wrong
    // name in its table map, which is precisely why CI was green.
    const { count: sessionCount, error: sessionError } = await supabase
      .from('call_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('role_id', roleId);
    if (sessionError) return next(sessionError);

    const referenced = (candidateCount ?? 0) > 0 || (sessionCount ?? 0) > 0;

    if (referenced) {
      let archive = supabase.from('roles').update({ is_active: false }).eq('id', roleId);
      if (isInterviewer) archive = archive.eq('owner_id', req.authUser!.id);
      const { data, error } = await archive.select('id').maybeSingle();
      if (error) return next(error);
      if (!data) return res.status(404).json({ error: 'Role not found' });
      try {
        await recordAudit(req, 'resource.update', 200, {
          metadata: { role_id: roleId, action: 'archive' },
        });
      } catch {
        return res.status(500).json({
          error: { type: 'internal_error', message: 'Internal server error' },
        });
      }
      return res.json({
        outcome: 'archived',
        reason: 'candidates_or_sessions_exist',
        candidates: candidateCount ?? 0,
        sessions: sessionCount ?? 0,
      });
    }

    let remove = supabase.from('roles').delete().eq('id', roleId);
    if (isInterviewer) remove = remove.eq('owner_id', req.authUser!.id);
    const { data: deleted, error: deleteError } = await remove.select('id').maybeSingle();
    if (deleteError) return next(deleteError);
    if (!deleted) return res.status(404).json({ error: 'Role not found' });

    // AUDITED FAIL-CLOSED, like every other mutation here: a delete whose
    // record was lost is the one an operator will most want to look up.
    try {
      await recordAudit(req, 'resource.delete', 200, {
        metadata: { role_id: roleId },
      });
    } catch {
      return res.status(500).json({
        error: { type: 'internal_error', message: 'Internal server error' },
      });
    }

    return res.json({ outcome: 'deleted' });
  },
);
