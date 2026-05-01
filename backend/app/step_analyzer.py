from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from typing import Any, Iterable


class CADKernelUnavailable(RuntimeError):
    """Raised when no supported OpenCASCADE binding is importable."""


class StepAnalysisError(RuntimeError):
    """Raised when STEP data cannot be parsed or analyzed."""


@dataclass(frozen=True)
class Axis:
    location: Any
    direction: Any


@dataclass(frozen=True)
class CylinderCandidate:
    axis: Axis
    max_radius: float
    cylindrical_face_count: int
    rotational_face_count: int


MM_TO_INCH = 1.0 / 25.4


@dataclass(frozen=True)
class BoundingDimensions:
    x: float
    y: float
    z: float

    def as_tuple(self) -> tuple[float, float, float]:
        return self.x, self.y, self.z

    def sorted_stock(self) -> tuple[float, float, float]:
        # Non-round stock is displayed smallest-to-largest for quick shop reading.
        return tuple(sorted((self.x, self.y, self.z)))


def analyze_step_file(path: str | Path) -> dict:
    """Parse a STEP file, classify stock shape, and return formatted dimensions.

    Values are returned in inches and rounded upward to the third decimal place.
    """

    occ = _load_occ()
    shape = parse_step_file(path, occ)

    rod = detect_cylindrical_stock(shape, occ)
    if rod is not None:
        length_mm = _axis_aligned_length(shape, rod.axis, occ)
        diameter_mm = _axis_aligned_radial_diameter(shape, rod.axis, occ, rod.max_radius)
        length = length_mm * MM_TO_INCH
        diameter = diameter_mm * MM_TO_INCH
        formatted = format_rod(diameter, length)
        return {
            "classification": "cylindrical",
            "format": formatted,
            "diameter_in": ceil_thousandth(diameter),
            "length_in": ceil_thousandth(length),
            "diameter_mm": diameter_mm,
            "length_mm": length_mm,
            "details": {
                "cylindrical_faces": rod.cylindrical_face_count,
                "rotational_faces": rod.rotational_face_count,
                "rule": "All curved analytic faces share a central axis; planes are perpendicular end faces.",
            },
        }

    dims = axis_aligned_bounding_dimensions(shape, occ)
    length_mm, width_mm, height_mm = dims.sorted_stock()
    length, width, height = length_mm * MM_TO_INCH, width_mm * MM_TO_INCH, height_mm * MM_TO_INCH
    formatted = format_prismatic(length, width, height)
    return {
        "classification": "prismatic",
        "format": formatted,
        "length_in": ceil_thousandth(length),
        "width_in": ceil_thousandth(width),
        "height_in": ceil_thousandth(height),
        "length_mm": length_mm,
        "width_mm": width_mm,
        "height_mm": height_mm,
        "details": {
            "bounding": "OpenCASCADE precise axis-aligned bounding box; no machining allowance added.",
            "axis_aligned_in": tuple(ceil_thousandth(v * MM_TO_INCH) for v in dims.as_tuple()),
        },
    }


def parse_step_file(path: str | Path, occ: Any | None = None) -> Any:
    occ = occ or _load_occ()
    step_path = str(Path(path).resolve())

    # Leave cascade.unit at the default "MM" so TransferRoots always produces
    # millimetre geometry — the well-tested default path in every OCCT build.
    # The caller converts to inches explicitly after bounding-box calculation.
    if occ.Interface_Static is not None:
        _call_any(occ.Interface_Static, ("SetCVal_s", "SetCVal"), "xstep.cascade.unit", "MM")

    reader = occ.STEPControl_Reader()
    status = reader.ReadFile(step_path)
    if status != occ.IFSelect_RetDone:
        raise StepAnalysisError("OpenCASCADE could not read this STEP file.")

    ok = reader.TransferRoots()
    if ok == 0:
        raise StepAnalysisError("The STEP file did not contain transferable solid geometry.")

    shape = reader.OneShape()
    if shape.IsNull():
        raise StepAnalysisError("The STEP file produced an empty shape.")

    return shape


def axis_aligned_bounding_dimensions(shape: Any, occ: Any | None = None) -> BoundingDimensions:
    occ = occ or _load_occ()
    box = occ.Bnd_Box()
    _call_brep_bnd(occ, "AddOptimal", shape, box, False, False)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return BoundingDimensions(xmax - xmin, ymax - ymin, zmax - zmin)


