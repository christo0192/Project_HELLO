"""Build the learner evidence pack from local data on the machine that holds it.

Run python -m rehearsal.evidence.build_learner_evidence from app/voice-livekit;
pass --source with the local data directory when it is not in the default place.
Output is paraphrased by construction using fixed labels and aggregate statistics.
This is an offline tool: it reads no environment variables and never ships in the image.
"""
import argparse
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

SOURCE = Path.home() / 'Claude projects' / 'Customer Persona'
SMALL_CELL = 20
SIGNAL_MIN_LEADS = 50
SIGNAL_LIFT = 1.15
STALL_LIFT = 0.85
CATCH_ALL_THEMES = {'Uncategorised', 'No matching category', 'Call logistics'}
POST_DECISION_MOVES = {'payment'}

BEHAVIOURS = {'Deep evaluator': 'deep_evaluator', 'Price negotiator': 'price_negotiator',
              'Steady enquirer': 'steady_enquirer', 'Time-blocked': 'time_blocked',
              'Disengaged': 'disengaged'}
FAMILIES = {
    'Fee Feels Too High': 'F1', "Can't Afford It Right Now": 'F1', 'Wants a Discount': 'F1',
    'Payment Method Problem': 'F1', 'Program Schedule Does Not Fit': 'F2',
    'Unavailable for the Next Step Now': 'F2', 'Doubts the Program Will Pay Off': 'F3',
    'Program Does Not Match Goals': 'F3', 'Needs to Confirm Fit First': 'F3',
    'Distrust of the company or advisor': 'F3', 'Considering Alternatives': 'F3',
    'Teaching Format or Pace Concern': 'F3', 'Wants Time to Decide': 'F4',
    'Needs Family Approval': 'F4', 'No current need': 'F4'}
# These fixed labels and patterns are the only source of free-form output text.
MOVE_CATEGORIES = {
    'discovery': ('Probed goals or situation',
                  r'\b(?:goals?|aspirations?|background|experience|profiled|enquir\w*|'
                  r'probed|asked about|current (?:job|role|salary)|explor\w* '
                  r'(?:goals?|background|experience|profile))\b'),
    'goal_fit': ('Connected program to goals',
                 r'\b(?:align\w*|relevan\w*|suitab\w*|fit(?:s|ting)?|tailor\w*|'
                 r'match(?:es|ed|ing)?)\b'),
    'fee': ('Explained price or fees', r'\b(?:fees?|prices?|costs?|pricing)\b'),
    'instalments': ('Explained instalment options',
                    r'\b(?:emi|instal+ments?|install+ments?|monthly payments?|loans?|financ\w*)\b'),
    'discount': ('Mentioned an offer or discount',
                 r'\b(?:discount\w*|scholarships?|concessions?|waivers?|coupons?|cashback|'
                 r'early[ -]bird|deals?|price drops?|(?:reduced|lower|special|festive|'
                 r'limited[ -]time) (?:prices?|fees?|offers?))\b'),
    'outcomes': ('Discussed career outcomes',
                 r'\b(?:placements?|salar(?:y|ies)|outcomes?|job support|career support|'
                 r'hiring (?:partners?|support|opportunities?|process))\b'),
    'stories': ('Shared success stories or reviews',
                r'\b(?:alumni|success stor(?:y|ies)|testimonials?|reviews?)\b'),
    'trial': ('Offered sample learning', r'\b(?:demo|trial|free session|sample class)\w*'),
    'webinar': ('Discussed a webinar', r'\bwebinars?\b'),
    'schedule': ('Discussed schedule or flexibility',
                 r'\b(?:schedule\w*|recordings?|flexib\w*|weekends?|timings?|pace)\b'),
    'urgency': ('Mentioned a deadline or cohort',
                r'\b(?:deadlines?|urgenc\w*|limited seats?|seats? (?:left|remaining|available)|'
                r'cohorts?|batch(?:es)? (?:starts?|starting|deadline|fills?|full)|last date)\b'),
    'decision_maker': ('Included another decision maker',
                       r'\b(?:spouse|parents?|family|husband|wife|decision maker)\b'),
    'follow_up': ('Arranged a follow-up', r'\b(?:follow[ -]?up|callback|call back|reconnect)\w*'),
    'payment': ('Discussed payment next steps',
                r'\b(?:payment link|pay now|make payment|pay the fee|payment process)\b'),
    'refund': ('Mentioned a refund or guarantee', r'\b(?:refund\w*|money[ -]back|guarantee\w*)\b'),
    'comparison': ('Discussed alternatives',
                   r'\b(?:competitors?|alternatives?|comparison|'
                   r'compar(?:e|ed|ing)|other programs?)\b'),
    'acknowledge': ('Acknowledged or clarified a concern',
                    r'\b(?:acknowledg\w*|empath\w*|clarif\w*|concerns?)\b'),
    'other': ('Other advisor action', None)}


