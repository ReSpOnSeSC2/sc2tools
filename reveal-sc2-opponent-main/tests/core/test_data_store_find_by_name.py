"""
Tests for the discriminator-aware ``BlackBookStore.find_by_name`` lookup.

Background
----------
SC2Pulse stores ``Character.Name`` with the BattleTag discriminator
(``"Yamada#622"``), but ``sc2reader`` returns the bare in-game name
(``"Yamada"``). The legacy ``find_by_name`` only stripped clan tags,
so a replay-driven lookup of ``"Yamada"`` against a Black Book that
already had a numeric record keyed on a name like ``"Yamada#622"``
would miss and fall through to a synthetic ``"unknown:Yamada"`` key —
producing a duplicate row in the analyzer.

These tests pin the new behavior: name comparison is case-insensitive
across clan-tag-stripped and discriminator-stripped forms, and a
numeric Pulse ID is preferred over a synthetic ``unknown:<Name>`` key
when both records match.

Real Black Book shapes — no mocks.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import data_store  # noqa: E402


class StripDiscriminatorTest(unittest.TestCase):
    """Pure helper: lift the BattleTag suffix off a name."""

    def test_strips_trailing_discriminator(self) -> None:
        self.assertEqual(data_store.BlackBookStore._strip_discriminator("Yamada#622"), "Yamada")

    def test_no_op_when_no_hash(self) -> None:
        self.assertEqual(data_store.BlackBookStore._strip_discriminator("Yamada"), "Yamada")

    def test_strips_at_last_hash(self) -> None:
        # Mirrors the JS `lastIndexOf('#')` semantics so identity is
        # consistent across the two implementations.
        self.assertEqual(
            data_store.BlackBookStore._strip_discriminator("foo#bar#622"),
            "foo#bar",
        )

    def test_empty_input(self) -> None:
        self.assertEqual(data_store.BlackBookStore._strip_discriminator(""), "")
        self.assertIsNone(data_store.BlackBookStore._strip_discriminator(None))


class NameFormsTest(unittest.TestCase):
    """The set of comparable forms drives the find-by-name lookup."""

    def test_basic_name_includes_lowercase_form(self) -> None:
        forms = data_store.BlackBookStore._name_forms("Yamada")
        self.assertIn("yamada", forms)

    def test_includes_clan_and_discriminator_variants(self) -> None:
        forms = data_store.BlackBookStore._name_forms("[CLAN]Yamada#622")
        # Original lowercased.
        self.assertIn("[clan]yamada#622", forms)
        # Clan-stripped.
        self.assertIn("yamada#622", forms)
        # Discriminator-stripped (clan still present).
        self.assertIn("[clan]yamada", forms)
        # Both stripped.
        self.assertIn("yamada", forms)

    def test_empty_returns_empty_set(self) -> None:
        self.assertEqual(data_store.BlackBookStore._name_forms(""), set())
        self.assertEqual(data_store.BlackBookStore._name_forms(None), set())


class FindByNameDiscriminatorAwareTest(unittest.TestCase):
    """Replay-driven name lookups must match SC2Pulse-stored forms."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="sc2_find_by_name_")
        self.history_path = os.path.join(self.tmpdir, "MyOpponentHistory.json")
        self.bb = data_store.BlackBookStore(self.history_path)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # The bug: lookup of "Yamada" must find the "Yamada#622" record.
    def test_bare_name_matches_record_with_discriminator(self) -> None:
        self.bb.save({
            "340938838": {
                "Name": "Yamada#622",
                "Race": "Z",
                "Notes": "",
                "Matchups": {},
            },
        })
        self.assertEqual(self.bb.find_by_name("Yamada"), "340938838")

    def test_discriminator_form_matches_bare_record(self) -> None:
        # Symmetry: the live overlay path looking up the SC2Pulse name
        # form must also resolve to a record stored under the bare name.
        self.bb.save({
            "340938838": {
                "Name": "Yamada",
                "Race": "Z",
                "Notes": "",
                "Matchups": {},
            },
        })
        self.assertEqual(self.bb.find_by_name("Yamada#622"), "340938838")

    def test_clan_tag_is_still_stripped(self) -> None:
        self.bb.save({
            "234362": {
                "Name": "Ricus#545",
                "Race": "T",
                "Notes": "",
                "Matchups": {},
            },
        })
        self.assertEqual(self.bb.find_by_name("[FOO]Ricus"), "234362")

    def test_match_is_case_insensitive(self) -> None:
        self.bb.save({
            "234362": {
                "Name": "Ricus#545",
                "Race": "T",
                "Notes": "",
                "Matchups": {},
            },
        })
        self.assertEqual(self.bb.find_by_name("RICUS"), "234362")

    def test_no_match_returns_none(self) -> None:
        self.bb.save({
            "234362": {
                "Name": "Ricus#545",
                "Race": "T",
                "Notes": "",
                "Matchups": {},
            },
        })
        self.assertIsNone(self.bb.find_by_name("Yamada"))

    def test_empty_name_returns_none(self) -> None:
        self.bb.save({
            "234362": {"Name": "Ricus#545", "Race": "T", "Notes": "", "Matchups": {}},
        })
        self.assertIsNone(self.bb.find_by_name(""))
        self.assertIsNone(self.bb.find_by_name(None))

    def test_prefers_numeric_over_unknown_when_both_match(self) -> None:
        # The order of the records below is intentional: the unknown
        # key sorts ahead of the numeric one alphabetically, so a naive
        # iteration would return the unknown. The contract is that the
        # numeric ID wins.
        self.bb.save({
            "unknown:Ricus": {
                "Name": "Ricus",
                "Race": "T",
                "Notes": "",
                "Matchups": {},
            },
            "234362": {
                "Name": "Ricus#545",
                "Race": "T",
                "Notes": "",
                "Matchups": {},
            },
        })
        self.assertEqual(self.bb.find_by_name("Ricus"), "234362")

    def test_unknown_match_is_used_when_no_numeric_twin(self) -> None:
        self.bb.save({
            "unknown:Mirtillo": {
                "Name": "Mirtillo",
                "Race": "P",
                "Notes": "",
                "Matchups": {},
            },
        })
        self.assertEqual(self.bb.find_by_name("Mirtillo"), "unknown:Mirtillo")


if __name__ == "__main__":
    unittest.main()
