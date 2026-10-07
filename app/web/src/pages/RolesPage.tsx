import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { questionTag, sectionHeading } from "../types";
import type { Role, RoleInput, ScreeningCategory, ScreeningQuestion } from "../types";
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PAGE_SIZES,
  PageHeader,
  Pagination,
  RevealGroup,
  RevealItem,
  SectionHeader,
  SegmentedControl,
  SlideOver,
  TextArea,
  TextField,
  cx,
  usePagination,
} from "../components/design";
import { buttonClass } from "../components/design";
import { RoleScorecardEditor } from "../components/roles/RoleScorecardEditor";
import { AskHelloButton } from "../components/roles/AskHelloButton";
// The metric library lives in `mission-control/` and STAYS there. It depends on
// `ConfirmButton` and `statusMeta` from that folder, so relocating it to
// `roles/` would drag two more components across for a cosmetic win. Mission
// Control no longer renders it; this page does.
// Imported from the FILE, not the `mission-control` barrel: the barrel also
// re-exports AccessSection and friends, and pulling it in would drag the whole
// Mission Control graph into the Roles chunk for one panel.
import { ScorebarSection } from "../components/mission-control/ScorebarSection";
import { useAuth } from "../lib/auth";
import { agentLabel, agentWithRoleLabel, roleAgentName } from "../lib/role-label";

interface QuestionRow {
  id: string;
  question: string;
  weight: number;
  /**
   * Rendered as `[MUST ASK] ` in the phone worker's prompt and prioritised
   * when the call runs long.
   *
   * CARRIED, NOT STRIPPED. The form used to drop this on the way to Save, so
   * the arc's "always ask CTC and notice" was true of the draft and false of
   * the call — the worker saw four ordinary bank entries inside a prompt that
   * says to cover the bank "where relevant".
   */
  mandatory?: boolean;
  /** Which compartment this question belongs to; absent on older roles. */
  category?: ScreeningCategory;
}

function emptyQuestion(index: number): QuestionRow {
  return { id: `q${index}`, question: "", weight: 1 };
}

