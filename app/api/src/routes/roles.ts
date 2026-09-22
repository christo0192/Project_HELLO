import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateParams } from '../lib/validation.js';
import { createRoleSchema, updateRoleSchema, roleIdParamSchema } from '../schemas/roles.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import {
  generateRoleDraft,
  RoleDraftError,
  ROLE_DRAFT_MAX_ATTEMPTS,
} from '../lib/role-authoring.js';
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
 * Ask Hello — draft a role from a job title. STREAMS NDJSON.
 *
 * One JSON object per line: `{type:"progress",...}` as each phase begins, then
 * exactly one terminal `{type:"draft"}` or `{type:"error"}`.
 *
 * WHY A STREAM AND NOT A PLAIN 200. v4-pro takes 133-206s per call and this
 * retries up to three times, so a single response can be silent for the better
 * part of ten minutes — indistinguishable from a hang. NDJSON over `fetch`
 * rather than SSE because `EventSource` cannot carry this API's Authorization
 * header, and inventing a second auth path for a progress bar would be a
 * security change disguised as a UX one.
 *
 * NOTHING IS WRITTEN. This endpoint returns a draft for the form to show; the
 * operator still presses Save, which re-validates everything through the same
 * schema. A generator that wrote directly would be a model authoring a live
 * screening script with no human in between.
 */
rolesRouter.post(
  '/draft',
  requireRole('interviewer'),
  validateBody(roleDraftSchema),
  async (req, res) => {
    const { job_role: jobRole } = req.body as { job_role: string };

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // Fly's proxy and nginx both buffer by default, which would hold every
    // progress line until the response ended — defeating the point.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let clientGone = false;
    res.on('close', () => {
      clientGone = true;
    });

    const write = (payload: unknown) => {
      if (clientGone) return;
      res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const { draft, attempts, repaired } = await generateRoleDraft(jobRole, {
        onProgress: (event) => write({ type: 'progress', ...event }),
      });
      write({ type: 'draft', draft, attempts, repaired });
    } catch (err) {
      // A stream that has already sent 200 cannot change its status, so the
      // failure is carried IN the stream and the client must read it there.
      if (err instanceof RoleDraftError) {
        write({
          type: 'error',
          reason: err.reason,
          message: err.message,
          detail: err.detail ?? [],
          maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS,
        });
      } else {
        write({
          type: 'error',
          reason: 'provider_unavailable',
          message: 'Hello could not be reached. Try again in a moment.',
          detail: [],
          maxAttempts: ROLE_DRAFT_MAX_ATTEMPTS,
        });
      }
    } finally {
      if (!clientGone) res.end();
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
