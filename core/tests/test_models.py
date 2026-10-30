import math

import pytest
from parking_core.models import AlignedOutline, Rect, Schematic, Viewpoint
from pydantic import ValidationError


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_outline_points_must_be_finite(bad):
    # JSON has no NaN/inf: Pydantic would store null, and the model holding it would no
    # longer load (a layout every worker retry then fails to read).
    corners = [(bad, 0.1), (0.2, 0.1), (0.2, 0.2), (0.1, 0.2)]
    with pytest.raises(ValidationError):
        Viewpoint(lot_id="lot", view_id="V1", name="V1", outlines={"A-01": corners})
    with pytest.raises(ValidationError):
        AlignedOutline(space_id="A-01", polygon=corners)


@pytest.mark.parametrize("field", ["x", "y", "w", "h"])
@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_rect_must_be_finite(field, bad):
    # Same as outline points: a NaN rect is stored as null and the snapshot no longer loads.
    with pytest.raises(ValidationError):
        Rect.model_validate({"x": 0, "y": 0, "w": 50, "h": 80, field: bad})


@pytest.mark.parametrize("field", ["width", "height"])
@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_schematic_must_be_finite(field, bad):
    # An infinite width is stored as null in the snapshot, which then no longer loads.
    with pytest.raises(ValidationError):
        Schematic.model_validate({field: bad})


def test_finite_outline_round_trips():
    corners = [(0.1, 0.1), (0.2, 0.1), (0.2, 0.2), (0.1, 0.2)]
    v = Viewpoint(lot_id="lot", view_id="V1", name="V1", outlines={"A-01": corners})
    assert Viewpoint.model_validate_json(v.model_dump_json()) == v
