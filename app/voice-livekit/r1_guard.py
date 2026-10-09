"""R1 output guard: per-sentence screening of every LLM sentence before it is spoken.

Plan 5.3.  The guard runs in EVERY phase, before the transcription/TTS tee, so captions,
stored transcript turns and scorer input are filtered as well as speech.  It never calls
the LLM and never changes a phase: it can only keep, replace or drop a sentence.

What it blocks (each category logs as ``r1_guard_<category>``):

``control`` / ``vendor`` / ``evaluation``
    Prompt and scoring vocabulary (CONTROL, OWED, H1-H3, F1-F4, "rubric", "system prompt",
    "as an AI", "language model"), model or vendor names, and scoring words.  In the
    opening and the icebreaker only a genuine leak counts (rubric, scorecard, threshold,
    "you are being scored", "your score"): "metrics", "rated" and "scores" are everyday
    words when the candidate describes a sales background.
``meta``
    Learner only: AI identity, "role-play", "this test", "persona", "instructions",
    "Christy".
``persona_secret``
    Interviewer phases after the persona is revealed: persona names (except the
    candidate's own first name), "$7,000", "objection", "hidden need" and the active
    persona's deep-need markers.
``volunteered_need``
    Learner only: a deep need whose topic has not been released by a probe and a
    follow-up.  The replacement is the topic's surface answer.
``commitment`` / ``concession``
    Learner only: any call, day, time, enrolment or payment acceptance above the WEAK
    stall, or resolution phrasing ("you've convinced me"); doubt such as "I'm not convinced
    yet" is not a concession.  Commitments are scripted and spoken by the worker, never by
    the LLM (S0-B: a dated call was accepted).
``invented_fact``
    Learner only: product, format, schedule, hours, outcome or amount claims that are not
    on the public card.  Interviewer: salary or work-mode claims, next-step timelines
    and role facts beyond the deck's shift timings, replaced by the deferral line.
``feedback`` / ``hiring_comp``
    Interviewer: feedback phrasing in wrap-up (replaced by L-NO-FEEDBACK, and the reply ends
    there: nothing the model says after the refusal is spoken), and hiring or
    compensation statements.  Outcomes and pay figures are always blocked; incentives,
    work mode and timelines only when the sentence is about THIS role, the future or an
    offer, so the candidate's own history ("you earned strong incentives", "you relocated
    for that role") can be repeated back.
``contact``
    Every phase: e-mail addresses (written or spoken), phone numbers, URLs and handles.
    S0-B found invented addresses in 24% of conversations.
``protected_question``
    Interviewer: questions about the CANDIDATE's age, marital status, children, religion,
    caste or health ("how old are you", "do you have kids"); the bare words are sales
    vocabulary ("convince parents to enrol their children", "sold health insurance").
``scripted_cue``
    The scripted exit line imitated by the LLM; and, in the opening and the icebreaker, the
    LLM announcing the role-play itself ("Now let's move into the role-play...").  The
    driver alone starts the role-play (the scripted transition line), so an improvised start
    would be a second one.
``ack_format``
    Hygiene, not a leak: an acknowledgement sentence with a question, a digit or a product
    word that is not a card answer or a paraphrase of one.  The sentence is dropped, but
    the hit does not count toward the 3-hit gate (``LEAK_CATEGORIES``).
``repeat``
    Hygiene, not a leak: the learner is about to say a sentence it already said earlier in
    the call (``GuardContext.said``; ``r1_text.repeat_kind``).  The sentence is dropped
    and nothing is posted: like ``ack_format`` it is outside ``LEAK_CATEGORIES`` and
    ``r1_replies.fidelity_events`` does not post it, because the API counts EVERY
    ``guard_hit`` row toward its 3-hit limit.

The ``control`` category also covers an INSTRUCTION ECHO: six consecutive words copied
from the private prompt prose (``GuardContext.control_texts``; the phone lane's
``phone_instruction_echo_detected``, copied rather than imported).

Plan section 9 forbids logging utterances, so a ``Hit`` carries the category, the rule and
a 12-character digest, and no text unless the caller opts in (``keep_excerpts``).

False positives matter as much as leaks: "time commitment" and "Interview Kickstart" are
fine (S0-B defect 7), and the candidate's own first name is never a persona leak.
"""
from __future__ import annotations

import functools
import hashlib
import re
from dataclasses import dataclass, field
from typing import Iterable

from r1_commitment import Level, classify_learner_commitment
from r1_personas import (
    ALL_PERSONA_NAMES,
    H_TOPICS,
    PERSONAS,
    PUBLIC_ANSWERS,
    RenderedPersona,
)
from r1_script import EXIT_CUE, LINES
from r1_text import (
    CLOSER,
    CONCESSION_TAG,
    CONCESSION_TAG_LEADING,
    CONCESSION_TAG_TRAILING,
    PHRASE_CONCESSION_TAG,
    canonical_amounts,
    TIC_HMM,
    TIC_HONESTLY,
    TIC_PATTERNS,
    clause_before,
    dollar_amounts,
    fold,
    fuzzy_contains,
    has_contact_detail,
    is_question_like,
    mask_contact,
    negated_before,
    normalize,
    pick_variant,
    PHRASE_STRETCH,
    PHRASE_TEMPLATE_Q,
    QUESTION_TEMPLATE,
    STRETCH_ALTERNATIVES,
    STRETCH_PHRASE,
    repeat_kind,
    reply_opener,
    split_sentences,
    truncate_words,
    word_count,
)
from r1_world import INTERVIEWER_DEFLECTION

FALLBACK_REPLY = "Sorry, what were you saying?"
# The learner's fallback rotates (seeded by the attempt id) so a second blocked reply never
# repeats the first one word for word.  The interviewer keeps ``FALLBACK_REPLY``.  R1-Q iteration 3:
# the learner never says it did not hear a clear question ("Sorry, what were you saying?" answered
# "Is it live or recorded?" in the live sweep and the advisor had to repeat it), so its fallbacks
# are the sound of a person thinking.
FALLBACK_REPLIES = (
    "Give me a second, I'm thinking that over.",
    "That's something I need to think about for a moment.",
    "Okay, let me think about that for a second.",
)
NO_FEEDBACK_LINE = LINES["L-NO-FEEDBACK"]
CONTACT_REPLACEMENT = "You can use the email on my form."
NEUTRAL_ACKS = ("Okay.", "I see.", "Right.", "Mm-hmm.")
REPLY_WORD_CAP = 45
ACK_WORD_CAP = 15
HIT_FLAG_THRESHOLD = 3
# Speaking style (R1-Q iteration 1).  A tic word ("hmm", "honestly") may appear in at most one
# reply in five, an interjection or demonstrative may open at most one reply in seven, and a reply
# never holds two filler words.  All of it is deterministic text surgery: zero extra model calls.
STYLE_TIC_WINDOW = 4
STYLE_OPENER_WINDOW = 6
# R1-Q iteration 2.  A tracked phrase ("a stretch", the "what would it involve" question) may be
# used this often in a call; a free reply asks nothing when one of the last QUESTION_DIET_WINDOW
# replies already asked (the live sweep: 0.67 to 0.81 of the replies held a question, gate 0.60),
# and a reply never asks two questions.
PHRASE_QUOTA = {PHRASE_STRETCH: 1, PHRASE_TEMPLATE_Q: 1, PHRASE_CONCESSION_TAG: 1}
# R1-Q iteration 3: the diet over-corrected (the question rate fell to 0.21-0.25 against a floor
# of 0.25; 17 replies lost their only question), so a free reply may ask unless the PREVIOUS
# reply did.
QUESTION_DIET_WINDOW = 1
# A question about the price asked before the advisor has put any price on the table is never
# dropped.
_PRICE_QUESTION = re.compile(
    r"\b(?:how much|what(?:'s| is| would| will)? (?:the |it |that |this )?(?:\w+ )?(?:price|"
    r"cost|fee|total)|what would (?:i|it|that) (?:actually )?(?:end up )?(?:cost|pay)|"
    r"what (?:do|would) i (?:\w+ ){0,3}pay|(?:total|final) (?:cost|price|number|amount))\b",
    re.IGNORECASE,
)
# A reply that has said this many words or fewer ("Okay.", "Right, I see.") still needs its
# question.
THIN_REPLY_WORDS = 4
# A word that can also start a sentence ("Look at the schedule", "Right now", "So far", "Well done")
# only counts as a filler or an interjection when a comma, a full stop or a dash follows it.
_LEAD_FILLER = re.compile(
    r"^\W*(?:(?:hmm+|hm|honestly|to be honest|frankly|actually|basically)\b[,.\s-]*"
    r"|(?:well|look|listen|i mean|you know)\b[,.-]+\s*)",
    re.IGNORECASE,
)
_LEAD_INTERJECTION = re.compile(
    r"^\W*(?:(?:okay|ok|oh|yeah|alright|all right|ah|wow|mm|um+|uh+)\b[,.!?\s-]*"
    r"|(?:right|sure|well|so|great|perfect|cool|fine|yes)\b[,.!?-]+\s*)+",
    re.IGNORECASE,
)
_INLINE_FILLER = re.compile(r",?\s*\b(?:you know|i mean)\b,?", re.IGNORECASE)
# A sentence longer than this is left alone: the style rules are for spoken sentences.
STYLE_MAX_CHARS = 600
# "that helps" -> "helps": only where dropping the demonstrative leaves a sentence.  Only a verb
# may follow (R1-Q iteration 3): "That's reassuring" lost its "That's" and 41 replies in 17
# calls opened with the fragment ("Reassuring, at least." twelve times in ten calls), so "That's"
# before an evaluative adjective stays.  (Iteration 2 had narrowed it from noun phrases: "That's
# the part I'd need to see" became "The part I'd need ...".)
_LEAD_DEMONSTRATIVE = re.compile(
    r"^that\s+(?=(?:helps|makes|sounds|gives|means|feels|seems|covers|explains|answers|eases|"
    r"works)\b)",
    re.IGNORECASE,
)
# "Before I go, ..." / "One more thing before I go": the learner is not the one leaving (the
# live sweep: "Before I go" in calls where nobody left).  The advisor's goodbye is answered with
# "Oh wait, before you go ...", which is a different phrase and stays.
_BEFORE_I_GO = re.compile(
    r"^\W*(?:(?:and|so|but|oh|well|also)\b[,\s]*)*"
    r"(?:(?:one|a) (?:more|last|quick) (?:thing|question)[,\s]+)?"
    r"before (?:i|we) (?:go|hang up|wrap up|run|leave|get going)\b(?:,? though)?[,.:\s-]*",
    re.IGNORECASE,
)
_INLINE_BEFORE_I_GO = re.compile(
    r",?\s*\bbefore (?:i|we) (?:go|hang up|wrap up|run|leave|get going)\b,?(?: though)?",
    re.IGNORECASE,
)
# "I have to be honest, ..." and "I need to be honest with you: ..." are the "honestly" tic.
_HONEST_CLAUSE = re.compile(
    r"(?:^|(?<=[\s,;-]))(?:i|we)(?:'d| would)?\s+(?:have|need|got|want|ought)\s+to\s+be\s+"
    r"(?:honest|frank|upfront)(?:\s+with\s+you)?\s*[,:;-]+\s*",
    re.IGNORECASE,
)
# The adverb "honestly" and "frankly" are always the tic.  "to be honest" is the tic only as an
# aside ("..., to be honest, ..."); in "I need to be honest with myself" it is the sentence.
_HONEST_ADVERB = r"(?:honestly|frankly)"
_HONEST_ASIDE = r"to be honest(?!\s+(?:with|about|that|if|enough|and)\b)"
_TIC_STRIP = {
    TIC_HMM: (
        re.compile(r"^\W*hmm+\b[,.\s-]*", re.IGNORECASE),
        re.compile(r"\s*,?\s*\bhmm+\b[,.]?", re.IGNORECASE),
    ),
    TIC_HONESTLY: (
        _HONEST_CLAUSE,
        re.compile(
            r"^\W*(?:" + _HONEST_ADVERB + r"|" + _HONEST_ASIDE + r")\b[,.\s-]*", re.IGNORECASE
        ),
        re.compile(r"\s*,?\s*\b" + _HONEST_ADVERB + r"\b[,]?", re.IGNORECASE),
        re.compile(r"\s*,\s*" + _HONEST_ASIDE + r"\b[,]?", re.IGNORECASE),
    ),
}
# "Also, how many hours a week ...", "And before I commit ...": a connector whose sentence was
# dropped is left hanging, so it goes with it.
_LEAD_CONNECTOR = re.compile(
    r"^\W*(?:and also|and|also|but|plus|then|besides|additionally)\b[,\s]+", re.IGNORECASE
)
# A figure the model wrapped in quote marks ("$7,000", "six months"): the marks were copied from
# the prompt's list of figures and are read out by the TTS as a pause.
_QUOTED_FIGURE = re.compile(
    r"[\"\u201c\u201d]\s*((?:\$\s?)?\d[\d,]*(?:\.\d+)?(?:\s*k\b)?|(?:six|6) months?)\s*"
    r"[\"\u201c\u201d]",
    re.IGNORECASE,
)


