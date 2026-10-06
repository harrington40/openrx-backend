"""Route-render smoke sweep — one UI test case per navigable route.

The cases are generated from ``routes.py`` (derived from ``App.tsx``), so adding
a route or a page is picked up automatically. Filter by feature with
``UI_DOMAINS=patients,dicom``.
"""
from __future__ import annotations

import pytest

from pages.base_page import ERROR_MARKERS
from routes import UiRoute

pytestmark = pytest.mark.smoke


def test_route_renders(page, route: UiRoute, ui_settings, session_state):
    if route.staff_auth and session_state is None:
        pytest.skip("no UI session — set UI_TOKEN or valid UI_USER/UI_PASSWORD")

    errors: list[str] = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))

    response = page.goto(
        f"{ui_settings.base_url}{route.path}",
        wait_until=ui_settings.nav_wait,
        timeout=ui_settings.timeout_ms,
    )
    assert response is None or response.status < 500, (
        f"{route.path}: HTTP {response and response.status}"
    )

    # React must have mounted something.
    page.wait_for_function(
        "() => { const r = document.querySelector('#root');"
        " return !!r && r.childElementCount > 0; }",
        timeout=ui_settings.timeout_ms,
    )

    text = page.locator("body").inner_text()
    assert text.strip(), f"{route.path}: rendered an empty page"

    for marker in ERROR_MARKERS:
        assert marker not in text, f"{route.path}: error screen ({marker!r})"

    if route.staff_auth:
        assert "/login" not in page.url, (
            f"{route.path}: bounced to /login — session/auth not working"
        )

    if not ui_settings.allow_page_errors:
        assert not errors, f"{route.path}: uncaught page error(s): {errors[:2]}"
