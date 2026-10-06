"""Safety guard — the suite must never silently target the live/main server.

These are offline checks of ``config.load_settings``: they prove that pointing a
run at production fails closed, and that the explicit opt-in opens the door.
"""
from __future__ import annotations

import pytest

from config import ProductionAccessError, is_production, load_settings

pytestmark = pytest.mark.ui

PROD_BASE = "https://openrx.transtechologies.com"
PROD_API = "https://openrx.transtechologies.com/api"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for name in (
        "UI_BASE_URL",
        "UI_API_URL",
        "UI_ALLOW_PRODUCTION",
    ):
        monkeypatch.delenv(name, raising=False)


def test_defaults_are_not_production():
    settings = load_settings()
    assert not is_production(settings.base_url)
    assert not is_production(settings.api_url)
    assert settings.api_url == "http://localhost:3202/api"


def test_production_base_url_is_refused(monkeypatch):
    monkeypatch.setenv("UI_BASE_URL", PROD_BASE)
    with pytest.raises(ProductionAccessError):
        load_settings()


def test_production_api_url_is_refused(monkeypatch):
    monkeypatch.setenv("UI_API_URL", PROD_API)
    with pytest.raises(ProductionAccessError):
        load_settings()


def test_production_is_allowed_with_explicit_opt_in(monkeypatch):
    monkeypatch.setenv("UI_BASE_URL", PROD_BASE)
    monkeypatch.setenv("UI_API_URL", PROD_API)
    monkeypatch.setenv("UI_ALLOW_PRODUCTION", "true")
    settings = load_settings()
    assert settings.allow_production is True
    assert is_production(settings.base_url)


def test_is_production_matches_the_main_server_only():
    assert is_production(PROD_BASE)
    assert is_production("https://94.250.201.58/api")
    assert not is_production("http://localhost:5173")
    assert not is_production("http://127.0.0.1:3202/api")
