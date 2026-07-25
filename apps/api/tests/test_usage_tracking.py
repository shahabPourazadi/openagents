"""Context meter estimates — avoid binary/base64 inflation; surface summarization."""

from __future__ import annotations

import io
import uuid
from types import SimpleNamespace

from pydantic_ai import BinaryContent
from pydantic_ai.messages import ModelRequest, SystemPromptPart, UserPromptPart

from openagents_api.suggestions import AgentRunState
from openagents_api.model_settings import clear_catalog_cache, set_catalog_cache
from openagents_api.usage_tracking import (
    _SUMMARY_PREFIX,
    build_usage_payload,
    estimate_message_parts,
    estimate_run_cost_usd,
    estimate_tokens,
)


def _png_bytes(width: int = 2000, height: int = 2000) -> bytes:
    from PIL import Image

    img = Image.new("RGB", (width, height), color=(40, 40, 40))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_estimate_message_parts_does_not_count_binary_as_text() -> None:
    huge = BinaryContent(data=_png_bytes(1800, 1200), media_type="image/png")
    msg = ModelRequest(
        parts=[
            UserPromptPart(
                content=[
                    "Showing attached image at uploads/ui.png",
                    huge,
                ]
            )
        ]
    )
    text_tokens, summary_tokens, vision_tokens = estimate_message_parts([msg])
    # Old bug: str(BinaryContent(...)) → hundreds of thousands of "tokens".
    assert text_tokens < 100
    assert summary_tokens == 0
    assert 85 <= vision_tokens < 10_000


def test_estimate_message_parts_strips_inline_base64() -> None:
    blob = "iVBORw0KGgo" + ("A" * 50_000)
    msg = ModelRequest(parts=[UserPromptPart(content=f"see image\n{blob}")])
    text_tokens, summary_tokens, vision_tokens = estimate_message_parts([msg])
    assert summary_tokens == 0
    assert vision_tokens == 0
    assert text_tokens < 50
    assert estimate_tokens(blob) > 10_000


def test_estimate_message_parts_detects_summarization() -> None:
    summary = _SUMMARY_PREFIX + "User asked to leave names as TBD. Drafted section 1."
    msg = ModelRequest(parts=[SystemPromptPart(content=summary)])
    text_tokens, summary_tokens, vision_tokens = estimate_message_parts([msg])
    assert text_tokens == 0
    assert vision_tokens == 0
    assert summary_tokens == estimate_tokens(summary)


def test_build_usage_payload_includes_summarization_row() -> None:
    summary = _SUMMARY_PREFIX + "Prior turns compacted."
    messages = [
        ModelRequest(parts=[SystemPromptPart(content=summary)]),
        ModelRequest(parts=[UserPromptPart(content="continue")]),
    ]
    state = AgentRunState(
        user_id="u",
        thread_id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        document_id=None,
        model="openrouter:anthropic/claude-sonnet-5",
    )
    usage = SimpleNamespace(
        input_tokens=0,
        output_tokens=10,
        requests=3,
        cache_read_tokens=0,
        cache_write_tokens=0,
    )
    payload = build_usage_payload(
        state=state,
        usage=usage,
        messages=messages,
        system_instructions="You are OpenAgents.",
    )
    by_id = {item["id"]: item["tokens"] for item in payload["breakdown"]}
    assert by_id.get("summarization", 0) > 0
    assert by_id.get("conversation", 0) > 0
    # Multi-request path must not explode from missing provider window stats.
    assert payload["context_used"] < 50_000


def test_estimate_run_cost_uses_catalog_prices_when_genai_prices_misses() -> None:
    """Admin-configured models (e.g. gemini-3.6-flash) must still price spend."""
    clear_catalog_cache()
    set_catalog_cache(
        zdr_only=False,
        tiers=[
            {
                "tier": "pro",
                "model_slug": "google/gemini-3.6-flash",
                "price_input_per_m": 1.5,
                "price_output_per_m": 7.5,
            }
        ],
    )
    try:
        cost = estimate_run_cost_usd(
            model="openrouter:google/gemini-3.6-flash",
            input_tokens=1_000_000,
            output_tokens=1_000_000,
        )
        # $1.5 + $7.5 per 1M = $9.00
        assert cost == 9.0

        state = AgentRunState(
            user_id="u",
            thread_id=uuid.uuid4(),
            workspace_id=uuid.uuid4(),
            document_id=None,
            model="openrouter:google/gemini-3.6-flash",
        )
        usage = SimpleNamespace(
            input_tokens=1_000_000,
            output_tokens=0,
            requests=1,
            cache_read_tokens=0,
            cache_write_tokens=0,
        )
        payload = build_usage_payload(
            state=state,
            usage=usage,
            messages=[],
            system_instructions="hi",
        )
        assert payload["run"]["cost_usd"] == 1.5
    finally:
        clear_catalog_cache()


def test_estimate_run_cost_unknown_model_without_catalog_is_none() -> None:
    clear_catalog_cache()
    assert (
        estimate_run_cost_usd(
            model="openrouter:unknown/model-xyz",
            input_tokens=1000,
            output_tokens=100,
        )
        is None
    )


def test_build_usage_payload_adds_multimodal_cost_to_total() -> None:
    from openagents_api.usage_tracking import merge_spend_totals

    state = AgentRunState(
        user_id="u",
        thread_id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        document_id=None,
        model="openrouter:z-ai/glm-5.2",
        multimodal_cost_usd=0.05,
    )
    usage = SimpleNamespace(
        input_tokens=0,
        output_tokens=0,
        requests=1,
        cache_read_tokens=0,
        cache_write_tokens=0,
    )
    payload = build_usage_payload(
        state=state,
        usage=usage,
        messages=[],
        system_instructions="",
    )
    assert payload["run"]["multimodal_cost_usd"] == 0.05
    assert payload["run"]["token_cost_usd"] in (0, 0.0, None) or payload["run"][
        "token_cost_usd"
    ] == 0.0
    # With zero tokens, token cost may be 0 from rates or None from genai miss —
    # total must still include multimodal.
    assert payload["run"]["cost_usd"] == 0.05 or (
        isinstance(payload["run"]["cost_usd"], float)
        and payload["run"]["cost_usd"] >= 0.05
    )

    spend = merge_spend_totals(None, payload)
    assert spend["multimodal_cost_usd"] == 0.05
    assert spend["total_cost_usd"] == spend["token_cost_usd"] + spend["multimodal_cost_usd"]
