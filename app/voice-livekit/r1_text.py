"""Shared text helpers for the R1 role-play content modules.

Pure functions only: no I/O, no clock, no randomness.  Every transcript comes from
speech-to-text, so each rule must tolerate missing punctuation and arbitrary casing.
Nothing here imports the LiveKit SDK, so the bare ``python3 -m unittest`` CI step
can load it.
"""
from __future__ import annotations

import hashlib
import re
from typing import Iterable, Sequence

_FOLD = str.maketrans(
    {
        "\u2019": "'",
        "\u2018": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2013": "-",
        "\u2014": "-",
        "\u2026": "...",
        "\u00a0": " ",
    }
)


def fold(text: object) -> str:
    """Return ``text`` with typographic quotes and dashes folded to ASCII."""
    return str(text or "").translate(_FOLD)


def normalize(text: object) -> str:
    """Lower-case alphanumerics separated by single spaces; apostrophes are dropped."""
    folded = fold(text).lower().replace("'", "")
    return re.sub(r"[^a-z0-9]+", " ", folded).strip()


def word_count(text: object) -> int:
    """Count whitespace-separated tokens that contain a letter or digit."""
    return len(re.findall(r"[A-Za-z0-9]+(?:'[A-Za-z]+)?", fold(text)))


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])[\"')\]]*\s+|\n+")


def split_sentences(text: object) -> list[str]:
    """Split on sentence punctuation or newlines, keeping the terminal mark.

    Decimals (``4.5``), clock times (``3:30``) and amounts (``$7,000``) never split,
    because a split needs whitespace after the mark.
    """
    parts = _SENTENCE_SPLIT.split(fold(text))
    return [part.strip() for part in parts if part and part.strip()]


# "like", "um", "uh" and "hmm" are speech fillers that speech-to-text keeps ("Like I wanted to
# know like why ...", "Um, I am trying to understand ..."), so they may open a question.
_DISCOURSE = (
    r"(?:(?:and|so|but|also|okay|ok|right|well|now|then|great|thanks|thank you|got it|"
    r"i see|sure|cool|alright|perfect|nice|good|like|um+|uh+|er+m?|hmm+)\b[,.\s]*)*"
)
# "when" asks a question only in inverted order ("when can I expect your call", "when exactly do
# you start").  In declarative order it is a subordinator: "when it comes to live classes, you
# can ask anything", "when you call me back, I can also talk to your husband" (owner test
# b58c7d9c turns 37, 45, 51 and 78).
_WHEN_ASKS = (
    r"when(?=\s+(?:exactly\s+|else\s+|specifically\s+)?(?:can|could|would|will|shall|should|do|"
    r"does|did|are|is|was|were|have|has|had|may|might|am)\b|'s\b)"
)
# "what we can do is ...", "how I can help you" and "so what I mean is" are clefts of a statement:
# a we/I subject straight after the wh-word.  ("what I'd like to know" below is a real elicitation.)
_WH_ASKS = r"(?:what|why|how|where|who|whom|which|whose)(?!\s+(?:i|we)\b)"
_QUESTION_START = re.compile(
    r"^" + _DISCOURSE + r"(?:" + _WH_ASKS + r"|" + _WHEN_ASKS + r"|is|are|was|were|"
    r"do|does|did|can|could|would|will|shall|should|have|has|had|may|might|"
    r"tell me|walk me through|talk me through|help me understand|share|describe|explain|"
    r"i'?d (?:love|like) to (?:know|understand|hear|learn)|i'?m curious|"
    r"i was (?:wondering|curious)|i wonder|curious (?:about|whether|if)|any (?:concerns?|"
    r"thoughts|questions)|anything (?:that|else)|"
    r"i (?:want|need) to (?:know|understand|hear|learn|find out)|let me (?:ask|understand)|"
    r"i wanted to (?:know|ask|understand|hear|learn|find out|wonder)|"
    r"(?:i'?m |i am )?trying to (?:understand|figure out|find out)|"
    r"(?:i'?m|i am) wondering|"
    r"i'?m (?:interested|keen) in (?:hearing|knowing|understanding)|"
    r"what i'?d like to (?:know|understand))\b",
)
# A wh-word after a conjunction ("so what do you do", "and why is that") is a run-on question,
# unless a "we/I" subject follows it directly ("so what we can do", "and what I mean"): that is
# a cleft or an embedded clause of a statement.
_QUESTION_ANYWHERE = re.compile(
    r"\b(?:wonder|wondering|wondered|curious) (?:like )?(?:if|whether|what|why|how|when|about)\b"
    r"|\b(?:so|and|but|also|now|then|well|okay|ok)\s+(?:what|why|how|" + _WHEN_ASKS +
    r"|where|who|which)\b(?!\s+(?:i|we)\b)"
)
# An OFFER or PROMISE is a statement even when a wh-word sits inside it: "I can also help him
# understand why it costs this and what the packages are" (owner test b58c7d9c turn 78) has
# its wh-words after a first-person modal, so they open embedded clauses, not questions.
_OFFER_MODAL = re.compile(
    r"\b(?:i|we)(?:'ll|\s+(?:will|can|could|would|may|might|shall|am going to|are going to))\b"
)


def _asks_run_on_question(plain: str) -> bool:
    """A conjunction + wh-word (or "wondering what") that is not inside an offer or promise."""
    return any(
        not _OFFER_MODAL.search(plain[: match.start()])
        for match in _QUESTION_ANYWHERE.finditer(plain)
    )


def is_question_like(sentence: object) -> bool:
    """True for an interrogative or an elicitation such as "tell me about ...".

    Speech-to-text may drop the question mark, so the test also accepts a leading
    interrogative or elicitation phrase, optionally after a discourse opener.  A wh-word
    that only introduces a subordinate clause is not a question: "when" counts only in
    inverted order, and a wh-word after "I can ..." or "we will ..." is embedded in an offer.
    """
    folded = fold(sentence).strip()
    if "?" in folded:
        return True
    plain = re.sub(r"[^a-z0-9' ]+", " ", folded.lower())
    plain = re.sub(r"\s+", " ", plain).strip()
    if not plain:
        return False
    return bool(_QUESTION_START.match(plain) or _asks_run_on_question(plain))


def _tokens(text: object) -> list[str]:
    return [word for word in normalize(text).split() if len(word) > 2]


def _ordered_share(haystack: Sequence[str], wanted: Sequence[str]) -> float:
    """Fraction of ``wanted`` found, in order, inside ``haystack`` (both already tokenised)."""
    if not wanted:
        return 0.0
    position = 0
    matched = 0
    for word in wanted:
        try:
            position = haystack.index(word, position) + 1
        except ValueError:
            continue
        matched += 1
    return matched / len(wanted)


def fuzzy_ratio(actual: object, expected: object) -> float:
    """Fraction of ``expected``'s content words found in order inside ``actual``."""
    return _ordered_share(normalize(actual).split(), _tokens(expected))


def fuzzy_contains(actual: object, expected: object, threshold: float = 0.78) -> bool:
    """Conservative ordered-token check used to confirm that a scripted line was spoken."""
    return fuzzy_ratio(actual, expected) >= threshold


# ----------------------------------------------------------------------------------
# Repetition: has this person already said (nearly) this sentence?
# ----------------------------------------------------------------------------------
REPEAT_MIN_WORDS = 4
REPEAT_MIN_CONTENT_WORDS = 4
REPEAT_RATIO = 0.8
REPEAT_EXACT = "exact"
REPEAT_NEAR = "near"


def _repeat_sized(norm: str) -> tuple[bool, bool]:
    """(long enough for an exact-repeat check, enough content words for a near-repeat check)."""
    words = norm.split()
    content = [word for word in words if len(word) > 2]
    return len(words) >= REPEAT_MIN_WORDS, len(content) >= REPEAT_MIN_CONTENT_WORDS


class SpokenMemory:
    """The normalised sentences a speaker has actually played so far.

    It keeps no timing and no speaker text beyond the normalised form, and only sentences
    long enough to be repeated in the sense of ``repeat_kind``: a short back-channel
    ("Mm-hmm.", "Okay.") is never a repeat, so it is not worth remembering.
    """

    def __init__(self) -> None:
        self._sentences: dict[str, None] = {}

    def add(self, text: object) -> int:
        """Remember every sentence of ``text`` that can be repeated; returns how many."""
        added = 0
        for sentence in split_sentences(text):
            norm = normalize(sentence)
            if not norm or norm in self._sentences:
                continue
            if any(_repeat_sized(norm)):
                self._sentences[norm] = None
                added += 1
        return added

    def snapshot(self) -> tuple[str, ...]:
        """An immutable copy for a guard context (the plan is made before the speech)."""
        return tuple(self._sentences)

    def __len__(self) -> int:
        return len(self._sentences)