def _unquote_figures(sentence: str) -> str:
    """``sentence`` without quote marks around an amount or the course length."""
    if '"' not in sentence and "\u201c" not in sentence:
        return sentence
    return _QUOTED_FIGURE.sub(r"\1", sentence)


# A confirmation holds no doubt and asks nothing new: these words reopen what was agreed.
_DOUBT = re.compile(
    r"\b(?:hold on|not sure|hesitat\w+|hard sell|pressure|but what|what if|still need|i'?d rather|"
    r"i don'?t want|too soon|too early|i'?m afraid|on second thought|i'?m (?:a bit |a little )?"
    r"worried|i worry|concerns?)\b"
    r"|(?<!can't )(?<!cannot )(?<!can not )\bwait\b(?! (?:to|for|until)\b)",
    re.IGNORECASE,
)
# The time cue is the LEARNER's: "you mentioned you only have a couple of minutes" turns it round.
# It is about the advisor's AVAILABILITY: "you just said $7,500 a minute ago" is the learner
# catching a price, not a time cue (R1-Q iteration 2: that sentence was dropped, and the question
# that followed it lost its referent).
_TIME_REVERSAL = re.compile(
    r"\byou(?:'ve| have)? (?:just |only )?(?:mentioned|said|told me|noted)\b[^.?!]{0,40}"
    r"\b(?:(?:a couple of|a few|two|five|ten|fifteen|twenty|\d+) minutes\b(?! ago)|next call|"
    r"another call|short on time|(?:have|got|need) to (?:go|run|hop|jump|leave))"
    r"|\byou(?:'ve| have|'re| are)? (?:only |just )?(?:got|have|having) (?:only |just )?"
    r"(?:a couple of|a few|two|five|ten|\d+) minutes\b",
    re.IGNORECASE,
)
# The decision maker is on the learner's side of the call: the plan is a call WITH them, so the
# learner never says they dislike calls or would not take part (a model said "he's not really one
# for these things" and, a turn later, booked a call with him).
_THIRD_PERSON = r"(?:he|she|they|my (?:husband|wife|partner|spouse|father|mother|dad|mom|parents))"
_CALL_WORDS = (
    r"(?:calls?|phone|talking|meetings?|chats?|speaking|these things|this kind of thing|"
    r"things like this|that sort of thing)"
)
_DECIDER_UNWILLING = re.compile(
    rf"\b{_THIRD_PERSON}\b[^.?!]{{0,30}}(?:\bnot\b|\bnever\b|n't\b)[^.?!]{{0,16}}"
    r"\b(?:one for|a fan of|big on|into|keen on|fond of|comfortable with|up for|good with|"
    r"the type for|a phone person|a call person)\b[^.?!]{0,30}"
    rf"\b{_CALL_WORDS}\b"
    rf"|\b{_THIRD_PERSON}\b[^.?!]{{0,25}}"
    r"\b(?:hates?|dislikes?|avoids?|won'?t (?:join|do|take|be on|come)|wouldn'?t "
    r"(?:join|do|take|be on|come)|doesn'?t (?:do|like|take|join)|refuses?)\b[^.?!]{0,25}"
    rf"\b{_CALL_WORDS}\b",
    re.IGNORECASE,
)
# "What I'd heard": hearsay about a figure that is not the $7,000 anchor ("That $6,300 actually
# matches what I'd heard people got it for", "I heard something like nine thousand").  The anchor
# is the only price the learner heard; the $9,000 it SAW on the website.
_HEARSAY = re.compile(
    r"\b(?:what i(?:'d|'ve| had| have)? (?:heard|read)|i(?:'d|'ve| had| have)? (?:heard|read)"
    r"|i was told|someone told me|people (?:got|paid|said|told))\b",
    re.IGNORECASE,
)
# Calling the price a stretch once the advisor has put $7,000 or less on the table (the learner's
# own ask): "That number's better, but it's still a stretch for me" after "six thousand flat".
_PRICE_STRAIN = re.compile(
    r"\b(?:(?:quite|kind of|sort of|a bit of|a real) )?a stretch\b"
    r"|\bstill (?:a lot|too much|steep|pricey|expensive|high|a big number|a big ask|heavy)\b"
    r"|\b(?:too|very|really|so) (?:expensive|pricey|steep)\b"
    r"|\bmore than (?:i|we) (?:can|could|wanted|planned|hoped|budgeted|expected)\b",
    re.IGNORECASE,
)
_TIME_TOPIC = re.compile(
    r"\b(?:time|schedule|hours?|weeks?|months?|busy|packed|work|job|evenings?|weekends?)\b",
    re.IGNORECASE,
)
# "That still sounds like a lot per month" when the advisor never gave a monthly figure.
_MONTHLY_REACTION = re.compile(
    r"\b(?:per month|a month|each month|every month|monthly|/month)\b", re.IGNORECASE
)
_STRAIN_PRICE_WORDS = re.compile(
    r"\b(?:a lot|too much|steep|stretch|expensive|pricey|heavy|big number)\b", re.IGNORECASE
)
# An advisor turn that gives a monthly figure (an amount next to "a month") or one that is just
# about monthly instalments.
MONTHLY_FIGURE = re.compile(
    r"\$\s?\d[\d,.]*\s*(?:k\s*)?(?:a|per|each|every|/)\s*(?:month|mo\b)"
    r"|\b(?:monthly|per month|a month|each month|every month)\b[^.?!]{0,30}\$\s?\d"
    r"|\$\s?\d[\d,.]*[^.?!]{0,20}\b(?:monthly|per month|a month|each month|every month)\b",
    re.IGNORECASE,
)
# The decision maker stays the persona's whole call ("it's just me deciding" is the contradiction).
_DECIDES_ALONE = re.compile(
    r"\b(?:it'?s|it is|its) (?:just|only) me\b[^.?!]{0,25}\b(?:decid\w+|decision|who decides)\b"
    r"|\b(?:just|only) me (?:deciding|who decides|making (?:the|this) decision)\b"
    r"|\bi (?:decide|make (?:the|this|my own) decisions?) (?:on my own|alone|by myself|myself)\b"
    r"|\b(?:no ?one|nobody) else (?:is |will be |has to be )?(?:involved|decides?|deciding|"
    r"part of|in (?:the|this) decision)\b"
    r"|\bi don'?t (?:need to|have to) (?:ask|check with|talk to|run (?:it|this) by) "
    r"(?:any ?one|anybody|someone)\b",
    re.IGNORECASE,
)
# Thanks for a discount nobody granted: "I can check with my manager" -> "Thank you, that helps".
_GRANT_GRATITUDE = re.compile(
    r"\b(?:thank(?:s| you)|appreciate|grateful)\b[^.?!]{0,50}\b(?:discount|reduc\w+|"
    r"(?:lower|better|special) (?:price|rate|deal)|the deal|that helps?|that would help|"
    r"helps a lot|great news|good news|that'?s great)\b"
    r"|\b(?:great|good|wonderful) news\b|\bbetter than i expected\b|\bthat'?s a (?:huge )?relief\b",
    re.IGNORECASE,
)
# What the learner says in place of a misreading (never the misreading itself).
ANCHOR_REPLACEMENT = "So what would the actual price come to?"
GRATITUDE_REPLACEMENT = "That would be good to know."
# In place of "that matches what I'd heard" about a figure that is not the $7,000 anchor.
ANCHOR_HEARD_REPLACEMENT = "I'd heard people got it for around $7,000."
ANCHOR_HEARD_BELOW = "That's even below the $7,000 I'd heard people got it for."
# In place of "that's a bit better" when the advisor put no lower price on the table (R1-Q
# iteration 3: 11 replies in 10 calls called an unchanged or a worse offer better).
PRICE_UNCHANGED_REPLACEMENT = "That's still more than I had planned for."
# "That lines up with what I'd heard" / "in line with what I heard" / "that's what I heard": only
# true of the $7,000 itself.  Said about any other price it contradicts the anchor the learner
# raised.
_HEARD_IN_LINE = re.compile(
    r"\b(?:in line with|lines? up with|matches|consistent with|the same as|right (?:at|around)|"
    r"about|close to|roughly|just|exactly)\s+(?:what|where)\s+i(?:'d| had| have)?\s+"
    r"(?:heard|read)\b"
    r"|\bthat'?s (?:what|about what|roughly what|exactly what|just what) i(?:'d| had| have)?\s+"
    r"(?:heard|read)\b",
    re.IGNORECASE,
)
# "That's a bit better" / "better than I expected" / "an improvement" / "closer to what I had in
# mind" said about the price.  A sentence that is plainly about something else is not one.
_BETTER_PRICE = re.compile(
    r"\b(?:that|it|this)(?:'s| is| looks| sounds| seems| feels) "
    r"(?:(?:definitely|certainly|already|actually|a bit|a little|a touch|slightly|much|way|"
    r"so much|quite a bit|somewhat) )*(?:better|closer)\b"
    r"|\b(?:more like it|an improvement)\b",
    re.IGNORECASE,
)
# "a bit better than I expected" / "better than before" need a price word in the sentence: the
# same words are "I'd like to understand it a bit better" and "better than watching videos".
_BETTER_THAN = re.compile(
    r"\b(?:(?:a bit|a little|a touch|slightly|much|way|so much|quite a bit|somewhat) "
    r"(?:better|closer)(?: than| to (?:what|where)| price| number| offer)"
    r"|better than (?:i|what i|before|the (?:first|last|full|original|list)|expected)"
    r"|closer to (?:what|where) i)",
    re.IGNORECASE,
)
_PRICE_WORD = re.compile(
    r"\b(?:price|cost|number|offer|deal|figure|discount|pay|paying|afford\w*|budget|\$\s?\d|"
    r"expected|hoped|planned)\b",
    re.IGNORECASE,
)
_NOT_ABOUT_PRICE = re.compile(
    r"\b(?:videos?|youtube|coursera|free|schedule|fit|option|support|mentors?|structure|classes|"
    r"curriculum|projects?|portfolio|interviews?|career|job|time|hours?|pace|format)\b",
    re.IGNORECASE,
)
_STILL_MORE = re.compile(
    r"\bmore than i (?:had |'d |would have )?(?:planned|hoped|budgeted|expected|wanted)\b",
    re.IGNORECASE,
)
# The call was placed by the advisor ("I'm glad I called"): the learner filled in a form.
_I_CALLED = re.compile(
    r"\b(?:glad i (?:called|rang|phoned)|when i called|i called (?:because|you|in|about)|"
    r"my call to you|thanks for taking my call)\b",
    re.IGNORECASE,
)
# A warm confirmation for a reply that held only doubts or questions after a commitment.
CONFIRM_FALLBACKS = (
    "Sounds good, thank you. I'm looking forward to it.",
    "Great, thanks so much. Looking forward to it.",
    "Perfect, thank you. Talk to you then.",
)
# "Oh, $7,000, that's better than I expected" after the learner only RAISED $7,000.
_ANCHOR_REACTION = re.compile(
    r"\b7,?000\b[^?]{0,60}\b(?:better than i expected|a relief|great|good news|wonderful|perfect|"
    r"amazing|that works|works for me|sounds good|i'?ll take)\b"
    r"|\b(?:better than i expected|that'?s a relief|great news|good news)\b[^?]{0,40}\b7,?000\b"
    r"|\bso you can (?:actually |really )?do (?:the |that )?\$?7,?000\b",
    re.IGNORECASE,
)

