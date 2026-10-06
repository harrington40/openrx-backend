"""Page object for the staff role dashboards.

Shared by ``test_role_dashboards_ui.py`` for the Registrar, Physician, Nurse
Aide, Administrator, Midwife and Laboratory dashboards. Beyond the base
navigation helpers it exposes the two things every role test needs: wait for a
stable on-page label, and query the role-gated sidebar.
"""
from __future__ import annotations

from playwright.sync_api import Locator, TimeoutError as PlaywrightTimeoutError

from pages.base_page import BasePage


class RoleDashboardPage(BasePage):
    def open(self, path: str, wait_until: str = "domcontentloaded") -> "RoleDashboardPage":
        """Navigate to a dashboard route and wait until React has mounted."""
        self.goto(path, wait_until=wait_until)
        return self

    def wait_for_text(self, text: str, timeout_ms: int | None = None) -> bool:
        """Wait until ``text`` is visible; return whether it appeared in time."""
        try:
            self.page.get_by_text(text, exact=False).first.wait_for(
                state="visible",
                timeout=timeout_ms or self.timeout_ms,
            )
            return True
        except PlaywrightTimeoutError:
            return False

    def sidebar_link(self, href: str) -> Locator:
        """The sidebar link pointing at ``href`` (``a.side-link[href=...]``)."""
        return self.page.locator(f'a.side-link[href="{href}"]')

    def sidebar_has(self, href: str) -> bool:
        return self.sidebar_link(href).count() >= 1
