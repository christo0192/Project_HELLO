import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type {
  AppealRow,
  CandidateDetail,
  MeResponse,
  Note,
  PhoneRescreenReason,
  PhoneScreeningCycle,
  PhoneScreeningsResponse,
} from "../types";
import { LiveCallPanel } from "../components/LiveCallPanel";
import { LiveKitCallCard } from "../components/LiveKitCallCard";
import { StatusBadge } from "../components/design";
import {
  CandidateButton,
  CandidateErrorState,
  CandidateInput,
  CandidateLoadingState,
  CandidateSelect,
  SurfaceCard,
  Tag,
} from "../components/design/candidate";
import {
  AshbyWorkflowCard,
  CandidateHeader,
  CandidateProfileCard,
  CandidateShell,
  DecisionBlockedBanner,
  NotesList,
  SessionsSummary,
  Tabs,
  TranscriptionSyncWorkspace,
  candidateDisplayName,
} from "../components/talent";
import {
  candidateStatusLabel,
  candidateStatusTone,
  sessionStatusLabel,
} from "../components/talent";
import { CandidateHeadlineFacts } from "../components/talent/CandidateHeadlineFacts";
import { formatDateTime } from "../lib/datetime";
import { PhoneSlotDialog, engagementStateTerm } from "../components/phone-calendar";
import { istToday } from "../lib/ist-datetime";
import type { IstDate } from "../lib/ist-datetime";
import type { PhoneSlot } from "../types";

/**
 * HELLO Lane 3 — CandidateDetail as one recruiter review workspace.
 *
 * Two tabs:
 *   - Overview: identity/profile, live screening actions, session summary,
 *     append-only notes, and appeals + one-time grant links.
 *   - Review: the single authoritative review workspace — session context,
 *     one recording player, synchronized transcript, and the session's
 *     scorecard (TranscriptionSyncWorkspace). This replaces the previously
 *     duplicated Sessions-tab audio, Recordings tab, and Overview scorecard.
 *
 * Preserved behavior: decision-use block banner + scorecard suppression,
 * LiveKit invite + live call panel, ownership-scoped CSV export, append-only
 * notes, appeals + fragment-only grant links, on-demand (never auto-fetched)
 * short-lived recording playback.
 */

