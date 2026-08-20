/**
 * Ashby feedback-form SCHEMA discovery — read-only, structure-only.
 *
 * The extractor is the only thing standing between an opaque provider payload
 * and an HR-facing screen, so the assertions here are about what CANNOT get
 * through as much as what can:
 *
 *   * exactly one allowlisted READ (`jobInterviewPlan.info`), never
 *     `applicationFeedback.list` and no mutating operation;
 *   * hostile payloads — PII-like siblings, submitted answers, comments,
 *     unbounded strings, control characters, cycles, huge lists — are omitted
 *     or bounded, not merely truncated in the UI;
 *   * a form the plan only NAMES reports `schemaAvailable: false` instead of
 *     an empty field list that would read as "this form has no fields".
 *
 * Zero network: every reader is an injected recorder, every payload synthetic
 * or shaped from the published Ashby response schema.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractFeedbackForms,
  probeJobFeedbackForms,
  extractStages,
  PROBE_READ_OPERATIONS,
  type ProbeFeedbackForm,
} from '../integrations/ashby/probe.js';
import { ASHBY_OPERATIONS } from '../integrations/ashby/types.js';

/** Officially-shaped plan: results.stages[].activities[].interviews[]. */
const OFFICIAL_PLAN = {
  jobId: 'job_abc',
  interviewPlanId: 'plan_1',
  stages: [
    {
      id: 'stage_ai',
      title: 'AI Screening',
      type: 'Interview',
      orderInInterviewPlan: 1,
      activities: [
        {
          id: 'act_1',
          interviews: [
            {
              id: 'iv_row_1',
              interviewId: 'iv_1',
              title: 'Hello Christy Screen',
              interviewDurationMinutes: 30,
              isSchedulable: true,
              feedbackFormDefinition: {
                id: 'form_1',
                title: 'Hello Christy Feedback',
                isArchived: false,
                isDefaultForm: false,
                formDefinition: {
                  sections: [
                    {
                      title: 'Overall',
                      descriptionHtml: '<p>Internal note that must never surface</p>',
                      fields: [
                        {
                          isRequired: true,
                          field: {
                            id: 'field_overall',
                            type: 'ValueSelect',
                            path: 'overall_recommendation',
                            humanReadablePath: 'Overall Recommendation',
                            title: 'Overall Recommendation',
                            isNullable: false,
                            selectableValues: [
                              { label: '4 - Strong Yes', value: '4' },
                              { label: '3 - Yes', value: '3' },
                            ],
                          },
                        },
                        {
                          isRequired: false,
                          field: {
                            id: 'field_summary',
                            type: 'String',
                            path: 'summary',
                            title: 'Summary',
                            isNullable: true,
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    },
  ],
};

function onlyForm(results: unknown): ProbeFeedbackForm {
  const out = extractFeedbackForms(results);
  expect(out.forms).toHaveLength(1);
  return out.forms[0];
}

describe('extractFeedbackForms — official plan shape', () => {
  it('reads form, section, field ids plus labels, types, required flags and the scale', () => {
    const form = onlyForm(OFFICIAL_PLAN);
    expect(form.formDefinitionId).toBe('form_1');
    expect(form.title).toBe('Hello Christy Feedback');
    expect(form.schemaAvailable).toBe(true);
    expect(form.stageId).toBe('stage_ai');
    expect(form.stageTitle).toBe('AI Screening');
    expect(form.interviewId).toBe('iv_1');
    expect(form.interviewTitle).toBe('Hello Christy Screen');
    expect(form.fieldCount).toBe(2);

    expect(form.sections).toHaveLength(1);
    const [section] = form.sections;
    expect(section.title).toBe('Overall');
    expect(section.fields.map((f) => f.id)).toEqual(['field_overall', 'field_summary']);

    const [overall, summary] = section.fields;
    expect(overall).toEqual({
      id: 'field_overall',
      title: 'Overall Recommendation',
      path: 'overall_recommendation',
      type: 'ValueSelect',
      required: true,
      options: [
        { value: '4', label: '4 - Strong Yes' },
        { value: '3', label: '3 - Yes' },
      ],
      optionsTruncated: false,
    });
    expect(summary.required).toBe(false);
    expect(summary.options).toEqual([]);
  });

  it('never carries the section description HTML across the boundary', () => {
    const out = extractFeedbackForms(OFFICIAL_PLAN);
    expect(JSON.stringify(out)).not.toContain('must never surface');
    expect(JSON.stringify(out)).not.toContain('descriptionHtml');
  });

  it('does not copy any provider key it was not asked for', () => {
    const form = onlyForm(OFFICIAL_PLAN);
    expect(Object.keys(form).sort()).toEqual([
      'fieldCount', 'formDefinitionId', 'interviewId', 'interviewTitle',
      'schemaAvailable', 'sections', 'stageId', 'stageTitle', 'title',
    ]);
    expect(Object.keys(form.sections[0]).sort()).toEqual(['fields', 'id', 'title']);
    expect(Object.keys(form.sections[0].fields[0]).sort()).toEqual([
      'id', 'options', 'optionsTruncated', 'path', 'required', 'title', 'type',
    ]);
    // `humanReadablePath` and `isNullable` are real provider keys we chose not
    // to expose; their absence is the assertion.
    expect(JSON.stringify(form)).not.toContain('humanReadablePath');
    expect(JSON.stringify(form)).not.toContain('isNullable');
  });

  it('leaves the input payload untouched (pure)', () => {
    const before = JSON.stringify(OFFICIAL_PLAN);
    extractFeedbackForms(OFFICIAL_PLAN);
    expect(JSON.stringify(OFFICIAL_PLAN)).toBe(before);
  });
});

describe('extractFeedbackForms — payload variants', () => {
  it('reads a bare form reference and reports the schema as unavailable', () => {
    const form = onlyForm({
      stages: [
        {
          id: 'stage_1',
          title: 'Screen',
          activities: [{ interviews: [{ interviewId: 'iv_9', title: 'Screen', feedbackFormDefinitionId: 'form_ref' }] }],
        },
      ],
    });
    expect(form.formDefinitionId).toBe('form_ref');
    // An empty `sections` here must NOT read as "this form has no fields".
    expect(form.schemaAvailable).toBe(false);
    expect(form.sections).toEqual([]);
    expect(form.fieldCount).toBe(0);
  });

  it('reads the interviewStages/interviews variant without an activities level', () => {
    const form = onlyForm({
      interviewStages: [
        { id: 'stage_x', name: 'Stage X', interviews: [{ id: 'iv_x', name: 'IV X', feedbackFormDefinitionId: 'form_x' }] },
      ],
    });
    expect(form.formDefinitionId).toBe('form_x');
    expect(form.stageTitle).toBe('Stage X');
    expect(form.interviewTitle).toBe('IV X');
  });

  it('reads a plan nested under results.jobInterviewPlan', () => {
    const form = onlyForm({ jobInterviewPlan: { stages: [{ id: 's1', interviews: [{ feedbackFormDefinitionId: 'form_n' }] }] } });
    expect(form.formDefinitionId).toBe('form_n');
    expect(form.interviewId).toBeNull();
  });

  it('reads a bare stage array', () => {
    const form = onlyForm([{ id: 's1', title: 'S', interviews: [{ feedbackFormDefinitionId: 'form_arr' }] }]);
    expect(form.formDefinitionId).toBe('form_arr');
  });

  it('accepts a flat field shape (no { isRequired, field } wrapper)', () => {
    const form = onlyForm({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_flat',
        sections: [{ fields: [{ id: 'f1', title: 'Flat', type: 'String', isRequired: true }] }],
      } }] }],
    });
    expect(form.schemaAvailable).toBe(true);
    expect(form.sections[0].fields[0]).toMatchObject({ id: 'f1', title: 'Flat', type: 'String', required: true });
  });

  it('accepts a scale delivered as bare scalars', () => {
    const form = onlyForm({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_scalar',
        sections: [{ fields: [{ id: 'f1', type: 'ValueSelect', selectableValues: [1, 2, '3'] }] }],
      } }] }],
    });
    expect(form.sections[0].fields[0].options).toEqual([
      { value: '1', label: null },
      { value: '2', label: null },
      { value: '3', label: null },
    ]);
  });

  it('reports an interview plan with no feedback form as empty, not as a failure', () => {
    const out = extractFeedbackForms({ stages: [{ id: 's1', title: 'S', activities: [{ interviews: [{ interviewId: 'iv' }] }] }] });
    expect(out.forms).toEqual([]);
    expect(out.empty).toBe(true);
    expect(out.truncated).toBe(false);
  });

  it('returns nothing for shapes it does not recognise, instead of guessing', () => {
    for (const payload of [null, undefined, 'a string', 42, {}, [], { results: {} }, { stages: 'not-a-list' }]) {
      expect(extractFeedbackForms(payload).forms, JSON.stringify(payload)).toEqual([]);
    }
  });
});

describe('extractFeedbackForms — determinism and dedup', () => {
  it('is deterministic in traversal order across repeated runs', () => {
    const payload = {
      stages: [
        { id: 's1', title: 'One', interviews: [{ feedbackFormDefinitionId: 'form_a' }] },
        { id: 's2', title: 'Two', interviews: [{ feedbackFormDefinitionId: 'form_b' }] },
      ],
    };
    const first = extractFeedbackForms(payload).forms.map((f) => f.formDefinitionId);
    expect(first).toEqual(['form_a', 'form_b']);
    for (let i = 0; i < 5; i += 1) {
      expect(extractFeedbackForms(payload).forms.map((f) => f.formDefinitionId)).toEqual(first);
    }
  });

  it('dedups one form reused across interviews and keeps the FIRST anchor', () => {
    const out = extractFeedbackForms({
      stages: [
        { id: 's1', title: 'First', interviews: [{ interviewId: 'iv1', feedbackFormDefinitionId: 'form_shared' }] },
        { id: 's2', title: 'Second', interviews: [{ interviewId: 'iv2', feedbackFormDefinitionId: 'form_shared' }] },
      ],
    });
    expect(out.forms).toHaveLength(1);
    expect(out.forms[0].stageTitle).toBe('First');
    expect(out.forms[0].interviewId).toBe('iv1');
  });

  it('upgrades a bare reference to a schema when a later sighting carries one', () => {
    const form = onlyForm({
      stages: [
        { id: 's1', interviews: [{ feedbackFormDefinitionId: 'form_up' }] },
        { id: 's2', interviews: [{ feedbackFormDefinition: {
          id: 'form_up', title: 'Late', sections: [{ fields: [{ id: 'f1' }] }],
        } }] },
      ],
    });
    expect(form.schemaAvailable).toBe(true);
    expect(form.title).toBe('Late');
    expect(form.fieldCount).toBe(1);
  });

  it('never downgrades a schema back to a bare reference', () => {
    const form = onlyForm({
      stages: [
        { id: 's1', interviews: [{ feedbackFormDefinition: { id: 'form_d', sections: [{ fields: [{ id: 'f1' }] }] } }] },
        { id: 's2', interviews: [{ feedbackFormDefinitionId: 'form_d' }] },
      ],
    });
    expect(form.schemaAvailable).toBe(true);
    expect(form.fieldCount).toBe(1);
  });

  it('dedups a field id repeated across sections', () => {
    const form = onlyForm({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_dupe',
        sections: [{ fields: [{ id: 'f1' }] }, { fields: [{ id: 'f1' }, { id: 'f2' }] }],
      } }] }],
    });
    expect(form.fieldCount).toBe(2);
    expect(form.sections[1].fields.map((f) => f.id)).toEqual(['f2']);
  });
});

