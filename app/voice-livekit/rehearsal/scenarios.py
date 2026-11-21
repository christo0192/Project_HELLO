"""The named full-interview scenarios (M032 S8 item 1): who the simulated candidate is, and what
they do in each phase.

A scenario fixes the CONTROL acts word for word (a brief request, the "ready", an end request, the
insult, the wrap-up answer ...), so its ground truth is exact offline and live alike, and leaves the
FREE talk to the candidate simulator (scripted banks offline, DeepSeek live): the icebreaker
answers, the role-play as the advisor (``rehearsal.advisor`` behaviours) and a real wrap-up
question.  Every text here is synthetic.

Acts (the ground-truth tags of the candidate's turns): ``icebreaker_answer``, ``skip_request``,
``hold_request``, ``silence_answer`` (an answer to "are you still with me?"), ``brief_request``,
``short_brief_request``, ``presence_check``, ``roleplay_question``, ``ready`` (a spoken consent),
the ``ready_button`` event, ``advisor_turn``, ``end_request``, ``end_decline``, ``end_agree``,
``wrap_accept``, ``wrap_decline``, ``insult``, ``price_dodge``, ``price_held``, ``aside_ack``,
``wrapup_question``, ``wrapup_none`` and ``wrapup_done``; the manual library adds ``ready_button``,
``repeat_request``, ``backchannel``, ``transition_other``, ``wrapup_other`` and ``tactic``.

Selection: ``parse_scenarios("strong,early-end")``; ``synthetic`` is every scenario of this module,
``closer`` the skilled closers, ``india`` the India closer, ``wrapup`` both wrap-up runs,
``price`` both price runs, ``early`` both early ends.  The manual library
(``rehearsal.manual``) adds ``manual-M01`` .. ``manual-M10``, ``manual-mix`` and the groups
``manual-replay``, ``manual`` and ``default`` (the manual scenarios, then the synthetic ones).
The adaptability scenarios (``rehearsal.adapt``) add the group ``adapt``, and ``default+adapt``
is ``default`` plus ``adapt``.  ``all`` stays the synthetic scenarios (``skilled-closer-india``
is opt-in: by name or through ``india`` / ``closer``).
"""
from __future__ import annotations

from dataclasses import dataclass, field

ACTS = (
    "icebreaker_answer",
    "skip_request",
    "hold_request",
    "silence_answer",
    "brief_request",
    "short_brief_request",
    "presence_check",
    "roleplay_question",
    "ready",
    "advisor_turn",
    "end_request",
    "end_decline",
    "end_agree",
    "wrap_accept",
    "wrap_decline",
    "insult",
    "price_dodge",
    "price_held",
    "aside_ack",
    "wrapup_question",
    "wrapup_none",
    "wrapup_done",
    "ready_button",
    "repeat_request",
    "backchannel",
    "transition_other",
    "wrapup_other",
    "tactic",
    "noise",
    "sound_check_answer",
    # The adaptability scenarios (``rehearsal.adapt``): turns whose purpose a judge reads.
    "tangent",
    "confused_question",
    "interrupt",
    "off_script",
    "pressure",
    "discount_drop",
    "glitch_check",
    "glitch_lost",
    "argue",
)


@dataclass(frozen=True)
class Beat:
    """One control act, said word for word (``text``), with its ground-truth tag (``act``)."""

    act: str
    text: str
    intent: str = ""  # the manual library's description of the move (replays and mixes)
    traits: tuple[str, ...] = ()  # how the turn is said (``rehearsal.adapt``: tangent, ramble ...)


@dataclass(frozen=True)
class RoleplayBeat:
    """A control act in the role-play, said instead of the advisor's turn once R reaches ``at_r``."""

    act: str
    text: str
    at_r: float
    intent: str = ""
    traits: tuple[str, ...] = ()


