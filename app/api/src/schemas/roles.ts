import { z } from 'zod';
import { idParamSchema } from './common.js';
import { phoneQuestionIssueMessage, validatePhoneQuestionTemplate } from '../lib/phone-screening/question-validation.js';

const screeningQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    question: z.string().trim().min(1).max(2_000),
    weight: z.number().finite().nonnegative().max(100).optional(),
    follow_up_hint: z.string().trim().max(2_000).optional(),
    mandatory: z.boolean().optional(),
  })
  .strict();

/**
 * Ask Hello's input. Just the job title — everything else is what it produces.
 *
 * Bounded at the same 200 as `title`, because that is what it will become.
 */
export const roleDraftSchema = z
  .object({ job_role: z.string().trim().min(1, 'job_role is required').max(200) })
  .strict();

export type RoleDraftInput = z.infer<typeof roleDraftSchema>;

export const createRoleSchema = z
  .object({
    title: z.string().trim().min(1, 'title is required').max(200),
    // Operator-facing label, never spoken. 80 to match the column's check
    // constraint — a longer value must fail here, not as a database error.
    // EMPTY BECOMES NULL rather than passing through. `roles.agent_name`
    // carries `check (length between 1 and 80)`, so a bare `.max(80)` lets ""
    // through zod and into a database constraint violation — a 500 where the
    // caller deserves the same answer the form already gives: a blank box
    // means there is no agent name, not that there is one of length zero.
    agent_name: z
      .string()
      .trim()
      .max(80)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    jd: z.string().max(100_000).nullable().optional(),
    required_skills: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    screening_template: z.array(screeningQuestionSchema).max(100).optional(),
    interviewer_instructions: z.string().trim().max(10_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.screening_template) return;
    for (const [index, issues] of validatePhoneQuestionTemplate(value.screening_template)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screening_template', index, 'question'], message: phoneQuestionIssueMessage(index, issues) });
    }
  });

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    // EMPTY BECOMES NULL rather than passing through. `roles.agent_name`
    // carries `check (length between 1 and 80)`, so a bare `.max(80)` lets ""
    // through zod and into a database constraint violation — a 500 where the
    // caller deserves the same answer the form already gives: a blank box
    // means there is no agent name, not that there is one of length zero.
    agent_name: z
      .string()
      .trim()
      .max(80)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    jd: z.string().max(100_000).nullable().optional(),
    required_skills: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    screening_template: z.array(screeningQuestionSchema).max(100).optional(),
    interviewer_instructions: z.string().trim().max(10_000).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  })
  .superRefine((value, ctx) => {
    if (!value.screening_template) return;
    for (const [index, issues] of validatePhoneQuestionTemplate(value.screening_template)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screening_template', index, 'question'], message: phoneQuestionIssueMessage(index, issues) });
    }
  });

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const roleIdParamSchema = idParamSchema;
