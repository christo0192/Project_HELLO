import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type {
  AdminAuditRow,
  AdminMember,
  AdminSessionRow,
  MembershipRole,
  PublicStatus,
  QuotaPolicy,
} from '../types';
import { Button, Card, ErrorState, LoadingState, PageHeader } from '../components/ui';

/**
 * Phase 9 L4 + review repair — Admin dashboard (OPS-01/OPS-05).
 *
 * Included (only what the API actually exposes):
 *   - admin health via GET /api/status
 *   - maintenance toggle via POST /api/admin/maintenance
 *   - opaque members role/active mutation
 *   - session view + override with reason (GET /api/admin/sessions +
 *     POST /api/admin/sessions/:id/override) — admin no longer needs to
 *     pre-know a UUID
 *   - bounded redacted audit view (GET /api/admin/audit)
 *   - abstract quota policy configuration (GET/POST/PATCH /api/admin/quotas)
 *     — cost units are abstract integers, never price/currency; policies are
 *     DISABLED by default (enforcement engages only when enabled)
 *
 * Deliberately NOT included (no API exists — no fabricated UI): nothing;
 * every section here is backed by a real endpoint. No Supabase Auth identity
 * creation claim is made anywhere. All lists are read-only rows with
 * keyboard-native controls and loading/error/empty states.
 */

const OVERRIDE_TARGETS = ['created', 'waiting', 'in_progress', 'failed', 'cancelled', 'completed'] as const;

