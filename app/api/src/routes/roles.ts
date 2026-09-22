import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateParams } from '../lib/validation.js';
import { createRoleSchema, updateRoleSchema, roleIdParamSchema } from '../schemas/roles.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import {
  cancelRoleDraft,
  readActiveRoleDraft,
  readRoleDraft,
  startRoleDraft,
} from '../lib/role-draft-jobs.js';
import { roleDraftSchema } from '../schemas/roles.js';

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
      // and the column's own check constraint.
      agent_name: agent_name?.trim() ? agent_name.trim() : null,
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
