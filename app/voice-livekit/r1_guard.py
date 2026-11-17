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
import os
import re
from dataclasses import dataclass, field, replace
from typing import Iterable

from r1_commitment import Level, classify_learner_commitment
from r1_personas import (
    ALL_PERSONA_NAMES,
    H_TOPICS,
    MONTHLY_BUDGET_MAX_USD,
    PERSONAS,
    PUBLIC_ANSWERS,
    SUCCESS_ANSWER_V2,
    RenderedPersona,
)
from r1_scheduler import open_question_topics
from r1_script import EXIT_CUE, LINES
from r1_text import (
    CLOSER,
    CONCESSION_TAG,
    CONCESSION_TAG_LEADING,
    CONCESSION_TAG_LEADING_V3,
    CONCESSION_TAG_TRAILING,
    CONCESSION_TAG_TRAILING_V3,
    DECIDER_STALL,
    MONEY_STRAIN,
    PHRASE_CONCESSION_TAG,
    PHRASE_DECIDER_STALL,
    PHRASE_MONEY_STRAIN,
    PHRASE_STALL_CLOSER,
    PHRASE_REAL_COMMITMENT,
    REAL_COMMITMENT,
    STALL_CLOSER,
    canonical_amounts,
    TIC_ACTUALLY,
    TIC_GENUINELY,
    TIC_HMM,
    TIC_HONESTLY,
    TIC_PATTERNS,
    TIC_PATTERNS_V2,
    TIC_PROPERLY,
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
    says_goodbye_or_sends,
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
PHRASE_QUOTA = {
    PHRASE_STRETCH: 1,
    PHRASE_TEMPLATE_Q: 1,
    PHRASE_CONCESSION_TAG: 1,
    # R1-Q final review round 1: the stall loop.  The decider stall ("talk it over with my father"),
    # the stall closer ("get back to you", "let me think about it") and the money line ("still more
    # than I planned for") may be used this often in a call (the scripted and owed lines count),
    # and never again within PHRASE_WINDOW of the learner's replies.  A free reply above the quota
    # loses the clause; an owed move (an intent reply) and the answer to "who else decides?" are
    # never touched.
    PHRASE_DECIDER_STALL: 3,
    PHRASE_STALL_CLOSER: 2,
    PHRASE_MONEY_STRAIN: 3,
}
PHRASE_WINDOW = {PHRASE_DECIDER_STALL: 4, PHRASE_STALL_CLOSER: 4, PHRASE_MONEY_STRAIN: 3}
_STALL_PATTERNS = {
    PHRASE_DECIDER_STALL: DECIDER_STALL,
    PHRASE_STALL_CLOSER: STALL_CLOSER,
    PHRASE_MONEY_STRAIN: MONEY_STRAIN,
}
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
# "That helps" -> "It helps", "That's a lot" -> "It's a lot": a repeated "That's" opener is
# swapped for the pronoun, never cut (R1-Q final review round 1: stripping "That" left fragments,
# "Helps a little, though." in 26 replies of 14 live calls, and "That's" still opened 17 % of all
# replies, 23 % at two levels).  Only where the pronoun fits: "That's what I heard" and "That's the
# part I keep coming back to" are clefts and stay as they are.
_THAT_IS = re.compile(
    r"^that(?P<verb>'s| is)\s+(?=(?:a|an|still|really|quite|very|pretty|so|not|actually|definitely|"
    r"probably|just|fair|good|great|true|helpful|reassuring|better|worth|more|less|fine|nice|"
    r"interesting|understandable|encouraging|too|already|much|even|clear|reasonable|honest|"
    r"tough|hard|big|huge|serious|exciting)\b)",
    re.IGNORECASE,
)
_THAT_VERB = re.compile(
    r"^that\s+(?=(?:helps|makes|sounds|gives|means|feels|seems|covers|explains|answers|eases|"
    r"works|does|would|will|could|should|might|may|can|really|actually)\b)",
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
# M032 SWEEP-12 (``GuardContext.tic_v2``): "I'll be honest, ..." and "If I'm honest, ..." are the
# honesty tic too, taken out only before punctuation ("I'll be honest with myself" is the sentence).
_TIC_STRIP_V2 = {
    TIC_HMM: _TIC_STRIP[TIC_HMM],
    TIC_HONESTLY: (
        re.compile(
            r"(?:^|(?<=[\s,;-]))i(?:'ll| will) be (?:honest|frank|upfront|straight)"
            r"(?:\s+with\s+you)?\s*[,:;-]+\s*",
            re.IGNORECASE,
        ),
        re.compile(r"(?:^|(?<=[\s,;-]))if i'?m (?:being )?honest\s*[,:;-]+\s*", re.IGNORECASE),
        *_TIC_STRIP[TIC_HONESTLY],
    ),
}
# The soft tics: trimmed from a FREE reply that carries no owed move when the same tic was in one
# of the learner's last ``SOFT_TIC_WINDOW`` replies.  "properly" goes only right after think,
# weigh, look at, consider, read or go through (plus a short object) at a clause end; the
# adjective "proper" is steered by a note, never cut.
SOFT_TIC_WINDOW = 3
_SOFT_TIC_STRIP = {
    TIC_ACTUALLY: re.compile(r"\s{0,3},?\s{0,3}\bactually\b,?", re.IGNORECASE),
    TIC_GENUINELY: re.compile(r"\s{0,3},?\s{0,3}\bgenuinely\b,?", re.IGNORECASE),
}
_PROPERLY_AFTER_VERB = re.compile(
    r"\b((?:think|thinking|weigh|weighing|look at|looking at|consider|considering|read|reading|"
    r"go through|going through)\b(?:\s[\w']+){0,3}?)\sproperly(?=\s{0,3}(?:[.,;:!?]|$))",
    re.IGNORECASE,
)
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
# L5 (mock call aa166f09, turn 107: "Okay, that's more workable for me." to "$1000 EMI option
# monthly", over the card's $500-700 a month).  A monthly figure above the card's budget is never
# called workable; the learner says so instead.
BUDGET_REPLACEMENT = "That's still more than I can manage each month, though."
# M032 SWEEP-4 (flag R1_LEARNER_VOICE_V2, ``GuardContext.voice_v2``): without the trailing "though".
BUDGET_REPLACEMENT_V2 = "That's still more than I can manage each month."
_PAYMENT_OK = re.compile(
    r"\b(?:workable|doable|manageable|affordable)\b"
    r"|\b(?:that|this|it) (?:works|would work|could work)\b"
    r"|\bworks for (?:me|us)\b"
    r"|\b(?:i|we) (?:can|could) (?:manage|afford|swing|handle|do) (?:that|it|this|those)\b",
    re.IGNORECASE,
)
_SUPPOSED = re.compile(r"\b(?:if|unless|as long as|provided)\b", re.IGNORECASE)
# What the learner agrees to besides a payment: the schedule, a call slot, an e-mail, a talk with
# her decision maker (review fix: "Thursday at 7 PM works for me.", "That works, send me the
# details by email." and "I can do that, I will talk to my partner tonight." were rewritten).
# Without a money word in the sentence such an agreement says nothing about the payment.
_SCHEDULE_ONLY = re.compile(
    r"\b(?:schedule|timing|hours?|evenings?|weekends?|pace|mornings?|afternoons?|tonight|today|"
    r"tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekdays?|o'?clock|"
    r"\d{1,2}(?::\d{2})?\s*(?:am|pm)|call|slot|time|e-?mail|mail|details|link|brochure|"
    r"whatsapp|message|partner|husband|wife|spouse|father|mother|dad|mom|parents?|family|boss|"
    r"manager|talk|speak)\b",
    re.I,
)
_MONEY_WORD = re.compile(
    r"\b(?:pay\w*|price|cost\w*|month\w*|emis?|instal\w*|dollars?|amount|figure|budget)\b|\$",
    re.IGNORECASE,
)
_STILL_MORE = re.compile(
    r"\bmore than i (?:had |'d |would have )?(?:planned|hoped|budgeted|expected|wanted)\b",
    re.IGNORECASE,
)
# The call was placed by the advisor ("I'm glad I called"): the learner filled in a form.  L4 (mock
# call aa166f09, turns 23 and 25): "I'm calling about the data science course", "I thought I was
# the one calling".
_I_CALLED = re.compile(
    r"\b(?:glad i (?:called|rang|phoned)|when i called|i called (?:because|you|in|about)|"
    r"my call to you|thanks for taking my call|"
    r"i'?m (?:just )?calling (?:about|because|regarding|to (?:ask|find out|enquire|inquire))|"
    r"i am (?:just )?calling (?:about|because|regarding|to (?:ask|find out|enquire|inquire))|"
    r"(?:i'?m|i am|i was) the one (?:calling|who called|who rang|who phoned)|"
    r"i (?:thought|think) i (?:was|am) (?:the one )?(?:calling|who called))\b",
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
    r"|\bso you can (?:actually |really )?do (?:the |that )?\$?7,?000\b"
    # "So $7,000 then.", "Oh, so I'd pay $7,000? That works for me." (the question is the proof)
    r"|\bso (?:i'?d|i would|i will|i'?ll|we'?d) (?:only |just )?pay (?:the |that )?\$?7,?000\b"
    r"|\b(?:so |then |okay,? )\$?7,?000 (?:then|it is|is doable|is fine|works|is on)\b",
    re.IGNORECASE,
)
# R1-Q final review round 1: the same misreading spread over two sentences ("Great, so $7,000 then.
# That's a relief."), in spelled form ("seven grand"), or as a confirmation ("So seven it is?").
_SEVEN_GRAND = re.compile(r"\b(?:seven|7) grand\b", re.IGNORECASE)
_SEVEN_CONFIRMED = re.compile(
    r"\b(?:so |then |okay,? |great,? )seven (?:it is|then|works|is doable|is fine|is good|is on)\b"
    r"|\bseven it is\b",
    re.IGNORECASE,
)
_RELIEF = re.compile(
    r"\b(?:(?:that'?s|it'?s|that is|which is|oh,?|wow,?|so)\s+(?:a |such a |really |so |pretty |"
    r"actually )*(?:relief|great|wonderful|perfect|amazing|fantastic|excellent|good news|doable|"
    r"better than i expected)|(?:that|it) (?:works|sounds (?:good|great|perfect|fair|doable))"
    r"(?: for me)?|better than i expected)\b",
    re.IGNORECASE,
)
_ANCHOR_MENTION = re.compile(r"(?<![\d,.])\$?7,?000\b(?!\s*(?:months?|students|people))")


def _anchor_canon(sentence: str) -> str:
    """The sentence with every spoken form of $7,000 written as "$7000"."""
    return _SEVEN_GRAND.sub("$7000", canonical_amounts(sentence))


def mentions_anchor_figure(sentence: str) -> bool:
    """The sentence names the $7,000 anchor (digits, "seven thousand" or "seven grand")."""
    return _ANCHOR_MENTION.search(_anchor_canon(sentence)) is not None


# Simulation diagnosis 4 (D4-SEVEN1, R1_ANCHOR_TIME_AWARE): "Seven it is" answered "What time
# suits you? ... seven" (a call at 7 pm) and was swapped for "So what would the actual price come
# to?".  A bare "seven" is the $7,000 only with money words in the sentence or in the advisor's
# turn, and never with a clock time in either.
_SEVEN_MONEY = re.compile(
    r"\$|\b(?:thousand|grand|k|price|pay|paying|fee|fees|cost|costs|dollars?|discount|"
    r"7,?000|seven thousand)\b",
    re.IGNORECASE,
)
# Review D4R-3: only a time next to the seven ("at seven", "7 pm", "seven o'clock") or a question
# about the time ("what time suits you? ... seven"); a deadline word beside a price ("$8,000 if you
# enroll by tomorrow", "only till this evening") is no clock time.
_SEVEN_CLOCK = re.compile(
    r"\b(?:at|around|by|about|till|until) (?:seven|7)\b|\b(?:seven|7) ?o'?clock\b"
    r"|\b(?:seven|7)(?::\d\d)? ?(?:pm|am|p\.m\.|a\.m\.)"
    r"|\b(?:what time|which time|time (?:suits|works)|call (?:you )?(?:at|back))\b",
    re.IGNORECASE,
)


# D4-CONTACT1 (R1_CONTACT_READER_V2): the advisor's turn asked how to reach her, so the form line
# answers it; otherwise a contact sentence is simply dropped ("You can use the email on my form."
# after "Mentors help you catch up" was a non sequitur).
_CONTACT_ASKED = re.compile(
    r"\b(?:e-?mail|mail id|number|phone|mobile|whats ?app|contact|reach you|text you|"
    r"call you (?:on|at))\b",
    re.IGNORECASE,
)


def _contact_asked(ctx: "GuardContext") -> bool:
    """D4-CONTACT1: the advisor's current turn asked for her contact details."""
    advisor = ctx.advisor_said[-1] if ctx.advisor_said else ""
    return _CONTACT_ASKED.search(advisor) is not None


def _seven_is_money(sentence: str, ctx: "GuardContext") -> bool:
    """D4-SEVEN1: a bare "seven" in ``sentence`` is the $7,000, not a clock time."""
    advisor = ctx.advisor_said[-1] if ctx.advisor_said else ""
    if _SEVEN_CLOCK.search(sentence) is not None or _SEVEN_CLOCK.search(advisor) is not None:
        return False
    return _SEVEN_MONEY.search(sentence) is not None or _SEVEN_MONEY.search(advisor) is not None


def _anchor_taken_as_offer(sentence: str, ctx: "GuardContext") -> bool:
    """The learner treats the $7,000 as a price the advisor offered (it only raised it itself)."""
    canon = _anchor_canon(sentence)
    if _ANCHOR_REACTION.search(canon) is not None:
        return True
    if _SEVEN_CONFIRMED.search(sentence) is not None:
        return not ctx.anchor_time_aware or _seven_is_money(sentence, ctx)
    return ctx.anchor_in_reply and _RELIEF.search(sentence) is not None

LEARNER_PHASE = "roleplay"
FEEDBACK_PHASES = frozenset({"roleplay_exit", "wrapup", "closing"})
# M032 SWEEP-26: the phases whose deflection is L-FAQ-DEFER-WRAP and that name the hiring team
# only in L-CLOSE (``GuardContext.one_mention``).
ONE_MENTION_PHASES = frozenset({"wrapup", "closing"})
FAQ_DEFER_WRAP_LINE = LINES["L-FAQ-DEFER-WRAP"]
_HIRING_TEAM = re.compile(r"\bhiring (?:team|manager|panel)s?\b", re.IGNORECASE)
# The words of an acknowledgement ("That's a good question.", "Sure, thanks for asking."): a
# sentence with at least ``OWN_CONTENT_WORDS`` other words has content of its own ("That's
# everything for today's interview."), so a hiring-team sentence after it is dropped rather than
# replaced (the reply already said something).
_ACK_ONLY_WORDS = frozenset(
    "great good sure okay ok of course thats that is its a an the question questions thanks thank "
    "you for asking absolutely yes yeah right i see understand fair point interesting nice so well "
    "and glad asked really very totally definitely happy to help".split()
)
OWN_CONTENT_WORDS = 3
# D3-WRAP1 (R1_WRAPUP_NEXT_STEPS): a lead-in says it will answer without answering ("Curious about
# that, so let me be straight with you.", "Good question."); with it taken out, a sentence that has
# no content of its own is no answer, so a hiring-team sentence after it still gets
# L-FAQ-DEFER-WRAP.
_LEAD_IN_PHRASES = re.compile(
    r"\b(?:let me be (?:straight|honest|clear|upfront|frank|direct)(?: with you)?|"
    r"(?:that'?s a |what a )?(?:good|great|fair|lovely|nice) (?:question|one)|"
    r"(?:i'?m )?(?:curious|glad) (?:about that|you asked)|thanks? (?:you )?for asking|"
    r"happy to (?:answer|help)(?: with that)?|let me (?:see|think)|"
    r"i(?:'d| would) love to (?:tell|share)(?: you)?|so)\b",
    re.IGNORECASE,
)
# D3-LRN-MONEY1 (R1_FIGURE_MEMORY): a comparison with what she had heard or braced for.
_HEARD_COMPARE = re.compile(
    r"\bwhat i(?:'d| had)? (?:heard|been told)\b|\bbraced (?:myself )?for\b|"
    r"\bwhere i was hoping it would land\b|\bwhat (?:someone|a friend|people) (?:paid|told me)\b",
    re.IGNORECASE,
)
_INCLUDED_QUESTION = re.compile(
    r"\bwhat(?:'s| is| would be| exactly is| exactly)? (?:actually )?(?:included|covered)\b|"
    r"\bwhat (?:does|would|do) (?:that|it|this|i) (?:\w+ )?(?:include|cover|get for)\b",
    re.IGNORECASE,
)
# D3-LRN-PRICE1 (R1_FOREIGN_PRICE): she says nobody told her the price after he named one.
_NO_PRICE_HEARD = re.compile(
    r"\b(?:nobody|no one|no-one)(?:'s| has| had)? (?:actually |really |even |yet )?"
    r"(?:told|given|said|mentioned|quoted)\b[^.?!]{0,30}\b(?:price|cost|figure|fee|number)\b|"
    # Review D3R-7: "heard / been told" binds to its object ("haven't heard what it costs"), never
    # "heard back from my husband about the cost" or "what the monthly fee would cost".
    r"\b(?:haven'?t|have not) (?:actually |really |yet |even )?"
    r"(?:heard|been told|gotten|got|been given)(?! back\b) (?:about |of )?"
    r"(?:the |a |any |an actual |a real )?(?:price|cost|fee|figure|number)\b|"
    r"\b(?:haven'?t|have not) (?:actually |really |yet |even )?(?:heard|been told)(?! back\b) "
    r"(?:what (?:it|the course|this|the program(?:me)?) (?:costs?|would cost|will cost|comes to)|"
    r"how much (?:it|the course|this|the program(?:me)?) (?:costs?|is|would cost|will cost))\b|"
    r"\bstill (?:don'?t|do not) know (?:what (?:it|the course|this|the program(?:me)?) "
    r"(?:costs?|would cost|will cost|comes to)|how much (?:it|the course|this|the program(?:me)?) "
    r"(?:costs?|is|would cost|will cost)|the (?:price|cost|fee))\b",
    re.IGNORECASE,
)
# D3-LRN-ACK1 (R1_EASED_ACK_V2): the stock thanks for easing off.
_THANKS_FOR_ROOM = re.compile(
    r"\bthanks? (?:you )?for giving me (?:the |some |a bit of |a little )?(?:time|space|room)\b",
    re.IGNORECASE,
)
# Simulation diagnosis 4.  D4-TIMECUE1 (R1_TIME_CUE_V3): once her time cue was said, a free reply
# does not say it again in other words.  D4-COMEBACK1 (R1_COME_BACK_V2): a come-back never points
# at what the advisor said or how often ("You've said small a couple of times now").  D4-F3STOCK1
# (R1_F3_WORDING): "<six months> is a real commitment" is said once a call.
_TIME_CUE_AGAIN = re.compile(
    r"\bonly (?:have|got|'ve got) (?:a couple of|a few|two|a few more) minutes\b"
    r"|\b(?:need|have) to (?:wrap up|head out|get going|go|leave|hop off) in (?:a couple of|a few|"
    r"two) minutes\b"
    r"|\b(?:a couple of|a few|two) (?:more )?minutes (?:left|before i (?:need|have) to)\b",
    re.IGNORECASE,
)
_REPETITION_REPROACH = re.compile(
    r"\byou(?:'ve| have) (?:said|mentioned|told me)\b[^.?!]{0,40}\b(?:a couple of times|twice|"
    r"a few times|again|already|more than once)\b"
    r"|\byou keep (?:saying|telling me)\b",
    re.IGNORECASE,
)
# D3-LRN-QDIET (R1_QUESTION_DIET_V2): a follow-up shares a content word of this many letters or more
# with the advisor's turn, none of these; or asks what she would pay after he named a figure.
FOLLOWUP_MIN_LETTERS = 4
_POINTING_WORD = re.compile(r"\b(?:that|this|it|those|these)\b", re.IGNORECASE)
_FOLLOWUP_STOP = frozenset(
    "what would that this with have about your there they does will just really actually then "
    "when which much like know think mean make could should from into over more some them those "
    "these been were said okay right sure well also still even only kind sort thing things "
    "course program class learn data science tell want need sound good great".split()
)
_MONEY_FOLLOW_UP = re.compile(
    r"\b(?:pay\w*|cost\w*|price|monthly|month|instal\w*|emis?|total|fee|discount\w*|offer)\b",
    re.IGNORECASE,
)
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
# M032 S5: Christy grading an answer in the getting-to-know-you part ("... is solid experience").
PRAISE = "praise"
# M032 SWEEP-17 (flag R1_PROBE_FIRST): a course length she says that the advisor never said.
# Hygiene, never posted to the 3-hit gate: the sentence is dropped and counted
# (``course_fact_unsaid``).
COURSE_FACT = "course_fact"
# M032 SWEEP-26 (flag R1_WRAPUP_ONE_MENTION): a wrap-up or closing sentence of Christy's that names
# the hiring team, which L-CLOSE names (replaced by L-FAQ-DEFER-WRAP once per reply, or dropped
# after a sentence with content of its own).  Hygiene, never posted: the gate's 3-hit count is
# unchanged.
HIRING_MENTION = "hiring_mention"
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
    PRAISE,
    COURSE_FACT,
    HIRING_MENTION,
)
# Hygiene is counted and logged but is not a leak and is never posted to the API.
HYGIENE_CATEGORIES = frozenset(
    {ACK_FORMAT, REPEAT, REOPEN, MISREAD, PRAISE, COURSE_FACT, HIRING_MENTION}
)
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
# M032 S5: Christy grading an answer in the opening or the icebreaker (owner's call fda9e9f6: "...
# is solid experience", "... is a real asset", "That drive sounds useful").  Narrow on purpose: a
# warm acknowledgement ("Got it", "Thanks for sharing that", "That makes sense", "Sounds like a busy
# day", "Good to know") is not a verdict and passes.  Every quantifier is bounded (no ReDoS).
_PRAISE_STRONG = (
    r"(?:solid|strong|great|impressive|excellent|valuable|fantastic|amazing|wonderful|brilliant|"
    r"outstanding|remarkable|incredible|exceptional|commendable|admirable|terrific|superb|stellar)"
)
_PRAISE_NOUN = (
    r"(?:experience|background|track record|skills?|skill set|strengths?|qualit(?:y|ies)|"
    r"answers?|examples?|achievements?|accomplishments?|results?|record|foundation|attitude|"
    r"mindset|approach|drive|traits?|profile|work ethic|grit)"
)
_PRAISE = _ci(
    # "solid experience", "a strong background", "great answer", "such an impressive result"
    r"\b" + _PRAISE_STRONG + r" " + _PRAISE_NOUN + r"\b",
    # "a real asset", "a big plus", "a definite strength" (a verdict about them, as a statement)
    r"\b(?:is|are|was|'s|be|sounds like|seems like) (?:a|an) (?:real |great |big |huge |valuable |"
    r"definite |genuine |clear )?(?:asset|plus|strength)\b",
    # "That's impressive", "sounds really outstanding", "That drive sounds useful"
    r"\b(?:is|are|was|were|'s|sounds?|seems?|looks?)(?: like)? (?:really |very |so |quite |truly |"
    r"genuinely |pretty |incredibly |super |especially |particularly )?(?:impressive|admirable|"
    r"commendable|remarkable|outstanding|excellent|exceptional|brilliant|fantastic|amazing|"
    r"incredible|terrific|superb|stellar|inspiring|wonderful|lovely)\b",
    r"\b(?:sounds?|seems?) (?:really |very |quite |so )?(?:useful|valuable)\b",
    # A verdict as a statement about any noun (review of S5): "That's an impressive streak",
    # "That's a solid number".  Only the grading adjectives: "a big jump", "a long run" pass.
    r"\b(?:is|are|was|'s|sounds like|seems like) (?:a|an|such a|such an) (?:really |very |pretty |"
    r"truly )?(?:impressive|solid|strong|excellent|outstanding|remarkable|exceptional|stellar|"
    r"terrific) [a-z]",
    r"\b(?:big|huge|real|major) (?:achievements?|accomplishments?)\b",
    # "Impressive!", "Wow, amazing.", "Perfect.", "Nice one."
    r"^(?:wow|oh)?[ ,!.]{0,3}(?:impressive|excellent|amazing|fantastic|brilliant|wonderful|"
    r"outstanding|terrific|superb|perfect|lovely)\b",
    r"^(?:nice one|good stuff|great stuff)\b",
    r"\b(?:well done|good for you|i love that|love that|kudos|hats off|bravo|nicely done|"
    r"(?:good|great|nice|excellent) (?:job|work|answer|point))\b",
    r"\byou(?:'re| are) clearly\b|\byou clearly (?:have|know|are|did)\b",
    r"\bplay(?:s|ing)? to your strengths?\b",
    r"\bshows? (?:real |great |a lot of |genuine |strong |true )?(?:dedication|commitment|"
    r"initiative|resilience|grit|drive|passion|maturity|leadership)\b",
)
# Where a question's leading clause ends: a comma, semicolon or colon, or a spaced dash.
_CLAUSE_BREAK = re.compile(r"[,;:]\s+|\s+[-\u2013\u2014]\s+")
# A clause that asks without a question mark ("Tell me about a great result you're proud of.",
# "I'm curious what drew you to this role.").
_ASKING_CLAUSE = _ci(
    r"^(?:(?:so|and|but|okay|ok|now|then|also|right)\W{1,2}){0,3}(?:tell me|walk me|talk me|"
    r"describe|share|give me|can you|could you|would you|i'd love to hear|i'd like to hear|"
    r"i'd love to know|i'd like to know|i'm curious|i am curious|i'd be curious|i would be "
    r"curious|i wonder|i'm wondering|help me understand)\b"
)
# A connector that leaned on a clause the cut removed ("..., and I'm curious what ...").
_KEPT_LEAD_CONNECTOR = _ci(r"^(?:and|but)\s+")
PRAISE_KEEP_MIN_WORDS = 3


def praise_detected(sentence: object) -> bool:
    """True when ``sentence`` grades the candidate or their answer (``_PRAISE``)."""
    return _PRAISE.search(fold(sentence)) is not None


def _asks(clause: str) -> bool:
    return "?" in clause or _ASKING_CLAUSE.search(clause.strip()) is not None


def sentence_asks(sentence: str) -> bool:
    """True when some clause of ``sentence`` asks (a question mark, or "tell me", "I'm curious
    ..." without one)."""
    return "?" in sentence or any(
        _asks(clause) for clause in _CLAUSE_BREAK.split(sentence)
    )


def without_praise(sentence: str) -> str:
    """``sentence`` without its praise: "" for a praising statement, the question for a question.

    A statement that praises is dropped whole.  A sentence that asks (a question mark, or "tell
    me", "I'm curious ..." without one) keeps what asks: every clause before the first asking one
    that praises is cut, with an acknowledgement kept ("Got it, that's solid experience, so what
    ...?" -> "Got it, so what ...?"), and an asking clause that itself names a quality ("Could you
    share a great example ...?") is left as it is.  What would keep fewer than
    ``PRAISE_KEEP_MIN_WORDS`` words is dropped too.
    """
    if not praise_detected(sentence):
        return sentence
    breaks = list(_CLAUSE_BREAK.finditer(sentence))
    bounds = [0, *(match.end() for match in breaks)]
    ends = [*(match.start() for match in breaks), len(sentence)]
    clauses = [sentence[begin:end] for begin, end in zip(bounds, ends)]
    asking = next((index for index, clause in enumerate(clauses) if _asks(clause)), None)
    if asking is None:
        return ""
    kept = [
        index
        for index, clause in enumerate(clauses)
        if index >= asking or not praise_detected(clause)
    ]
    if len(kept) == len(clauses):
        return sentence
    parts: list[str] = []
    for index in kept:
        if parts:
            parts.append(sentence[ends[index - 1] : bounds[index]])  # the original separator
        parts.append(clauses[index])
    rest = _KEPT_LEAD_CONNECTOR.sub("", "".join(parts).strip(), count=1)
    if word_count(rest) < PRAISE_KEEP_MIN_WORDS:
        return ""
    return rest[0].upper() + rest[1:]


# M032 diagnosis 3 (D3-ICE1): Christy's echo-and-verdict reaction, "Six years in edtech, that's a
# good stretch.", "Eleven years in sales is a long run.", "Making a study plan together, that's
# hands-on."  Not praise (``_PRAISE`` passes "a long run" on purpose) but a stock summary label, in
# 9 of 15 judged calls of int-live-3.  Every quantifier is bounded (no ReDoS).
_SUMMARY_VERDICT = _ci(
    r"\b(?:that's|that is|is|sounds like) (?:a |an )?(?:good|long|fair|busy|clear|decent|nice|"
    r"natural|real|useful|smart|helpful|big) (?:stretch|run|path|one|instinct|amount|bit|jump|"
    r"leap|habit|journey|mix)\b",
    r"\bthat's (?:hands-on|a lot of [a-z]+)\b",
)
# The echo-and-verdict SHAPE, whatever the words: a short echo, then "that's", "that is", "which
# sounds" ...  Two in a row are the pattern the judges called robotic; one is a reaction.
_SUMMARY_SHAPE = _ci(r"^[^,.?!]{3,60}(?:,| -) (?:that|which)(?:'s| is| sounds)\b")


# M032 live simulation, diagnosis 4 (D4-ICE-ECHO1, ``R1_REACTION_VARIETY_V2``): the verdicts the
# list above missed ("Same-day callbacks, that's a habit.", "That email months later says a lot.",
# "Notes on your phone, simple enough.", "That call must have felt good.").  Bounded quantifiers
# only.
_SUMMARY_VERDICT_V2 = _ci(
    r"\bthat'?s (?:a |an )?(?:habit|choice|practical|something|nice (?:reason|detail|one)|"
    r"not always easy|a lot)\b",
    r"\bsays (?:a lot|something)\b",
    r"\bmust have (?:felt|been)\b",
    r"\bisn'?t easy\b",
    r"\bsimple enough\b",
    r"\b(?:sounds like it|keeps things) [a-z]+\b",
)
# An echo opener: an acknowledgement word and their words back, as a whole statement ("Right,
# insurance sales to individuals.", "Got it, eight years in sales program management.").
_ECHO_OPENER = _ci(
    r"^(?:right|got it|okay|ok|mm|sure|makes sense|fair enough)[,.] [^.?!]{3,80}\.$"
)
_ECHO_OPENER_LEAD = _ci(r"^(?:right|got it|okay|ok|mm|sure|makes sense|fair enough)[,.] ")


def summary_verdict_detected(sentence: object, *, wide: bool = False) -> bool:
    """True when ``sentence`` labels what the candidate said (``_SUMMARY_VERDICT``, and with
    ``wide`` the D4-ICE-ECHO1 list too)."""
    folded = fold(sentence)
    if _SUMMARY_VERDICT.search(folded) is not None:
        return True
    return wide and _SUMMARY_VERDICT_V2.search(folded) is not None


def echo_opener(sentence: object) -> bool:
    """True when ``sentence`` is an acknowledgement and their words back (``_ECHO_OPENER``)."""
    return _ECHO_OPENER.search(fold(sentence).strip()) is not None


# Review of diagnosis 4 (ECHO-CUT-EATS-ANSWERS): the words an echo shares with the candidate's turn
# are its content words (four letters or more, none of these), compared without a plural "s".
_ECHO_FUNCTION_WORDS = frozenset(
    {"that", "this", "those", "these", "then", "than", "there", "their", "they", "them", "with",
     "from", "into", "about", "your", "yours", "what", "when", "which", "while", "have", "just",
     "some", "very", "really", "also", "back", "over", "more", "most", "much", "will", "would",
     "could", "should", "does", "done", "were", "been", "being", "here", "later", "come", "make",
     "sure", "okay", "right", "makes", "sense", "fair", "enough"}
)


def _echo_terms(text: str) -> set[str]:
    terms: set[str] = set()
    for word in normalize(fold(text)).split():
        if len(word) < 4 or word in _ECHO_FUNCTION_WORDS:
            continue
        terms.add(word[:-1] if word.endswith("s") and len(word) > 4 else word)
    return terms


def echoes_their_turn(sentence: object, candidate_text: str) -> bool:
    """Review of diagnosis 4 (ECHO-CUT-EATS-ANSWERS): ``sentence`` is an echo opener that plays the
    candidate's own words back: their turn asked nothing (an ack-led statement after a question is
    her answer or her deferral) and the echo's body shares a content word with it ("Right, two
    years on the phones." after "I spent two years on the phones")."""
    if not candidate_text or _turn_asks(candidate_text) or not echo_opener(sentence):
        return False
    body = _ECHO_OPENER_LEAD.sub("", fold(sentence).strip(), count=1)
    return bool(_echo_terms(body) & _echo_terms(candidate_text))


# M032 live simulation, diagnosis 5 (D5-ICE-AWITH1, ``R1_REACTION_VARIETY_V2``): the react clause's
# old example taught a stock frame, "And with <their thing>, <question>?" ("And with that playbook
# routine, what's drawing you to this particular role?"), about ten times in 250 icebreaker lines.
# One such opener in the small talk is natural; after that the clause is cut and the question kept.
# Bounded quantifiers only.
_WITH_OPENER = re.compile(
    r"^(?:and )?with (?:that|those|this|these|all|a|the|learners|so)\b[^,?]{0,60},\s*",
    re.IGNORECASE,
)
_WITH_OPENER_MIN_WORDS = 3


def with_opener(sentence: object) -> bool:
    """D5-ICE-AWITH1: ``sentence`` opens with the stock "And with <their thing>," frame."""
    return _WITH_OPENER.match(str(sentence or "").strip()) is not None


def without_with_opener(sentence: str) -> str:
    """D5-ICE-AWITH1: ``sentence`` without its "And with <their thing>," clause, re-capitalised.

    Never empty: with fewer than ``_WITH_OPENER_MIN_WORDS`` words left the sentence is kept whole.
    """
    text = str(sentence or "").strip()
    match = _WITH_OPENER.match(text)
    if match is None:
        return sentence
    rest = text[match.end():].strip()
    if word_count(rest) < _WITH_OPENER_MIN_WORDS:
        return sentence
    return rest[:1].upper() + rest[1:]


# D5-DEFLECT1: the core of her own deflection (``INTERVIEWER_DEFLECTION``), normalised.
_DEFLECTION_CORE = "good question for the hiring team"


def is_self_deflection(sentence: object) -> bool:
    """D5-DEFLECT1: ``sentence`` is the interviewer's hiring-team deflection, in any wording that
    keeps its core ("That's a good question for the hiring team; they'll follow up with you on
    it.")."""
    said = normalize(fold(sentence))
    return bool(said) and (
        said == normalize(fold(INTERVIEWER_DEFLECTION)) or _DEFLECTION_CORE in said
    )


def opens_with_reaction(sentence: object) -> bool:
    """D4-ICE-ECHO1: a reply opener that is an echo, a verdict or the echo-and-verdict shape."""
    return (
        echo_opener(sentence)
        or summary_shape(sentence)
        or summary_verdict_detected(sentence, wide=True)
    )


# D4-TRANS-Q1 (``R1_TRANSITION_ANSWERS``): the offer the transition note's old example taught the
# model ("Happy to go over the hours or anything else"), said once a session at most.
# Review of diagnosis 4 (OFFER-TRIM-FRAGMENT): its subject goes with it ("I'd be", "I'll be",
# "We're", "I would be more than"), so the cut never leaves "I'd be." to be spoken.
_OFFER_PHRASE = re.compile(
    r"[,;]?\s*(?:and\s+)?"
    r"(?:(?:i|we)(?:(?:'|\u2019)(?:m|re|d|ll)| am| are| would| will)\s+(?:be\s+)?)?"
    r"(?:(?:always|really|very|so|more than)\s+)*"
    r"happy to go (?:over|into) "
    r"(?:the hours|the brief|it again)[^.?!]*",
    re.IGNORECASE,
)
# What may be left of a sentence whose one clause was the offer: no words of its own to say.
_OFFER_LEFTOVER_WORDS = frozenset(
    {"sure", "of", "course", "and", "also", "absolutely", "definitely", "yes", "yeah", "okay", "ok"}
)


def offer_phrase_in(text: object) -> bool:
    """True when ``text`` makes the transition's "happy to go over ..." offer."""
    return _OFFER_PHRASE.search(str(text or "")) is not None


def without_offer_phrase(sentence: str) -> str:
    """``sentence`` without the "happy to go over ..." offer ("" when nothing else is left)."""
    if _OFFER_PHRASE.search(sentence) is None:
        return sentence
    rest = _OFFER_PHRASE.sub("", sentence).strip()
    rest = rest.rstrip(" ,;:-")
    if word_count(rest) < 2:
        return ""
    if all(word in _OFFER_LEFTOVER_WORDS for word in normalize(rest).split()):
        return ""  # "Sure, of course." with the offer gone says nothing of its own
    if rest[-1] not in ".?!":
        rest += "."
    return rest[0].upper() + rest[1:]


def summary_shape(sentence: object) -> bool:
    """True when ``sentence`` opens with a short echo and "that's ..." (``_SUMMARY_SHAPE``)."""
    return _SUMMARY_SHAPE.search(fold(sentence).strip()) is not None


def without_summary(sentence: str, *, shape: bool = False, wide: bool = False) -> str:
    """``sentence`` without its echo-and-verdict reaction (D3-ICE1).

    A statement is dropped whole ("" back).  A sentence that asks keeps what asks: the clauses
    before the first asking one go ("Six years in edtech, that's a good stretch, so what does a day
    look like?" -> "So what does a day look like?").  ``shape`` cuts the echo-and-verdict shape
    (``summary_shape``) in place of the verdict words.  What would keep fewer than
    ``PRAISE_KEEP_MIN_WORDS`` words is dropped too.
    """
    if not (summary_shape(sentence) if shape else summary_verdict_detected(sentence, wide=wide)):
        return sentence
    breaks = list(_CLAUSE_BREAK.finditer(sentence))
    bounds = [0, *(match.end() for match in breaks)]
    ends = [*(match.start() for match in breaks), len(sentence)]
    clauses = [sentence[begin:end] for begin, end in zip(bounds, ends)]
    asking = next((index for index, clause in enumerate(clauses) if _asks(clause)), None)
    if asking is None:
        return ""
    if asking == 0:
        return sentence  # the label is part of the question itself: left to the model's words
    rest = sentence[bounds[asking] :].strip()
    rest = _KEPT_LEAD_CONNECTOR.sub("", rest, count=1)
    if word_count(rest) < PRAISE_KEEP_MIN_WORDS:
        return ""
    return rest[0].upper() + rest[1:]


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

_CONCESSION_REST = (
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
_CONCESSION = _ci(r"\bconvinc", *_CONCESSION_REST)
# Simulation diagnosis 5 (D5-HF-CONCESSION1, R1_CONCESSION_READ_V2): "convinc" only as being won
# over ("you've convinced me", "I'm convinced", "that's convincing").  "It'd take some convincing"
# and "I'd need more convincing" are scepticism, the opposite of a concession.  "I'm convinced
# enough to ..." is still a concession; only "I'm convinced yet" (a dropped "not") is not.
# Review D5R-2: a whitelist missed "That convinced me.", "You've got me convinced." and "I'm a
# hundred percent convinced.", so the reading is the release before's ("convinced", "convinces",
# "convincing") minus the shapes that are never her being won over (``_NOT_WON_OVER``): the base
# form ("convince me", "you'll have to convince me") is never matched at all.
_CONCESSION_V2 = _ci(r"\bconvinc(?:ed|es|ing)\b", *_CONCESSION_REST)
# "(it'd) take some convincing", "I'd need more convincing": never a concession, whatever matched.
_MORE_CONVINCING = re.compile(
    r"\b(?:take|takes|took|taking|need|needs|want|wants|require|requires)\s+"
    r"(?:(?:some|a lot of|a lot more|more|a bit of|a little|a bit more|a little more|real)\s+)?"
    r"convincing\b",
    re.IGNORECASE,
)
# Review D5R-2: never her being won over: having or trying to convince someone, convincing someone
# other than her ("I'd have to convince my husband"), and "convinced yet" (a dropped "not").
_NOT_WON_OVER = re.compile(
    r"\b(?:have|has|had|need|needs|needed|got|going|gonna|try|tries|tried|trying|hope|hoping|"
    r"want|wants)\s+to\s+convinc\w*"
    r"|\bconvinc\w*\s+(?:my|his|her|their|our|him|them|everyone|anyone|somebody|someone|"
    r"the family|the kids)\b"
    r"|\bconvinced yet\b",
    re.IGNORECASE,
)


def concession_read_v2() -> bool:
    """D5-HF-CONCESSION1 (R1_CONCESSION_READ_V2, read at use; default ON, 0/off restores the
    release before): "convinc" counts only as being won over."""
    raw = os.getenv("R1_CONCESSION_READ_V2") or "1"
    return raw.strip().lower() not in ("0", "off", "false", "no")


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
# M032 SWEEP-17 (flag R1_PROBE_FIRST, ``GuardContext.probe_first``): the card holds no course
# figure, so the website's $9,000 leaves the amounts she may always say; the $7,000 she heard
# and her monthly budget stay.  A figure on the check or conflict path comes in through
# ``allowed_extra``.
_CARD_AMOUNTS_V2 = frozenset({7000, 500, 700})
# A course length or duration, as months ("six months", "a six-month program", "24 weeks", "half a
# year"); weeks count as weeks / 4.33 months.
_DURATION_NUMBERS = {
    "one": 1.0,
    "two": 2.0,
    "three": 3.0,
    "four": 4.0,
    "five": 5.0,
    "six": 6.0,
    "seven": 7.0,
    "eight": 8.0,
    "nine": 9.0,
    "ten": 10.0,
    "eleven": 11.0,
    "twelve": 12.0,
    "fifteen": 15.0,
    "sixteen": 16.0,
    "eighteen": 18.0,
    "twenty": 20.0,
    "twenty four": 24.0,
}
_DURATION = re.compile(
    r"\b(?P<num>\d{1,2}(?:\.\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"fifteen|sixteen|eighteen|twenty[- ]four|twenty)[\s-]+(?P<unit>months?|weeks?)\b"
    r"|\b(?P<half>half a year|half-year)\b",
    re.IGNORECASE,
)
WEEKS_PER_MONTH = 4.33

# ----------------------------------------------------------------------------------------------
# Simulation diagnosis 1 (flag R1_ECHO_GUARD, ``GuardContext.echo_guard``).  The probe-first notes
# make her pick up what the advisor just said ("recorded sessions help", "live mock interviews
# sound useful"), and every such echo was a LEAK hit: three echoes flagged a call.  A word she
# repeats from the advisor's latest turns is no invention; one he never said still hits.
# ----------------------------------------------------------------------------------------------
_TERM = re.compile(r"[a-z0-9]+")
_TERM_SUFFIXES = ("ings", "ing", "ed", "s")
# The words that make a sentence a format or schedule claim (``_FORMAT_FACT``), matched as whole
# words and compared as stems (review: "evenings" stems to "even", so a stem list never held it).
_FORMAT_WORD = re.compile(
    r"\b(?:live|record(?:ed|ing|ings|s)?|evenings?|mornings?|weekends?|weekdays?|hours?)\b"
)
# A priority or a wish about a policy ("the refund policy matters most to me", "the refund terms
# are the main thing I'd want to look at") states nothing about the course.
_POLICY_WISH = re.compile(
    r"\b(?:matters?|mattering|main thing|most to me|worried about|concerned about|care about|"
    r"curious about|ask(?:ing)? about|look(?:ing)? (?:at|into|over)|read(?:ing)? (?:through|up on)|"
    r"(?:want|need|like|have) to (?:look at|see|know|check|read|understand|hear about))\b",
    re.IGNORECASE,
)
# Review of L1 (c): the wish governs a claim word only in the claim's own clause, either before it
# ("I'd want to see placement numbers") or with the claim as its subject ("the refund policy
# matters most to me").  A new subject after a conjunction starts a new clause ("..., and you
# guarantee placement"), and the subject is a bare noun phrase: no "you", "there's" or verb.
_NEW_SUBJECT = re.compile(
    r"\b(?:and|so|which|because|then)\s+(?=(?:you|they|there|we|it|that|this|he|she)\b)",
    re.IGNORECASE,
)
_WISH_CLAUSE_END = re.compile(
    r"[.?!,;:\n]|\s-+\s|\b(?:but|so|which|because|though|although|while)\b|"
    r"\band\s+(?=(?:you|they|there|we|it|that|this|he|she|i)\b)",
    re.IGNORECASE,
)
_CLAIM_SUBJECT_LEAD = re.compile(
    r"\W*(?:(?:the|your|a|an|any|some|their|that|this|my|our|full|real|actual|whole|job|clear|"
    r"solid|decent|proper|and|or|money-back|placements?|refunds?|guarantees?|success|rate)\s+)*",
    re.IGNORECASE,
)
# How her course work is graded is a question about the course, not about this interview's score.
_SOFT_EVALUATION = re.compile(
    r"(?:scor(?:e|es|ed|ing)|grad(?:e|es|ed|ing)|rated|ratings?)", re.IGNORECASE
)
_COURSE_NOUN = (
    r"(?:capstones?|projects?|assignments?|exams?|quiz(?:zes)?|modules?|homework|coursework|"
    r"submissions?)"
)
_COURSE_WORK = re.compile(r"\b" + _COURSE_NOUN + r"\b", re.IGNORECASE)
# Review of L1 (d): the course work is what is graded, as the subject ("How is the capstone
# graded?", "Is the project reviewed and graded by mentors?") or the object ("How do you grade the
# assignments?") of the grading word.
_GRADE_WORD = (
    r"(?:scor(?:e|es|ed|ing)|grad(?:e|es|ed|ing)|rat(?:e|es|ed|ing)|mark(?:s|ed|ing)?)\b"
)
_COURSE_WORK_GRADED = re.compile(
    r"\b" + _COURSE_NOUN + r"(?:\s+\w+){0,2}?\s+(?:(?:is|are|get|gets|getting|be|being|was|were)"
    r"\s+)?(?:\w+\s+(?:and|or)\s+)?(?:scored|graded|rated|marked)\b"
    r"|\b(?:scor|grad|mark)(?:e|es|ed|ing|s)?\s+(?:the|my|our|their|each|every|all|all the)?\s*"
    r"(?:\w+\s+)?" + _COURSE_NOUN + r"\b",
    re.IGNORECASE,
)
# ... while grading her, the advisor or this call stays a leak ("Are you scoring me ...?", "Is this
# call graded like a project?", "Am I being graded on this ...?").
_SELF_GRADED = re.compile(
    r"\b" + _GRADE_WORD + r"\s+(?:me|us|you|your|this|on this|the (?:call|interview|"
    r"conversation))\b"
    r"|\b(?:am i|are we|are you|is this|is it|i'?m|i am|we'?re|you'?re)\b[^.?!]{0,25}?\b"
    + _GRADE_WORD
    + r"|\bthis (?:call|interview|conversation|chat)\b"
    r"|\byour (?:score|scores|grade|grades|marks|rating)\b",
    re.IGNORECASE,
)
# Fillers of an echo question ("Wait, $1,000?", "Really?", "Sorry, the mentors?").
_ECHO_FILLER = frozenset(
    {"wait", "really", "sorry", "oh", "so", "hmm", "huh", "what", "the", "a", "that", "is", "it",
     "seriously", "okay", "ok"}
)
ECHO_QUESTION_WORDS = 4
# A clause she keeps only with what it points at ("..., that suits me better" after the clause
# was cut): a short sentence led by "that" or "this", or "it suits / works / sounds".
_POINTS_BACK = re.compile(
    r"^\W*(?:(?:that|this)\b|it (?:suits|works|sounds|helps)\b)", re.IGNORECASE
)
POINTS_BACK_WORDS = 6
_DANGLING_CONJUNCTION = re.compile(r"[,;]?\s*\b(?:so|and|but|though)\W*$", re.IGNORECASE)
# The asked-for re-ask, shortened (L5): "Does the course include time with mentors?" -> "So, time
# with mentors?".
_REASK_TAIL = re.compile(
    r"\b(?:include|includes|cover|covers|offer|offers|have|has|get|give|gives|come with|"
    r"comes with|about)\s+(?P<tail>[^?]{3,60})\?\s*$",
    re.IGNORECASE,
)
REASK_TAIL_WORDS = 5
# Review of L5: a tail that holds a clause is no noun phrase, and a leading conjunction or "so" goes
# before "So, ...".
_REASK_CLAUSE = re.compile(
    r"\b(?:if|when|whenever|how|whether|why|where|what|who|which|that|i|you|we|they|it|is|are|"
    r"do|does|did|can|will|would|should|to)\b",
    re.IGNORECASE,
)
_REASK_LEAD = re.compile(r"^(?:(?:and|so|but|then|okay|ok|sorry)\b[,\s]*)+", re.IGNORECASE)


def _stem(word: str) -> str:
    for suffix in _TERM_SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


def _stems(text: object) -> list[str]:
    return [_stem(word) for word in _TERM.findall(fold(text).lower())]


def advisor_terms_in(text: object) -> frozenset[str]:
    """The word stems of an advisor turn, for ``GuardContext.advisor_terms`` (memory only)."""
    return frozenset(_stems(text))


def advisor_text_of(text: object) -> str:
    """An advisor turn as the deep-need markers read it, for ``GuardContext.advisor_said``."""
    return fold(text)


def _format_echoed(sentence: str, terms: frozenset[str]) -> bool:
    """Every format or schedule word of ``sentence`` (and an hours figure) is the advisor's."""
    lowered = fold(sentence).lower()
    needed = {_stem(word) for word in _FORMAT_WORD.findall(lowered)}
    if "hour" in needed:
        needed |= {word for word in _stems(sentence) if word.isdigit() or word in _SPELLED}
    return bool(needed) and needed <= terms


def _marker_echoed(
    pattern: re.Pattern[str], match: re.Match[str], advisor_said: tuple[str, ...]
) -> bool:
    """L1 (b): the marker is a phrase ("evenings and weekends") the advisor's own words match.

    A one-word marker ("kids", "loans") is never an echo: her own deep need is told in it whether
    or not he said the word.
    """
    return len(match.group(0).split()) >= 2 and any(
        pattern.search(said) is not None for said in advisor_said
    )


def echoed_need_topics(
    persona: RenderedPersona, text: object, advisor_said: tuple[str, ...]
) -> frozenset[str]:
    """The deep-need topics whose every marker in ``text`` echoes the advisor (L1 (b)).

    The guard lets such an echo through, so the reveal bookkeeping must not count it as a need
    told before it was asked about (``NeedGate.note_learner_text``'s ``echoed``).
    """
    folded = fold(text)
    topics: set[str] = set()
    for topic in H_TOPICS:
        found = [
            (pattern, match)
            for pattern in persona.markers(topic)
            for match in pattern.finditer(folded)
        ]
        if found and all(_marker_echoed(p, m, advisor_said) for p, m in found):
            topics.add(topic)
    return frozenset(topics)


def _wish_governs(sentence: str, match: re.Match[str]) -> bool:
    """Review of L1 (c): a wish or an indirect question governs this claim word in its clause."""
    before = _NEW_SUBJECT.split(clause_before(sentence, match.start()))[-1]
    if _NOT_ASSERTED.search(before) is not None or _POLICY_WISH.search(before) is not None:
        return True
    if _CLAIM_SUBJECT_LEAD.fullmatch(before) is None:
        return False  # "You guarantee ...", "There's a full refund ...": the claim is asserted
    after = _WISH_CLAUSE_END.split(sentence[match.end() :], maxsplit=1)[0]
    return _POLICY_WISH.search(after) is not None


def _claim_not_asserted(sentence: str) -> bool:
    """A policy or outcome word in a wish, a priority or an indirect question (L1 (c)).

    Every claim word of the sentence must be governed: a priority clause beside a claim ("You
    guarantee placement, and that matters most to me.") covers nothing.
    """
    matches = list(_CLAIM_WORDS.finditer(sentence))
    return bool(matches) and all(_wish_governs(sentence, match) for match in matches)


def _course_work_graded(sentence: str) -> bool:
    """L1 (d): only grading words, about how her course work is graded ("How is the capstone
    graded?"), never about her, the advisor or this call."""
    if _COURSE_WORK_GRADED.search(sentence) is None or _SELF_GRADED.search(sentence) is not None:
        return False
    return all(
        _SOFT_EVALUATION.fullmatch(match.group(0)) is not None
        for match in _EVALUATION.finditer(sentence)
    )


def is_echo_question(text: str, terms: frozenset[str]) -> bool:
    """U2: "Wait, $1,000?", "Really?": a few words of fillers, figures or the advisor's words."""
    if "?" not in text or word_count(text) > ECHO_QUESTION_WORDS:
        return False
    words = [word for word in _stems(text) if word not in _ECHO_FILLER]
    return all(word.isdigit() or word in terms for word in words)


def offers_choice(text: object) -> bool:
    """U5: an advisor question that offers her a choice ("a call next week, or would you rather
    reach out yourself?")."""
    return any(
        "?" in sentence and re.search(r"\bor\b", sentence, re.IGNORECASE) is not None
        for sentence in split_sentences(text)
    )


def short_reask(question: str) -> str:
    """L5: her question asked again in fewer words ("So, time with mentors?").

    Only a noun-phrase tail is shortened ("What do I get if I finish early?" keeps its "if"
    clause: "So, if I finish early?" asks something else); otherwise she asks it again whole, as
    her own re-ask ("So, is there any refund if I drop out?"), never asking him to repeat himself.
    """
    match = _REASK_TAIL.search(question)
    if match is not None:
        tail = match.group("tail").strip().rstrip(",")
        if 1 <= word_count(tail) <= REASK_TAIL_WORDS and _REASK_CLAUSE.search(tail) is None:
            return f"So, {tail}?"
    body = _REASK_LEAD.sub("", question.strip(), count=1)
    if not body:
        return question
    if not re.match(r"I\b", body):
        body = body[:1].lower() + body[1:]
    return f"So, {body}"


def durations_said(text: object) -> frozenset[float]:
    """The course-length figures in ``text``, as months (M032 SWEEP-17)."""
    found: set[float] = set()
    for match in _DURATION.finditer(fold(text)):
        if match.group("half"):
            found.add(6.0)
            continue
        token = match.group("num").lower().replace("-", " ")
        value = _DURATION_NUMBERS.get(token)
        if value is None:
            try:
                value = float(token)
            except ValueError:
                continue
        if match.group("unit").lower().startswith("week"):
            value = round(value / WEEKS_PER_MONTH, 2)
        found.add(value)
    return frozenset(found)


def _duration_known(value: float, known: frozenset[float]) -> bool:
    """``value`` (months) is one the advisor said; a figure from weeks matches within a month."""
    return any(
        abs(value - other) < 0.01 or (abs(value - other) <= 1.0 and (value % 1 or other % 1))
        for other in known
    )


# SWEEP-17 item 5: the frames in which a learner sentence states a course length ("keep up for six
# months", "the course runs for six months", "the data science course, roughly six months", "a
# six-month program"), and two that may carry either kind of duration
# (``_AMBIGUOUS_LENGTH_FRAMES``).
# Her own life's durations reach no frame in the persona's own words ("my contract renewal is
# decided in about six months", "I quit a free course after three weeks", "I've been applying for
# about three months"); the "for N months" frame with a course word skips a sentence about her past
# or her own plans (``_OWN_LIFE``).
_DUR_RE = (
    r"(?:(?:\d{1,2}(?:\.\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
    r"fifteen|sixteen|eighteen|twenty[- ]four|twenty)[\s-]+(?:months?|weeks?)\b|half a year\b)"
)
_APPROX = r"(?:about |around |roughly |nearly |almost |like |over |a good |only |just )?"
_COURSE_LENGTH_FRAMES = (
    re.compile(
        r"\bkeep(?:ing)? up\b[^.?!]{0,40}?\b(?:for|over|across|through)\s+(?:a |the )?" + _APPROX
        + _DUR_RE,
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:course|program(?:me)?|class(?:es)?|bootcamp)\s+(?:is|runs?|takes?|lasts?|goes on|"
        r"would (?:take|run|last|be)|will (?:take|run|last|be))\b[^.?!]{0,25}?" + _DUR_RE,
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:course|program(?:me)?|bootcamp)\b[^.?!]{0,30}?,?\s*(?:roughly|about|around|nearly|"
        r"almost)\s+" + _DUR_RE,
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|"
        r"twenty[- ]four)[\s-]+(?:months?|weeks?)[\s-]+(?:long\s+)?(?:course|program(?:me)?|"
        r"bootcamp)\b",
        re.IGNORECASE,
    ),
)
# Review S2P-R1: an "it" subject ("it will take six months") and "N months is a lot / feels like a
# really long ..." (review S2P-R8: up to two modifiers before "long") state a course length, but
# a model also says her own life's durations that way: "It is about eight months until my funding
# ends", "It will be six months before my contract renewal is decided", "Eight months is a lot
# less time than it sounds, that's when my funding ends", "It will take me two weeks to decide".
# These two frames skip a sentence about her own timeline (``_own_life_duration``).
_AMBIGUOUS_LENGTH_FRAMES = (
    re.compile(
        r"\bit\s+(?:is|runs?|takes?|lasts?|goes on|would (?:take|run|last|be)|"
        r"will (?:take|run|last|be))\b[^.?!]{0,25}?" + _DUR_RE,
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:^|[^\w])" + _DUR_RE + r"\s+(?:is|feels|sounds|seems|would be)\s+(?:like\s+)?"
        r"(?:(?:a|really|quite|pretty|so|very)\s+){0,2}(?:long|a lot|lot|too long|forever|big)\b",
        re.IGNORECASE,
    ),
)
# Her own timeline: a duration counted up to her own event ("until my funding ends", "before my
# contract renewal", "that's when my funding ends"; never "before I could switch", which is the
# course's length again), or the time she needs to decide ("it will take me two weeks to decide").
_OWN_LIFE_TIME = re.compile(
    r"\b(?:until|till|before|by the time|that'?s when|that is when|which is when)\s+(?:my|our)\b",
    re.IGNORECASE,
)
_OWN_LIFE_DECIDE = re.compile(
    r"\btake me\b[^.?!]{0,30}?\bto (?:decide|think|sort|talk|figure|make up my mind|save|discuss|"
    r"check|get back)\b",
    re.IGNORECASE,
)
_FOR_DURATION = re.compile(r"\b(?:for|over)\s+" + _APPROX + _DUR_RE, re.IGNORECASE)
_COURSE_WORD = re.compile(
    r"\b(?:course|program(?:me)?|class(?:es)?|bootcamp|studying|study|learning)\b", re.IGNORECASE
)
# Her own past or plans: the "for N months" frame never reads them as a course length.
_OWN_LIFE = re.compile(
    r"\b(?:ago|last|took|tried|did|quit|was|were|been|had|used to|renewal|contract|funding|opening|"
    r"applying|applied|postdoc|position|job|role|start in|starting in|could start)\b",
    re.IGNORECASE,
)