LEARNER_PHASE = "roleplay"
FEEDBACK_PHASES = frozenset({"roleplay_exit", "wrapup", "closing"})
PERSONA_REVEALED_PHASES = frozenset({"transition", "roleplay_exit", "wrapup", "closing"})

CONTROL = "control"
VENDOR = "vendor"
EVALUATION = "evaluation"
META = "meta"
PERSONA_SECRET = "persona_secret"
VOLUNTEERED_NEED = "volunteered_need"
COMMITMENT = "commitment"
CONCESSION = "concession"
INVENTED_FACT = "invented_fact"
FEEDBACK = "feedback"
HIRING_COMP = "hiring_comp"
CONTACT = "contact"
PROTECTED_QUESTION = "protected_question"
SCRIPTED_CUE = "scripted_cue"
ACK_FORMAT = "ack_format"
REPEAT = "repeat"
REOPEN = "reopen"
MISREAD = "misread"
CATEGORIES = (
    CONTROL,
    VENDOR,
    EVALUATION,
    META,
    PERSONA_SECRET,
    VOLUNTEERED_NEED,
    COMMITMENT,
    CONCESSION,
    INVENTED_FACT,
    FEEDBACK,
    HIRING_COMP,
    CONTACT,
    PROTECTED_QUESTION,
    SCRIPTED_CUE,
    ACK_FORMAT,
    REPEAT,
    REOPEN,
    MISREAD,
)
# Hygiene is counted and logged but is not a leak and is never posted to the API.
HYGIENE_CATEGORIES = frozenset({ACK_FORMAT, REPEAT, REOPEN, MISREAD})
# Categories that count toward the 3-hit gate: everything except hygiene.
LEAK_CATEGORIES = frozenset(CATEGORIES) - HYGIENE_CATEGORIES


def _ci(*patterns: str) -> re.Pattern[str]:
    return re.compile("|".join(patterns), re.IGNORECASE)


# Control tokens appear in prompts in upper case, so they are matched case-sensitively;
# "owed", "reminder" and "h1" in ordinary lower-case speech are not leaks.
_CONTROL_TOKEN = re.compile(
    r"\b(?:CONTROL|OWED|ROLEPLAY|CANDIDATE_MONOLOGUE|R_CLOCK\w*|MODE=\w*)\b|\b[HF][1-4]\b"
    r"|\bPHASE\s*[=:]"
)
_CONTROL_PHRASE = _ci(
    r"\brubric\b",
    r"\bsystem (?:prompt|message|note)\b",
    r"\bas an ai\b",
    r"\blanguage model\b",
    r"\bowed move\b",
    r"\bhidden needs?\b",
)
_VENDOR = _ci(r"\b(?:deepseek|chatgpt|openai|gemini|claude|anthropic|gpt-?\d*|sarvam|livekit)\b")
_EVALUATION = _ci(
    r"\b(?:rubric|scorecard|scoring|scored|scores?|grading|graded|rated|ratings?|metrics?|"
    r"thresholds?|calibrat\w+|auto-?reject\w*|automated decisions?)\b"
)
# In the opening and the icebreaker the interviewer talks about the candidate's sales
# background, where "metrics", "rated" and "scores" are everyday words ("What metrics did
# you own?", "How were you rated against your targets?").  There only a genuine leak of
# THIS evaluation counts: jargon, or a statement that the candidate is being scored.
SMALL_TALK_PHASES = frozenset({"opening", "icebreaker"})
_EVALUATION_LEAK = _ci(
    r"\b(?:rubric|scorecard|thresholds?|calibrat\w+|auto-?reject\w*|automated decisions?)\b",
    r"\bscor(?:ed|es|ing)? (?:you|your (?:answers?|responses?|call|performance|interview)|"
    r"this (?:call|interview|conversation)|the (?:call|interview|conversation))\b",
    r"\bgrad(?:e|es|ed|ing) (?:you|your|this|the (?:call|interview|conversation)|on|against)\b",
    r"\b(?:is|are|will be|being|be|get|gets) (?:scored|graded)\b",
    r"\byour (?:score|scores|grade|marks)\b",
)
_LEARNER_META = _ci(
    r"\b(?:i am|i'?m|am i|you are|you'?re|are you) (?:an? )?(?:ai|a\.i\.|bot|chatbot|robot|"
    r"language model|artificial)\b",
    r"\bartificial intelligence (?:model|assistant)\b|\bai (?:assistant|model|agent)\b",
    r"\bsimulat\w+\b|\brole-?play(?:ing)?\b|\bthis test\b|\bthe test\b|\btest (?:call|scenario)\b",
    r"\bpersona\b|\bprompts?\b|\bmy instructions\b|\binstructions? (?:say|tell|state)\b",
    r"\bchristy\b",
)
_INTERVIEWER_SECRET = _ci(r"\$\s?7,?000\b", r"\bobjections?\b", r"\bhidden needs?\b")
_FEEDBACK = _ci(
    r"\byou did (?:well|great|good|fine|poorly|badly)\b",
    r"\b(?:well|good|great|nice|excellent) (?:done|job|work)\b",
    r"\byour (?:score|performance|rating|result)s?\b",
    r"\byou (?:scored|handled|missed|passed|failed|cleared)\b",
    r"\byou were (?:good|great|strong|weak|excellent|impressive)\b",
    r"\b(?:strong|weak|good|great) candidate\b|\bareas? (?:to|for|of) improv\w+\b",
    r"\bfeedback\b|\byou (?:should|could) have\b|\bimpressed\b",
    r"\b(?:not|n't) (?:a )?(?:good )?fit\b",
)
# An outcome, or a pay figure, is never the interviewer's to state.
_HIRING_ALWAYS = _ci(
    r"\byou(?:'re| are) (?:hired|selected|shortlisted|through|moving forward)\b",
    r"\b(?:the )?job is yours\b|\boffer letter\b|\bcongratulations\b",
    r"\b(?:we|i)(?:'ll| will) (?:make you an offer|hire you|move you forward|call you for)\b",
    r"\byou(?:'ll| will) (?:get|receive) (?:the )?(?:job|offer)\b",
    r"\bsalar(?:y|ies)\b|\bctc\b|\blpa\b|\blakhs?\b|\bstipend\b|\bcompensation\b",
    r"\b(?:competitive|compensation|salary|benefits?|pay|attractive|good|great) package\b",
    r"\bpay ?(?:scale|range|band|grade)\b|\bvariable pay\b|\bper annum\b",
)
# Incentives, work mode and next-step timelines are only a leak when the interviewer
# states them about THIS role, the future or an offer.  The same words are the candidate's
# own history in the icebreaker ("so you hit your targets and earned strong incentives",
# "you relocated for that role", "you ramped up within a few weeks"), which must pass.
_HIRING_ROLE_TERMS = _ci(
    r"\bincentives?\b|\bcommissions?\b|\bbonus(?:es)?\b|\bannual(?:ly)?\b",
    r"\b(?:remote|hybrid|work from home|wfh|on-?site|in-?office|office-based|relocat\w+)\b",
    r"\b(?:within|in|after|by) (?:the next |about |around )?(?:\d+|one|two|three|four|five|"
    r"a few|few|several) (?:business |working )?(?:days?|weeks?)\b",
    r"\bby (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|"
    r"end of (?:the )?(?:day|week|month))\b|\bnext week\b|\bthis week\b",
)
_ABOUT_THE_ROLE_OR_FUTURE = _ci(
    r"\b(?:we|our|ours|us|we'?re|we'?ve)\b",
    r"\bi(?:'ll| will)\b|\byou(?:'ll| will| would| shall)\b",
    r"\byou (?:can|could|should|may) (?:expect|hear|get|receive)\b",
    r"\bthere (?:is|are|will be|'s)\b",
    r"\bthis (?:role|position|job|opening|vacancy|package|offer|team|company)\b",
    r"\bthe (?:role|position|job|offer|package) (?:is|will|has|comes|offers|pays|involves)\b",
    r"\b(?:it|this|that)(?:'s| is) (?:a|an)\b[^.?!]{0,25}\b(?:role|position|job|opening)\b",
    r"\b(?:it|the role|the job) (?:pays|comes with|includes|offers)\b",
)
# Questions about the CANDIDATE's own protected characteristics.  The bare words are
# everyday sales vocabulary ("convince parents to enrol their children", "sold health
# insurance"), so each pattern names the candidate ("how old are you", "your religion",
# "do you have kids"), never the topic alone.
_PROTECTED = _ci(
    r"\bhow old (?:are|were) you\b|\byour (?:age|age group|date of birth)\b|\bwhat'?s your age\b",
    r"\b(?:are|were) you (?:\w+ )?(?:married|single|divorced|engaged|pregnant|expecting)\b"
    r"|\bmarital status\b|\bpregnan\w+\b",
    r"\bdo you (?:have|plan to have|want) (?:any )?(?:kids|children|a family|dependents?)\b"
    r"|\bhow many (?:kids|children)\b|\bplan(?:ning)? (?:on )?(?:having )?(?:a family|kids)\b",
    r"\byour (?:spouse|husband|wife|kids|children)\b",
    r"\byour (?:religio\w+|caste|ethnic\w*|race|nationality|visa status|community)\b"
    r"|\b(?:what|which) (?:religio\w+|caste|community|ethnic\w*|nationality)\b",
    r"\byour (?:health|medical (?:condition|history|issues?|status))\b(?!\s+(?:insurance|care|"
    r"tech|products?|plans?|sector|industry|domain|business|startup|apps?|vertical|segment|"
    r"devices?|equipment|sales|clients?|accounts?|portfolio|territory))"
    r"|\bany (?:health|medical) (?:issues?|conditions?|problems?|concerns?)\b"
    r"|\bdo you have (?:a |any )?(?:disabilit\w+|illness\w*|chronic\w*)\b|\bare you disabled\b",
)
# The interviewer ANNOUNCING the role-play in the getting-to-know-you part.  A statement that
# looks forward ("let's move into the role-play", "we'll start the role play", "I'll play a
# prospective learner") is the driver's job, never the model's.  Repeating the candidate's own
# history ("you ran role-plays for new hires") has no such marker and passes, as does any
# question.
_ROLEPLAY_WORD = r"role[- ]?play(?:s|ing|ed)?"
_ROLEPLAY_ANNOUNCE = _ci(
    r"\b(?:let'?s|let us|shall we|we\b|i(?:'ll| will|'m going to| am going to)|"
    r"time (?:to|for)|ready (?:to|for)|about to|"
    r"(?:move|moving|switch|switching|go|going|jump|jumping|dive|diving|get|getting|start|"
    r"starting|begin|beginning|proceed|proceeding) (?:on )?(?:in)?to)\b[^.?!]{0,60}\b"
    + _ROLEPLAY_WORD
    + r"\b",
    r"\bi(?:'ll| will|'m going to| am going to)\b[^.?!]{0,30}\bplay(?:ing)?\b[^.?!]{0,25}"
    r"\b(?:learner|student|prospect|lead|customer)\b",
)
_ROLE_CONTEXT = _ci(
    r"\b(?:(?:this|the) role(?!-)|our shifts?|the shifts?|shift timings?|working days|"
    r"you(?:'ll| will) (?:work|be working)|we work)\b"
)
_TIME_OF_DAY = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", re.IGNORECASE)
_ALLOWED_TIMES = frozenset({(10, 0, "pm"), (8, 0, "am"), (3, 30, "am")})
_SPELLED = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "fifteen": 15,
    "twenty": 20,
}
_UNIT_NUMBER = r"(\d+(?:\.\d+)?|" + "|".join(_SPELLED) + r")(?:-|\s)*"
_HOURS_UNIT = re.compile(r"\b" + _UNIT_NUMBER + r"hours?\b", re.IGNORECASE)
_DAYS_UNIT = re.compile(r"\b" + _UNIT_NUMBER + r"days?\b", re.IGNORECASE)
_ALLOWED_HOURS = frozenset({10.0, 4.5})
_ALLOWED_DAYS = frozenset({5.5})

