"""Authentication UI — the real login form, redirects, and error handling.

These run in a *fresh, unauthenticated* context (``anon_page``).
"""
from __future__ import annotations

import pytest
import requests

from pages.login_page import LoginPage

pytestmark = [pytest.mark.ui, pytest.mark.auth]


def _creds_are_accepted(settings) -> bool:
    try:
        r = requests.post(
            f"{settings.api_url}/auth/login",
            json={"username": settings.user, "password": settings.password},
            timeout=10,
        )
        return r.ok and bool(r.json().get("token"))
    except requests.RequestException:
        return False


def test_login_page_renders(anon_page, ui_settings):
    login = LoginPage(anon_page, ui_settings.base_url, ui_settings.timeout_ms).open()
    assert anon_page.get_by_placeholder("Enter your username").is_visible()
    assert anon_page.get_by_placeholder("Enter your password").is_visible()
    assert anon_page.locator('form button[type="submit"]').count() == 1
    assert login.has_error_screen() is None


def test_protected_route_redirects_to_login(anon_page, ui_settings):
    anon_page.goto(f"{ui_settings.base_url}/dashboard", wait_until=ui_settings.nav_wait)
    anon_page.wait_for_url("**/login**", timeout=ui_settings.timeout_ms)
    assert "/login" in anon_page.url


def test_login_form_authenticates_and_leaves_login(anon_page, ui_settings):
    if not _creds_are_accepted(ui_settings):
        pytest.skip("configured UI_USER/UI_PASSWORD are not accepted by the API")

    login = LoginPage(anon_page, ui_settings.base_url, ui_settings.timeout_ms).open()
    login.login(ui_settings.user, ui_settings.password)
    anon_page.wait_for_function(
        "() => !location.pathname.endsWith('/login')",
        timeout=ui_settings.timeout_ms,
    )
    assert "/login" not in anon_page.url


def test_bad_credentials_show_an_error(anon_page, ui_settings):
    login = LoginPage(anon_page, ui_settings.base_url, ui_settings.timeout_ms).open()
    login.login(ui_settings.user, "definitely-not-the-password")
    anon_page.wait_for_selector(".alert", timeout=ui_settings.timeout_ms)
    assert login.error_text().strip()
    assert "/login" in anon_page.url
