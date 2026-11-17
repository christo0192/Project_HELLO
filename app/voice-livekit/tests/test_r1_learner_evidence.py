"""Tests for privacy-safe learner evidence.

Builder and artifact tests always run on synthetic text and the committed JSON. The local
privacy tests need the real lead data, so they RETURN EARLY (never skip) when it is absent:
the CI SDK step fails on any skipped test.
"""
import ast
import json
import re
import unittest
from pathlib import Path

from rehearsal.evidence import build_learner_evidence as ev

ARTIFACT = Path(ev.__file__).with_name('learner_evidence.json')
SOURCE = ev.SOURCE
LEAD_TEXT_KEYS = frozenset({
    'quote', 'response', 'what', 'summary', 'moves', 'outcomes', 'goals', 'pains',
    'motivations', 'gaps',
})
COMMON_WORDS = frozenset({
    'a', 'an', 'and', 'or', 'the', 'of', 'to', 'for', 'in', 'on', 'by',
    'with', 'from', 'is', 'as', 'at', 'be', 'it', 'us', 'india', 'only',
    'real', 'call', 'calls', 'lead', 'leads', 'market', 'source', 'pattern',
    'patterns', 'rate', 'share', 'other', 'no', 'current', 'now', 'time',
    'decision', 'advisor', 'action', 'program', 'payment', 'career', 'fee',
    'price', 'fit', 'family', 'schedule', 'outcome', 'concern', 'support',
    'learning', 'mentioned', 'discussed', 'explained', 'offered', 'included',
    'observed', 'required', 'before', 'adoption', 'policy', 'owner', 'r1',
    'usd', 'classified', 'mapped', 'enrolment', 'lift', 'aggregate',
    'aggregates', 'prior', 'customers', 'excluded', 'july',
})
GENERIC_LEAK = re.compile(
    r'[\w.+-]+@[\w.-]+\.[a-z]{2,}'            # email
    r'|(?<!\w)\+?\d[\d +()-]{5,}\d'           # phone-like digit run
    r'|\d{6,}'                                # any 6+ digit run
    r'|\b(?:OBJ|OUT)-[0-9][a-z0-9-]*'         # analysis row ids
    r'|\b00T[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?\b'  # CRM record ids
    r'|lead_id|c:\\|users',                   # id fields and local paths
    re.I,
)


def strings(value):
    """Yield every key and string value in a JSON-like value."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, str):
        yield value


def grams(text):
    """Yield the lower-cased 6-word windows of text."""
    words = re.findall(r'\w+', text.lower())
    return zip(*(words[i:] for i in range(6)))


def corpus_strings(value, active=False):
    """Yield free lead text: strings under any LEAD_TEXT_KEYS key, at any depth."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from corpus_strings(item, active or key in LEAD_TEXT_KEYS)
    elif isinstance(value, list):
        for item in value:
            yield from corpus_strings(item, active)
    elif active and isinstance(value, str):
        yield value