def _own_life_duration(folded: str, persona: RenderedPersona | None) -> bool:
    """``folded`` counts a duration on her own timeline (review S2P-R1): up to her own event, the
    time she needs to decide, or a "why now" event of the session's persona (her H1 deep need's
    markers: p2's contract renewal, p3's next opening, p4's funding), read with every duration
    masked so a persona marker that is itself a duration ("eight months") exempts nothing."""
    if _OWN_LIFE_TIME.search(folded) or _OWN_LIFE_DECIDE.search(folded):
        return True
    if persona is None:
        return False
    masked = _DURATION.sub(" ", folded)
    return any(pattern.search(masked) for pattern in persona.markers("H1"))


# Simulation diagnosis 2 (CF1, ``own_course``): a course she took herself is not THE course ("I quit
# a free Python course after about three weeks" is her H2 backstory).  The product is always "the",
# "this" or "your" course; a course noun with one of these words among the three before it is
# another course.
_OTHER_COURSE_BEFORE = re.compile(
    r"\b(?:a|an|one|another|that|some|free|online|python|youtube|coursera|udemy|old|previous|"
    r"earlier|other|first)\b",
    re.IGNORECASE,
)
_COURSE_NOUN = re.compile(r"\b(?:course|program(?:me)?|class(?:es)?|bootcamp)\b", re.IGNORECASE)
_OWN_LIFE_PAST = re.compile(
    r"\b(?:dropped|gave up|stopped|lasted|after (?:about|around|roughly|only|just))\b",
    re.IGNORECASE,
)
# Review of CF1: her own course is told with a verb of taking or leaving it ("I quit", "I tried",
# "I took", "I did a ..."), never with a common auxiliary or a time word ("I was hoping the course
# takes about three months", "I had hoped", "Last time I checked"): those are the product's length.
_OWN_COURSE_TAKEN = re.compile(
    r"\bi\s+(?:(?:once|already|also|actually|even)\s+)?(?:quit|tried|took|did (?:a|an|one|some)|"
    r"finished|completed|attended|enrolled in|signed up for|joined)\b",
    re.IGNORECASE,
)


