import { useCallback, useEffect, useState } from "react";
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

interface QuestionRow {
  id: string;
  question: string;
  weight: number;
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

  const pager = usePagination(roles ?? [], 10);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Talent workspace"
        title="Roles"
        description="Define the jobs candidates are screened for and the questions Gopu will ask."
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
                    <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">
                      {role.title}
                    </h2>
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
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setEditing(role)}
                      className="shrink-0"
                    >
                      Edit
                    </Button>
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
    })) ?? [emptyQuestion(1)],
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function updateQuestion(idx: number, patch: Partial<QuestionRow>) {
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
      setFormError("Title is required.");
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
      }));

    const body: RoleInput = {
      title: title.trim(),
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
        description="The title, focus and questions below drive the screening conversation."
      />
      <form onSubmit={handleSubmit} className="mt-5 space-y-5">
        <Field label="Title" id="role-title">
          {({ id }) => (
            <TextField
              id={id}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Senior Frontend Engineer"
            />
          )}
        </Field>

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
          <div className="mt-3 space-y-3">
            {questions.map((q, idx) => {
              const issue = spokenQuestionIssue(q.question, questions, idx);
              return (
                <div key={idx} className="glass-sunken space-y-3 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-ink-tertiary">
                      {q.id || `q${idx + 1}`}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeQuestion(idx)}
                      aria-label="Remove question"
                      disabled={questions.length === 1}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <Field
                      className="min-w-0 flex-1"
                      label={`Question ${idx + 1}`}
                      id={`role-question-${idx}`}
                      error={issue ?? undefined}
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