export function CandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    setDetail(null);
    setMe(null);
    // Older embedded candidate surfaces may provide only the candidate
    // endpoint in their test/host adapter. Treat that missing optional role
    // lookup as viewer-safe; the production API always supplies it and the
    // phone-cycle endpoint remains server-authorized.
    const fallbackMe: MeResponse = { userId: "", email: null, role: "viewer", active: false };
    const meRequest = Promise.resolve()
      .then(() => typeof api.getMe === "function" ? api.getMe() : fallbackMe)
      .catch(() => fallbackMe);
    Promise.all([api.getCandidate(id), meRequest])
      .then(([d, currentMe]) => {
        setDetail(d);
        setMe(currentMe);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  /**
   * The role this candidate applied for, resolved to its title.
   *
   * The detail payload carries `role_id` but not the title, and the route does
   * not join roles. `null` until it resolves, and `null` when the id is not in
   * the list — which is a real case, not only an error: an interviewer sees
   * only roles they own, so a candidate on a colleague's role resolves to
   * nothing. The badge is then simply absent, because a WRONG role on a
   * candidate page is worse than no role at all.
   */
  const roleId = detail?.candidate.role_id ?? null;
  const [roleTitle, setRoleTitle] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!roleId) {
      setRoleTitle(null);
      return;
    }
    // GUARDED THE SAME WAY `getMe` is, twenty lines up, and for the same
    // reason: embedded candidate surfaces supply a host adapter with only the
    // endpoints they need, and `listRoles` is not one of them.
    //
    // WHAT ACTUALLY FIXED THE UNMOUNT WAS THE `Promise.resolve()` WRAPPER, not
    // this check. Called bare, a missing method threw synchronously in the
    // effect body, which React escalates into unmounting the whole page —
    // transcript, scorecard and appeal controls with it. Inside the wrapper
    // the same TypeError is an ordinary rejection the `.catch` below already
    // absorbs, so removing this line changes no observable behaviour and no
    // test pins it. It stays for symmetry with `getMe` and to keep "this
    // adapter has no roles endpoint" from arriving down the same path as "the
    // roles request failed" — and is stated as defence in depth rather than
    // as a protection, because a comment claiming the latter would be false.
    Promise.resolve()
      .then(() => (typeof api.listRoles === "function" ? api.listRoles() : []))
      .then((roles) => {
        if (!live) return;
        setRoleTitle(roles.find((r) => r.id === roleId)?.title ?? null);
      })
      .catch(() => {
        if (live) setRoleTitle(null);
      });
    return () => {
      live = false;
    };
  }, [roleId]);

  // Silent refresh: re-read the candidate (its session list feeds the Review
  // tab) without unmounting the page. Used when a live call completes.
  const refresh = useCallback(() => {
    if (!id) return;
    api
      .getCandidate(id)
      .then((d) => setDetail(d))
      .catch(() => {
        /* keep the current view; the next explicit load surfaces errors */
      });
  }, [id]);

  if (error)
    return (
      <CandidateShell variant="inset">
        <CandidateErrorState message={error} onRetry={load} />
      </CandidateShell>
    );
  if (!detail || !me)
    return (
      <CandidateShell variant="inset">
        <CandidateLoadingState label="Loading candidate…" />
      </CandidateShell>
    );

  const { candidate, sessions, assessments } = detail;
  const decisionBlocked = candidate.decision_use_blocked_at != null;

  /**
   * The LONGEST completed call, not the latest.
   *
   * A candidate can have several sessions — a cycle-2 rescreen, a call that
   * died at the consent gate after nine seconds. Showing the most recent would
   * report "0m 9s on the call" for someone who actually completed a seven
   * minute screen; the longest is the one the scorecard was built from.
   * `null` (never 0) when nothing completed, so the badge is absent rather
   * than claiming a zero-length call.
   */
  const longestSession = sessions.reduce<(typeof sessions)[number] | null>((best, session) => {
    const secs = session.duration_sec;
    if (typeof secs !== "number" || !Number.isFinite(secs) || secs <= 0) return best;
    return secs > (best?.duration_sec ?? -1) ? session : best;
  }, null);

  return (
    <CandidateShell variant="inset">
      <Link
        to="/candidates"
        className="mb-4 inline-flex min-h-11 items-center gap-1 text-sm text-[var(--c-ink-secondary)] hover:text-[var(--c-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
      >
        ← Back to candidates
      </Link>

      <CandidateHeader
        eyebrow="Candidate"
        title={candidateDisplayName(candidate.name)}
        description={candidate.email ?? undefined}
        // Directly under the name, above the tabs: which role, how long the
        // call ran, how much the candidate said. The call length previously
        // lived in the Live-call panel on the far right, and the role was not
        // on this page at all.
        meta={
          <CandidateHeadlineFacts
            roleTitle={roleTitle}
            callSeconds={longestSession?.duration_sec ?? null}
            // From THE SAME session as the length, or the two figures describe
            // different calls while sitting side by side.
            candidateWords={longestSession?.candidate_words ?? null}
          />
        }
        actions={
          <>
            <StatusBadge tone={candidateStatusTone(candidate.status)}>
              {candidateStatusLabel(candidate.status)}
            </StatusBadge>
            <CsvExportButton candidateId={candidate.id} />
          </>
        }
      />

      {decisionBlocked && <DecisionBlockedBanner />}

      <div className="mt-4">
        <Tabs
          ariaLabel="Candidate sections"
          items={[
            {
              id: "overview",
              label: "Overview",
              panel: (
                <OverviewTab
                  candidate={candidate}
                  sessions={sessions}
                  phoneRole={me.role}
                  onSessionCompleted={refresh}
                />
              ),
            },
            {
              id: "review",
              label: "Review",
              panel: (
                <TranscriptionSyncWorkspace
                  sessions={sessions}
                  assessments={assessments}
                  blocked={decisionBlocked}
                />
              ),
            },
          ]}
        />
      </div>
    </CandidateShell>
  );
}

