"""Per-phase checks of a full-interview call, and the full tier's scorecard.

``phase_checks(record)`` reads a full call's record (``rehearsal.full``) and answers, phase by
phase, the questions the owner's rules and the plan ask (M032 S8):

* ``phase_order``: the phases came in order (OPENING, ICEBREAKER, TRANSITION, ROLEPLAY with its
  asides, the exit, WRAPUP, CLOSING), never backwards;
* ``reached_closing``: a scenario that should complete reached the wrap-up and closed "complete";
  a silent one ended on its own without a role-play;
* ``icebreaker_exit``: the icebreaker ended between its soft exit (S 3:30) and its hard stop
  (S 4:30) plus the hold for a turn in flight;
* ``start_by``: the role-play started the way the scenario started it (its ground truth: a spoken
  "ready", or the "I'm ready" button), the button was on the page whenever it was pressed, and
  the candidate never had to fall back to the button because a spoken "ready" was not taken (and,
  when the code base reports it, ``session_facts.start_by`` agrees);
* ``transition_ceiling``: the role-play started within the transition's 6:00 ceiling;
* ``roleplay_end``: an in-role close (a farewell, the offer to wrap up) never exits before R 14:00
  unless the candidate agreed (D-M032-2); a time-cap exit falls inside 19:00-20:30 and never
  follows an end request that was ignored; an exit on the candidate's own end request is theirs;
* ``end_consent``: every end request is heard: Christy asks (L-ASIDE-END), or the role-play exits
  at once where the design allows it (the request names the interview or the role-play and ends on
  it, or Christy already asked once); an ignored request (no question, no exit, answered in role)
  fails, and so does an at-once exit for a request that neither names the exercise nor follows a
  question; a declined request resumed the role-play, an agreed one exited it;
* ``abuse``: what followed an insult to the learner (a hang-up path counts only where the code
  base has one: feature-detected);
* ``brief_repair``: a brief request got Christy's scripted brief line again (the full brief or a
  recap: it names the Program Advisor or the learner; the learner's own hello is not one), a
  shorter-brief request a brief line under 60 % of the brief's length, a presence check a short
  answer;
* ``icebreaker_repeat``: a request in the transition to hear an icebreaker question again got that
  question back (the second-to-last for "the one before the last", otherwise the last; an insisted
  request keeps the question the one before it asked for);
* ``wrapup_answered``: every wrap-up question got an answer before the close;
* ``hiring_team_once``: the wrap-up and the close mention the hiring team once (M032 S3 item 5);
* ``christy_repeats``: Christy says no sentence of six words or more three times outside the role-play;
* ``closing_once``: one goodbye; ``learner_after_exit``: the learner never speaks after the exit;
* ``dead_air``: no bot silence over ``DEAD_AIR_SEC`` after a candidate turn;
* ``bot_overlap``: no two bot lines play at the same time (the SDK plays one speech at a time).

Each check is ``{"ok": True | False | None, ...detail}`` (None: not applicable to this call), and
``failed`` lists the checks that are False.  ``build_full_scorecard`` aggregates them over a sweep
next to the role-play scorecard (``rehearsal.scorecard``).
"""
from __future__ import annotations

import importlib
import re
from typing import Any, Iterable, Mapping, Sequence

from rehearsal import flags

PHASE_RANK = {
    "pre_join": -1,
    "opening": 0,
    "icebreaker": 1,
    "transition": 2,
    "roleplay": 3,
    "aside": 3,
    "roleplay_exit": 4,
    "wrapup": 5,
    "closing": 6,
    "aborted": 6,
    "finishing": 7,
    "ended": 7,
}
ICEBREAKER_SOFT_EXIT_SEC = 210.0
ICEBREAKER_LATEST_SEC = 310.0  # the 4:30 hard stop, plus the bounded hold for a turn in flight
ICEBREAKER_EARLIEST_SEC = 150.0  # a skip request may end it early; earlier than this is a miss
TRANSITION_CEILING_SEC = 370.0  # 6:00, plus the pickup line
ROLEPLAY_FLOOR_SEC = 840.0  # 14:00
ROLEPLAY_STALL_SEC = 1140.0  # 19:00
ROLEPLAY_CAP_SEC = 1230.0  # 20:00 plus the closing hold
DEAD_AIR_SEC = 8.0
SHORT_ANSWER_WORDS = 30  # "Yes, I'm here" plus the start question the transition appends
CHECK_IDS = (
    "phase_order",
    "reached_closing",
    "icebreaker_exit",
    "start_by",
    "transition_ceiling",
    "roleplay_end",
    "end_consent",
    "abuse",
    "brief_repair",
    "icebreaker_repeat",
    "wrapup_answered",
    "hiring_team_once",
    "christy_repeats",
    "closing_once",
    "learner_after_exit",
    "dead_air",
    "bot_overlap",
)
OVERLAP_TOLERANCE_SEC = 0.05


