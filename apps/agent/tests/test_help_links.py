"""Every help topic the agent source opens is one the website publishes."""
from __future__ import annotations

import ast
from pathlib import Path

import sc2tools_agent
from sc2tools_agent.ui.help_links import AGENT_HELP_SLUGS

# Where the slug sits in each call that opens or builds a help link.
SLUG_ARGUMENT = {"open_help": 0, "_open_help": 0, "_help_url": 0, "help_url": 1, "_help_label": 1}


def help_calls():
    found, unchecked = [], []
    for path in sorted(Path(sc2tools_agent.__file__).parent.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            position = SLUG_ARGUMENT.get(getattr(node.func, "attr", getattr(node.func, "id", None)))
            if position is None or len(node.args) <= position:
                continue
            argument, where = node.args[position], f"{path.name}:{node.lineno}"
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                found.append((argument.value, where))
            elif not (isinstance(argument, ast.Name) and argument.id == "slug"):
                unchecked.append(f"{where} {ast.unparse(argument)}")
    return found, unchecked


def test_every_help_slug_in_the_agent_source_is_allowed():
    found, unchecked = help_calls()
    # Only the wrappers forward a variable (their own ``slug``); anything else can't be checked here.
    assert unchecked == []
    assert [f"{where} {slug}" for slug, where in found if slug not in AGENT_HELP_SLUGS] == []
    # Every allowed topic is still linked, so a renamed helper can't quietly empty the scan.
    assert {slug for slug, _where in found} == set(AGENT_HELP_SLUGS)