_CONCESSION = _ci(
    r"\bconvinc",
    r"that (?:resolves|settles|addresses)",
    r"(?:resolves|addresses) my (?:concern|worry|question)",
    r"no (?:more|other) (?:concerns|worries)",
    r"i'?m (?:sold|on board)",
    r"(?:price|cost|\$ ?9,?000) (?:is|'s|sounds) (?:fine|okay|ok|reasonable|fair|worth it)",
    r"(?<!whether )(?<!if )\b(?:it'?s|that'?s|it is|that is|sounds|seems) "
    r"(?:definitely |totally |really )?worth (?:it|every penny|the money|the price)",
    r"you'?ve (?:answered|addressed) (?:all|everything)",
    r"\bsounds like a deal\b|\bi'?ll take it\b(?!\s+from)|\bi accept\b",
)
_OPINION = _ci(
    r"\b(?:is|are|sounds?|seems?|looks?) (?:really |very |quite |pretty |so |super )?"
    r"(?:impressive|good|great|solid|interesting|helpful|expensive|steep|pricey|appealing|"
    r"nice|intense|comprehensive|broad|a lot|too much)\b",
    # Evaluative predicates about the learner's own situation are doubt or opinion, not a
    # product fact: "the course is right for me", "this program is a big decision for me".
    r"\b(?:is|are|sounds?|seems?|feels?) (?:really |just |not |still |kind of |a bit |quite )*"
    r"(?:right|the right|a (?:good |great |bad |better )?fit|for me|a (?:big|huge|major|tough|"
    r"hard|serious) (?:decision|commitment|investment|step|ask)|worth (?:considering|a look))\b",
)
_FORMAT_FACT = _ci(
    r"^(?:i think |i believe |i heard |i guess )?(?:it'?s |it is |they'?re |they are |"
    r"(?:the )?classes are |(?:the )?sessions are |the (?:course|program) is )?"
    r"(?:mostly |all |fully |partly |usually |entirely )?(?:live|recorded)\b",
    r"\blive (?:sessions|classes) (?:plus|with|and) record",
    r"\b(?:classes|sessions|lectures)\b[^.?!]{0,30}\b(?:evenings?|weekends?|weekdays?|"
    r"mornings?)\b",
    r"\b(?:it|the course|the program)\b[^.?!]{0,20}\b(?:takes|needs|requires)\b[^.?!]{0,15}"
    r"\b\d+\s*(?:-|to)?\s*\d*\s*hours?\b",
)
_NUM_WORD = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)"
_HOURS_A_WEEK = re.compile(
    rf"\b{_NUM_WORD}(?:\s*(?:-|to)\s*{_NUM_WORD})?\s*hours?\s*(?:a|per|each|every)\s*"
    r"(?:week|day)\b",
    re.IGNORECASE,
)
_CARD_NOUNS = frozenset({"course", "program", "programme", "bootcamp"})
# Words before a product subject that make the clause a wish, a doubt or an indirect question and
# not a claim (R1-Q iteration 3): "I'd still want to know how much time the mentors give you each
# week", "knowing whether the classes are live or recorded would help".
_NOT_ASSERTED = re.compile(
    r"\b(?:whether|if|know|knowing|wonder|wondering|curious|ask|asking|see|check|understand|"
    r"clarify|find out|figure out|depends on|sure|unsure|unclear|how|what|which|why|when|where)\b",
    re.IGNORECASE,
)
_PRODUCT_SUBJECT = _ci(
    r"\b(?:the|this|your|that) (?P<noun>course|program|programme|curriculum|classes|"
    r"instructors|mentors?|bootcamp|cohort|capstone|certificate)"
    r"(?:'s\b|\s+(?:\w+\s+){0,3}?(?:is|are|has|have|includes?|covers?|offers?|provides?|"
    r"gives?|gets?|teach(?:es)?|costs?|takes?|runs?|lasts?|comes? with|focus(?:es)?|"
    r"starts?|meets?|happens?)\b)"
)
_CLAIM_WORDS = _ci(
    r"\bguarantee\w*\b",
    r"\bplacements?\b",
    r"\brefunds?\b",
    r"\bsuccess rate\b",
    r"\b\d+\s?% (?:of )?(?:students|learners|graduates)\b",
    r"\bmoney[- ]back\b",
    r"\bfree trial\b",
    r"\b\d{1,2}\s?%\s*(?:off|discount)\b",
)
_CARD_AMOUNTS = frozenset({9000, 7000, 500, 700})
_CARD_DURATION = _ci(r"\b(?:6|six) months\b")
_ACK_WORDS = _ci(
    r"\b(?:course|program|programme|curriculum|class(?:es)?|price|cost|discount|schedule|"
    r"hours?|weeks?|months?|projects?|cohort|capstone|instructors?|mentors?|live|"
    r"recorded|format|evenings?|weekends?|weekdays?|mornings?|nights?|budget|money|"
    r"loans?|instal?lments?|kids|children|husband|wife|family)\b"
)


@dataclass(frozen=True)
class Hit:
    """One guard hit: what fired and a digest, never the utterance itself by default.

    Plan section 9 forbids logging utterances, so ``excerpt`` is empty unless the context
    opts in (``GuardContext.keep_excerpts``, meant for staff dry runs and offline
    replay).  ``digest`` (12 hex characters of the normalised sentence) lets repeated
    hits be correlated without keeping any text.
    """

    category: str
    rule: str
    excerpt: str
    digest: str = ""

    @property
    def log_key(self) -> str:
        return f"r1_guard_{self.category}"


@dataclass(frozen=True)
class GuardContext:
    """Everything the guard needs to know about the moment a sentence is produced."""

    phase: str
    persona: RenderedPersona | None = None
    candidate_first_name: str = ""
    released_topics: frozenset[str] = frozenset()
    advisor_amounts: frozenset[int] = frozenset()
    mode: str = "reply"
    commitment_cap: Level = Level.WEAK
    turn: int = 0
    control_texts: tuple[str, ...] = ()
    keep_excerpts: bool = False
    # Learner repetition control.  ``said`` is the normalised sentences the learner has
    # already played (``r1_text.SpokenMemory.snapshot``); ``seed`` and ``variant`` pick which
    # fallback variant to speak (the attempt id, and how many fallbacks were used so far).
    said: tuple[str, ...] = ()
    seed: str = ""
    variant: int = 0
    # An INTENT reply (R1-Q) has its own scripted fallback, appended by the session when the
    # model's reply misses the move's markers: a reply with nothing usable left stays EMPTY
    # instead of becoming "Sorry, what were you saying?" in front of that line.
    quiet_empty: bool = False
    # Topics whose deep need was already told (a later mention is dropped, not swapped for the
    # surface answer), and whether the advisor only said they would check or try on the price.
    spent_topics: frozenset[str] = frozenset()
    nothing_granted: bool = False
    # How the learner's last replies opened and which tic words they held (oldest first):
    # ``(opener, tics)`` pairs from ``r1_text.reply_opener`` / ``reply_tics``.
    recent_styles: tuple[tuple[str, tuple[str, ...]], ...] = ()
    # The commitment is on record: the reply only confirms it, so a question or a doubt is dropped.
    confirm: bool = False
    # The best price the advisor has put on the table (None: none); "$7,000, better than I
    # expected" is a misreading unless it is at or below $7,000.
    offer_usd: int | None = None
    # R1-Q iteration 2.  Whether each of the learner's last replies held a question (oldest first),
    # how often each tracked phrase tic was already used in the call (``(key, count)`` pairs, see
    # ``r1_text.reply_phrases``), whether this is a free reply (the question diet applies; an
    # intent reply is built around a question of its own), the hours-a-week figures the advisor
    # said (the learner may repeat them), and whether the advisor ever gave a monthly figure.
    recent_questions: tuple[bool, ...] = ()
    phrase_counts: tuple[tuple[str, int], ...] = ()
    free_reply: bool = False
    advisor_hours: frozenset[float] = frozenset()
    monthly_stated: bool = False
    # R1-Q iteration 3.  The advisor's turn put a LOWER price on the table than any before it ("a
    # bit better" is only true then); the advisor said (almost) nothing after the learner's last
    # goodbye (a second goodbye is dropped); the advisor asked who else decides (the answer is
    # never dropped as a repeat).
    fresh_price: bool = False
    hollow: bool = False
    decider_asked: bool = False

    @property
    def is_learner(self) -> bool:
        return self.phase == LEARNER_PHASE

    @property
    def word_cap(self) -> int | None:
        if not self.is_learner:
            return None
        return ACK_WORD_CAP if self.mode == "ack" else REPLY_WORD_CAP


