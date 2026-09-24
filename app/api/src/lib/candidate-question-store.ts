/**
 * The service-role adapter behind `CandidateQuestionsStore`.
 *
 * Separated from the handler so the decision logic — regenerate or not, retry
 * or record — is testable against a fake rather than against a mocked query
 * builder, and so this file can be read as exactly what it is: four reads and
 * one upsert.
 *
 * READS ARE DELIBERATELY NOT A JOIN. Supabase's embedded-resource syntax would
 * fetch the link, engagement, candidate and role in one round trip, but it
 * returns a shape that changes with the FK graph and is silently empty when a
 * relationship name is wrong — the class of defect that shipped a route
 * querying a table called `sessions` that has never existed. Four explicit
 * reads cost four cheap primary-key lookups on a background job and fail
 * loudly on the exact hop that broke.
 */
import { supabase } from './supabase.js';
import type {
  CandidateQuestionsContext,
  CandidateQuestionsStore,
} from './candidate-question-jobs.js';
import type { CandidateTemplateQuestion } from './candidate-questions.js';

/** The engagement states after which no call will ever happen. */
const TERMINAL_STATES = new Set([
  'completed',
  'abandoned_no_answer',
  'opted_out',
  'wrong_number',
  'failed',
  'cancelled',
]);

function asTemplate(value: unknown): CandidateTemplateQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: CandidateTemplateQuestion[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const question = typeof row.question === 'string' ? row.question : '';
    if (!id || !question) continue;
    out.push({
      id,
      question,
      ...(typeof row.weight === 'number' ? { weight: row.weight } : {}),
      ...(typeof row.follow_up_hint === 'string' ? { follow_up_hint: row.follow_up_hint } : {}),
      ...(typeof row.mandatory === 'boolean' ? { mandatory: row.mandatory } : {}),
      // Carried through UNVALIDATED against the category enum on purpose: this
      // is a read of what is stored, and `variableSlots` matches the two names
      // it cares about exactly. A category the code does not know simply is not
      // a variable slot, which is the correct treatment for one.
      ...(typeof row.category === 'string'
        ? { category: row.category as CandidateTemplateQuestion['category'] }
        : {}),
    });
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * `client` is typed off the process singleton rather than as a bare
 * `SupabaseClient`, because the singleton is created with an explicit schema
 * and its generic parameters do not match the library's defaults. Writing the
 * default here compiled until it was called with the real client.
 */
export function createCandidateQuestionStore(
  client: typeof supabase = supabase,
): CandidateQuestionsStore {
  return {
    async loadContext(applicationLinkId): Promise<CandidateQuestionsContext | null> {
      const { data: engagement, error: engagementError } = await client
        .from('phone_engagements')
        .select('id,role_id,candidate_id,state')
        .eq('application_link_id', applicationLinkId)
        .maybeSingle();
      if (engagementError) throw new Error('candidate_questions_engagement_read_error');
      if (!engagement) return null;

      const engagementId = String((engagement as Record<string, unknown>).id);
      const roleId = ((engagement as Record<string, unknown>).role_id as string | null) ?? null;
      const state = String((engagement as Record<string, unknown>).state ?? '');
      if (!roleId) {
        // Nothing to personalise against and nothing to splice into. Reported
        // as missing context rather than as a failure, because an engagement
        // with no role is a prerequisite problem, not a generation one.
        return null;
      }

      const { data: role, error: roleError } = await client
        .from('roles')
        .select('title,jd,required_skills,screening_template')
        .eq('id', roleId)
        .maybeSingle();
      if (roleError) throw new Error('candidate_questions_role_read_error');
      if (!role) return null;
      const roleRow = role as Record<string, unknown>;

      // The candidate comes off the ENGAGEMENT row read above, not off the
      // application link. The generated questions are keyed on the engagement,
      // so they must describe the person that engagement is about — a link
      // whose candidate was re-bound must not produce questions about whoever
      // it pointed at first.
      const candidateId =
        ((engagement as Record<string, unknown>).candidate_id as string | null) ?? null;

      let resume: unknown = null;
      if (candidateId) {
        const { data: candidate, error: candidateError } = await client
          .from('candidates')
          .select('parsed')
          .eq('id', candidateId)
          .maybeSingle();
        if (candidateError) throw new Error('candidate_questions_candidate_read_error');
        resume = (candidate as Record<string, unknown> | null)?.parsed ?? null;
      }

      const { data: existing, error: existingError } = await client
        .from('candidate_screening_questions')
        .select('status,template_hash')
        .eq('engagement_id', engagementId)
        .maybeSingle();
      if (existingError) throw new Error('candidate_questions_row_read_error');

      return {
        engagementId,
        roleId,
        engagementTerminal: TERMINAL_STATES.has(state),
        roleTitle: typeof roleRow.title === 'string' ? roleRow.title : '',
        jd: typeof roleRow.jd === 'string' ? roleRow.jd : null,
        requiredSkills: asStringArray(roleRow.required_skills),
        template: asTemplate(roleRow.screening_template),
        resume,
        existing: existing
          ? {
              status: String((existing as Record<string, unknown>).status ?? ''),
              templateHash:
                ((existing as Record<string, unknown>).template_hash as string | null) ?? null,
            }
          : null,
      };
    },

    async writeReady(input): Promise<void> {
      const { error } = await client
        .from('candidate_screening_questions')
        .upsert(
          {
            engagement_id: input.engagementId,
            role_id: input.roleId,
            status: 'ready',
            questions: input.questions,
            template_hash: input.templateHash,
            model: input.model,
            error_reason: null,
            generated_at: new Date().toISOString(),
          },
          { onConflict: 'engagement_id' },
        );
      if (error) throw new Error('candidate_questions_write_error');
    },

    async writeFailed(input): Promise<void> {
      const { error } = await client
        .from('candidate_screening_questions')
        .upsert(
          {
            engagement_id: input.engagementId,
            role_id: input.roleId,
            status: 'failed',
            // The previous set, if any, is CLEARED rather than kept. A stored
            // `failed` row still holding last week's questions would be read
            // by nothing — 0103 keys on `status = 'ready'` — but it would mean
            // an operator looking at the table sees questions beside a failure,
            // and the table's whole job is to make that state legible.
            questions: null,
            template_hash: null,
            error_reason: input.reason,
            generated_at: null,
          },
          { onConflict: 'engagement_id' },
        );
      if (error) throw new Error('candidate_questions_write_error');
    },
  };
}
