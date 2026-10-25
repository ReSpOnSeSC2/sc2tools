"""The source and packaged desktop builder consume the web's canonical source-size data."""
import json
from pathlib import Path

from sc2tools_agent.live.obs_layout import PlannedItem, Rect, _browser_settings
from sc2tools_agent.live.widget_sizes import recommended_widget_size, widget_sizes


def test_shared_sizes_and_packaged_resource_contract():
    root = Path(__file__).resolve().parents[3]
    canonical = json.loads((root / "apps/web/lib/widgetRecommendedSizes.json").read_text())
    assert len(canonical) == 31
    assert widget_sizes() == {key: (value["width"], value["height"]) for key, value in canonical.items()}
    packaging = (root / "apps/agent/packaging/sc2tools_agent.spec").read_text()
    assert '"widgetRecommendedSizes.json"), "sc2tools_agent/live"' in packaging
    assert recommended_widget_size("build-profile") == (720, 900)


def test_builder_uses_shared_defaults_but_preserves_confirmed_native_layout_geometry():
    item = PlannedItem(label="Profile", rect=Rect(0, 0, 0, 0), z=1, browser_path="https://example.invalid/overlay/synthetic/widget/build-profile?theme=test")
    assert _browser_settings(item)["width"] == 720
    assert _browser_settings(item)["height"] == 900
    native = PlannedItem(label="Chat", rect=Rect(0, 0, 480, 777), z=1, browser_path="widget/multichat")
    assert _browser_settings(native)["width"] == 480
    assert _browser_settings(native)["height"] == 777
