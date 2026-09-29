import { describe, expect, it } from 'vitest';
import { agentLabel, agentWithRoleLabel, roleAgentName, uniqueAgentLabels } from './role-label';

const role = (id: string, title: string, agent_name?: string | null) => ({ id, title, agent_name });

describe('role labels', () => {
  it('leads with the agent name and falls back to the title', () => {
    expect(agentLabel(role('a', 'Intern Talent Acquisition', 'TA-Intern calling bot'))).toBe('TA-Intern calling bot');
    expect(agentLabel(role('b', 'Program Advisor', null))).toBe('Program Advisor');
    expect(agentLabel(role('c', 'Program Advisor'))).toBe('Program Advisor');
  });

  it('treats a blank agent name as absent, never as a blank label', () => {
    expect(roleAgentName(role('a', 'Sales', '   '))).toBeNull();
    expect(agentLabel(role('a', 'Sales', '   '))).toBe('Sales');
    expect(agentLabel(role('a', 'Sales', '  Nova  '))).toBe('Nova');
  });

  it('renders "Agent (Role)" only when there is an agent name', () => {
    expect(agentWithRoleLabel(role('a', 'Intern Talent Acquisition', 'TA-Intern calling bot')))
      .toBe('TA-Intern calling bot (Intern Talent Acquisition)');
    expect(agentWithRoleLabel(role('b', 'Program Advisor', null))).toBe('Program Advisor');
  });

  it('keeps duplicate labels distinguishable, keyed by id, in list order', () => {
    const labels = uniqueAgentLabels([
      role('r1', 'Sales Program Advisor', null),
      role('r2', 'Sales Program Advisor', 'Test v1'),
      role('r3', 'Sales Program Advisor', null),
      role('r4', 'Other', 'Test v1'),
    ]);
    expect(labels.get('r1')).toBe('Sales Program Advisor');
    expect(labels.get('r2')).toBe('Test v1');
    expect(labels.get('r3')).toBe('Sales Program Advisor (2)');
    expect(labels.get('r4')).toBe('Test v1 (2)');
  });
});