def repeat_kind(sentence: object, said: Iterable[str]) -> str | None:
    """``"exact"`` or ``"near"`` when ``sentence`` repeats one of ``said``, else ``None``.

    ``said`` holds normalised sentences (``SpokenMemory.snapshot``).  Exact: the same
    normalised sentence of at least ``REPEAT_MIN_WORDS`` words.  Near: at least
    ``REPEAT_MIN_CONTENT_WORDS`` content words, and one sentence contains the other's
    content words in order (``REPEAT_RATIO``), so "Just email me the details." inside
    "Just email me the details and I'll get back to you." is a repeat.  Pure and
    deterministic; one-word and two-word back-channels never count.
    """
    norm = normalize(sentence)
    if not norm:
        return None
    long_enough, content_enough = _repeat_sized(norm)
    if not (long_enough or content_enough):
        return None
    prior_sentences = [prior for prior in said if prior]
    if long_enough and norm in prior_sentences:
        return REPEAT_EXACT
    if content_enough:
        words = norm.split()
        content = [word for word in words if len(word) > 2]
        for prior in prior_sentences:
            prior_words = prior.split()
            if _ordered_share(prior_words, content) >= REPEAT_RATIO:
                return REPEAT_NEAR  # this sentence sits inside an earlier one
            prior_content = [word for word in prior_words if len(word) > 2]
            if (
                len(prior_content) >= REPEAT_MIN_CONTENT_WORDS
                and _ordered_share(words, prior_content) >= REPEAT_RATIO
            ):
                return REPEAT_NEAR  # an earlier sentence sits inside this one
    return None


def pick_variant(variants: Sequence[str], seed: str, count: int) -> str:
    """The ``count``-th variant of a rotation whose starting point is derived from ``seed``.

    Deterministic: the same attempt id always starts at the same variant, and successive
    uses walk the rotation, so a line is not repeated until all variants were used.  An
    empty ``seed`` starts at the first variant.
    """
    if not variants:
        return ""
    start = 0
    if seed:
        start = int.from_bytes(hashlib.sha256(seed.encode("utf-8")).digest()[:4], "big")
    return variants[(start + max(0, count)) % len(variants)]


# ----------------------------------------------------------------------------------
# Speaking style: how a reply opens and which filler words it leans on (R1-Q iteration 1).
# 44 of 90 live replies started with "Hmm" and 50 of 90 held "Honestly": a person on a phone call
# does not hum at every turn.  The guard varies a reply with these helpers (``r1_guard``) and the
# rehearsal harness measures the same words with its own copy.
# ----------------------------------------------------------------------------------
TIC_HMM = "hmm"
TIC_HONESTLY = "honestly"
TIC_PATTERNS = {
    TIC_HMM: re.compile(r"(?<![a-z-])hmm+\b|(?<![a-z-])hm\b", re.IGNORECASE),
    TIC_HONESTLY: re.compile(r"\b(?:honestly|to be honest|frankly)\b", re.IGNORECASE),
}
# M032 SWEEP-12 (flag R1_TIC_V2, read by the engine): "I'll be honest, ..." and "if I'm honest" are
# the honesty tic too, but only as an aside before punctuation ("I'll be honest with myself about
# it" is the sentence itself); and three soft tics the model moved on to ("actually" in 7 of 17
# lines of one call, "genuinely", "properly").  The soft tics are a separate guard pass, outside
# the one-filler budget, and only in a free reply (``r1_guard``).
TIC_ACTUALLY = "actually"
TIC_GENUINELY = "genuinely"
TIC_PROPERLY = "properly"
SOFT_TICS = (TIC_ACTUALLY, TIC_GENUINELY, TIC_PROPERLY)
TIC_PATTERNS_V2 = {
    TIC_HMM: TIC_PATTERNS[TIC_HMM],
    TIC_HONESTLY: re.compile(
        r"\b(?:honestly|to be honest|frankly)\b"
        r"|\bi(?:'ll| will) be (?:honest|frank|upfront|straight)(?:\s+with\s+you)?(?=\s*[,:;.-])"
        r"|\bif i'?m (?:being )?honest\b(?=\s*[,:;-])",
        re.IGNORECASE,
    ),
    TIC_ACTUALLY: re.compile(r"\bactually\b", re.IGNORECASE),
    TIC_GENUINELY: re.compile(r"\bgenuinely\b", re.IGNORECASE),
    TIC_PROPERLY: re.compile(r"\bproper(?:ly)?\b", re.IGNORECASE),
}
_FIRST_WORD = re.compile(r"[a-z]+")


def reply_opener(text: object) -> str:
    """The first word of ``text``, lower-case ("That's fine" -> "that"); "" for no word."""
    words = _FIRST_WORD.findall(fold(text).lower())
    return words[0] if words else ""


def reply_tics(text: object, *, v2: bool = False) -> tuple[str, ...]:
    """The tic words ("hmm", "honestly") that ``text`` contains, in a fixed order.

    ``v2`` (SWEEP-12) reads the wider honesty forms and the soft tics as well.
    """
    folded = fold(text)
    patterns = TIC_PATTERNS_V2 if v2 else TIC_PATTERNS
    return tuple(tic for tic, pattern in patterns.items() if pattern.search(folded))


# ----------------------------------------------------------------------------------
# Phrase tics beyond the filler words (R1-Q iteration 2).  The live sweep of iteration 1 fixed
# "hmm" and "honestly", and the model moved on to "still a stretch for me" (28 replies in 19 of
# 20 calls, in consecutive turns in nine) and to one question template ("what would that call
# actually involve?", 33 times in 15 calls).  Each phrase may be used once per call; the guard
# rewrites a second "a stretch" and drops a second template question.
# ----------------------------------------------------------------------------------
PHRASE_STRETCH = "stretch"
PHRASE_TEMPLATE_Q = "template_q"
STRETCH_PHRASE = re.compile(
    r"\b(?:(?:quite|kind of|sort of|a bit of|a little bit of|a real) )?a stretch\b", re.IGNORECASE
)
# Said in place of a second "a stretch"; every one reads right before "for me".
STRETCH_ALTERNATIVES = ("steep", "a lot", "a big ask", "tight", "too much")
# "what would that call actually involve / cover / include", "what would joining later mean".
QUESTION_TEMPLATE = re.compile(
    r"\bwhat (?:would|does|will|do|did|could|is) (?:that|this|the|it|a|an|my|joining|waiting|"
    r"those|these|one)\b[^?.!]{0,40}?\b(?:actually |really |exactly |even )?(?:involve|involves|"
    r"cover|covers|include|includes|entail|entails|look like|commit me to|mean for me)\b",
    re.IGNORECASE,
)


# Iteration 3.  The next live sweep found the concession tag ("I'll give you that", "I'll admit",
# "I won't pretend it isn't", "I'll say that": 28 replies in 14 calls, four in a row in one call)
# and the learner's goodbyes ("I'll reach out", "I'll let you know", "thanks for your time": nine
# in a row once the advisor only said "Sure." and "Okay.").  The tag is used once per call; a
# closer is dropped while the advisor has nothing to answer.
PHRASE_CONCESSION_TAG = "concession_tag"
_CONCESSION_CLAUSE = (
    r"i(?:'ll| will) (?:give you that|admit(?: that)?|say that|grant (?:you )?that|"
    r"concede(?: that)?)"
    r"|i won't pretend(?: (?:that )?(?:it isn't|it's not|it wasn't|otherwise|i'm not|i wasn't|"
    r"it doesn't|that isn't the case|it hasn't)|(?=\s*(?:[,.;!]|$)))"
    r"|i have to admit|i must admit|i can't deny(?: that)?|i'll be fair"
)
CONCESSION_TAG = re.compile(r"\b(?:" + _CONCESSION_CLAUSE + r")\b", re.IGNORECASE)
# The tag as a clause of its own, with the comma or dash that joins it: ", I'll give you that.",
# " - I won't pretend it isn't", and the tag that opens a sentence ("I'll admit, that's a ...").
CONCESSION_TAG_TRAILING = re.compile(
    r"\s*[,;-]*\s*(?:" + _CONCESSION_CLAUSE + r")\b[,.]?", re.IGNORECASE
)
CONCESSION_TAG_LEADING = re.compile(
    r"^\W*(?:" + _CONCESSION_CLAUSE + r")\b[,:]?\s*(?:(?:but|though|and)\b[,]?\s*)?",
    re.IGNORECASE,
)
# A goodbye: the learner closing the call itself.  "I'll let you know" and "I'll get back to you"
# as the answer to a close are the stall; this is only counted while the advisor has said nothing.
PHRASE_CLOSER = "closer"
HOLLOW_MAX_WORDS = 4
CLOSER = re.compile(
    r"\bi(?:'ll| will) (?:reach out|let you know|be in touch|get in touch|mull (?:it|this) over|"
    r"keep an eye out)\b"
    r"|\bthanks? (?:you )?(?:so much )?(?:again )?for (?:your time|walking me through|the call|"
    r"taking the time|hearing me out|your help|everything)\b"
    r"|\bthanks? (?:again|so much)\b[^.?!]{0,20}\b(?:call|time|help)\b"
    r"|\b(?:i should|let me|i'll) let you go\b|\btake care\b|\b(?:good ?)?bye\b"
    r"|\bi(?:'ve| have) got what i needed\b"
    r"|\bi think i(?:'ve| have) got (?:enough|what i needed)\b",
    re.IGNORECASE,
)


