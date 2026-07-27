import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Candidate, Role } from "../types";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Label,
  LoadingState,
  PageHeader,
  Select,
  Spinner,
} from "../components/ui";

export function CandidatesPage() {
  const navigate = useNavigate();
  const [roles, setRoles] = useState<Role[]>([]);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterRole, setFilterRole] = useState<string>("");

  const loadCandidates = useCallback((roleId: string) => {
    setError(null);
    setCandidates(null);
    api
      .listCandidates(roleId || undefined)
      .then(setCandidates)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(() => {
    api.listRoles().then(setRoles).catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    loadCandidates(filterRole);
  }, [filterRole, loadCandidates]);

  return (
    <div>
      <PageHeader
        title="Candidates"
        description="Upload resumes, review parsed profiles, and launch screenings."
      />

      <UploadCard
        roles={roles}
        onUploaded={() => loadCandidates(filterRole)}
      />

      <div className="mb-4 mt-8 flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold text-gray-900">All candidates</h2>
        {roles.length > 0 && (
          <div className="w-56">
            <Select
              value={filterRole}
              onChange={(e) => setFilterRole(e.target.value)}
              aria-label="Filter by role"
            >
              <option value="">All roles</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {error && (
        <ErrorState message={error} onRetry={() => loadCandidates(filterRole)} />
      )}
      {!error && candidates === null && (
        <LoadingState label="Loading candidates…" />
      )}
      {!error && candidates !== null && candidates.length === 0 && (
        <EmptyState
          title="No candidates yet"
          hint="Upload a resume above to parse a candidate and add them here."
        />
      )}

      {candidates && candidates.length > 0 && (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/60 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Skills</th>
                <th className="px-4 py-3 font-medium">Exp.</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/candidates/${c.id}`)}
                  className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-accent-50/40"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">
                      {c.name || "Unnamed"}
                    </p>
                    {c.email && (
                      <p className="text-xs text-gray-400">{c.email}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.phone_e164 ? (
                      <span className="flex items-center gap-1.5">
                        <span className="text-gray-700">{c.phone_e164}</span>
                        {!c.phone_valid && <Chip tone="red">invalid</Chip>}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex max-w-xs flex-wrap gap-1">
                      {c.skills.slice(0, 4).map((s) => (
                        <Chip key={s}>{s}</Chip>
                      ))}
                      {c.skills.length > 4 && (
                        <Chip>+{c.skills.length - 4}</Chip>
                      )}
                      {c.skills.length === 0 && (
                        <span className="text-gray-400">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {c.experience_years != null
                      ? `${c.experience_years} yr`
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <Chip>{c.status || "new"}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function UploadCard({
  roles,
  onUploaded,
}: {
  roles: Role[];
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [roleId, setRoleId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleUpload() {
    if (!file) return;
    setError(null);
    setSuccess(null);
    setUploading(true);
    try {
      const result = await api.uploadResume(file, roleId || undefined);
      setSuccess(`Parsed ${result.candidate.name || "candidate"}.`);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 text-sm font-semibold text-gray-900">
        Upload a resume
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        PDF or DOCX. Parsing runs an LLM and can take 10–20 seconds.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Label htmlFor="resume-file">Resume file</Label>
          <input
            id="resume-file"
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setSuccess(null);
              setError(null);
            }}
            disabled={uploading}
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-accent-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-accent-700 hover:file:bg-accent-100 disabled:opacity-60"
          />
        </div>
        <div>
          <Label htmlFor="resume-role">Role (optional)</Label>
          <Select
            id="resume-role"
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            disabled={uploading}
          >
            <option value="">No role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={handleUpload} disabled={!file} loading={uploading}>
          {uploading ? "Parsing…" : "Upload & Parse"}
        </Button>
        {uploading && (
          <span className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner className="h-4 w-4 text-accent-500" />
            Extracting and parsing with the LLM…
          </span>
        )}
        {success && !uploading && (
          <span className="text-sm text-emerald-600">{success}</span>
        )}
        {error && !uploading && (
          <span className="text-sm text-red-600">{error}</span>
        )}
      </div>
    </Card>
  );
}
