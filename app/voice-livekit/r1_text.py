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
_QUESTION_START = re.compile(
    r"^" + _DISCOURSE + r"(?:what|why|how|when|where|who|whom|which|whose|is|are|was|were|"
    r"do|does|did|can|could|would|will|shall|should|have|has|had|may|might|"
    r"tell me|walk me through|talk me through|help me understand|share|describe|explain|"
    r"i'?d (?:love|like) to (?:know|understand|hear|learn)|i'?m curious|"
    r"i was (?:wondering|curious)|i wonder|curious (?:about|whether|if)|any (?:concerns?|"
    r"thoughts|questions)|anything (?:that|else)|"
    r"i (?:want|need) to (?:know|understand|hear|learn|find out)|let me (?:ask|understand)|"
    r"i wanted to (?:know|ask|understand|hear|learn|find out)|"
    r"(?:i'?m |i am )?trying to (?:understand|figure out|find out)|"
    r"i'?m (?:interested|keen) in (?:hearing|knowing|understanding)|"
    r"what i'?d like to (?:know|understand))\b",
)
_QUESTION_ANYWHERE = re.compile(
    r"\b(?:wondering|curious) (?:if|whether|what|why|how|when|about)\b"
    r"|\b(?:so|and|but|also|now|then|well|okay|ok)\s+(?:what|why|how|when|where|who|which)\b"
)


def is_question_like(sentence: object) -> bool:
    """True for an interrogative or an elicitation such as "tell me about ...".

    Speech-to-text may drop the question mark, so the test also accepts a leading
    interrogative or elicitation phrase, optionally after a discourse opener.
    """
    folded = fold(sentence).strip()
    if "?" in folded:
        return True
    plain = re.sub(r"[^a-z0-9' ]+", " ", folded.lower())
    plain = re.sub(r"\s+", " ", plain).strip()
    if not plain:
        return False
    return bool(_QUESTION_START.match(plain) or _QUESTION_ANYWHERE.search(plain))


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


def _spelled_repl(match: re.Match[str]) -> str:
    words = re.findall(r"[a-z]+", match.group(0).lower())
    scale = any(word in _SCALE for word in words)
    if match.group("pct"):
        return f"{_spelled_value(words)}%"
    if not scale:
        return match.group(0)  # "six months": a plain small number is not an amount
    value = _spelled_value(words)
    return f"${value}" if 0 <= value <= MAX_AMOUNT else match.group(0)


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
    ``USD 1500``, ``1500 bucks``, ``fifteen hundred dollars`` and ``three thousand`` all
    become ``$1500`` / ``$3000``, and ``ten percent`` becomes ``10%``.  Plain small
    spelled numbers ("six months") are left alone.  Speech-to-text may write an amount
    either way, so no reader should depend on the ``$`` sign being there.
    """
    folded = _SPELLED_RUN.sub(_spelled_repl, fold(text))
    return _DOLLAR.sub(_dollar_repl, folded)


def clause_after(text: str, pos: int) -> str:
    """The clause of ``text`` that starts at ``pos`` and runs to the next clause break."""
    stop = _CLAUSE_BREAK.search(text, pos)
    return text[pos : stop.start() if stop else len(text)]
