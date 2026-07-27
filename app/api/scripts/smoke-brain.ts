/**
 * DB-free smoke test of the LLM "brain": resume extraction, phone normalization,
 * one screening turn, and assessment scoring — all via `claude -p`.
 * Run: npm run smoke:brain
 */
import { runClaudeJSON } from '../src/lib/claude.js';
import { normalizePhone } from '../src/lib/phone.js';
import {
  buildExtractionPrompt,
  buildConversationPrompt,
  SCREENING_SYSTEM,
  buildAssessmentPrompt,
} from '../src/lib/prompts.js';
import type { ParsedResume, ScreeningQuestion, TranscriptTurn } from '../src/lib/types.js';

const SAMPLE_RESUME = `
TAYLOR EXAMPLE
Frontend Engineer | taylor@example.invalid | +91 90000 00000 | Bengaluru

SUMMARY
Frontend engineer with 4 years building React + TypeScript web apps.

EXPERIENCE
Acme Corp — Senior Frontend Engineer (2022–present)
- Built a design system in React/TypeScript used across 6 products.
- Improved Lighthouse performance score from 62 to 94.

SKILLS
React, TypeScript, JavaScript, Redux, CSS, REST APIs, Git, Jest
`;

const template: ScreeningQuestion[] = [
  { id: 'q1', question: 'Can you walk me through your experience with React and TypeScript?', weight: 3 },
  { id: 'q2', question: 'What is your notice period?', weight: 1 },
];

async function main() {
  console.log('1) Extracting resume...');
  const parsed = await runClaudeJSON<ParsedResume>(buildExtractionPrompt(SAMPLE_RESUME));
  console.log('   parsed:', JSON.stringify(parsed));

  const phone = normalizePhone(parsed.phone);
  console.log('   phone:', JSON.stringify(phone));

  console.log('\n2) First screening message (Maya)...');
  const first = await runClaudeJSON<{ message: string; done: boolean }>(
    buildConversationPrompt({
      company: 'Interview Kickstart',
      roleTitle: 'Frontend Engineer',
      jd: null,
      requiredSkills: ['React', 'TypeScript'],
      candidateName: parsed.name,
      candidateSummary: parsed.summary,
      candidateSkills: parsed.skills ?? [],
      resumeFacts: `- Name: ${parsed.name}\n- Experience: ${parsed.experience_years} years`,
      template,
      transcript: [],
    }),
    { system: SCREENING_SYSTEM },
  );
  console.log('   Maya:', first.message, '(done:', first.done, ')');

  console.log('\n3) Assessment over a short transcript...');
  const transcript: TranscriptTurn[] = [
    { speaker: 'bot', text: first.message },
    { speaker: 'candidate', text: 'Yes, I have four years with React and TypeScript. I built a design system used across six products and improved performance a lot.' },
    { speaker: 'bot', text: 'Great. And what is your notice period?' },
    { speaker: 'candidate', text: 'I can join in 30 days.' },
  ];
  const assessment = await runClaudeJSON(
    buildAssessmentPrompt({
      roleTitle: 'Frontend Engineer',
      requiredSkills: ['React', 'TypeScript'],
      candidateName: parsed.name,
      transcript,
    }),
  );
  console.log('   assessment:', JSON.stringify(assessment, null, 2));
  console.log('\n✓ Brain smoke test complete.');
}

main().catch((e) => {
  console.error('✗ smoke test failed:', e.message);
  process.exit(1);
});
