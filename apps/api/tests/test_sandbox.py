"""TDD seams: SandboxSlot + open_agent_backend (local / docker / degraded)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from openagents_api.agent_runtime import AgentRuntimeConfig, runtime_from_env
from openagents_api.config import Settings
from openagents_api.sandbox import (
    AgentBackendHandle,
    SandboxSlot,
    open_agent_backend,
    reset_sandbox_slot_for_tests,
)


@pytest.fixture(autouse=True)
def _reset_slot() -> None:
    reset_sandbox_slot_for_tests()
    yield
    reset_sandbox_slot_for_tests()


@pytest.mark.asyncio
async def test_sandbox_slot_second_acquire_fails_while_held() -> None:
    slot = SandboxSlot(max_concurrent=1)
    assert await slot.try_acquire() is True
    assert await slot.try_acquire() is False
    await slot.release()
    assert await slot.try_acquire() is True
    await slot.release()


@pytest.mark.asyncio
async def test_sandbox_slot_allows_configured_concurrency() -> None:
    slot = SandboxSlot(max_concurrent=2)
    assert await slot.try_acquire() is True
    assert await slot.try_acquire() is True
    assert await slot.try_acquire() is False
    await slot.release()
    assert await slot.try_acquire() is True
    await slot.release()
    await slot.release()


@pytest.mark.asyncio
async def test_open_agent_backend_local_execute_on(tmp_path: Path) -> None:
    runtime = runtime_from_env(Settings(agent_sandbox="local", agent_execute=True))
    handle = await open_agent_backend(str(tmp_path), runtime)
    try:
        assert handle.degraded is False
        assert handle.execute_enabled is True
        assert getattr(handle.backend, "execute_enabled", False) is True
    finally:
        await handle.aclose()


@pytest.mark.asyncio
async def test_open_agent_backend_local_execute_off(tmp_path: Path) -> None:
    runtime = runtime_from_env(Settings(agent_sandbox="local", agent_execute=False))
    handle = await open_agent_backend(str(tmp_path), runtime)
    try:
        assert handle.degraded is False
        assert handle.execute_enabled is False
        assert getattr(handle.backend, "execute_enabled", True) is False
    finally:
        await handle.aclose()


class _FakeDockerSandbox:
    """Stand-in for DockerSandbox — no real Docker daemon."""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.started = False
        self.stopped = False
        self.execute_enabled = True

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True


@pytest.mark.asyncio
async def test_open_agent_backend_docker_uses_provider(tmp_path: Path) -> None:
    created: list[_FakeDockerSandbox] = []

    def factory(**kwargs: Any) -> _FakeDockerSandbox:
        sb = _FakeDockerSandbox(**kwargs)
        created.append(sb)
        return sb

    runtime = AgentRuntimeConfig(
        sandbox="docker",
        execute=True,
        max_concurrent=1,
        image="openagents-agent-sandbox:test",
    )
    handle = await open_agent_backend(
        str(tmp_path), runtime, docker_factory=factory
    )
    try:
        assert handle.degraded is False
        assert handle.execute_enabled is True
        assert len(created) == 1
        assert created[0].started is True
        assert created[0].kwargs["image"] == "openagents-agent-sandbox:test"
        assert created[0].kwargs["volumes"] == {str(tmp_path.resolve()): "/workspace"}
        assert handle.backend is created[0]
    finally:
        await handle.aclose()
    assert created[0].stopped is True


@pytest.mark.asyncio
async def test_open_agent_backend_docker_busy_soft_degrades(tmp_path: Path) -> None:
    runtime = AgentRuntimeConfig(
        sandbox="docker",
        execute=True,
        max_concurrent=1,
        image="openagents-agent-sandbox:latest",
    )

    def factory(**kwargs: Any) -> _FakeDockerSandbox:
        return _FakeDockerSandbox(**kwargs)

    first = await open_agent_backend(
        str(tmp_path / "a"), runtime, docker_factory=factory
    )
    second = await open_agent_backend(
        str(tmp_path / "b"), runtime, docker_factory=factory
    )
    try:
        assert first.degraded is False
        assert first.execute_enabled is True
        assert second.degraded is True
        assert second.execute_enabled is False
        # Soft-degrade must never enable host shell when sandbox mode is docker.
        assert getattr(second.backend, "execute_enabled", True) is False
        assert not isinstance(second.backend, _FakeDockerSandbox)
    finally:
        await second.aclose()
        await first.aclose()


@pytest.mark.asyncio
async def test_agent_backend_handle_type() -> None:
    """Public seam shape stays stable for agent_routes wiring."""
    assert AgentBackendHandle.__annotations__["backend"]
    assert AgentBackendHandle.__annotations__["execute_enabled"]
    assert AgentBackendHandle.__annotations__["degraded"]