export function AdminDashboardPage() {
  const [status, setStatus] = useState<PublicStatus | null>(null);
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [sessions, setSessions] = useState<AdminSessionRow[] | null>(null);
  const [audit, setAudit] = useState<AdminAuditRow[] | null>(null);
  const [policies, setPolicies] = useState<QuotaPolicy[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Maintenance form state
  const [maintEnabled, setMaintEnabled] = useState(false);
  const [maintReason, setMaintReason] = useState('');
  const [maintBusy, setMaintBusy] = useState(false);
  const [maintMsg, setMaintMsg] = useState<string | null>(null);

  // Member mutation state
  const [memberDrafts, setMemberDrafts] = useState<Record<string, { role: MembershipRole; active: boolean }>>({});
  const [memberMsg, setMemberMsg] = useState<string | null>(null);

  // Session override state — session selectable from the admin session list
  const [sessionId, setSessionId] = useState('');
  const [targetStatus, setTargetStatus] = useState<(typeof OVERRIDE_TARGETS)[number]>('waiting');
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideMsg, setOverrideMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .status()
      .then((s) => {
        setStatus(s);
        setMaintEnabled(s.maintenance?.enabled === true);
        setMaintReason(s.maintenance?.reason ?? '');
      })
      .catch((e: ApiError) => setLoadError(e.message));
    api
      .listAdminMembers()
      .then((m) => {
        setMembers(m);
        setMemberDrafts(
          Object.fromEntries(m.map((mm) => [mm.user_id, { role: mm.role, active: mm.active }])),
        );
      })
      .catch((e: ApiError) => setLoadError(e.message));
    api
      .listAdminSessions()
      .then((r) => {
        setSessions(r.sessions);
        if (r.sessions.length > 0) setSessionId((prev) => prev || r.sessions[0].id);
      })
      .catch((e: ApiError) => setLoadError(e.message));
    api
      .listAdminAudit(50, 0)
      .then((r) => setAudit(r.audit))
      .catch((e: ApiError) => setLoadError(e.message));
    api
      .listAdminQuotas()
      .then((r) => setPolicies(r.policies))
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  async function toggleMaintenance() {
    setMaintBusy(true);
    setMaintMsg(null);
    try {
      const res = await api.toggleMaintenance({ enabled: maintEnabled, reason: maintReason });
      setMaintMsg(`Maintenance ${res.enabled ? 'enabled' : 'disabled'}.`);
      setMaintEnabled(res.enabled);
      const s = await api.status();
      setStatus(s);
    } catch (e) {
      setMaintMsg(e instanceof ApiError ? e.message : 'Failed to toggle maintenance.');
    } finally {
      setMaintBusy(false);
    }
  }

  async function saveMember(userId: string) {
    setMemberMsg(null);
    const draft = memberDrafts[userId];
    if (!draft) return;
    try {
      await api.updateAdminMember(userId, draft);
      setMemberMsg('Member updated.');
      const m = await api.listAdminMembers();
      setMembers(m);
      setMemberDrafts(
        Object.fromEntries(m.map((mm) => [mm.user_id, { role: mm.role, active: mm.active }])),
      );
    } catch (e) {
      setMemberMsg(e instanceof ApiError ? e.message : 'Failed to update member.');
    }
  }

  async function runOverride() {
    if (!sessionId.trim()) return;
    setOverrideBusy(true);
    setOverrideMsg(null);
    try {
      await api.overrideSession(sessionId.trim(), {
        target_status: targetStatus,
        reason: overrideReason,
      });
      setOverrideMsg('Session override applied.');
      setOverrideReason('');
      const r = await api.listAdminSessions();
      setSessions(r.sessions);
    } catch (e) {
      setOverrideMsg(e instanceof ApiError ? e.message : 'Failed to override session.');
    } finally {
      setOverrideBusy(false);
    }
  }

  if (loadError && !status && !members) {
    return <ErrorState message={loadError} onRetry={load} />;
  }
  if (!status || !members) {
    return <LoadingState label="Loading admin dashboard…" />;
  }

  return (
    <div>
      <PageHeader title="Admin" description="Operational controls (bounded to the exposed admin API)." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Service state + maintenance */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Service state</h2>
          <p className="text-sm text-gray-600">
            {status.status === 'ok'
              ? 'All systems operational'
              : status.status === 'maintenance'
                ? 'Maintenance mode enabled — new sessions are blocked'
                : 'Service degraded'}
          </p>
          <p className="mt-1 text-xs text-gray-400">
            Updated {new Date(status.updated_at).toLocaleString()}
          </p>

          <div className="mt-5 rounded-md border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900">Maintenance mode</h3>
            <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={maintEnabled}
                onChange={(e) => setMaintEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-accent-600 focus:ring-accent-500"
              />
              Enable maintenance
            </label>
            <label htmlFor="maint-reason" className="mt-3 block text-sm font-medium text-gray-700">
              Reason
            </label>
            <input
              id="maint-reason"
              value={maintReason}
              onChange={(e) => setMaintReason(e.target.value)}
              maxLength={200}
              placeholder="Required — e.g. planned deployment window"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
            />
            <Button
              className="mt-3"
              onClick={() => void toggleMaintenance()}
              loading={maintBusy}
              disabled={maintReason.trim().length === 0}
            >
              Apply maintenance toggle
            </Button>
            {maintMsg && <p className="mt-2 text-xs text-gray-600">{maintMsg}</p>}
          </div>
        </Card>

        {/* Members */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Members</h2>
          <p className="mb-3 text-xs text-gray-400">
            Opaque identifiers only — no email/identity data is exposed.
          </p>
          <ul className="divide-y divide-gray-100">
            {members.map((m) => {
              const draft = memberDrafts[m.user_id];
              return (
                <li key={m.user_id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <span className="w-40 truncate font-mono text-xs text-gray-500" title={m.user_id}>
                    {m.user_id.slice(0, 13)}…
                  </span>
                  <select
                    aria-label={`Role for member ${m.user_id.slice(0, 8)}`}
                    value={draft?.role ?? m.role}
                    onChange={(e) =>
                      setMemberDrafts((prev) => ({
                        ...prev,
                        [m.user_id]: { ...(prev[m.user_id] ?? { role: m.role, active: m.active }), role: e.target.value as MembershipRole },
                      }))
                    }
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                  >
                    <option value="viewer">viewer</option>
                    <option value="interviewer">interviewer</option>
                    <option value="admin">admin</option>
                  </select>
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={draft?.active ?? m.active}
                      onChange={(e) =>
                        setMemberDrafts((prev) => ({
                          ...prev,
                          [m.user_id]: { ...(prev[m.user_id] ?? { role: m.role, active: m.active }), active: e.target.checked },
                        }))
                      }
                      className="h-4 w-4 rounded border-gray-300 text-accent-600 focus:ring-accent-500"
                    />
                    active
                  </label>
                  <Button
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={() => void saveMember(m.user_id)}
                  >
                    Save
                  </Button>
                </li>
              );
            })}
          </ul>
          {memberMsg && <p className="mt-2 text-xs text-gray-600">{memberMsg}</p>}
        </Card>

        {/* Sessions view + override */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Sessions</h2>
          <p className="mb-3 text-xs text-gray-400">
            Opaque IDs only — no candidate PII. Select a session to override it.
          </p>
          {sessions === null ? (
            <p className="text-sm text-gray-400">Loading sessions…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-gray-500">No sessions yet.</p>
          ) : (
            <>
              <label htmlFor="override-session" className="block text-sm font-medium text-gray-700">
                Session
              </label>
              <select
                id="override-session"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id.slice(0, 8)} — {s.status}
                  </option>
                ))}
              </select>
              <ul className="mt-3 max-h-40 divide-y divide-gray-100 overflow-y-auto">
                {sessions.slice(0, 8).map((s) => (
                  <li key={s.id} className="py-1.5 text-xs text-gray-600">
                    <span className="font-mono">{s.id.slice(0, 13)}…</span>
                    <span className="mx-2 rounded bg-gray-100 px-1.5 py-0.5">{s.status}</span>
                    <span className="text-gray-400">
                      {new Date(s.created_at).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="mt-4 rounded-md border border-gray-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900">Override session</h3>
            <p className="mt-1 text-xs text-gray-500">
              Bounded CAS override with an audit reason. Terminal states
              (failed/cancelled/expired/deleted) cannot be resurrected.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="override-target" className="block text-xs font-medium text-gray-600">
                  Target status
                </label>
                <select
                  id="override-target"
                  value={targetStatus}
                  onChange={(e) => setTargetStatus(e.target.value as (typeof OVERRIDE_TARGETS)[number])}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
                >
                  {OVERRIDE_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="override-reason" className="block text-xs font-medium text-gray-600">
                  Reason (required)
                </label>
                <input
                  id="override-reason"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  maxLength={200}
                  placeholder="Audit reason…"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
                />
              </div>
            </div>
            <Button
              className="mt-3"
              onClick={() => void runOverride()}
              loading={overrideBusy}
              disabled={!sessionId.trim() || overrideReason.trim().length === 0}
            >
              Apply override
            </Button>
            {overrideMsg && <p className="mt-2 text-xs text-gray-600">{overrideMsg}</p>}
          </div>
        </Card>

        {/* Audit view */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Audit log</h2>
          <p className="mb-3 text-xs text-gray-400">
            Bounded and redacted — metadata, IPs, correlation IDs and tokens are
            never returned.
          </p>
          {audit === null ? (
            <p className="text-sm text-gray-400">Loading audit log…</p>
          ) : audit.length === 0 ? (
            <p className="text-sm text-gray-500">No audit events yet.</p>
          ) : (
            <ul className="max-h-64 divide-y divide-gray-100 overflow-y-auto">
              {audit.map((row) => (
                <li key={row.id} className="py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-gray-800">{row.action}</span>
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600">
                      {row.result}
                    </span>
                  </div>
                  <p className="mt-0.5 text-gray-400">
                    {row.actor_type} · {row.target_type} ·{' '}
                    {new Date(row.created_at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Quota policies */}
        <Card className="p-5 lg:col-span-2">
          <QuotaPoliciesSection
            policies={policies}
            onChanged={(next) => setPolicies(next)}
          />
        </Card>
      </div>
    </div>
  );
}

/* ── Phase 9 review repair: abstract quota policy configuration (OPS-05) ─ */

function QuotaPoliciesSection({
  policies,
  onChanged,
}: {
  policies: QuotaPolicy[] | null;
  onChanged: (next: QuotaPolicy[] | null) => void;
}) {
  const [scope, setScope] = useState<'global' | 'candidate'>('global');
  const [scopeId, setScopeId] = useState('');
  const [maxSessions, setMaxSessions] = useState('');
  const [maxCostUnits, setMaxCostUnits] = useState('');
  const [costPerSession, setCostPerSession] = useState('');
  const [warningPct, setWarningPct] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api.createQuotaPolicy({
        scope,
        scope_id: scope === 'candidate' ? scopeId || null : null,
        max_sessions: maxSessions === '' ? null : Number(maxSessions),
        max_cost_units: maxCostUnits === '' ? null : Number(maxCostUnits),
        cost_units_per_session: costPerSession === '' ? null : Number(costPerSession),
        warning_percentage: warningPct === '' ? null : Number(warningPct),
        enabled,
      });
      setMsg('Quota policy created (disabled by default unless enabled).');
      setMaxSessions('');
      setMaxCostUnits('');
      setCostPerSession('');
      setWarningPct('');
      setEnabled(false);
      const r = await api.listAdminQuotas();
      onChanged(r.policies);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Failed to save quota policy.');
    } finally {
      setBusy(false);
    }
  }

  async function togglePolicy(p: QuotaPolicy) {
    setBusy(true);
    setMsg(null);
    try {
      await api.updateQuotaPolicy(p.id, {
        scope: p.scope,
        scope_id: p.scope_id,
        mode: p.mode,
        max_sessions: p.max_sessions,
        max_cost_units: p.max_cost_units,
        cost_units_per_session: p.cost_units_per_session,
        warning_percentage: p.warning_percentage,
        period_days: p.period_days,
        enabled: !p.enabled,
      });
      const r = await api.listAdminQuotas();
      onChanged(r.policies);
      setMsg('Quota policy updated.');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Failed to update quota policy.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-sm font-semibold text-gray-900">Quota policies</h2>
      <p className="mb-3 text-xs text-gray-400">
        Abstract cost units only — never currency or provider price. Policies
        are disabled by default; enforcement engages only once enabled.
        Warning percentage is optional (null = no warning).
      </p>

      {policies === null ? (
        <p className="text-sm text-gray-400">Loading quota policies…</p>
      ) : policies.length === 0 ? (
        <p className="text-sm text-gray-500">No quota policies configured (quota enforcement is off).</p>
      ) : (
        <ul className="mb-4 divide-y divide-gray-100">
          {policies.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="font-mono text-xs text-gray-500">{p.id.slice(0, 8)}…</span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{p.scope}</span>
              <span className="text-xs text-gray-600">
                max_sessions: {p.max_sessions ?? '∞'} · max_cost_units:{' '}
                {p.max_cost_units ?? '∞'} · units/session: {p.cost_units_per_session ?? '—'} ·
                warning: {p.warning_percentage == null ? 'off' : `${p.warning_percentage}%`}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  p.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-500'
                }`}
              >
                {p.enabled ? 'enabled' : 'disabled'}
              </span>
              <Button
                variant="secondary"
                className="px-2 py-1 text-xs"
                loading={busy}
                onClick={() => void togglePolicy(p)}
              >
                {p.enabled ? 'Disable' : 'Enable'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-md border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900">Create policy</h3>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div>
            <label htmlFor="quota-scope" className="block text-xs font-medium text-gray-600">
              Scope
            </label>
            <select
              id="quota-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'global' | 'candidate')}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
            >
              <option value="global">global</option>
              <option value="candidate">candidate</option>
            </select>
          </div>
          {scope === 'candidate' && (
            <div>
              <label htmlFor="quota-scope-id" className="block text-xs font-medium text-gray-600">
                Candidate ID
              </label>
              <input
                id="quota-scope-id"
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                placeholder="UUID"
                className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
              />
            </div>
          )}
          <div>
            <label htmlFor="quota-max-sessions" className="block text-xs font-medium text-gray-600">
              Max sessions (blank = unlimited)
            </label>
            <input
              id="quota-max-sessions"
              type="number"
              min={1}
              value={maxSessions}
              onChange={(e) => setMaxSessions(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
            />
          </div>
          <div>
            <label htmlFor="quota-max-cost" className="block text-xs font-medium text-gray-600">
              Max cost units (abstract)
            </label>
            <input
              id="quota-max-cost"
              type="number"
              min={1}
              value={maxCostUnits}
              onChange={(e) => setMaxCostUnits(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
            />
          </div>
          <div>
            <label htmlFor="quota-units-session" className="block text-xs font-medium text-gray-600">
              Cost units per session (abstract)
            </label>
            <input
              id="quota-units-session"
              type="number"
              min={1}
              value={costPerSession}
              onChange={(e) => setCostPerSession(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
            />
          </div>
          <div>
            <label htmlFor="quota-warning" className="block text-xs font-medium text-gray-600">
              Warning % (blank = off)
            </label>
            <input
              id="quota-warning"
              type="number"
              min={1}
              max={100}
              value={warningPct}
              onChange={(e) => setWarningPct(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-accent-500"
            />
          </div>
          <label className="mt-5 flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-accent-600 focus:ring-accent-500"
            />
            Enabled
          </label>
        </div>
        <Button className="mt-4" onClick={() => void save()} loading={busy}>
          Create quota policy
        </Button>
        {msg && <p className="mt-2 text-xs text-gray-600">{msg}</p>}
      </div>
    </div>
  );
}