# R1-Q final review round 1.  The stall loop: the same stall said again and again in other words
# ("talk it over with my father" in 9 of 35 replies of one terse call, "get back to you" four
# times, "still more than I planned for" three replies in a row).  Three more tracked phrases, each
# with a per-call quota AND a spacing window (``r1_guard.PHRASE_QUOTA`` / ``PHRASE_WINDOW``).
PHRASE_DECIDER_STALL = "decider_stall"
PHRASE_STALL_CLOSER = "stall_closer"
PHRASE_MONEY_STRAIN = "money_strain"
_DECIDER_ROLE = (
    r"(?:husband|wife|partner|spouse|father|mother|dad|mom|mum|parents|family|fianc\w+|boyfriend|"
    r"girlfriend|him|her|them)"
)
# "I'd want to talk it through with my father", "Let me run it by my husband first", "I should
# check with him before I say yes": the learner stalls on the person who decides with it.
DECIDER_STALL = re.compile(
    r"\b(?:talk(?:ing)?|speak(?:ing)?|check(?:ing)?|run(?:ning)?|discuss(?:ing)?|consult(?:ing)?|"
    r"go(?:ing)? (?:over|through)|sleep on|clear(?:ing)?|loop(?:ing)?)\b[^.?!]{0,40}?\b"
    r"(?:with|to|by|past)\s+(?:my |our )?" + _DECIDER_ROLE + r"\b",
    re.IGNORECASE,
)
# "I'll get back to you", "let me think about it", "I'll let you know", "I'll be in touch".
STALL_CLOSER = re.compile(
    r"\bget(?:ting)? back to you\b|\blet me think (?:about it|it over|this over|on it)\b"
    r"|\bi(?:'ll| will) (?:think (?:about it|it over|this over)|let you know|be in touch)\b"
    r"|\bi(?:'ll| will) (?:reach out|come back to you)\b",
    re.IGNORECASE,
)
# "still more than I planned for", "still worried about the cost", "still a lot for me".
MONEY_STRAIN = re.compile(
    r"\bstill (?:more than (?:i|we) (?:had |'d |would have )?(?:planned|hoped|budgeted|expected|"
    r"wanted)|worried about (?:the )?(?:cost|price|money|fees?)|(?:a lot|too much|steep|pricey|"
    r"expensive) for me|a (?:big|heavy) (?:number|ask))\b"
    r"|\bmore than (?:i|we) (?:had |'d |would have )?(?:planned|hoped|budgeted) (?:for|on)\b",
    re.IGNORECASE,
)


def reply_phrases(text: object) -> tuple[str, ...]:
    """The tracked phrase tics ("a stretch", the "what would it involve" template ...)."""
    folded = fold(text)
    found = []
    if STRETCH_PHRASE.search(folded):
        found.append(PHRASE_STRETCH)
    if QUESTION_TEMPLATE.search(folded):
        found.append(PHRASE_TEMPLATE_Q)
    if CONCESSION_TAG.search(folded):
        found.append(PHRASE_CONCESSION_TAG)
    if DECIDER_STALL.search(folded):
        found.append(PHRASE_DECIDER_STALL)
    if STALL_CLOSER.search(folded):
        found.append(PHRASE_STALL_CLOSER)
    if MONEY_STRAIN.search(folded):
        found.append(PHRASE_MONEY_STRAIN)
    return tuple(found)


# M032 S1 concern ledger (RCA END-5, phone map M8 / spoken-style M4).  The themes the learner
# herself voiced, read from what she actually said: once said (twice for pressure), a free reply is
# told not to say it again in any words.  Steering only: nothing is ever cut from a reply.
CONCERN_PRESSURE = "pressure"
CONCERN_OFFENDED = "offended"
CONCERN_THINK_OVER = "think_over"
CONCERN_TRUST = "trust"
# M032 SWEEP-3: the not-today stall (``not_deciding``), recorded by the engine while the flag
# R1_NO_COMMIT_LEDGER is on; it is not one of ``concern_themes``.
CONCERN_NOT_TODAY = "not_today"


def _concern(pattern: str) -> re.Pattern[str]:
    return re.compile(rf"\b(?:{pattern})\b", re.IGNORECASE)


# The think-it-over stall: the think_over theme's reader AND one arm of ``not_deciding`` (SWEEP-3:
# "have S1.5's think_over theme use the same reader, so the two cannot disagree"; review S2R-5: "Let
# me sleep on it" set only think_over, so F4-PRIMARY later said the stall again as news).  Taking
# or needing time counts only as time to think or before deciding ("I need some time to think",
# "I'll need some time before I decide"), never "some time off work" or "time to finish a project".
_THINK_OVER = _concern(
    r"think (?:it|this|that|things) (?:over|through)|"
    r"get(?:ting)? back to you(?=\s*(?:[.,;!]|$|later|after|once|when|tomorrow|next week|soon|"
    r"in a (?:few|couple of) days))|"
    r"(?:give|put) (?:it|this) (?:some )?(?:proper |more |real |serious )?thought|"
    r"sit with (?:it|this)|sleep on (?:it|this)|mull (?:it|this) over|"
    r"(?:take|need|needs|taking|needing) (?:some|a (?:bit|little)(?: (?:of|more))?|a few days'?|"
    r"a day or two|a couple of days|more) (?:time\s?)?"
    r"(?=\s*(?:[.,;!]|$|to (?:think|decide|consider|process|weigh)|before (?:i |we )?"
    r"(?:decid|commit|sign|enrol|agree|say)|for (?:this|it|that)\b|on my own\b|to myself\b|"
    r"first\b|alone\b))"
)


# Per theme: the words a negation turns around ("I'm not offended", "there's no hurry", "I don't
# need proof": review S1-R3, a false "you have already told the advisor ..." for the rest of the
# session), then the phrasings that voice the concern whatever precedes them (None: none).  Trust is
# read in its doubting forms only ("I trust you on that" voices no doubt).
_CONCERNS: tuple[tuple[str, re.Pattern[str], re.Pattern[str] | None], ...] = (
    (
        CONCERN_PRESSURE,
        _concern(r"pressur(?:e|ed|es|ing)|rush(?:ed|ing)?|hurr(?:y|ied|ying)"),
        _concern(r"pushed into|only chance|breathing room|back off|on the spot"),
    ),
    (
        CONCERN_OFFENDED,
        _concern(
            r"uncalled for|offend(?:ed|s|ing)?|hurtful|disrespect\w*|"
            r"(?:that was|that's|that is|pretty|quite|very|bit|really|so) rude"
        ),
        _concern(r"caught me off guard|sour (?:taste|note)"),
    ),
    # S1.5's own reader (R1_NO_COMMIT_LEDGER off); with it on, ``concern_themes(...,
    # shared_think_over=True)`` reads the theme with ``_THINK_OVER`` instead.
    (
        CONCERN_THINK_OVER,
        _concern(
            r"think (?:it|this|that|things) (?:over|through)|"
            r"get(?:ting)? back to you (?:later|after|once|when|tomorrow|next week|"
            r"in a (?:few|couple of) days)|"
            r"(?:give|put) (?:it|this) (?:some )?(?:proper |more |real |serious )?thought|"
            r"sit with (?:it|this)|sleep on (?:it|this)|mull (?:it|this) over|"
            r"take (?:some|a (?:bit|little) of|a few days'?|a day'?s?) (?:time|to think)"
        ),
        None,
    ),
    (
        CONCERN_TRUST,
        _concern(
            r"proof|prove (?:it|that|this)|evidence|"
            r"see (?:it|that|this|some of (?:that|it|this)|results) (?:for )?myself|"
            r"see for myself|"
            r"(?:see|know|check|hear about|look at|what's|what is) (?:your|the|their) track record"
        ),
        _concern(
            r"(?:don't|do not|can't|cannot|couldn't|hard to|not sure(?: if)?(?: i)?(?: can| could)?"
            r"|before) trust(?:ing)?|"
            r"trust (?:it|that|this|you|them|those numbers) (?:yet|blindly|just like that)|"
            r"too good to be true"
        ),
    ),
)
CONCERN_THEMES = tuple(theme for theme, _turned, _fixed in _CONCERNS)
# A negation in the same clause, at most ``NEGATION_WINDOW_WORDS`` words before the concern word.
NEGATION_WINDOW_WORDS = 3
_NEGATOR = re.compile(
    r"\b(?:not|no|never|nothing|cannot|dont|doesnt|didnt|isnt|wasnt|arent|cant|wont)\b|n't\b",
    re.IGNORECASE,
)
# ... unless the negation still voices it: an imperative clause ("please don't rush me"), "I don't
# like being rushed", "I'd rather not be rushed", "I won't be pressured".
_IMPERATIVE = re.compile(
    r"^\s*(?:(?:so|and|but|just|okay|look|please)\s+){0,2}(?:don'?t|do not|never)\b",
    re.IGNORECASE,
)
_STILL_VOICED = re.compile(
    r"(?:n't|\bnot|\bnever)\s+(?:\w+\s+)?(?:like|want|appreciate|enjoy|love)\b"
    r"|\brather not\b"
    r"|\b(?:can'?t|cannot|won'?t|will not|refuse to)\s+be\b",
    re.IGNORECASE,
)
_CLAUSE_BREAK = re.compile(r"[,.;:!?()\"]|\s-\s")


