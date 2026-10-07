import type { R1LeadCard } from '../../lib/r1/r1-api';

interface R1LeadCardViewProps {
  /** The lead's name and city, or null when the server did not provide them. */
  lead: R1LeadCard | null;
}

/**
 * The role-play lead card (plan decision D8). It repeats, on screen, what the
 * interviewer said when the role-play was announced, so a candidate who missed
 * a sentence can still tell who they are calling and why. It carries no
 * product facts: those come only from the candidate's own preparation guide.
 */
export function R1LeadCardView({ lead }: R1LeadCardViewProps) {
  return (
    <section className="candidate-glass-card r1-lead" aria-labelledby="r1-lead-title">
      <h2 id="r1-lead-title">Your role-play</h2>
      <p className="r1-lead__who">
        {lead ? `${lead.name} from ${lead.city}` : 'A prospective learner'}
      </p>
      <p>
        They filled in a form on our website about the Data Science course a few days ago.
        You are the Program Advisor, calling them back.
      </p>
      <p>
        Understand their needs and help them reach a decision, as you would on a real call,
        using the course details from your preparation guide.
      </p>
      <p>
        The interviewer stays in character until they say, “Let’s pause the role-play here.”
      </p>
    </section>
  );
}