@dataclass(frozen=True)
class GuardResult:
    """The vetted text and what was found.  ``text`` is always safe to speak."""

    text: str
    hits: tuple[Hit, ...]
    replaced: bool
    fallback_used: bool
    truncated: bool = False
    style_edits: int = 0

    @property
    def clean(self) -> bool:
        return not self.hits


@dataclass
class GuardLedger:
    """Session counters: three or more LEAK hits flag the session for HR and fail fidelity.

    ``ack_format`` hits are hygiene, not leaks: the acknowledgement guard drops any
    sentence that carries a digit or product word, and that is how a benign paraphrase of
    a card answer ("Money's a bit tight, honestly.") gets removed.  Counting them would
    flag one conversation in four as having broken character for nothing a candidate or
    HR could see (S0-B defect 7 again).  ``repeat`` hits (a sentence the learner already
    said) are hygiene for the same reason.  They are still counted and reported separately.
    """

    counts: dict[str, int] = field(default_factory=dict)
    total: int = 0
    leak_total: int = 0
    style_edits: int = 0

    def record(self, result: GuardResult) -> None:
        self.style_edits += result.style_edits
        for hit in result.hits:
            self.counts[hit.category] = self.counts.get(hit.category, 0) + 1
            self.total += 1
            if hit.category in LEAK_CATEGORIES:
                self.leak_total += 1

    @property
    def flagged(self) -> bool:
        return self.leak_total >= HIT_FLAG_THRESHOLD

    def summary(self) -> dict[str, object]:
        return {
            "hits": self.total,
            "leak_hits": self.leak_total,
            "hygiene_hits": self.total - self.leak_total,
            "by_category": dict(self.counts),
            "flagged": self.flagged,
            # Filler words and repeated openers the style rules took out (counts only).
            "style_edits": self.style_edits,
        }


def _hit(category: str, rule: str, sentence: str) -> Hit:
    return Hit(category, rule, mask_contact(sentence, 60))


def _persona_name_pattern(candidate_first_name: str) -> re.Pattern[str] | None:
    own = (candidate_first_name or "").strip().lower()
    names = sorted(
        {
            name
            for persona in PERSONAS
            for variant in persona.variants
            for name in (variant.first_name, variant.full_name)
            if name.split()[0].lower() != own
        },
        key=len,
        reverse=True,
    )
    if not names:
        return None
    return re.compile(r"\b(?:" + "|".join(re.escape(name) for name in names) + r")\b", re.I)


_NAME_PATTERN_CACHE: dict[str, re.Pattern[str] | None] = {}


def _names(candidate_first_name: str) -> re.Pattern[str] | None:
    key = (candidate_first_name or "").strip().lower()
    if key not in _NAME_PATTERN_CACHE:
        _NAME_PATTERN_CACHE[key] = _persona_name_pattern(key)
    return _NAME_PATTERN_CACHE[key]


_ECHO_TOKEN = re.compile(r"[a-z0-9']+")
ECHO_RUN_WORDS = 6


@functools.lru_cache(maxsize=64)
def _echo_windows(control_texts: tuple[str, ...]) -> frozenset[tuple[str, ...]]:
    windows: set[tuple[str, ...]] = set()
    for text in control_texts:
        tokens = _ECHO_TOKEN.findall(fold(text).lower())
        for index in range(len(tokens) - ECHO_RUN_WORDS + 1):
            windows.add(tuple(tokens[index : index + ECHO_RUN_WORDS]))
    return frozenset(windows)


def echo_detected(sentence: object, control_texts: tuple[str, ...]) -> bool:
    """True when ``sentence`` repeats six consecutive words of a private control text.

    Copied from the phone lane's ``phone_instruction_echo_detected`` (copied, not
    imported: the phone lane is untouchable).  Callers pass only INSTRUCTION prose, never
    the words the model is meant to speak, so a legitimate verbatim answer is not a leak.
    """
    if not control_texts:
        return False
    spoken = _ECHO_TOKEN.findall(fold(sentence).lower())
    if len(spoken) < ECHO_RUN_WORDS:
        return False
    windows = _echo_windows(tuple(control_texts))
    return any(
        tuple(spoken[index : index + ECHO_RUN_WORDS]) in windows
        for index in range(len(spoken) - ECHO_RUN_WORDS + 1)
    )


def _shared_hits(sentence: str, ctx: GuardContext) -> list[Hit]:
    hits: list[Hit] = []
    if echo_detected(sentence, ctx.control_texts):
        hits.append(_hit(CONTROL, "instruction_echo", sentence))
    if _CONTROL_TOKEN.search(sentence) or _CONTROL_PHRASE.search(sentence):
        hits.append(_hit(CONTROL, "control_vocabulary", sentence))
    if _VENDOR.search(sentence):
        hits.append(_hit(VENDOR, "vendor_name", sentence))
    evaluation = _EVALUATION_LEAK if ctx.phase in SMALL_TALK_PHASES else _EVALUATION
    if evaluation.search(sentence):
        hits.append(_hit(EVALUATION, "scoring_vocabulary", sentence))
    if has_contact_detail(sentence):
        hits.append(_hit(CONTACT, "contact_detail", sentence))
    if fuzzy_contains(sentence, EXIT_CUE, 0.9) and word_count(sentence) <= 12:
        hits.append(_hit(SCRIPTED_CUE, "exit_line_imitation", sentence))
    return hits


def _interviewer_hits(sentence: str, ctx: GuardContext) -> list[Hit]:
    hits: list[Hit] = []
    if ctx.phase in PERSONA_REVEALED_PHASES:
        names = _names(ctx.candidate_first_name)
        if (names and names.search(sentence)) or _INTERVIEWER_SECRET.search(sentence):
            hits.append(_hit(PERSONA_SECRET, "persona_vocabulary", sentence))
        elif ctx.persona is not None:
            for topic in H_TOPICS:
                if any(pattern.search(sentence) for pattern in ctx.persona.markers(topic)):
                    hits.append(_hit(PERSONA_SECRET, f"deep_need_{topic}", sentence))
                    break
    if ctx.phase in FEEDBACK_PHASES and _FEEDBACK.search(sentence):
        hits.append(_hit(FEEDBACK, "feedback_phrasing", sentence))
    question = is_question_like(sentence)
    # Only STATEMENTS assert a hiring, pay, work-mode or timeline fact; a question such as
    # "Have you worked in a hybrid team?" asks about the candidate's own experience.
    if not question and _states_hiring_or_pay(sentence):
        hits.append(_hit(HIRING_COMP, "hiring_or_compensation", sentence))
    elif not question and _unapproved_role_fact(sentence):
        hits.append(_hit(INVENTED_FACT, "role_fact_beyond_deck", sentence))
    if question and _PROTECTED.search(sentence):
        hits.append(_hit(PROTECTED_QUESTION, "protected_class", sentence))
    if ctx.phase in SMALL_TALK_PHASES and not question and _ROLEPLAY_ANNOUNCE.search(sentence):
        hits.append(_hit(SCRIPTED_CUE, "roleplay_announcement", sentence))
    return hits


def _states_hiring_or_pay(sentence: str) -> bool:
    """An outcome or pay figure, or an incentive, work-mode or timeline claim about the role.

    The second kind needs a cue that the sentence is about THIS role, the future or an
    offer (``_ABOUT_THE_ROLE_OR_FUTURE``); without one it is the candidate's own past.
    """
    if _HIRING_ALWAYS.search(sentence):
        return True
    return bool(
        _HIRING_ROLE_TERMS.search(sentence) and _ABOUT_THE_ROLE_OR_FUTURE.search(sentence)
    )


def _unapproved_role_fact(sentence: str) -> bool:
    """A shift time, hours or day count for THIS role that the deck does not state.

    Only sentences that describe the role's own shift are checked, so a candidate's
    "12-hour shifts" at a previous job can be repeated back without a false positive.
    """
    if not _ROLE_CONTEXT.search(sentence):
        return False
    for match in _TIME_OF_DAY.finditer(sentence):
        key = (int(match.group(1)), int(match.group(2) or 0), match.group(3).lower())
        if key not in _ALLOWED_TIMES:
            return True
    for match in _HOURS_UNIT.finditer(sentence):
        if _number_value(match.group(1)) not in _ALLOWED_HOURS:
            return True
    for match in _DAYS_UNIT.finditer(sentence):
        if _number_value(match.group(1)) not in _ALLOWED_DAYS:
            return True
    return False


def _number_value(token: str) -> float:
    """A digit string or a spelled-out number (one to twenty) as a float; -1 if unknown."""
    lowered = token.lower()
    if lowered in _SPELLED:
        return float(_SPELLED[lowered])
    try:
        return float(lowered)
    except ValueError:
        return -1.0


def _card_fact_only(sentence: str, allowed: frozenset[int]) -> bool:
    """True when every number in ``sentence`` is a public-card fact (9,000 / six months)."""
    amounts = dollar_amounts(sentence)
    if any(amount not in allowed for amount in amounts):
        return False
    without = _CARD_DURATION.sub(" ", sentence)
    without = re.sub(r"\$\s?[\d,]+(?:\.\d+)?\s*k?", " ", without)
    return not re.search(r"\d", without) and bool(amounts or _CARD_DURATION.search(sentence))


def _is_product_statement(sentence: str, allowed: frozenset[int]) -> bool:
    """A declarative about the product.  Only the website's price and duration pass.

    "The course is around $9,000" and "about six months" are on the card.  Any other
    subject (capstone, classes, instructors, cohort ...) or any other number is a fact
    the learner must not assert, even when it happens to agree with the deck.
    """
    match = _PRODUCT_SUBJECT.search(sentence)
    if match is None or _OPINION.search(sentence):
        return False
    if match.group("noun").lower() in _CARD_NOUNS and _card_fact_only(sentence, allowed):
        return False
    if _NOT_ASSERTED.search(clause_before(sentence, match.start())) is not None:
        return False  # "knowing whether the classes are live would help": a wish, not a claim
    return True


def hours_said(text: object) -> frozenset[float]:
    """The hours-a-week figures in ``text`` ("ten to fifteen hours a week" -> {10.0, 15.0})."""
    figures: set[float] = set()
    for match in _HOURS_A_WEEK.finditer(fold(text)):
        for token in re.findall(r"\d+(?:\.\d+)?|[a-z]+", match.group(0).lower()):
            value = _number_value(token)
            if value > 0:
                figures.add(value)
    return frozenset(figures)


def _hours_are_advisors(sentence: str, ctx: GuardContext) -> bool:
    """Every hours figure in ``sentence`` is one the advisor said ("Ten hours a week is ...")."""
    figures = hours_said(sentence)
    return bool(figures) and figures <= ctx.advisor_hours