def _negated(folded: str, start: int) -> bool:
    """A negation in the clause just before ``start`` turns the concern around (review S1-R3)."""
    clause = _CLAUSE_BREAK.split(folded[max(0, start - 80) : start])[-1]
    window = " ".join(clause.split()[-NEGATION_WINDOW_WORDS:])
    if _NEGATOR.search(window) is None:
        return False
    return _IMPERATIVE.search(clause) is None and _STILL_VOICED.search(window) is None


def concern_themes(text: object, *, shared_think_over: bool = False) -> frozenset[str]:
    """The concern themes the learner's own ``text`` voices (worker-side labels only).

    ``shared_think_over`` (the engine passes R1_NO_COMMIT_LEDGER): the think_over theme is read
    with the reader ``not_deciding`` shares (SWEEP-3), else with S1.5's own, so the flag's rollback
    gives back S1's ledger exactly.
    """
    folded = fold(text)
    found: set[str] = set()
    for theme, turned, fixed in _CONCERNS:
        if theme == CONCERN_THINK_OVER and shared_think_over:
            # SWEEP-3: the very reader ``not_deciding`` uses, so the two never disagree.
            if any(_says_think_over(sentence) for sentence in split_sentences(folded)):
                found.add(theme)
            continue
        if (fixed is not None and fixed.search(folded)) or any(
            not _negated(folded, match.start()) for match in turned.finditer(folded)
        ):
            found.add(theme)
    return frozenset(found)


def is_closer(text: object) -> bool:
    """True when ``text`` is the learner closing the call itself (``CLOSER``)."""
    return CLOSER.search(fold(text)) is not None


# ----------------------------------------------------------------------------------
# M032 S3 (endings).  Readers of the learner's own sign-off and of what a reaction before the
# scripted WEAK line must not say.  Every quantifier is bounded; nothing here trims a reply by
# itself (the guard and the engine decide).
# ----------------------------------------------------------------------------------
# S3.1 (RCA END-1 missed item: her sign-offs #80-#90 matched neither CLOSER nor STALL_CLOSER): her
# real sign-off forms, besides ``CLOSER``.  "I'll get back to you" and "let me think it over" are
# also the stall (``STALL_CLOSER``), so they count as a sign-off only under the two-part rule of
# ``is_sign_off`` (the phrase ends the line and the line asks nothing) and only on a line that
# carried no owed move or negotiation line (the engine's rule).
SIGN_OFF = re.compile(
    r"\b(?:i(?:'ll| will)|let me|i(?:'d| would) like to|i need to|i want to|i should) "
    r"(?:think (?:it|this|things) (?:over|through)|get back to you|give (?:it|this) (?:some )?"
    r"(?:proper |real |more |serious )?thought|take (?:some|a (?:bit|little) of) time"
    r"(?: (?:on|over|with) (?:it|this))?|sit with (?:it|this)|sleep on (?:it|this))"
    r"(?: (?:first|properly|for a (?:bit|while|day or two)|on my (?:own|end)|tonight|"
    r"and get back to you|and come back to you))?"
    r"|\b(?:let'?s|i'?ll|i will|we can) leave it (?:there|at that)\b",
    re.IGNORECASE,
)
# What may follow the sign-off phrase at the end of the line: courtesy only.
_SIGN_OFF_TAIL = re.compile(
    r"^(?:[\s,.!-]*(?:then|now|for now|thanks?(?: you)?(?: so much)?(?: again)?|bye|goodbye|"
    r"take care|okay|ok|alright))*[\s,.!-]*$",
    re.IGNORECASE,
)


def is_sign_off(text: object) -> bool:
    """S3.1: the learner's line signs off (its last sentence ENDS on a sign-off; nothing asked).

    ``CLOSER`` ("Thanks for your time.", "Take care.") or one of her real forms (``SIGN_OFF``: "I'll
    think it over", "I'll get back to you", "let me give it some proper thought", "I'll take some
    time", "I'll sit with it", "let's leave it there"), followed by courtesy alone.  A line with a
    question mark is never a sign-off ("I'll think it over, but what about the EMI?").
    """
    folded = fold(text)
    if "?" in folded:
        return False
    sentences = split_sentences(folded)
    if not sentences:
        return False
    last = sentences[-1]
    for pattern in (SIGN_OFF, CLOSER):
        for match in pattern.finditer(last):
            if _SIGN_OFF_TAIL.match(last[match.end():]) is not None:
                return True
    return False


# SWEEP-25 B: "I should go now", "I need to get going": she is leaving.  ("I'll let you go" is a
# ``CLOSER``.)  And A2: her own request for the details by e-mail ("Could you just e-mail me the
# details instead?", "send those over").
LEAVE_TAKING = re.compile(
    r"\bi(?:'ve got to| (?:should|must|need to|have to|gotta|got to)) "
    r"(?:go|run|head off|hop off|jump off|get going|leave)\b",
    re.IGNORECASE,
)
LEARNER_EMAIL_REQUEST = re.compile(
    r"\b(?:e-?mail|send) me (?:the |those |all the )?(?:details|info|information|documents?|"
    r"brochures?|it|that)\b"
    r"|\bsend (?:it|them|those|the details|the documents?) (?:over|across|by e-?mail|on e-?mail|"
    r"to my (?:e-?mail|inbox))\b"
    r"|\bby e-?mail instead\b",
    re.IGNORECASE,
)
# Review S3R-8 (naturalness): "Can you send me the details on WhatsApp?" asks for no e-mail.
_OTHER_CHANNEL = re.compile(
    r"^\s*(?:(?:on|over|via|through|by|in|as)\s+(?:an?\s+)?)?"
    r"(?:whats\s?app|text(?:\s+message)?s?|sms|messages?|dms?|chat|phone|call)\b",
    re.IGNORECASE,
)


def asks_for_email(text: object) -> bool:
    """SWEEP-25 A2: her own request for the details by e-mail (``LEARNER_EMAIL_REQUEST``), never
    one that names another channel right after it ("send me the details on WhatsApp")."""
    folded = fold(text)
    return any(
        _OTHER_CHANNEL.match(folded[match.end() :]) is None
        for match in LEARNER_EMAIL_REQUEST.finditer(folded)
    )


def says_goodbye_or_sends(text: object) -> bool:
    """SWEEP-25 B: a sentence the 19:00 reaction must not say.

    A goodbye or sign-off, the stall, that she has to go, or a request for the e-mail (the
    scripted WEAK line says that, once).
    """
    folded = fold(text)
    return any(
        pattern.search(folded) is not None
        for pattern in (CLOSER, SIGN_OFF, STALL_CLOSER, LEAVE_TAKING, LEARNER_EMAIL_REQUEST)
    )