def classify_move(text):
    """Return fixed move categories matched in text, or other for unmatched text."""
    text = text if isinstance(text, str) else ''
    hits = {
        key for key, (_, pattern) in MOVE_CATEGORIES.items()
        if pattern and re.search(pattern, text, re.I)
    }
    return hits or ({'other'} if text else set())


def classify_response(text):
    """Return the fixed move categories used to summarise an advisor response."""
    return classify_move(text)


def family_for_theme(theme):
    """Return the mapped R1 family, or None for an unmapped theme."""
    return FAMILIES.get(theme)


def rate(num, den):
    """Return a rounded rate, or None below the small-cell floor."""
    return round(num / den, 3) if den >= SMALL_CELL else None


def median(values):
    """Return the rounded median of numeric values, excluding booleans."""
    values = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
    return round(statistics.median(values), 1) if values else None


def quantile(values, p):
    """Return an interpolated rounded quantile, or None for an empty sample."""
    if not values:
        return None
    values = sorted(values)
    pos = (len(values) - 1) * p
    lo = int(pos)
    hi = min(lo + 1, len(values) - 1)
    return round(values[lo] + (values[hi] - values[lo]) * (pos - lo), 1)


def lift(a, b):
    """Return the rounded ratio of two rates when both are usable."""
    return round(a / b, 3) if a is not None and b is not None and b > 0 else None


def entries(lead, key):
    """Return valid themed entries so malformed records are excluded."""
    return [
        x for x in lead.get(key, [])
        if isinstance(x, dict) and isinstance(x.get('theme'), str)
    ]


def enrol_rate(leads):
    """Return the enrolment rate of a group of leads (None below the small-cell floor)."""
    return rate(sum(bool(x.get('enrolled')) for x in leads), len(leads))


def moves_for(lead):
    """Return a lead's matched categories; other only when no move matched a real one."""
    moves = lead.get('moves', [])
    hits = set().union(*(classify_move(x) - {'other'} for x in moves))
    if hits:
        return hits
    return {'other'} if any(isinstance(x, str) and x.strip() for x in moves) else set()


def move_stats(leads):
    """Return category rates and lifts for enrolled and non-enrolled leads."""
    enrolled = [x for x in leads if x.get('enrolled')]
    others = [x for x in leads if not x.get('enrolled')]
    counts = [Counter(cat for x in group for cat in moves_for(x)) for group in (enrolled, others)]
    result = {}
    for key, (label, _) in MOVE_CATEGORIES.items():
        a = rate(counts[0][key], len(enrolled))
        b = rate(counts[1][key], len(others))
        result[key] = {
            'label': label,
            'n_enrolled': len(enrolled),
            'n_not_enrolled': len(others),
            'rate_enrolled': a,
            'rate_not_enrolled': b,
            'lift': lift(a, b),
            'post_decision': key in POST_DECISION_MOVES,
        }
    return result


def _by_theme(leads, key):
    """Return {theme: [(lead, entry), ...]} for one entry list of every lead."""
    groups = defaultdict(list)
    for lead in leads:
        for item in entries(lead, key):
            groups[item['theme']].append((lead, item))
    return groups


def _unique_leads(rows):
    """Return the distinct leads behind (lead, entry) rows, keyed by identity."""
    return list({id(lead): lead for lead, _ in rows}.values())


def _signal_kind(n, value, family):
    """Classify an objection theme from its lead count, conditional lift and family."""
    if n >= SIGNAL_MIN_LEADS and value is not None and value >= SIGNAL_LIFT:
        return 'buying_signal'
    if family == 'F4' or (value is not None and value <= STALL_LIFT):
        return 'stall'
    return 'objection'