# Spelled-out amounts ("six hundred a month") are only money next to a money word: "a hundred
# applications" is not an amount.
_MONEY_CUE = re.compile(
    r"\b(?:price|prices|cost|costs|pay|paying|paid|budget|afford|per month|a month|monthly|fee|"
    r"fees|dollars|bucks|discount|total|spend|spending|instal\w+)\b",
    re.IGNORECASE,
)


# "a few hundred a month" / "a couple of thousand" name no amount: the persona's own budget
# answer is "around $500-700 a month", and a vague quantity of hundreds is the same thing said
# loosely (R1-Q iteration 3: the sentence was dropped as an amount off the card, and the H3 need
# with it).
_VAGUE_QUANTITY = re.compile(
    r"\b(?:a few|a couple of|couple of|several|some|a handful of|many|a lot of) "
    r"(?:hundred|thousand)\b",
    re.IGNORECASE,
)


def _amounts_spoken(sentence: str) -> list[int]:
    """Whole-dollar amounts in ``sentence``, written or (next to a money word) spelled out."""
    sentence = _VAGUE_QUANTITY.sub(" ", sentence)
    if _MONEY_CUE.search(sentence):
        return dollar_amounts(canonical_amounts(sentence))
    return dollar_amounts(sentence)


# The R1-Q iteration 2 misread rules read ordinary spoken sentences only (a learner sentence is
# 45 words at most): a runaway sentence skips them, which also bounds their cost on hostile text.
MISREAD_MAX_CHARS = 1200


def _iteration_two_misreads(sentence: str, ctx: GuardContext, question: bool) -> list[Hit]:
    """Misreadings the second live sweep found (hygiene hits: never posted, never a leak)."""
    hits: list[Hit] = []
    if ctx.persona is not None and _DECIDER_UNWILLING.search(sentence) is not None:
        hits.append(_hit(MISREAD, "decider_unwilling", sentence))
    if _HEARSAY.search(sentence) is not None:
        # The $9,000 is on the website, so "I heard it is about $9,000" is the card, not hearsay.
        prices = [
            value
            for value in dollar_amounts(canonical_amounts(sentence))
            if value >= 4500 and value != 9000
        ]
        if prices and 7000 not in prices:
            hits.append(_hit(MISREAD, "heard_not_anchor", sentence))
    if (
        ctx.offer_usd is not None
        and ctx.offer_usd <= 7000
        and _PRICE_STRAIN.search(sentence) is not None
        and _TIME_TOPIC.search(sentence) is None
    ):
        hits.append(_hit(MISREAD, "strain_after_met", sentence))
    if (
        not ctx.monthly_stated
        and not question
        and _MONTHLY_REACTION.search(sentence) is not None
        and _STRAIN_PRICE_WORDS.search(sentence) is not None
        and re.search(r"\b(?:500|700)\b", sentence) is None
    ):
        hits.append(_hit(MISREAD, "monthly_unstated", sentence))
    return hits


# A sentence that keeps the agreed plan while it turns down a fresh push ("I'll still talk it
# through with him first, but I'm looking forward to tomorrow", "I'd rather talk to my husband
# before I pay anything") is not a doubt about the booked call, and without it a reply to "why
# not just grab it now?" is "That would be good to know, thanks." (R1-Q iteration 3).
_HOLDS_THE_PLAN = re.compile(
    r"\b(?:talk|speak|run|discuss)\w*\b[^.?!]{0,30}\b(?:with|to|by)?\s*(?:him|her|them|my "
    r"(?:husband|wife|partner|father|mother|dad|mom|spouse|parents|family))\b[^.?!]{0,20}"
    r"\b(?:first|before)\b"
    r"|\bwait (?:until|for|till) (?:the|our) call\b"
    r"|\b(?:stick|sticking) (?:with|to) (?:the|our) (?:plan|call)\b",
    re.IGNORECASE,
)


def _reopens(sentence: str) -> bool:
    """A doubt that reopens what was agreed (``_DOUBT``), unless it holds the plan."""
    return _DOUBT.search(sentence) is not None and _HOLDS_THE_PLAN.search(sentence) is None


def _iteration_three_misreads(sentence: str, ctx: GuardContext) -> list[Hit]:
    """Misreadings the third live sweep found (hygiene hits: never posted, never a leak)."""
    hits: list[Hit] = []
    if (
        not ctx.fresh_price
        and _NOT_ABOUT_PRICE.search(sentence) is None
        and (
            _BETTER_PRICE.search(sentence) is not None
            or (
                _BETTER_THAN.search(sentence) is not None
                and _PRICE_WORD.search(sentence) is not None
            )
        )
    ):
        hits.append(_hit(MISREAD, "better_unchanged", sentence))
    if ctx.offer_usd != 7000 and _HEARD_IN_LINE.search(sentence) is not None:
        hits.append(_hit(MISREAD, "heard_in_line", sentence))
    if ctx.hollow and CLOSER.search(sentence) is not None:
        hits.append(_hit(MISREAD, "closer_again", sentence))
    if _I_CALLED.search(sentence) is not None:
        hits.append(_hit(MISREAD, "learner_called", sentence))
    return hits


def _learner_hits(sentence: str, ctx: GuardContext) -> list[Hit]:
    hits: list[Hit] = []
    if _LEARNER_META.search(sentence):
        hits.append(_hit(META, "learner_meta", sentence))
    persona = ctx.persona
    if persona is not None:
        for topic in H_TOPICS:
            if topic in ctx.released_topics:
                continue
            if any(pattern.search(sentence) for pattern in persona.markers(topic)):
                hits.append(_hit(VOLUNTEERED_NEED, topic, sentence))
                break
    level = classify_learner_commitment(sentence)
    if level > ctx.commitment_cap:
        hits.append(_hit(COMMITMENT, f"level_{level.name.lower()}", sentence))
    if has_concession(sentence):
        hits.append(_hit(CONCESSION, "resolution_phrasing", sentence))
    question = is_question_like(sentence)
    allowed = _CARD_AMOUNTS | ctx.advisor_amounts
    if not question:
        if _FORMAT_FACT.search(sentence):
            hits.append(_hit(INVENTED_FACT, "format_or_schedule_claim", sentence))
        elif _is_product_statement(sentence, allowed):
            hits.append(_hit(INVENTED_FACT, "product_statement", sentence))
        elif _CLAIM_WORDS.search(sentence):
            hits.append(_hit(INVENTED_FACT, "outcome_or_policy_claim", sentence))
    if _HOURS_A_WEEK.search(sentence) and not question and not _hours_are_advisors(sentence, ctx):
        hits.append(_hit(INVENTED_FACT, "own_availability_figure", sentence))
    elif any(amount not in allowed for amount in _amounts_spoken(sentence)):
        hits.append(_hit(INVENTED_FACT, "amount_off_card", sentence))
    if ctx.confirm and (question or _reopens(sentence)):
        hits.append(_hit(REOPEN, "confirm_only", sentence))
    if _TIME_REVERSAL.search(sentence) is not None:
        hits.append(_hit(MISREAD, "time_cue_reversed", sentence))
    if persona is not None and _DECIDES_ALONE.search(sentence) is not None:
        hits.append(_hit(MISREAD, "decider_alone", sentence))
    if len(sentence) <= MISREAD_MAX_CHARS:
        hits.extend(_iteration_two_misreads(sentence, ctx, question))
    if ctx.nothing_granted and _GRANT_GRATITUDE.search(sentence) is not None:
        hits.append(_hit(MISREAD, "gratitude_for_nothing", sentence))
    if (
        (ctx.offer_usd is None or ctx.offer_usd > 7000)
        and _ANCHOR_REACTION.search(canonical_amounts(sentence)) is not None
    ):
        hits.append(_hit(MISREAD, "anchor_taken_as_offer", sentence))
    if len(sentence) <= MISREAD_MAX_CHARS and not any(hit.category == MISREAD for hit in hits):
        hits.extend(_iteration_three_misreads(sentence, ctx))  # one misreading per sentence
    if ctx.mode == "ack" and not _is_card_answer(sentence, persona):
        if question:
            hits.append(_hit(ACK_FORMAT, "ack_question", sentence))
        elif re.search(r"\d", sentence) or _ACK_WORDS.search(sentence):
            hits.append(_hit(ACK_FORMAT, "ack_fact_vocabulary", sentence))
    return hits


CARD_MATCH_THRESHOLD = 0.75
# The scripted WEAK line, on normalised text (apostrophes dropped).
_RESERVED_WEAK_LINE = re.compile(
    r"\blet me think about it\b|\bemail me the details\b|\bcall me back after ive talked\b"
    r"|\bread through the email and ill get back to you\b"
)
_POSSESSIVE = re.compile(r"(?<=\w)'s\b")
_DIGITS = re.compile(r"\d+")


def _is_card_answer(sentence: str, persona: RenderedPersona | None) -> bool:
    """True when ``sentence`` is one of the persona's card answers, or a close paraphrase.

    An acknowledgement may carry no facts, but the card's answers ("Around $500-700 a
    month.", "My schedule is pretty packed.", the deflection) are exactly what the
    advisor is allowed to hear, so they pass the acknowledgement vocabulary check.  So
    does a paraphrase that keeps to the card: it contains the answer's content words in
    order (``CARD_MATCH_THRESHOLD``) and adds no digit and no product word the answer does
    not already have ("My schedule's pretty packed, honestly.", "Within a couple of
    weeks, ideally.").  A question is never a card answer unless it is one word for word.
    """
    if persona is None:
        return False
    if normalize(sentence) in _card_answers(persona):
        return True
    if is_question_like(sentence):
        return False
    plain = _POSSESSIVE.sub("", sentence)  # "schedule's" -> "schedule"
    digits = set(_DIGITS.findall(plain))
    vocabulary = {match.group(0).lower() for match in _ACK_WORDS.finditer(plain)}
    for answer, answer_digits, answer_vocabulary in _card_answer_forms(persona):
        if (
            digits <= answer_digits
            and vocabulary <= answer_vocabulary
            and fuzzy_contains(plain, answer, CARD_MATCH_THRESHOLD)
        ):
            return True
    return False


def _card_texts(persona: RenderedPersona) -> list[str]:
    answers = [answer for _, answer in PUBLIC_ANSWERS]
    answers.append(persona.persona.prior_learning)
    answers.extend(persona.surface(topic) for topic in H_TOPICS)
    answers.append(persona.decider_answer)
    return answers


@functools.lru_cache(maxsize=64)
def _card_answers(persona: RenderedPersona) -> frozenset[str]:
    return frozenset(normalize(answer) for answer in _card_texts(persona))


@functools.lru_cache(maxsize=64)
def _card_answer_forms(
    persona: RenderedPersona,
) -> tuple[tuple[str, frozenset[str], frozenset[str]], ...]:
    """Each card answer with its possessive-folded text, its digits and its product words."""
    forms = []
    for answer in _card_texts(persona):
        plain = _POSSESSIVE.sub("", answer)
        forms.append(
            (
                plain,
                frozenset(_DIGITS.findall(plain)),
                frozenset(match.group(0).lower() for match in _ACK_WORDS.finditer(plain)),
            )
        )
    return tuple(forms)


