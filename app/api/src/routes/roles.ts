import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateParams } from '../lib/validation.js';
import { createRoleSchema, updateRoleSchema, roleIdParamSchema } from '../schemas/roles.js';

export const rolesRouter = Router();

// List roles
rolesRouter.get('/', async (_req, res, next) => {
  const { data, error } = await supabase
    .from('roles')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return next(error);
  res.json(data);
});

// Get one role
rolesRouter.get('/:id', validateParams(roleIdParamSchema), async (req, res) => {
  const { data, error } = await supabase.from('roles').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Role not found' });
  res.json(data);
});

// Create role (with screening template)
rolesRouter.post('/', validateBody(createRoleSchema), async (req, res, next) => {
  const { title, jd, required_skills, screening_template } = req.body;
  const { data, error } = await supabase
    .from('roles')
    .insert({
      title,
      jd: jd ?? null,
      required_skills: required_skills ?? [],
      screening_template: screening_template ?? [],
    })
    .select()
    .single();
  if (error) return next(error);
  res.status(201).json(data);
});

// Update role
rolesRouter.put(
  '/:id',
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
    const { data, error } = await supabase
      .from('roles')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return next(error);
    res.json(data);
  },
);
