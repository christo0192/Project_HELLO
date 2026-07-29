import type { ParsedResume, ScreeningQuestion, TranscriptTurn } from './types.js';

// ── LLM-06: Prompt template version identifiers ────────────────────────
// These are the canonical version constants for provenance tracking.
// Bump the version identifier when the corresponding template function
// changes in a semantically meaningful way (structure, scoring, behavior).

export const SCREENING_PROMPT_TEMPLATE_VERSION = '2026-07-28.1';
export const SCORING_PROMPT_TEMPLATE_VERSION = '2026-07-28.1';

// Resume extraction
export function buildExtractionPrompt(resumeText: string): string {
  return `You are a resume parser. Extract structured data from the resume text below.

Return a JSON object with EXACTLY these keys:
- "name": full name (string or null)
- "email": email address (string or null)
- "phone": the candidate's phone number exactly as written, including any country code (string or null)
- "skills": array of technical/professional skills (string[])
- "experience_years": total years of professional experience as a number (number or null)
- "current_role": most recent job title (string or null)
- "summary": a 1-2 sentence professional summary (string or null)

Resume text:
"""
${resumeText.slice(0, 12000)}
"""`;
}

export function formatResumeFacts(parsed: Partial<ParsedResume> | null | undefined): string {
  const p = parsed ?? {};
  const lines = [
    `- Name: ${p.name ?? 'unknown'}`,
    `- Current/most recent role: ${p.current_role ?? 'unknown'}`,
    `- Total experience (years): ${p.experience_years ?? 'unknown'}`,
    `- Skills: ${(p.skills ?? []).join(', ') || 'unknown'}`,
    `- Summary: ${p.summary ?? 'n/a'}`,
  ];
  return lines.join('\n');
}

// Deterministic opening. The required AI disclosure must not be left to the model.
export function buildOpeningMessage(args: {
  candidateName: string | null;
  roleTitle: string;
  company: string;
}): string {
  const rawFirst = (args.candidateName ?? '').trim().split(/\s+/)[0] || 'there';
  const first = rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1).toLowerCase();
  return (
    `Hi ${first}, this is an automated AI assistant calling on behalf of ${args.company} ` +
    `about the ${args.roleTitle} role you applied for. Just to be clear, I'm an AI, not a person. ` +
    `This is a short first-round screening and should only take about ten minutes. ` +
    `Is now a good time to talk?`
  );
}

export interface ConversationContext {
  company: string;
  roleTitle: string;
  jd?: string | null;
  requiredSkills: string[];
  candidateName: string | null;
  candidateSummary: string | null;
  candidateSkills: string[];
  resumeFacts: string;
  template: ScreeningQuestion[];
  transcript: TranscriptTurn[];
}

export const SCREENING_SYSTEM = `You are "Gopu", a warm, professional AI voice assistant running a first-round phone screening for a hiring team in India. You speak natural, clear Indian English at a relaxed, human pace. Friendly but efficient.

TIME BUDGET: keep the whole call to about 5 MINUTES. Be concise, keep your turns short, and do not over-ask follow-ups. Prioritize the mandatory items and your gap probes, and skip lower-priority small talk if time is running on.

How you run the call:
- You have ALREADY greeted the candidate and disclosed you are an automated AI in your first message. Do NOT repeat the full disclosure. If the candidate ever asks, confirm plainly that you are an automated AI assistant. Never claim to be human.
- Follow the SCREENING FLOW you are given, in order, but generate the actual questions LIVE and naturally from the role and the candidate's resume. Personalize ("I noticed you worked on X - tell me about that").
- Ask ONE question at a time. Keep each turn short and conversational. This is speech, not an essay. No lists, no markdown.
- Acknowledge each answer briefly, then move on. Given the 5-minute budget, only ask a follow-up when truly needed.
- Items marked [MUST ASK] are mandatory. They must be asked and answered before you end the call. Never skip them.
- GAP PROBING: if the candidate hasn't shown evidence of one of the role's key requirements, ask ONE INDIRECT question that gives them a chance to surface it. For example, instead of "you have no sales experience?", ask "have you ever had to convince someone to choose a particular option?". Do this for at most the 2 MOST important missing requirements.
- RESUME CHECK: if an answer conflicts with the candidate's resume facts (years, title, skills), politely probe with 1 clarifying question. Stay warm and never accuse.
- Do not make hiring promises or quote salary; say the team will follow up.
- When the flow is complete (including EVERY [MUST ASK] item), thank the candidate by name, tell them the team will be in touch about next steps, say goodbye, and end the call.`;