def _another_course(folded: str, match: re.Match[str]) -> bool:
    """CF1: the course noun of a course-noun frame ``match`` names another course than THE one."""
    noun = _COURSE_NOUN.search(match.group(0))
    if noun is None:
        return False
    before = folded[: match.start() + noun.start()].split()[-3:]
    return any(_OTHER_COURSE_BEFORE.fullmatch(word.strip(",;:")) for word in before)


def course_length_unsaid(
    sentence: object,
    known: frozenset[float] = frozenset(),
    *,
    persona: RenderedPersona | None = None,
    own_course: bool = False,
) -> bool:
    """``sentence`` states a course length that is not one of the ``known`` (advisor) durations.

    M032 SWEEP-17 item 5: the product-statement form and the course-length frames above; a question
    is no exemption ("I can't keep up for six months, can I?").  Every figure in a matched frame
    must be known for the sentence to pass.  ``persona`` (the session's): her own timeline's
    durations pass the ambiguous frames (review S2P-R1).

    ``own_course`` (simulation diagnosis 2, CF1; the engine's R1_OWN_COURSE): the two course-noun
    frames skip a course that is not THE course ("a free Python course") and a sentence about her
    own course taken or left ("I quit", "gave up", "after about"; review of CF1: never a common
    auxiliary or "last", and the ambiguous frames keep H1's own-timeline exemption only).
    """
    folded = fold(sentence)
    if own_course:
        past = (
            _OWN_COURSE_TAKEN.search(folded) is not None
            or _OWN_LIFE_PAST.search(folded) is not None
        )
        spans = []
        for index, frame in enumerate(_COURSE_LENGTH_FRAMES):
            for match in frame.finditer(folded):
                if index in (1, 2) and (past or _another_course(folded, match)):
                    continue
                spans.append(match.group(0))
    else:
        spans = [
            match.group(0) for frame in _COURSE_LENGTH_FRAMES for match in frame.finditer(folded)
        ]
    own_life = _own_life_duration(folded, persona)
    if not own_life:
        spans.extend(
            match.group(0) for frame in _AMBIGUOUS_LENGTH_FRAMES for match in frame.finditer(folded)
        )
    if _COURSE_WORD.search(folded) and not _OWN_LIFE.search(folded):
        spans.extend(match.group(0) for match in _FOR_DURATION.finditer(folded))
    for span in spans:
        if any(not _duration_known(value, known) for value in durations_said(span)):
            return True
    return False
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
    # intent reply is built around a question of its own) and the hours-a-week figures the advisor
    # said (the learner may repeat them).
    recent_questions: tuple[bool, ...] = ()
    phrase_counts: tuple[tuple[str, int], ...] = ()
    free_reply: bool = False
    advisor_hours: frozenset[float] = frozenset()
    # R1-Q iteration 3.  The advisor's turn put a LOWER price on the table than any before it ("a
    # bit better" is only true then); the advisor said (almost) nothing after the learner's last
    # goodbye (a second goodbye is dropped); the advisor asked who else decides (the answer is
    # never dropped as a repeat).
    fresh_price: bool = False
    hollow: bool = False
    decider_asked: bool = False
    # R1-Q final review round 1.  The tracked phrases (``r1_text.reply_phrases``) of the learner's
    # last replies, oldest first (the spacing window of ``PHRASE_WINDOW``); and whether an earlier
    # sentence of THIS reply named the $7,000 (set by the stream guard).
    recent_phrases: tuple[tuple[str, ...], ...] = ()
    anchor_in_reply: bool = False
    # L5 (mock call aa166f09).  The latest monthly payment the advisor named (None: none): above
    # the card's budget it is never "workable" (``over_budget_accepted``).
    monthly_quote_usd: int | None = None
    # M032 S5.  Christy's praise of an answer is cut in the opening and the icebreaker (hygiene;
    # the session sets it from ``R1_INTERVIEWER_VOICE``), and an interviewer reply with nothing
    # usable left says this line (the icebreaker plan's current question) instead of
    # ``FALLBACK_REPLY`` ("" keeps the guard's own fallback).
    praise_check: bool = False
    interviewer_fallback: str = ""
    # M032 S2 (the engine's flags, read once per plan): ``voice_v2`` (R1_LEARNER_VOICE_V2) picks the
    # S2 replacement lines; ``tic_v2`` (R1_TIC_V2, SWEEP-12) reads the wider honesty tic and trims a
    # repeated soft tic in a free reply that carries no owed move (``carries_move``: the plan voices
    # or may complete one, so "actually help" stays for F3-PUSH's markers).
    voice_v2: bool = False
    tic_v2: bool = False
    carries_move: bool = False
    # Review S2R-4 (SWEEP-11): on a lone "okay" after her question she is told to ask it again in a
    # few words.  ``reask`` is that question's normalised sentences: a question of this reply that
    # repeats one of them is the asked-for re-ask, so it is neither a repeat nor cut by the diet.
    reask: tuple[str, ...] = ()
    # M032 SWEEP-7 (R1_COME_BACK): the reply comes back once to her question the advisor dodged.
    # A question of this reply that asks about that topic (``open_question_topics``) is the
    # asked-for come-back: the question diet and the near-repeat drop let it through (one question
    # still).
    reask_topic: str = ""
    # M032 SWEEP-6 (R1_PRICE_MEMORY): "I'll take the price as it stands" is a misreading (hygiene,
    # never a concession): she never says she will take the price.
    price_memory: bool = False
    # M032 S2P (SWEEP-17; the engine's latched R1_PROBE_FIRST): the card holds no course figure, so
    # the $9,000 is no longer an amount she may always say and "six months" no longer passes as a
    # card fact.  ``allowed_extra``: the amounts this reply may say all the same (a check or a
    # conflict the plan owes, or one she already said on such a path); ``advisor_durations``: the
    # course lengths, in months, the advisor said (or the plan owes), which she may refer to.
    probe_first: bool = False
    # Simulation diagnosis 2 (CF1; the engine's R1_OWN_COURSE): a course she took herself is no
    # course length (``course_length_unsaid``).
    own_course: bool = False
    # Simulation diagnosis 2 (ST1 (3); the engine's R1_STALL_MEMORY): a subordinate clause left
    # alone by a stall-quota cut goes with the clause it hung on (``_without_clauses``).
    orphan_clause: bool = False
    # Simulation diagnosis 2 (NAT1; the engine's R1_NO_BARE_REPROACH): the question diet never
    # leaves a bare reproach alone (``_bare_reproach``).
    bare_reproach: bool = False
    allowed_extra: frozenset[int] = frozenset()
    advisor_durations: frozenset[float] = frozenset()
    # M032 SWEEP-26 (R1_WRAPUP_ONE_MENTION; Christy in the wrap-up and the closing only): the hiring
    # team is named once, by L-CLOSE, so a model sentence that names it is replaced by
    # L-FAQ-DEFER-WRAP (or dropped after a sentence with content of its own), and the deflection
    # for a hiring or invented fact is L-FAQ-DEFER-WRAP as well.
    one_mention: bool = False
    # M032 S3.2 (R1_CLOSING_STATE): the advisor is closing the call (WINDING), so her reply is one
    # short goodbye: a goodbye is not dropped as said again (``closer_again``) and the stall-closer
    # quota does not cut "I'll get back to you" (``closing_exempt``, one reply).
    winding: bool = False
    closing_exempt: bool = False
    # M032 SWEEP-25 B (R1_COMMIT_REACTION_V2): the 19:00 reaction before the scripted WEAK line; a
    # sentence of it that says goodbye, that she has to go, that she will think it over or get back
    # to them, or asks for an e-mail is dropped (the WEAK line says that, once).
    reaction_only: bool = False
    # Simulation diagnosis 1 (R1_ECHO_GUARD, the engine's flag; off restores the release before).
    # ``advisor_terms``: the word stems of the advisor's latest turns (``advisor_terms_in``), so a
    # format, schedule or deep-need word she echoes from them is no invention (L1);
    # ``asked_her``: the advisor asked her something, or to enrol or book (an emptied reply may then
    # be the "thinking" line, U3); ``choice_offered``: the advisor's question offered her a choice,
    # so "I'll reach out myself" answers it and is no stall closer (U5).
    echo_guard: bool = False
    advisor_terms: frozenset[str] = frozenset()
    # The advisor's latest turns, folded (``advisor_text_of``; memory only): a deep-need marker
    # phrase is an echo only when his own words match it (review of L1 (b)).
    advisor_said: tuple[str, ...] = ()
    asked_her: bool = False
    choice_offered: bool = False
    # Simulation diagnosis 3 (each the engine's flag; off restores the release before).
    # ``question_diet_v2`` (R1_QUESTION_DIET_V2, D3-LRN-QDIET): the diet drops only a NEW-topic
    # question; a follow-up on the advisor's current turn (``followup_terms``, its content stems),
    # on a figure he put on the table this turn (``figure_now``), or a question whose statement
    # would only restate what she said, stays.
    question_diet_v2: bool = False
    followup_terms: frozenset[str] = frozenset()
    figure_now: bool = False
    # ``figure_memory`` (R1_FIGURE_MEMORY, D3-LRN-MONEY1): once F1-ANCHOR and F1-COUNTER are
    # delivered (``anchor_settled``), a second comparison with the $7,000 or with what she had
    # heard (``anchor_comments`` counts hers since) is dropped, and "what's included" is asked once
    # in three replies unless he named a new figure (``included_recent``).
    figure_memory: bool = False
    anchor_settled: bool = False
    anchor_comments: int = 0
    included_recent: bool = False
    # ``eased_ack_v2`` (R1_EASED_ACK_V2, D3-LRN-ACK1): "thanks for giving me the time / space /
    # room" is taken out of her reply.
    eased_ack_v2: bool = False
    # ``next_steps`` (R1_WRAPUP_NEXT_STEPS, D3-WRAP1; Christy's wrap-up and closing): a lead-in
    # ("Curious about that, so let me be straight with you.") is no answer, so a hiring-team
    # sentence after it still gets the deflection instead of leaving the reply hollow.
    next_steps: bool = False
    # ``price_heard`` (R1_FOREIGN_PRICE, D3-LRN-PRICE1): the advisor named a course price (in
    # dollars or in rupees), so "nobody has told me the price" / "I still haven't heard what it
    # costs" contradicts the call and is taken out.
    price_heard: bool = False
    # M032 diagnosis 3 (D3-ICE1).  Christy's echo-and-verdict reactions are trimmed in the opening
    # and the icebreaker (a style trim; the session sets it from ``R1_REACTION_VARIETY``), and the
    # first sentence of her last reply there ("" for none), for the same-shape check.
    reaction_check: bool = False
    previous_opening: str = ""
    # M032 diagnosis 3 (D3-GUARD-IB1, ``R1_GUARD_STORY_ECHO``; the session sets both).  The
    # candidate's turn this reply answers: a money figure or "scholarship" Christy echoes from it is
    # their story, not a claim about pay, and in the opening and the icebreaker a hiring or pay
    # sentence after a turn that asked nothing is dropped, never answered with the deflection.
    story_echo: bool = False
    candidate_text: str = ""
    # Simulation diagnosis 4 (each the engine's rollback flag, default ON):
    # ``anchor_time_aware`` (R1_ANCHOR_TIME_AWARE, D4-SEVEN1): "seven it is" is the $7,000 only
    # with money context and never a clock time; ``committed``: the commitment is on record, so a
    # misread sentence is dropped and never swapped for the price question.
    # ``contact_v2`` (R1_CONTACT_READER_V2, D4-CONTACT1): the narrow spoken e-mail reader, and the
    # form line only when the advisor asked for contact details.
    # ``short_on_time`` (R1_TIME_CUE_V3, D4-TIMECUE1): her time cue was said, so a free reply asks
    # no new-topic question and does not say the cue again.
    # ``decider_spacing`` (R1_DECIDER_SPACING, D4-DECIDER1): a commitment line that names her
    # decision maker is coming, so a free reply's decider clause is cut (never the only sentence).
    # ``clause_orphan_v2`` (R1_CLAUSE_ORPHAN_V2, D4-FRAG1): a cut never leaves "Since ..." alone.
    # ``come_back_v2`` (R1_COME_BACK_V2, D4-COMEBACK1): no "you've said X a couple of times".
    # ``f3_wording`` (R1_F3_WORDING, D4-F3STOCK1): "is a real commitment" once a call.
    anchor_time_aware: bool = False
    committed: bool = False
    contact_v2: bool = False
    short_on_time: bool = False
    decider_spacing: bool = False
    clause_orphan_v2: bool = False
    come_back_v2: bool = False
    f3_wording: bool = False
    # M032 diagnosis 4 (D4-ICE-ECHO1, ``R1_REACTION_VARIETY_V2``; the session sets both).  The wider
    # verdict trim, and the first sentences of her last two replies in the opening and the
    # icebreaker (newest last), for the echo-opener check.
    reaction_check_v2: bool = False
    previous_openings: tuple[str, ...] = ()
    # M032 diagnosis 5 (D5-ICE-AWITH1, ``R1_REACTION_VARIETY_V2``; the session sets it with
    # ``reaction_check_v2``): one of her earlier small-talk replies already opened a sentence with
    # "And with <their thing>," (``with_opener``), so any further one loses that clause.
    with_opener_used: bool = False
    # D4-TRANS-Q1 (``R1_TRANSITION_ANSWERS``; the session sets both, with ``candidate_text``).  In
    # the transition a blocked sentence after a turn that asked nothing is dropped (never the
    # hiring-team deflection), and the "happy to go over ..." offer once made is cut.
    transition_quiet_drop: bool = False
    offer_phrase_used: bool = False
    # Simulation diagnosis 5 (each the engine's rollback flag, default ON):
    # ``guard_tidy_v3`` (R1_GUARD_TIDY_V3, D5-GUARD-GARBLE1): "I'll say that much" is cut whole, and
    # a surface line that stood in for a blocked need is never said twice in one reply.
    # ``contentless`` (R1_NO_ANSWER_READ, D5-LRN-ASSUME1): the advisor's turn told her nothing (a
    # fragment, a filler or "let me clarify that"), so a first sentence that treats it as an answer
    # ("Good to know ...", "Right, so it's ...") goes.
    # ``ack_press`` (R1_ACK_PRESS, D5-LRN-ACKFALL1) and ``advisor_hollow``: his turn was a lone
    # "Okay." after her question, so a reply emptied of its re-asked question presses gently
    # (``PRESS_REPLIES``) instead of a bare "Mm-hmm.".
    # ``topic_recent`` (R1_TOPIC_REPEAT, D5-LRN-TOPICREP1): the still-unanswered topics she raised
    # in one of her last two replies; a free reply does not raise them again beside something else.
    # ``bye_heard`` (R1_POST_BYE_QUIET, D5-LRN-POSTBYE1): the advisor said goodbye, so a free reply
    # opens no new-topic question.
    guard_tidy_v3: bool = False
    contentless: bool = False
    ack_press: bool = False
    advisor_hollow: bool = False
    topic_recent: frozenset[str] = frozenset()
    bye_heard: bool = False

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
    # M032 SWEEP-12: soft tics trimmed from this reply (a count, logged in session_facts).
    soft_tic_trims: int = 0
    # Simulation diagnosis 2 (NAT1): questions kept because only a bare reproach was left (a count).
    bare_keeps: int = 0

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
    bare_keeps: int = 0

    def record(self, result: GuardResult) -> None:
        self.style_edits += result.style_edits
        self.bare_keeps += result.bare_keeps
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
            # NAT1: questions kept beside a bare reproach (counts only).
            "bare_keeps": self.bare_keeps,
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
    if evaluation.search(sentence) and not (
        ctx.echo_guard and ctx.is_learner and _course_work_graded(sentence)
    ):
        hits.append(_hit(EVALUATION, "scoring_vocabulary", sentence))
    if has_contact_detail(sentence, narrow=ctx.contact_v2):
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
    if (
        not question
        and _states_hiring_or_pay(sentence)
        and not (
            ctx.story_echo
            and ctx.phase in SMALL_TALK_PHASES
            and echoes_candidate_story(sentence, ctx.candidate_text)
        )
    ):
        hits.append(_hit(HIRING_COMP, "hiring_or_compensation", sentence))
    elif not question and _unapproved_role_fact(sentence):
        hits.append(_hit(INVENTED_FACT, "role_fact_beyond_deck", sentence))
    if question and _PROTECTED.search(sentence):
        hits.append(_hit(PROTECTED_QUESTION, "protected_class", sentence))
    if (
        ctx.one_mention
        and ctx.phase in ONE_MENTION_PHASES
        and _HIRING_TEAM.search(sentence) is not None
    ):
        hits.append(_hit(HIRING_MENTION, "hiring_team_mention", sentence))
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