# ----------------------------------------------------------------------------------
# M032 S2 (owner decision D-M032-4): readers of the LEARNER's own lines, for the next reply's
# steering notes and for counts.  None of them ever trims a reply (SWEEP-4: a trimmed reply can be
# emptied, and an emptied free reply speaks "Give me a second ...").  Every quantifier is bounded.
# ----------------------------------------------------------------------------------
# SWEEP-4 (fda9e9f6: 11 of 27 learner lines were a token reaction turned round with "but" or
# "though", 8 of 27 opened by grading the advisor).  A reaction clause is short and judges or
# acknowledges what the advisor said; a clause about her own life ("I have a good job") or a
# negated one is not a reaction.
ACK_HINGE_MAX_WORDS = 12
HINGE_TAIL_WORDS = 15
_REACTION_ADJ = (
    r"(?:good|great|reasonable|reassuring|fair|helpful|useful|nice|encouraging|manageable|fine|"
    r"generous|decent|interesting|tempting|better|clear|doable|sensible|positive|a relief|"
    r"a (?:big |real )?help|a pleasant surprise)"
)
# On ``normalize``d text (lower case, apostrophes dropped: "that's" is "thats").
_GRADES = re.compile(
    r"\b(?:sounds?|seems?|looks?|feels?|is|are|was|thats|its|helps|helped)\b(?: \w+){0,2}? "
    + _REACTION_ADJ
    + r"\b"
    r"|^(?:sounds?|seems?|looks?) (?:\w+ ){0,2}?" + _REACTION_ADJ + r"\b"
    r"|\bmakes sense\b|\b(?:helps?|helped)$"
    r"|^(?:fair enough|fair point|good to (?:hear|know)|glad to hear(?: that| it)?|nice to hear|"
    r"great|good|perfect|nice|cool|fine)$"
)
_ACKNOWLEDGES = re.compile(
    r"^(?:got it|thank you|thanks(?: \w+){0,3}|noted|understood|i see|right|okay|ok)$"
    r"|^i (?:really |do |totally |completely )?(?:appreciate|get|understand|hear you|see)\b"
)
_LEAD_ACK_WORDS = frozenset(
    "okay ok oh right yeah well alright sure great good cool fine so hmm hm ah".split()
)
_NEGATING_WORDS = frozenset(
    "not never hardly no nothing none nobody neither nor dont doesnt isnt arent wasnt werent "
    "wont cant couldnt wouldnt shouldnt didnt".split()
)
_FIRST_PERSON_WORDS = frozenset("i im ive id ill my me mine myself our us".split())
_QUANTITY_PHRASE = re.compile(r"\ba (?:fair bit|good (?:chunk|amount|deal|bit)|great deal)\b")
_HINGE_JOIN = re.compile(
    r"(?:\s{0,3}(?:,|;|:|\s-+|\.\.\.)\s{0,3}|\s{1,3})(?:(?:honestly|frankly)\s{0,2},?\s{0,3})?"
    r"(?:but|though|although|however)\b",
    re.IGNORECASE,
)
_LEADING_TURN = re.compile(r"^\W{0,3}(?:but|though|although|however)\b", re.IGNORECASE)
_TRAILING_THOUGH = re.compile(r"[\s,](?:though|tho)\W{0,3}$", re.IGNORECASE)
_VERDICT_LEAD = re.compile(
    r"^\W{0,3}(?:(?:okay|ok|oh|right|yeah|well|alright|all right|so|hmm|ah)\b[\s,.!-]{0,4}){0,3}",
    re.IGNORECASE,
)
_CLAUSE_END = re.compile(
    r"[,;:]|\s-+\s|\.\.\.|\b(?:but|though|although|however|and|so)\b", re.IGNORECASE
)


def _reaction_words(clause: str) -> tuple[list[str], list[str]] | None:
    """The clause's words, and the same without its lead interjections; None when the clause is
    too long or negated to be a reaction."""
    words = normalize(clause).split()
    if not words or len(words) > ACK_HINGE_MAX_WORDS:
        return None
    if any(word in _NEGATING_WORDS for word in words):
        return None
    rest = words
    while rest and rest[0] in _LEAD_ACK_WORDS:
        rest = rest[1:]
    return words, rest


def _grades(clause: str) -> bool:
    """A short clause that judges what the advisor said ("That sounds reasonable")."""
    read = _reaction_words(clause)
    if read is None:
        return False
    words, rest = read
    text = " ".join(words)
    if any(word in _FIRST_PERSON_WORDS for word in words) or _QUANTITY_PHRASE.search(text):
        return False
    # "Good to hear" is a grade whole; "Okay, that sounds fine" once its "Okay" is off.
    return _GRADES.search(text) is not None or (
        bool(rest) and _GRADES.search(" ".join(rest)) is not None
    )


def _reacts(clause: str) -> bool:
    """A short clause that judges or only acknowledges what the advisor said ("I get it")."""
    read = _reaction_words(clause)
    if read is None:
        return False
    _words, rest = read
    if not rest:
        return True  # nothing but an interjection: "Okay, but ..."
    if _ACKNOWLEDGES.search(" ".join(rest)):
        return True
    return _grades(clause)


def ack_hinge(text: object) -> bool:
    """Her reply opens with a token reaction turned round with "but" or "though" (SWEEP-4).

    "Sounds useful, but ...", "That helps. But ...", "Makes sense. I keep worrying about it
    though.".  Not a contrast about her own life ("I've applied on my own, but nothing landed")
    and not the conflict check ("I saw $9,000 on the website, but you're saying ten?").
    """
    sentences = split_sentences(text)
    if not sentences:
        return False
    first = sentences[0]
    join = _HINGE_JOIN.search(first)
    if join is not None and join.start() > 0:
        return _reacts(first[: join.start()])
    if len(sentences) < 2 or not _reacts(first):
        return False
    second = sentences[1]
    return _LEADING_TURN.match(second) is not None or (
        word_count(second) <= HINGE_TAIL_WORDS and _TRAILING_THOUGH.search(second) is not None
    )


def reply_verdict(text: object) -> bool:
    """Her reply's first sentence opens by grading the advisor ("Fair enough.", "That sounds
    reasonable.") (SWEEP-4).  A negated grade ("That's not reasonable for me"), a quantity ("a
    fair bit more", "a good chunk of money") and a line about her own life are no verdict."""
    sentences = split_sentences(text)
    if not sentences or "?" in sentences[0]:
        return False
    first = _VERDICT_LEAD.sub("", fold(sentences[0]), count=1)
    clause = _CLAUSE_END.split(first, maxsplit=1)[0]
    return _grades(clause)


_DOUBT_OPENER = re.compile(
    r"^\W{0,3}(?:(?:okay|ok|so|well|honestly|but|and|still)\b[\s,]{0,3}){0,2}"
    r"(?:my (?:main |biggest |only |real |one )?(?:worry|concern) (?:is|would be)|"
    r"what (?:really |still )?worries me)\b",
    re.IGNORECASE,
)


def doubt_opener(text: object) -> bool:
    """Her reply opens "My worry is ..." / "What worries me ..." (a replacement tic, SWEEP-4)."""
    return _DOUBT_OPENER.search(fold(text)) is not None


# SWEEP-3: the not-today stall ("I'm not ready to commit to anything today", "I'd want to think
# it over before deciding"), and its think-it-over form (``_THINK_OVER``, the think_over theme's own
# reader, so a think-over line is always a not-today line too).  Never "pay" (a payment-capacity
# line is the money worry), and never a stall whose object is time, the schedule, a batch or money
# ("I'm not ready to commit to six months yet", "I can't commit that much time right now").  Review
# S2R-5/S2R-7: the exclusion reads only that object (the words between the verb and "today", and
# the rest of its clause), never the whole sentence, so "Four to six hours sounds manageable, but
# I'm not ready to decide today" is the stall; and the common phrasings count ("I don't want to
# decide today", "I won't be signing up today", "I'm not in a position to decide today", "I can't
# give you an answer today", a leading "Not today, ...").
_NOT_TODAY_TIME = (
    r"(?:today|tonight|yet|right now|just now|now|right away|immediately|on the spot|"
    r"on (?:this|the) call|over the phone|at the moment|this (?:minute|second))"
)
_NOT_DECIDING = re.compile(
    r"(?:\bnot|n't)\s{1,3}(?:(?:quite|really|yet|even|actually)\s{1,3})?"
    r"(?:(?:ready|going|gonna|about|able|want|wanting|wanna|planning|looking|be|"
    r"in a position|sure (?:that |if )?(?:i|we) (?:can|could|will|'ll|would|'d|should))\s{1,3})?"
    r"(?:to\s{1,3})?(?:be\s{1,3})?"
    r"(?:decid\w*|commit\w*|enrol\w*|sign(?:ing)? up|move forward|"
    r"mak(?:e|ing) (?:a|the|any|my|that|this) (?:final )?decisions?)"
    r"(?P<obj>[^.?!]{0,30}?)\b" + _NOT_TODAY_TIME + r"\b"
    r"|(?:\bcan't|\bcannot|\bwon't|\bwill not)\s{1,3}(?:give|get)\s{1,3}(?:you\s{1,3})?"
    r"(?:an?|my|any|a final)\s{1,3}(?:answer|decision)\b(?P<obj2>[^.?!]{0,20}?)\b"
    + _NOT_TODAY_TIME
    + r"\b"
    r"|^\W{0,3}(?:(?:no|um|uh|well|so|sorry|okay|look)\b,?\s{1,3}){0,2}not today\b(?!\s{0,3}\?)",
    re.IGNORECASE,
)
_NOT_DECIDING_EXCLUDED = re.compile(
    r"\b(?:months?|weeks?|hours?|schedules?|weekends?|weekdays?|evenings?|keep(?:ing)? up|"
    r"batch(?:es)?|class (?:timings?|times?)|(?:that much|this much|enough|more|the) time|"
    r"pay\w*|money|price|fees?|cost\w*|emi|instal\w*|afford\w*|budget|dollars?)\b|\$",
    re.IGNORECASE,
)
# The rest of the stall's clause: up to a comma or a clause word ("..., but", "because").
_STALL_CLAUSE_END = re.compile(
    r"[,;:]|\b(?:but|because|since|though|although|so)\b", re.IGNORECASE
)
_STALL_TAIL_CHARS = 40


