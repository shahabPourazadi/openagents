"""MCP tool failures should be unmistakable to the model."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from pydantic_ai.exceptions import ModelRetry

from openagents_api.durable_media_toolset import (
    DurableMediaToolset,
    _strengthen_tool_failure_message,
)


def test_strengthen_tool_failure_message_appends_hint() -> None:
    msg = 'Upstream error HTTP 404: {"error":{"message":"No model found","code":404}}'
    out = _strengthen_tool_failure_message(msg)
    assert "Upstream error HTTP 404" in out
    assert "TOOL FAILED" in out
    assert "Do not invent asset paths" in out


def test_strengthen_tool_failure_message_idempotent() -> None:
    once = _strengthen_tool_failure_message("boom")
    twice = _strengthen_tool_failure_message(once)
    assert twice.count("TOOL FAILED") == 1


@pytest.mark.asyncio
async def test_durable_media_toolset_strengthens_model_retry() -> None:
    class _Failing:
        async def call_tool(self, name, tool_args, ctx, tool):  # noqa: ANN001
            raise ModelRetry(
                message='Upstream error HTTP 404: {"error":{"message":"No model found","code":404}}'
            )

    wrapper = DurableMediaToolset(wrapped=_Failing())  # type: ignore[arg-type]

    with pytest.raises(ModelRetry) as excinfo:
        await wrapper.call_tool(
            "generate-image",
            {},
            MagicMock(deps=object()),
            MagicMock(),
        )

    assert "TOOL FAILED" in str(excinfo.value.message)
    assert "404" in str(excinfo.value.message)
