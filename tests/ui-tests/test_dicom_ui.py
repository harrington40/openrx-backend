"""DICOM viewer UI — the CT reader layout, tools, and study list.

Authenticated context (``page``): the viewer page only renders its chrome when a
staff session is present.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.ui


@pytest.fixture(autouse=True)
def _require_session(session_state):
    """The viewer only renders for a staff session."""
    if session_state is None:
        pytest.skip("no UI session — set UI_TOKEN or valid UI_USER/UI_PASSWORD")


def test_dicom_viewer_chrome_renders(page, ui_settings):
    page.goto(f"{ui_settings.base_url}/dicom", wait_until=ui_settings.nav_wait, timeout=ui_settings.timeout_ms)
    page.wait_for_function(
        "() => { const r = document.querySelector('#root');"
        " return !!r && r.childElementCount > 0; }",
        timeout=ui_settings.timeout_ms,
    )

    assert page.get_by_text("DICOM / CT / X-Ray Viewer").first.is_visible()
    assert page.get_by_text("TOOLS").first.is_visible()
    assert page.get_by_text("WINDOW / LEVEL").first.is_visible()
    assert page.get_by_text("SERIES / STUDIES", exact=False).first.is_visible()
    assert page.get_by_text("DICOM TAGS").first.is_visible()


def test_dicom_viewer_exposes_tools(page, ui_settings):
    page.goto(f"{ui_settings.base_url}/dicom", wait_until=ui_settings.nav_wait, timeout=ui_settings.timeout_ms)
    page.wait_for_function(
        "() => { const r = document.querySelector('#root');"
        " return !!r && r.childElementCount > 0; }",
        timeout=ui_settings.timeout_ms,
    )

    for label in ("W/L", "Pan", "Zoom", "Length", "Angle", "ROI"):
        assert page.get_by_role("button", name=label).first.count() >= 1, f"missing tool: {label}"


def test_dicom_viewer_has_upload_area(page, ui_settings):
    page.goto(f"{ui_settings.base_url}/dicom", wait_until=ui_settings.nav_wait, timeout=ui_settings.timeout_ms)
    page.wait_for_function(
        "() => { const r = document.querySelector('#root');"
        " return !!r && r.childElementCount > 0; }",
        timeout=ui_settings.timeout_ms,
    )
    assert page.get_by_text("Upload X-Ray / DICOM to Backblaze B2", exact=False).first.is_visible()