def profile(leads):
    """Return aggregate objection, question and move statistics for a lead group."""
    n = len(leads)
    engaged_rate = enrol_rate([x for x in leads if entries(x, 'objections')])
    obs = _by_theme(leads, 'objections')
    qs = _by_theme(leads, 'questions')
    total = sum(map(len, obs.values()))
    mix, resolutions = {}, {}
    for theme, rows in sorted(obs.items()):
        enrolled_rows = [(lead, obj) for lead, obj in rows if lead.get('enrolled')]
        advanced = [(lead, obj) for lead, obj in enrolled_rows if obj.get('outcome') == 'advanced']
        mix[theme] = {
            'n_objections': len(rows),
            'n_enrolled_objections': len(enrolled_rows),
            'rate_per_lead': rate(len(_unique_leads(rows)), n),
            'share_of_objections': rate(len(rows), total),
            'median_minute': median([x.get('minute') for _, x in rows]),
            'r1_family': family_for_theme(theme),
            'resolved_rate': rate(sum(x.get('outcome') == 'advanced' for _, x in rows), len(rows)),
            'enrolled_resolved_rate': rate(len(advanced), len(enrolled_rows)),
        }
        cats = Counter(
            cat for _, obj in advanced for cat in classify_response(obj.get('response', ''))
        )
        top = sorted(cats.items(), key=lambda x: (-x[1], x[0]))[:4]
        resolutions[theme] = {
            'n': len(advanced),
            'patterns': [
                {'pattern': MOVE_CATEGORIES[k][0], 'share': rate(v, len(advanced))}
                for k, v in top
            ],
        }
    qitems = sorted(qs.items(), key=lambda x: (-len(_unique_leads(x[1])), x[0]))[:6]
    questions = [
        {
            'theme': theme,
            'rate_per_lead': rate(len(_unique_leads(rows)), n),
            'median_minute': median([x.get('minute') for _, x in rows]),
        }
        for theme, rows in qitems
    ]
    counts = [len(entries(x, 'objections')) for x in leads]
    signal = stall = 0
    for theme, rows in obs.items():
        unique = _unique_leads(rows)
        kind = _signal_kind(
            len(unique), lift(enrol_rate(unique), engaged_rate), family_for_theme(theme)
        )
        if kind == 'buying_signal':
            signal += len(rows)
        elif kind == 'stall':
            stall += len(rows)
    return {
        'n': n,
        'share': None,
        'enrol_rate': enrol_rate(leads),
        'objections_per_lead': {
            'mean': round(sum(counts) / n, 3) if n else None,
            'median': median(counts),
            'p25': quantile(counts, .25),
            'p75': quantile(counts, .75),
            'share_with_2_to_4': rate(sum(2 <= x <= 4 for x in counts), n),
        },
        'objection_mix': mix,
        'signal_balance': {
            'n': total,
            'buying_signal_share': rate(signal, total),
            'stall_share': rate(stall, total),
        },
        'top_question_themes': questions,
        'move_categories': move_stats(leads),
        'resolutions': resolutions,
    }


def theme_stats(leads, key, base):
    """Return theme-level enrolment lifts and classifications for the selected entries.

    The lift is against leads with at least one entry of the same kind, because raising
    anything at all already marks a longer, more engaged call.
    """
    conditional = enrol_rate([x for x in leads if entries(x, key)])
    result = {}
    for theme, rows in sorted(_by_theme(leads, key).items()):
        unique = _unique_leads(rows)
        theme_rate = enrol_rate(unique)
        value = lift(theme_rate, conditional)
        all_lift = lift(theme_rate, base)
        if key == 'questions':
            buying = (
                len(unique) >= SIGNAL_MIN_LEADS and value is not None and value >= SIGNAL_LIFT
            )
            result[theme] = {
                'enrol_lift': value,
                'enrol_lift_vs_all': all_lift,
                'kind': 'buying_signal' if buying else 'neutral',
                'n': len(unique),
                'median_minute': median([x.get('minute') for _, x in rows]),
            }
        else:
            family = family_for_theme(theme)
            result[theme] = {
                'r1_family': family,
                'kind': _signal_kind(len(unique), value, family),
                'enrol_lift': value,
                'enrol_lift_vs_all': all_lift,
                'n': len(unique),
                'rationale': 'Classified by mapped concern and observed enrolment lift.',
            }
    return result


