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

  describe('uniqueAgentLabels', () => {
    it('leaves labels that are already unique exactly as agentLabel gives them', () => {
      const labels = uniqueAgentLabels([
        role('r1', 'Sales Program Advisor', 'Gopu'),
        role('r2', 'Support', null),
      ]);
      expect([...labels.values()]).toEqual(['Gopu', 'Support']);
    });

    it('names the ROLE when two agents share a name, in the usual "Agent (Role)" form', () => {
      const labels = uniqueAgentLabels([
        role('r1', 'Ops', 'Gopu'),
        role('r2', 'Finance', 'Gopu'),
      ]);
      // Not "Gopu" and "Gopu (2)", which says nothing about which is which.
      expect(labels.get('r1')).toBe('Gopu (Ops)');
      expect(labels.get('r2')).toBe('Gopu (Finance)');
    });

    it('numbers title-only duplicates after a middle dot — never a bracket that reads as a role', () => {
      const labels = uniqueAgentLabels([
        role('r1', 'Sales Program Advisor', null),
        role('r2', 'Sales Program Advisor', '   '),
        role('r3', 'Sales Program Advisor', undefined),
      ]);
      expect(labels.get('r1')).toBe('Sales Program Advisor');
      expect(labels.get('r2')).toBe('Sales Program Advisor · 2');
      expect(labels.get('r3')).toBe('Sales Program Advisor · 3');
      for (const label of labels.values()) expect(label).not.toMatch(/\(\d+\)$/);
    });

    it('in a mixed clash, only the member WITH an agent name gains the role', () => {
      // A role titled "Gopu" and an agent named Gopu both read "Gopu".
      const labels = uniqueAgentLabels([
        role('r1', 'Gopu', null),
        role('r2', 'Sales', 'Gopu'),
      ]);
      expect(labels.get('r1')).toBe('Gopu');
      expect(labels.get('r2')).toBe('Gopu (Sales)');
    });

    it('numbers what the role cannot tell apart: the same agent on two same-titled roles', () => {
      const labels = uniqueAgentLabels([
        role('r1', 'Sales', 'Gopu'),
        role('r2', 'Sales', 'Gopu'),
      ]);
      expect(labels.get('r1')).toBe('Gopu (Sales)');
      expect(labels.get('r2')).toBe('Gopu (Sales) · 2');
    });

    it('keeps the earlier cases apart, keyed by id, in list order', () => {
      const labels = uniqueAgentLabels([
        role('r1', 'Sales Program Advisor', null),
        role('r2', 'Sales Program Advisor', 'Test v1'),
        role('r3', 'Sales Program Advisor', null),
        role('r4', 'Other', 'Test v1'),
      ]);
      expect(labels.get('r1')).toBe('Sales Program Advisor');
      expect(labels.get('r2')).toBe('Test v1 (Sales Program Advisor)');
      expect(labels.get('r3')).toBe('Sales Program Advisor · 2');
      expect(labels.get('r4')).toBe('Test v1 (Other)');
    });

    it('never hands out a number another role already reads as', () => {
      const labels = uniqueAgentLabels([
        role('r1', 'Sales', null),
        role('r2', 'Sales · 2', null),
        role('r3', 'Sales', null),
      ]);
      expect(labels.get('r2')).toBe('Sales · 2');
      expect(labels.get('r3')).toBe('Sales · 3');
      expect(new Set(labels.values()).size).toBe(3);
    });
  });
});
