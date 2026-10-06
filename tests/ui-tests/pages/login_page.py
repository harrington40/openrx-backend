"""The staff login page (``features/auth/LoginPage.tsx``)."""
from __future__ import annotations

from pages.base_page import BasePage

PATH = "/login"


class LoginPage(BasePage):
    def open(self) -> "LoginPage":
        self.goto(PATH)
        return self

    def fill(self, username: str, password: str) -> None:
        self.page.get_by_placeholder("Enter your username").fill(username)
        self.page.get_by_placeholder("Enter your password").fill(password)

    def submit(self) -> None:
        self.page.locator('form button[type="submit"]').click()

    def login(self, username: str, password: str) -> None:
        self.fill(username, password)
        self.submit()

    def error_text(self) -> str:
        alert = self.page.locator(".alert")
        return alert.first.inner_text() if alert.count() else ""