/* ── Overview tab ───────────────────────────────────────────────────── */

function OverviewTab({
  candidate,
  sessions,
  phoneRole,
  onSessionCompleted,
}: {
  candidate: CandidateDetail["candidate"];
  sessions: CandidateDetail["sessions"];
  phoneRole: MeResponse["role"];
  onSessionCompleted?: () => void;
}) {
  return (
    // `fade-up-stagger` is the CSS-only reveal: candidate-scoped source may
    // not import a motion library, and this collapses with every other
    // animation under the global reduced-motion rule in index.css.
    //
    // Two columns, not one short card beside a six-card stack. The reference
    // material — profile, session history, notes — is a sticky left rail that
    // stays put while the operator works; the acting surfaces — the two call
    // cards, the phone cycle, the Ashby pipeline, appeals — own the wide
    // column. Below `lg` this is one ordinary stack, reference first.
    <div className="fade-up-stagger grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-12 lg:items-start">
      <div className="order-2 space-y-4 lg:order-1 lg:col-span-4">
        <CandidateProfileCard
          candidate={candidate}
          className="p-4 sm:p-5"
          footnote="Transcript, playback and scorecard sync back into the Review tab."
        />

        <SessionsSummary sessions={sessions} />

        <NotesSection candidateId={candidate.id} />
      </div>

      <div className="order-1 space-y-4 sm:space-y-6 lg:order-2 lg:col-span-8">
        {/* Both call cards are frozen components. They are placed side by
            side and stretched to a common height by their wrappers, so the
            large "No active call" body no longer stacks below a card that
            has already ended. Neither component is modified. */}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] sm:items-start">
          <div className="min-w-0">
            <LiveKitCallCard
              candidateId={candidate.id}
              candidateName={candidate.name}
            />
          </div>
          <div className="min-w-0">
            <LiveCallPanel
              candidateId={candidate.id}
              candidateName={candidate.name || undefined}
              onSessionCompleted={onSessionCompleted}
            />
          </div>
        </div>

        {phoneRole !== "viewer" && (
          <PhoneCycleCard candidateId={candidate.id} admin={phoneRole === "admin"} />
        )}

        {/* Read-only Ashby pipeline status. Renders nothing for a candidate
            with no Ashby application link. */}
        <AshbyWorkflowCard source={{ kind: "candidate", candidateId: candidate.id }} />

        <AppealsSection candidateId={candidate.id} sessions={sessions} />
      </div>
    </div>
  );
}

/**
 * The booking advisory, preserved word for word.
 *
 * It is a truth claim — booking a slot promises nothing, admission does —
 * so it stays in the DOM in full and is read in full by a screen reader. It
 * is only laid out as one 12px line and carried in `title`, so the operator
 * can read the whole sentence on hover without a paragraph of chrome above
 * every picker.
 */
const SLOT_ADVISORY_NEW =
  "Choose an IST slot. Availability is advisory; normal admission gates still decide whether a call can start.";
const SLOT_ADVISORY_EXISTING =
  "Choose an IST slot. Availability is advisory; the normal admission gates still decide whether a call can start.";

function cycleLabel(cycle: PhoneScreeningCycle): string {
  return cycle.cycle_number == null ? "Screening cycle" : `Screening cycle ${cycle.cycle_number}`;
}

const RESCREEN_REASONS: Array<{ value: PhoneRescreenReason; label: string }> = [
  { value: "candidate_requested", label: "Candidate requested another screen" },
  { value: "incomplete_screening", label: "Screening was incomplete" },
  { value: "technical_issue", label: "Technical issue" },
  { value: "role_changed", label: "Role changed" },
  { value: "quality_review", label: "Quality review" },
];

