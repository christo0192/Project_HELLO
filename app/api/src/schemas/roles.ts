import { z } from 'zod';
import { idParamSchema } from './common.js';

const screeningQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    question: z.string().trim().min(1).max(2_000),
    weight: z.number().finite().nonnegative().max(100).optional(),
    follow_up_hint: z.string().trim().max(2_000).optional(),
    mandatory: z.boolean().optional(),
  })
  .strict();

export const createRoleSchema = z
  .object({
    title: z.string().trim().min(1, 'title is required').max(200),
    jd: z.string().max(100_000).nullable().optional(),
    required_skills: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    screening_template: z.array(screeningQuestionSchema).max(100).optional(),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    jd: z.string().max(100_000).nullable().optional(),
    required_skills: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    screening_template: z.array(screeningQuestionSchema).max(100).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  });

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const roleIdParamSchema = idParamSchema;
