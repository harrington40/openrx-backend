"""Catalog of staff roles and the dashboards the SPA shows them.

Mirrors ``routes.py``: this list drives a parametrized UI sweep
(``test_role_dashboards_ui.py``), so every role becomes an individually
reportable case. Each role is described by:

* ``key``   — the value the SPA stores in ``localStorage['openemr_user'].role``
              (see ``App.tsx`` ``RoleRedirect`` and ``components/layout/Sidebar.tsx``).
* ``name``  — human label used in test ids / failure messages.
* ``landing`` — where ``RoleRedirect`` sends the user after login (``/`` route).
* ``dashboard`` — the role's own dashboard route.
* ``heading`` — stable, always-rendered text on ``dashboard`` (it must not depend
                on API data, or the case would flake when the backend is down).
* ``hidden_dashboards`` — role dashboards that must **not** appear in the sidebar.
* ``extra_pages`` — additional ``(route, heading)`` pages the role is allowed to
                    use (secondary surfaces such as Lab Management).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Role:
    key: str
    name: str
    landing: str
    dashboard: str
    heading: str
    hidden_dashboards: tuple[str, ...] = ()
    extra_pages: tuple[tuple[str, str], ...] = ()
    display_name: str = ""
    main_menu_role: str = ""


#: The six staff roles this suite exercises: Registrar, Physician, Nurse Aide,
#: Administrator, Midwife and Laboratory (lab tech).
ROLES: tuple[Role, ...] = (
    Role(
        key="front_desk",
        name="Registrar",
        landing="/registrar-dashboard",
        dashboard="/registrar-dashboard",
        heading="Registrar Dashboard",
        hidden_dashboards=(
            "/provider-dashboard",
            "/nurse-dashboard",
            "/midwife-dashboard",
            "/lab-tech-dashboard",
        ),
        display_name="Registrar",
    ),
    Role(
        key="physician",
        name="Physician",
        landing="/provider-dashboard",
        dashboard="/provider-dashboard",
        # The provider dashboard's <h2> is the provider's own name (data-driven),
        # so we anchor on the always-present "Quick Actions" card instead.
        heading="Quick Actions",
        hidden_dashboards=(
            "/registrar-dashboard",
            "/nurse-dashboard",
            "/midwife-dashboard",
            "/lab-tech-dashboard",
        ),
        display_name="Dr. Physician",
    ),
    Role(
        key="nurse",
        name="Nurse Aide",
        landing="/nurse-dashboard",
        dashboard="/nurse-dashboard",
        heading="Nurse Aide Dashboard",
        hidden_dashboards=(
            "/provider-dashboard",
            "/registrar-dashboard",
            "/midwife-dashboard",
            "/lab-tech-dashboard",
        ),
        # Seeded with main_menu_role 'nurse' so RoleRedirect picks the nurse-aide
        # dashboard rather than the registered-nurse (RN) workbench.
        main_menu_role="nurse",
        display_name="Nurse Aide",
    ),
    Role(
        key="admin",
        name="Administrator",
        landing="/dashboard",
        dashboard="/admin",
        heading="Administration",
        hidden_dashboards=(
            "/registrar-dashboard",
            "/nurse-dashboard",
            "/rn-dashboard",
            "/midwife-dashboard",
            "/lab-tech-dashboard",
        ),
        extra_pages=(("/dashboard", "Clinic Overview"),),
        display_name="Administrator",
    ),
    Role(
        key="midwife",
        name="Midwife",
        landing="/midwife-dashboard",
        dashboard="/midwife-dashboard",
        heading="Midwife Dashboard",
        hidden_dashboards=(
            "/provider-dashboard",
            "/registrar-dashboard",
            "/nurse-dashboard",
            "/lab-tech-dashboard",
        ),
        display_name="Midwife",
    ),
    Role(
        key="lab_tech",
        name="Laboratory",
        landing="/lab-tech-dashboard",
        dashboard="/lab-tech-dashboard",
        heading="Lab Technician Dashboard",
        hidden_dashboards=(
            "/provider-dashboard",
            "/registrar-dashboard",
            "/nurse-dashboard",
            "/midwife-dashboard",
        ),
        extra_pages=(("/lab-dashboard", "Laboratory Management"),),
        display_name="Lab Technician",
    ),
)


def keys() -> list[str]:
    """Return the role keys in catalog order (for ``-k`` filtering help)."""
    return [r.key for r in ROLES]
