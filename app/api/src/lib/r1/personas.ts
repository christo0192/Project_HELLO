/**
 * Who the AI learner was, for the staff review page.
 *
 * The worker owns the personas (`app/voice-livekit/r1_personas.py`) and picks the surface variant
 * at run time: `interview_round_attempts.persona_variant` keeps its column default, and the variant
 * actually used is pinned on every `r1_admin_log` row (`payload.pins.persona_variant`). This is a
 * copy of the names and labels ONLY, because the API cannot read the worker's file at run time;
 * `r1-personas-sync.test.ts` fails the build when the two disagree.
 *
 * Nothing else about a persona is here. Its needs and objection plan are what the candidate is
 * assessed on finding out.
 */

export interface R1PersonaNames {
  readonly label: string;
  readonly variants: Readonly<Record<string, string>>;
}

export const R1_PERSONAS: Readonly<Record<string, R1PersonaNames>> = Object.freeze({
  p1_career_switcher: {
    label: 'Career switcher',
    variants: { v1: 'Meera Iyer', v2: 'Priya Nair', v3: 'Divya Shah' },
  },
  p2_recent_grad: {
    label: 'Recent graduate',
    variants: { v1: 'Ananya Rao', v2: 'Neha Singh', v3: 'Pooja Gupta' },
  },
  p3_data_analyst: {
    label: 'Working data analyst',
    variants: { v1: 'Kavya Menon', v2: 'Sneha Pillai', v3: 'Ritu Kapoor' },
  },
  p4_research_scholar: {
    label: 'Research scholar',
    variants: { v1: 'Shalini Verma', v2: 'Anjali Joshi', v3: 'Nisha Reddy' },
  },
});

const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** "Career switcher", or null for a persona this build does not know. */
export function r1PersonaLabel(personaId: string): string | null {
  return own(R1_PERSONAS, personaId) ? R1_PERSONAS[personaId].label : null;
}

/** "Priya Nair", or null when the variant is unknown: a wrong name is worse than the plain label. */
export function r1LearnerName(personaId: string, variantId: string | null): string | null {
  if (variantId === null || !own(R1_PERSONAS, personaId)) return null;
  const { variants } = R1_PERSONAS[personaId];
  return own(variants, variantId) ? variants[variantId] : null;
}