describe('extractFeedbackForms — hostile payloads are omitted, not filtered downstream', () => {
  it('omits PII-like and answer-like siblings everywhere they can appear', () => {
    const out = extractFeedbackForms({
      candidateEmail: 'root@example.invalid',
      stages: [{
        id: 'stage_h',
        title: 'Stage',
        candidateName: 'Real Person',
        activities: [{
          interviews: [{
            interviewId: 'iv_h',
            title: 'IV',
            interviewerEmail: 'panel@example.invalid',
            feedbackFormDefinition: {
              id: 'form_h',
              title: 'Form',
              submittedBy: 'someone@example.invalid',
              formDefinition: {
                sections: [{
                  title: 'S',
                  fields: [{
                    isRequired: true,
                    answer: 'Candidate said something private',
                    comment: 'Interviewer note',
                    field: {
                      id: 'f_h',
                      title: 'T',
                      type: 'ValueSelect',
                      value: 'SUBMITTED-ANSWER',
                      submittedValue: 'ALSO-AN-ANSWER',
                      phone: '+10000000000',
                      resumeUrl: 'https://example.invalid/resume.pdf',
                      selectableValues: [{ label: 'Yes', value: '1' }],
                    },
                  }],
                }],
              },
            },
          }],
        }],
      }],
    });
    const json = JSON.stringify(out);
    for (const forbidden of [
      'root@example.invalid', 'Real Person', 'panel@example.invalid',
      'someone@example.invalid', 'Candidate said something private',
      'Interviewer note', 'SUBMITTED-ANSWER', 'ALSO-AN-ANSWER',
      '+10000000000', 'resume.pdf',
    ]) {
      expect(json, `must not leak ${forbidden}`).not.toContain(forbidden);
    }
    // The legitimate structure still came through.
    expect(out.forms[0].sections[0].fields[0].options).toEqual([{ value: '1', label: 'Yes' }]);
  });

  it('bounds an unbounded title, path, type and option text', () => {
    const form = onlyForm({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_b',
        title: 'T'.repeat(5000),
        sections: [{ title: 'S'.repeat(5000), fields: [{
          id: 'f1',
          title: 'F'.repeat(5000),
          path: 'p'.repeat(5000),
          type: 'x'.repeat(5000),
          selectableValues: [{ label: 'L'.repeat(5000), value: 'V'.repeat(5000) }],
        }] }],
      } }] }],
    });
    expect(form.title).toHaveLength(120);
    expect(form.sections[0].title).toHaveLength(120);
    const field = form.sections[0].fields[0];
    expect(field.title).toHaveLength(120);
    expect(field.path).toHaveLength(160);
    // An over-long "type" is not an identifier, so it fails closed to null
    // rather than becoming a 64-char stub that looks like a real type.
    expect(field.type).toBeNull();
    expect(field.options[0].label).toHaveLength(120);
    expect(field.options[0].value).toHaveLength(120);
  });

  it('strips control characters from every string it keeps', () => {
    // Built from codepoints so the fixture cannot be silently normalised by an
    // editor: NUL, BEL, newline, and DEL.
    const NUL = String.fromCharCode(0);
    const BEL = String.fromCharCode(7);
    const LF = String.fromCharCode(10);
    const DEL = String.fromCharCode(127);
    const form = onlyForm({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_c',
        title: `A${NUL}B${BEL}C${LF}D`,
        sections: [{ fields: [{
          id: 'f1',
          title: `X${DEL}Y`,
          selectableValues: [{ label: `L${NUL}L`, value: '1' }],
        }] }],
      } }] }],
    });
    const json = JSON.stringify(form);
    for (const ch of [NUL, BEL, LF, DEL]) {
      expect(json.includes(ch), `control char ${ch.charCodeAt(0)} survived`).toBe(false);
    }
    expect(form.title).toBe('A B C D');
    expect(form.sections[0].fields[0].title).toBe('X Y');
    expect(form.sections[0].fields[0].options[0].label).toBe('L L');
  });

  it('rejects a field/form/section id that is not an opaque identifier', () => {
    const out = extractFeedbackForms({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_ids',
        sections: [{ id: 'has space', fields: [
          { id: 'ok_1' },
          { id: 'has space' },
          { id: 'x'.repeat(300) },
          { id: 42 },
          { id: null },
          { field: { id: '<script>' } },
        ] }],
      } }] }],
    });
    expect(out.forms[0].sections[0].id).toBeNull();
    expect(out.forms[0].sections[0].fields.map((f) => f.id)).toEqual(['ok_1']);
  });

  it('reports required as null rather than inferring it from isNullable', () => {
    const form = onlyForm({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_r',
        sections: [{ fields: [
          { field: { id: 'f1', isNullable: false } },
          { isRequired: 'yes', field: { id: 'f2' } },
        ] }],
      } }] }],
    });
    expect(form.sections[0].fields.map((f) => f.required)).toEqual([null, null]);
  });

  it('terminates on a self-referential payload and flags nothing false', () => {
    const cyclic: Record<string, unknown> = { stages: [] };
    const stage: Record<string, unknown> = { id: 'cycle_stage', title: 'Cycle' };
    stage.interviews = [{ feedbackFormDefinitionId: 'form_cycle', self: stage }];
    (cyclic.stages as unknown[]).push(stage);
    cyclic.jobInterviewPlan = cyclic;
    cyclic.interviewPlan = cyclic;

    const out = extractFeedbackForms(cyclic);
    expect(out.forms.map((f) => f.formDefinitionId)).toEqual(['form_cycle']);
  });

  it('bounds a huge stage list and says so via truncated', () => {
    const stages = Array.from({ length: 400 }, (_, i) => ({
      id: `stage_${i}`,
      interviews: [{ feedbackFormDefinitionId: `form_${i}` }],
    }));
    const out = extractFeedbackForms({ stages });
    expect(out.truncated).toBe(true);
    // The form bound (50) clips before the list bound (200) is exhausted.
    expect(out.forms).toHaveLength(50);
  });

  it('bounds sections, fields and options per form and says so', () => {
    const form = onlyForm({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_big',
        sections: Array.from({ length: 80 }, (_, si) => ({
          title: `S${si}`,
          fields: Array.from({ length: 20 }, (_, fi) => ({
            id: `f_${si}_${fi}`,
            selectableValues: Array.from({ length: 100 }, (_, oi) => ({ label: `o${oi}`, value: `${oi}` })),
          })),
        })),
      } }] }],
    });
    expect(extractFeedbackForms({ stages: [] }).truncated).toBe(false);
    expect(form.sections.length).toBeLessThanOrEqual(50);
    expect(form.fieldCount).toBeLessThanOrEqual(200);
    for (const section of form.sections) {
      for (const field of section.fields) {
        expect(field.options.length).toBeLessThanOrEqual(40);
        expect(field.optionsTruncated).toBe(true);
      }
    }
  });

  it('flags truncation on the result when any bound bites', () => {
    const out = extractFeedbackForms({
      stages: [{ id: 's', interviews: [{ feedbackFormDefinition: {
        id: 'form_t',
        sections: [{ fields: [{ id: 'f1', selectableValues: Array.from({ length: 60 }, (_, i) => ({ value: `${i}` })) }] }],
      } }] }],
    });
    expect(out.truncated).toBe(true);
  });
});

