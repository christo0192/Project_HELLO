import { describe, it, expect } from 'vitest';
import {
  candidateStatusLabel,
  candidateStatusTone,
  sessionStatusLabel,
  sessionStatusTone,
  formatDurationSec,
  candidateStatusCounts,
  sessionStatusCounts,
  sessionsPerDay,
} from '../status';

describe('candidateStatusLabel', () => {
  it('labels the known status vocabulary', () => {
    expect(candidateStatusLabel('new')).toBe('New');
    expect(candidateStatusLabel('queued')).toBe('Queued');
    expect(candidateStatusLabel('screening')).toBe('Screening');
    expect(candidateStatusLabel('screened')).toBe('Screened');
    expect(candidateStatusLabel('advanced')).toBe('Advanced');
    expect(candidateStatusLabel('rejected')).toBe('Rejected');
  });

  it('falls back to the raw value for unknown statuses (never invents)', () => {
    expect(candidateStatusLabel('custom_state')).toBe('custom_state');
    expect(candidateStatusLabel(null)).toBe('New');
    expect(candidateStatusLabel(undefined)).toBe('New');
    expect(candidateStatusLabel('  ')).toBe('New');
  });
});

describe('candidateStatusTone', () => {
  it('maps screened/advanced to success, screening/queued to warning, rejected to danger, new to info', () => {
    expect(candidateStatusTone('screened')).toBe('success');
    expect(candidateStatusTone('advanced')).toBe('success');
    expect(candidateStatusTone('screening')).toBe('warning');
    expect(candidateStatusTone('queued')).toBe('warning');
    expect(candidateStatusTone('rejected')).toBe('danger');
    expect(candidateStatusTone('new')).toBe('info');
    expect(candidateStatusTone('mystery')).toBe('neutral');
  });
});

describe('sessionStatusLabel / tone', () => {
  it('labels the 7-state session vocabulary', () => {
    expect(sessionStatusLabel('created')).toBe('Created');
    expect(sessionStatusLabel('waiting')).toBe('Waiting');
    expect(sessionStatusLabel('in_progress')).toBe('In progress');
    expect(sessionStatusLabel('completed')).toBe('Completed');
    expect(sessionStatusLabel('failed')).toBe('Failed');
    expect(sessionStatusLabel('cancelled')).toBe('Cancelled');
    expect(sessionStatusLabel('expired')).toBe('Expired');
    expect(sessionStatusLabel('weird')).toBe('weird');
    expect(sessionStatusLabel(null)).toBe('—');
  });

  it('tones terminal failure states as danger', () => {
    expect(sessionStatusTone('completed')).toBe('success');
    expect(sessionStatusTone('in_progress')).toBe('warning');
    expect(sessionStatusTone('failed')).toBe('danger');
    expect(sessionStatusTone('cancelled')).toBe('danger');
    expect(sessionStatusTone('expired')).toBe('danger');
    expect(sessionStatusTone('created')).toBe('info');
  });
});

describe('formatDurationSec', () => {
  it('formats seconds without fabricating values', () => {
    expect(formatDurationSec(45)).toBe('45s');
    expect(formatDurationSec(360)).toBe('6m 0s');
    expect(formatDurationSec(385)).toBe('6m 25s');
    expect(formatDurationSec(null)).toBe('—');
    expect(formatDurationSec(undefined)).toBe('—');
  });
});

describe('candidateStatusCounts', () => {
  it('counts only statuses actually present, newest label maps, sorted desc', () => {
    const counts = candidateStatusCounts([
      { status: 'new' },
      { status: 'new' },
      { status: 'screened' },
      { status: null },
    ]);
    expect(counts).toEqual([
      { label: 'New', value: 3 },
      { label: 'Screened', value: 1 },
    ]);
  });

  it('returns an empty list for no candidates (no fabricated statuses)', () => {
    expect(candidateStatusCounts([])).toEqual([]);
  });
});

describe('sessionStatusCounts', () => {
  it('counts present session statuses only', () => {
    const counts = sessionStatusCounts([
      { status: 'completed' },
      { status: 'completed' },
      { status: 'in_progress' },
    ]);
    expect(counts).toEqual([
      { label: 'Completed', value: 2 },
      { label: 'In progress', value: 1 },
    ]);
  });
});

describe('sessionsPerDay', () => {
  it('zero-fills a fixed window and labels dates m/d', () => {
    // Reference date is “today” (UTC) — the newest bucket carries the sessions.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const iso = today.toISOString();
    const data = sessionsPerDay([{ created_at: iso }, { created_at: iso }], 3);
    expect(data).toHaveLength(3);
    expect(data[data.length - 1].value).toBe(2);
    expect(data[data.length - 1].label).toMatch(/^\d{2}\/\d{2}$/);
    expect(data.slice(0, 2).every((d) => d.value === 0)).toBe(true);
  });

  it('ignores malformed dates without fabricating counts', () => {
    const data = sessionsPerDay([{ created_at: 'not-a-date' }], 2);
    expect(data).toHaveLength(2);
    expect(data.every((d) => d.value === 0)).toBe(true);
  });
});