# D3-GUARD-IB1 (int-live-3 mix t15): the candidate's own story ("around three lakh rupees, so my
# manager approved a scholarship") echoed back tripped the pay rule, and the reply opened with
# "That's a good question for the hiring team" to a turn that asked nothing.  The money figures and
# the scholarship words an echo may carry; bounded quantifiers only.  Review of diagnosis 3
# (D3-GUARD-IB1-LEAK): a number is a money figure only with a currency sign or a money unit, never
# bare ("one more round" must not license "in one week").
_STORY_NUMBER = (
    r"(?:\d[\d,.]{0,12}|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|a)"
)
_STORY_TERM = _ci(
    r"(?:\$|\u20b9|\brs\.?|\binr)\s?\d[\d,.]{0,12}(?:\s?(?:lakhs?|lacs?|crores?|thousand|k)\b)?",
    r"\b" + _STORY_NUMBER + r" (?:lakhs?|lacs?|crores?|thousand|rupees|dollars)\b",
    r"\b\d[\d,.]{0,12}k\b",
    r"\b(?:lakhs?|lacs?|crores?|rupees?|inr|scholarships?)\b",
)
# A sentence about THIS role, the future or a rate of pay is never an echo of the candidate's
# story, whatever figure it repeats ("The role pays three lakh.", "Three lakh a year here.").
_NOT_THEIR_STORY = _ci(
    r"\b(?:a|per|each|every) (?:year|month|annum)\b|\b(?:monthly|yearly|annually|annual)\b",
    r"\bhere\b|\bin[- ]hand\b|\btake[- ]home\b|\bearns?\b|\bearning\b|\bpackage\b|\boffer\w*\b",
    r"\byou (?:get|make|take)\b|\bpays?\b|\bpaying\b|\bctc\b|\bsalar(?:y|ies)\b",
)
# What an echo of the candidate's story is answered with when the sentence that went before the
# question was dropped (the question alone after a story sounds abrupt).
STORY_ACK = "Got it."