def _stall_tail(sentence: str, end: int) -> str:
    """The rest of the clause after a stall that ends at ``end`` (its object, if any)."""
    tail = sentence[end : end + _STALL_TAIL_CHARS]
    return _STALL_CLAUSE_END.split(tail, maxsplit=1)[0]


def _says_think_over(sentence: str) -> bool:
    """``sentence`` (folded) voices the think-it-over stall, not negated, with no time or money
    object."""
    for match in _THINK_OVER.finditer(sentence):
        if _negated(sentence, match.start()):
            continue
        if _NOT_DECIDING_EXCLUDED.search(_stall_tail(sentence, match.end())) is None:
            return True
    return False


def not_deciding(text: object, *, think_over: bool = True) -> bool:
    """Her line says she is not deciding or committing today (SWEEP-3), sentence by sentence.

    Every think-it-over line (the think_over theme of ``concern_themes``) is one too, unless
    ``think_over`` is False: then only the not-today stall in its own words counts (the concern
    ledger names a think-over line by its own theme, never twice).
    """
    for sentence in split_sentences(text):
        if think_over and _says_think_over(sentence):
            return True
        for match in _NOT_DECIDING.finditer(sentence):
            scope = (match.group("obj") or match.group("obj2") or "") + _stall_tail(
                sentence, match.end()
            )
            if _NOT_DECIDING_EXCLUDED.search(scope) is None:
                return True
    return False


def is_hollow_turn(text: object) -> bool:
    """True when an advisor turn has nothing to answer: four words or fewer and no question.

    "Sure.", "Okay.", "Mm-hmm.", "Glad it helped." and "Of course." are hollow; a question, or any
    turn longer than a short back-channel, is not.  The learner does not say goodbye to a hollow
    turn twice in a row (``r1_roleplay``, ``r1_guard``).
    """
    folded = fold(text)
    return "?" not in folded and 0 < word_count(folded) <= HOLLOW_MAX_WORDS


_NUMBER_WORD = r"zero|one|two|three|four|five|six|seven|eight|nine|oh"
# Every quantifier below is bounded, so a long run of word characters (or dots, or
# digits) cannot trigger quadratic backtracking in these detectors.
EMAIL_WRITTEN = re.compile(r"[\w.+-]{1,64}\s?@\s?[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}")
EMAIL_SPOKEN = re.compile(
    r"\b[\w.]{1,40}(?:\s+(?:dot|underscore|dash)\s+\w{1,30}){0,6}"
    r"\s+(?:at(?:\s+the\s+rate(?:\s+of)?)?|@)\s+"
    r"(?:\w{1,30}\s+)?(?:gmail|googlemail|yahoo|outlook|hotmail|icloud|proton\w{0,10}|"
    r"rediff\w{0,10}|live|aol|example|email|mail)\b(?:\s+dot\s+\w{1,10}){0,4}",
    re.IGNORECASE,
)
EMAIL_DOMAIN_SPOKEN = re.compile(
    r"\b\w{1,40}(?:\s+dot\s+\w{1,30}){0,6}\s+at\s+(?:the\s+rate\s+)?\w{1,30}\s+dot\s+"
    r"(?:com|net|org|edu|io|in|co|us)\b",
    re.IGNORECASE,
)
PHONE_DIGITS = re.compile(r"(?<!\w)\+?\d[\d\s().-]{8,30}\d(?!\w)")
PHONE_SPOKEN = re.compile(
    r"(?:\b(?:" + _NUMBER_WORD + r")\b[\s,-]{0,3}){7,20}",
    re.IGNORECASE,
)
URL = re.compile(
    r"https?://\S{1,200}|\bwww\.\S{1,200}"
    r"|\b[\w-]{1,63}\.(?:com|net|org|io|in|co|edu|us)\b(?:/\S{0,200})?",
    re.IGNORECASE,
)
HANDLE = re.compile(r"(?<![\w@])@\w{3,}|\b(?:whatsapp|telegram|skype)\b", re.IGNORECASE)
_CONTACT_PATTERNS = (
    EMAIL_WRITTEN,
    EMAIL_SPOKEN,
    EMAIL_DOMAIN_SPOKEN,
    PHONE_DIGITS,
    PHONE_SPOKEN,
    URL,
    HANDLE,
)


def has_contact_detail(text: object) -> bool:
    """True when ``text`` spells out an e-mail address, phone number, URL or handle."""
    folded = fold(text)
    return any(pattern.search(folded) for pattern in _CONTACT_PATTERNS)


def mask_contact(text: object, limit: int | None = None) -> str:
    """Replace every contact detail with ``[contact]`` and optionally cap the length."""
    masked = fold(text).replace("\n", " ")
    for pattern in _CONTACT_PATTERNS:
        masked = pattern.sub("[contact]", masked)
    if limit is not None and len(masked) > limit:
        return masked[: max(0, limit - 3)] + "..."
    return masked


def truncate_words(text: str, cap: int) -> str:
    """Cut ``text`` to at most ``cap`` words, preferring a sentence boundary.

    Whole sentences are kept while they fit.  If even the first sentence is too long it
    is cut at a word boundary and closed with a full stop, so TTS never speaks a ragged
    fragment.
    """
    if cap <= 0:
        return ""
    kept: list[str] = []
    used = 0
    for sentence in split_sentences(text):
        size = word_count(sentence)
        if used + size <= cap:
            kept.append(sentence)
            used += size
            continue
        if not kept:
            tokens = sentence.split()
            clipped = " ".join(tokens[:cap]).rstrip(",;:-")
            kept.append(clipped if clipped.endswith((".", "?", "!")) else clipped + ".")
        break
    return " ".join(kept)


_DOLLAR = re.compile(
    r"(?:\$\s?|\busd\s?)(\d[\d,]*(?:\.\d+)?)\s*(k\b)?"
    r"|\b(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*(?:dollars?|usd|bucks)\b",
    re.IGNORECASE,
)


MAX_AMOUNT = 10**9


# ----------------------------------------------------------------------------------
# Polarity: is a phrase negated or refused by the words just before it?
# ----------------------------------------------------------------------------------
NEGATION_WINDOW = 6
# A clause ends at sentence punctuation, a spaced dash or a contrastive conjunction, so a
# negator in the previous clause ("I can't promise much, but ...") never reaches across.
_CLAUSE_BREAK = re.compile(
    r"[.?!,;:\n]|\s-+\s|\b(?:but|however|although|though|yet|except|while|whereas)\b",
    re.IGNORECASE,
)
_NEG_TOKEN = re.compile(r"[a-z0-9$%]+(?:'[a-z]+)?")
_NEGATORS = frozenset(
    {
        "no",
        "not",
        "never",
        "nothing",
        "nobody",
        "none",
        "neither",
        "nor",
        "without",
        "cannot",
        "unable",
        "hardly",
        "barely",
    }
)
# Speech-to-text sometimes drops the apostrophe ("cant", "dont").
_BARE_CONTRACTIONS = frozenset(
    {
        "cant",
        "wont",
        "dont",
        "doesnt",
        "didnt",
        "isnt",
        "arent",
        "wasnt",
        "werent",
        "couldnt",
        "wouldnt",
        "shouldnt",
        "havent",
        "hasnt",
    }
)
# "No problem, ..." and "not a problem" are courtesies, not negations of what follows.
_NO_COURTESY = frozenset({"problem", "worries", "worry", "doubt", "trouble", "issue"})


def clause_before(text: str, pos: int) -> str:
    """The clause of ``text`` that ends at ``pos`` (``text`` must already be folded)."""
    return _CLAUSE_BREAK.split(text[:pos])[-1]


def negated_before(text: str, pos: int, window: int = NEGATION_WINDOW) -> bool:
    """True when a negator sits in the same clause, at most ``window`` words before ``pos``.

    ``text`` must be folded (``fold``) so the index is stable.  "I can't guarantee a job"
    negates "guarantee"; "No problem, I can do $500 off" does not negate "$500", because
    the comma ends the clause and "no problem" is a courtesy.
    """
    tokens = _NEG_TOKEN.findall(clause_before(text, pos).lower())
    for index in range(max(0, len(tokens) - window - 1), len(tokens)):
        token = tokens[index]
        following = tokens[index + 1 : index + 3]
        if token in _NEGATORS:
            if token == "no" and following[:1] and following[0] in _NO_COURTESY:
                continue
            if token == "not" and following[:1] in (["a"], ["an"]) and following[1:2] and (
                following[1] in _NO_COURTESY
            ):
                continue
            if token == "without" and following[:1] in (["a"], ["any"]) and following[1:2] == [
                "doubt"
            ]:
                continue
            return True
        if token.endswith("n't") or token in _BARE_CONTRACTIONS:
            return True
    return False


