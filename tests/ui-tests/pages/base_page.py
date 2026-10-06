"""Minimal Page Object base — shared navigation + readiness helpers."""
from __future__ import annotations

from playwright.sync_api import Page

#: Marker text that indicates a route rendered an error screen rather than the app.
ERROR_MARKERS = (
    "Something went wrong",
    "Application error",
    "Unhandled Runtime Error",
    "Unexpected Application Error",
)


class BasePage:
    def __init__(self, page: Page, base_url: str, timeout_ms: int = 15000) -> None:
        self.page = page
        self.base_url = base_url.rstrip("/")
        self.timeout_ms = timeout_ms

    def url_for(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def goto(self, path: str, wait_until: str = "domcontentloaded") -> None:
        self.page.goto(self.url_for(path), wait_until=wait_until, timeout=self.timeout_ms)
        self.wait_ready()

    def wait_ready(self) -> None:
        """Wait until React has mounted something into ``#root``."""
        self.page.wait_for_function(
            "() => { const r = document.querySelector('#root');"
            " return !!r && r.childElementCount > 0; }",
            timeout=self.timeout_ms,
        )

    @property
    def body_text(self) -> str:
        return self.page.locator("body").inner_text()

    def has_error_screen(self) -> str | None:
        text = self.body_text
        for marker in ERROR_MARKERS:
            if marker in text:
                return marker
        return None
