"""
Build the per-call screening context (system prompt + opener) by loading the role
and candidate from Supabase (screening_v2) — mirroring v1's dynamic variables, so
Maya asks the SAME role-specific questions and cross-checks the SAME resume facts.

Degrades gracefully: if ids/DB are missing, falls back to query-param name/role and
the default question flow, so a standalone test still works.
"""

import db
from prompts import (
    format_questions,
    format_resume_facts,
    opening_line,
    system_prompt,
)


async def build_screening_context(candidate_id=None, role_id=None, name_param=None, role_param=None):
    role = await db.get_role(role_id) if role_id else None
    cand = await db.get_candidate(candidate_id) if candidate_id else None

    candidate_name = (cand or {}).get("name") or name_param
    role_title = (role or {}).get("title") or role_param or "the role"

    role_focus = None
    questions = None
    if role:
        role_focus = role.get("jd") or ", ".join(role.get("required_skills") or [])
        questions = format_questions(role.get("screening_template") or [])

    resume_facts = format_resume_facts((cand or {}).get("parsed")) if cand else None

    system_text = system_prompt(candidate_name, role_title, role_focus, resume_facts, questions)
    opening_text = opening_line(candidate_name, role_title)
    return system_text, opening_text, candidate_name