def oriented_bounding_dimensions(shape: Any, occ: Any | None = None) -> BoundingDimensions:
    occ = occ or _load_occ()
    obb = occ.Bnd_OBB()
    try:
        _call_brep_bnd(occ, "AddOBB", shape, obb, False, True, False)
        return BoundingDimensions(
            2.0 * _obb_half_size(obb, "X"),
            2.0 * _obb_half_size(obb, "Y"),
            2.0 * _obb_half_size(obb, "Z"),
        )
    except Exception:
        return axis_aligned_bounding_dimensions(shape, occ)


def detect_cylindrical_stock(shape: Any, occ: Any | None = None, tolerance: float = 1e-5) -> CylinderCandidate | None:
    """Strictly classify rod-like stock from analytic OpenCASCADE faces.

    This intentionally rejects near-round meshes, faceted cylinders, and
    filleted rectangular parts. A rod candidate needs at least one cylindrical
    face, every rotational curved face must share one axis, and every plane must
    be perpendicular to that axis so it behaves as an end/cross-section face.
    """

    occ = occ or _load_occ()
    faces = list(_iter_faces(shape, occ))
    if not faces:
        return None

    candidate_axis: Axis | None = None
    max_radius = 0.0
    cyl_count = 0
    rotational_count = 0
    saw_plane = False

    for face in faces:
        surf = occ.BRepAdaptor_Surface(face, True)
        surface_type = surf.GetType()

        if surface_type == occ.GeomAbs_Cylinder:
            cyl = surf.Cylinder()
            axis = _axis_from_gp_axis(cyl.Axis())
            candidate_axis = _merge_axis(candidate_axis, axis, tolerance)
            if candidate_axis is None:
                return None
            max_radius = max(max_radius, float(cyl.Radius()))
            cyl_count += 1
            rotational_count += 1
            continue

        if surface_type == occ.GeomAbs_Cone:
            cone = surf.Cone()
            candidate_axis = _merge_axis(candidate_axis, _axis_from_gp_axis(cone.Axis()), tolerance)
            if candidate_axis is None:
                return None
            max_radius = max(max_radius, abs(float(cone.RefRadius())))
            rotational_count += 1
            continue

        if surface_type == occ.GeomAbs_Torus:
            torus = surf.Torus()
            candidate_axis = _merge_axis(candidate_axis, _axis_from_gp_axis(torus.Axis()), tolerance)
            if candidate_axis is None:
                return None
            max_radius = max(max_radius, abs(float(torus.MajorRadius())) + abs(float(torus.MinorRadius())))
            rotational_count += 1
            continue

        if surface_type == occ.GeomAbs_Sphere:
            sphere = surf.Sphere()
            if candidate_axis is not None and _point_line_distance(sphere.Location(), candidate_axis) > tolerance:
                return None
            max_radius = max(max_radius, abs(float(sphere.Radius())))
            rotational_count += 1
            continue

        if surface_type == occ.GeomAbs_Plane:
            saw_plane = True
            if candidate_axis is None:
                continue
            if not _plane_is_perpendicular_to_axis(surf.Plane(), candidate_axis, tolerance):
                return None
            continue

        # B-spline, faceted, swept, or imported approximation: not trustworthy
        # enough to call rod stock.
        return None

    if candidate_axis is None or cyl_count == 0:
        return None

    if not saw_plane and rotational_count == cyl_count:
        # A bare cylindrical surface without end faces is probably a surface
        # body, not manufacturable solid stock.
        return None

    for face in faces:
        surf = occ.BRepAdaptor_Surface(face, True)
        if surf.GetType() == occ.GeomAbs_Plane and not _plane_is_perpendicular_to_axis(surf.Plane(), candidate_axis, tolerance):
            return None

    length = _axis_aligned_length(shape, candidate_axis, occ)
    if length <= tolerance or max_radius <= tolerance:
        return None

    radial_diameter = _axis_aligned_radial_diameter(shape, candidate_axis, occ, max_radius)
    if radial_diameter <= tolerance:
        return None

    return CylinderCandidate(
        axis=candidate_axis,
        max_radius=radial_diameter / 2.0,
        cylindrical_face_count=cyl_count,
        rotational_face_count=rotational_count,
    )


