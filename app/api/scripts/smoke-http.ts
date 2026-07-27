/**
 * Full end-to-end smoke test against the RUNNING API + live Supabase DB.
 * Start the server first (npm run dev), then: npm run smoke:http
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:8787';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return data;
}

const RESUME = `TAYLOR EXAMPLE
Frontend Engineer | taylor@example.invalid | +91 90000 00000 | Bengaluru
SUMMARY: Frontend engineer, 4 years, React + TypeScript.
EXPERIENCE: Acme Corp — Senior Frontend Engineer (2022–present). Built a design system in React/TypeScript across 6 products. Improved Lighthouse 62 -> 94.
SKILLS: React, TypeScript, JavaScript, Redux, CSS, REST APIs, Git, Jest`;

const ANSWERS = [
  "Sure. I've worked with React and TypeScript for about four years. At Acme I built a shared design system in React and TypeScript that six product teams use, and I migrated our codebase to strict TypeScript which cut runtime type bugs significantly.",
  "One tricky problem was a slow dashboard with thousands of rows. I profiled it, added virtualization with react-window, memoized expensive selectors, and moved heavy work off the main thread. Lighthouse went from 62 to 94.",
  "For larger apps I lean on React Query for server state and keep UI state local or in context. I avoid putting everything in Redux now — I reserve a global store only for truly cross-cutting state.",
  "I handle errors with a typed fetch wrapper, error boundaries for render failures, and toast notifications with retry for transient API errors. I also surface validation errors inline on forms.",
  "I'm looking for a role with strong frontend ownership and good engineering culture. My notice period is 30 days.",
];

async function main() {
  console.log('health:', await api('GET', '/api/health'));

  const role = await api('POST', '/api/roles', {
    title: 'Frontend Engineer (smoke)',
    jd: 'React/TypeScript web apps.',
    required_skills: ['React', 'TypeScript', 'JavaScript', 'CSS', 'REST APIs'],
    screening_template: [
      { id: 'q1', question: 'Walk me through your experience with React and TypeScript.', weight: 3 },
      { id: 'q2', question: 'Tell me about a challenging UI problem you solved.', weight: 3 },
      { id: 'q3', question: 'How do you manage state in a larger React app?', weight: 2 },
      { id: 'q4', question: 'How do you handle API errors on the frontend?', weight: 2 },
      { id: 'q5', question: 'What are you looking for next, and your notice period?', weight: 1 },
    ],
  });
  console.log('role created:', role.id);

  // upload resume as a .txt file via multipart
  const form = new FormData();
  form.append('file', new Blob([RESUME], { type: 'text/plain' }), 'taylor-example.txt');
  form.append('role_id', role.id);
  const upRes = await fetch(BASE + '/api/resumes', { method: 'POST', body: form });
  const up = await upRes.json();
  if (!upRes.ok) throw new Error('resume upload failed: ' + JSON.stringify(up));
  console.log('candidate:', up.candidate.id, '| phone:', up.candidate.phone_e164, 'valid:', up.candidate.phone_valid);

  const start = await api('POST', '/api/screening/start', { candidate_id: up.candidate.id });
  console.log('\nMaya:', start.message);

  let done = start.done;
  let sessionId = start.session_id;
  let i = 0;
  let lastAssessment: any = null;
  while (!done && i < ANSWERS.length) {
    const ans = ANSWERS[i++];
    console.log('\nCandidate:', ans);
    const turn = await api('POST', `/api/screening/${sessionId}/turn`, { text: ans });
    console.log('\nMaya:', turn.message, '(done:', turn.done, ')');
    done = turn.done;
    if (turn.assessment) lastAssessment = turn.assessment;
  }

  if (!lastAssessment) {
    // force-score if conversation didn't naturally end
    lastAssessment = await api('POST', `/api/assess/${sessionId}`);
  }
  console.log('\n=== SCORECARD ===');
  console.log('overall:', lastAssessment.overall_score, '| recommendation:', lastAssessment.recommendation);
  console.log('english band:', lastAssessment.english?.band, '| role_fit:', lastAssessment.role_fit?.score);
  console.log('summary:', lastAssessment.summary);

  const detail = await api('GET', `/api/candidates/${up.candidate.id}`);
  console.log('\nDB check — sessions:', detail.sessions.length, '| assessments:', detail.assessments.length);
  console.log('\n✓ Full HTTP end-to-end smoke passed.');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
