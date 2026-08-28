import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Role, RoleInput, ScreeningQuestion } from "../types";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Input,
  Label,
  LoadingState,
  PageHeader,
  Textarea,
} from "../components/ui";

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
  if (/\\b(system|developer|assistant|model|prompt|instruction|interviewer|recruiter)\\b|\\b(must|should|do not|don't)\\s+(ask|say|tell|mention|reveal|ignore)\\b|[\\[\\]{}<>]/i.test(text)) {
    return "Use candidate-facing spoken language, not instructions or markup.";
  }
  if (!/[?]|\\b(tell|describe|walk|explain|what|how|why|when|where|which|could|can|have|did|would|are|do|is)\\b/i.test(text)) {
    return "Write a speakable candidate-facing question.";
  }
  const normalized = text.toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim().replace(/\\s+/g, " ");
  if (normalized && allQuestions.some((other, otherIndex) => otherIndex !== index && spokenQuestionIssueKey(other.question) === normalized)) {
    return "This question duplicates another question.";
  }
  return null;
}

function spokenQuestionIssueKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim().replace(/\\s+/g, " ");
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

  return (
    <div>
      <PageHeader
        title="Roles"
        description="Define the jobs candidates are screened for and the questions Gopu will ask."
        action={
          editing === null && (
            <Button onClick={() => setEditing("new")}>New role</Button>
          )
        }
      />

      {editing !== null && (
        <div className="mb-6">
          <RoleForm
            role={editing === "new" ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              load();
            }}
          />
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && roles === null && <LoadingState label="Loading roles…" />}
      {!error && roles !== null && roles.length === 0 && editing === null && (
        <EmptyState
          title="No roles yet"
          hint="Create your first role to start screening candidates against it."
          action={<Button onClick={() => setEditing("new")}>New role</Button>}
        />
      )}

      {roles && roles.length > 0 && (
        <div className="space-y-3">
          {roles.map((role) => (
            <Card key={role.id} className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-gray-900">
                      {role.title}
                    </h2>
                    <Chip tone={role.is_active ? "green" : "neutral"}>
                      {role.is_active ? "Active" : "Inactive"}
                    </Chip>
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-gray-500">
                    {role.jd}
                  </p>
                  {role.required_skills.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {role.required_skills.map((s) => (
                        <Chip key={s} tone="accent">
                          {s}
                        </Chip>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-xs text-gray-400">
                    {role.screening_template.length} screening question
                    {role.screening_template.length === 1 ? "" : "s"}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => setEditing(role)}
                  className="shrink-0"
                >
                  Edit
                </Button>
              </div>
            </Card>
          ))}
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
    questionLines.length ? `Recruiter questions:\n${questionLines.join("\\n")}` : "Recruiter questions: none; generate role-specific questions from the focus.",
    "Do not ask protected or sensitive questions, reveal scores, promise a hiring outcome, or invent company facts.",
  ].join("\\n\\n");

  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-4">
      <div className="mb-2 flex items-center justify-between">
        <Label>Generated voice prompt preview</Label>
        <span className="text-xs text-gray-500">updates as you edit</span>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-white p-3 text-xs leading-5 text-gray-700">
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
    <Card className="p-5">
      <h2 className="mb-4 text-sm font-semibold text-gray-900">
        {role ? "Edit role" : "New role"}
      </h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="role-title">Title</Label>
          <Input
            id="role-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Senior Frontend Engineer"
          />
        </div>

        <div>
          <Label htmlFor="role-jd">Job description</Label>
          <Textarea
            id="role-jd"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            rows={4}
            placeholder="Paste the JD or a short summary…"
          />
        </div>

        <div>
          <Label htmlFor="role-skills">Required skills</Label>
          <Input
            id="role-skills"
            value={skillsText}
            onChange={(e) => setSkillsText(e.target.value)}
            placeholder="React, TypeScript, CSS (comma-separated)"
          />
          <p className="mt-1 text-xs text-gray-400">
            Separate skills with commas.
          </p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>Screening questions</Label>
            <Button type="button" variant="ghost" onClick={addQuestion}>
              + Add question
            </Button>
          </div>
          <div className="space-y-2">
            {questions.map((q, idx) => (
              <div key={idx} className="flex items-start gap-2">
                <span className="mt-2.5 w-7 shrink-0 text-xs font-medium text-gray-400">
                  {q.id || `q${idx + 1}`}
                </span>
                <div className="flex-1">
                  <Input
                    value={q.question}
                    onChange={(e) =>
                      updateQuestion(idx, { question: e.target.value })
                    }
                    placeholder="Question text…"
                    aria-invalid={Boolean(spokenQuestionIssue(q.question, questions, idx))}
                  />
                  {spokenQuestionIssue(q.question, questions, idx) && (
                    <p className="mt-1 text-xs text-amber-700" role="status">
                      {spokenQuestionIssue(q.question, questions, idx)}
                    </p>
                  )}
                </div>
                <div className="w-20 shrink-0">
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={q.weight}
                    onChange={(e) =>
                      updateQuestion(idx, { weight: Number(e.target.value) })
                    }
                    aria-label="Weight"
                    title="Weight"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => removeQuestion(idx)}
                  className="mt-0.5 px-2 text-gray-400 hover:text-red-600"
                  aria-label="Remove question"
                  disabled={questions.length === 1}
                >
                  ✕
                </Button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <Label htmlFor="role-instructions">Interviewer instructions</Label>
          <Textarea
            id="role-instructions"
            value={interviewerInstructions}
            onChange={(e) => setInterviewerInstructions(e.target.value)}
            rows={5}
            placeholder="Optional guidance: what good evidence looks like, which probes to prioritize, and what the interviewer should avoid…"
          />
          <p className="mt-1 text-xs text-gray-400">
            This is included in the generated voice prompt and remains editable.
          </p>
        </div>

        <PromptPreview
          title={title}
          jd={jd}
          skills={skillsText}
          instructions={interviewerInstructions}
          questions={questions}
        />

        {formError && (
          <p className="text-sm text-red-600" role="alert">
            {formError}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <Button type="submit" loading={saving}>
            {role ? "Save changes" : "Create role"}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