def format_prismatic(length: float, width: float, height: float) -> str:
    return f"{ceil_thousandth(length):.3f} X {ceil_thousandth(width):.3f} X {ceil_thousandth(height):.3f}"


def format_rod(diameter: float, length: float) -> str:
    return f"DIA {ceil_thousandth(diameter):.3f} X {ceil_thousandth(length):.3f}"


def ceil_thousandth(value: float) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.001"), rounding=ROUND_CEILING))


def _axis_aligned_length(shape: Any, axis: Axis, occ: Any) -> float:
    projections = [_project_point(v, axis) for v in _iter_vertex_points(shape, occ)]
    if projections:
        return max(projections) - min(projections)

    # Fallback for vertex-poor geometry. OBB dimensions on a rod are stable,
    # and the longest dimension is the stock length for valid rod candidates.
    dims = oriented_bounding_dimensions(shape, occ).sorted_stock()
    return dims[0]


def _axis_aligned_radial_diameter(shape: Any, axis: Axis, occ: Any, classified_radius: float) -> float:
    distances = [_point_line_distance(p, axis) for p in _iter_vertex_points(shape, occ)]
    if distances:
        return max(2.0 * max(distances), 2.0 * classified_radius)
    return 2.0 * classified_radius


def _iter_faces(shape: Any, occ: Any) -> Iterable[Any]:
    explorer = occ.TopExp_Explorer(shape, occ.TopAbs_FACE)
    while explorer.More():
        current = explorer.Current()
        yield _as_face(current, occ)
        explorer.Next()


def _iter_vertex_points(shape: Any, occ: Any) -> Iterable[Any]:
    explorer = occ.TopExp_Explorer(shape, occ.TopAbs_VERTEX)
    while explorer.More():
        vertex = _as_vertex(explorer.Current(), occ)
        yield _call_any(occ.BRep_Tool, ("Pnt_s", "Pnt"), vertex)
        explorer.Next()


def _axis_from_gp_axis(gp_axis: Any) -> Axis:
    return Axis(location=gp_axis.Location(), direction=gp_axis.Direction())


def _merge_axis(existing: Axis | None, incoming: Axis, tolerance: float) -> Axis | None:
    if existing is None:
        return incoming
    if not _directions_parallel(existing.direction, incoming.direction, tolerance):
        return None
    if _point_line_distance(incoming.location, existing) > tolerance:
        return None
    return existing


def _plane_is_perpendicular_to_axis(plane: Any, axis: Axis, tolerance: float) -> bool:
    return _directions_parallel(plane.Axis().Direction(), axis.direction, tolerance)


def _directions_parallel(a: Any, b: Any, tolerance: float) -> bool:
    return abs(abs(float(a.Dot(b))) - 1.0) <= tolerance


def _point_line_distance(point: Any, axis: Axis) -> float:
    vec = _vector(axis.location, point)
    cross = vec.Crossed(_direction_vector(axis.direction))
    return float(cross.Magnitude())


def _project_point(point: Any, axis: Axis) -> float:
    return float(_vector(axis.location, point).Dot(_direction_vector(axis.direction)))


def _vector(origin: Any, point: Any) -> Any:
    # Avoid binding-specific imports at module load. The fallback path is kept
    # for pythonocc-core, whose gp classes expose XYZ coordinates identically.
    try:
        from OCP.gp import gp_Vec
    except Exception:
        from OCC.Core.gp import gp_Vec
    return gp_Vec(origin, point)


def _direction_vector(direction: Any) -> Any:
    try:
        from OCP.gp import gp_Vec
    except Exception:
        from OCC.Core.gp import gp_Vec
    return gp_Vec(direction)


def _obb_half_size(obb: Any, axis: str) -> float:
    for name in (f"{axis}HSize", f"{axis}HSize_s", f"{axis.lower()}HSize"):
        if hasattr(obb, name):
            return float(getattr(obb, name)())
    raise AttributeError(f"Bnd_OBB binding does not expose {axis} half-size.")


def _call_brep_bnd(occ: Any, method: str, *args: Any) -> Any:
    return _call_any(occ.BRepBndLib, (f"{method}_s", method, f"brepbndlib_{method}"), *args)