def parse_amount(digits: str | None, thousands: bool = False) -> int | None:
    """A whole-dollar amount from "9,000", "1.5" (+ "k"), or None if it is not a sane number.

    Speech-to-text can emit absurdly long digit runs, so anything that does not parse or
    exceeds ``MAX_AMOUNT`` is rejected rather than raising.
    """
    try:
        value = float((digits or "").replace(",", "").rstrip("."))
    except ValueError:
        return None
    value = value * 1000 if thousands else value
    if not 0 <= value <= MAX_AMOUNT:
        return None
    return int(round(value))


def dollar_amounts(text: object) -> list[int]:
    """Whole-dollar amounts written as ``$9,000``, ``$9000``, ``$1.5k`` or ``500 dollars``."""
    amounts: list[int] = []
    for match in _DOLLAR.finditer(fold(text)):
        digits = match.group(1) or match.group(3)
        thousands = bool(match.group(2) or match.group(4))
        amount = parse_amount(digits, thousands)
        if amount is not None:
            amounts.append(amount)
    return amounts


# ----------------------------------------------------------------------------------
# One amount grammar for every module that reads what a person said about money.
# ----------------------------------------------------------------------------------
_SMALL = {
    "zero": 0,
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
    "thirteen": 13,
    "fourteen": 14,
    "fifteen": 15,
    "sixteen": 16,
    "seventeen": 17,
    "eighteen": 18,
    "nineteen": 19,
    "twenty": 20,
    "thirty": 30,
    "forty": 40,
    "fifty": 50,
    "sixty": 60,
    "seventy": 70,
    "eighty": 80,
    "ninety": 90,
}
_SCALE = {"hundred": 100, "thousand": 1000}
_NUMBER_WORDS_ALT = "|".join(sorted((*_SMALL, *_SCALE), key=len, reverse=True))
_SPELLED_RUN = re.compile(
    r"\b(?:an?\s+(?=(?:hundred|thousand)\b))?(?:" + _NUMBER_WORDS_ALT + r")"
    r"(?:[\s-]+(?:and\s+)?(?:" + _NUMBER_WORDS_ALT + r"))*\b"
    r"(?:\s*(?P<pct>%|per ?cent|percent)\b|\s+(?P<cur>dollars?|usd|bucks)\b)?",
    re.IGNORECASE,
)


def _spelled_value(words: list[str]) -> int:
    """Value of a spelled number such as "fifteen hundred" or "two thousand five hundred"."""
    total = 0
    current = 0
    for word in words:
        if word in ("a", "an"):
            current = 1
        elif word in _SMALL:
            current += _SMALL[word]
        elif word == "hundred":
            current = max(current, 1) * 100
        elif word == "thousand":
            total += max(current, 1) * 1000
            current = 0
    return total + current


# A count, not an amount: "five thousand alumni", "3 thousand students", "2,000 interviews",
# "1,500 seats" (review of the 8f5bfefc fix: a pitch statistic became a $5,000 offer, and the
# anchor asked "is $3,000 what I'd pay in total?").  One modifier may sit between the figure and
# the noun ("5 thousand happy alumni", "3 thousand plus learners"), never a preposition ("3
# thousand for students" is a price for them).
COUNT_NOUN_AFTER = re.compile(
    r"\s*(?:\+\s*|plus\s+)?"
    r"(?:(?!(?:for|to|per|a|an|the|of|in|on|at|from|by|with|each|every|and|or|dollars?|usd|"
    r"bucks|rupees?|inr)\b)[a-z][a-z-]*\s+)?"
    r"(?:students?|learners?|alumni|alumnus|people|persons|members|partners|companies|firms|"
    r"employers|recruiters|reviews|ratings|hours|days|weeks|months|years|problems|questions|"
    r"hires|jobs|placements|interviews|engineers|developers|professionals|graduates|mentors|"
    r"instructors|coaches|seats|candidates|users|customers|clients|participants|"
    r"enrol+ments|sign-?ups|sessions|classes|lessons|videos|projects|views|followers|"
    r"subscribers|applications|applicants|offers|calls|careers|stories|batches|cohorts|teams|"
    r"schools|colleges|universities|cities|countries|times|lines|modules|courses)\b",
    re.IGNORECASE,
)


def _counts_after(match: re.Match[str]) -> bool:
    """A count noun follows the spelled or scaled number ``match`` (and no currency word)."""
    return COUNT_NOUN_AFTER.match(match.string, match.end()) is not None


def _spelled_repl(match: re.Match[str]) -> str:
    words = re.findall(r"[a-z]+", match.group(0).lower())
    scale = any(word in _SCALE for word in words)
    if match.group("pct"):
        return f"{_spelled_value(words)}%"
    if not scale:
        return match.group(0)  # "six months": a plain small number is not an amount
    if not match.group("cur") and _counts_after(match):
        return match.group(0)  # "five thousand alumni" is a count, not an amount
    value = _spelled_value(words)
    return f"${value}" if 0 <= value <= MAX_AMOUNT else match.group(0)


# Digits before a spelled scale ("3 thousand", "2.5 thousand dollars"): the spelled-run grammar
# alone read "3 thousand" as "3 $1000" (owner test 8f5bfefc review: "for 3 thousand" was lost).
_DIGIT_SCALE = re.compile(
    r"(?<![\d$.,])(\d{1,3}(?:\.\d{1,2})?)\s*-?\s*(thousand|hundred)\b"
    r"(?P<cur>\s+(?:dollars?|usd|bucks)\b)?",
    re.IGNORECASE,
)


def _digit_scale_repl(match: re.Match[str]) -> str:
    if not match.group("cur") and _counts_after(match):
        return match.group(0)  # "3 thousand students" is a count (the spelled run skips it too)
    value = float(match.group(1)) * _SCALE[match.group(2).lower()]
    return f"${int(round(value))}" if 0 <= value <= MAX_AMOUNT else match.group(0)


def _dollar_repl(match: re.Match[str]) -> str:
    digits = match.group(1) or match.group(3)
    amount = parse_amount(digits, bool(match.group(2) or match.group(4)))
    if amount is None:
        return match.group(0)
    whole = match.group(0)
    return f"${amount}" + whole[len(whole.rstrip()) :]  # the pattern may eat trailing space


def canonical_amounts(text: object) -> str:
    """Fold ``text`` and rewrite every money expression as ``$N`` (``%`` for percentages).

    One grammar for every reader of amounts: ``$1,500``, ``$1.5k``, ``1500 dollars``,
    ``USD 1500``, ``1500 bucks``, ``fifteen hundred dollars``, ``three thousand`` and
    ``3 thousand`` all become ``$1500`` / ``$3000``, and ``ten percent`` becomes ``10%``.
    Plain small spelled numbers ("six months") are left alone.  Speech-to-text may write an
    amount either way, so no reader should depend on the ``$`` sign being there.
    """
    folded = _SPELLED_RUN.sub(_spelled_repl, _DIGIT_SCALE.sub(_digit_scale_repl, fold(text)))
    return _DOLLAR.sub(_dollar_repl, folded)


# M032 S2P (review S2P-R6): the advisor's thousands shorthand without a currency word, "9k", "9.5k",
# "nine grand", "9 grand".  Read only where the advisor's own figures are collected
# (``r1_roleplay.advisor_amounts_in``, ``r1_negotiation.named_prices``), never by the shared
# grammar above, so no other reader changes.  A count is none ("10k learners", "5k followers").
_SHORTHAND_K = re.compile(r"(?<![\w$.,])(\d{1,2}(?:\.\d{1,2})?)\s?k\b", re.IGNORECASE)
_SHORTHAND_GRAND = re.compile(
    r"\b(\d{1,2}(?:\.\d)?|" + "|".join(sorted(_SMALL, key=len, reverse=True)) + r")\s+grand\b",
    re.IGNORECASE,
)


def _shorthand_value(token: str) -> float | None:
    lowered = token.lower()
    if lowered in _SMALL:
        return float(_SMALL[lowered])
    try:
        return float(lowered)
    except ValueError:
        return None


def expand_shorthand_amounts(text: object) -> str:
    """``text`` with "9k" and "nine grand" written as "$9000" (review S2P-R6); counts stay."""

    def repl(match: re.Match[str]) -> str:
        if COUNT_NOUN_AFTER.match(match.string, match.end()) is not None:
            return match.group(0)
        value = _shorthand_value(match.group(1))
        if value is None or value <= 0:
            return match.group(0)
        return f"${int(round(value * 1000))}"

    folded = fold(text)
    return _SHORTHAND_GRAND.sub(repl, _SHORTHAND_K.sub(repl, folded))