function PhoneCycleCard({ candidateId, admin }: { candidateId: string; admin: boolean }) {
  const headingId = useId();
  const [data, setData] = useState<PhoneScreeningsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<PhoneRescreenReason>("candidate_requested");
  const [confirming, setConfirming] = useState(false);
  const confirmTriggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  // A non-modal inline dialog still owes keyboard users the basics: focus
  // moves in when it opens, Escape closes it, and focus returns to the
  // control that opened it.
  useEffect(() => {
    if (!confirming) return;
    const dialog = confirmDialogRef.current;
    dialog?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirming(false);
        confirmTriggerRef.current?.focus();
      }
    };
    dialog?.addEventListener("keydown", onKeyDown);
    return () => dialog?.removeEventListener("keydown", onKeyDown);
  }, [confirming]);
  const [requesting, setRequesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [phone, setPhone] = useState("");
  const [slotDate, setSlotDate] = useState<IstDate>(() => istToday());
  const [selectedSlot, setSelectedSlot] = useState<PhoneSlot | null>(null);
  // The slot grid is ~26 rows; it lives behind a button so the page stays
  // about the candidate until someone actually decides to book.
  const [slotDialogOpen, setSlotDialogOpen] = useState(false);
  // Captured explicitly rather than read from document.activeElement: Safari
  // and Firefox do not focus a button on mouse click, so the heuristic would
  // hand focus back to <body>. Mirrors `confirmTriggerRef` above.
  // ONE ref, because only ONE trigger is ever mounted: the two live in
  // opposite arms of a single ternary. Selecting between two refs on a
  // different predicate (`current?.appointment`) left `.current` null in the
  // most ordinary state — a cycle requested with nothing booked yet — so focus
  // returned nowhere, which is the exact failure the ref exists to prevent.
  const slotTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [savingAppointment, setSavingAppointment] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .getCandidatePhoneScreenings(candidateId)
      .then(setData)
      .catch((e: ApiError) => {
        // A disabled phone deployment is a truthful empty state, while a
        // transient projection failure remains visibly retryable.
        setError(e.message);
      });
  }, [candidateId]);

  useEffect(load, [load]);

  const current = data?.cycles.find((cycle) => cycle.cycle_number === data.current_cycle)
    ?? data?.cycles[0]
    ?? null;

  // Close when booking stops being offered. A refetch can turn the cycle
  // terminal while the dialog is open; leaving it up means confirming would
  // POST a schedule for a cycle that no longer accepts one. Keyed on the same
  // predicate that renders the triggers — an unmount-only cleanup would be a
  // no-op on an already-dead component, which is not the case it guards.
  const canSchedule = data
    ? data.cycles.length === 0 || !current || current.terminal_at === null
    : false;
  useEffect(() => {
    if (canSchedule) return;
    setSlotDialogOpen(false);
    setSelectedSlot(null);
  }, [canSchedule]);
  const canRescreen = current != null
    && current.terminal_at != null
    && ["completed", "failed", "abandoned_no_answer", "cancelled", "wrong_number"].includes(current.state);
  const requiresVerification = current?.state === "wrong_number";

  async function requestInitialCall() {
    setRequesting(true);
    setMessage(null);
    try {
      const result = await api.requestCandidatePhoneCall(candidateId);
      setConfirming(false);
      setMessage(result.status === "already_requested"
        ? "A phone screening is already queued or in progress."
        : "Phone screening requested. It will run only when all call gates permit it.");
      load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "The phone screening could not be requested.");
    } finally {
      setRequesting(false);
    }
  }

  async function requestRescreen() {
    setRequesting(true);
    setMessage(null);
    try {
      const requestId = `ui-${crypto.randomUUID()}`;
      const result = await api.requestPhoneRescreen(candidateId, { request_id: requestId, reason });
      setMessage(result.status === "already_requested"
        ? "That re-screen request was already accepted."
        : `Re-screen cycle ${result.cycle_number ?? ""} requested. It will run only when all call gates permit it.`);
      load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "The re-screen request could not be created.");
    } finally {
      setRequesting(false);
    }
  }

  async function saveAppointment() {
    if (!selectedSlot) return;
    setSavingAppointment(true);
    setMessage(null);
    try {
      if (current?.appointment?.appointment_id && current.appointment.version != null) {
        await api.rescheduleCandidatePhoneAppointment(candidateId, current.appointment.appointment_id, {
          starts_at: selectedSlot.starts_at,
          ends_at: selectedSlot.ends_at,
          version: current.appointment.version,
        });
        setMessage("Appointment moved. The previous slot has been superseded.");
      } else {
        const result = await api.scheduleCandidatePhoneAppointment(candidateId, {
          starts_at: selectedSlot.starts_at,
          ends_at: selectedSlot.ends_at,
        });
        setMessage(result.prereqs_pending
          ? "Appointment booked, but prerequisites are still pending; no dial is promised until admission re-checks them."
          : "Appointment booked. The call will still pass through normal admission gates.");
      }
      setSelectedSlot(null);
      // Close only on success: a failed save must keep the dialog open with
      // the grid in place, or the operator loses their context and has to
      // rediscover the slot they were trying to book.
      setSlotDialogOpen(false);
      load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "The appointment could not be saved.");
    } finally {
      setSavingAppointment(false);
    }
  }

  async function cancelAppointment() {
    const appointment = current?.appointment;
    if (!appointment?.appointment_id || appointment.version == null) return;
    setSavingAppointment(true);
    setMessage(null);
    try {
      await api.cancelCandidatePhoneAppointment(candidateId, appointment.appointment_id, {
        reason: "hr_cancelled",
        version: appointment.version,
      });
      setMessage("Appointment cancelled.");
      setSelectedSlot(null);
      load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "The appointment could not be cancelled.");
    } finally {
      setSavingAppointment(false);
    }
  }

  async function verifyNumber() {
    setVerifying(true);
    setMessage(null);
    try {
      await api.verifyCandidatePhone(candidateId, { phone_e164: phone.trim() });
      setPhone("");
      setMessage("Replacement number verified. Request a re-screen when ready.");
      load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "The number could not be verified.");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <>
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
        Phone screening cycles
      </h2>
      <p className="mt-0.5 text-[13px] text-ink-tertiary">
        A request never dials on its own — every call still passes the normal admission gates.
      </p>
      {error ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-ink-secondary">Phone cycle history unavailable.</p>
          <CandidateButton variant="secondary" onClick={load}>Retry</CandidateButton>
        </div>
      ) : data === null ? (
        <p className="mt-2 text-sm text-ink-tertiary">Loading cycle history…</p>
      ) : !data.enabled ? (
        <p className="mt-2 text-sm text-ink-secondary">Phone screening is turned off.</p>
      ) : data.cycles.length === 0 ? (
        <>
          <p className="mt-2 text-sm text-ink-secondary">No phone screening cycle has been created.</p>
          <CandidateButton ref={confirmTriggerRef} className="mt-3" variant="primary" onClick={() => { setMessage(null); setConfirming(true); }} disabled={requesting}>
            Call candidate
          </CandidateButton>
          {confirming && (
            <div
              ref={confirmDialogRef}
              role="dialog"
              aria-labelledby={`${headingId}-confirm`}
              // Non-modal on purpose: nothing outside is hidden, so no
              // `aria-modal`. The same sunken material a `SurfaceCard
              // level="sunken"` paints, applied directly so `role` stays on
              // the well itself.
              className="glass-sunken mt-4 p-4"
            >
              <h3 id={`${headingId}-confirm`} className="text-[13px] font-medium text-ink">Confirm phone screening</h3>
              <p className="mt-1 text-sm text-ink-secondary">
                Request one phone screening for this candidate? The system will call only if every safety gate passes.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <CandidateButton variant="primary" onClick={() => void requestInitialCall()} loading={requesting}>
                  Confirm call
                </CandidateButton>
                <CandidateButton variant="secondary" onClick={() => { setConfirming(false); confirmTriggerRef.current?.focus(); }} disabled={requesting}>
                  Cancel
                </CandidateButton>
              </div>
            </div>
          )}
          <SurfaceCard level="sunken" className="mt-4 p-3">
            <h3 className="text-[13px] font-medium text-ink-secondary">Schedule a slot</h3>
            <CandidateButton
              ref={slotTriggerRef}
              variant="primary"
              className="mt-3"
              onClick={() => setSlotDialogOpen(true)}
              disabled={savingAppointment}
            >
              Book a slot
            </CandidateButton>
          </SurfaceCard>
        </>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-line" aria-label="Phone screening cycle history">
            {data.cycles.map((cycle) => (
              <li key={`${cycle.cycle_number}-${cycle.created_at}`} className="py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-ink">{cycleLabel(cycle)}</span>
                  <StatusBadge tone={cycle.terminal_at ? "neutral" : "info"}>
                    <span title={cycle.state}>{cycle.state === "unknown" ? "Unknown" : engagementStateTerm(cycle.state).label}</span>
                  </StatusBadge>
                </div>
                <p className="mt-1 text-xs text-ink-tertiary">
                  {cycle.has_assessment ? "Assessment recorded" : cycle.has_session ? "Session recorded" : "No session yet"}
                  {cycle.appointment ? ` · ${cycle.appointment.status ?? "appointment"}` : ""}
                </p>
              </li>
            ))}
          </ul>

          {current?.state === "opted_out" ? (
            <p className="mt-3 text-sm text-warning">
              Re-screening is unavailable because the candidate opted out. Renewed consent requires separate governance.
            </p>
          ) : canRescreen && requiresVerification && !admin ? (
            <p className="mt-3 text-sm text-warning">An administrator must verify a replacement number before this cycle can be re-screened.</p>
          ) : canRescreen && requiresVerification && admin ? (
            <SurfaceCard level="sunken" className="mt-4 p-3">
              <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="min-w-0">
                  <label htmlFor={`${headingId}-phone`} className="block text-[13px] font-medium text-ink-secondary">
                    Verify replacement Indian mobile
                  </label>
                  <CandidateInput
                    id={`${headingId}-phone`}
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="+91…"
                    inputMode="tel"
                    autoComplete="off"
                    className="mt-1 block w-full"
                  />
                </div>
                <CandidateButton variant="secondary" onClick={() => void verifyNumber()} loading={verifying} disabled={!phone.trim()}>
                  Verify number
                </CandidateButton>
              </div>
            </SurfaceCard>
          ) : canRescreen ? (
            <SurfaceCard level="sunken" className="mt-4 p-3">
              <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div className="min-w-0">
                  <label htmlFor={`${headingId}-reason`} className="block text-[13px] font-medium text-ink-secondary">
                    Reason for new cycle
                  </label>
                  <CandidateSelect
                    id={`${headingId}-reason`}
                    value={reason}
                    onChange={(event) => setReason(event.target.value as PhoneRescreenReason)}
                    className="mt-1 block w-full"
                  >
                    {RESCREEN_REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </CandidateSelect>
                </div>
                <CandidateButton variant="primary" onClick={() => void requestRescreen()} loading={requesting}>
                  Request re-screen
                </CandidateButton>
              </div>
            </SurfaceCard>
          ) : current?.terminal_at ? (
            <p className="mt-3 text-sm text-ink-secondary">This cycle is terminal; no new cycle can be started from its current state.</p>
          ) : null}

          {(!current || current.terminal_at === null) && (
            <SurfaceCard level="sunken" className="mt-4 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-[13px] font-medium text-ink-secondary">
                  {current?.appointment ? "Move appointment" : "Schedule a slot"}
                </h3>
                {current?.appointment && (
                  <p className="text-[13px] text-ink-secondary">
                    Current slot: {current.appointment.starts_at ? formatDateTime(current.appointment.starts_at) : "time unavailable"}
                  </p>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <CandidateButton
                  ref={slotTriggerRef}
                  variant="primary"
                  onClick={() => setSlotDialogOpen(true)}
                  // Without this, clicking "Cancel appointment" and then this
                  // opens the dialog with `saving` already true — and every
                  // exit (Esc, backdrop, Cancel) is gated on !saving, so the
                  // operator is locked in until an unrelated request returns.
                  disabled={savingAppointment}
                >
                  {current?.appointment ? "Move appointment" : "Book a slot"}
                </CandidateButton>
                {current?.appointment && (
                  <CandidateButton variant="secondary" onClick={() => void cancelAppointment()} loading={savingAppointment}>
                    Cancel appointment
                  </CandidateButton>
                )}
              </div>
            </SurfaceCard>
          )}
        </>
      )}
      {message && <p role="status" className="mt-3 text-sm text-ink-secondary">{message}</p>}
    </SurfaceCard>

    {/* ONE dialog for both branches, mounted OUTSIDE the SurfaceCard above.
        `SurfaceCard level="base"` applies `.glass`, which sets
        `backdrop-filter` and therefore becomes the containing block for any
        `position: fixed` descendant — a "full-viewport" overlay declared
        inside it would clamp to the card. Here it has no filtered ancestor,
        so it covers the viewport with no portal and no event-scoping games.

        The two call sites were mutually exclusive arms of one ternary and
        already shared `slotDialogOpen`/`slotDate`/`selectedSlot`, so a single
        instance is the same behaviour with one fewer way to render two
        dialogs at once. */}
    <PhoneSlotDialog
      open={slotDialogOpen}
      onClose={() => { setSlotDialogOpen(false); setSelectedSlot(null); }}
      title={current?.appointment ? "Move appointment" : "Book a slot"}
      confirmLabel={current?.appointment ? "Move appointment" : "Book slot"}
      advisory={(data?.cycles.length ?? 0) === 0 ? SLOT_ADVISORY_NEW : SLOT_ADVISORY_EXISTING}
      date={slotDate}
      onDateChange={(date) => { setSlotDate(date); setSelectedSlot(null); }}
      selected={selectedSlot}
      onSelect={setSelectedSlot}
      onConfirm={() => void saveAppointment()}
      saving={savingAppointment}
      idPrefix={`${headingId}-slot`}
      returnFocusRef={slotTriggerRef}
    />
    </>
  );
}

/* ── Append-only notes ──────────────────────────────────────────────── */

function NotesSection({ candidateId }: { candidateId: string }) {
  const headingId = useId();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api
      .listNotes(candidateId)
      .then((r) => setNotes(r.notes))
      .catch((e: ApiError) => setErr(e.message));
  }, [candidateId]);

  useEffect(load, [load]);

  async function add() {
    if (!noteText.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.addNote(candidateId, noteText.trim());
      setNoteText("");
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Failed to add note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
        Notes
      </h2>
      <p className="mb-3 mt-0.5 text-[13px] text-ink-tertiary">
        Recruiter notes, appended in order.
      </p>
      <SurfaceCard level="sunken" className="p-3">
        <NotesList notes={notes} error={err} />
      </SurfaceCard>
      <div className="mt-3 flex flex-wrap gap-2">
        <label htmlFor="note-input" className="sr-only">
          Add a note
        </label>
        <CandidateInput
          id="note-input"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          maxLength={2000}
          placeholder="Add a note…"
          className="min-w-0 flex-1"
        />
        <CandidateButton
          variant="secondary"
          onClick={() => void add()}
          loading={saving}
          disabled={!noteText.trim()}
        >
          Add
        </CandidateButton>
      </div>
      {msg && <p className="mt-2 max-w-prose text-xs text-ink-secondary">{msg}</p>}
    </SurfaceCard>
  );
}