@dataclass(frozen=True)
class Scenario:
    name: str
    title: str
    level: str
    style: str  # how the candidate talks to Christy: strong, average or terse
    tags: tuple[str, ...] = ()
    # The icebreaker, answer by answer: "answer" is a free answer, anything else a Beat's act.
    icebreaker: tuple[str, ...] = ()
    icebreaker_beats: dict[str, str] = field(default_factory=dict)
    # Stay silent (no answer at all) after Christy's N-th icebreaker question (1-based), once.
    silent_after_question: int | None = None
    silence_answer: str = "Sorry. Um, yes, I'm here."
    transition: tuple[Beat, ...] = ()
    ready_fallbacks: tuple[str, ...] = ("I'm ready.", "Ready.")
    press_button: str | None = None  # "mid_brief": the button while the brief is playing
    roleplay: tuple[RoleplayBeat, ...] = ()
    end_answers: tuple[Beat, ...] = ()  # answers to Christy's end question, in order
    price: str | None = None  # "dodge" (two dodges) or "never" (no price unless asked)
    wrapup: tuple[Beat, ...] = ()  # "<free>" text: the simulator asks a real question
    wrapup_free_question: bool = False
    # Never says anything at all (no audio): the interview must end on its own.
    silent_all: bool = False
    # Whether the interview is expected to reach the wrap-up and close as "complete".
    expect_complete: bool = True
    # The learner persona the scenario was recorded against (a manual replay), else any.
    persona: str | None = None
    candidate_name: str = "Alex"
    # A manual replay's id (``M01`` ...) or a catalogue mix (``rehearsal.manual``).
    replay_id: str | None = None
    mix: bool = False
    # An adaptability scenario's behaviour key (``rehearsal.adapt.BEHAVIOURS``), else None.
    adapt: str | None = None
    # What the candidate says to Christy's sound check, and to her offer to wrap up (accept,
    # decline); None keeps the defaults (a one-word candidate answers in one word everywhere).
    sound_check_text: str | None = None
    wrap_texts: tuple[str, str] | None = None


FREE = "<free>"
READY = Beat("ready", "Okay, I'm ready.")
WRAP_DONE = Beat("wrapup_done", "No, that's all from my side. Thank you.")

SCENARIOS: dict[str, Scenario] = {}


def _add(scenario: Scenario) -> None:
    SCENARIOS[scenario.name] = scenario