describe('probeJobFeedbackForms — exactly one allowlisted read, nothing written', () => {
  it('performs one jobInterviewPlan.info read and nothing else', async () => {
    const jobInterviewPlanInfo = vi.fn(async () => ({ results: OFFICIAL_PLAN }));
    const reader = { jobInterviewPlanInfo };
    const out = await probeJobFeedbackForms('job_abc', reader as never);

    expect(jobInterviewPlanInfo).toHaveBeenCalledTimes(1);
    expect(jobInterviewPlanInfo).toHaveBeenCalledWith('job_abc');
    expect(out.forms[0].formDefinitionId).toBe('form_1');
  });

  it('exposes no mutating or feedback-content seam on the reader it is given', async () => {
    // Anything the probe might call would have to exist on the injected reader.
    // A Proxy that throws on ANY other property proves it calls nothing else —
    // in particular not applicationFeedback.list.
    const calls: string[] = [];
    const reader = new Proxy(
      {
        jobInterviewPlanInfo: async () => {
          calls.push('jobInterviewPlanInfo');
          return { results: OFFICIAL_PLAN };
        },
      } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          throw new Error(`probe reached for a forbidden member: ${String(prop)}`);
        },
      },
    );
    await expect(probeJobFeedbackForms('job_abc', reader as never)).resolves.toBeDefined();
    expect(calls).toEqual(['jobInterviewPlanInfo']);
  });

  it('propagates a provider failure instead of inventing a schema', async () => {
    const reader = { jobInterviewPlanInfo: async () => { throw new Error('403 tenant scope'); } };
    await expect(probeJobFeedbackForms('job_abc', reader as never)).rejects.toThrow('403 tenant scope');
  });

  it('keeps `applicationFeedback.list` out of the probe allowlist', () => {
    expect([...PROBE_READ_OPERATIONS]).toEqual(['jobInterviewPlan.info']);
    // The operation exists in the registry — it is excluded on purpose, not
    // absent by accident.
    expect(ASHBY_OPERATIONS['applicationFeedback.list']).toBeDefined();
  });

  it('does not disturb the stage extractor that shares the payload', () => {
    expect(extractStages(OFFICIAL_PLAN).map((s) => s.id)).toEqual(['stage_ai']);
  });
});
