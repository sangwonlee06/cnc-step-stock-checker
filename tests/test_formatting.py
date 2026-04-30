from backend.app.step_analyzer import BoundingDimensions, ceil_thousandth, format_prismatic, format_rod


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
