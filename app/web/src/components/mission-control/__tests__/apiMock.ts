/**
 * Shared HOISTED api mock for Mission Control tests.
 *
 * vi.hoisted guarantees the mock exists before any static import of the
 * mocked api module (the same pattern as DashboardPage.test). The hoisted
 * value is assigned to a normal const and re-exported (a hoisted binding
 * itself cannot be exported). Every test file registers
 * `vi.mock('../../../api', () => ({ api: missionApi.api, ApiError:
 * missionApi.ApiError }))` and configures the fns it needs in beforeEach.
 */
import { vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  const fns = {
    getMe: vi.fn(),
    status: vi.fn(),
    listAdminSessions: vi.fn(),
    listAdminAllowlist: vi.fn(),
    addAdminAllowlistEntry: vi.fn(),
    updateAdminAllowlistEntry: vi.fn(),
    listAdminQuotas: vi.fn(),
    createQuotaPolicy: vi.fn(),
    updateQuotaPolicy: vi.fn(),
    listAdminAudit: vi.fn(),
    toggleMaintenance: vi.fn(),
    overrideSession: vi.fn(),
  };

  const api = {
    getMe: fns.getMe,
    status: fns.status,
    listAdminSessions: fns.listAdminSessions,
    listAdminAllowlist: fns.listAdminAllowlist,
    addAdminAllowlistEntry: fns.addAdminAllowlistEntry,
    updateAdminAllowlistEntry: fns.updateAdminAllowlistEntry,
    listAdminQuotas: fns.listAdminQuotas,
    createQuotaPolicy: fns.createQuotaPolicy,
    updateQuotaPolicy: fns.updateQuotaPolicy,
    listAdminAudit: fns.listAdminAudit,
    toggleMaintenance: fns.toggleMaintenance,
    overrideSession: fns.overrideSession,
  };

  return { api, fns, ApiError };
});

export const missionApi = hoisted;
export const apiFns = hoisted.fns;