def check_sentence(sentence: str, ctx: GuardContext) -> list[Hit]:
    """All hits for one sentence in ``ctx``.  Pure; does not change any state."""
    folded = fold(sentence)
    hits = _shared_hits(folded, ctx)
    if ctx.is_learner:
        hits.extend(_learner_hits(folded, ctx))
    else:
        hits.extend(_interviewer_hits(folded, ctx))
    if not hits:
        return hits
    digest = hashlib.sha256(normalize(folded).encode("utf-8")).hexdigest()[:12]
    keep = ctx.keep_excerpts
    first_name = (ctx.candidate_first_name or "").strip()
    return [
        Hit(
            hit.category,
            hit.rule,
            _scrub_name(hit.excerpt, first_name) if keep else "",
            digest,
        )
        for hit in hits
    ]


def _scrub_name(text: str, first_name: str) -> str:
    """Mask the candidate's first name (the only candidate PII) in an opted-in excerpt."""
    if not first_name:
        return text
    return re.sub(re.escape(first_name), "[name]", text, flags=re.IGNORECASE)


def _without_unwilling_clause(sentence: str) -> str:
    """``sentence`` up to the clause that says the decision maker dislikes calls, or "".

    "I'd have to ask my father first, and he's not really one for these things." keeps its first
    half; a sentence that is nothing but the clause is dropped.
    """
    found = _DECIDER_UNWILLING.search(sentence)
    if found is None:
        return ""
    # The clause starts at the LAST subject inside the match ("... my father first, and he's not
    # really one for ..." matches from "my father"; the clause is "he's not really one for ...").
    subjects = list(re.finditer(r"\b" + _THIRD_PERSON + r"\b", found.group(0), re.IGNORECASE))
    start = found.start() + (subjects[-1].start() if subjects else 0)
    kept = re.sub(r"[\s,;-]*(?:and|but|though|so)?[\s,;-]*$", "", sentence[:start])
    if word_count(kept) < 3:
        return ""
    return kept + "."


def _heard_replacement(ctx: GuardContext) -> str:
    """What the learner says in place of hearsay about a figure that is not the $7,000 anchor."""
    offer = ctx.offer_usd
    if offer is not None and offer < 7000:
        return ANCHOR_HEARD_BELOW
    return ANCHOR_HEARD_REPLACEMENT


def _replacement(hits: list[Hit], ctx: GuardContext, sentence: str = "") -> str:
    """The line spoken in place of a blocked sentence, chosen by hit priority.

    Feedback wins over everything (the wrap-up always answers with L-NO-FEEDBACK), then
    the interviewer's deferral line, then the learner's surface answer or contact line.
    Anything else is simply dropped.
    """
    categories = {hit.category for hit in hits}
    if ctx.is_learner and ctx.mode == "ack":
        # An acknowledgement is a few neutral words: a blocked sentence is just dropped.
        return ""
    if FEEDBACK in categories:
        return NO_FEEDBACK_LINE
    if not ctx.is_learner and categories & {HIRING_COMP, INVENTED_FACT}:
        return INTERVIEWER_DEFLECTION
    if ctx.is_learner and ctx.persona is not None:
        need = next((hit for hit in hits if hit.category == VOLUNTEERED_NEED), None)
        if need is not None:
            return "" if need.rule in ctx.spent_topics else ctx.persona.surface(need.rule)
    if ctx.is_learner and CONTACT in categories:
        return CONTACT_REPLACEMENT
    if ctx.is_learner and MISREAD in categories:
        rule = next(hit.rule for hit in hits if hit.category == MISREAD)
        if rule == "anchor_taken_as_offer":
            return ANCHOR_REPLACEMENT
        if rule == "gratitude_for_nothing":
            return GRATITUDE_REPLACEMENT
        if rule == "decider_alone" and ctx.persona is not None:
            return ctx.persona.decider_answer
        if rule in ("heard_not_anchor", "heard_in_line"):
            return _heard_replacement(ctx)
        if rule == "decider_unwilling":
            return _without_unwilling_clause(sentence)
        if rule == "better_unchanged":
            at_ask = ctx.offer_usd is not None and ctx.offer_usd <= 7000
            return "" if at_ask else PRICE_UNCHANGED_REPLACEMENT
    return ""


def _fallback(ctx: GuardContext, *, only_repeats: bool = False) -> str:
    """The line spoken when a learner or interviewer reply had nothing left to say.

    ``only_repeats`` means every dropped sentence was one the learner already said: the
    answer has been given, so a neutral back-channel fits ("Mm-hmm.") and "Sorry, what were
    you saying?" would be wrong.  Otherwise the learner rotates through ``FALLBACK_REPLIES``
    from a point seeded by the attempt id, skipping any variant it already said, so the same
    apology is never spoken twice in a row.
    """
    if ctx.is_learner and (ctx.mode == "ack" or only_repeats):
        return NEUTRAL_ACKS[ctx.turn % len(NEUTRAL_ACKS)]
    if ctx.is_learner and ctx.confirm:
        for offset in range(len(CONFIRM_FALLBACKS)):
            candidate = pick_variant(CONFIRM_FALLBACKS, ctx.seed, ctx.variant + offset)
            if repeat_kind(candidate, ctx.said) is None:
                return candidate
        return pick_variant(CONFIRM_FALLBACKS, ctx.seed, ctx.variant)
    if ctx.is_learner:
        for offset in range(len(FALLBACK_REPLIES)):
            candidate = pick_variant(FALLBACK_REPLIES, ctx.seed, ctx.variant + offset)
            if repeat_kind(candidate, ctx.said) is None:
                return candidate
        return pick_variant(FALLBACK_REPLIES, ctx.seed, ctx.variant)
    return FALLBACK_REPLY


