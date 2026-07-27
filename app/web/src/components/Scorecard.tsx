import type { Assessment, Recommendation } from "../types";
import { Card, Chip } from "./ui";

const recoConfig: Record<
  Recommendation,
  { label: string; className: string }
> = {
  advance: {
    label: "Advance",
    className: "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300",
  },
  hold: {
    label: "Hold",
    className: "bg-amber-100 text-amber-800 ring-1 ring-amber-300",
  },
  reject: {
    label: "Reject",
    className: "bg-red-100 text-red-800 ring-1 ring-red-300",
  },
};

function scoreColor(score: number): string {
  if (score >= 75) return "text-emerald-600";
  if (score >= 50) return "text-amber-600";
  return "text-red-600";
}

function barColor(value: number): string {
  if (value >= 7) return "bg-emerald-500";
  if (value >= 5) return "bg-amber-500";
  return "bg-red-500";
}

function MetricBar({ label, value }: { label: string; value: number }) {
  const safe = Math.max(0, Math.min(10, Number(value) || 0));
  const pct = safe * 10;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-gray-600">{label}</span>
        <span className="font-medium text-gray-800">{safe}/10</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full ${barColor(safe)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  notes,
}: {
  title: string;
  children: React.ReactNode;
  notes?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{title}</h3>
      <div className="space-y-3">{children}</div>
      {notes && <p className="mt-3 text-xs leading-relaxed text-gray-500">{notes}</p>}
    </div>
  );
}

function ChipGroup({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone: "green" | "amber" | "red";
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-gray-600">{label}</p>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400">None</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <Chip key={item} tone={tone}>
              {item}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalBlock({
  label,
  signal,
}: {
  label: string;
  signal?: {
    level: string;
    examples: string[];
    impact_score: number;
    notes: string;
  };
}) {
  if (!signal) return null;
  const tone =
    signal.level === "none" || signal.level === "low"
      ? "green"
      : signal.level === "moderate"
        ? "amber"
        : "red";

  return (
    <div className="rounded-md bg-gray-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-gray-700">{label}</span>
        <Chip tone={tone}>{signal.level}</Chip>
      </div>
      <MetricBar label="Impact" value={signal.impact_score} />
      {signal.examples.length > 0 && (
        <p className="mt-2 text-xs text-gray-500">
          <span className="font-medium">Examples:</span>{" "}
          {signal.examples.join(", ")}
        </p>
      )}
      {signal.notes && (
        <p className="mt-1 text-xs leading-relaxed text-gray-500">
          {signal.notes}
        </p>
      )}
    </div>
  );
}

export function Scorecard({ assessment }: { assessment: Assessment }) {
  const raw = assessment.raw ?? {};
  const { tone, role_fit, overall_score, recommendation, summary } = assessment;
  const communication = assessment.communication ?? raw.communication;
  const english = communication?.english_proficiency ?? assessment.english;
  const motivation = assessment.motivation ?? raw.motivation;
  const conflicts = assessment.resume_conflicts ?? raw.resume_conflicts ?? [];
  const reco = recoConfig[recommendation] ?? recoConfig.hold;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-4 border-b border-gray-200 bg-gray-50/60 p-5">
        <div className="flex items-baseline gap-2">
          <span className={`text-4xl font-bold ${scoreColor(overall_score)}`}>
            {Math.round(overall_score)}
          </span>
          <span className="text-sm text-gray-400">/ 100</span>
          <span className="ml-2 text-sm text-gray-500">Overall score</span>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold ${reco.className}`}
        >
          {reco.label}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-3">
        <Section
          title="Communication - 50%"
          notes={
            communication?.notes ??
            "No candidate responses are available to assess communication."
          }
        >
          <MetricBar label="Score" value={communication?.score ?? 0} />
          {communication?.clarity != null && (
            <MetricBar label="Clarity" value={communication.clarity} />
          )}
          {communication?.structure != null && (
            <MetricBar label="Structure" value={communication.structure} />
          )}
          {communication?.listening != null && (
            <MetricBar label="Listening" value={communication.listening} />
          )}
          {communication?.rapport != null && (
            <MetricBar label="Rapport" value={communication.rapport} />
          )}
          {english && (
            <div className="rounded-md bg-gray-50 p-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-gray-700">English band</span>
                <Chip tone="accent">{english.band}</Chip>
              </div>
              <MetricBar label="Grammar" value={english.grammar} />
              <MetricBar label="Vocabulary" value={english.vocabulary} />
              <MetricBar label="Fluency" value={english.fluency} />
              <MetricBar label="Coherence" value={english.coherence} />
              {english.notes && (
                <p className="mt-2 text-xs leading-relaxed text-gray-500">
                  {english.notes}
                </p>
              )}
            </div>
          )}
          <SignalBlock
            label="Filler usage"
            signal={communication?.filler_usage}
          />
          <SignalBlock
            label="Native-language usage"
            signal={communication?.native_language_usage}
          />
        </Section>

        <Section
          title="Motivation - 20%"
          notes={
            motivation?.notes ??
            "No candidate responses are available to assess motivation."
          }
        >
          <MetricBar label="Score" value={motivation?.score ?? 0} />
        </Section>

        <Section title="Tone - 10%" notes={tone.notes}>
          <MetricBar label="Clarity" value={tone.clarity} />
          <MetricBar label="Confidence" value={tone.confidence} />
          <MetricBar label="Professionalism" value={tone.professionalism} />
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600">Sentiment</span>
            <Chip>{tone.sentiment}</Chip>
          </div>
        </Section>

        <Section title="Role fit - 20%" notes={role_fit.notes}>
          <MetricBar label="Fit score" value={role_fit.score} />
          <ChipGroup
            label="Matched skills"
            items={role_fit.matched_skills}
            tone="green"
          />
          <ChipGroup label="Gaps" items={role_fit.gaps} tone="amber" />
          <ChipGroup
            label="Red flags"
            items={role_fit.red_flags}
            tone="red"
          />
        </Section>
      </div>

      {conflicts.length > 0 && (
        <div className="border-t border-gray-200 p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
            Resume conflicts
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-300">
              {conflicts.length}
            </span>
          </h3>
          <div className="space-y-3">
            {conflicts.map((c, i) => (
              <div
                key={i}
                className={`rounded-lg border p-3 ${
                  c.resolved
                    ? "border-gray-200 bg-gray-50"
                    : "border-amber-300 bg-amber-50"
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-900">{c.topic}</span>
                  <Chip tone={c.resolved ? "green" : "amber"}>
                    {c.resolved ? "resolved" : "unresolved"}
                  </Chip>
                </div>
                <p className="text-xs text-gray-600">
                  <span className="font-medium">Resume:</span> {c.resume_says}
                </p>
                <p className="text-xs text-gray-600">
                  <span className="font-medium">Said on call:</span> {c.candidate_said}
                </p>
                {c.note && <p className="mt-1 text-xs italic text-gray-500">{c.note}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {summary && (
        <div className="border-t border-gray-200 p-5">
          <h3 className="mb-1.5 text-sm font-semibold text-gray-900">Summary</h3>
          <p className="text-sm leading-relaxed text-gray-600">{summary}</p>
        </div>
      )}
    </Card>
  );
}