def clause_after(text: str, pos: int) -> str:
    """The clause of ``text`` that starts at ``pos`` and runs to the next clause break."""
    stop = _CLAUSE_BREAK.search(text, pos)
    return text[pos : stop.start() if stop else len(text)]


# M032 SWEEP-18 (offer reader v2) and SWEEP-21 (price conflict).  A later-price threat or another
# batch's price is never the price on the table: "decide now or later you will have to pay $13000",
# "if you wait, you will have to pay $13000", "a new batch would be $12000".  The first form is
# ``r1_tracker._later_price_threat`` (L6) copied here, because the negotiation must not import the
# tracker (which feeds grading and is not changed); the other two forms are new.  Each needs a
# figure above the list price in the sentence.
_LATER_PRICE = re.compile(
    r"\blater\b[^.?!]{0,40}?\b(?:you|it)\b(?P<verb>[^.?!]{0,20}?)\b"
    r"(?:pay(?:ing)?|cost(?:s|ing)?|charged?)\b(?P<tail>[^.?!]{0,30})",
    re.IGNORECASE,
)
_LATER_MUST = re.compile(r"\b(?:have to|has to|need to|must|end up)\b", re.IGNORECASE)
_LATER_MORE = re.compile(
    r"(?<!\bno )(?<!\bnothing )(?<!\bany )\b(?:more|higher)\b",
    re.IGNORECASE,
)
_LATER_SURCHARGE = re.compile(
    r"\b(?:interest|in total|emis?|instal+ments?|add-?ons?|"
    r"for (?:the |an? |this |that )?(?:\w+ )?(?:plans?|modules?|mentor(?:ing|ship)|options?|"
    r"add-?ons?|sessions?|packages?|emis?|instal+ments?))\b",
    re.IGNORECASE,
)
_LATER_FIGURE = re.compile(r"\$(\d+)")
_IF_YOU_WAIT = re.compile(
    r"\bif (?:you|u) (?:wait|delay|hold off|postpone|miss (?:this|the) (?:batch|cohort|offer)|"
    r"(?:do not|don'?t) (?:join|enrol+\w*|decide|sign up|book)(?: (?:now|today))?)\b"
    r"[^.?!]{0,60}?\b(?:pay|paying|cost|costs|be|charged?)\b",
    re.IGNORECASE,
)
_OTHER_BATCH = re.compile(
    r"\b(?:new|next|later|upcoming|another|future|following) (?:batch|cohort|intake)\b"
    r"[^.?!]{0,60}?\b(?:is|be|costs?|pay|paying|priced|charged?|goes up)\b",
    re.IGNORECASE,
)
THREAT_LIST_USD = 9000


def later_price_threat(sentence: object, list_usd: int = THREAT_LIST_USD) -> bool:
    """A later-price threat or another batch's price in ``sentence`` (SWEEP-18, SWEEP-21).

    "later you will have to pay $13000" (the tracker's L6 reading, copied), "if you wait, you will
    have to pay $13000", "a new batch would be $12000".  The figure must be above ``list_usd``.
    """
    canonical = canonical_amounts(sentence)
    for match in _LATER_PRICE.finditer(canonical):
        tail = match.group("tail")
        if _LATER_MORE.search(tail) and _LATER_SURCHARGE.search(canonical[match.start():]) is None:
            return True
        if _LATER_MUST.search(match.group("verb")) and any(
            int(figure) > list_usd for figure in _LATER_FIGURE.findall(tail)
        ):
            return True
    above = any(int(figure) > list_usd for figure in _LATER_FIGURE.findall(canonical))
    if not above:
        return False
    return bool(_IF_YOU_WAIT.search(canonical) or _OTHER_BATCH.search(canonical))


# ------------------------------------------------------------------------------------------------
# M032 SWEEP-9 (flag R1_CALL_OPENING, read by ``r1_roleplay``): the call opening.  Pure, narrow and
# linear.  ``caller_introduced``: whether the advisor's first turns said where they call from or why
# ("known"), only their name ("name_only"), or neither ("").  ``asks_how_she_is``: a greeting
# question, never "how are you planning to pay?".  ``asked_who_is_calling``: HER question.
# ------------------------------------------------------------------------------------------------
CALLER_KNOWN = "known"
CALLER_NAME_ONLY = "name_only"
_CALLER_COMPANY = re.compile(
    r"\binterview\s*(?:kick|geek|kik|quick)\s*start\b|\bkick\s*start\b", re.IGNORECASE
)
_CALLER_COMPANY_CASED = re.compile(r"\bIK\b")
_CALLER_PURPOSE = re.compile(
    r"\bforms?\b|\b(?:enquiry|inquiry|enquiries|inquiries)\b|\bwebinars?\b|\bdata science\b"
    r"|\b(?:the|our|this|a) (?:courses?|programs?|programmes?|bootcamps?)\b"
    r"|\bcalling (?:about|regarding|back|from|because)\b|\bfollow(?:ing)?[- ]?up\b"
    r"|\b(?:program|programme|course|admissions?|career) (?:advisor|adviser|counsell?or|team|"
    r"consultant)s?\b"
    r"|\breaching out\b|\byour (?:interest|details|profile|application|registration)\b"
    r"|\b(?:our|the) website\b|\bsigned up\b|\bregistered\b|\b(?:enquired|inquired)\b",
    re.IGNORECASE,
)
_NAME_WORD = r"([A-Z][a-z]{1,23})"
_GREETING_LEAD = r"(?:(?:hi|hello|hey|good (?:morning|afternoon|evening))\b[\s,.!-]*)?"
_CALLER_NAMED = (
    re.compile(
        r"(?:^|[.!?,]\s*)(?i:" + _GREETING_LEAD + r"(?:[a-z]+[\s,.!-]+)?this is)\s+"
        + _NAME_WORD
        + r"\b"
    ),
    re.compile(
        r"\b(?i:i'?m|i am)\s+" + _NAME_WORD + r"(?=\s*(?:,|from\b|here\b|with\b|calling\b))"
    ),
    re.compile(r"(?:^|[.!?,]\s*)" + _NAME_WORD + r"\s+(?i:here|this side)\b"),
    re.compile(r"\b(?i:it'?s)\s+" + _NAME_WORD + r"\s+(?i:from|here)\b"),
    re.compile(r"\b" + _NAME_WORD + r"\s+(?i:from (?:the|our))\s+[A-Za-z]"),
)
_NOT_A_CALLER_NAME = frozenset(
    "hi hello hey good yes yeah okay ok so well sure great thanks thank this that it what how "
    "the our your my we you i sorry just".split()
)


def caller_introduced(text: object, names: tuple[str, ...] = ()) -> str:
    """``CALLER_KNOWN``, ``CALLER_NAME_ONLY`` or "" for the advisor's opening ``text``.

    ``names``: her own first name (a vocative, "Hi Alex", is never the caller's name).
    """
    raw = fold(text)
    if _CALLER_COMPANY.search(raw) or _CALLER_COMPANY_CASED.search(raw):
        return CALLER_KNOWN
    if _CALLER_PURPOSE.search(raw):
        return CALLER_KNOWN
    own = {name.lower() for name in names if name}
    for pattern in _CALLER_NAMED:
        for match in pattern.finditer(raw):
            word = match.group(1).lower()
            if word not in _NOT_A_CALLER_NAME and word not in own:
                return CALLER_NAME_ONLY
    return ""


_HOW_ARE_YOU = re.compile(
    r"\bhow (?:are|r) (?:you|u)\b(?! (?:planning|going|thinking|hoping|looking|managing|paying|"
    r"finding|able|feeling about)\b)(?! doing (?:with|on|in|at|about)\b)"
    r"|\bhow(?:'s| is) (?:it going|your day|everything|life)\b|\bhow have you been\b"
    r"|\bhow are things\b",
    re.IGNORECASE,
)


def asks_how_she_is(text: object) -> bool:
    """The advisor asks how she is ("how are you?", "how's your day going?")."""
    return _HOW_ARE_YOU.search(fold(text)) is not None


_WHO_IS_CALLING = re.compile(
    r"\bwho(?:'s| is| am i)\b[^.?!]{0,30}\b(?:this|calling|speaking|there|with)\b"
    r"|\bwhere (?:are you|is this|are you guys) calling from\b|\bwhich company\b"
    r"|\bwhere are you (?:from|calling)\b",
    re.IGNORECASE,
)


def asked_who_is_calling(text: object) -> bool:
    """HER line asks who is calling or from where (a question-like sentence)."""
    return any(
        is_question_like(sentence) and _WHO_IS_CALLING.search(fold(sentence)) is not None
        for sentence in split_sentences(text)
    )
