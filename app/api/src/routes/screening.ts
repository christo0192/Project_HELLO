import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { runClaudeJSON } from '../lib/claude.js';
import { env } from '../lib/env.js';
import {
  buildConversationPrompt,
  buildOpeningMessage,
  formatResumeFacts,
  SCREENING_SYSTEM,
  type ConversationContext,
} from '../lib/prompts.js';
import type { ScreeningQuestion, TranscriptTurn } from '../lib/types.js';
import { runAssessment } from '../services/assessment.js';

export const screeningRouter = Router();

interface BotReply {
  message: string;
  done: boolean;
}

async function loadContext(candidateId: string): Promise<{
  ctxBase: Omit<ConversationContext, 'transcript'>;
  roleId: string | null;
}> {
  const { data: candidate, error } = await supabase
    .from('candidates')
    .select('id,name,role_id,skills,parsed')
    .eq('id', candidateId)
    .single();
  if (error || !candidate) throw new Error(`candidate not found: ${error?.message}`);

  let roleTitle = 'the role';
  let jd: string | null = null;
  let requiredSkills: string[] = [];
  let template: ScreeningQuestion[] = [];
  if (candidate.role_id) {
    const { data: role } = await supabase
      .from('roles')
      .select('title,jd,required_skills,screening_template')
      .eq('id', candidate.role_id)
      .single();
    if (role) {
      roleTitle = role.title;
      jd = role.jd;
      requiredSkills = (role.required_skills as string[]) ?? [];
      template = (role.screening_template as ScreeningQuestion[]) ?? [];
    }
  }

  const parsed = (candidate.parsed as any) ?? {};
  return {
    roleId: candidate.role_id,
    ctxBase: {
      company: env.companyName,
      roleTitle,
      jd,
      requiredSkills,
      candidateName: candidate.name,
      candidateSummary: parsed.summary ?? null,
      candidateSkills: (candidate.skills as string[]) ?? [],
      resumeFacts: formatResumeFacts(parsed),
      template,
    },
  };
}

async function getTranscript(sessionId: string): Promise<TranscriptTurn[]> {
  const { data } = await supabase
    .from('transcript_turns')
    .select('speaker,text')
    .eq('session_id', sessionId)
    .order('turn_index', { ascending: true });
  return (data ?? []).map((t) => ({ speaker: t.speaker as 'bot' | 'candidate', text: t.text }));
}

async function appendTurn(sessionId: string, index: number, speaker: 'bot' | 'candidate', text: string) {
  await supabase.from('transcript_turns').insert({ session_id: sessionId, turn_index: index, speaker, text });
}

// POST /api/screening/start  { candidate_id }
screeningRouter.post('/start', async (req, res) => {
  try {
    const candidateId = req.body?.candidate_id as string;
    if (!candidateId) return res.status(400).json({ error: 'candidate_id is required' });

    const { ctxBase, roleId } = await loadContext(candidateId);

    const { data: session, error } = await supabase
      .from('call_sessions')
      .insert({ candidate_id: candidateId, role_id: roleId, mode: 'simulation', status: 'in_progress' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Deterministic opening — guarantees the mandatory AI disclosure.
    const opening = buildOpeningMessage({
      candidateName: ctxBase.candidateName,
      roleTitle: ctxBase.roleTitle,
      company: env.companyName,
    });

    await appendTurn(session.id, 0, 'bot', opening);
    await supabase.from('candidates').update({ status: 'screening' }).eq('id', candidateId);

    res.status(201).json({ session_id: session.id, message: opening, done: false });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'failed to start screening' });
  }
});

// POST /api/screening/:id/turn  { text }
screeningRouter.post('/:id/turn', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const text = (req.body?.text as string)?.trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    const { data: session, error: sErr } = await supabase
      .from('call_sessions')
      .select('id,candidate_id,status')
      .eq('id', sessionId)
      .single();
    if (sErr || !session) return res.status(404).json({ error: 'session not found' });
    if (session.status !== 'in_progress')
      return res.status(409).json({ error: 'session already completed' });

    const { ctxBase } = await loadContext(session.candidate_id);
    const transcript = await getTranscript(sessionId);

    // record candidate's answer
    await appendTurn(sessionId, transcript.length, 'candidate', text);
    transcript.push({ speaker: 'candidate', text });

    // generate bot's next message
    const reply = await runClaudeJSON<BotReply>(
      buildConversationPrompt({ ...ctxBase, transcript }),
      { system: SCREENING_SYSTEM },
    );
    await appendTurn(sessionId, transcript.length, 'bot', reply.message);

    let assessment = null;
    if (reply.done) {
      await supabase
        .from('call_sessions')
        .update({ status: 'completed', ended_at: new Date().toISOString() })
        .eq('id', sessionId);
      try {
        assessment = await runAssessment(sessionId);
      } catch (e: any) {
        // don't fail the turn if scoring hiccups; surface a flag
        assessment = { error: e?.message ?? 'assessment failed' } as any;
      }
    }

    res.json({ message: reply.message, done: reply.done, assessment });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'turn failed' });
  }
});

// GET /api/screening/:id  -> session + transcript + assessment
screeningRouter.get('/:id', async (req, res) => {
  const sessionId = req.params.id;
  const { data: session, error } = await supabase
    .from('call_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  const transcript = await getTranscript(sessionId);
  const { data: assessment } = await supabase
    .from('assessments')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  res.json({ session, transcript, assessment });
});
