"""Pluggable agent sandbox: LocalBackend vs DockerSandbox + concurrency slot."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from pydantic_ai_backends import LocalBackend

from openagents_api.agent_runtime import AgentRuntimeConfig, runtime_from_env
from openagents_api.config import Settings

_log = logging.getLogger(__name__)

DockerFactory = Callable[..., Any]


class SandboxProvider(Protocol):
    """Extension point for Daytona / Modal / dedicated host later."""

    def create(self, workspace_dir: str, settings: Settings) -> Any: ...

    def start(self, sandbox: Any) -> None: ...

    def stop(self, sandbox: Any) -> None: ...


class SandboxSlot:
    """Limits concurrent Docker sandboxes (default 1 for beta VPS)."""

    def __init__(self, max_concurrent: int = 1) -> None:
        self._max = max(1, int(max_concurrent))
        self._lock = asyncio.Lock()
        self._active = 0

    @property
    def max_concurrent(self) -> int:
        return self._max

    @property
    def active(self) -> int:
        return self._active

    async def try_acquire(self) -> bool:
        async with self._lock:
            if self._active >= self._max:
                return False
            self._active += 1
            return True

    async def release(self) -> None:
        async with self._lock:
            self._active = max(0, self._active - 1)


_global_slot: SandboxSlot | None = None
_global_slot_max: int | None = None


def get_sandbox_slot(max_concurrent: int = 1) -> SandboxSlot:
    """Process-wide slot; recreates if max_concurrent changes (tests / config)."""
    global _global_slot, _global_slot_max
    if _global_slot is None or _global_slot_max != max_concurrent:
        _global_slot = SandboxSlot(max_concurrent=max_concurrent)
        _global_slot_max = max_concurrent
    return _global_slot


def reset_sandbox_slot_for_tests() -> None:
    global _global_slot, _global_slot_max
    _global_slot = None
    _global_slot_max = None


@dataclass
class AgentBackendHandle:
    """Lifecycle wrapper around the filesystem/execute backend for one agent run."""

    backend: Any
    execute_enabled: bool
    degraded: bool
    _slot: SandboxSlot | None = field(default=None, repr=False)
    _holds_slot: bool = field(default=False, repr=False)
    _docker: Any | None = field(default=None, repr=False)
    _stop_docker: Callable[[Any], None] | None = field(default=None, repr=False)

    async def aclose(self) -> None:
        if self._docker is not None and self._stop_docker is not None:
            try:
                await asyncio.to_thread(self._stop_docker, self._docker)
            except Exception:
                _log.exception("Failed to stop Docker sandbox")
            self._docker = None
        if self._holds_slot and self._slot is not None:
            await self._slot.release()
            self._holds_slot = False


def _default_docker_factory(**kwargs: Any) -> Any:
    from pydantic_ai_backends import DockerSandbox

    return DockerSandbox(**kwargs)


def _start_docker(sandbox: Any) -> None:
    sandbox.start()


def _stop_docker(sandbox: Any) -> None:
    sandbox.stop()


async def open_agent_backend(
    workspace_dir: str,
    runtime: AgentRuntimeConfig | Settings,
    *,
    docker_factory: DockerFactory | None = None,
    slot: SandboxSlot | None = None,
) -> AgentBackendHandle:
    """Open Local or Docker backend for one deep-agent turn.

    When ``sandbox=docker`` and the concurrency slot is busy, soft-degrades
    to LocalBackend with execute disabled (never host shell).
    """
    if isinstance(runtime, Settings):
        runtime = runtime_from_env(runtime)

    root = str(Path(workspace_dir).resolve())
    mode = (runtime.sandbox or "local").strip().lower()
    want_execute = bool(runtime.execute)

    if mode != "docker":
        backend = LocalBackend(root_dir=root, enable_execute=want_execute)
        return AgentBackendHandle(
            backend=backend,
            execute_enabled=want_execute,
            degraded=False,
        )

    # Docker mode
    slot = slot or get_sandbox_slot(runtime.max_concurrent)
    got = await slot.try_acquire()
    if not got:
        backend = LocalBackend(root_dir=root, enable_execute=False)
        return AgentBackendHandle(
            backend=backend,
            execute_enabled=False,
            degraded=True,
        )

    factory = docker_factory or _default_docker_factory
    image = (runtime.image or "openagents-agent-sandbox:latest").strip()
    try:
        sandbox = factory(
            image=image,
            work_dir="/workspace",
            auto_remove=True,
            volumes={root: "/workspace"},
            network_mode="none",
        )
        await asyncio.to_thread(_start_docker, sandbox)
    except Exception:
        await slot.release()
        _log.exception(
            "Docker sandbox failed to start; soft-degrading to filesystem-only"
        )
        backend = LocalBackend(root_dir=root, enable_execute=False)
        return AgentBackendHandle(
            backend=backend,
            execute_enabled=False,
            degraded=True,
        )

    if hasattr(sandbox, "execute_enabled"):
        try:
            sandbox.execute_enabled = want_execute  # type: ignore[attr-defined]
        except Exception:
            pass

    return AgentBackendHandle(
        backend=sandbox,
        execute_enabled=want_execute,
        degraded=False,
        _slot=slot,
        _holds_slot=True,
        _docker=sandbox,
        _stop_docker=_stop_docker,
    )
