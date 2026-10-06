"""Role-based dashboard UI — Registrar, Physician, Nurse Aide, Admin, Midwife, Laboratory.

One parametrized case set per staff role (see ``roles.py``), run with a session
whose stored role has been overridden: the SPA reads its signed-in user (and
role) from ``localStorage['openemr_user']`` for **client-side gating** — the
``/`` redirect, the role-filtered sidebar, and role-only controls — while API
calls keep using the JWT. That lets us verify every role's UI from one session.

The cases are:
* the role's own dashboard renders its stable heading (no error screen);
* visiting ``/`` lands the role on its dashboard (``RoleRedirect``);
* the sidebar links to the role's own dashboard;
* the sidebar hides other roles' dashboards (access-control isolation);
* any secondary pages the role owns render too.
"""
from __future__ import annotations

import pytest

from pages.role_dashboard_page import RoleDashboardPage
from roles import Role

pytestmark = pytest.mark.roles


def test_role_dashboard_renders(role_page, ui_settings, role: Role):
    """The role's dashboard renders its stable heading without an error screen."""
    dash = RoleDashboardPage(
        role_page, ui_settings.base_url, ui_settings.timeout_ms
    ).open(role.dashboard)

    assert dash.wait_for_text(role.heading), (
        f"{role.name}: {role.heading!r} never appeared on {role.dashboard}"
    )
    assert dash.has_error_screen() is None, (
        f"{role.name}: {role.dashboard} rendered an error screen"
    )
    assert "/login" not in role_page.url, (
        f"{role.name}: {role.dashboard} bounced to /login — session not applied"
    )


def test_role_lands_on_its_dashboard(role_page, ui_settings, role: Role):
    """``RoleRedirect`` sends the role from ``/`` to its own landing page."""
    role_page.goto(
        f"{ui_settings.base_url}/",
        wait_until=ui_settings.nav_wait,
        timeout=ui_settings.timeout_ms,
    )
    role_page.wait_for_url(f"**{role.landing}**", timeout=ui_settings.timeout_ms)
    assert role.landing in role_page.url, (
        f"{role.name}: expected to land on {role.landing}, got {role_page.url}"
    )


def test_role_sidebar_links_to_own_dashboard(role_page, ui_settings, role: Role):
    """The role-filtered sidebar offers the role its own dashboard."""
    dash = RoleDashboardPage(
        role_page, ui_settings.base_url, ui_settings.timeout_ms
    ).open(role.dashboard)
    dash.wait_for_text(role.heading)
    assert dash.sidebar_has(role.dashboard), (
        f"{role.name}: sidebar has no link to its own dashboard {role.dashboard}"
    )


def test_role_sidebar_hides_other_role_dashboards(role_page, ui_settings, role: Role):
    """Dashboards belonging to other roles must not leak into this role's sidebar."""
    dash = RoleDashboardPage(
        role_page, ui_settings.base_url, ui_settings.timeout_ms
    ).open(role.dashboard)
    dash.wait_for_text(role.heading)

    leaked = [href for href in role.hidden_dashboards if dash.sidebar_has(href)]
    assert not leaked, f"{role.name}: sidebar exposed foreign dashboards {leaked}"


def test_role_extra_pages_render(role_page, ui_settings, role: Role):
    """Secondary role-owned surfaces (e.g. Lab Management) also render."""
    if not role.extra_pages:
        pytest.skip(f"{role.name} has no secondary pages in the catalog")

    dash = RoleDashboardPage(role_page, ui_settings.base_url, ui_settings.timeout_ms)
    for path, heading in role.extra_pages:
        dash.open(path)
        assert dash.wait_for_text(heading), (
            f"{role.name}: {heading!r} never appeared on {path}"
        )
        assert dash.has_error_screen() is None, (
            f"{role.name}: {path} rendered an error screen"
        )