/* ── Appeals + one-time grant link ──────────────────────────────────── */

function AppealsSection({
  candidateId,
  sessions,
}: {
  candidateId: string;
  sessions: CandidateDetail["sessions"];
}) {
  const headingId = useId();
  const [appeals, setAppeals] = useState<AppealRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expiryHours, setExpiryHours] = useState(24);
  const [selectedSession, setSelectedSession] = useState(sessions[0]?.id ?? "");
  const [issuing, setIssuing] = useState(false);
  const [grantLink, setGrantLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api
      .listAppeals(candidateId)
      .then((r) => setAppeals(r.appeals))
      .catch((e: ApiError) => setErr(e.message));
  }, [candidateId]);

  useEffect(load, [load]);

  async function issueGrant() {
    if (!selectedSession) return;
    setIssuing(true);
    setMsg(null);
    setGrantLink(null);
    try {
      const res = await api.issueAppealGrant(candidateId, selectedSession, expiryHours);
      const link = `${window.location.origin}/appeal#${res.appeal_grant_token}`;
      setGrantLink(link);
      setMsg(
        `Grant issued — expires ${formatDateTime(res.expires_at)}. ` +
          "Send this one-time link to the candidate.",
      );
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Failed to issue appeal grant.");
    } finally {
      setIssuing(false);
    }
  }

  return (
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
        Appeals
      </h2>
      <p className="mb-3 mt-0.5 text-[13px] text-ink-tertiary">
        Open and resolved appeals for this candidate.
      </p>
      {err ? (
        <p className="text-sm text-error">{err}</p>
      ) : appeals === null ? (
        <p className="text-sm text-ink-tertiary">Loading appeals…</p>
      ) : appeals.length === 0 ? (
        <p className="text-sm text-ink-secondary">No appeals.</p>
      ) : (
        <ul className="divide-y divide-line">
          {appeals.map((a) => (
            <li key={a.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-ink">{a.category}</p>
                <Tag
                  tone={
                    a.status === "open" || a.status === "under_review"
                      ? "accent"
                      : "positive"
                  }
                  srPrefix="Appeal status:"
                >
                  {a.status}
                </Tag>
              </div>
              <p className="mt-0.5 max-w-prose whitespace-pre-wrap leading-relaxed text-ink-secondary">
                {a.description}
              </p>
              <p className="mt-0.5 text-xs text-ink-tertiary">
                {formatDateTime(a.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <SurfaceCard level="sunken" className="mt-4 p-3">
        <h3 className="text-[13px] font-medium text-ink">Issue appeal grant</h3>
        <p className="mt-0.5 text-xs leading-snug text-ink-tertiary">
          A one-time fragment link the candidate opens at /appeal. Explicit
          expiry is required (1–72 hours); the plaintext is shown only once.
        </p>
        {/* One row: choose the session, state the expiry, issue. Same ids,
            same labels, same call. */}
        <div className="mt-3 grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_11rem_auto] sm:items-end">
          <div className="min-w-0">
            <label htmlFor="appeal-session" className="block text-[13px] font-medium text-ink-secondary">
              Session
            </label>
            <CandidateSelect
              id="appeal-session"
              value={selectedSession}
              onChange={(e) => setSelectedSession(e.target.value)}
              className="mt-1 block w-full"
            >
              {sessions.length === 0 ? (
                <option value="">No sessions</option>
              ) : (
                sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id.slice(0, 8)} ({sessionStatusLabel(s.status)})
                  </option>
                ))
              )}
            </CandidateSelect>
          </div>
          <div className="min-w-0">
            <label htmlFor="appeal-expiry" className="block text-[13px] font-medium text-ink-secondary">
              Expires in (hours, 1–72)
            </label>
            <CandidateInput
              id="appeal-expiry"
              type="number"
              min={1}
              max={72}
              value={expiryHours}
              onChange={(e) => setExpiryHours(Number(e.target.value))}
              className="mt-1 block w-full"
            />
          </div>
          <CandidateButton
            variant="secondary"
            onClick={() => void issueGrant()}
            loading={issuing}
            disabled={!selectedSession}
          >
            Issue one-time appeal grant
          </CandidateButton>
        </div>
        {msg && <p className="mt-2 max-w-prose text-xs text-ink-secondary">{msg}</p>}
        {grantLink && (
          <div className="mt-2 rounded-control border border-[var(--c-border)] bg-[var(--c-surface)] p-3">
            <p className="text-xs font-semibold text-ink-secondary">One-time link (shown once)</p>
            <code className="block break-all text-xs text-ink-secondary">{grantLink}</code>
            <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-ink-tertiary">
              Contains a secret token in the fragment — share it only with the
              candidate. It is never stored by the app.
            </p>
          </div>
        )}
      </SurfaceCard>
    </SurfaceCard>
  );
}

/* ── CSV export ─────────────────────────────────────────────────────── */

function CsvExportButton({ candidateId }: { candidateId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const csv = await api.exportCsv(candidateId);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `screening-export-${candidateId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed to export CSV.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <CandidateButton
        variant="secondary"
        onClick={() => void download()}
        loading={busy}
      >
        Export screening data (scorecard + transcript)
      </CandidateButton>
      {err && (
        <p className="mt-1 rounded bg-[var(--c-surface)] px-2 py-1 text-xs text-error">
          {err}
        </p>
      )}
    </div>
  );
}
