from math import radians

import pytest

pytest.importorskip("OCP.BRepAlgoAPI")
pytest.importorskip("OCP.BRepBuilderAPI")
pytest.importorskip("OCP.BRepPrimAPI")

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

from backend.app import step_analyzer
from backend.app.step_analyzer import (
    _load_occ,
    analyze_step_file,
    detect_cylindrical_stock,
    detect_cylindrical_stock_relaxed,
)


def _cylinder(radius: float, length: float, z_offset: float = 0.0):
    shape = BRepPrimAPI_MakeCylinder(radius, length).Shape()
    if z_offset == 0:
        return shape

    transform = gp_Trsf()
    transform.SetTranslation(gp_Vec(0, 0, z_offset))
    return BRepBuilderAPI_Transform(shape, transform, True).Shape()


def _cut(base, tool):
    operation = BRepAlgoAPI_Cut(base, tool)
    operation.Build()
    assert operation.IsDone()
    return operation.Shape()


def _fuse(first, second):
    operation = BRepAlgoAPI_Fuse(first, second)
    operation.Build()
    assert operation.IsDone()
    return operation.Shape()


def _rotate_z(shape, degrees: float):
    transform = gp_Trsf()
    transform.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), radians(degrees))
    return BRepBuilderAPI_Transform(shape, transform, True).Shape()


def test_prismatic_analysis_uses_axis_aligned_bounds(monkeypatch) -> None:
    occ = _load_occ()
    rotated_box = _rotate_z(BRepPrimAPI_MakeBox(10, 20, 30).Shape(), 30)
    monkeypatch.setattr(step_analyzer, "_load_occ", lambda: occ)
    monkeypatch.setattr(step_analyzer, "parse_step_file", lambda _path, _occ: rotated_box)

    result = analyze_step_file("unused.step")

    assert result["classification"] == "prismatic"
    assert result["length_mm"] == pytest.approx(18.660254, rel=1e-6)
    assert result["width_mm"] == pytest.approx(22.320508, rel=1e-6)
    assert result["height_mm"] == pytest.approx(30.0)
    assert "axis_aligned_in" in result["details"]


def test_strict_tube_detection_reports_inner_radius() -> None:
    occ = _load_occ()
    tube = _cut(_cylinder(10, 100), _cylinder(6, 120, -10))

    candidate = detect_cylindrical_stock(tube, occ)

    assert candidate is not None
    assert candidate.min_radius == pytest.approx(6.0)


def test_relaxed_stepped_solid_with_flat_is_not_pipe() -> None:
    occ = _load_occ()
    stepped_shaft = _fuse(_cylinder(10, 60), _cylinder(6, 40, 60))
    flat_cut = BRepPrimAPI_MakeBox(gp_Pnt(8, -12, 20), 10, 24, 20).Shape()
    stepped_shaft_with_flat = _cut(stepped_shaft, flat_cut)

    assert detect_cylindrical_stock(stepped_shaft_with_flat, occ) is None
    candidate = detect_cylindrical_stock_relaxed(stepped_shaft_with_flat, occ)

    assert candidate is not None
    assert candidate.max_radius == pytest.approx(10.0)
    assert candidate.min_radius is None
