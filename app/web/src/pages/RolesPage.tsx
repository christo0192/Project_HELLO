import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Role, RoleInput, ScreeningQuestion } from "../types";
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PageHeader,
  Pagination,
  RevealGroup,
  RevealItem,
  SectionHeader,
  StatusBadge,
  TextArea,
  TextField,
  usePagination,
} from "../components/design";
import { RoleScorecardEditor } from "../components/roles/RoleScorecardEditor";
import { AskHelloButton } from "../components/roles/AskHelloButton";

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

export function RolesPage() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Role | "new" | null>(null);

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
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          `Remove "${role.title}"? If candidates have already been screened for it, it is archived rather than deleted so their records keep the job they applied for.`,
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
            ? `"${role.title}" was archived rather than deleted — ${result.candidates ?? 0} candidate${result.candidates === 1 ? "" : "s"} and ${result.sessions ?? 0} session${result.sessions === 1 ? "" : "s"} still reference it.`
            : `"${role.title}" was deleted.`,
        );
        load();
      } catch (e) {
        // A 409 (mapped to an Ashby job) arrives here with the server's own
        // sentence, which names what to do about it.
        setError(e instanceof ApiError ? e.message : "Could not remove the role.");
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, load],
  );

  const pager = usePagination(roles ?? [], 10);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Talent workspace"
        title="Roles"
        // NOT "the questions Gopu will ask". Each role now names its own
        // agent, and one hard-coded name in the page header contradicts every
        // role that chose a different one.
        description="Define the jobs candidates are screened for and the questions the screening agent will ask."
        actions={
          editing === null ? (
            <Button variant="primary" onClick={() => setEditing("new")}>
              New role
            </Button>
          ) : undefined
        }
      />

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
      {!error && roles === null && <LoadingPanel label="Loading roles…" />}
      {!error && roles !== null && roles.length === 0 && editing === null && (
        <EmptyPanel
          title="No roles yet"
          hint="Create your first role to start screening candidates against it."
          action={
            <Button variant="primary" onClick={() => setEditing("new")}>
              New role
            </Button>
          }
        />
      )}

      {roles && roles.length > 0 && (
        <div>
          <RevealGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {pager.items.map((role) => (
              <RevealItem key={role.id} as="article" className="h-full">
                <GlassPanel
                  interactive
                  padding="sm"
                  className="flex h-full flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">
                        {role.title}
                      </h2>
                      {/* SHOWN, because a field you can only write is a field
                          nobody can check. The agent name is how an operator
                          tells two roles apart internally; it is never spoken
                          to a candidate, and the label says so. */}
                      {role.agent_name && (
                        <p
                          data-role-agent-name=""
                          className="mt-0.5 truncate text-xs text-ink-tertiary"
                        >
                          Agent: {role.agent_name}
                        </p>
                      )}
                    </div>
                    <StatusBadge tone={role.is_active ? "success" : "neutral"}>
                      {role.is_active ? "Active" : "Inactive"}
                    </StatusBadge>
                  </div>
                  <p className="line-clamp-2 text-sm leading-6 text-ink-secondary">
                    {role.jd}
                  </p>
                  {role.required_skills.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {role.required_skills.map((s) => (
                        <li
                          key={s}
                          className="rounded-full bg-ink/[0.05] px-2 py-0.5 text-xs font-medium text-ink-secondary"
                        >
                          {s}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-auto flex items-end justify-between gap-3 pt-1">
                    <p className="text-[13px] text-ink-tertiary">
                      {role.screening_template.length} screening question{role.screening_template.length === 1 ? "" : "s"}
                    </p>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditing(role)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void removeRole(role)}
                        // NAMED FOR THE ROLE, and the name FOLLOWS THE STATE.
                        // A page of six cards means six identical "Delete"
                        // controls to anyone navigating by control; the title
                        // tells them apart and is the last thing they hear
                        // before a destructive action. A static label while
                        // the visible text becomes "Deleting…" is the SC 2.5.3
                        // mismatch the Rephrase button two elements away was
                        // just fixed for.
                        aria-label={
                          deletingId === role.id
                            ? `Deleting role ${role.title}…`
                            : `Delete role ${role.title}`
                        }
                        aria-busy={deletingId === role.id}
                        aria-disabled={deletingId !== null}
                      >
                        {deletingId === role.id ? "Deleting…" : "Delete"}
                      </Button>
                    </div>
                  </div>
                </GlassPanel>
              </RevealItem>
            ))}
          </RevealGroup>
          <Pagination state={pager} noun="roles" />
        </div>
      )}
    </div>
  );
}

function PromptPreview({
  title,
  jd,
  skills,
  instructions,
  questions,
}: {
  title: string;
  jd: string;
  skills: string;
  instructions: string;
  questions: QuestionRow[];
}) {
  const questionLines = questions
    .filter((q) => q.question.trim())
    .map((q, i) => `${i + 1}. ${q.question.trim()}`);
  const focus = jd.trim() || skills.trim() || "Use the role requirements provided by the recruiter.";
  const prompt = [
    `You are conducting a first-round screening interview for ${title.trim() || "this role"}.`,
    "Interview conversationally, ask one question at a time, and adapt follow-ups to the candidate's answers.",
    `Role focus: ${focus}`,
    instructions.trim() ? `Recruiter guidance: ${instructions.trim()}` : "Recruiter guidance: none provided.",
    "Flow: opening → relevant experience → role evidence → one realistic scenario → logistics → candidate questions → closing.",
    questionLines.length ? `Recruiter questions:\n${questionLines.join("\n")}` : "Recruiter questions: none; generate role-specific questions from the focus.",
    "Do not ask protected or sensitive questions, reveal scores, promise a hiring outcome, or invent company facts.",
  ].join("\n\n");

  return (
    <div className="glass-sunken p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ink-secondary">
          Generated voice prompt preview
        </p>
        <span className="text-xs text-ink-tertiary">updates as you edit</span>
      </div>
      <pre
        role="region"
        aria-label="Generated voice prompt preview"
        tabIndex={0}
        className="max-h-72 overflow-auto whitespace-pre-wrap rounded-control bg-white/70 p-3 font-mono text-xs leading-5 text-ink-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
      >
        {prompt}
      </pre>
    </div>
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
  const [interviewerInstructions, setInterviewerInstructions] = useState(
    role?.interviewer_instructions ?? "",
  );
  const [skillsText, setSkillsText] = useState(
    role?.required_skills.join(", ") ?? "",
  );
  const [questions, setQuestions] = useState<QuestionRow[]>(
    role?.screening_template.map((q) => ({
      id: q.id,
      question: q.question,
      weight: q.weight,
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
        title={role ? "Edit role" : "New role"}
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
                : `Hello drafted this role. Review it before saving.${rephrased}`,
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
              return (
                <div key={idx} className="glass-sunken space-y-3 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-ink-tertiary">
                      {q.id || `q${idx + 1}`}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
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
                      >
                        {rephrasingIdx === idx ? "Rephrasing…" : "Rephrase"}
                      </Button>
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
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
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
                    <Field
                      className="sm:w-24"
                      label="Weight"
                      id={`role-question-${idx}-weight`}
                    >
                      {({ id }) => (
                        <TextField
                          id={id}
                          type="number"
                          min={0}
                          step={1}
                          value={q.weight}
                          onChange={(e) =>
                            updateQuestion(idx, { weight: Number(e.target.value) })
                          }
                          title="Weight"
                        />
                      )}
                    </Field>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Field
          label="Interviewer instructions"
          id="role-instructions"
          hint="This is included in the generated voice prompt and remains editable."
        >
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              value={interviewerInstructions}
              onChange={(e) => setInterviewerInstructions(e.target.value)}
              rows={5}
              placeholder="Optional guidance: what good evidence looks like, which probes to prioritize, and what the interviewer should avoid…"
            />
          )}
        </Field>

        <PromptPreview
          title={title}
          jd={jd}
          skills={skillsText}
          instructions={interviewerInstructions}
          questions={questions}
        />

        {formError && (
          <InlineNotice tone="danger" role="alert">
            {formError}
          </InlineNotice>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" variant="primary" loading={saving}>
            {role ? "Save changes" : "Create role"}
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
