from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from sc2tools_agent.obs_activity import outputs_active
from sc2tools_agent.streaming.obs_reader import OutputReader


def reader(raw):
    return OutputReader(lambda: {}, factory=lambda **kwargs: raw)


@pytest.mark.parametrize("native", ["stream", "record"])
def test_native_outputs_block_update_even_without_plugin_outputs(native):
    raw=Mock()
    raw.get_stream_status.return_value=SimpleNamespace(output_active=native=="stream")
    raw.get_record_status.return_value=SimpleNamespace(output_active=native=="record")
    assert outputs_active(reader(raw))


def test_any_active_plugin_output_blocks_update_and_complete_idle_inventory_releases():
    raw=Mock()
    raw.get_stream_status.return_value=SimpleNamespace(output_active=False)
    raw.get_record_status.return_value=SimpleNamespace(output_active=False)
    raw.get_output_list.return_value=SimpleNamespace(outputs=[{"outputName":"custom Aitum output"}])
    raw.get_output_status.return_value=SimpleNamespace(output_active=True)
    value=reader(raw)
    assert outputs_active(value)
    raw.get_output_status.assert_called_once_with("custom Aitum output")
    raw.get_output_status.return_value=SimpleNamespace(output_active=False)
    assert not outputs_active(value)


def test_unknown_obs_state_holds_updates_but_absent_obs_does_not():
    raw=Mock();raw.get_stream_status.side_effect=RuntimeError("OBS response incomplete")
    value=reader(raw)
    assert outputs_active(value) and value.raw is None
    raw.disconnect.assert_called_once()
    raw.get_stream_status.side_effect=ConnectionRefusedError()
    assert not outputs_active(value)
    assert not outputs_active(None)
    value.disabled=True
    assert not outputs_active(value)
