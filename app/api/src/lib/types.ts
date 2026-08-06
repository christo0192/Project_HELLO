export interface ScreeningQuestion {
  id: string;
  question: string;        // topic/anchor - Gopu phrases it naturally and adapts
  weight?: number;         // relative importance for scoring
  follow_up_hint?: string;
  mandatory?: boolean;     // must be asked and answered, e.g. years of exp, why-left, CTC
}

export interface ParsedResume {
  name: string | null;
  email: string | null;
  phone: string | null;
  skills: string[];
  experience_years: number | null;
  current_role: string | null;
  summary: string | null;
}

export interface TranscriptTurn {
  speaker: 'bot' | 'candidate';
  text: string;
  /** Seconds from the authoritative recording start to this turn's start.
   *  Derived as max(0, turn_started_at_ms − recording_egress_started_at_ms) / 1000.
   *  NULL when either anchor is missing (legacy rows, simulation sessions,
   *  non-egress recordings). */
  start_offset_sec?: number | null;
}

export interface LanguageProficiencyScore {
  band: string;          // CEFR A1..C2
  grammar: number;       // 0-10
  vocabulary: number;    // 0-10
  fluency: number;       // 0-10
  coherence: number;     // 0-10
  notes: string;
}

export interface SpeechPatternSignal {
  level: 'none' | 'low' | 'moderate' | 'high';
  examples: string[];
  impact_score: number;  // 0-10; higher means less distracting
  notes: string;
}

export interface Assessment {
  // Backward-compatible for older assessment rows. New scoring puts this inside
  // communication.english_proficiency and does not weight this separately.
  english?: LanguageProficiencyScore;
  tone: {
    clarity: number;       // 0-10
    confidence: number;    // 0-10
    professionalism: number; // 0-10
    sentiment: string;     // positive|neutral|negative
    notes: string;
  };
  communication: {
    score: number;         // 0-10 - clarity, articulation, rapport, listening, English
    clarity: number;
    structure: number;
    listening: number;
    rapport: number;
    english_proficiency: LanguageProficiencyScore;
    filler_usage: Omit<SpeechPatternSignal, 'level'> & {
      level: 'low' | 'moderate' | 'high';
    };
    native_language_usage: SpeechPatternSignal;
    notes: string;
  };
  motivation: {
    score: number;         // 0-10 - genuine interest in role + company, energy, intent
    notes: string;
  };
  role_fit: {
    score: number;         // 0-10
    matched_skills: string[];
    gaps: string[];
    red_flags: string[];
    notes: string;
  };
  overall_score: number;   // 0-100
  recommendation: 'advance' | 'hold' | 'reject';
  summary: string;
  // Discrepancies between what the candidate said and their resume.
  resume_conflicts: {
    topic: string;          // e.g. "Years of experience"
    resume_says: string;
    candidate_said: string;
    resolved: boolean;      // did the clarification resolve it?
    note: string;
  }[];
}