def guard_story_echo_enabled() -> bool:
    """``R1_GUARD_STORY_ECHO`` (default on; M032 diagnosis 3, D3-GUARD-IB1): Christy's echo of the
    candidate's own money figure or scholarship is not a pay claim, and in the opening and the
    icebreaker a hiring or pay sentence after a turn that asked nothing is dropped (with "Got it."
    before the question that follows), never answered with "That's a good question for the hiring
    team".  Read at use.  Rollback: ``fly secrets set R1_GUARD_STORY_ECHO=0 -a
    project-hello-voice`` (every such sentence gets the deflection, as before)."""
    return (os.getenv("R1_GUARD_STORY_ECHO") or "1").strip().lower() not in {
        "0", "off", "false", "no"
    }
_ACK_OPENER = _ci(r"^(?:got it|okay|ok|right|i see|sure|mm-?hmm|thanks|thank you|understood)\b")


def echoes_candidate_story(sentence: str, candidate_text: str) -> bool:
    """D3-GUARD-IB1: ``sentence`` names only money figures or scholarship words the candidate's
    own turn named (a turn that asked nothing: their story), and without them it states no hiring
    or pay fact (``_states_hiring_or_pay``).
    "Three lakh for one course." after "around three lakh rupees" is their story; "The role pays
    three lakh." is not, and neither is a "salary" they never said.  Review of diagnosis 3
    (D3-GUARD-IB1-LEAK): a sentence with any cue that it is about the role, the future or a rate of
    pay (``_ABOUT_THE_ROLE_OR_FUTURE``, ``_NOT_THEIR_STORY``) is never exempt, and a bare number
    word is no figure (only a currency sign or a money unit makes one)."""
    if not candidate_text or _turn_asks(candidate_text):
        return False  # a figure they ASKED about is never echoed back unguarded
    folded = fold(sentence)
    if _ABOUT_THE_ROLE_OR_FUTURE.search(folded) or _NOT_THEIR_STORY.search(folded):
        return False
    terms = {normalize(match.group(0)) for match in _STORY_TERM.finditer(folded)}
    terms.discard("")
    if not terms:
        return False
    told = f" {normalize(candidate_text)} "
    if any(f" {term} " not in told for term in terms):
        return False
    return not _states_hiring_or_pay(_STORY_TERM.sub(" ", folded))


def _turn_asks(text: str) -> bool:
    """The candidate's turn asks something (a question mark, or a question without one)."""
    return "?" in text or any(is_question_like(part) for part in split_sentences(text))


def turn_asks(text: str) -> bool:
    """Public ``_turn_asks`` (the session's D4-TRANS-Q1 fallback choice)."""
    return _turn_asks(text)


# Review of diagnosis 5 (D5-DEFLECT1-R2): a question the speech-to-text leaves unmarked, read only
# by the deflection cut: Hindi question words ("Salary kya hoga is role mein"), an indirect ask
# ("I have a question about the pay"), or a terse turn of a few words that names a role topic
# ("and the pay").  The model said the deflection because it heard a question; the cut must not
# overrule it.  A longer story that names pay ("The pay at my last job was really low") asks
# nothing.
_HINDI_QUESTION_WORD = re.compile(
    r"\b(?:kya|kitna|kitni|kitne|kab|kaise|kaisa|kaisi|kaun|kaunsa|kaunsi|kahan|kidhar|kyun|"
    r"kyon|kyu)\b"
)
_INDIRECT_ASK = re.compile(
    r"\b(?:(?:a|one|some|few|couple of|quick|small) questions?|(?:want|wanted|would like|d like|"
    r"like) to (?:ask|know|check|understand)|wondering|curious (?:about|to know)|(?:can|could|"
    r"would) you (?:tell|explain|share|clarify)|tell me (?:more )?about (?:the|this|that)|"
    r"i (?:need|want) to understand)\b"
)
_ROLE_TOPIC = re.compile(
    r"\b(?:pay|salary|salaries|ctc|package|incentives?|commissions?|stipend|bonus|work mode|wfh|"
    r"work from home|remote|hybrid|office|training|timelines?|next steps?|joining|shifts?|timings?|"
    r"hours|leaves?|holidays?)\b"
)
_TERSE_ASK_WORDS = 5


def _turn_may_ask(text: str) -> bool:
    """D5-DEFLECT1 (review): ``_turn_asks``, or a question without the mark (see above)."""
    if _turn_asks(text):
        return True
    said = normalize(text)
    if _HINDI_QUESTION_WORD.search(said) or _INDIRECT_ASK.search(said):
        return True
    return word_count(text) <= _TERSE_ASK_WORDS and _ROLE_TOPIC.search(said) is not None


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


def _card_fact_only(
    sentence: str, allowed: frozenset[int], durations: frozenset[float] | None = None
) -> bool:
    """True when every number in ``sentence`` is a public-card fact (9,000 / six months).

    M032 SWEEP-17: with ``durations`` (probe first) a course length passes only when the advisor
    said it (its months are in ``durations``); without, "six months" is the card's, as before.
    """
    amounts = dollar_amounts(sentence)
    if any(amount not in allowed for amount in amounts):
        return False
    if durations is None:
        without = _CARD_DURATION.sub(" ", sentence)
        said_length = _CARD_DURATION.search(sentence) is not None
    else:
        lengths = durations_said(sentence)
        if any(not _duration_known(value, durations) for value in lengths):
            return False
        without = _DURATION.sub(" ", sentence)
        said_length = bool(lengths)
    without = re.sub(r"\$\s?[\d,]+(?:\.\d+)?\s*k?", " ", without)
    return not re.search(r"\d", without) and bool(amounts or said_length)


def _is_product_statement(
    sentence: str, allowed: frozenset[int], durations: frozenset[float] | None = None
) -> bool:
    """A declarative about the product.  Only the website's price and duration pass.

    "The course is around $9,000" and "about six months" are on the card.  Any other
    subject (capstone, classes, instructors, cohort ...) or any other number is a fact
    the learner must not assert, even when it happens to agree with the deck.  M032 SWEEP-17
    (``durations``, probe first): the card holds neither, so only the figures the advisor said
    (or a note allows) pass.
    """
    match = _PRODUCT_SUBJECT.search(sentence)
    if match is None or _OPINION.search(sentence):
        return False
    if match.group("noun").lower() in _CARD_NOUNS and _card_fact_only(sentence, allowed, durations):
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


# The R1-Q iteration 2 misread rules read ordinary spoken sentences only (a learner sentence is
# 45 words at most): a runaway sentence skips them, which also bounds their cost on hostile text.
MISREAD_MAX_CHARS = 1200


def _iteration_two_misreads(sentence: str, ctx: GuardContext) -> list[Hit]:
    """Misreadings the second live sweep found (hygiene hits: never posted, never a leak).

    Ship-gate round 1 took out ``monthly_unstated`` ("That still sounds like a lot per month" when
    no monthly figure was named): with a bare "a lot" as a strain word it replaced the learner's
    reaction to an instalment offer ("Yes, monthly payments would help a lot.": 6 of 6 natural
    replies, 0 on main) with a thinking filler, right after the advisor handled the objection.
    """
    hits: list[Hit] = []
    if (
        ctx.offer_usd is not None
        and ctx.offer_usd <= 7000
        and _PRICE_STRAIN.search(sentence) is not None
        and _TIME_TOPIC.search(sentence) is None
    ):
        hits.append(_hit(MISREAD, "strain_after_met", sentence))
    elif _accepts_over_budget(sentence, ctx):
        hits.append(_hit(MISREAD, "over_budget_accepted", sentence))
    return hits


def _accepts_over_budget(sentence: str, ctx: GuardContext) -> bool:
    """The learner calls a monthly payment above her card's budget workable (L5).

    Only while the advisor's latest monthly figure is above ``MONTHLY_BUDGET_MAX_USD``, and only a
    plain statement: a question, a negated one ("that's not really workable"), a supposition ("it
    would be doable if it were $600") and one about the schedule alone pass.
    """
    if ctx.monthly_quote_usd is None or ctx.monthly_quote_usd <= MONTHLY_BUDGET_MAX_USD:
        return False
    if is_question_like(sentence) or _SUPPOSED.search(sentence) is not None:
        return False
    folded = fold(sentence)
    if _SCHEDULE_ONLY.search(folded) is not None and _MONEY_WORD.search(folded) is None:
        return False
    return any(
        not negated_before(folded, match.start()) for match in _PAYMENT_OK.finditer(folded)
    )


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


# M032 SWEEP-6: she says she will take the price ("so it's fine, I'll take the price as it
# stands").  Not "I'll take the price list home", not a negated or questioned one, and not taking
# it somewhere ("I'll take that number to my husband", "I'll take the figure back to Rohan": the
# decision-maker talk of review S7L-R5).
_PRICE_ACCEPTED = re.compile(
    r"\bi'?ll (?:take|accept|go with|pay) (?:the|that|your|this) "
    r"(?:price|number|figure|amount|rate)\b(?!\s*(?:list|sheet|breakdown|details|back|home|to|"
    r"with|by|into|in|down|away|over|up|and (?:think|talk|discuss|check|run|chat|share))\b)",
    re.IGNORECASE,
)


def _price_accepted(sentence: str, ctx: GuardContext) -> bool:
    """SWEEP-6 (``price_memory``): an unconditional "I'll take the price" in her reply.

    Like ``has_concession`` it honours a negator or a doubt frame earlier in the clause and a
    question; it is skipped on a confirmation and once a STRONG commitment is on record.
    """
    if not ctx.price_memory or ctx.confirm or ctx.commitment_cap >= Level.STRONG:
        return False
    if is_question_like(sentence):
        return False
    folded = fold(sentence)
    return any(
        not negated_before(folded, match.start())
        and _DOUBT_FRAME.search(clause_before(folded, match.start())) is None
        for match in _PRICE_ACCEPTED.finditer(folded)
    )


def _iteration_three_misreads(sentence: str, ctx: GuardContext) -> list[Hit]:
    """Misreadings the third live sweep found (hygiene hits: never posted, never a leak)."""
    hits: list[Hit] = []
    if _price_accepted(sentence, ctx):
        hits.append(_hit(MISREAD, "price_accepted", sentence))
    if ctx.hollow and not ctx.winding and CLOSER.search(sentence) is not None:
        # M032 S3.2: while the advisor closes the call her one goodbye is the reply's job.
        hits.append(_hit(MISREAD, "closer_again", sentence))
    if _I_CALLED.search(sentence) is not None:
        hits.append(_hit(MISREAD, "learner_called", sentence))
    return hits


