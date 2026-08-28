-- 0066_phone_directive_topics.sql
--
-- Follow-up to 0065, which is already applied in production and therefore
-- immutable: the speakability gate accepts recruiter DIRECTIVE rows as
-- question topics.
--
-- 0065's delivery model hands every plan question to the model to phrase
-- ("ask this planned topic in your own natural words"), so a template row is
-- a TOPIC, not speech. Recruiters author topics as directives — the
-- production role's template is eight rows like "Ask about total experience
-- and customer-facing, counselling, advisory, or sales experience." — and
-- under 0065's spoken-question-only positive requirement five of those eight
-- refuse at plan materialization with `invalid_role_template`, which would
-- stop the role phone-screening entirely.
--
-- The positive requirement now accepts directive shape
-- (ask/probe/explore/cover/check/confirm/discuss/understand/find) alongside
-- spoken-question shape. The refusals that matter are unchanged:
-- meta/prompt-shaped rows (`system`, `prompt`, `instruction`, bracketed
-- markup) and "don't say/tell/mention/reveal/ignore" steering chains. The
-- one verbatim path left is the say() FALLBACK when the opening generation
-- fails; a directive row spoken once on that rare path is an accepted trade
-- for not forcing every recruiter template to be re-authored.

create or replace function screening_v2.cagv_question_is_speakable(p_text text)
returns boolean language sql immutable
as $$
  select p_text is not null
    and length(btrim(p_text)) between 1 and 2000
    and btrim(p_text) ~* '\?|\m(tell|describe|walk|explain|what|how|why|when|where|which|could|can|have|did|would|are|do|is|ask|probe|explore|cover|check|confirm|discuss|understand|find)\M'
    and btrim(p_text) !~* '\m(system|developer|assistant|model|prompt|instruction|interviewer|recruiter)\M'
    and btrim(p_text) !~* '\m(must|should|do not|don''t)\s+(say|tell|mention|reveal|ignore)\M'
    and btrim(p_text) !~ '[\[\]{}<>]'
$$;