def _call_any(owner: Any, names: tuple[str, ...], *args: Any) -> Any:
    for name in names:
        if hasattr(owner, name):
            return getattr(owner, name)(*args)
    raise AttributeError(f"None of {names!r} exist on {owner!r}.")


def _as_face(shape: Any, occ: Any) -> Any:
    if occ.TopoDS is not None and hasattr(occ.TopoDS, "Face_s"):
        return occ.TopoDS.Face_s(shape)
    if occ.topods is not None:
        return occ.topods.Face(shape)
    return shape


def _as_vertex(shape: Any, occ: Any) -> Any:
    if occ.TopoDS is not None and hasattr(occ.TopoDS, "Vertex_s"):
        return occ.TopoDS.Vertex_s(shape)
    if occ.topods is not None:
        return occ.topods.Vertex(shape)
    return shape


def _load_occ() -> Any:
    try:
        from OCP.Bnd import Bnd_Box, Bnd_OBB
        from OCP.BRep import BRep_Tool
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.BRepBndLib import BRepBndLib
        from OCP.GeomAbs import (
            GeomAbs_Cone,
            GeomAbs_Cylinder,
            GeomAbs_Plane,
            GeomAbs_Sphere,
            GeomAbs_Torus,
        )
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.Interface import Interface_Static
        from OCP.STEPControl import STEPControl_Reader
        from OCP.TopAbs import TopAbs_FACE, TopAbs_VERTEX
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopoDS import TopoDS

        return _OccNamespace(locals(), topods=None)
    except Exception as ocp_error:
        try:
            from OCC.Core.Bnd import Bnd_Box, Bnd_OBB
            from OCC.Core.BRep import BRep_Tool
            from OCC.Core.BRepAdaptor import BRepAdaptor_Surface
            from OCC.Core.BRepBndLib import brepbndlib_AddOBB, brepbndlib_AddOptimal
            from OCC.Core.GeomAbs import (
                GeomAbs_Cone,
                GeomAbs_Cylinder,
                GeomAbs_Plane,
                GeomAbs_Sphere,
                GeomAbs_Torus,
            )
            from OCC.Core.IFSelect import IFSelect_RetDone
            from OCC.Core.Interface import Interface_Static
            from OCC.Core.STEPControl import STEPControl_Reader
            from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_VERTEX
            from OCC.Core.TopExp import TopExp_Explorer
            from OCC.Core import topods

            class BRepBndLibCompat:
                AddOBB = staticmethod(brepbndlib_AddOBB)
                AddOptimal = staticmethod(brepbndlib_AddOptimal)

            values = locals()
            values["BRepBndLib"] = BRepBndLibCompat
            values["TopoDS"] = None
            return _OccNamespace(values, topods=topods)
        except Exception as occ_error:
            raise CADKernelUnavailable(
                "OpenCASCADE bindings are not installed. Use Python 3.10-3.12 and install "
                "the requirements, or install pythonocc-core from conda-forge."
            ) from occ_error


class _OccNamespace:
    def __init__(self, values: dict[str, Any], topods: Any) -> None:
        self.Bnd_Box = values["Bnd_Box"]
        self.Bnd_OBB = values["Bnd_OBB"]
        self.BRep_Tool = values["BRep_Tool"]
        self.BRepAdaptor_Surface = values["BRepAdaptor_Surface"]
        self.BRepBndLib = values["BRepBndLib"]
        self.GeomAbs_Cone = values["GeomAbs_Cone"]
        self.GeomAbs_Cylinder = values["GeomAbs_Cylinder"]
        self.GeomAbs_Plane = values["GeomAbs_Plane"]
        self.GeomAbs_Sphere = values["GeomAbs_Sphere"]
        self.GeomAbs_Torus = values["GeomAbs_Torus"]
        self.IFSelect_RetDone = values["IFSelect_RetDone"]
        self.Interface_Static = values.get("Interface_Static")
        self.STEPControl_Reader = values["STEPControl_Reader"]
        self.TopAbs_FACE = values["TopAbs_FACE"]
        self.TopAbs_VERTEX = values["TopAbs_VERTEX"]
        self.TopExp_Explorer = values["TopExp_Explorer"]
        self.TopoDS = values.get("TopoDS")
        self.topods = topods