def _learner_hits(sentence: str, ctx: GuardContext) -> list[Hit]:
    hits: list[Hit] = []
    if _LEARNER_META.search(sentence):
        hits.append(_hit(META, "learner_meta", sentence))
    if ctx.reaction_only and says_goodbye_or_sends(sentence):
        # M032 SWEEP-25 B: the 19:00 reaction says no goodbye, no "I have to go" and no e-mail
        # request (the scripted WEAK line follows and says that, once).  Hygiene: the sentence is
        # dropped; an emptied reaction leaves the WEAK line alone (``quiet_empty``).
        hits.append(_hit(MISREAD, "reaction_leave_taking", sentence))
    persona = ctx.persona
    if persona is not None:
        for topic in H_TOPICS:
            # A need that was already told is told: saying it again discloses nothing (R1-Q final
            # review round 1: the sentence about the kids was blocked at ex9 after it had been
            # revealed at ex8, and the sentence that leaned on it was left dangling).
            if topic in ctx.released_topics or topic in ctx.spent_topics:
                continue
            matches = [
                (pattern, match)
                for pattern in persona.markers(topic)
                for match in pattern.finditer(sentence)
            ]
            if ctx.echo_guard and matches:
                # Simulation diagnosis 1 (L1 (b)): "evenings and weekends" right after the advisor
                # said that phrase is his schedule echoed, not her deep need told.
                matches = [
                    (p, m) for p, m in matches if not _marker_echoed(p, m, ctx.advisor_said)
                ]
            if matches:
                hits.append(_hit(VOLUNTEERED_NEED, topic, sentence))
                break
    level = classify_learner_commitment(sentence)
    if level > ctx.commitment_cap:
        hits.append(_hit(COMMITMENT, f"level_{level.name.lower()}", sentence))
    if has_concession(sentence):
        hits.append(_hit(CONCESSION, "resolution_phrasing", sentence))
    question = is_question_like(sentence)
    card = _CARD_AMOUNTS_V2 if ctx.probe_first else _CARD_AMOUNTS
    allowed = card | ctx.advisor_amounts | ctx.allowed_extra
    if persona is not None:
        allowed = allowed | persona.card_amounts  # her salary (M4)
    durations = ctx.advisor_durations if ctx.probe_first else None
    length_unsaid = False
    if not question:
        echo = ctx.echo_guard
        if _FORMAT_FACT.search(sentence) and not (
            echo and _format_echoed(sentence, ctx.advisor_terms)
        ):
            hits.append(_hit(INVENTED_FACT, "format_or_schedule_claim", sentence))
        elif _is_product_statement(sentence, allowed, durations):
            if durations is not None and not _is_product_statement(
                sentence, allowed, durations | durations_said(sentence)
            ):
                # M032 SWEEP-17 item 5: its only offending figure is a course length the advisor
                # never said ("The course is about six months long."): hygiene, not a leak.
                length_unsaid = True
            else:
                hits.append(_hit(INVENTED_FACT, "product_statement", sentence))
        elif _CLAIM_WORDS.search(sentence) and not (echo and _claim_not_asserted(sentence)):
            hits.append(_hit(INVENTED_FACT, "outcome_or_policy_claim", sentence))
    if ctx.probe_first and not length_unsaid and len(sentence) <= MISREAD_MAX_CHARS:
        # SWEEP-17 item 5: a course-length frame ("keep up for six months"; questions too).
        length_unsaid = not any(
            hit.rule == "product_statement" for hit in hits
        ) and course_length_unsaid(
            sentence, ctx.advisor_durations, persona=persona, own_course=ctx.own_course
        )
    if length_unsaid:
        hits.append(_hit(COURSE_FACT, "course_length_unsaid", sentence))
    if _HOURS_A_WEEK.search(sentence) and not question and not _hours_are_advisors(sentence, ctx):
        hits.append(_hit(INVENTED_FACT, "own_availability_figure", sentence))
    elif any(amount not in allowed for amount in dollar_amounts(sentence)):
        hits.append(_hit(INVENTED_FACT, "amount_off_card", sentence))
    if ctx.confirm and (question or _reopens(sentence)):
        hits.append(_hit(REOPEN, "confirm_only", sentence))
    if _TIME_REVERSAL.search(sentence) is not None:
        hits.append(_hit(MISREAD, "time_cue_reversed", sentence))
    if len(sentence) <= MISREAD_MAX_CHARS:
        hits.extend(_iteration_two_misreads(sentence, ctx))
    if ctx.nothing_granted and _GRANT_GRATITUDE.search(sentence) is not None:
        hits.append(_hit(MISREAD, "gratitude_for_nothing", sentence))
    if (ctx.offer_usd is None or ctx.offer_usd > 7000) and _anchor_taken_as_offer(sentence, ctx):
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
    # M032 SWEEP-8: both card wordings stay allowed, so a session on either release is clean.
    answers = [answer for _, answer in PUBLIC_ANSWERS]
    if persona.temperament is not None:
        answers.append(persona.temperament.timeline_answer)
    answers.append(SUCCESS_ANSWER_V2)
    answers.append(persona.persona.prior_learning)
    answers.extend(persona.surface(topic) for topic in H_TOPICS)
    answers.append(persona.decider_answer)
    answers.extend(answer for _label, answer in persona.work_answers)
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
    if (
        not ctx.is_learner
        and ctx.one_mention
        and ctx.phase in ONE_MENTION_PHASES
        and categories & {HIRING_COMP, INVENTED_FACT, HIRING_MENTION}
    ):
        return FAQ_DEFER_WRAP_LINE  # M032 SWEEP-26: L-CLOSE is the one mention of the hiring team
    if not ctx.is_learner and categories & {HIRING_COMP, INVENTED_FACT}:
        if (
            ctx.story_echo
            and ctx.phase in SMALL_TALK_PHASES
            and ctx.candidate_text
            and not _turn_asks(ctx.candidate_text)
        ):
            return ""  # D3-GUARD-IB1: nobody asked, so there is nothing to defer: dropped
        if (
            ctx.transition_quiet_drop
            and ctx.phase == "transition"
            and ctx.candidate_text
            and not _turn_asks(ctx.candidate_text)
        ):
            return ""  # D4-TRANS-Q1: a comment or complaint, not a question: nothing to defer
        return INTERVIEWER_DEFLECTION
    if ctx.is_learner and ctx.persona is not None:
        need = next((hit for hit in hits if hit.category == VOLUNTEERED_NEED), None)
        if need is not None:
            return "" if need.rule in ctx.spent_topics else ctx.persona.surface(need.rule)
    if ctx.is_learner and CONTACT in categories:
        if ctx.contact_v2 and not _contact_asked(ctx):
            return ""  # D4-CONTACT1: nobody asked for her details, so the sentence just goes
        return CONTACT_REPLACEMENT
    if ctx.is_learner and MISREAD in categories:
        rule = next(hit.rule for hit in hits if hit.category == MISREAD)
        if rule == "anchor_taken_as_offer":
            if ctx.anchor_time_aware and (ctx.committed or ctx.confirm):
                return ""  # D4-SEVEN1: the price is settled; never ask it again
            return ANCHOR_REPLACEMENT
        if rule == "gratitude_for_nothing":
            return GRATITUDE_REPLACEMENT
        budget = BUDGET_REPLACEMENT_V2 if ctx.voice_v2 else BUDGET_REPLACEMENT
        if rule == "over_budget_accepted" and repeat_kind(budget, ctx.said) is None:
            return budget
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
    return ctx.interviewer_fallback or FALLBACK_REPLY


# Simulation diagnosis 5 (D5-LRN-ACKFALL1, R1_ACK_PRESS): what she says when her question met a
# lone "Okay." and her re-ask was dropped as a repeat.  Rotated; a line she already said is skipped.
PRESS_REPLIES = (
    "Sorry, did you catch my question?",
    "So, any thoughts on that?",
    "I'm still curious about that one.",
)


def _press_line(ctx: GuardContext) -> str | None:
    """D5-LRN-ACKFALL1: a rotated press line she has not said yet, or None once each was said
    (int-offline-7: the first came back word for word; after the third press she acknowledges)."""
    for offset in range(len(PRESS_REPLIES)):
        candidate = pick_variant(PRESS_REPLIES, ctx.seed, ctx.variant + offset)
        if repeat_kind(candidate, ctx.said) is None:
            return candidate
    return None


# D5-LRN-ASSUME1 (R1_NO_ANSWER_READ): a first sentence that takes a contentless advisor turn as an
# answer ("Good to know the class size is manageable", "Right, so it's more cohort-based").
_ASSUMED_ANSWER = re.compile(
    r"^\W*(?:(?:okay|oh|ah|ok)[,.]?\s+)?(?:(?:good|great|nice) to (?:know|hear)|glad to hear|"
    r"that'?s (?:good|great|reassuring|nice) to (?:know|hear)|right,? so\b|so it'?s\b|"
    r"sounds like (?:it'?s|you)\b)",
    re.IGNORECASE,
)
# Review D5R-4: what NO_ANSWER_NOTE itself asks for (the line cut out) is never an assumed answer.
_LINE_CUT = re.compile(
    r"\b(?:cut (?:out|off)|broke up|break(?:ing)? up|dropp?(?:ed)? out|froze|frozen|lost you|"
    r"(?:the )?(?:line|connection|signal|audio)\b|didn'?t (?:catch|hear|get) (?:that|it|you|the))",
    re.IGNORECASE,
)
# Review D5R-4: a reply emptied only because its first sentence assumed an answer says the line cut
# out (what NO_ANSWER_NOTE asks for) instead of a bare "Okay.".  Rotated; never "Sorry, what were
# you saying?" (banned for her in R1-Q iteration 3).
CUT_OUT_REPLIES = (
    "Sorry, I think you cut out there.",
    "Sorry, I lost you for a second there.",
)


def _cut_out_line(ctx: GuardContext) -> str:
    """Review D5R-4: a rotated cut-out line she has not said yet (the first if both were said)."""
    for offset in range(len(CUT_OUT_REPLIES)):
        candidate = pick_variant(CUT_OUT_REPLIES, ctx.seed, ctx.variant + offset)
        if repeat_kind(candidate, ctx.said) is None:
            return candidate
    return pick_variant(CUT_OUT_REPLIES, ctx.seed, ctx.variant)
# D5-LRN-TOPICREP1 (R1_TOPIC_REPEAT): the topics she keeps raising while the advisor dodges them.
TOPIC_PATTERNS = {
    # Review D5R-3: "a month" only after money words ("pay a month", "how much a month"), never
    # "I could start in a month or so"; "keep up" never "with my job"; "number" never "number of".
    "monthly": re.compile(
        r"\bmonthly\b|\b(?:per|each|every) month\b|\bmonth by month\b|"
        r"\b(?:pay|paying|cost|costs|much|amount|figure|fee|emi|that|it|\d[\d,]*|thousand|"
        r"hundred|rupees|dollars)\b[^.?!]{0,15}\ba month\b",
        re.IGNORECASE,
    ),
    "price": re.compile(
        r"\b(?:total|final|full|real|actual|exact|overall)\b[^.?!]{0,25}\b(?:price|cost|figure|"
        r"number|amount|fee)s?\b(?!\s+of\b)|"
        r"\bhow much\b[^.?!]{0,30}\b(?:cost|pay|is it|would it be|are we)\b",
        re.IGNORECASE,
    ),
    "included": re.compile(
        r"\bwhat(?:'s| is| would be| does it)? (?:actually |exactly |really )?(?:included|"
        r"include)\b|\bwhat (?:do|would) i (?:actually |really )?get\b",
        re.IGNORECASE,
    ),
    "class_size": re.compile(
        r"\b(?:class|batch|cohort|group) sizes?\b|\bhow many (?:people|learners|students)\b|"
        r"\bhow (?:big|large|small) (?:is|are) (?:the |a )?(?:class|batch|cohort|group)",
        re.IGNORECASE,
    ),
    "fall_behind": re.compile(
        r"\bfall(?:s|ing)? behind\b"
        r"|\bkeep(?:ing)? up\b(?!\s+with\s+(?:my|our|his|her|their|the) (?:job|work|family|kids|"
        r"bills|rent|life|day job|office))"
        r"|\bmiss(?:ing)? (?:a |some )?"
        r"(?:class|classes|session|sessions)\b",
        re.IGNORECASE,
    ),
    "schedule": re.compile(
        r"\bschedule\b[^.?!]{0,25}\b(?:packed|full|tight|busy|hectic)\b|"
        r"\b(?:packed|tight|busy|hectic) schedule\b",
        re.IGNORECASE,
    ),
}


def topics_raised(text: object) -> frozenset[str]:
    """D5-LRN-TOPICREP1: the topics (``TOPIC_PATTERNS``) the learner's ``text`` raises."""
    folded = fold(text)
    return frozenset(topic for topic, pattern in TOPIC_PATTERNS.items() if pattern.search(folded))


# M032 SWEEP-17: what an emptied free reply asks instead of the course length it was dropped for.
LENGTH_PROBES = ("How long does the course run?", "How long is the course, by the way?")


