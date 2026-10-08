import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { R1ScenarioCard } from './R1ScenarioCard';

function card(leadName: string | null = 'Meera Iyer') {
  const view = render(<R1ScenarioCard leadName={leadName} />);
  return { ...view, region: screen.getByRole('region', { name: 'Your role-play' }) };
}

describe('the scenario card', () => {
  it('names the learner the interviewer published', () => {
    const { region } = card('Meera Iyer');
    expect(within(region).getByText('Meera Iyer')).toBeVisible();
    expect(region).not.toHaveTextContent('A prospective learner');
  });

  it('says "A prospective learner" until there is a name, and with the facts all the same', () => {
    const { region } = card(null);
    expect(within(region).getByText('A prospective learner')).toBeVisible();
    expect(region).toHaveTextContent('$9,000');
  });

  it('gives the three course facts as a labelled list', () => {
    const { region } = card();
    const facts = region.querySelector('dl');
    expect(facts).not.toBeNull();
    const terms = [...facts!.querySelectorAll('dt')].map((term) => term.textContent);
    const values = [...facts!.querySelectorAll('dd')].map((value) => value.textContent);
    expect(terms).toEqual(['List price', 'Duration', 'Discounts']);
    expect(values).toEqual([
      '$9,000',
      '6 months',
      '$500, $1,000 or $1,500, depending on the payment plan',
    ]);
  });

  it('introduces the call and the advisor goal', () => {
    const { region } = card();
    expect(region).toHaveTextContent(
      'Filled in a form about the Data Science course. You are the Program Advisor, calling back.',
    );
    expect(region).toHaveTextContent(
      'Your goal: understand their needs, handle their concerns, and agree a clear next step.',
    );
    expect(region).toHaveTextContent(
      'The interviewer stays in character until they say, “Let’s pause the role-play here.”',
    );
  });

  it('shows nothing the candidate is meant to find out for themselves', () => {
    const { region } = card();
    const text = region.textContent ?? '';
    expect(text).not.toMatch(/7,?000/);
    expect(text).not.toMatch(/budget|per month|monthly|afford|timeline|decision|spouse|loan/i);
    expect(text).not.toMatch(/upfront|installment|instalment|lump/i);
  });

  it('is one labelled region with a heading, and nothing live', () => {
    const { region, container } = card();
    expect(within(region).getByRole('heading', { level: 2, name: 'Your role-play' })).toBeVisible();
    expect(container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = card();
    await expect(container).toHaveNoViolations();
  });
});
