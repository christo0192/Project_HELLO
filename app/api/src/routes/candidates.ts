import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateQuery, validateParams } from '../lib/validation.js';
import { listCandidatesQuerySchema, candidateIdParamSchema } from '../schemas/candidates.js';

export const candidatesRouter = Router();

// List candidates (optionally by role)
candidatesRouter.get('/', validateQuery(listCandidatesQuerySchema), async (req, res, next) => {
  let q = supabase
    .from('candidates')
    .select(
      'id,name,email,phone_e164,phone_valid,skills,experience_years,status,role_id,created_at',
    )
    .order('created_at', { ascending: false });
  if (req.query.role_id) q = q.eq('role_id', req.query.role_id as string);
  const { data, error } = await q;
  if (error) return next(error);
  res.json(data);
});

// Candidate detail incl. latest assessment + session list
candidatesRouter.get('/:id', validateParams(candidateIdParamSchema), async (req, res) => {
  const { data: candidate, error } = await supabase
    .from('candidates')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Candidate not found' });

  const { data: sessions } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('candidate_id', req.params.id)
    .order('started_at', { ascending: false });

  const { data: assessments } = await supabase
    .from('assessments')
    .select('*')
    .eq('candidate_id', req.params.id)
    .order('created_at', { ascending: false });

  res.json({ candidate, sessions: sessions ?? [], assessments: assessments ?? [] });
});
