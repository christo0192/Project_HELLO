"""The simulator speaks of the R1 interviewer by the active persona (R1_INTERVIEWER_DEX).

Stored records and the move library keep the name they were written with.
"""
from __future__ import annotations

import re

import r1_script

_NAME_PATTERN = re.compile(r"\b" + re.escape(r1_script.INTERVIEWER_NAME) + r"\b", re.IGNORECASE)


def name() -> str:
    """Return the active interviewer name."""
    return r1_script.interviewer_name()


def upper_name() -> str:
    """Return the active interviewer name in uppercase."""
    return name().upper()


def fill(template: str) -> str:
    """Fill persona placeholders in a template."""
    he, him, his = r1_script.interviewer_pronouns()
    for token, value in (("{name}", name()), ("{NAME}", upper_name()), ("{he}", he),
                         ("{him}", him), ("{his}", his), ("{He}", he.capitalize()),
                         ("{His}", his.capitalize())):
        template = template.replace(token, value)
    return template


def _replace_name(match: re.Match) -> str:
    """Match the replacement name to the original case."""
    word = match.group()
    return upper_name() if word.isupper() else name().lower() if word.islower() else name()


def swap_name(text: str) -> str:
    """Replace whole occurrences of the original interviewer name."""
    if name() == r1_script.INTERVIEWER_NAME:
        return text
    return _NAME_PATTERN.sub(_replace_name, text)