function spokenQuestionIssue(question: string, allQuestions: QuestionRow[], index: number): string | null {
  const text = question.trim();
  if (!text) return null;
  if (text.length > 2000) return "Question is too long.";
  if (/\b(system|developer|assistant|model|prompt|instruction|interviewer|recruiter)\b|\b(must|should|do not|don't)\s+(ask|say|tell|mention|reveal|ignore)\b|[\[\]{}<>]/i.test(text)) {
    return "Use candidate-facing spoken language, not instructions or markup.";
  }
  if (!/[?]|\b(tell|describe|walk|explain|what|how|why|when|where|which|could|can|have|did|would|are|do|is)\b/i.test(text)) {
    return "Write a speakable candidate-facing question.";
  }
  const normalized = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  if (normalized && allQuestions.some((other, otherIndex) => otherIndex !== index && spokenQuestionIssueKey(other.question) === normalized)) {
    return "This question duplicates another question.";
  }
  return null;
}

function spokenQuestionIssueKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** The list's heading; the `<ul>` is named by it. One list per page. */
const ROLES_LIST_HEADING = "roles-list-heading";

/**
 * How many skills a row names before the rest fold into "+N". Three fit the
 * facts column on one or two lines; the full list is one hover away and is
 * read out in full to a screen reader.
 */
const SKILLS_SHOWN = 3;

/**
 * Row controls: 36px at a desk (design rule 5), a 44px target under a finger
 * or at phone width. Both, because a narrow desktop window has a mouse and a
 * tablet in landscape does not.
 */
const ROW_CONTROL = "max-sm:h-11 [@media(pointer:coarse)]:h-11";

/**
 * The list's one-line summary: "6 roles, 5 active". Counts EVERY role, not
 * the visible page. An archived role stays listed as Inactive (see
 * `removeRole`), so the two numbers are what an operator needs to trust that
 * a removal landed the way the note says.
 */
function rolesSummary(roles: Role[]): string {
  const active = roles.filter((role) => role.is_active).length;
  return `${roles.length} ${roles.length === 1 ? "agent" : "agents"}, ${active === 0 ? "none" : active} active`;
}

type StatusFilter = "all" | "active" | "inactive";

function parseStatusFilter(raw: string | null): StatusFilter {
  return raw === "active" || raw === "inactive" ? raw : "all";
}

export function RolesPage() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [scorebarOpen, setScorebarOpen] = useState(false);
  // Focus returns HERE on close, and the caller owns it — `SlideOver` explains
  // why `document.activeElement` is not good enough.
  const scorebarTrigger = useRef<HTMLButtonElement | null>(null);
  // ADMIN ONLY, and this is a real gate rather than decoration: every
  // `/api/scorecards/metrics` route is `requireRole('admin')` server-side, so
  // for anyone else the drawer would open onto a 403 and a save that cannot
  // land. Hiding the trigger is the honest version of that fact, not a
  // permission check we are inventing on the client.
  const { role: viewerRole } = useAuth();
  const canEditMetrics = viewerRole === "admin";

  const load = useCallback(() => {
    setError(null);
    setRoles(null);
    api
      .listRoles()
      .then(setRoles)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  /** The role currently being removed, so only its button says so. */
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** What the last removal did, in words. Cleared on the next one. */
  const [removalNote, setRemovalNote] = useState<string | null>(null);

  /**
   * Remove a role, and tell the operator WHICH of the three things happened.
   *
   * The server deletes only a role nothing references; one with candidates or
   * call sessions is ARCHIVED instead, so every historical record still says
   * which job it belonged to, and one mapped to an Ashby job is refused.
   *
   * AN ARCHIVED CARD STAYS ON THIS PAGE, flipped to "Inactive" — `GET
   * /api/roles` has no `is_active` filter. That is defensible, but it is not
   * what a button labelled Delete leads anyone to expect, so the note says
   * which of the three happened. An earlier version of this comment claimed
   * the card goes away in every case; it does not, and a maintainer would
   * have trusted it.
   */
  const removeRole = useCallback(
    async (role: Role) => {
      if (deletingId) return;
      // CONFIRMED, because this is destructive and one click from a list.
      // The wording promises only what the server will actually do.
      // Named as the card is — agent first, job in brackets — so the dialog
      // and the note both point at the card the operator just pressed.
      const name = agentWithRoleLabel(role);
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          `Remove "${name}"? If candidates have already been screened for it, it is archived rather than deleted so their records keep the job they applied for.`,
        )
      ) {
        return;
      }
      setRemovalNote(null);
      setError(null);
      setDeletingId(role.id);
      try {
        const result = await api.deleteRole(role.id);
        setRemovalNote(
          result.outcome === "archived"
            ? `"${name}" was archived rather than deleted — ${result.candidates ?? 0} candidate${result.candidates === 1 ? "" : "s"} and ${result.sessions ?? 0} session${result.sessions === 1 ? "" : "s"} still reference it.`
            : `"${name}" was deleted.`,
        );
        load();
      } catch (e) {
        // A 409 (mapped to an Ashby job) arrives here with the server's own
        // sentence, which names what to do about it.
        setError(e instanceof ApiError ? e.message : "Could not remove the agent.");
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, load],
  );

  // The status filter lives in the URL (?status=active|inactive) so it survives
  // a reload and Back. Absent or unknown means "all". It is NOT cleared by
  // `load()`: a removal reloads the list and the operator stays on the filter
  // they were using.
  const [searchParams, setSearchParams] = useSearchParams();
  const statusFilter = parseStatusFilter(searchParams.get("status"));
  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "all") params.delete("status");
          else params.set("status", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const statusCounts = useMemo(() => {
    const all = roles ?? [];
    const active = all.filter((role) => Boolean(role.is_active)).length;
    return { all: all.length, active, inactive: all.length - active };
  }, [roles]);
  const visibleRoles = useMemo(() => {
    const all = roles ?? [];
    if (statusFilter === "all") return all;
    // Same coercion as the counts and the row badge: anything not truthy is inactive.
    return all.filter((role) => Boolean(role.is_active) === (statusFilter === "active"));
  }, [roles, statusFilter]);

  // Changing the filter returns to page 1.
  const pager = usePagination(visibleRoles, 10, statusFilter);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Talent workspace"
        title="Agents"
        // NOT "the questions Gopu will ask". Each role now names its own
        // agent, and one hard-coded name in the page header contradicts every
        // role that chose a different one.
        description="Each agent screens candidates for one job, using the questions it asks."
        actions={
          canEditMetrics || editing === null ? (
            <>
              {canEditMetrics && (
                // A plain button wearing `buttonClass`. (`<Button>` takes a
                // `ref` too now; this one predates that and is equivalent.)
                <button
                  ref={scorebarTrigger}
                  type="button"
                  className={buttonClass("secondary", "md")}
                  onClick={() => setScorebarOpen(true)}
                  aria-haspopup="dialog"
                  aria-expanded={scorebarOpen}
                >
                  Scorebar
                </button>
              )}
              {editing === null && (
                <Button variant="primary" onClick={() => setEditing("new")}>
                  New agent
                </Button>
              )}
            </>
          ) : undefined
        }
      />

      <SlideOver
        open={scorebarOpen}
        onClose={() => setScorebarOpen(false)}
        idPrefix="scorebar"
        title="Scorebar"
        description="Reusable scoring metrics, shared by every agent. Editing one publishes a new version; agents already using it keep the copy they saved."
        returnFocusRef={scorebarTrigger}
      >
        <ScorebarSection />
      </SlideOver>

      {editing !== null && (
        <RoleForm
          key={editing === "new" ? "new" : editing.id}
          role={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {error && <ErrorPanel message={error} onRetry={load} />}

      {removalNote && (
        // `role="status"`, so the outcome is ANNOUNCED. Deleted and archived
        // are told apart only by this sentence — the archived card stays on
        // the page as "Inactive" and the deleted one goes — so someone who
        // cannot see the grid has nothing else to go on.
        <InlineNotice tone="info" role="status" className="mt-1">
          {removalNote}
        </InlineNotice>
      )}
      {!error && roles === null && <LoadingPanel label="Loading agents…" />}
      {!error && roles !== null && roles.length === 0 && editing === null && (
        <EmptyPanel
          title="No agents yet"
          hint="Create your first agent to start screening candidates."
          action={
            <Button variant="primary" onClick={() => setEditing("new")}>
              New agent
            </Button>
          }
        />
      )}

      {roles && roles.length > 0 && (
        // ONE SURFACE, ROWS SPLIT BY HAIRLINES (design rule 9). This was a
        // 3×2 wall of identical glass cards, each repeating the same pill,
        // chips and button pair, with the description cut mid-sentence. A
        // role is scanned, compared and acted on, which is a list's job.
        <RevealGroup>
          <RevealItem>
            <GlassPanel>
              <SectionHeader
                id={ROLES_LIST_HEADING}
                title="All agents"
                // Said once here, so nobody counts the rows to learn it.
                description={rolesSummary(roles)}
                // Right-aligned beside the title; SectionHeader wraps it
                // under the title on a phone.
                actions={
                  <SegmentedControl
                    ariaLabel="Filter agents by status"
                    size="sm"
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { value: "all", label: "All", count: statusCounts.all },
                      { value: "active", label: "Active", count: statusCounts.active },
                      { value: "inactive", label: "Inactive", count: statusCounts.inactive },
                    ]}
                  />
                }
              />
              {/* Announces what a filter did; silent while unfiltered. */}
              <p role="status" className="sr-only">
                {statusFilter === "all"
                  ? ""
                  : `Showing ${visibleRoles.length} of ${roles.length} ${roles.length === 1 ? "agent" : "agents"}`}
              </p>
              {visibleRoles.length === 0 ? (
                <div className="mt-4 flex flex-col items-start gap-3 border-t border-glass-ring pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-label text-ink-secondary">
                    {statusFilter === "active"
                      ? "No active agents right now."
                      : "No inactive agents. Every agent is active."}
                  </p>
                  <Button variant="secondary" onClick={() => setStatusFilter("all")}>
                    Show all agents
                  </Button>
                </div>
              ) : (
              <ul
                // `role="list"`: Safari drops list semantics from a list
                // styled without markers, and "list, 6 items" is how a screen
                // reader user learns the size of what follows.
                role="list"
                aria-labelledby={ROLES_LIST_HEADING}
                className="mt-2 divide-y divide-glass-ring"
              >
                {pager.items.map((role) => (
                  <RoleRow
                    key={role.id}
                    role={role}
                    deleting={deletingId === role.id}
                    anyDeleting={deletingId !== null}
                    onEdit={() => setEditing(role)}
                    onDelete={() => void removeRole(role)}
                  />
                ))}
              </ul>
              )}
              {/* Paging controls only when there is more than one page's
                  worth at the smallest size. "Showing 1–6 of 6 agents" with
                  disabled arrows was a second way of saying the summary. */}
              {pager.total > PAGE_SIZES[0] && (
                <Pagination
                  state={pager}
                  noun="agents"
                  className="mt-4 border-t border-glass-ring"
                />
              )}
            </GlassPanel>
          </RevealItem>
        </RevealGroup>
      )}
    </div>
  );
}

/**
 * One role on the list: who it is, what it asks, whether it is live, and the
 * two things an operator can do to it.
 *
 * FOUR COLUMNS AT A DESK, so the facts, the states and the buttons line up
 * down the list and can be scanned. Every row is its own grid, which is why
 * the status column is a fixed width rather than `auto`: an "Inactive" row
 * would otherwise sit out of line with its "Active" neighbours. Below `xl`
 * the facts drop under the description; on a phone the buttons take a line of
 * their own.
 *
 * DOM ORDER IS READING ORDER: name, job, description, state, facts, then Edit
 * and Delete. Only placement classes move things on screen, and nothing
 * focusable moves, so Tab still reaches Edit then Delete, row by row, as it
 * did on the cards.
 */
function RoleRow({
  role,
  deleting,
  anyDeleting,
  onEdit,
  onDelete,
}: {
  role: Role;
  /** This row's removal is in flight. */
  deleting: boolean;
  /** Some row's removal is in flight; every Delete refuses meanwhile. */
  anyDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const headingId = useId();
  const label = agentLabel(role);
  const jd = role.jd.trim();
  const questions = role.screening_template.length;
  const skills = role.required_skills;
  const shownSkills = skills.slice(0, SKILLS_SHOWN);
  const foldedSkills = skills.slice(SKILLS_SHOWN);

  return (
    <li
      data-role-row={role.id}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3 py-4 last:pb-0 md:grid-cols-[minmax(0,1fr)_5.5rem_auto] xl:grid-cols-[minmax(0,1fr)_14rem_5.5rem_auto]"
    >
      <div className="col-start-1 row-start-1 min-w-0">
        {/* AGENT FIRST, job second (owner request). The agent name is how an
            operator tells two roles apart day to day, so it is the heading; a
            role without one falls back to its title, so the heading is never
            blank. The agent name is never spoken to a candidate: `title`
            stays the only name the phone worker says.

            `title` carries the FULL text: `truncate` cuts an 80-character
            agent name to an ellipsis, and without it a sighted operator had
            no way to read the rest. The heading's accessible name is still
            its content, which was never truncated. An h3: the list's own
            heading ("All agents") is the h2 above it. */}
        <h3 id={headingId} title={label} className="truncate text-section text-ink">
          {label}
        </h3>
        {/* The job, underneath, only when the heading is NOT already the job.
            Repeating the title under itself would be noise, not information.
            Truncated too, so it carries its full text the same way. */}
        {roleAgentName(role) && (
          <p
            data-role-title-secondary=""
            title={`Role: ${role.title}`}
            className="truncate text-label font-medium text-ink-secondary"
          >
            Role: {role.title}
          </p>
        )}
        {jd && (
          // Two lines, then an ellipsis, with the whole text one hover away.
          // The clamp is visual only: a screen reader reads all of it. Capped
          // at a reading measure so a wide screen does not stretch it into
          // one 150-character line.
          <p title={jd} className="mt-1 line-clamp-2 max-w-[72ch] text-label text-ink-tertiary">
            {jd}
          </p>
        )}
      </div>

      {/* The state in words, in the state's colour. A dot and a word rather
          than a pill: on a list the column already says "this is the status",
          and six tinted pills were half of what made the cards read as a
          template. */}
      <p
        className={cx(
          "col-start-2 row-start-1 flex items-center gap-1.5 justify-self-end whitespace-nowrap text-label font-medium md:justify-self-start xl:col-start-3",
          role.is_active ? "text-success-text" : "text-ink-tertiary",
        )}
      >
        <span
          aria-hidden="true"
          className={cx("h-1.5 w-1.5 shrink-0 rounded-full", role.is_active ? "bg-success" : "bg-ink-muted")}
        />
        {role.is_active ? "Active" : "Inactive"}
      </p>

      <div className="col-span-2 row-start-2 flex min-w-0 flex-col text-label md:col-span-1 md:col-start-1 xl:col-start-2 xl:row-start-1">
        <p className="tabular-nums text-ink-secondary">
          {questions} screening question{questions === 1 ? "" : "s"}
        </p>
        {skills.length > 0 && (
          // The first few skills, then "+N". The folded ones are in the `+N`
          // tooltip for a mouse and spoken in full to a screen reader; the
          // tooltip itself is hidden from assistive tech so the list is not
          // read twice.
          <p className="text-ink-tertiary">
            <span className="sr-only">Skills: </span>
            {shownSkills.join(", ")}
            {foldedSkills.length > 0 && (
              <>
                {/* A no-break space: "+1" never wraps onto a line alone. */}
                {" "}
                <span
                  aria-hidden="true"
                  title={foldedSkills.join(", ")}
                  data-role-skills-more=""
                  className="cursor-help font-medium tabular-nums text-ink-secondary"
                >
                  +{foldedSkills.length}
                </span>
                <span className="sr-only">, {foldedSkills.join(", ")}</span>
              </>
            )}
          </p>
        )}
      </div>

      {/* `min-w-0`, NOT `shrink-0`, and `flex-wrap`: on a phone this line is
          the row's full width and must never be wider than the screen. At a
          desk the buttons are nudged up so their centre sits on the heading's
          line rather than below it. */}
      <div className="col-span-2 row-start-3 flex min-w-0 flex-wrap items-center gap-2 md:col-span-1 md:col-start-3 md:row-start-1 md:-mt-2 md:justify-end xl:col-start-4">
        <Button
          variant="secondary"
          className={ROW_CONTROL}
          onClick={onEdit}
          // The NAME stays "Edit", matching what is on screen; the row's
          // heading is the description, so navigating by control still says
          // which role six identical Edit buttons belong to.
          aria-describedby={headingId}
        >
          Edit
        </Button>
        <Button
          // Quiet until the confirmation (design rule 10): red ink and a red
          // outline on the row, never a filled red button on every one.
          variant="danger-quiet"
          className={ROW_CONTROL}
          onClick={onDelete}
          // NAMED FOR THE ROLE, and the name FOLLOWS THE STATE. A page of six
          // rows means six identical "Delete" controls to anyone navigating
          // by control; the name tells them apart and is the last thing they
          // hear before a destructive action. A static label while the
          // visible text becomes "Deleting…" is the SC 2.5.3 mismatch the
          // Rephrase button was fixed for.
          //
          // The name LEADS WITH WHAT THE ROW'S HEADING SAYS (the agent), then
          // the job in brackets, so a screen reader hears the same name a
          // sighted operator sees.
          aria-label={
            deleting ? `Deleting agent ${agentWithRoleLabel(role)}…` : `Delete agent ${agentWithRoleLabel(role)}`
          }
          aria-busy={deleting}
          aria-disabled={anyDeleting}
        >
          {deleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </li>
  );
}

function RoleForm({
  role,
  onCancel,
  onSaved,
}: {
  role: Role | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(role?.title ?? "");
  const [agentName, setAgentName] = useState(role?.agent_name ?? "");
  const [jd, setJd] = useState(role?.jd ?? "");
  // Read-only on this form since the textarea was removed: the value is
  // still submitted, so an existing role keeps what it was saved with.
  const [interviewerInstructions] = useState(role?.interviewer_instructions ?? "");
  const [skillsText, setSkillsText] = useState(
    role?.required_skills.join(", ") ?? "",
  );
  const [questions, setQuestions] = useState<QuestionRow[]>(
    role?.screening_template.map((q) => ({
      id: q.id,
      question: q.question,
      weight: q.weight,
      category: q.category,
      // CARRIED THROUGH THE EDIT ROUND TRIP. `PUT /api/roles/:id` replaces
      // `screening_template` wholesale, and this map is what it is rebuilt
      // from — so dropping the flag here meant opening a role to fix a typo
      // in the JD and silently removing every `[MUST ASK]` from it on Save.
      // The flag appears nowhere in the UI, so it was invisible and
      // unrecoverable short of re-running a ten-minute draft.
      mandatory: q.mandatory,
    })) ?? [emptyQuestion(1)],
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** Set after Ask Hello fills the form; cleared once the role is saved. */
  const [draftNote, setDraftNote] = useState<string | null>(null);
  /**
   * Ask Hello's own failures, kept SEPARATE from `formError`.
   * `formError` renders beside the Save button, below the question list and
   * the prompt preview — roughly 1200px down. After a ten-minute wait, that is
   * off screen at exactly the moment an explanation is needed, and moving it
   * up would put save errors far from Save. Two slots, each next to its own
   * button.
   */
  const [draftError, setDraftError] = useState<string | null>(null);

  /**
   * The question currently being rewritten, and what went wrong last time.
   *
   * The index, not a boolean, because the UI has to say WHICH row is busy —
   * one shared flag would spin all eight buttons. It is not a concurrency
   * mechanism: `rephrase()` returns early while another is in flight and
   * every button is `aria-disabled` meanwhile, so exactly one request is ever
   * out. (An earlier version of this comment claimed the opposite, and a
   * maintainer reading it would go looking for a per-row queue that does not
   * exist.)
   */
  const [rephrasingIdx, setRephrasingIdx] = useState<number | null>(null);
  const [rephraseError, setRephraseError] = useState<{ idx: number; message: string } | null>(
    null,
  );
  /** What the live region says. Empty between rephrases, so each one is new. */
  const [rephraseStatus, setRephraseStatus] = useState("");
  /**
   * The live question list, readable synchronously.
   *
   * `setQuestions(prev => …)` does NOT run its updater when it is called —
   * React schedules it — so deciding inside the updater whether the rewrite
   * landed, and then reading that decision on the next line, reads a value
   * that has not been computed yet. It was always `false`, so the success
   * announcement never fired. The guard needs a synchronous read of the
   * current list, which is what this is.
   */
  const questionsRef = useRef<QuestionRow[]>(questions);
  questionsRef.current = questions;

  async function rephrase(idx: number) {
    // THE GUARD IS THE DISABLE. With `aria-disabled` the element stays
    // focusable and clickable, so this is what actually stops a second press
    // and an empty question — not decoration on top of a `disabled` attribute.
    const text = questions[idx]?.question.trim();
    if (!text || rephrasingIdx !== null) return;
    setRephraseError(null);
    setRephraseStatus(`Rephrasing question ${idx + 1}…`);
    setRephrasingIdx(idx);
    try {
      const { question } = await api.rephraseQuestion(text);
      // THE INDEX IS NOT AN IDENTITY. The functional updater kept a stale
      // snapshot from restoring a deleted row, but it did nothing about the
      // list RESHUFFLING: remove row 1 while row 4's rephrase is out and
      // index 4 now addresses what used to be row 5, so the rewrite of one
      // question silently overwrote a different one — proven by a reviewer,
      // with the fifth question's text simply gone and no error shown.
      //
      // Neither Add nor Remove is disabled during a rephrase, and pruning an
      // eight-row draft while one is out is the normal workflow. So the row
      // is identified by WHAT WAS SENT: if the text at that index is no
      // longer the text this call was made about, the answer is discarded.
      const applied = questionsRef.current[idx]?.question.trim() === text;
      if (applied) {
        setQuestions((prev) =>
          prev[idx]?.question.trim() === text
            ? prev.map((q, i) => (i === idx ? { ...q, question } : q))
            : prev,
        );
      }
      setRephraseStatus(
        applied
          ? `Question ${idx + 1} rephrased.`
          : `Question ${idx + 1} changed while Hello was rewriting it, so the rewrite was discarded.`,
      );
    } catch (err) {
      // 422 is the model failing to phrase it, not an outage. Either way the
      // operator's own text is left exactly as they typed it.
      const message = err instanceof ApiError ? err.message : "Rephrase failed. Try again.";
      setRephraseError({ idx, message });
      setRephraseStatus(`Question ${idx + 1}: ${message}`);
    } finally {
      setRephrasingIdx(null);
    }
  }

  function updateQuestion(idx: number, patch: Partial<QuestionRow>) {
    // A rephrase failure is about the text as it WAS. Editing the row answers
    // it, and leaving the message up (it deliberately outranks the live gate
    // message) hid whether the hand-written fix actually passed — the
    // operator found out at Save, a long scroll away.
    setRephraseError((prev) => (prev?.idx === idx ? null : prev));
    setQuestions((prev) =>
      prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)),
    );
  }

  function addQuestion() {
    setQuestions((prev) => [...prev, emptyQuestion(prev.length + 1)]);
  }

  function removeQuestion(idx: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!title.trim()) {
      setFormError("Job role is required.");
      return;
    }
    const questionIssue = questions
      .map((q, index) => spokenQuestionIssue(q.question, questions, index))
      .find(Boolean);
    if (questionIssue) {
      setFormError(questionIssue);
      return;
    }

    const required_skills = skillsText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const screening_template: ScreeningQuestion[] = questions
      .filter((q) => q.question.trim())
      .map((q, i) => ({
        id: q.id || `q${i + 1}`,
        question: q.question.trim(),
        weight: Number(q.weight) || 1,
        // Only when set: `screeningQuestionSchema` has it optional, and
        // sending `mandatory: false` on every hand-written question would
        // write a claim the operator never made.
        ...(q.mandatory ? { mandatory: true } : {}),
        ...(q.category ? { category: q.category } : {}),
      }));

    const body: RoleInput = {
      title: title.trim(),
      // Blank means unset, which the API stores as NULL — one representation,
      // matching the column's check constraint.
      // SENT ONLY WHEN IT MEANS SOMETHING, and that is a deploy-ordering
      // guard rather than tidiness. `roles.agent_name` arrives in 0100, and
      // the web app ships independently of `supabase db push` — until the
      // migration lands, PostgREST rejects the unknown column (PGRST204) and
      // the route 500s. Sending it unconditionally would therefore break ALL
      // role creation and editing, including for the roles that never wanted
      // an agent name, which is every existing one.
      //
      // Omitted when the box is blank and the role never had a value: the
      // overwhelming majority of saves carry no key at all and keep working.
      // A blank box on a role that HAS one is a real edit — "clear it" — so
      // that still sends an explicit null and still needs the migration.
      ...(agentName.trim() || role?.agent_name
        ? { agent_name: agentName.trim() ? agentName.trim() : null }
        : {}),
      jd: jd.trim(),
      required_skills,
      screening_template,
      interviewer_instructions: interviewerInstructions.trim(),
    };

    setSaving(true);
    try {
      if (role) await api.updateRole(role.id, body);
      else await api.createRole(body);
      onSaved();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
    <GlassPanel padding="lg">
      <SectionHeader
        title={role ? "Edit agent" : "New agent"}
        description="The job role, focus and questions below drive the screening conversation."
      />
      <form onSubmit={handleSubmit} className="mt-5 space-y-5">
        {/* ABOVE the job role, because it is what the operator calls this
            screener day to day. It is NEVER spoken: `title` is the job the
            candidate applied for and remains the only name the phone worker
            reads aloud. */}
        <Field label="Agent" id="role-agent-name" hint="Your internal name for this screener. Never spoken to candidates.">
          {({ id, describedBy }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              value={agentName}
              maxLength={80}
              placeholder="e.g. Gopu"
              onChange={(e) => setAgentName(e.target.value)}
            />
          )}
        </Field>

        <Field label="Job role" id="role-title">
          {({ id }) => (
            <TextField
              id={id}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Senior Frontend Engineer"
            />
          )}
        </Field>

        {/* Drafts the three fields below from the job role above. Placed
            here, between the input it reads and the fields it writes, so the
            direction is obvious. */}
        <AskHelloButton
          className="mt-1"
          jobRole={title}
          // A FUNCTION, read when the draft LANDS, not when it starts. The
          // confirm at t=0 cannot know what was typed during the eight minutes
          // that followed, and a draft replacing hand-written questions is
          // data loss.
          wouldOverwrite={() =>
            Boolean(jd.trim() || skillsText.trim() || questions.some((q) => q.question.trim()))
          }
          onError={(message) => {
            setDraftError(message);
            setDraftNote(null);
          }}
          // A reload leaves this field blank while a draft is still running.
          // Filling it from the adopted job makes the screen true: the button
          // says "Asking Hello…" and the field says what Hello is drafting.
          // Information, not an error: nothing the operator did was wrong.
          onBusy={(message) => {
            setDraftNote(message);
            setDraftError(null);
          }}
          onResumed={(resumedRole) => {
            setTitle((current) => (current.trim() ? current : resumedRole));
            setDraftNote(`Picked up the draft already running for "${resumedRole}".`);
          }}
          onDrafted={(draft, repaired, draftedFor) => {
            // The job's OWN job role, not the field's current value: the field
            // stays editable while a draft runs, so a draft written for
            // "Sales Advisr" can land under a heading that now reads something
            // else. Say which one it was rather than pretending.
            const staleTitle = draftedFor.trim() !== title.trim();
            const hasWork = Boolean(
              jd.trim() || skillsText.trim() || questions.some((q) => q.question.trim()),
            );
            // ASK ON A MISMATCH TOO, not only when there is work to lose. A
            // fresh form has nothing to overwrite, so `hasWork` is false —
            // and that is exactly the case where a draft for another role
            // used to fill the form silently, with only an info notice after
            // the fact.
            if (
              (hasWork || staleTitle) &&
              typeof window !== "undefined" &&
              !window.confirm(
                `Hello finished drafting "${draftedFor}". Replace the job description, skills and questions now in this form?`,
              )
            ) {
              setDraftNote(null);
              return;
            }

            setDraftError(null);
            setJd(draft.jd);
            setSkillsText(draft.required_skills.join(", "));
            setQuestions(
              draft.screening_template.map((q, i) => ({
                id: q.id || `q${i + 1}`,
                question: q.question,
                weight: q.weight ?? 1,
                mandatory: q.mandatory === true,
                category: q.category,
              })),
            );
            const rephrased =
              repaired.length > 0
                ? ` Hello rephrased ${repaired.length} question${
                    repaired.length === 1 ? "" : "s"
                  } the screener would not read aloud.`
                : "";
            setDraftNote(
              staleTitle
                ? `Drafted for "${draftedFor}", which is not what the job role says now — check it before saving.${rephrased}`
                : `Hello drafted this agent. Review it before saving.${rephrased}`,
            );
          }}
        />

        {/* Both notices sit HERE, beside the button that produced them. */}
        {draftError && (
          <InlineNotice tone="danger" role="alert" className="mt-1">
            {draftError}
          </InlineNotice>
        )}
        {/* Said plainly, because a drafted role is NOT a saved role and the
            form gives no other signal that a model wrote what is on screen.

            A PERMANENT region, not one mounted with its content: a live region
            created at the same moment it gains text is not reliably announced,
            and this is the sentence the operator waited ten minutes for. The
            button's own status region is built the same way for the same
            reason. */}
        <div role="status" aria-live="polite" data-role-draft-note="">
          {draftNote && (
            // A <div>, not a <p>: InlineNotice renders a div, React refuses
            // div-inside-p with a console.error, and this project's test
            // harness FAILS the suite on an unexpected console.error. It
            // stayed green only because no test exercised the draft-note path.
            //
            // `role="none"` because the wrapper above is the live region.
            // InlineNotice defaults to `status`, and nesting one region inside
            // another invites the same sentence being announced twice.
            <InlineNotice tone="info" role="none" className="mt-1">
              {draftNote}
            </InlineNotice>
          )}
        </div>

        <Field label="Job description" id="role-jd">
          {({ id }) => (
            <TextArea
              id={id}
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              rows={4}
              placeholder="Paste the JD or a short summary…"
            />
          )}
        </Field>

        <Field
          label="Required skills"
          id="role-skills"
          hint="Separate skills with commas."
        >
          {({ id, describedBy }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
              placeholder="React, TypeScript, CSS (comma-separated)"
            />
          )}
        </Field>

        <div>
          <SectionHeader
            level={3}
            title="Screening questions"
            actions={
              <Button type="button" variant="ghost" size="sm" onClick={addQuestion}>
                Add question
              </Button>
            }
          />
          {/*
            * PERMANENT, and outside the loop. Success silently rewrites an
            * input's value — a screen reader says nothing at all about it,
            * and the operator who pressed the button is the one person who
            * needs to know it landed. A region mounted WITH its content is
            * not reliably announced, which is why this is always present and
            * only its text changes (the same conclusion `AskHelloButton`
            * reached and documents).
            */}
          <p role="status" aria-live="polite" className="sr-only">
            {rephraseStatus}
          </p>
          <div className="mt-3 space-y-3">
            {questions.map((q, idx) => {
              const issue = spokenQuestionIssue(q.question, questions, idx);
              // A HEADING WHEN THE COMPARTMENT CHANGES, not a nested list.
              // The order of this array IS the order of the call — the plan
              // builder copies it verbatim — so grouping by re-ordering the
              // rows would silently re-order the conversation. The rows stay
              // exactly as they will be asked; the heading just says where one
              // compartment ends and the next begins.
              //
              // THE LABEL IS LOOKED UP BEFORE THE HEADING IS DECIDED, because
              // the category arrives off the wire and the lookup is typed as
              // total but is not. A compartment this build does not know would
              // otherwise render an EMPTY `<h4>` — invisible on screen, an
              // `empty-heading` violation to a screen reader, and a lie about
              // where the compartment boundary is. Unknown means unlabelled
              // means no heading.
              //
              // The uncategorised TAIL gets its own break rather than falling
              // under the previous heading. Pressing "Add question" on a
              // compartmented role appends a row with no category, and sitting
              // it silently under "Compensation and notice" would tell the
              // recruiter their new question belongs to a compartment it has
              // nothing to do with.
              const label = sectionHeading(q.category, questions[idx - 1]?.category);
              return (
                <div key={idx} className="space-y-3">
                  {label && (
                    <h4 className="pt-1 text-label font-semibold leading-5 text-ink-secondary">
                      {label}
                    </h4>
                  )}
                <div className="glass-sunken space-y-3 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="font-mono text-meta text-ink-tertiary"
                      // The id is still worth having when there is no topic —
                      // it is what an older role has — but it is a poor tag
                      // for a human, so the topic wins when one exists.
                      title={q.id || `q${idx + 1}`}
                    >
                      {questionTag(q.category, q.id, idx)}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void rephrase(idx)}
                        // `aria-disabled`, NOT `disabled`, and the handler
                        // guards — the idiom `AskHelloButton` already uses
                        // twice in this codebase, for the reason stated
                        // there: a real `disabled` blurs the element the
                        // instant it is pressed by keyboard, dropping the
                        // user to <body> so the next Tab restarts from the
                        // top of the page. jsdom does not reproduce that
                        // blur, which is exactly why a test suite cannot be
                        // the thing that catches it.
                        //
                        // Nothing is faded either. `disabled:opacity-50` put
                        // the whole eight-button column at 2.56:1 the moment
                        // one request went out, which reads as "the form
                        // broke" rather than "one request is out" — and it
                        // landed hardest on the one row whose label is the
                        // only progress this feature shows.
                        aria-disabled={rephrasingIdx !== null || !q.question.trim()}
                        aria-busy={rephrasingIdx === idx}
                        // THE STATE IS IN THE ACCESSIBLE NAME. A static
                        // `aria-label` OVERRIDES the visible text, so
                        // "Rephrasing…" was rendered on screen and invisible
                        // to a screen reader — and the visible label was no
                        // longer contained in the accessible name, which is
                        // SC 2.5.3 (Label in Name) verbatim.
                        aria-label={
                          rephrasingIdx === idx
                            ? `Rephrasing question ${idx + 1}…`
                            : `Rephrase question ${idx + 1}`
                        }
                        // The Ask Hello pill, verbatim. Both buttons on this
                        // form ask a model for words; looking alike is the
                        // point. NO `opacity-*` in this list — see
                        // `AskHelloButton` for the measurement: fading the
                        // pill fades the white label with it and drops it
                        // under 4.5:1, and the faded state here is exactly
                        // the one the operator is waiting on.
                        className={`ask-hello relative inline-flex min-h-11 items-center gap-2 overflow-hidden rounded-full px-5 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-info ${
                          rephrasingIdx !== null || !q.question.trim()
                            ? 'ask-hello--idle cursor-not-allowed'
                            : ''
                        }${rephrasingIdx === idx ? ' cursor-progress' : ''}`}
                      >
                        <span aria-hidden="true" className="ask-hello__sheen" />
                        <span aria-hidden="true" className="relative">
                          {rephrasingIdx === idx ? '◐' : '✦'}
                        </span>
                        <span className="relative">
                          {rephrasingIdx === idx ? "Rephrasing…" : "Rephrase"}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeQuestion(idx)}
                        aria-label={`Remove question ${idx + 1}`}
                        disabled={questions.length === 1}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3">
                    <Field
                      className="min-w-0 flex-1"
                      label={`Question ${idx + 1}`}
                      id={`role-question-${idx}`}
                      // The row's OWN failure wins over the static validation
                      // message: "Hello could not rephrase that" is news, and
                      // the gate complaint underneath it is what the operator
                      // already knew.
                      error={
                        (rephraseError?.idx === idx ? rephraseError.message : null) ??
                        issue ??
                        undefined
                      }
                    >
                      {({ id, describedBy, invalid }) => (
                        <TextField
                          id={id}
                          aria-describedby={describedBy}
                          value={q.question}
                          onChange={(e) =>
                            updateQuestion(idx, { question: e.target.value })
                          }
                          placeholder="Question text…"
                          aria-invalid={invalid}
                        />
                      )}
                    </Field>
                  </div>
                </div>
                </div>
              );
            })}
          </div>
        </div>

        {formError && (
          <InlineNotice tone="danger" role="alert">
            {formError}
          </InlineNotice>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" variant="primary" loading={saving}>
            {role ? "Save changes" : "Create agent"}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </GlassPanel>

      {/*
        Per-role scorecard configuration. Only for an EXISTING role — a new,
        unsaved role has no id to attach a scorecard version to. Save the role
        first, reopen it, then configure the scorecard here.
      */}
      {role && <RoleScorecardEditor roleId={role.id} />}
    </div>
  );
}
