import { R1_SCENARIO_COPY } from './r1-scenario';

interface R1ScenarioCardProps {
  /** The learner's name as the interviewer published it, or null before it has. */
  leadName: string | null;
  /**
   * The strip the card shrinks to once the role-play is on: who, and the three course facts. The
   * briefing shows the whole card; the role-play is where the captions are read, and the full card
   * would take a third of a laptop's column from them.
   */
  compact?: boolean;
}

/**
 * The role-play scenario card (plan decision D8). It repeats, on screen, what the interviewer
 * said when the role-play was announced, so a candidate who missed a sentence can still tell
 * who they are calling, what the course costs and what they are there to do.
 *
 * The three course facts are the preparation guide's own (see r1-scenario.ts, whose test keeps
 * them equal to the interviewer's and the scorer's). The card never says which discount goes
 * with which payment plan, and never shows anything about the learner beyond their name: their
 * budget, needs and timeline are what the candidate is assessed on finding out.
 */
export function R1ScenarioCard({ leadName, compact = false }: R1ScenarioCardProps) {
  return (
    <section
      className={`candidate-glass-card r1-scenario${compact ? ' r1-scenario--compact' : ''}`}
      aria-labelledby="r1-scenario-title"
    >
      <h2 id="r1-scenario-title">{R1_SCENARIO_COPY.heading}</h2>
      <p className="r1-scenario__who">{leadName ?? R1_SCENARIO_COPY.unnamedLearner}</p>
      {!compact && <p>{R1_SCENARIO_COPY.intro}</p>}
      <dl className="r1-scenario__facts">
        <dt>{R1_SCENARIO_COPY.priceLabel}</dt>
        <dd>{R1_SCENARIO_COPY.price}</dd>
        <dt>{R1_SCENARIO_COPY.durationLabel}</dt>
        <dd>{R1_SCENARIO_COPY.duration}</dd>
        <dt>{R1_SCENARIO_COPY.discountsLabel}</dt>
        <dd>{R1_SCENARIO_COPY.discounts}</dd>
      </dl>
      {!compact && <p className="r1-scenario__goal">{R1_SCENARIO_COPY.goal}</p>}
      {!compact && <p className="r1-scenario__note">{R1_SCENARIO_COPY.inCharacter}</p>}
    </section>
  );
}
