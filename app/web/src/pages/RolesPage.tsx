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
                  />
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
