/**
 * Resume: the facts parsed from the candidate's resume. The original file has no staff route yet, so
 * only the facts are here. The evidence list is the candidate page's own.
 */
import { Tag } from '../design/candidate';
import { EmptyPanel } from '../design';
import { ResumeEvidence } from '../talent/CandidateOverviewSections';
import type { R1ReviewResponse } from '../../lib/r1-types';

export function ResumePanel({ candidate }: { candidate: R1ReviewResponse['candidate'] }) {
  const { resume, skills, experience_years: years } = candidate;
  if (!resume && skills.length === 0 && years === null) return <EmptyPanel title="No resume on file" />;
  return (
    <div className="max-w-xl space-y-4 text-sm">
      {resume?.summary && <p className="leading-relaxed text-ink">{resume.summary}</p>}
      {!resume && <p className="text-ink-secondary">No resume on file</p>}
      <dl className="grid gap-y-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        {years !== null && (
          <>
            <dt className="form-label pt-0.5">Experience</dt>
            <dd className="text-ink">{years} years</dd>
          </>
        )}
        {skills.length > 0 && (
          <>
            <dt className="form-label pt-1">Skills</dt>
            <dd className="flex flex-wrap gap-1.5">
              {skills.map((skill) => (
                <Tag key={skill} tone="accent" srPrefix="Skill:">
                  {skill}
                </Tag>
              ))}
            </dd>
          </>
        )}
      </dl>
      <ResumeEvidence facts={resume} />
    </div>
  );
}