class StreamGuard:
    """Vet an LLM reply sentence by sentence, as it streams.

    ``feed`` takes text deltas and returns the sentences now complete and safe to speak;
    ``flush`` vets the remainder and, if nothing at all was emitted, returns the
    fallback.  A learner reply stops at its word cap.  ``result`` aggregates the hits.
    """

    def __init__(self, ctx: GuardContext) -> None:
        self.ctx = ctx
        self._buffer = ""
        self._emitted: list[str] = []
        self._hits: list[Hit] = []
        self._used = 0
        self._truncated = False
        self._replaced = False
        self._fallback_used = False
        self._replacements: set[str] = set()
        self._done = False
        self._repeat_drops = 0
        self._other_drops = 0
        self._reply_fillers = 0  # filler words already kept in this reply
        self._style_edits = 0
        self._questions_kept = 0  # question sentences already let through in this reply
        self._phrases_used: dict[str, int] = {}  # tracked phrases used so far in this reply
        self._last_dropped = False  # the sentence before this one was dropped

    def _phrase_count(self, key: str) -> int:
        """How often the tracked phrase ``key`` was used in the call so far (this reply too)."""
        return dict(self.ctx.phrase_counts).get(key, 0) + self._phrases_used.get(key, 0)

    def _drop_question(self, text: str) -> bool:
        """True when the question ``text`` must not be asked in this reply.

        A reply asks at most one question; the "what would it involve" template is asked once per
        call; and a free reply asks nothing when one of its last two replies already asked.  A
        question is never dropped while it is the only thing the reply has said, so a reply keeps
        its first sentence.
        """
        ctx = self.ctx
        if "?" not in text:
            # The model writes its questions with a question mark; "I see what you mean." and "I'd
            # like to know before I say yes." read as questions to ``is_question_like`` (a
            # speech-to-text rule) but are statements here.
            return False
        template = QUESTION_TEMPLATE.search(text) is not None
        if template and self._phrase_count(PHRASE_TEMPLATE_Q) >= PHRASE_QUOTA[PHRASE_TEMPLATE_Q]:
            self._repeat_drops += 1
            return True
        if self._questions_kept >= 1:
            return True
        if (
            ctx.free_reply
            and self._emitted
            and any(ctx.recent_questions[-QUESTION_DIET_WINDOW:])
            # "Okay." and the question is the whole reply: dropping the question would leave a bare
            # acknowledgement, so the question stays.
            and word_count(" ".join(self._emitted)) > THIN_REPLY_WORDS
            # A question about the price, asked before the advisor has put any price on the table,
            # always stays (R1-Q iteration 3: "what the total cost actually comes to?" was dropped).
            and not (ctx.offer_usd is None and _PRICE_QUESTION.search(text) is not None)
        ):
            return True
        self._questions_kept += 1
        if template:
            self._phrases_used[PHRASE_TEMPLATE_Q] = self._phrases_used.get(PHRASE_TEMPLATE_Q, 0) + 1
        return False

    def _repeat_hit(self, kind: str, sentence: str) -> Hit:
        """A ``repeat`` hit for ``sentence`` (digest always; excerpt only if opted in)."""
        folded = fold(sentence)
        digest = hashlib.sha256(normalize(folded).encode("utf-8")).hexdigest()[:12]
        excerpt = ""
        if self.ctx.keep_excerpts:
            excerpt = _scrub_name(mask_contact(folded, 60), self.ctx.candidate_first_name)
        return Hit(REPEAT, f"repeat_{kind}", excerpt, digest)

    def _repeated(self, out: str) -> Hit | None:
        """A hit when the learner already said ``out`` earlier in the call (``ctx.said``).

        Inside one reply only an identical sentence is dropped (silently, below): two
        sentences of a single reply that differ by a word are the model's own phrasing.  The
        two sentences of the scripted WEAK line ("Let me think about it." / "Just email me the
        details ...") are reserved for that line: the model saying them earlier would make the
        scripted line an exact repeat, or ask for the e-mail twice, so they are dropped as
        hygiene and the intent's own scripted variant is used instead.
        """
        if not self.ctx.is_learner:
            return None
        if _RESERVED_WEAK_LINE.search(normalize(out)):
            return self._repeat_hit("reserved", out)
        if not self.ctx.said:
            return None
        persona = self.ctx.persona
        if (
            self.ctx.decider_asked
            and persona is not None
            and re.search(r"\b" + re.escape(persona.decision_maker) + r"\b", out, re.IGNORECASE)
        ):
            return None  # the advisor asked who else decides: the same answer is the right answer
        kind = repeat_kind(out, self.ctx.said)
        return None if kind is None else self._repeat_hit(kind, out)

    def _tic_allowed(self, tic: str) -> bool:
        """A tic word may appear in at most one reply in five, and one filler per reply."""
        if self._reply_fillers >= 1:
            return False
        recent = self.ctx.recent_styles[-STYLE_TIC_WINDOW:]
        return not any(tic in tics for _opener, tics in recent)

    def _vary(self, sentence: str) -> str:
        """The sentence with its tic words, extra fillers and a repeated opener taken out.

        Only a learner reply is varied.  A sentence that would be left with fewer than two words
        keeps its filler (a bare "Hmm." becomes a neutral acknowledgement instead).
        """
        ctx = self.ctx
        if not ctx.is_learner or ctx.mode != "reply" or len(sentence) > STYLE_MAX_CHARS:
            return sentence
        text = sentence
        for tic, patterns in _TIC_STRIP.items():
            if TIC_PATTERNS[tic].search(text) is None:
                continue
            if self._tic_allowed(tic):
                self._reply_fillers += 1
                continue
            for pattern in patterns:
                text = pattern.sub(_filler_gap, text)
        text = self._single_filler(text)
        if self._reply_fillers >= 1:
            text = _INLINE_FILLER.sub(_filler_gap, text)
        if not self._emitted:
            text = self._vary_opener(text)
        if _BEFORE_I_GO.match(text) is not None:
            text = _BEFORE_I_GO.sub("", text, count=1)
        elif _INLINE_BEFORE_I_GO.search(text) is not None:
            text = _INLINE_BEFORE_I_GO.sub("", text)
        if STRETCH_PHRASE.search(text) is not None:
            used = self._phrase_count(PHRASE_STRETCH)
            if used >= PHRASE_QUOTA[PHRASE_STRETCH]:
                text = STRETCH_PHRASE.sub(
                    pick_variant(STRETCH_ALTERNATIVES, ctx.seed, ctx.turn), text
                )
            else:
                self._phrases_used[PHRASE_STRETCH] = self._phrases_used.get(PHRASE_STRETCH, 0) + 1
        if CONCESSION_TAG.search(text) is not None:
            if self._phrase_count(PHRASE_CONCESSION_TAG) >= PHRASE_QUOTA[PHRASE_CONCESSION_TAG]:
                text = _strip_concession_tag(text)
            else:
                key = PHRASE_CONCESSION_TAG
                self._phrases_used[key] = self._phrases_used.get(key, 0) + 1
        if text != sentence:
            text = _tidy(text)
            if text and text[0].islower():
                text = text[0].upper() + text[1:]
            if not re.search(r"[A-Za-z0-9]", text):
                text = NEUTRAL_ACKS[ctx.turn % len(NEUTRAL_ACKS)]
            self._style_edits += 1
        if self._drop_question(text):
            self._style_edits += 1
            return ""
        return text

    def _single_filler(self, text: str) -> str:
        """Keep the first filler word that opens ``text`` (if the reply has none), drop the rest.

        A tic word that is still here was allowed by ``_tic_allowed`` and is already counted; any
        other opening filler ("Well,", "Actually,") counts once and a second one is dropped, so
        "Hmm, well, ..." becomes "Hmm, ...".  A filler that is all there is of the sentence stays.
        """
        kept = ""
        while True:
            lead = _LEAD_FILLER.match(text)
            if lead is None or word_count(text[lead.end() :]) < 2:
                return kept + text
            if _is_tic_word(lead.group(0)):
                kept += lead.group(0)
            elif self._reply_fillers == 0:
                self._reply_fillers += 1
                kept += lead.group(0)
            text = text[lead.end() :]

    def _vary_opener(self, text: str) -> str:
        """Take an interjection or a "That's" off a reply that opens like one of the last six."""
        recent = [past for past, _tics in self.ctx.recent_styles[-STYLE_OPENER_WINDOW:]]
        for pattern in (_LEAD_INTERJECTION, _LEAD_DEMONSTRATIVE):
            opener = reply_opener(text)
            if not opener or opener not in recent:
                break
            match = pattern.match(text)
            if match is not None and word_count(text[match.end() :]) >= 2:
                text = text[match.end() :]
        return text

    def _vet(self, sentence: str) -> list[str]:
        if self._done:
            return []
        if self.ctx.is_learner:
            sentence = _unquote_figures(sentence)
        hits = check_sentence(sentence, self.ctx)
        out = sentence
        # The feedback refusal is the whole answer: whatever the model says after it (in the
        # owner's session, a paraphrase of the deferral line, "the hiring team will follow up")
        # would say the same thing twice.  The reply ends with the refusal.
        final = False
        if hits:
            self._hits.extend(hits)
            self._replaced = True
            out = _replacement(hits, self.ctx, sentence)
            final = out == NO_FEEDBACK_LINE
            if out in self._replacements:
                out = ""
            if out:
                self._replacements.add(out)
        if out and self.ctx.is_learner and _STILL_MORE.search(out) is not None:
            if any(_STILL_MORE.search(said) for said in self._emitted):
                out = ""  # "more than I planned for" is said once in a reply
        if out and not hits:
            out = self._vary(out)
            if out and self._last_dropped and self.ctx.is_learner:
                # The sentence before this one was dropped: a connector that leaned on it
                # ("Also, how many hours ...", "And before I commit ...") goes with it.
                stripped = _LEAD_CONNECTOR.sub("", out, count=1)
                if stripped != out and word_count(stripped) >= 2:
                    out = stripped[0].upper() + stripped[1:]
                    self._style_edits += 1
        if out and out not in self._emitted:
            repeated = self._repeated(out)
            if repeated is not None:
                self._hits.append(repeated)
                self._replaced = True
                if hits:
                    self._other_drops += 1  # the model's own sentence was blocked as well
                else:
                    self._repeat_drops += 1
                self._last_dropped = True
                return []
        if not out or out in self._emitted:
            if hits and all(hit.rule == "closer_again" for hit in hits):
                self._repeat_drops += 1  # a second goodbye is a repeat: a back-channel replaces it
            elif hits:
                self._other_drops += 1
            self._last_dropped = True
            return []
        self._last_dropped = False
        cap = self.ctx.word_cap
        if cap is not None:
            room = cap - self._used
            size = word_count(out)
            if size > room:
                self._done = True
                self._truncated = True
                if self._emitted:
                    # Never speak a ragged fragment after complete sentences.
                    return []
                out = truncate_words(out, room)
                if not out:
                    return []
                size = word_count(out)
            self._used += size
            if self._used >= cap:
                self._done = True
        self._emitted.append(out)
        if final:
            self._done = True
        return [out]

    def feed(self, delta: str) -> list[str]:
        self._buffer += delta
        parts = split_sentences(self._buffer)
        if len(parts) <= 1:
            return []
        out: list[str] = []
        for sentence in parts[:-1]:
            out.extend(self._vet(sentence))
        self._buffer = parts[-1]
        return out

    def flush(self) -> list[str]:
        out: list[str] = []
        for sentence in split_sentences(self._buffer):
            out.extend(self._vet(sentence))
        self._buffer = ""
        if not self._emitted and not self.ctx.quiet_empty:
            self._fallback_used = True
            only_repeats = self._repeat_drops > 0 and self._other_drops == 0
            self._emitted.append(_fallback(self.ctx, only_repeats=only_repeats))
            out.append(self._emitted[-1])
        return out

    @property
    def result(self) -> GuardResult:
        return GuardResult(
            text=" ".join(self._emitted),
            hits=tuple(self._hits),
            replaced=self._replaced,
            fallback_used=self._fallback_used,
            truncated=self._truncated,
            style_edits=self._style_edits,
        )


def guard_text(text: str, ctx: GuardContext) -> GuardResult:
    """Vet a whole reply at once (the non-streaming form of ``StreamGuard``)."""
    guard = StreamGuard(ctx)
    guard.feed(text)
    guard.flush()
    return guard.result


def _filler_gap(match: re.Match[str]) -> str:
    """What replaces a filler taken out of a sentence.

    Nothing when punctuation follows ("confusing, honestly - I'm not sure" -> "confusing - I'm not
    sure"); the comma before the filler stays ("packed, honestly, and" -> "packed, and"); otherwise
    one space ("but I have to be honest, there's" -> "but there's").
    """
    following = match.string[match.end() :].lstrip()
    if not following or following[0] in ".?!,;:-)":
        return ""
    return "," if match.group(0).lstrip().startswith(",") else " "


def _strip_concession_tag(text: str) -> str:
    """``text`` without the concession tag ("..., I'll give you that.", "I'll admit, ...").

    What is left keeps its closing mark; a tag that is the whole sentence leaves nothing, which
    ``_vary`` turns into a neutral acknowledgement.
    """
    end = text.rstrip()[-1:] if text.rstrip()[-1:] in (".", "?", "!") else ""
    out = CONCESSION_TAG_LEADING.sub("", text, count=1)
    out = CONCESSION_TAG_TRAILING.sub("", out).rstrip(" ,;:-")
    if word_count(out) < 2:
        return ""
    if out and out[-1] not in ".?!":
        out += end or "."
    return out


def _tidy(text: str) -> str:
    """Spacing and commas after a filler was taken out ("packed , , and" -> "packed, and")."""
    text = re.sub(r"\s+([,.?!])", r"\1", text)
    text = re.sub(r"^\W*(?:though|and|so)\s*,\s+", "", text, flags=re.IGNORECASE)
    text = re.sub(r",(?:\s*,)+", ",", text)
    text = re.sub(r",\s*([.?!])", r"\1", text)
    text = re.sub(r",\s*(-+)(?=\s)", r" \1", text)  # "confusing, - I'm" -> "confusing - I'm"
    text = re.sub(  # "But, there's" -> "But there's"
        r"\b(but|and|or|yet|plus)\s*,\s+", r"\1 ", text, flags=re.IGNORECASE
    )
    text = re.sub(r"^[\s,]+", "", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def _is_tic_word(text: str) -> bool:
    """True when ``text`` is (led by) one of the tic words, which have their own quota."""
    return any(pattern.search(text) is not None for pattern in TIC_PATTERNS.values())


# Words that frame the phrase after them as something the learner still has to find out:
# "I want to be sure it's worth it" and "so I can see if it's worth the money" are doubt, which is
# exactly what the learner should voice (R1-Q iteration 2: the first was a concession hit and a
# hard fail).  "I'm sure it's worth it" has no such frame and stays a concession.
_DOUBT_FRAME = re.compile(
    r"\b(?:(?:to|want to|need to|have to|like to|got to|trying to|going to|just to) "
    r"(?:be |make )?(?:sure|certain|confident)"
    r"|make sure|want to (?:know|see|check|understand|find out|confirm|figure out)"
    r"|need to (?:know|see|check|understand|find out|confirm|figure out)"
    r"|(?:figure|work|find) out|wonder(?:ing)?|unsure|not sure|"
    r"(?:see|check|confirm|know|decide|judge|tell|ask) (?:if|whether|that|how)|"
    r"whether|depends)\b",
    re.IGNORECASE,
)


def has_concession(text: object) -> bool:
    """True when ``text`` expresses resolution, acceptance or "you've convinced me".

    Polarity-aware: "I'm not convinced yet", "I'm still not convinced it's worth it" and
    "I'm not sure it's worth the money" are scepticism, which is exactly what the learner
    should voice, so a phrase with a negator earlier in its clause is not a concession.  The
    same goes for a phrase the learner is only checking on ("I want to be sure it's worth it",
    "I need to see if the price is fair").
    """
    folded = fold(text)
    return any(
        not negated_before(folded, match.start())
        and _DOUBT_FRAME.search(clause_before(folded, match.start())) is None
        for match in _CONCESSION.finditer(folded)
    )


def log_keys(hits: Iterable[Hit]) -> list[str]:
    """The ``r1_guard_*`` keys to log for ``hits``, in first-seen order."""
    seen: list[str] = []
    for hit in hits:
        if hit.log_key not in seen:
            seen.append(hit.log_key)
    return seen


# Names that must never reach the interviewer's mouth are exported for tests and logs.
PERSONA_NAMES = tuple(sorted(set(ALL_PERSONA_NAMES)))
