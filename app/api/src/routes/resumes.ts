import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import mammoth from 'mammoth';
// import from the lib path to avoid pdf-parse's debug self-test on import
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { supabase, RESUME_BUCKET } from '../lib/supabase.js';
import { runClaudeJSON } from '../lib/claude.js';
import { buildExtractionPrompt } from '../lib/prompts.js';
import { normalizePhone } from '../lib/phone.js';
import type { ParsedResume } from '../lib/types.js';

export const resumesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function extractText(buf: Buffer, mime: string, name: string): Promise<string> {
  const lower = name.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    const out = await pdfParse(buf);
    return out.text;
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lower.endsWith('.docx')
  ) {
    const out = await mammoth.extractRawText({ buffer: buf });
    return out.value;
  }
  // plain text fallback
  return buf.toString('utf-8');
}

/**
 * POST /api/resumes
 * multipart: file (required), role_id (optional)
 * Uploads the resume, extracts text, parses with claude -p, creates a candidate.
 */
resumesRouter.post('/', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'file is required (multipart field "file")' });
    const roleId = (req.body?.role_id as string) || null;

    // 1) store the raw file
    const ext = file.originalname.split('.').pop() ?? 'bin';
    const storagePath = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(RESUME_BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: `storage upload failed: ${upErr.message}` });

    // 2) extract text
    const text = await extractText(file.buffer, file.mimetype, file.originalname);
    if (!text || text.trim().length < 20) {
      return res.status(422).json({ error: 'Could not extract readable text from this file.' });
    }

    // 3) parse with claude -p
    const parsed = await runClaudeJSON<ParsedResume>(buildExtractionPrompt(text));

    // 4) normalize phone (default India)
    const phone = normalizePhone(parsed.phone);

    // 5) persist resume row
    const { data: resumeRow, error: rErr } = await supabase
      .from('resumes')
      .insert({
        file_path: storagePath,
        file_name: file.originalname,
        mime_type: file.mimetype,
        text_extracted: text.slice(0, 50000),
        parsed,
      })
      .select()
      .single();
    if (rErr) return res.status(500).json({ error: rErr.message });

    // 6) persist candidate row (+ consent record, implied via application)
    const now = new Date().toISOString();
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .insert({
        role_id: roleId,
        resume_id: resumeRow.id,
        name: parsed.name,
        email: parsed.email,
        phone_raw: phone.raw || parsed.phone,
        phone_e164: phone.e164,
        phone_valid: phone.valid,
        skills: parsed.skills ?? [],
        experience_years: parsed.experience_years,
        parsed,
        status: 'new',
        consent_source: 'job_application',
        consent_at: now,
      })
      .select()
      .single();
    if (cErr) return res.status(500).json({ error: cErr.message });

    await supabase.from('consent_records').insert({
      candidate_id: candidate.id,
      source: 'job_application',
      proof: { note: 'Candidate submitted resume/application for this role.', captured_at: now },
    });

    res.status(201).json({ candidate, resume: resumeRow, phone });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'resume processing failed' });
  }
});
