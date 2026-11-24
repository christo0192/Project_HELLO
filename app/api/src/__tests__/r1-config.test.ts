import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { getR1Config, r1IkOffersEnabled, r1IndiaPlaybookEnabled } from '../lib/r1/config.js';
import { createApp } from '../app.js';

describe('R1 lazy configuration', () => {
  it('defaults the India playbook on and accepts explicit off values without throwing', () => {
    for (const value of [undefined, '', '1']) {
      expect(r1IndiaPlaybookEnabled({ R1_INDIA_PLAYBOOK: value })).toBe(true);
    }
    for (const value of ['0', ' Off ', 'NO', 'false']) {
      expect(r1IndiaPlaybookEnabled({ R1_INDIA_PLAYBOOK: value })).toBe(false);
    }
    expect(() => r1IndiaPlaybookEnabled({ R1_INDIA_PLAYBOOK: 123 } as unknown as NodeJS.ProcessEnv))
      .not.toThrow();
  });
  it('defaults IK offers on and accepts explicit off values without throwing (owner 2026-11-24)', () => {
    for (const value of [undefined, '', '1']) {
      expect(r1IkOffersEnabled({ R1_IK_OFFERS: value })).toBe(true);
    }
    for (const value of ['0', ' Off ', 'NO', 'false']) {
      expect(r1IkOffersEnabled({ R1_IK_OFFERS: value })).toBe(false);
    }
    expect(() => r1IkOffersEnabled({ R1_IK_OFFERS: 123 } as unknown as NodeJS.ProcessEnv))
      .not.toThrow();
    expect(r1IkOffersEnabled({ R1_INDIA_PLAYBOOK: '0' })).toBe(true);
  });
  it('never throws and disables invalid values', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(getR1Config({ R1_ENABLED: 'definitely' } as NodeJS.ProcessEnv)).toMatchObject({ enabled: false, status: 'invalid' });
    spy.mockRestore();
  });
  it('has a safe disabled default', () => {
    expect(getR1Config({} as NodeJS.ProcessEnv)).toEqual({ enabled: false, status: 'disabled' });
  });
  it('does not prevent the shared API from booting when R1 is malformed', async () => {
    const previous = process.env.R1_ENABLED;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.R1_ENABLED = 'wrong';
    try {
      const app = createApp({ nodeEnv: 'test', auditSinkOverride: async () => undefined });
      expect((await request(app).get('/api/health')).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.R1_ENABLED;
      else process.env.R1_ENABLED = previous;
      spy.mockRestore();
    }
  });
});