export function buildConversationPrompt(ctx: ConversationContext): string {
  const transcriptStr = ctx.transcript.length
    ? ctx.transcript.map((t) => `${t.speaker === 'bot' ? 'Gopu' : 'Candidate'}: ${t.text}`).join('\n')
    : '(no messages yet - this is the start of the call)';

  const flow = ctx.template.length
    ? ctx.template.map((q, i) => `${i + 1}. ${q.mandatory ? '[MUST ASK] ' : ''}${q.question}`).join('\n')
    : '1. Quick intro - ask the candidate to tell you a bit about themselves and their current work\n2. [MUST ASK] Total years of relevant experience\n3. Their most relevant experience for this role (adapt to resume)\n4. [MUST ASK] Reason for leaving their current/previous organization\n5. [MUST ASK] Expected CTC';

  return `Context for this screening call (hiring company: ${ctx.company}):
- Role: ${ctx.roleTitle}
- Role focus / requirements: ${(ctx.jd ?? ctx.requiredSkills.join(', ')).slice(0, 900)}
- Candidate name: ${ctx.candidateName ?? 'the candidate'}
- Candidate RESUME FACTS (use to detect conflicts with what they say):
${ctx.resumeFacts}

SCREENING FLOW - cover in order; phrase each question live, naturally, adapted to the resume:
${flow}

Conversation so far:
${transcriptStr}

Decide Gopu's NEXT message. Rules: cover every [MUST ASK] item before ending; if an answer conflicts with the resume facts, ask 1-2 clarifying questions about it. Return a JSON object:
- "message": what Gopu says next (natural spoken style)
- "done": true ONLY if all flow items including every [MUST ASK] item have been covered and this message ends the call; otherwise false`;
}

export function buildAssessmentPrompt(args: {
  roleTitle: string;
  requiredSkills: string[];
  candidateName: string | null;
  transcript: TranscriptTurn[];
  resumeFacts?: string;
}): string {
  const transcriptStr = args.transcript
    .map((t) => `${t.speaker === 'bot' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
    .join('\n');

  return `You are a recruiter assessing a FIRST-ROUND phone-screening transcript for the role of "${args.roleTitle}".
This is only a screen - deep role fit is evaluated later in the R1 interview. Be LENIENT and top-of-funnel: the question is "is this person worth a human R1 conversation?", not "can they do the whole job perfectly?". Judge potential, and do NOT over-penalize short answers.
Key role requirements (context, weighed lightly here): ${args.requiredSkills.join(', ') || 'n/a'}.
Assess ONLY the candidate's responses.

Candidate RESUME FACTS (compare against what they said to find discrepancies):
${args.resumeFacts ?? '(not provided)'}

Score the candidate and return a JSON object with EXACTLY this shape (all numeric sub-scores are 0-10):
{
  "english": { "band": "A1|A2|B1|B2|C1|C2", "grammar": 0-10, "vocabulary": 0-10, "fluency": 0-10, "coherence": 0-10, "notes": "Deprecated duplicate for backward compatibility. Mirror communication.english_proficiency." },
  "tone": { "clarity": 0-10, "confidence": 0-10, "professionalism": 0-10, "sentiment": "positive|neutral|negative", "notes": "..." },
  "communication": {
    "score": 0-10,
    "clarity": 0-10,
    "structure": 0-10,
    "listening": 0-10,
    "rapport": 0-10,
    "english_proficiency": { "band": "A1|A2|B1|B2|C1|C2", "grammar": 0-10, "vocabulary": 0-10, "fluency": 0-10, "coherence": 0-10, "notes": "..." },
    "filler_usage": { "level": "low|moderate|high", "examples": ["..."], "impact_score": 0-10, "notes": "..." },
    "native_language_usage": { "level": "none|low|moderate|high", "examples": ["..."], "impact_score": 0-10, "notes": "..." },
    "notes": "..."
  },
  "motivation": { "score": 0-10, "notes": "..." },
  "role_fit": { "score": 0-10, "matched_skills": ["..."], "gaps": ["..."], "red_flags": ["..."], "notes": "..." },
  "resume_conflicts": [ { "topic": "...", "resume_says": "...", "candidate_said": "...", "resolved": true, "note": "..." } ],
  "overall_score": 0-100,
  "recommendation": "advance|hold|reject",
  "summary": "2-3 sentence overall summary for the hiring manager"
}

Dimension guidance:
- "communication.score": combined communication and English score. Judge how clearly and effectively they articulate ideas, structure answers, listen, build rapport, persuade/explain, and use English in a customer-facing call.
- "communication.english_proficiency": language proficiency. Grade LENIENTLY - only give low scores if the English is genuinely poor / hard to follow. Minor grammar slips or an accent should NOT pull scores down.
- "communication.filler_usage": detect distracting filler words such as "um", "uh", "like", "you know", repeated "actually", repeated "basically", long verbal stalls, or similar. Use examples from the transcript where possible. impact_score 10 = no meaningful issue, 0 = very distracting.
- "communication.native_language_usage": detect whether the candidate uses too much non-English/native-language speech for a role that requires clear English customer conversations. Do NOT penalize a light accent or one-off native word. impact_score 10 = no issue, 0 = mostly not understandable in English.
- "motivation.score": genuine interest in the role and the company, energy, and intent to join.
- "english": deprecated mirror of communication.english_proficiency for compatibility only. Do not treat it as a separate dimension.
- "tone": confidence, professionalism, warmth.
- "role_fit": relevant background only (kept light - depth is for R1). Note matched_skills, gaps, red_flags.
- "resume_conflicts": list every discrepancy between statements and resume facts (years, titles, skills). "resolved" = did clarification reconcile it. Empty array [] if none. Flag for the human; do NOT tank the score unless it reveals dishonesty.

Note: "overall_score" and "recommendation" you return are advisory only - the system recomputes them from the sub-scores with fixed weights. Still fill them in reasonably.

Transcript:
"""
${transcriptStr}
"""`;
}
