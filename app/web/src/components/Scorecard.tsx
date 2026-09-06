import type { Assessment, Recommendation } from "../types";
import { GlassPanel, StatusBadge } from "./design";
import type { StatusTone } from "./design";

/** Legacy chip tones → design badge tones. */
const BADGE_TONE: Record<string, StatusTone> = {
  green: "success",
  amber: "warning",
  red: "danger",
  accent: "info",
  neutral: "neutral",
};

const recoConfig: Record<
  Recommendation,
  { label: string; className: string }
> = {
  advance: {
    label: "Advance",
    className: "bg-success-soft text-success-text",
  },
  hold: {
    label: "Hold",
    className: "bg-warning-soft text-warning-text",
  },
  reject: {
    label: "Reject",
    className: "bg-error-soft text-error-text",
  },
};

function scoreColor(score: number): string {
  if (score >= 75) return "text-success-text";
  if (score >= 50) return "text-warning-text";
  return "text-error-text";
}

function barColor(value: number): string {
  if (value >= 7) return "bg-success";
  if (value >= 5) return "bg-warning";
  return "bg-error";
}

function MetricBar({ label, value }: { label: string; value: number }) {
  const safe = Math.max(0, Math.min(10, Number(value) || 0));
  const pct = safe * 10;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-ink-secondary">{label}</span>
        <span className="font-medium text-ink">{safe}/10</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.06]">
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
    <div className="glass-sunken p-4">
      <h3 className="mb-3 text-sm font-semibold text-ink">{title}</h3>
      <div className="space-y-3">{children}</div>
      {notes && <p className="mt-3 text-xs leading-relaxed text-ink-tertiary">{notes}</p>}
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
      <p className="mb-1.5 text-xs font-medium text-ink-secondary">{label}</p>
      {items.length === 0 ? (
        <p className="text-xs text-ink-tertiary">None</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <StatusBadge dot={false} key={item} tone={BADGE_TONE[tone]}>
              {item}
            </StatusBadge>
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
    <div className="rounded-[12px] bg-white/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-ink-secondary">{label}</span>
        <StatusBadge dot={false} tone={BADGE_TONE[tone]}>{signal.level}</StatusBadge>
      </div>
      <MetricBar label="Impact" value={signal.impact_score} />
      {signal.examples.length > 0 && (
        <p className="mt-2 text-xs text-ink-tertiary">
          <span className="font-medium">Examples:</span>{" "}
          {signal.examples.join(", ")}
        </p>
      )}
      {signal.notes && (
        <p className="mt-1 text-xs leading-relaxed text-ink-tertiary">
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
    <GlassPanel level="sunken" padding="none" className="overflow-hidden rounded-[16px]">
      <div className="flex items-center justify-between gap-4 border-b border-glass-ring p-5">
        <div className="flex items-baseline gap-2">
          <span className={`text-4xl font-bold ${scoreColor(overall_score)}`}>
            {Math.round(overall_score)}
          </span>
          <span className="text-sm text-ink-tertiary">/ 100</span>
          <span className="ml-2 text-sm text-ink-tertiary">Overall score</span>
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
            <div className="rounded-[12px] bg-white/70 p-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-medium text-ink-secondary">English band</span>
                <StatusBadge dot={false} tone="info">{english.band}</StatusBadge>
              </div>
              <MetricBar label="Grammar" value={english.grammar} />
              <MetricBar label="Vocabulary" value={english.vocabulary} />
              <MetricBar label="Fluency" value={english.fluency} />
              <MetricBar label="Coherence" value={english.coherence} />
              {english.notes && (
                <p className="mt-2 text-xs leading-relaxed text-ink-tertiary">
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
            <span className="text-ink-secondary">Sentiment</span>
            <StatusBadge dot={false}>{tone.sentiment}</StatusBadge>
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
        <div className="border-t border-glass-ring p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            Resume conflicts
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning-text">
              {conflicts.length}
            </span>
          </h3>
          <div className="space-y-3">
            {conflicts.map((c, i) => (
              <div
                key={i}
                className={`rounded-lg border p-3 ${
                  c.resolved
                    ? "border-glass-ring bg-white/60"
                    : "border-warning bg-warning-soft"
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink">{c.topic}</span>
                  <StatusBadge tone={c.resolved ? "success" : "warning"}>
                    {c.resolved ? "resolved" : "unresolved"}
                  </StatusBadge>
                </div>
                <p className="text-xs text-ink-secondary">
                  <span className="font-medium">Resume:</span> {c.resume_says}
                </p>
                <p className="text-xs text-ink-secondary">
                  <span className="font-medium">Said on call:</span> {c.candidate_said}
                </p>
                {c.note && <p className="mt-1 text-xs italic text-ink-tertiary">{c.note}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {summary && (
        <div className="border-t border-glass-ring p-5">
          <h3 className="mb-1.5 text-sm font-semibold text-ink">Summary</h3>
          <p className="text-sm leading-relaxed text-ink-secondary">{summary}</p>
        </div>
      )}
    </GlassPanel>
  );
}