def _length_probe(ctx: GuardContext) -> str:
    """A rotated length question the learner has not asked yet (the first if both were asked)."""
    for offset in range(len(LENGTH_PROBES)):
        candidate = pick_variant(LENGTH_PROBES, ctx.seed, ctx.variant + offset)
        if repeat_kind(candidate, ctx.said) is None:
            return candidate
    return pick_variant(LENGTH_PROBES, ctx.seed, ctx.variant)


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
        self._anchor_seen = False  # an earlier sentence of this reply named the $7,000
        # M032 S5: the praising sentences this reply lost whole (``_cut_praise``), and whether the
        # praise check is off for the rest of the reply (``flush``'s last resort).
        self._praise_dropped: list[str] = []
        self._praise_off = False
        self._soft_tic_trims = 0  # M032 SWEEP-12: soft tics taken out of this reply
        self._bare_keeps = 0  # Simulation diagnosis 2 (NAT1): questions kept beside a bare reproach
        self._length_drops = 0  # M032 SWEEP-17: sentences dropped for a course length unsaid
        self._anchor_comments = 0  # D3-LRN-MONEY1: settled-price comparisons kept in this reply
        # D3-ICE1: the summary reactions this reply lost whole (``_cut_summary``; never the only
        # sentence, ``flush`` gives them back), whether that trim is off for the rest of the reply,
        # and how many sentences were vetted (the first is the reply's opener).
        self._summary_dropped: list[str] = []
        self._summary_off = False
        self._vetted = 0
        # D3-GUARD-IB1: the reply's first sentence was a pay echo dropped after a turn that asked
        # nothing, so the next sentence kept opens with ``STORY_ACK``.
        self._story_ack_owed = False
        self._surfaces: list[str] = []  # D5-GUARD-GARBLE1: surface lines said in place of a need
        self._repeat_question_dropped = False  # D5-LRN-ACKFALL1: a dropped repeat asked something
        self._topic_held = ""  # D5-LRN-TOPICREP1: the first sentence held back as a topic repeat
        self._assumed_drops = 0  # review D5R-4: first sentences dropped as an assumed answer
        # D5-ICE-AWITH1: a sentence of this reply already opened with "And with <their thing>,".
        self._with_opener_seen = False
        # D5-DEFLECT1: her own hiring-team deflection, dropped after a turn that asked nothing
        # (``_cut_self_deflection``; never the only sentence, ``flush`` gives it back).
        self._deflection_dropped: list[str] = []

    def _phrase_count(self, key: str) -> int:
        """How often the tracked phrase ``key`` was used in the call so far (this reply too)."""
        return dict(self.ctx.phrase_counts).get(key, 0) + self._phrases_used.get(key, 0)

    def _stall_blocked(self, key: str) -> bool:
        """The stall phrase ``key`` is over its quota, too close to its last use, or used here."""
        if self._phrases_used.get(key, 0) >= 1:
            return True  # one voicing of a stall per reply
        if self._phrase_count(key) >= PHRASE_QUOTA[key]:
            return True
        recent = self.ctx.recent_phrases[-PHRASE_WINDOW[key] :]
        return any(key in phrases for phrases in recent)

    def _stall_quotas(self, text: str) -> str:
        """``text`` without the stall clauses that are over their quota ("" when nothing is left).

        Only a free reply is held to it: an owed move (an intent reply) voices its reason once by
        design, and the answer to "who else decides?" is the card's answer whenever it is asked.
        """
        ctx = self.ctx
        if not ctx.free_reply:
            return text
        for key, pattern in _STALL_PATTERNS.items():
            if pattern.search(text) is None:
                continue
            if key == PHRASE_DECIDER_STALL and ctx.decider_asked:
                recent = any(key in phrases for phrases in ctx.recent_phrases[-2:])
                if ctx.decider_spacing and recent and self._emitted:
                    # D4-DECIDER1: she said it in one of her last two lines (a push or a
                    # commitment line too): asked again, the rest of her answer stands and the
                    # stall is not said a third time; never the only sentence.
                    text = _without_clauses(
                        text, pattern, orphans=ctx.orphan_clause, orphan_tail=ctx.clause_orphan_v2
                    )
                    if not text:
                        return ""
                    continue
                self._phrases_used[key] = self._phrases_used.get(key, 0) + 1
                continue
            if key == PHRASE_STALL_CLOSER and (
                ctx.closing_exempt or (ctx.echo_guard and ctx.choice_offered)
            ):
                # M032 S3.2: the advisor closed the call, so "I'll get back to you, bye" is her
                # plain goodbye for this one reply, not the stall loop.  Simulation diagnosis 1
                # (U5): his question offered her a choice, so "I'll reach out myself" answers it.
                self._phrases_used[key] = self._phrases_used.get(key, 0) + 1
                continue
            if self._stall_blocked(key):
                cut_first = _first_clause_matches(text, pattern)
                text = _without_clauses(
                    text, pattern, orphans=ctx.orphan_clause, orphan_tail=ctx.clause_orphan_v2
                )
                if text and ctx.echo_guard and cut_first and _points_back(text):
                    # U5: "I'll reach out myself ..., that suits me better." leaves "That suits me
                    # better." pointing at the clause just cut before it.  A "that" clause the cut
                    # came after ("That's too much for me, I'll get back to you.") points at what
                    # the advisor said and is her reaction: it stays (review of U5).
                    text = ""
                if not text:
                    return ""
            else:
                self._phrases_used[key] = self._phrases_used.get(key, 0) + 1
        return text

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
        if ctx.echo_guard and is_echo_question(text, ctx.advisor_terms):
            # Simulation diagnosis 1 (U2): "Wait, $1,000?" repeats his words back; it is not the
            # reply's one question, so the real one after it is still asked.
            return False
        if self._questions_kept >= 1:
            return True
        if (
            ctx.free_reply
            and self._emitted
            and any(ctx.recent_questions[-QUESTION_DIET_WINDOW:])
            and not ctx.reask
            and not self._comes_back(text)
            # "Okay." and the question is the whole reply: dropping the question would leave a bare
            # acknowledgement, so the question stays.
            and word_count(" ".join(self._emitted)) > THIN_REPLY_WORDS
            # A question about the price, asked before the advisor has put any price on the table,
            # always stays (R1-Q iteration 3: "what the total cost actually comes to?" was dropped).
            and not (ctx.offer_usd is None and _PRICE_QUESTION.search(text) is not None)
            # Simulation diagnosis 3 (D3-LRN-QDIET): the diet is for a NEW topic; her follow-up
            # on what he just said stays.
            and not (ctx.question_diet_v2 and self._follow_up(text))
        ):
            if ctx.bare_reproach and _bare_reproach(" ".join(self._emitted)):
                # Simulation diagnosis 2 (NAT1): dropping it would leave a curt reproach alone
                # ("That's not really what I was asking about, honestly."), so her question stays.
                self._bare_keeps += 1
                self._questions_kept += 1
                return False
            return True
        self._questions_kept += 1
        if template:
            self._phrases_used[PHRASE_TEMPLATE_Q] = self._phrases_used.get(PHRASE_TEMPLATE_Q, 0) + 1
        return False

    def _follow_up(self, question: str) -> bool:
        """D3-LRN-QDIET: ``question`` reacts to the advisor's current turn, or without it the reply
        would only restate what she already said.

        (a) it shares a specific content word with his turn ("the free part ... why would that be
        on the table?" after he offered a free month); (b) the statement before it repeats one of
        her earlier lines, or names the $7,000 she already named; (c) he put a figure on the table
        this turn and she asks what she would pay.
        """
        ctx = self.ctx
        about = question
        if self._emitted and _POINTING_WORD.search(question) is not None:
            # "Why would that be on the table?" asks about the sentence before it ("the free
            # month is what's throwing me"): that sentence's words are the question's subject.
            about = f"{self._emitted[-1]} {question}"
        own = {
            stem
            for stem in _stems(about)
            if len(stem) >= FOLLOWUP_MIN_LETTERS and stem not in _FOLLOWUP_STOP
        }
        if own & ctx.followup_terms:
            return True
        if ctx.figure_now and _MONEY_FOLLOW_UP.search(question) is not None:
            return True
        before = " ".join(self._emitted)
        if not before or not ctx.said:
            return False
        if repeat_kind(before, ctx.said) is not None:
            return True
        return mentions_anchor_figure(before) and any(
            mentions_anchor_figure(said) for said in ctx.said
        )

    def _figure_memory(self, sentence: str) -> str:
        """D3-LRN-MONEY1: ``sentence``, or "" when it compares the settled price with the $7,000 or
        with what she heard once again, or asks "what's included" again too soon."""
        ctx = self.ctx
        if (
            ctx.anchor_settled
            and "?" not in sentence
            and (mentions_anchor_figure(sentence) or _HEARD_COMPARE.search(sentence) is not None)
        ):
            if ctx.anchor_comments + self._anchor_comments >= 1:
                return ""
            self._anchor_comments += 1
        if ctx.included_recent and "?" in sentence and _INCLUDED_QUESTION.search(sentence):
            return ""
        return sentence

    def _is_reask(self, text: str) -> bool:
        """Review D5R-3: ``text`` is the re-ask this ack turn asked for (SWEEP-11): a question on
        a topic of one of the re-asked questions, or a repeat of one of them."""
        reask = self.ctx.reask
        if not reask or "?" not in text:
            return False
        if topics_raised(text) & topics_raised(" ".join(reask)):
            return True
        return repeat_kind(text, reask) is not None

    def _comes_back(self, text: str) -> bool:
        """M032 SWEEP-7: ``text`` is a question about the topic the reply comes back to."""
        topic = self.ctx.reask_topic
        return bool(topic) and "?" in text and topic in open_question_topics(text)

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
        if self._comes_back(out):
            return None  # M032 SWEEP-7: the come-back the reply was asked for
        said = self.ctx.said
        if self.ctx.reask and "?" in out:
            said = tuple(prior for prior in said if prior not in self.ctx.reask)
        kind = repeat_kind(out, said)
        return None if kind is None else self._repeat_hit(kind, out)

    def _drop_repeat(self, hit: Hit, *, blocked: bool, question: bool = False) -> list[str]:
        """Record the ``repeat`` hit of a dropped sentence.

        ``blocked``: the model's own sentence was blocked as well (the fallback is then the
        "thinking" line, not a back-channel).  ``question``: the dropped sentence asked something
        (D5-LRN-ACKFALL1: an emptied reply then presses instead of a bare back-channel).
        """
        if question and not blocked:
            self._repeat_question_dropped = True
        self._hits.append(hit)
        self._replaced = True
        if blocked:
            self._other_drops += 1
        else:
            self._repeat_drops += 1
        self._last_dropped = True
        return []

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
        strips, detect = (
            (_TIC_STRIP_V2, TIC_PATTERNS_V2) if ctx.tic_v2 else (_TIC_STRIP, TIC_PATTERNS)
        )
        for tic, patterns in strips.items():
            if detect[tic].search(text) is None:
                continue
            if self._tic_allowed(tic):
                self._reply_fillers += 1
                continue
            for pattern in patterns:
                text = pattern.sub(_filler_gap, text)
        text = self._single_filler(text)
        if ctx.tic_v2 and ctx.free_reply and not ctx.carries_move:
            text = self._trim_soft_tics(text)
        if self._reply_fillers >= 1:
            text = _INLINE_FILLER.sub(_filler_gap, text)
        if not self._emitted:
            text = self._vary_opener(text)
        if STRETCH_PHRASE.search(text) is not None:
            used = self._phrase_count(PHRASE_STRETCH)
            if used >= PHRASE_QUOTA[PHRASE_STRETCH]:
                text = STRETCH_PHRASE.sub(
                    pick_variant(STRETCH_ALTERNATIVES, ctx.seed, ctx.turn), text
                )
            else:
                self._phrases_used[PHRASE_STRETCH] = self._phrases_used.get(PHRASE_STRETCH, 0) + 1
        if ctx.f3_wording and REAL_COMMITMENT.search(text) is not None:
            # D4-F3STOCK1: "Six months is a real commitment." once a call; a second one goes (its
            # clause, or the whole sentence when that was all of it).  Review D4R-1: only from a
            # free reply; a line that carries an owed move keeps it (its proof clause may be it).
            key = PHRASE_REAL_COMMITMENT
            if self._phrase_count(key) >= 1 and ctx.free_reply and not ctx.carries_move:
                text = _without_clauses(text, REAL_COMMITMENT)
                if not text:
                    self._style_edits += 1
                    self._repeat_drops += 1
                    return ""
            else:
                self._phrases_used[key] = self._phrases_used.get(key, 0) + 1
        if CONCESSION_TAG.search(text) is not None:
            if self._phrase_count(PHRASE_CONCESSION_TAG) >= PHRASE_QUOTA[PHRASE_CONCESSION_TAG]:
                text = _strip_concession_tag(
                    text, tidy=ctx.echo_guard, v3=ctx.guard_tidy_v3
                )
            else:
                key = PHRASE_CONCESSION_TAG
                self._phrases_used[key] = self._phrases_used.get(key, 0) + 1
        text = self._stall_quotas(text)
        if not text:
            # Nothing but an over-quota stall was left: dropped like a repeat, so a reply that has
            # nothing else gets a neutral back-channel and not "I'm thinking that over".
            self._style_edits += 1
            self._repeat_drops += 1
            return ""
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

    def _trim_soft_tics(self, text: str) -> str:
        """SWEEP-12: a soft tic she used in one of her last ``SOFT_TIC_WINDOW`` replies is taken out
        ("What would I actually work on?" -> "What would I work on?"); never down to one word."""
        recent = self.ctx.recent_styles[-SOFT_TIC_WINDOW:]
        for tic in (TIC_ACTUALLY, TIC_GENUINELY, TIC_PROPERLY):
            if TIC_PATTERNS_V2[tic].search(text) is None:
                continue
            if not any(tic in tics for _opener, tics in recent):
                continue
            if tic == TIC_PROPERLY:
                trimmed = _PROPERLY_AFTER_VERB.sub(r"\1", text)
            else:
                trimmed = _SOFT_TIC_STRIP[tic].sub(_filler_gap, text)
            if trimmed != text and word_count(trimmed) >= 2:
                text = trimmed
                self._soft_tic_trims += 1
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
        """Vary a reply that opens like one of the last six.

        An interjection ("Okay,", "Oh,") is taken off.  A "That's ..." / "That helps ..." becomes
        "It's ..." / "It helps ..." (a pronoun swap: cutting the "That" left fragments).
        """
        recent = [past for past, _tics in self.ctx.recent_styles[-STYLE_OPENER_WINDOW:]]
        opener = reply_opener(text)
        if not opener or opener not in recent:
            return text
        match = _LEAD_INTERJECTION.match(text)
        if match is not None and word_count(text[match.end() :]) >= 2:
            text = text[match.end() :]
        if reply_opener(text) == "that" and "that" in recent:
            text = _swap_that(text)
        return text

    def _cut_praise(self, sentence: str) -> str:
        """M032 S5: ``sentence`` without Christy's praise of the answer ("" when none is left).

        Only in the opening and the icebreaker and only when the session turned the check on
        (``praise_check``).  Each cut is a ``praise`` hit: hygiene, counted but never a leak.  A
        sentence that also leaks is left whole for the leak rules (review of S5): it is blocked
        either way, and its leak hits must reach the posted rows and the 3-hit gate.
        """
        ctx = self.ctx
        if (
            not ctx.praise_check
            or self._praise_off
            or ctx.is_learner
            or ctx.phase not in SMALL_TALK_PHASES
        ):
            return sentence
        kept = without_praise(sentence)
        if kept == sentence:
            return sentence
        if any(hit.category in LEAK_CATEGORIES for hit in check_sentence(sentence, ctx)):
            return sentence
        folded = fold(sentence)
        digest = hashlib.sha256(normalize(folded).encode("utf-8")).hexdigest()[:12]
        excerpt = ""
        if ctx.keep_excerpts:
            excerpt = _scrub_name(mask_contact(folded, 60), ctx.candidate_first_name)
        self._hits.append(Hit(PRAISE, "icebreaker_praise", excerpt, digest))
        self._replaced = True
        if not kept:
            self._praise_dropped.append(sentence)
        else:
            self._style_edits += 1
        return kept

    def _cut_summary(self, sentence: str) -> str:
        """D3-ICE1: ``sentence`` without Christy's echo-and-verdict reaction ("" when none is left).

        Only in the opening and the icebreaker and only when the session turned the check on
        (``reaction_check``).  A summary label ("that's a good stretch", ``_SUMMARY_VERDICT``) is
        trimmed wherever it is; the bare shape ("X, that's ...") only when it opens this reply and
        her last reply opened the same way.  A style trim (no hit).  A sentence dropped whole is
        kept for ``flush``: it is never the only thing a reply says.
        """
        ctx = self.ctx
        if (
            not ctx.reaction_check
            or self._summary_off
            or ctx.is_learner
            or ctx.phase not in SMALL_TALK_PHASES
        ):
            return sentence
        kept = without_summary(sentence, wide=ctx.reaction_check_v2)
        if (
            kept == sentence
            and self._vetted == 1
            and ctx.previous_opening
            and summary_shape(ctx.previous_opening)
        ):
            kept = without_summary(sentence, shape=True)
        if (
            kept == sentence
            and ctx.reaction_check_v2
            and self._vetted == 1
            and echoes_their_turn(sentence, ctx.candidate_text)
            and any(opens_with_reaction(opening) for opening in ctx.previous_openings[-2:])
        ):
            # D4-ICE-ECHO1: one of her last two replies opened with an echo or a verdict, so this
            # echo goes (never the only sentence: ``flush`` gives it back).  Review of diagnosis 4
            # (ECHO-CUT-EATS-ANSWERS): only their own words back after a turn that asked nothing;
            # her answer to their question or her deferral is never cut.
            kept = ""
        if kept == sentence:
            return sentence
        self._style_edits += 1
        if not kept:
            self._summary_dropped.append(sentence)
        return kept


    def _is_surface(self, out: str, hits: list[Hit]) -> bool:
        """D5-GUARD-GARBLE1: ``out`` is the persona's surface line for a blocked need."""
        persona = self.ctx.persona
        if persona is None or not self.ctx.is_learner:
            return False
        return any(
            hit.category == VOLUNTEERED_NEED and out == persona.surface(hit.rule) for hit in hits
        )

    def _rest_after(self, sentence: str) -> str:
        """The raw text received after ``sentence`` (``feed`` and ``flush`` vet from the buffer)."""
        index = self._buffer.find(sentence)
        return "" if index < 0 else self._buffer[index + len(sentence) :]

    def _without_surfaces(self, text: str) -> str:
        """D5-GUARD-GARBLE1: ``text`` without a clause that says a surface line of this reply."""
        for surface in self._surfaces:
            if repeat_kind(text, (surface,)) is not None:
                return ""
            pattern = _surface_pattern(surface)
            if pattern is not None and _first_clause_matches(fold(text), pattern):
                text = _without_clauses(text, pattern, orphans=True, orphan_tail=True)
                if not text:
                    return ""
        return text

    def _cap_with_opener(self, sentence: str) -> str:
        """D5-ICE-AWITH1: the "And with <their thing>," opener is kept once in the small talk.

        Only in the opening and the icebreaker and only with ``reaction_check_v2``.  The first
        such opener (in the session, ``with_opener_used``, or in this reply) stays; any later one
        loses the clause up to its comma, and the question is re-capitalised (never emptied:
        ``without_with_opener``).  A style trim (no hit).
        """
        ctx = self.ctx
        if (
            not ctx.reaction_check_v2
            or ctx.is_learner
            or ctx.phase not in SMALL_TALK_PHASES
            or not with_opener(sentence)
        ):
            return sentence
        if not ctx.with_opener_used and not self._with_opener_seen:
            self._with_opener_seen = True
            return sentence
        kept = without_with_opener(sentence)
        if kept != sentence:
            self._style_edits += 1
        return kept

    def _cut_self_deflection(self, sentence: str) -> str:
        """D5-DEFLECT1 (``story_echo``, ``R1_GUARD_STORY_ECHO``): in the opening and the icebreaker
        her own "That's a good question for the hiring team ..." after a turn that asked nothing is
        dropped ("" for gone): nobody asked her anything.  Never the only sentence: ``flush`` falls
        back to the plan's question, or gives it back when there is none; and when what is left
        asks nothing ("Okay."), the plan's question follows it (review of diagnosis 5).  A turn
        that may ask without a question mark (``_turn_may_ask``) keeps it.  A style trim (no hit).
        """
        ctx = self.ctx
        if (
            not ctx.story_echo
            or ctx.is_learner
            or ctx.phase not in SMALL_TALK_PHASES
            or not ctx.candidate_text
            or _turn_may_ask(ctx.candidate_text)
            or self._summary_off
            or not is_self_deflection(sentence)
        ):
            return sentence
        self._style_edits += 1
        self._deflection_dropped.append(sentence)
        return ""

    def _vet(self, sentence: str) -> list[str]:
        if self._done:
            return []
        self._vetted += 1
        if self.ctx.offer_phrase_used and not self.ctx.is_learner and sentence:
            trimmed = without_offer_phrase(sentence)  # D4-TRANS-Q1: the offer was made once
            if trimmed != sentence:
                self._style_edits += 1
                sentence = trimmed
        sentence = self._cut_praise(sentence)
        if sentence:
            sentence = self._cut_summary(sentence)
        if sentence:
            sentence = self._cut_self_deflection(sentence)
        if sentence:
            sentence = self._cap_with_opener(sentence)
        if not sentence:
            self._last_dropped = True
            return []
        if self.ctx.is_learner:
            sentence = _unquote_figures(sentence)
        ctx = replace(self.ctx, anchor_in_reply=True) if self._anchor_seen else self.ctx
        hits = check_sentence(sentence, ctx)
        if self.ctx.is_learner and mentions_anchor_figure(sentence):
            self._anchor_seen = True  # also when it is swapped: the next sentence reacts to it
        out = sentence
        # The feedback refusal is the whole answer: whatever the model says after it (in the
        # owner's session, a paraphrase of the deferral line, "the hiring team will follow up")
        # would say the same thing twice.  The reply ends with the refusal.
        final = False
        if hits:
            self._hits.extend(hits)
            self._replaced = True
            if any(hit.category == COURSE_FACT for hit in hits):
                self._length_drops += 1
            out = _replacement(hits, self.ctx, sentence)
            categories = {hit.category for hit in hits}
            if (
                out == FAQ_DEFER_WRAP_LINE
                and HIRING_MENTION in categories
                and categories <= {HIRING_MENTION, HIRING_COMP, INVENTED_FACT}
                and any(
                    _has_answer_content(said) if ctx.next_steps else _has_own_content(said)
                    for said in self._emitted
                )
            ):
                # M032 SWEEP-26: "Great, that's all from my side." already said something, so its
                # "The hiring team will follow up ..." is dropped, not answered with a deflection
                # (review S3R-7, naturalness: also when it names the selection or the pay).
                out = ""
            final = out == NO_FEEDBACK_LINE
            if out in self._replacements:
                out = ""
            surface = out and self._is_surface(out, hits)
            if surface and self.ctx.guard_tidy_v3:
                # D5-GUARD-GARBLE1: the reply says the same worry in its own words already (before
                # or after this sentence), so the surface line would be heard twice.
                pattern = _surface_pattern(out)
                around = " ".join((*self._emitted, self._rest_after(sentence)))
                if pattern is not None and pattern.search(fold(around)) is not None:
                    out = ""
            if out:
                self._replacements.add(out)
                if surface:
                    self._surfaces.append(out)
        if out and self.ctx.is_learner and _STILL_MORE.search(out) is not None:
            if any(_STILL_MORE.search(said) for said in self._emitted):
                out = ""  # "more than I planned for" is said once in a reply
        if (
            out
            and not hits
            and self.ctx.is_learner
            and self.ctx.contentless
            and not self._emitted
            and "?" not in out
            and _LINE_CUT.search(out) is None
            and _ASSUMED_ANSWER.match(out) is not None
        ):
            # D5-LRN-ASSUME1: his turn told her nothing, so "Good to know ..." or "Right, so it's
            # ..." reacts to an answer nobody gave; the rest of the reply stands.  Review D5R-4: a
            # question ("Right, so how big are the batches?") or the cut-out line stays, and a
            # reply left empty by this drop says the line cut out (``flush``).
            self._style_edits += 1
            self._assumed_drops += 1
            self._last_dropped = True
            return []
        if out and not hits and self.ctx.is_learner and self.ctx.free_reply:
            kept = out
            if self.ctx.figure_memory:
                kept = self._figure_memory(kept)
            if kept and self.ctx.price_heard and _NO_PRICE_HEARD.search(kept) is not None:
                kept = _without_clauses(kept, _NO_PRICE_HEARD)  # D3-LRN-PRICE1
            if kept and self.ctx.eased_ack_v2 and _THANKS_FOR_ROOM.search(kept) is not None:
                # D3-LRN-ACK1: "Thanks for giving me the room on that." is a stock phrase.
                kept = _without_clauses(kept, _THANKS_FOR_ROOM)
            if kept and self.ctx.short_on_time:
                if _TIME_CUE_AGAIN.search(kept) is not None:
                    kept = ""  # D4-TIMECUE1: her time cue was said once already
                elif (
                    "?" in kept
                    and self._emitted
                    and not self._follow_up(kept)
                    and not self._comes_back(kept)
                ):
                    kept = ""  # D4-TIMECUE1: short on time, she opens no new topic
            if (
                kept
                and self.ctx.bye_heard
                and not self.ctx.short_on_time
                and "?" in kept
                and self._emitted
                and not self._follow_up(kept)
                and not self._comes_back(kept)
            ):
                kept = ""  # D5-LRN-POSTBYE1: he said goodbye, so she opens no new topic
            if kept and self.ctx.topic_recent and not self.ctx.carries_move:
                raised = topics_raised(kept) & self.ctx.topic_recent
                if (
                    raised
                    and not self._comes_back(kept)
                    and not self._is_reask(kept)
                    and (self._emitted or word_count(self._rest_after(sentence)) >= 3)
                ):
                    # D5-LRN-TOPICREP1: she raised this in one of her last two replies and he has
                    # not answered it; beside something else to say, it is not said again.  Held
                    # back, so a reply left with nothing says it after all (never emptied).
                    if not self._topic_held:
                        self._topic_held = kept
                    kept = ""
            if kept and self.ctx.come_back_v2 and _REPETITION_REPROACH.search(kept) is not None:
                # D4-COMEBACK1: no "you've said small a couple of times now": the question stays.
                kept = _without_clauses(kept, _REPETITION_REPROACH)
            if kept != out:
                self._style_edits += 1
                if not kept:
                    self._repeat_drops += 1  # an emptied reply gets a back-channel, as a repeat
                out = kept
        if (
            out
            and not hits
            and self.ctx.echo_guard
            and self.ctx.reask
            and "?" in out
            and repeat_kind(out, self.ctx.reask) == "exact"
        ):
            # Simulation diagnosis 1 (L5): the asked-for re-ask word for word sounds scripted; a
            # person asks it again in fewer words.
            out = short_reask(out)
            self._style_edits += 1
        if out and not hits and self._surfaces and self.ctx.guard_tidy_v3:
            # D5-GUARD-GARBLE1: a later sentence that says the surface line again loses the clause
            # that repeats it; with nothing left it goes silently (no repeat, no back-channel).
            trimmed = self._without_surfaces(out)
            if trimmed != out:
                self._style_edits += 1
                if not trimmed:
                    self._last_dropped = True
                    return []
                out = trimmed
        if out and not hits:
            # A sentence the learner already said is a repeat in the words it was WRITTEN in: the
            # style rules below change a few words ("That's" -> "It's"), and a changed copy of an
            # earlier sentence must not slip past the repeat check as a new one.
            written = self._repeated(out) if out not in self._emitted else None
            if written is not None:
                return self._drop_repeat(written, blocked=False, question="?" in out)
            out = self._vary(out)
            if out and self._last_dropped and self.ctx.is_learner:
                if _DANGLING_REFERENCE.match(out) is not None or (
                    self.ctx.echo_guard and _points_back(out)
                ):
                    # The sentence before this one was dropped and this one points back at it
                    # ("He'd probably ask about that first."): it goes with it.
                    out = ""
                    self._style_edits += 1
            if out and self._last_dropped and self.ctx.is_learner:
                # A connector that leaned on the dropped sentence ("Also, how many hours ...",
                # "And before I commit ...") goes with it.
                stripped = _LEAD_CONNECTOR.sub("", out, count=1)
                if stripped != out and word_count(stripped) >= 2:
                    out = stripped[0].upper() + stripped[1:]
                    self._style_edits += 1
        if out and out not in self._emitted:
            repeated = self._repeated(out)
            if repeated is not None:
                return self._drop_repeat(repeated, blocked=bool(hits), question="?" in out)
        if not out or out in self._emitted:
            if hits and all(hit.rule == "closer_again" for hit in hits):
                self._repeat_drops += 1  # a second goodbye is a repeat: a back-channel replaces it
            elif hits:
                self._other_drops += 1
            if (
                hits
                and not out
                and not self._emitted
                and self.ctx.story_echo
                and any(hit.category in (HIRING_COMP, INVENTED_FACT) for hit in hits)
            ):
                self._story_ack_owed = True  # D3-GUARD-IB1: the reply's opener was dropped
            self._last_dropped = True
            return []
        self._last_dropped = False
        if self._story_ack_owed and not self._emitted:
            # D3-GUARD-IB1: a short acknowledgement takes the dropped opener's place, so the
            # question does not follow the candidate's story cold.
            if _ACK_OPENER.match(out) is None:
                out = STORY_ACK + " " + out
                self._style_edits += 1
        self._story_ack_owed = False
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
        if not self._emitted and self._summary_dropped and self._other_drops == 0:
            # D3-ICE1: the reaction was all the reply said, so it stays (a reaction with no
            # question beats a canned line): vetted again without the summary trim.
            self._summary_off = True
            for sentence in self._summary_dropped:
                out.extend(self._vet(sentence))
        if (
            not self._emitted
            and self._deflection_dropped
            and self._other_drops == 0
            and not self.ctx.interviewer_fallback
        ):
            # D5-DEFLECT1: the deflection was all the reply said and there is no question to fall
            # back on: it stays, as before (vetted again without the trims).
            self._summary_off = True
            for sentence in self._deflection_dropped:
                out.extend(self._vet(sentence))
        if (
            not self._emitted
            and self._praise_dropped
            and self._other_drops == 0
            and not self.ctx.interviewer_fallback
        ):
            # M032 S5: praise was all the reply said and there is no question to fall back on.
            # The model's own line beats "Sorry, what were you saying?" (the phone's lesson: never
            # swap a natural line for a canned one), so it is vetted again without the praise cut.
            self._praise_off = True
            for sentence in self._praise_dropped:
                out.extend(self._vet(sentence))
        restate = self.ctx.interviewer_fallback
        if (
            self._emitted
            and (self._praise_dropped or self._deflection_dropped)
            and restate
            and not self._done
            and restate not in self._emitted
            and not any(sentence_asks(sentence) for sentence in self._emitted)
            and (self.ctx.word_cap is None or self._used + word_count(restate) <= self.ctx.word_cap)
        ):
            # M032 S5 (review): the praise cut took the reply's only question ("Got it. That's
            # solid experience."): the plan's current question follows the acknowledgement, so
            # the candidate is never left waiting for a question that was never asked.  Review of
            # diagnosis 5 (D5-DEFLECT1-R1): the same after the deflection cut ("Okay.").
            self._emitted.append(restate)
            self._used += word_count(restate)
            self._style_edits += 1
            out.append(restate)
        if not self._emitted and not self.ctx.quiet_empty:
            self._fallback_used = True
            only_repeats = self._repeat_drops > 0 and self._other_drops == 0
            ctx = self.ctx
            if self._topic_held and ctx.is_learner:
                # D5-LRN-TOPICREP1: everything else went too, so the held sentence is the reply.
                self._emitted.append(self._topic_held)
            elif (
                self._assumed_drops
                and ctx.is_learner
                and ctx.contentless
                and self._other_drops == 0
            ):
                # Review D5R-4: the reply only assumed an answer nobody gave; a bare "Okay." to a
                # broken-up line is unnatural, so she says the line cut out.
                self._emitted.append(_cut_out_line(ctx))
            elif (
                ctx.ack_press
                and ctx.is_learner
                and ctx.mode == "reply"
                and ctx.advisor_hollow
                and only_repeats
                and self._repeat_question_dropped
                and not ctx.confirm
                and (press := _press_line(ctx)) is not None
            ):
                # D5-LRN-ACKFALL1: her question met a lone "Okay." and its re-ask was a repeat; a
                # bare "Mm-hmm." would drop her point, so she presses gently (each line once).
                self._emitted.append(press)
            elif self._length_drops and ctx.free_reply and ctx.is_learner:
                # M032 SWEEP-17: a free reply emptied by a course length she was never told asks
                # for it instead ("How long does the course run?"), never "Give me a second".
                self._emitted.append(_length_probe(ctx))
            elif (
                ctx.echo_guard
                and ctx.is_learner
                and ctx.free_reply
                and ctx.mode == "reply"
                and not ctx.confirm
                and not ctx.asked_her
                and {hit.category for hit in self._hits} <= {INVENTED_FACT, COURSE_FACT}
            ):
                # Simulation diagnosis 1 (U3): a reply emptied of a fact she may not state, after a
                # turn that asked her nothing: "I'm thinking that over" answers nothing he said, so
                # a neutral back-channel lets him go on.
                self._emitted.append(NEUTRAL_ACKS[ctx.turn % len(NEUTRAL_ACKS)])
            else:
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
            soft_tic_trims=self._soft_tic_trims,
            bare_keeps=self._bare_keeps,
        )


