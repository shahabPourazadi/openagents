"""Per-user spend budget helpers (pre-payment soft cap)."""

from __future__ import annotations

from openagents_api.usage_tracking import (
    resolve_spend_budget_usd,
    spend_budget_exceeded,
    spent_usd,
)


def test_spent_usd_defaults_missing_to_zero() -> None:
    assert spent_usd(None) == 0.0
    assert spent_usd({}) == 0.0
    assert spent_usd({"total_cost_usd": None}) == 0.0
    assert spent_usd({"total_cost_usd": 1.25}) == 1.25


def test_resolve_spend_budget_usd() -> None:
    assert resolve_spend_budget_usd(None, default=5.0) == 5.0
    assert resolve_spend_budget_usd(10.0, default=5.0) == 10.0
    assert resolve_spend_budget_usd(-1.0, default=5.0) == 0.0


def test_spend_budget_exceeded() -> None:
    assert spend_budget_exceeded({"total_cost_usd": 5.0}, 5.0) is True
    assert spend_budget_exceeded({"total_cost_usd": 4.99}, 5.0) is False
    assert spend_budget_exceeded(None, 5.0) is False
