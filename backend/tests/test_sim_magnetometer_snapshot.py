"""The magnetometer settings in the runtime config, and the flyby request
beside them, which is not one.

services/state_snapshot.py carries the mag_* keys over a rebuild, as it does
the Physics tab's other settings, so a restarted backend hands the running
fleet the same magnetometers and the detector the same threshold. A flyby
request is an action, not a setting: one that survived a restart would fly a
UAP nobody had just asked for, and one that moved the config's stamp would
read on the Physics page as someone else's edit of its settings.
"""

from unittest.mock import patch

from core import state
from services import sim_magnetometer as sm
from services.state_snapshot import restore_snapshot, save_snapshot

# Every magnetometer setting away from its default, so a key that is not
# restored shows up as the default coming back.
SETTINGS = {
    "mag_enabled": False,
    "mag_n_nodes": 12,
    "mag_placement": "core",
    "mag_cycle_count": 400,
    "mag_storm": True,
    "mag_threshold_sigma": 6.5,
    "mag_common_mode": False,
}


def _save_restart_restore(tmp_path):
    snap_path = str(tmp_path / "snap.json")
    with patch("services.state_snapshot._SNAPSHOT_PATH", snap_path):
        save_snapshot()
        state.simulation_config.clear()
        state.simulation_config.update(state._SIMULATION_CONFIG_DEFAULTS)
        assert restore_snapshot() is True


def test_every_setting_differs_from_its_default():
    assert set(SETTINGS) == set(sm.SETTINGS_DEFAULTS)
    assert all(SETTINGS[key] != default for key, default in sm.SETTINGS_DEFAULTS.items())
    assert sm.validate_settings(SETTINGS) == SETTINGS


def test_the_magnetometer_settings_survive_a_restart(tmp_path):
    state.simulation_config.update({**SETTINGS, "_updated_at": 1234.5})
    _save_restart_restore(tmp_path)
    assert {key: state.simulation_config.get(key) for key in SETTINGS} == SETTINGS
    assert sm.effective_settings(state.simulation_config) == SETTINGS
    assert state.simulation_config["_updated_at"] == 1234.5


def test_a_flyby_request_does_not_survive_a_restart(tmp_path):
    flyby = {**sm.validate_flyby({}), "seq": 3, "requested_at": 1234.5}
    state.simulation_config.update({"mag_threshold_sigma": 6.5, "mag_flyby": flyby})
    _save_restart_restore(tmp_path)
    assert state.simulation_config["mag_threshold_sigma"] == 6.5
    assert "mag_flyby" not in state.simulation_config


def test_a_flyby_rides_in_the_config_without_moving_its_stamp(client):
    before = client.get("/api/simulation/config").json()["_updated_at"]
    for seq in (1, 2):
        response = client.post("/api/sim/magnetometers/flyby", json={"closest_approach_m": 400})
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"ok", "flyby"} and body["flyby"]["seq"] == seq
        cfg = client.get("/api/simulation/config").json()
        assert cfg["_updated_at"] == before
        assert cfg["mag_flyby"]["seq"] == seq
        assert cfg["mag_flyby"]["requested_at"] == body["flyby"]["requested_at"]
        assert cfg["mag_flyby"]["closest_approach_m"] == 400.0
