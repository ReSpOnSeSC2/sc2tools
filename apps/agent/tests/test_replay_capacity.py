"""Browser-semantic checks for the isolated replay capacity repair."""
import bisect
import math
import random

import pytest

import sc2tools_agent.replay_pipeline as pipeline

def browser_sample(points, t):
    """Exact sampleTrack position rules from apps/web/lib/replayMotion.ts."""
    times = [point[0] for point in points]
    upper = bisect.bisect_right(times, t)
    index = max(0, upper - 1)
    a = points[index]
    if upper in (0, len(points)):
        return a[1:]
    b = points[index + 1]
    span = b[0] - a[0]
    if span <= 0 or span > 2 or math.hypot(b[1] - a[1], b[2] - a[2]) > 14 * span + 2:
        return a[1:]
    fraction = (t - a[0]) / span
    return (a[1] + fraction * (b[1] - a[1]), a[2] + fraction * (b[2] - a[2]))


def compressed(points, tolerance=.15, boundaries=()):
    kept = pipeline._compress_engine_track(points, tolerance, list(boundaries))
    flat = pipeline._engine_wire_track(kept)
    return [tuple(flat[index:index + 3]) for index in range(0, len(flat), 3)]


def assert_browser_fidelity(points, result, tolerance):
    assert result[0][0] == points[0][0] and result[-1][0] == points[-1][0]
    assert all(a[0] < b[0] for a, b in zip(result, result[1:]))
    times = [point[0] for point in points]
    times.extend((a[0] + b[0]) / 2 for a, b in zip(points, points[1:]))
    for t in times:
        actual, expected = browser_sample(result, t), browser_sample(points, t)
        error = math.hypot(actual[0] - expected[0], actual[1] - expected[1])
        assert error <= tolerance + 1e-9, (t, error, tolerance, actual, expected)


def test_integer_timestamps_and_stationary_intervals_can_span_longer_than_two_seconds():
    points = [(i, 40, 50) for i in range(101)]
    result = compressed(points)
    assert len(result) == 2
    assert result[-1][0] - result[0][0] > 2
    assert_browser_fidelity(points, result, .15)


def test_nearly_stationary_wobble_stays_inside_declared_hold_error():
    points = [(round(i * .1786, 3), 40 + .05 * math.sin(i), 50 + .05 * math.cos(i)) for i in range(180)]
    result = compressed(points)
    assert len(result) < len(points) // 4
    assert_browser_fidelity(points, result, .15)


def test_slow_but_significant_movement_cannot_freeze_across_long_span():
    points = [(round(i * .1, 3), 40 + i * .03, 50) for i in range(101)]
    result = compressed(points)
    assert len(result) > 2
    assert_browser_fidelity(points, result, .15)


def test_merged_segments_must_not_trigger_a_new_browser_speed_hold():
    points = [(round(i * .1, 3), i * 2., 0.) for i in range(11)]
    assert_browser_fidelity(points, compressed(points), .15)


@pytest.mark.parametrize("with_middle", [False, True])
def test_coordinate_rounding_cannot_flip_browser_discontinuity_decision(with_middle):
    points = [(0., .0049, .0049), (.1, 2.408, 2.408)]
    if with_middle:
        points.insert(1, (.05, 1.20645, 1.20645))
    assert_browser_fidelity(points, compressed(points), .15)


@pytest.mark.parametrize("tolerance", [.15, .3, .5])
def test_turns_stops_and_short_transport_teleport_keep_visibility_and_form_anchors(tolerance):
    points = [(round(i * .1, 3), 30 + .2 * i, 40) for i in range(20)]
    points += [(round(2 + i * .1, 3), 34, 40) for i in range(20)]
    points += [(round(4 + i * .1, 3), 90 + i * .15, 70 + i * .05) for i in range(20)]
    boundaries = [1.3, 2.1, 4.0, 4.7]
    result = compressed(points, tolerance, boundaries)
    times = [point[0] for point in result]
    for boundary in boundaries:
        index = bisect.bisect_left([point[0] for point in points], boundary)
        assert points[index][0] in times
        assert points[index - 1][0] in times
    assert 3.9 in times and 4.0 in times
    assert_browser_fidelity(points, result, tolerance)


@pytest.mark.parametrize("seed", range(12))
def test_random_dense_native_routes_keep_actual_browser_error_bounded(seed):
    rng = random.Random(seed)
    x, y = 50., 50.
    points = []
    for i in range(240):
        if i % 83 == 82:
            x += 35
        elif i % 70 < 35:
            angle = rng.uniform(-math.pi, math.pi)
            speed = rng.uniform(0, 12)
            x += math.cos(angle) * speed * .1786
            y += math.sin(angle) * speed * .1786
        points.append((round(i * .1786, 3), x, y))
    tolerance = (.15, .3, .5)[seed % 3]
    assert_browser_fidelity(points, compressed(points, tolerance), tolerance)