_add(
    Scenario(
        "strong",
        "A strong candidate: full answers, says ready, asks one real question at the end.",
        level="strong",
        style="strong",
        tags=("happy_path",),
        transition=(READY,),
        wrapup=(Beat("wrapup_question", FREE), WRAP_DONE),
        wrapup_free_question=True,
    )
)
_add(
    Scenario(
        "average",
        "An average candidate: shorter answers, no questions at the end.",
        level="average",
        style="average",
        tags=("happy_path",),
        transition=(Beat("ready", "Sure, I'm ready whenever you are."),),
        wrapup=(Beat("wrapup_none", "No, I think I'm good. Thank you."),),
    )
)
_add(
    Scenario(
        "terse-nervous",
        "A terse, nervous candidate: few words, one silence in the icebreaker, a hesitant ready.",
        level="terse",
        style="terse",
        tags=("terse", "silence"),
        silent_after_question=2,
        transition=(Beat("ready", "Um, okay. Ready."),),
        wrapup=(Beat("wrapup_none", "No. Thank you."),),
    )
)
_add(
    Scenario(
        "brief-repair",
        "Asks to hear the brief again, checks the interviewer is there, asks for a shorter brief.",
        level="average",
        style="average",
        tags=("brief_repeat", "presence_check", "short_brief"),
        transition=(
            Beat("brief_request", "Sorry, I didn't catch all of that. Could you repeat it?"),
            Beat("short_brief_request", "Can you give me a shorter version? That was a lot."),
            Beat("presence_check", "Hello? Are you there?"),
            READY,
        ),
        wrapup=(Beat("wrapup_none", "No, I think I'm good. Thank you."),),
    )
)
_add(
    Scenario(
        "button-mid-brief",
        "Presses the I'm-ready button while the brief is still playing, and says nothing.",
        level="strong",
        style="strong",
        tags=("ready_button",),
        press_button="mid_brief",
        wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "roleplay-question",
        "Asks the interviewer two questions about the role-play before saying ready.",
        level="strong",
        style="strong",
        tags=("transition_questions",),
        transition=(
            Beat("roleplay_question", "Before we start, am I calling her, or is she calling me?"),
            Beat("roleplay_question", "And how long will the role-play take?"),
            Beat("ready", "Got it. Okay, I'm ready."),
        ),
        wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "icebreaker-skip",
        "Asks to skip ahead in the icebreaker, and once says 'let me think' before answering.",
        level="average",
        style="average",
        tags=("icebreaker_skip", "hold_request"),
        icebreaker=("answer", "skip_request", "answer", "hold_request", "answer", "answer", "answer"),
        icebreaker_beats={
            "skip_request": "Sorry, can we skip ahead to the role-play?",
            "hold_request": "Hmm, let me think for a second.",
        },
        transition=(READY,),
        wrapup=(Beat("wrapup_none", "No, I think I'm good. Thank you."),),
    )
)
_add(
    Scenario(
        "early-end",
        "Tries to end the role-play early twice before 10:00: declines when the interviewer asks, then "
        "agrees (an agreed stop before 10:00 leaves the attempt unscored).",
        level="strong",
        style="strong",
        tags=("early_end", "end_decline", "end_agree"),
        transition=(READY,),
        roleplay=(
            RoleplayBeat("end_request", "Sorry, I want to stop here.", at_r=300.0),
            RoleplayBeat("end_request", "Can we end the role play now?", at_r=450.0),
        ),
        end_answers=(
            Beat("end_decline", "No, sorry, let's carry on."),
            Beat("end_agree", "Yes. End the interview."),
        ),
        wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "early-end-late",
        "Asks to end the role-play at 12:00, before the 14:00 floor, and agrees when asked.",
        level="strong",
        style="strong",
        tags=("early_end", "end_agree"),
        transition=(READY,),
        roleplay=(RoleplayBeat("end_request", "Can we stop the role-play here, please?", at_r=720.0),),
        end_answers=(Beat("end_agree", "Yes, please end it here."),),
        wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "abuse-once",
        "Insults the learner once in the role-play, then carries on.",
        level="strong",
        style="strong",
        tags=("abuse",),
        transition=(READY,),
        roleplay=(
            RoleplayBeat("insult", "Oh come on, stop wasting my time, you idiot.", at_r=360.0),
        ),
        wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "price-dodge",
        "Dodges the learner's price question twice before answering it.",
        level="strong",
        style="strong",
        tags=("price_dodge", "probe_first"),
        transition=(READY,),
        price="dodge",
        wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "price-never",
        "Never names a price unless the learner asks for it.",
        level="strong",
        style="strong",
        tags=("price_never", "probe_first"),
        transition=(READY,),
        price="never",
        wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "pushy-discounter",
        "A pushy advisor: price first, invented discounts and deadlines, early close.",
        level="pushy",
        style="average",
        tags=("pushy",),
        transition=(READY,),
        wrapup=(Beat("wrapup_none", "No, I think I'm good. Thank you."),),
    )
)
_add(
    Scenario(
        "skilled-closer",
        "A skilled closer: discovery first, answers every concern she raises, then asks her to "
        "enrol and offers the link and plan details on the call.",
        level="closer", style="strong", tags=("happy_path", "closer"),
        transition=(READY,), wrapup=(WRAP_DONE,),
    )
)
_add(
    Scenario(
        "wrapup-question",
        "Asks two real questions in the wrap-up.",
        level="average",
        style="average",
        tags=("wrapup_question",),
        transition=(READY,),
        wrapup=(
            Beat("wrapup_question", "What happens after this round, and when would I hear back?"),
            Beat("wrapup_question", "Is this role remote, or based in an office?"),
            WRAP_DONE,
        ),
    )
)
_add(
    Scenario(
        "silent",
        "Joins but is never heard (no audio at all): the interview must end on its own.",
        level="average",
        style="average",
        tags=("silent", "no_audio"),
        silent_all=True,
        expect_complete=False,
    )
)
_add(
    Scenario(
        "wrapup-none",
        "Says 'no, we're good' at the wrap-up.",
        level="average",
        style="average",
        tags=("wrapup_none",),
        transition=(READY,),
        wrapup=(Beat("wrapup_none", "No, we're good."),),
    )
)

SCENARIO_NAMES = tuple(SCENARIOS)  # the synthetic edge scenarios (the manual library adds more)
# Opt-in by name or the india and closer groups, so default live sweeps do not grow.
_add(
    Scenario(
        "skilled-closer-india",
        "A skilled closer selling the IK India way: discovery first, answers every concern, "
        "offers no-cost EMI and a one-day $1,500 offer, then asks her to enrol.",
        level="closer_india", style="strong", tags=("happy_path", "closer", "india_playbook"),
        transition=(READY,), wrapup=(WRAP_DONE,),
    )
)
GROUPS = {
    "all": SCENARIO_NAMES,
    "synthetic": SCENARIO_NAMES,
    "wrapup": ("wrapup-question", "wrapup-none"),
    "price": ("price-dodge", "price-never"),
    "early": ("early-end", "early-end-late"),
    "abuse": ("abuse-once",),
    "pushy": ("pushy-discounter",),
    "closer": ("skilled-closer", "skilled-closer-india"),
    "india": ("skilled-closer-india",),
    "button": ("button-mid-brief",),
}


def scenario_persona(name: str) -> str | None:
    """The learner persona a scenario is tied to (a manual replay), or None for any."""
    scenario = SCENARIOS.get(name)
    return None if scenario is None else scenario.persona


