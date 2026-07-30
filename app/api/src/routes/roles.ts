import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateParams } from '../lib/validation.js';
import { createRoleSchema, updateRoleSchema, roleIdParamSchema } from '../schemas/roles.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';

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

// Create role (with screening template) — interviewer and above
// Stamps owner_id from the authenticated user
rolesRouter.post('/', requireRole('interviewer'), validateBody(createRoleSchema), async (req, res, next) => {
  const { title, jd, required_skills, screening_template } = req.body;
  const ownerId = req.authUser!.id;

  const { data, error } = await supabase
    .from('roles')
    .insert({
      title,
      jd: jd ?? null,
      required_skills: required_skills ?? [],
      screening_template: screening_template ?? [],
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
    const { title, jd, required_skills, screening_template, is_active } = req.body;
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (jd !== undefined) patch.jd = jd;
    if (required_skills !== undefined) patch.required_skills = required_skills;
    if (screening_template !== undefined) patch.screening_template = screening_template;
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
