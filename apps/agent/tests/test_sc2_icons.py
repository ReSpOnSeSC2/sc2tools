from __future__ import annotations

import os

import pytest

from sc2tools_agent.ui import sc2_icons


_NAMESPACES = {"unit": "units", "building": "buildings", "upgrade": "upgrades", "race": "races"}
_FORM_ALIASES = {
    "SiegeTankSieged": "siegetank", "VikingAssault": "viking", "VikingFighter": "viking",
    "ThorAP": "thor", "LiberatorAG": "liberator", "WidowMineBurrowed": "widowmine",
    "LurkerMP": "lurker", "LurkerMPBurrowed": "lurker", "SwarmHostMP": "swarmhost",
    "SwarmHostBurrowedMP": "swarmhost", "OverseerSiegeMode": "overseer",
    "ObserverSiegeMode": "observer", "WarpPrismPhasing": "warpprism",
    "OverlordTransport": "overlord", "OverlordCocoon": "overlord", "BanelingCocoon": "baneling",
    "RavagerCocoon": "ravager", "BroodLordCocoon": "broodlord", "BanelingBurrowed": "baneling",
    "DroneBurrowed": "drone", "HydraliskBurrowed": "hydralisk", "InfestorBurrowed": "infestor",
    "QueenBurrowed": "queen", "RavagerBurrowed": "ravager", "RoachBurrowed": "roach",
    "UltraliskBurrowed": "ultralisk", "ZerglingBurrowed": "zergling",
    "SupplyDepotLowered": "supplydepot", "BarracksFlying": "barracks", "FactoryFlying": "factory",
    "StarportFlying": "starport", "CommandCenterFlying": "commandcenter",
    "OrbitalCommandFlying": "orbitalcommand", "SpineCrawlerUprooted": "spinecrawler",
    "SporeCrawlerUprooted": "sporecrawler",
}


@pytest.fixture
def qt_app():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    pytest.importorskip("PySide6")
    from PySide6 import QtGui, QtWidgets
    application = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    yield application, QtGui


def assert_painted(icon, QtGui):
    pixmap = icon.pixmap(38, 38)
    assert not pixmap.isNull()
    image = pixmap.toImage().convertToFormat(QtGui.QImage.Format_RGBA8888)
    pixels = image.constBits().tobytes()
    assert any(pixels[3::4])
    assert len(set(pixels)) > 4


def test_unknown_categories_find_exact_bundled_units_without_changing_source():
    for name in ("Sentry", "Phoenix", "Marine", "Hydralisk"):
        expected = sc2_icons.icon_root() / "units" / (name.lower() + ".png")
        assert next(sc2_icons.icon_paths(name, "unknown")) == expected
        assert next(sc2_icons.icon_paths(name, None)) == expected
        assert next(sc2_icons.icon_paths(name, "building")) == expected


def test_every_bundled_entity_and_race_has_a_real_offline_icon(qt_app):
    application, QtGui = qt_app
    counts = {}
    for kind, directory in _NAMESPACES.items():
        assets = sorted((sc2_icons.icon_root() / directory).glob("*"))
        counts[kind] = len(assets)
        for path in assets:
            assert next(sc2_icons.icon_paths(path.stem, kind)) == path
            assert next(sc2_icons.icon_paths(path.stem, "unknown")) == path
            assert_painted(sc2_icons.load_icon(path.stem, kind, QtGui=QtGui), QtGui)
            assert_painted(sc2_icons.load_icon(path.stem, "unknown", QtGui=QtGui), QtGui)
    assert counts["unit"] >= 50 and counts["building"] >= 40 and counts["upgrade"] >= 80
    assert counts["race"] == 4


@pytest.mark.parametrize(("alias", "expected"), [("P", "protoss"), ("T", "terran"), ("Z", "zerg"), ("R", "random")])
def test_short_race_names_have_painted_svg_icons(qt_app, alias, expected):
    application, QtGui = qt_app
    assert next(sc2_icons.icon_paths(alias, "race")).name == expected + ".svg"
    assert next(sc2_icons.icon_paths(alias, "unknown")).name == expected + ".svg"
    assert_painted(sc2_icons.load_icon(alias, "race", QtGui=QtGui), QtGui)


def test_replay_unit_and_building_forms_resolve_to_their_actual_offline_art(qt_app):
    application, QtGui = qt_app
    for alias, expected in _FORM_ALIASES.items():
        assert next(sc2_icons.icon_paths(alias, "unknown")).stem == expected
        assert_painted(sc2_icons.load_icon(alias, "unknown", QtGui=QtGui), QtGui)


@pytest.mark.parametrize(("name", "expected"), [
    ("FactoryTechLab", "techlab"), ("StarportReactor", "reactor"),
    ("ProtossGroundArmorsLevel2", "protossgroundarmor2"),
    ("TerranVehicleAndShipArmorsLevel3", "terranvehiclearmor3"),
    ("ZergFlyerWeaponsLevel1", "zergflyerattacks1"), ("BlinkTech", "blink"),
])
def test_unknown_namespace_also_applies_explicit_addon_and_research_aliases(name, expected):
    assert next(sc2_icons.icon_paths(name, "unknown")).stem == expected


def test_declared_namespace_wins_when_exact_names_collide(tmp_path):
    for directory in ("units", "buildings", "upgrades"):
        (tmp_path / directory).mkdir()
        (tmp_path / directory / "shared.png").write_bytes(b"fixture")
    assert next(sc2_icons.icon_paths("Shared", "building", root=tmp_path)).parent.name == "buildings"
    assert next(sc2_icons.icon_paths("Shared", "upgrade", root=tmp_path)).parent.name == "upgrades"
    assert next(sc2_icons.icon_paths("Shared", "unknown", root=tmp_path)).parent.name == "units"


@pytest.mark.parametrize("name", [None, True, 12, "", " / . ", "MissingUnit", "SentryUpgradeLevel9"])
def test_truly_unknown_or_invalid_entities_keep_an_empty_icon(name, qt_app):
    application, QtGui = qt_app
    assert not list(sc2_icons.icon_paths(name, "unknown"))
    assert sc2_icons.load_icon(name, "unknown", QtGui=QtGui).isNull()


def test_lookup_normalization_never_escapes_the_offline_asset_root():
    root = sc2_icons.icon_root()
    for name in ("../../Sentry", "..\\Phoenix", "https://example.com/icon.png"):
        assert all(path.is_relative_to(root) for path in sc2_icons.icon_paths(name, "unknown"))


def test_corrupt_preferred_asset_does_not_hide_a_painted_fallback(tmp_path, qt_app):
    application, QtGui = qt_app
    (tmp_path / "units").mkdir()
    (tmp_path / "buildings").mkdir()
    (tmp_path / "units" / "sentry.png").write_bytes(b"not an image")
    (tmp_path / "buildings" / "sentry.png").write_bytes((sc2_icons.icon_root() / "units" / "sentry.png").read_bytes())
    assert_painted(sc2_icons.load_icon("Sentry", "unit", QtGui=QtGui, root=tmp_path), QtGui)


def test_packaged_icon_root_is_preferred_and_development_root_is_fallback(tmp_path, monkeypatch):
    source = tmp_path / "apps" / "agent" / "sc2tools_agent" / "ui" / "sc2_icons.py"
    packaged = source.parent / "assets" / "sc2"
    monkeypatch.setattr(sc2_icons, "__file__", str(source))
    assert sc2_icons.icon_root() == tmp_path / "apps" / "web" / "public" / "icons" / "sc2"
    packaged.mkdir(parents=True)
    assert sc2_icons.icon_root() == packaged