def flow(leads):
    """Return prevalent conversation stages ordered by their median timing."""
    rows = []
    for key, kind in (('questions', 'question'), ('objections', 'objection')):
        for theme, items in _by_theme(leads, key).items():
            if theme in CATCH_ALL_THEMES:
                continue
            minute = median([x.get('minute') for _, x in items])
            if minute is not None:
                rows.append({
                    'stage': theme,
                    'type': kind,
                    'median_minute': minute,
                    'rate_per_lead': rate(len(_unique_leads(items)), len(leads)),
                })
    # Select the most prevalent stages, then order them by observed time.
    rows.sort(key=lambda x: (-(x['rate_per_lead'] or 0), x['stage'], x['type']))
    return sorted(rows[:8], key=lambda x: (x['median_minute'], x['stage'], x['type']))


def call_minutes(lead):
    """Return numeric timeline durations, excluding booleans and malformed entries."""
    return [
        t['minutes'] for t in lead.get('timeline', [])
        if isinstance(t, dict)
        and isinstance(t.get('minutes'), (int, float))
        and not isinstance(t['minutes'], bool)
    ]


def _per_group(groups, fn):
    """Return {group name: median of fn(lead)} for the enrolled / not-enrolled split."""
    return {name: median([fn(x) for x in leads]) for name, leads in groups.items()}


def build_evidence(data):
    """Return the privacy-safe evidence pack from aggregated call data."""
    calls = data.get('calls', [])
    leads = [x for x in calls if not x.get('prior_customer')]
    n = len(leads)
    enrolled = sum(bool(x.get('enrolled')) for x in leads)
    base = rate(enrolled, n)

    def make(group):
        p = profile(group)
        p['share'] = rate(len(group), n)
        return p

    behaviours = {
        slug: make([x for x in leads if x.get('behaviour') == name])
        for name, slug in BEHAVIOURS.items()
    }
    ids = {x['name']: x['pid'] for x in data.get('personas', []) if 'name' in x and 'pid' in x}
    persona_names = set(ids) | {x.get('persona') for x in leads if x.get('persona')}
    personas = {}
    for name in sorted(persona_names):
        slug = ids.get(name, re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_'))
        group = [x for x in leads if x.get('persona') == name]
        label = name.replace('—', '-').replace('�', '-')
        personas[slug] = {'label': label, **make(group)}
    groups = {
        'enrolled': [x for x in leads if x.get('enrolled')],
        'not_enrolled': [x for x in leads if not x.get('enrolled')],
    }
    return {
        'schema_version': 1,
        'source': {
            'window': 'Jul-Oct 2026',
            'market': 'India',
            'leads': n,
            'excluded_prior_customers': len(calls) - n,
            'enrolled': enrolled,
            'enrol_rate': base,
            'objections': sum(len(entries(x, 'objections')) for x in leads),
            'note': 'aggregates only; prior customers excluded',
        },
        'us_adaptation': {
            'market': 'R1 retains a US learner and USD.',
            'payment': (
                'Instalments, bank loans, discounts and refunds and guarantees are India '
                'patterns only; R1 must use r1_world terms.'
            ),
        },
        'behaviour_types': behaviours,
        'persona_groups': personas,
        'signal_method': (
            'Lift uses the enrolment rate among leads with at least one item of the same type.'
        ),
        'theme_map': theme_stats(leads, 'objections', base),
        'question_signals': theme_stats(leads, 'questions', base),
        'move_categories': move_stats(leads),
        'call_flow': {
            **{name: flow(group) for name, group in groups.items()},
            'median_longest_call_minutes': _per_group(
                groups, lambda x: max(call_minutes(x), default=0)
            ),
            'median_total_call_minutes': _per_group(groups, lambda x: sum(call_minutes(x))),
            'median_connected_calls_per_lead': _per_group(groups, lambda x: x.get('n_connected')),
            'median_calls_per_lead': _per_group(groups, lambda x: x.get('n_calls')),
        },
        'overall': make(leads),
    }


def load_app_data(path):
    """Return the JSON object embedded in the local JavaScript data file."""
    text = Path(path).read_text(encoding='utf-8')
    return json.loads(text[text.index('{'):text.rindex('}') + 1])


def main(argv=None):
    """Write the evidence pack as deterministic JSON from the local data source."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=SOURCE)
    parser.add_argument(
        '--out', type=Path, default=Path(__file__).with_name('learner_evidence.json')
    )
    args = parser.parse_args(argv)
    data = load_app_data(args.source / 'app' / 'data_3m.js')
    output = json.dumps(build_evidence(data), indent=2, sort_keys=True, ensure_ascii=False)
    args.out.write_text(output + '\n', encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