# ------------------------------------------------------------------------------ helpers
def _num(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _ordered(rows: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    keyed = []
    for order, row in enumerate(rows):
        t = _num(row.get("t_start"))
        keyed.append((t if t is not None else float("inf"), order, row))
    keyed.sort(key=lambda item: (item[0], item[1]))
    return [row for _, _, row in keyed]


def _words(text: Any) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", str(text or "")))


def phases_seen(record: Mapping[str, Any]) -> list[str]:
    """The phases the page saw, in order, consecutive repeats collapsed."""
    out: list[str] = []
    for item in record.get("phase_trace") or []:
        phase = str(item.get("phase"))
        if not out or out[-1] != phase:
            out.append(phase)
    return out


def _phase_s(record: Mapping[str, Any], phase: str) -> float | None:
    for item in record.get("phase_trace") or []:
        if item.get("phase") == phase:
            return _num(item.get("s_sec"))
    return None


def _first(rows: Sequence[Mapping[str, Any]], **match: Any) -> Mapping[str, Any] | None:
    for row in rows:
        if all(row.get(key) == value for key, value in match.items()):
            return row
    return None


def _next_bot(rows: Sequence[Mapping[str, Any]], index: int) -> Mapping[str, Any] | None:
    """The first bot row after ``rows[index]`` and before the candidate's next row."""
    for row in rows[index + 1 :]:
        if row.get("speaker") == "candidate":
            return None
        if row.get("speaker") == "bot":
            return row
    return None


def abuse_supported() -> bool:
    """True when this checkout's R1 code has an abuse path (feature-detected by name)."""
    for name in ("r1_roleplay", "r1_session", "r1_guard", "r1_end_intent", "r1_script"):
        try:
            module = importlib.import_module(name)
        except Exception:  # noqa: BLE001 - a module this checkout does not have
            continue
        if any("ABUSE" in attr.upper() for attr in dir(module)):
            return True
    return False


# ------------------------------------------------------------------------------ the checks
def _phase_order(phases: Sequence[str]) -> dict[str, Any]:
    ranks = [PHASE_RANK.get(phase) for phase in phases]
    known = [rank for rank in ranks if rank is not None]
    backwards = [
        f"{phases[i - 1]}->{phases[i]}"
        for i in range(1, len(phases))
        if ranks[i] is not None and ranks[i - 1] is not None and ranks[i] < ranks[i - 1]
    ]
    return {"ok": not backwards and bool(known), "phases": list(phases), "backwards": backwards}


def _reached_closing(record: Mapping[str, Any], phases: Sequence[str], truth: Mapping[str, Any]) -> dict[str, Any]:
    outcome = record.get("outcome")
    if truth.get("expect_complete", True):
        ok = outcome == "complete" and "wrapup" in phases and "closing" in phases
        return {"ok": ok, "outcome": outcome, "expected": "complete"}
    ended = any(phase in phases for phase in ("closing", "aborted", "ended", "finishing"))
    ok = ended and "roleplay" not in phases and outcome != "complete"
    return {"ok": ok, "outcome": outcome, "expected": "ends on its own, no role-play"}


def _icebreaker_exit(record: Mapping[str, Any], truth: Mapping[str, Any]) -> dict[str, Any]:
    s_trans = _phase_s(record, "transition")
    if s_trans is None or truth.get("silent_all"):
        return {"ok": None, "s_transition": s_trans}
    early_allowed = "skip_request" in (truth.get("icebreaker_plan") or [])
    floor = ICEBREAKER_EARLIEST_SEC if early_allowed else ICEBREAKER_SOFT_EXIT_SEC - 15.0
    return {
        "ok": floor <= s_trans <= ICEBREAKER_LATEST_SEC,
        "s_transition": round(s_trans, 1),
        "window": [floor, ICEBREAKER_LATEST_SEC],
    }


def _pickup(rows: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    return _first(rows, speaker="bot", voice="learner")


def _start_by(record: Mapping[str, Any], rows: Sequence[Mapping[str, Any]], truth: Mapping[str, Any]) -> dict[str, Any]:
    pickup = _pickup(rows)
    facts = record.get("session_facts") or {}
    reported = facts.get("start_by") if isinstance(facts, Mapping) else None
    if pickup is None:
        return {"ok": None, "start_by": None, "reported": reported}
    t_pickup = _num(pickup.get("t_start")) or 0.0
    latest: tuple[float, str, str | None] | None = None
    for row in rows:
        t_end = _num(row.get("t_end"))
        if row.get("speaker") != "candidate" or t_end is None or t_end > t_pickup:
            continue
        if row.get("phase") not in ("transition", "icebreaker"):
            continue
        if latest is None or t_end >= latest[0]:
            latest = (t_end, "spoken" if row.get("act") == "ready" else f"turn:{row.get('act')}", row.get("text"))
    for event in record.get("events") or []:
        t = _num(event.get("t"))
        if event.get("kind") == "ready_button" and t is not None and t <= t_pickup:
            if latest is None or t >= latest[0]:
                latest = (t, "button", None)
    start_by = None if latest is None else latest[1]
    ok = start_by in ("spoken", "button")
    why: list[str] = []
    # What the scenario did (its ground truth): the button when it presses it, else a spoken ready.
    pressed = bool(truth.get("press_button")) or "ready_button" in (truth.get("transition") or [])
    expected = "button" if pressed else "spoken"
    if start_by in ("spoken", "button") and start_by != expected:
        ok = False
        why.append(f"expected a {expected} start, got {start_by}")
    events = list(record.get("events") or [])
    if any(e.get("kind") == "ready_button" and e.get("why") == "ready_not_taken" for e in events):
        ok = False
        why.append("a spoken ready was not taken: the candidate fell back to the button")
    if any(e.get("kind") == "button_not_shown" and e.get("phase") == "transition" for e in events):
        # In the transition the page must show the button; elsewhere it never does (a replay move
        # recorded as a press there is the scenario's, not the product's).
        ok = False
        why.append("a press was due in the transition but the page did not show the button")
    agrees = None
    if reported is not None and start_by in ("spoken", "button"):
        agrees = reported == start_by
        ok = ok and agrees
    out = {
        "ok": ok,
        "start_by": start_by,
        "expected": expected,
        "reported": reported,
        "reported_agrees": agrees,
        "s_pickup": _num(pickup.get("s_sec")),
    }
    if why:
        out["why"] = why
    return out


def _transition_ceiling(record: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    s_trans = _phase_s(record, "transition")
    pickup = _pickup(rows)
    if s_trans is None or pickup is None or _num(pickup.get("s_sec")) is None:
        return {"ok": None}
    took = float(pickup["s_sec"]) - s_trans
    return {"ok": took <= TRANSITION_CEILING_SEC, "transition_seconds": round(took, 1)}


def _candidate_acts(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return list(record.get("candidate_turns") or [])


def _roleplay_end(
    record: Mapping[str, Any], phases: Sequence[str], consent: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    if "roleplay" not in phases:
        return {"ok": None}
    end = record.get("stop_reason")
    r_end = _num(record.get("roleplay_seconds")) or 0.0
    acts = [turn.get("act") for turn in _candidate_acts(record)]
    agreed = "end_agree" in acts or "wrap_accept" in acts
    detail: dict[str, Any] = {"end": end, "r_end": round(r_end, 1), "agreed": agreed}
    ignored = [item for item in (consent or {}).get("requests") or [] if item.get("ignored")]
    if end == "time_cap":
        detail["ok"] = ROLEPLAY_STALL_SEC <= r_end <= ROLEPLAY_CAP_SEC
        if ignored:
            # The role-play ran to the cap after the candidate asked to stop and was not heard.
            detail["ok"] = False
            detail["why"] = "the role-play ran to the time cap after an ignored end request"
            detail["ignored_requests_r"] = [item.get("r") for item in ignored]
    elif end in ("farewell_exit", "wrap_accepted"):
        detail["ok"] = r_end >= ROLEPLAY_FLOOR_SEC or agreed
        if not detail["ok"]:
            detail["why"] = "an in-role close ended the role-play before R 14:00 without the candidate agreeing"
    elif end == "end_request":
        detail["ok"] = True  # the candidate asked to stop (whether Christy asked first: end_consent)
        detail["early"] = r_end < ROLEPLAY_FLOOR_SEC
        detail["unscored_floor"] = r_end < 600.0
    else:
        detail["ok"] = None
    return detail


def _bot_rows_until_candidate(rows: Sequence[Mapping[str, Any]], index: int) -> list[Mapping[str, Any]]:
    """The bot rows after ``rows[index]`` and before the candidate's next row."""
    out = []
    for row in rows[index + 1 :]:
        if row.get("speaker") == "candidate":
            break
        if row.get("speaker") == "bot":
            out.append(row)
    return out


def _is_end_question(row: Mapping[str, Any]) -> bool:
    """Christy's L-ASIDE-END as said (the ``question`` column the harness writes), or, in a record
    without that column, any Christy line inside the role-play."""
    if row.get("voice") != "christy" or row.get("phase") not in ("aside", "roleplay"):
        return False
    question = row.get("question", "end")
    return question == "end"


def _names_the_end(text: Any) -> bool | None:
    """Whether the request names the interview or the role-play and ends on it (the engine exits
    such a request at once, by design: owner test 1eb18cd4); None when this checkout cannot say."""
    try:
        from r1_tracker import explicit_end_request, strictly_names_end
    except ImportError:  # pragma: no cover - feature detect
        return None
    value = str(text or "")
    return bool(explicit_end_request(value) or strictly_names_end(value))


def _end_consent(record: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    requests = [i for i, row in enumerate(rows) if row.get("speaker") == "candidate" and row.get("act") == "end_request"]
    if not requests:
        return {"ok": None}
    items = []
    ok = True
    for index in requests:
        bots = _bot_rows_until_candidate(rows, index)
        reply = bots[0] if bots else None
        asked = bool(reply is not None and _is_end_question(reply))
        exited = any(row.get("phase") in ("roleplay_exit", "wrapup") for row in bots)
        asked_before = any(_is_end_question(row) for row in rows[:index])
        answer = next(
            (row for row in rows[index + 1 :] if row.get("speaker") == "candidate"), None
        )
        item: dict[str, Any] = {"r": _num(rows[index].get("r_sec")), "asked": asked, "exited_at_once": exited}
        if not asked and not exited:
            # Neither asked nor exited: the request was ignored (answered in role, or not at all).
            item["ignored"] = True
            item["answered_in_role"] = any(row.get("voice") == "learner" for row in bots)
            ok = False
        elif exited and not asked:
            names = _names_the_end(rows[index].get("text"))
            basis = "asked_before" if asked_before else ("names_the_end" if names else None)
            if basis is None and names is None:
                basis = "unknown"
            item["exit_basis"] = basis
            if basis is None:
                # An at-once exit is the design only for a request that names the interview or the
                # role-play, or a request after Christy already asked once (D-M032-2: consent).
                item["exited_without_asking"] = True
                ok = False
        if asked and answer is not None:
            item["answer"] = answer.get("act")
            later = rows[rows.index(answer) + 1 :]
            resumed = any(row.get("voice") == "learner" for row in later[:4])
            exit_row = next((row for row in later[:3] if row.get("phase") in ("roleplay_exit", "wrapup")), None)
            if answer.get("act") == "end_decline":
                item["resumed"] = resumed and exit_row is None
                ok = ok and item["resumed"]
            elif answer.get("act") == "end_agree":
                item["exited"] = exit_row is not None
                ok = ok and item["exited"]
        items.append(item)
    return {"ok": ok, "requests": items}


def _abuse(record: Mapping[str, Any], rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    insults = [i for i, row in enumerate(rows) if row.get("speaker") == "candidate" and row.get("act") == "insult"]
    if not insults:
        return {"ok": None}
    index = insults[0]
    after = rows[index + 1 :]
    learner_lines = 0
    exited = False
    for row in after:
        if row.get("phase") in ("roleplay_exit", "wrapup"):
            exited = True
            break
        if row.get("voice") == "learner":
            learner_lines += 1
            if learner_lines > 2:
                break
    facts = record.get("session_facts") or {}
    supported = abuse_supported() or (isinstance(facts, Mapping) and "abuse_count" in facts)
    return {
        "ok": exited if supported else None,
        "supported": supported,
        "exited_within_two_learner_lines": exited,
        "learner_lines_before_exit": learner_lines,
        "r": _num(rows[index].get("r_sec")),
    }


def _is_brief_line(row: Mapping[str, Any], learner: str | None) -> bool:
    """Christy's scripted brief (or its recap): a ``say`` line naming the role or the learner.

    The learner's own scripted hello is a ``say`` line naming the learner too: that is the role-play
    starting, not the brief again.
    """
    if row.get("source") != "say" or row.get("voice") == "learner":
        return False
    text = str(row.get("text") or "")
    if re.search(r"program advisor", text, re.IGNORECASE):
        return True
    return bool(learner) and re.search(rf"\b{re.escape(str(learner))}\b", text) is not None


def _brief_repair(rows: Sequence[Mapping[str, Any]], record: Mapping[str, Any] | None = None) -> dict[str, Any]:
    v2 = flags.on(flags.TRANSITION_ACTS_V2)
    learner = ((record or {}).get("header") or {}).get("learner_first_name")
    brief = _first(rows, speaker="bot", phase="transition")
    brief_words = _words(brief.get("text")) if brief else 0
    items = []
    ok: bool | None = None
    for index, row in enumerate(rows):
        act = row.get("act")
        if row.get("speaker") != "candidate" or row.get("phase") != "transition":
            continue
        if act not in ("brief_request", "short_brief_request", "presence_check"):
            continue
        reply = _next_bot(rows, index)
        words = _words(reply.get("text")) if reply else 0
        if reply is None:
            good = False
        elif act == "brief_request" and v2:
            # The brief again, as Christy's scripted line (a long refusal is not a brief).
            good = _is_brief_line(reply, learner)
        elif act == "brief_request":
            good = words >= 25 or bool(re.search(r"program advisor|calling (?:her|him) back", str(reply.get("text")), re.I))
        elif act == "short_brief_request" and v2:
            good = _is_brief_line(reply, learner) and 0 < words < brief_words * 0.6
        elif act == "short_brief_request":
            good = 0 < words < max(25, int(brief_words * 0.6))
        else:
            good = 0 < words <= SHORT_ANSWER_WORDS
        items.append({"act": act, "reply_words": words, "ok": good})
        ok = good if ok is None else (ok and good)
    return {"ok": ok, "brief_words": brief_words, "requests": items}


_COMMON_WORDS = frozenset(
    "about and any are can did does for from had has have how into its just like that the their them "
    "then there they this was were what when where which who why will with would you your".split()
)


def _content_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9']+", text.lower()) if len(w) >= 3 and w not in _COMMON_WORDS}


def _asks_again(question: str, reply: str) -> bool:
    """The reply holds the question again (most of its own words; the wording may change a little)."""
    wanted = _content_words(question)
    if len(wanted) < 2:
        return " ".join(re.findall(r"[a-z0-9']+", question.lower())) in " ".join(re.findall(r"[a-z0-9']+", reply.lower()))
    return len(wanted & _content_words(reply)) >= 0.6 * len(wanted)


_SECOND_LAST = re.compile(
    r"\bbefore (?:the )?last\b|\bsecond[- ](?:to[- ])?last\b|\bpenultimate\b", re.IGNORECASE
)
_LAST = re.compile(r"\b(?:last|previous|latest) (?:\w+ ){0,2}question\b|\brepeat the question\b", re.IGNORECASE)


def _icebreaker_repeat(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if not flags.on(flags.TRANSITION_ACTS_V2):
        return {"ok": None}
    questions: list[str] = []
    for row in rows:
        if row.get("speaker") != "bot" or row.get("voice") == "learner":
            continue
        if row.get("phase") not in ("opening", "icebreaker"):
            continue
        for sentence in _SENTENCE.split(str(row.get("text") or "")):
            if sentence.strip().endswith("?") and not re.search(r"\bhear me\b", sentence, re.IGNORECASE):
                questions.append(sentence.strip())
    items = []
    ok: bool | None = None
    target: str | None = None
    for index, row in enumerate(rows):
        if row.get("speaker") != "candidate" or row.get("phase") != "transition" or row.get("act") != "repeat_request":
            continue
        # Which question it asks for: "the one before the last" the second-to-last; "the last" or "the
        # previous" the last; a request naming neither ("no, the earlier one") keeps the question the
        # request before it asked for, and a first such request means the last.
        what = f"{row.get('intent') or ''} || {row.get('text') or ''}"
        if _SECOND_LAST.search(what):
            target = "second_last"
        elif _LAST.search(what) or target is None:
            target = "last"
        wanted = questions[-2:-1] if target == "second_last" and len(questions) >= 2 else questions[-1:]
        reply = _next_bot(rows, index)
        text = str((reply or {}).get("text") or "")
        good = bool(text) and any(_asks_again(question, text) for question in wanted)
        items.append({"target": target, "reply_words": _words(text), "ok": good})
        ok = good if ok is None else (ok and good)
    return {"ok": ok, "questions_asked": len(questions), "requests": items}


def _wrapup_answered(rows: Sequence[Mapping[str, Any]], phases: Sequence[str]) -> dict[str, Any]:
    if "wrapup" not in phases:
        return {"ok": None}
    asked = any(row.get("speaker") == "bot" and row.get("phase") == "wrapup" for row in rows)
    questions = []
    ok = asked
    for index, row in enumerate(rows):
        if row.get("speaker") == "candidate" and row.get("act") == "wrapup_question":
            reply = _next_bot(rows, index)
            answered = bool(reply and reply.get("phase") == "wrapup")
            questions.append({"answered": answered, "closing_instead": bool(reply and reply.get("phase") == "closing")})
            ok = ok and answered
    return {"ok": ok, "wrap_question_asked": asked, "questions": questions}


_HIRING_TEAM = re.compile(r"\bhiring team\b", re.IGNORECASE)


def _hiring_team_once(rows: Sequence[Mapping[str, Any]], phases: Sequence[str]) -> dict[str, Any]:
    if "closing" not in phases and "wrapup" not in phases:
        return {"ok": None}
    lines = [
        row
        for row in rows
        if row.get("speaker") == "bot"
        and row.get("phase") in ("wrapup", "closing")
        and _HIRING_TEAM.search(str(row.get("text") or ""))
    ]
    return {"ok": len(lines) <= 1, "mentions": len(lines)}


_SENTENCE = re.compile(r"(?<=[.!?])\s+")


def _christy_repeats(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for row in rows:
        if row.get("voice") != "christy" or row.get("phase") in ("roleplay", "aside"):
            continue
        for sentence in _SENTENCE.split(str(row.get("text") or "")):
            key = " ".join(re.findall(r"[a-z0-9']+", sentence.lower()))
            if len(key.split()) >= 6:
                counts[key] = counts.get(key, 0) + 1
    repeated = {key: count for key, count in counts.items() if count >= 3}
    return {"ok": not repeated, "repeated": [f"{count}x {key[:60]}" for key, count in repeated.items()]}


def _closing_once(rows: Sequence[Mapping[str, Any]], phases: Sequence[str]) -> dict[str, Any]:
    if "closing" not in phases:
        return {"ok": None}
    lines = [row for row in rows if row.get("speaker") == "bot" and row.get("phase") == "closing"]
    return {"ok": len(lines) == 1, "closing_lines": len(lines)}


def _learner_after_exit(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    exit_index = next((i for i, row in enumerate(rows) if row.get("phase") == "roleplay_exit"), None)
    if exit_index is None:
        return {"ok": None}
    late = [row for row in rows[exit_index:] if row.get("voice") == "learner"]
    return {"ok": not late, "learner_lines_after_exit": len(late)}


def _dead_air(rows: Sequence[Mapping[str, Any]], truth: Mapping[str, Any]) -> dict[str, Any]:
    if truth.get("silent_all"):
        return {"ok": None}
    gaps = []
    for index, row in enumerate(rows):
        if row.get("speaker") != "candidate" or _num(row.get("t_end")) is None:
            continue
        reply = _next_bot(rows, index)
        if reply is None or _num(reply.get("t_start")) is None:
            continue
        gaps.append((float(reply["t_start"]) - float(row["t_end"]), row.get("phase")))
    if not gaps:
        return {"ok": None}
    worst = max(gaps, key=lambda item: item[0])
    over = [round(gap, 1) for gap, _ in gaps if gap > DEAD_AIR_SEC]
    return {
        "ok": not over,
        "max_gap_sec": round(worst[0], 1),
        "max_gap_phase": worst[1],
        "over": over,
        "limit_sec": DEAD_AIR_SEC,
    }


def _bot_overlap(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """No two bot lines play at once (livekit-agents plays one speech at a time, in order)."""
    spans = sorted(
        (float(row["t_start"]), float(row["t_end"]), row)
        for row in rows
        if row.get("speaker") == "bot" and _num(row.get("t_start")) is not None and _num(row.get("t_end")) is not None
    )
    if not spans:
        return {"ok": None}
    overlaps = []
    end_so_far = spans[0][1]
    for start, end, row in spans[1:]:
        if start < end_so_far - OVERLAP_TOLERANCE_SEC:
            overlaps.append(
                {"s_sec": _num(row.get("s_sec")), "voice": row.get("voice"), "seconds": round(end_so_far - start, 2)}
            )
        end_so_far = max(end_so_far, end)
    return {"ok": not overlaps, "overlaps": overlaps[:10], "count": len(overlaps)}


def phase_timings(record: Mapping[str, Any]) -> dict[str, Any]:
    """Seconds spent in each phase (the S clock), and R at the role-play's end."""
    trace = [(str(item.get("phase")), _num(item.get("s_sec"))) for item in record.get("phase_trace") or []]
    out: dict[str, float] = {}
    for (phase, start), (_, end) in zip(trace, trace[1:]):
        if start is None or end is None:
            continue
        key = "roleplay" if phase == "aside" else phase
        out[key] = round(out.get(key, 0.0) + max(0.0, end - start), 1)
    return {
        "phase_seconds": out,
        "session_seconds": record.get("session_seconds"),
        "roleplay_seconds_r": record.get("roleplay_seconds"),
    }


def phase_checks(record: Mapping[str, Any]) -> dict[str, Any]:
    """Every per-phase check of one full call (see the module docstring)."""
    rows = _ordered(record.get("rows") or [])
    truth = (record.get("header") or {}).get("ground_truth") or {}
    phases = phases_seen(record)
    consent = _end_consent(record, rows)
    checks = {
        "phase_order": _phase_order(phases),
        "reached_closing": _reached_closing(record, phases, truth),
        "icebreaker_exit": _icebreaker_exit(record, truth),
        "start_by": _start_by(record, rows, truth),
        "transition_ceiling": _transition_ceiling(record, rows),
        "roleplay_end": _roleplay_end(record, phases, consent),
        "end_consent": consent,
        "abuse": _abuse(record, rows),
        "brief_repair": _brief_repair(rows, record),
        "icebreaker_repeat": _icebreaker_repeat(rows),
        "wrapup_answered": _wrapup_answered(rows, phases),
        "hiring_team_once": _hiring_team_once(rows, phases),
        "christy_repeats": _christy_repeats(rows),
        "closing_once": _closing_once(rows, phases),
        "learner_after_exit": _learner_after_exit(rows),
        "dead_air": _dead_air(rows, truth),
        "bot_overlap": _bot_overlap(rows),
    }
    failed = [name for name in CHECK_IDS if checks[name].get("ok") is False]
    return {
        "phases": phases,
        "start_by": checks["start_by"].get("start_by"),
        "checks": checks,
        "failed": failed,
        "timings": phase_timings(record),
    }


# ----------------------------------------------------------------------------- scorecard
def aggregate_checks(records: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for check in CHECK_IDS:
        passed = failed = na = 0
        calls: list[str] = []
        for record in records:
            value = ((record.get("phase_checks") or {}).get("checks") or {}).get(check, {}).get("ok")
            if value is True:
                passed += 1
            elif value is False:
                failed += 1
                calls.append(str((record.get("header") or {}).get("seed")))
            else:
                na += 1
        out[check] = {"pass": passed, "fail": failed, "n/a": na, "failed_calls": calls}
    return out


def build_full_scorecard(
    records: Sequence[Mapping[str, Any]], *, offline: bool, header: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """The role-play scorecard of the calls that reached a role-play, plus the per-phase checks."""
    from rehearsal.scorecard import build_scorecard

    with_roleplay = [record for record in records if record.get("exchanges")]
    roleplay = build_scorecard(with_roleplay, offline=offline, header=header) if with_roleplay else None
    checks = aggregate_checks(records)
    failed = [
        {"call": str((record.get("header") or {}).get("seed")), "check": name}
        for record in records
        for name in (record.get("phase_checks") or {}).get("failed") or []
    ]
    reasons = list((roleplay or {}).get("readiness", {}).get("reasons") or ["no role-play was reached"])
    if failed:
        reasons.append(f"{len(failed)} per-phase check(s) failed")
    errors = [str((r.get("header") or {}).get("seed")) for r in records if r.get("error")]
    if errors:
        reasons.append(f"{len(errors)} call(s) broke")
    return {
        "header": dict(header or {}),
        "tier": "full",
        "offline": offline,
        "calls": len(records),
        "roleplay": roleplay,
        "phase_checks": checks,
        "phase_checks_failed": failed,
        "errors": errors,
        "ready_for_owner_test": not reasons,
        "reasons": reasons,
    }


def render_full_markdown(card: Mapping[str, Any], records: Sequence[Mapping[str, Any]]) -> str:
    from rehearsal.scorecard import render_markdown

    lines = [
        "# Full-interview rehearsal scorecard",
        "",
        f"{card['calls']} call(s), {'OFFLINE (scripted models)' if card['offline'] else 'LIVE'}. "
        f"Ready for an owner test: **{'yes' if card['ready_for_owner_test'] else 'no'}**"
        + ("" if card["ready_for_owner_test"] else f" ({'; '.join(card['reasons'])})"),
        "",
        "## Per-phase checks",
        "",
        "| check | pass | fail | n/a | failed calls |",
        "|---|---|---|---|---|",
    ]
    for name, row in card["phase_checks"].items():
        failed = ", ".join(row["failed_calls"][:6]) + (" ..." if len(row["failed_calls"]) > 6 else "")
        lines.append(f"| {name} | {row['pass']} | {row['fail']} | {row['n/a']} | {failed} |")
    lines += [
        "",
        "## Calls",
        "",
        "| call | scenario | outcome | role-play end | start | S | R | failed checks |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for record in records:
        head = record.get("header") or {}
        checks = record.get("phase_checks") or {}
        lines.append(
            f"| {head.get('seed')} | {head.get('scenario')} | {record.get('outcome')} | "
            f"{record.get('stop_reason')} | {checks.get('start_by')} | "
            f"{_clock(record.get('session_seconds'))} | {_clock(record.get('roleplay_seconds'))} | "
            f"{', '.join(checks.get('failed') or []) or '-'} |"
        )
    if card.get("roleplay"):
        with_roleplay = [record for record in records if record.get("exchanges")]
        lines += ["", "## Role-play (the role-play tier's gates)", "", render_markdown(card["roleplay"], with_roleplay)]
    return "\n".join(lines) + "\n"


def _clock(seconds: Any) -> str:
    value = _num(seconds)
    if value is None:
        return "-"
    value = max(0, int(value))
    return f"{value // 60:02d}:{value % 60:02d}"
