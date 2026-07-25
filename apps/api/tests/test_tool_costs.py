"""Multimodal / image-generation cost extraction."""

from __future__ import annotations

from types import SimpleNamespace

from openagents_api.tool_costs import (
    estimate_image_generation_cost_usd,
    extract_usage_cost_usd,
    record_multimodal_cost,
)


def test_extract_usage_cost_from_openrouter_usage_object() -> None:
    result = {
        "content": [{"type": "image", "media_type": "image/png", "data": "abc"}],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 4175,
            "total_tokens": 4175,
            "cost": 0.05,
        },
    }
    assert extract_usage_cost_usd(result) == 0.05


def test_extract_usage_cost_from_embedded_json_text() -> None:
    result = [
        {"type": "text", "text": '{"usage":{"cost":0.04,"total_tokens":100}}'},
    ]
    assert extract_usage_cost_usd(result) == 0.04


def test_estimate_image_cost_for_grok() -> None:
    cost = estimate_image_generation_cost_usd(
        "generate-image",
        {"model": "x-ai/grok-imagine-image-quality"},
        image_count=1,
    )
    assert cost == 0.05


def test_record_multimodal_cost_updates_deps_and_state() -> None:
    state = SimpleNamespace(multimodal_cost_usd=0.0)
    deps = SimpleNamespace(multimodal_cost_usd=0.0, _run_state=state)
    record_multimodal_cost(deps, 0.05)
    record_multimodal_cost(deps, 0.04)
    assert deps.multimodal_cost_usd == 0.09
    assert state.multimodal_cost_usd == 0.09