def parse_scenarios(text: str) -> tuple[str, ...]:
    """Scenario names (or groups) separated by commas, in order, without duplicates.

    Names are matched without regard to case (``manual-m01`` is ``manual-M01``).
    """
    from rehearsal import adapt, manual  # register the manual library and the adapt scenarios

    manual.register()
    adapt.register()
    lookup = {name.lower(): name for name in SCENARIOS}
    chosen: list[str] = []
    for token in (part.strip().lower() for part in (text or "").split(",") if part.strip()):
        names = GROUPS.get(token, (lookup.get(token, token),))
        for name in names:
            if name not in SCENARIOS:
                raise ValueError(
                    f"unknown scenario {name!r}; use {', '.join(SCENARIOS)} or "
                    f"{', '.join(sorted(GROUPS))}"
                )
            if name not in chosen:
                chosen.append(name)
    if not chosen:
        raise ValueError("no scenario given")
    return tuple(chosen)


# ------------------------------------------------------------------- the free talk, offline
ICEBREAKER_ANSWERS = {
    "strong": (
        "Sure. I've spent the last four years in inside sales at an online tutoring company. I "
        "started on inbound leads, parents who had filled in a form, and moved up to handling "
        "the harder conversations, the ones where the family was interested but worried about "
        "the cost or the time. Last year I was the top closer on my team for three quarters.",
        "What I enjoy most is the discovery part of a call. People rarely say what really matters "
        "in the first minute, so I ask about what prompted them to look now and what they tried "
        "before. Once I understand that, the recommendation almost makes itself, and the person "
        "feels heard instead of pitched to.",
        "A good example is a working mother who wanted to learn coding but had tried two free "
        "courses and given up. Instead of pushing the price, I asked what made her stop. It was "
        "the lack of structure. We talked about the weekly plan and the mentor check-ins, and she "
        "enrolled a week later after talking it over with her husband.",
        "I'm applying because Interview Kickstart sells something I believe in: a real change in "
        "someone's career. The ticket size is bigger than what I sold before, which means longer "
        "conversations and more trust, and that is exactly the kind of selling I want to get "
        "better at over the next few years.",
        "When someone says the price is too high, I first check whether it is really the price or "
        "something else, like doubt about the outcome. If it is the money, I talk about the value "
        "and the payment options. I never discount just to close, because people can tell when a "
        "deal is desperate.",
        "I keep every follow-up in the CRM with a note about what the person cares about, so the "
        "next call starts from where we left off. My rule is that a follow-up must bring something "
        "new, an answer to their question or a detail they asked for, not just a check-in.",
        "My targets were monthly revenue targets, around forty enrolments a month, and a weekly "
        "call count. I usually hit them by the third week, mostly because my follow-ups converted "
        "well, not because I made more calls than others.",
    ),
    "average": (
        "Hi, yes. I have worked in sales for about two years, mostly in a telecom company, selling "
        "plans to customers over the phone. Before that I did some customer support.",
        "I like talking to people and helping them find what they need. I think I'm good at "
        "building a connection quickly, and customers usually tell me I'm easy to talk to.",
        "There was a customer who wanted to cancel because the bill was high. I explained a "
        "cheaper plan to him and he stayed with us. My manager mentioned it in our team meeting.",
        "I want to move into education sales because it feels more meaningful, and I've heard "
        "good things about Interview Kickstart from a friend who works in edtech.",
        "Usually I try to explain the benefits again and maybe offer a discount if one is "
        "available. Sometimes it works, sometimes the customer needs more time.",
        "I use a spreadsheet and reminders on my phone to follow up. I try to call back within a "
        "day or two so they don't forget about the offer.",
        "We had daily call targets and a monthly sales target. I was usually around the middle of "
        "the team, sometimes a bit above.",
    ),
    "terse": (
        "Um, I did some sales. Two years.",
        "I like talking to people, I guess.",
        "Yes. Telecom plans, mostly.",
        "Um, I want a better job. More growth.",
        "I try to explain it again.",
        "Spreadsheet, mostly. And calls.",
        "Sorry, I'm a bit nervous. Monthly targets.",
    ),
}
FALLBACK_THINKING_ANSWER = (
    "Okay, I've got it. I think what I'm proudest of is learning to listen more than I talk on a "
    "call, because that is when people actually tell you what is holding them back."
)
WRAPUP_FREE_QUESTIONS = (
    "What does the next round look like if I move forward?",
    "How soon would someone in this role start taking live calls?",
)