class BuilderTests(unittest.TestCase):
    def test_classifiers_and_mapping(self):
        self.assertIn('fee', ev.classify_move('Explained the fee and monthly payment plan'))
        self.assertIn('instalments', ev.classify_response('Explained the monthly payment plan'))
        self.assertEqual(ev.family_for_theme('Fee Feels Too High'), 'F1')
        self.assertIsNone(ev.family_for_theme('unknown'))

    def test_precise_moves(self):
        self.assertNotIn('discount', ev.classify_move('offered a demo session'))
        self.assertIn('discount', ev.classify_move('offered a festive discount on the fee'))
        self.assertNotIn('stories', ev.classify_move('reviewed the profile'))
        self.assertNotIn('goal_fit', ev.classify_move('benefits of the program'))
        self.assertIn('discovery', ev.classify_move('asked about current job'))
        self.assertNotIn('other', ev.moves_for({'moves': ['explained the fee', 'miscellaneous']}))

    def test_conditional_signal(self):
        calls = [
            {'enrolled': i < 60, 'objections': [{'theme': 'Fee Feels Too High'}],
             'questions': []}
            for i in range(100)
        ]
        calls += [{'enrolled': False, 'objections': [], 'questions': []} for _ in range(100)]
        theme = ev.build_evidence({'calls': calls})['theme_map']['Fee Feels Too High']
        self.assertNotEqual(theme['kind'], 'buying_signal')
        self.assertEqual(theme['enrol_lift'], 1.0)
        self.assertEqual(theme['enrol_lift_vs_all'], 2.0)

    def test_flow_and_call_metrics(self):
        calls = [
            {'enrolled': True, 'n_calls': 2, 'n_connected': 1,
             'timeline': [{'minutes': 1}, {'minutes': 5}],
             'questions': [{'theme': 'Call logistics', 'minute': 1}],
             'objections': []}
            for _ in range(20)
        ]
        result = ev.build_evidence({'calls': calls})
        flow = result['call_flow']
        self.assertEqual(flow['enrolled'], [])
        self.assertEqual(flow['median_longest_call_minutes']['enrolled'], 5)
        self.assertEqual(flow['median_total_call_minutes']['enrolled'], 6)
        self.assertEqual(flow['median_connected_calls_per_lead']['enrolled'], 1)
        self.assertTrue(result['move_categories']['payment']['post_decision'])

    def test_exclusion_small_cells_and_determinism(self):
        lead = {
            'enrolled': True, 'behaviour': 'Deep evaluator', 'persona': 'Example',
            'objections': [{'theme': 'Fee Feels Too High', 'outcome': 'advanced',
                            'response': 'Explained fee', 'minute': 2}],
            'questions': [],
        }
        data = {'calls': [lead, dict(lead, prior_customer=True)], 'personas': []}
        result = ev.build_evidence(data)
        self.assertEqual(result['source']['leads'], 1)
        self.assertEqual(result['source']['excluded_prior_customers'], 1)
        self.assertIsNone(result['overall']['enrol_rate'])
        mix = result['overall']['objection_mix']['Fee Feels Too High']
        self.assertIsNone(mix['resolved_rate'])
        again = ev.build_evidence(data)
        self.assertEqual(json.dumps(result, sort_keys=True), json.dumps(again, sort_keys=True))

    def test_signal(self):
        calls = [
            {'enrolled': i < 60,
             'objections': [{'theme': 'Fee Feels Too High' if i < 50 else 'Other concern'}],
             'questions': [], 'behaviour': 'Deep evaluator'}
            for i in range(100)
        ]
        theme_map = ev.build_evidence({'calls': calls})['theme_map']
        self.assertEqual(theme_map['Fee Feels Too High']['kind'], 'buying_signal')

    def test_builder_reads_no_environment(self):
        source = Path(ev.__file__).read_text(encoding='utf-8')
        self.assertNotIn('os.environ', source)
        self.assertNotIn('getenv', source)


class ArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(ARTIFACT.read_text(encoding='utf-8'))

    def test_schema(self):
        d = self.data
        self.assertEqual(d['schema_version'], 1)
        sections = {
            'source', 'us_adaptation', 'behaviour_types', 'persona_groups', 'theme_map',
            'question_signals', 'move_categories', 'call_flow', 'overall',
        }
        self.assertTrue(sections <= d.keys())
        self.assertEqual(set(d['behaviour_types']), set(ev.BEHAVIOURS.values()))
        shares = sum(x['share'] for x in d['behaviour_types'].values())
        self.assertAlmostEqual(shares, 1, delta=.003)
        families = (None, 'F1', 'F2', 'F3', 'F4')
        self.assertTrue(all(x['r1_family'] in families for x in d['theme_map'].values()))
        self.assertIsNotNone(d['overall']['objections_per_lead']['median'])

        def is_rate(key):
            return (key == 'share' or key.endswith('_share') or key.startswith('rate_')
                    or key.endswith('_rate'))

        def check(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if isinstance(item, (int, float)) and not isinstance(item, bool):
                        if is_rate(key):
                            self.assertGreaterEqual(item, 0)
                            self.assertLessEqual(item, 1)
                        if key in ('lift', 'enrol_lift'):
                            self.assertGreaterEqual(item, 0)
                    check(item)
            elif isinstance(value, list):
                for item in value:
                    check(item)

        check(d)

    def test_strings_are_known_or_short_labels(self):
        # Schema identifiers and fixed text are authored in the builder.
        tree = ast.parse(Path(ev.__file__).read_text(encoding='utf-8'))
        known = {
            node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }
        known.update(ev.BEHAVIOURS)
        known.update(ev.BEHAVIOURS.values())
        known.update(ev.FAMILIES.values())
        known.update(self.data['persona_groups'])
        label = re.compile(r"[A-Za-z][A-Za-z .,'&()/\-]*\Z")
        for value in strings(self.data):
            self.assertTrue(value in known or (len(value) <= 60 and label.fullmatch(value)),
                            repr(value))

    def test_resolution_schema(self):
        for resolution in self.data['overall']['resolutions'].values():
            self.assertEqual(set(resolution), {'n', 'patterns'})
            self.assertTrue(all('n' not in pattern for pattern in resolution['patterns']))
        for entry in self.data['overall']['objection_mix'].values():
            self.assertNotIn('n_leads', entry)
            self.assertNotIn('n_all_objections', entry)

    def test_generic_privacy(self):
        leaks = [x for x in strings(self.data) if GENERIC_LEAK.search(x)]
        self.assertEqual(leaks, [])

    def test_generic_privacy_pattern_catches_synthetic_leaks(self):
        for text in ('reach me at someone@example.com', 'call +1 (555) 010-0199',
                     'row 1234567', 'OBJ-12-ab', 'lead_id'):
            self.assertTrue(GENERIC_LEAK.search(text), text)
        self.assertIsNone(GENERIC_LEAK.search('Fee Feels Too High'))


class LocalPrivacyTests(unittest.TestCase):
    """Needs the local lead data; each test returns early (not skip) without it."""

    @classmethod
    def setUpClass(cls):
        cls.data = ev.load_app_data(SOURCE / 'app' / 'data_3m.js') if SOURCE.exists() else None
        cls.artifact = json.loads(ARTIFACT.read_text(encoding='utf-8'))

    @classmethod
    def tearDownClass(cls):
        cls.data = None

    def test_no_six_word_overlap(self):
        if not SOURCE.exists():
            return
        output_grams = {gram for text in strings(self.artifact) for gram in grams(text)}
        for section in ('calls', 'exchanges', 'obj_rows'):
            for text in corpus_strings(self.data.get(section, [])):
                self.assertFalse(any(g in output_grams for g in grams(text)),
                                 'Source phrase overlaps output')

    def test_no_harvested_names(self):
        if not SOURCE.exists():
            return
        names_path = SOURCE / 'analysis' / 'harvested_names.json'
        names = json.loads(names_path.read_text(encoding='utf-8'))
        groups = self.data.get('personas', []) + self.data.get('persona_groups', [])
        labels = [x.get('name', '') for x in groups]
        labels += list(ev.BEHAVIOURS)
        labels += list(self.artifact['theme_map']) + list(self.artifact['question_signals'])
        allowed = set(re.findall(r'\w+', ' '.join(labels).lower())) | COMMON_WORDS
        text = ' '.join(set(re.findall(r'\w+', ' '.join(strings(self.artifact)).lower())))
        offenders = [
            name for name in names
            if len(name) >= 3 and name.lower() not in allowed
            and re.search(r'(?<!\w)' + re.escape(name.lower()) + r'(?!\w)', text)
        ]
        self.assertEqual(len(offenders), 0, str(len(offenders)))

    def test_rebuild(self):
        if not SOURCE.exists():
            return
        output = json.dumps(ev.build_evidence(self.data), sort_keys=True, indent=2,
                            ensure_ascii=False) + '\n'
        self.assertEqual(output, ARTIFACT.read_text(encoding='utf-8'))
