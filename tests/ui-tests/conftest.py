"""Fixtures and route-driven parametrization for the UI tests.

Relies on ``pytest-playwright`` for the ``browser``/``context``/``page``
fixtures, and overrides ``browser_context_args`` to (a) point at the configured
base URL and (b) seed the app's ``localStorage`` session so authenticated pages
render without driving the login form every time.
"""
from __future__ import annotations

import pytest

from auth import role_storage_state, storage_state
from config import load_settings
from roles import ROLES
from routes import navigable_routes


@pytest.fixture(scope="session")
def ui_settings():
    return load_settings()


@pytest.fixture(scope="session")
def session_state(ui_settings):
    """Playwright storage-state dict (or None when no session is available)."""
    return storage_state(ui_settings)


@pytest.fixture
def browser_context_args(browser_context_args, ui_settings, session_state):
    args = {
        **browser_context_args,
        "base_url": ui_settings.base_url,
        "viewport": {"width": 1440, "height": 900},
        "ignore_https_errors": True,
    }
    if session_state:
        args["storage_state"] = session_state
    return args


@pytest.fixture
def anon_context(browser, ui_settings):
    """A fresh, unauthenticated context — for login / redirect tests."""
    context = browser.new_context(
        base_url=ui_settings.base_url,
        viewport={"width": 1440, "height": 900},
        ignore_https_errors=True,
    )
    yield context
    context.close()


@pytest.fixture
def anon_page(anon_context):
    return anon_context.new_page()


@pytest.fixture
def role_state(ui_settings, role):
    """Storage state carrying the session token but the parametrized role."""
    state = role_storage_state(
        ui_settings,
        role.key,
        role.display_name,
        role.main_menu_role or None,
    )
    if state is None:
        pytest.skip("no UI session — set UI_TOKEN or valid UI_USER/UI_PASSWORD")
    return state


@pytest.fixture
def role_context(browser, ui_settings, role_state):
    """A context seeded with a specific role (for role-based UI gating tests)."""
    context = browser.new_context(
        base_url=ui_settings.base_url,
        viewport={"width": 1440, "height": 900},
        ignore_https_errors=True,
        storage_state=role_state,
    )
    yield context
    context.close()


@pytest.fixture
def role_page(role_context):
    return role_context.new_page()


def pytest_generate_tests(metafunc) -> None:
    """Parametrize the catalog-driven sweeps.

    * ``route`` — one smoke case per navigable SPA route (``test_smoke_routes``).
    * ``role``  — one case per staff role (``test_role_dashboards_ui``).
    """
    if "route" in metafunc.fixturenames:
        settings = load_settings()
        cases = navigable_routes(settings.domains)
        metafunc.parametrize("route", cases, ids=[r.path for r in cases])

    if "role" in metafunc.fixturenames:
        metafunc.parametrize("role", ROLES, ids=[r.key for r in ROLES])
