from backend.app.step_analyzer import (
    BoundingDimensions,
    CylinderCandidate,
    ceil_thousandth,
    format_pipe,
    format_prismatic,
    format_rod,
)


def test_ceil_thousandth_rounds_up() -> None:
    assert ceil_thousandth(1.2341) == 1.235
    assert ceil_thousandth(1.2340) == 1.234
    assert ceil_thousandth(10.0) == 10.0


def test_formats_prismatic_stock() -> None:
    assert format_prismatic(1.1231, 2.345, 3.4551) == "1.124 X 2.345 X 3.456"


def test_formats_rod_stock() -> None:
    assert format_rod(3.2341, 9.9991) == "DIA 3.235 X 10.000"


def test_prismatic_dimensions_sort_smallest_to_largest() -> None:
    assert BoundingDimensions(4.0, 1.23, 2.0).sorted_stock() == (1.23, 2.0, 4.0)


def test_formats_pipe_stock() -> None:
    assert format_pipe(1.5, 0.75, 6.0) == "OD 1.500 X ID 0.750 X 6.000"


def test_formats_pipe_stock_with_rounding() -> None:
    assert format_pipe(1.5001, 0.7499, 6.0001) == "OD 1.501 X ID 0.750 X 6.001"


def test_cylinder_candidate_defaults() -> None:
    """New optional fields default correctly and don't break existing construction."""
    from unittest.mock import MagicMock

    axis = MagicMock()
    candidate = CylinderCandidate(axis=axis, max_radius=5.0, cylindrical_face_count=2, rotational_face_count=3)
    assert candidate.min_radius is None
    assert candidate.rotational_area_ratio == 1.0
    assert candidate.detection_rule == "strict"


def test_cylinder_candidate_with_pipe_fields() -> None:
    from unittest.mock import MagicMock

    axis = MagicMock()
    candidate = CylinderCandidate(
        axis=axis, max_radius=10.0, cylindrical_face_count=4, rotational_face_count=4,
        min_radius=5.0, rotational_area_ratio=0.85, detection_rule="relaxed",
    )
    assert candidate.min_radius == 5.0
    assert candidate.rotational_area_ratio == 0.85
    assert candidate.detection_rule == "relaxed"