def guard_text(text: str, ctx: GuardContext) -> GuardResult:
    """Vet a whole reply at once (the non-streaming form of ``StreamGuard``)."""
    guard = StreamGuard(ctx)
    guard.feed(text)
    guard.flush()
    return guard.result


def _has_own_content(sentence: str) -> bool:
    """A sentence that is more than an acknowledgement (``OWN_CONTENT_WORDS`` other words)."""
    words = normalize(sentence).split()
    return sum(1 for word in words if word not in _ACK_ONLY_WORDS) >= OWN_CONTENT_WORDS


def compares_with_anchor(text: object) -> bool:
    """D3-LRN-MONEY1: a statement of hers that compares a price with the $7,000 or with what she
    had heard or braced for (memory only)."""
    return any(
        "?" not in sentence
        and (mentions_anchor_figure(sentence) or _HEARD_COMPARE.search(sentence) is not None)
        for sentence in split_sentences(str(text or ""))
    )


def asks_whats_included(text: object) -> bool:
    """D3-LRN-MONEY1: her question about what the price includes."""
    return any(
        "?" in sentence and _INCLUDED_QUESTION.search(sentence) is not None
        for sentence in split_sentences(str(text or ""))
    )


def _has_answer_content(sentence: str) -> bool:
    """D3-WRAP1: ``_has_own_content`` once the lead-in phrases are taken out."""
    return _has_own_content(_LEAD_IN_PHRASES.sub(" ", fold(sentence)))


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


# A sentence about "he" or "she" that follows a dropped sentence points back at it.
_DANGLING_REFERENCE = re.compile(
    r"^\W*(?:he|she|they)(?:'d|'ll|'s|'re| would| will| is| was| has| had| might| probably)\b",
    re.IGNORECASE,
)
# D3-LRN-TRUNC1: never split "$7,500" at its thousands comma (it left "just that $7.").
_CLAUSE_SPLIT = re.compile(r"\s*(?:(?<!\d),|,(?!\d{3}\b)|;)\s*|\s+-+\s+")


def _swap_that(text: str) -> str:
    """"That's a lot" -> "It's a lot", "That helps" -> "It helps"; other openers are unchanged."""
    match = _THAT_IS.match(text)
    if match is not None:
        return "It" + match.group("verb") + " " + text[match.end() :]
    match = _THAT_VERB.match(text)
    if match is not None:
        return "It " + text[match.end() :]
    return text


# Simulation diagnosis 2 (ST1 (3), ``GuardContext.orphan_clause``): a clause that opens with a
# subordinator ("Whether we do a call after that, I'll let you know ...") cannot stand without the
# main clause after it.
BARE_REPROACH_WORDS = 10
_BARE_REPROACH_OPENER = re.compile(
    r"^\W*(?:that'?s not|that is not|it'?s not|it is not|that isn'?t|not really|no,|no\b|"
    r"you(?:'re| are) not)",
    re.IGNORECASE,
)
_SUBORDINATE_OPENER = re.compile(
    r"^\s*(?:whether|if|once|when|whenever|after|before|until|till|since|because|although|"
    r"though|as soon as|unless)\b",
    re.IGNORECASE,
)


def _bare_reproach(text: str) -> bool:
    """NAT1: ``text`` is only a short complaint or reaction ("That's not really what I was asking
    about, honestly."): ten words or fewer, opening with a negative pointer, and no course word."""
    stripped = text.strip()
    return (
        bool(stripped)
        and word_count(stripped) <= BARE_REPROACH_WORDS
        and _BARE_REPROACH_OPENER.match(stripped) is not None
        and _ACK_WORDS.search(stripped) is None
    )


# D4-FRAG1 (R1_CLAUSE_ORPHAN_V2): a kept clause that opens with one of these leans on the clause
# just cut before it ("Money's the part I'd go over with him, since it's a stretch." left "Since
# it's a real stretch at home right now."), so it goes too.
_DEPENDENT_OPENER = re.compile(
    r"^\W*(?:since|because|'?cause|as|which|who|whereas)\b", re.IGNORECASE
)


def _without_clauses(
    text: str, pattern: re.Pattern[str], *, orphans: bool = False, orphan_tail: bool = False
) -> str:
    """``text`` without the comma-separated clauses that match ``pattern`` ("" if little is left).

    "That helps, but it's still more than I planned for." keeps "That helps."; a sentence whose
    only substance was the clause (fewer than three words left) is dropped whole.  ``orphans``
    (ST1 (3)): a subordinate clause whose next clause was cut goes with it.  ``orphan_tail``
    (D4-FRAG1): a clause that opens with "since", "because", "as" or "which" right after a cut
    clause goes with it as well.
    """
    stripped = text.rstrip()
    end = stripped[-1:] if stripped[-1:] in (".", "?", "!") else "."
    body = stripped.rstrip(".?!")
    parts = [part for part in _CLAUSE_SPLIT.split(body) if part.strip()]
    cut = [pattern.search(part) is not None for part in parts]
    if orphans:
        for index, part in enumerate(parts):
            if (
                not cut[index]
                and index + 1 < len(parts)
                and cut[index + 1]
                and _SUBORDINATE_OPENER.match(part)
            ):
                cut[index] = True
    if orphan_tail:
        for index in range(1, len(parts)):
            if not cut[index] and cut[index - 1] and _DEPENDENT_OPENER.match(parts[index]):
                cut[index] = True
    kept = [part for part, gone in zip(parts, cut) if not gone]
    if not kept:
        return ""
    out = ", ".join(kept)
    out = re.sub(r"^(?:but|though|although|and|so|yet|because)\s+", "", out, flags=re.IGNORECASE)
    if word_count(out) < 3:
        return ""
    return out[0].upper() + out[1:] + end


_SURFACE_STOP = frozenset(
    {"that", "this", "with", "have", "just", "really", "about", "would", "there", "they", "them",
     "what", "when", "your", "been", "from", "very", "will", "into", "than", "then", "also"}
)


@functools.lru_cache(maxsize=64)
def _surface_pattern(surface: str) -> re.Pattern[str] | None:
    """D5-GUARD-GARBLE1: the surface line's content words in order ("schedule ... pretty ...
    packed"), within one clause; None when it has fewer than two of them."""
    words = [
        word
        for word in re.findall(r"[a-z']+", fold(surface).lower())
        if len(word) >= 4 and word not in _SURFACE_STOP
    ]
    if len(words) < 2:
        return None
    return re.compile(
        r"\b" + r"\b[^,.;?!]*?\b".join(re.escape(word) for word in words) + r"\b", re.IGNORECASE
    )


def _first_clause_matches(text: str, pattern: re.Pattern[str]) -> bool:
    """U5: the first comma-separated clause of ``text`` is one ``_without_clauses`` cuts."""
    parts = [part for part in _CLAUSE_SPLIT.split(text.rstrip().rstrip(".?!")) if part.strip()]
    return bool(parts) and pattern.search(parts[0]) is not None


def _points_back(text: str) -> bool:
    """U5: a short sentence that only points at something said before it ("That suits me.")."""
    return word_count(text) <= POINTS_BACK_WORDS and _POINTS_BACK.match(text) is not None


def _strip_concession_tag(text: str, *, tidy: bool = False, v3: bool = False) -> str:
    """``text`` without the concession tag ("..., I'll give you that.", "I'll admit, ...").

    What is left keeps its closing mark; a tag that is the whole sentence leaves nothing, which
    ``_vary`` turns into a neutral acknowledgement.  ``tidy`` (simulation diagnosis 1, U4 (3)):
    a conjunction left dangling before the tag ("..., so, I'll give you that") goes with it.
    ``v3`` (D5-GUARD-GARBLE1, R1_GUARD_TIDY_V3): "I'll say that much" is one tag, so no "much"
    is stranded; review D5R-5: a "much" left before the tag belongs to the sentence ("I like the
    structure very much") and stays.
    """
    end = text.rstrip()[-1:] if text.rstrip()[-1:] in (".", "?", "!") else ""
    leading, trailing = (
        (CONCESSION_TAG_LEADING_V3, CONCESSION_TAG_TRAILING_V3)
        if v3
        else (CONCESSION_TAG_LEADING, CONCESSION_TAG_TRAILING)
    )
    out = leading.sub("", text, count=1)
    out = trailing.sub("", out).rstrip(" ,;:-")
    if tidy:
        out = _DANGLING_CONJUNCTION.sub("", out).rstrip(" ,;:-")
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
    v2 = concession_read_v2()
    if v2:
        # D5-HF-CONCESSION1 and review D5R-2: scepticism and other people, never a yes.
        folded = _NOT_WON_OVER.sub("", _MORE_CONVINCING.sub("", folded))
    return any(
        not negated_before(folded, match.start())
        and _DOUBT_FRAME.search(clause_before(folded, match.start())) is None
        for match in (_CONCESSION_V2 if v2 else _CONCESSION).finditer(folded)
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
