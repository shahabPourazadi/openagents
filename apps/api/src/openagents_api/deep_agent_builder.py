"""Deep agent builder — pydantic-deep harness + OpenAgents HITL tools."""

from __future__ import annotations

import asyncio
import io
import logging
import shutil
import subprocess
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic_ai import Agent, RunContext
from pydantic_ai.toolsets import FunctionToolset
from pydantic_ai_shields import PromptInjection, SecretRedaction, ToolGuard
from pydantic_deep import DeepAgentDeps, create_deep_agent, default_security_hook

from openagents_api.config import Settings, get_settings
from openagents_api.hitl_tools import OPENAGENTS_HITL_TOOLS, read_workspace_file_content
from openagents_api.mcp_resolve import merge_mcp_server_configs
from openagents_api.mcp_toolsets import (
    McpServerConfig,
    create_mcp_toolsets,
    resolve_mcp_server_configs,
)
from openagents_api.model_settings import model_supports_vision, settings_for_model
from openagents_api.agents import DEFAULT_SYSTEM_PROMPT
from openagents_api.sandbox import AgentBackendHandle
from openagents_api.suggestions import AgentRunState, PendingChangeView, PendingSuggestion
from openagents_api.uploads import register_workspace_uploads
from openagents_api.usage_tracking import context_window_for_model

EXECUTE_UNAVAILABLE_NOTE = (
    "Shell execution is temporarily unavailable this turn "
    "(sandbox busy or unavailable). Continue with suggest_edit and "
    "filesystem tools. You may write SVG under diagrams/ if needed; do not "
    "attempt apt/brew/rsvg/shell this turn."
)

_log = logging.getLogger(__name__)

_SUMMARIZATION_MODEL = "openrouter:openai/gpt-4o-mini"

# Downscale longest edge before vision pulls (Claude tokens ≈ width*height/750).
_MAX_VISION_DIM = 1024
# Safety ceiling for screenshot_document (omit target_pages → up to this many;
# agent can pass target_pages for fewer). Soft cap vs deepagents' uncapped default.
_MAX_SCREENSHOT_PAGES = 200
# Match pydantic-deep default: keep the newest BinaryContent parts in history;
# older ones are evicted to files (agent can read_file them again if needed).
_MAX_BINARY_CONTENT_IN_HISTORY = 3
# Match deepagents LiteparseToolset max_pages default; text still head/tail capped.
MAX_PARSE_PAGES = 10_000
MAX_PARSE_TEXT_CHARS = 80_000

_IMAGE_EXTENSIONS = frozenset({
    ".png",
    ".jpg",
    ".jpeg",
    ".tif",
    ".tiff",
    ".webp",
    ".gif",
    ".bmp",
})

# LiteParse / Tesseract language codes (settings use short codes like "en").
_TESSERACT_LANG = {
    "en": "eng",
    "eng": "eng",
    "fr": "fra",
    "fra": "fra",
    "de": "deu",
    "deu": "deu",
    "es": "spa",
    "spa": "spa",
}

def parse_document_description(*, supports_vision: bool) -> str:
    """Tool description tailored to the active model's modalities."""
    if supports_vision:
        return (
            "Extract content from a workspace document "
            "(path e.g. uploads/spec.pdf or uploads/ui.png). "
            "PDF/DOCX/XLSX/PPTX → text and tables. "
            "Raster images → saves an optimized preview under screenshots/ and returns the path — "
            "then call read_file on that path to see pixels (you have vision). "
            "Do not expect OCR text for icon-heavy UI screenshots."
        )
    return (
        "Extract text from a workspace document "
        "(path e.g. uploads/spec.pdf or uploads/scan.png). "
        "PDF/DOCX/XLSX/PPTX → text and tables. "
        "Raster images → OCR text only (this model cannot see image pixels). "
        "OCR often fails on icons/diagrams — say when the text is unclear."
    )


def screenshot_document_description(*, supports_vision: bool) -> str:
    """Tool description tailored to the active model's modalities."""
    if supports_vision:
        return (
            "Render an attached image or PDF page to screenshots/ (optimized). "
            "Returns saved path(s) only — call read_file on a path to see pixels (you have vision). "
            "For PNG/JPG/WEBP, call this (or parse_document) first when asked what an image shows. "
            "For PDFs, omit target_pages for up to the first "
            f"{_MAX_SCREENSHOT_PAGES} pages, or set target_pages for fewer "
            "(e.g. '3' or '2-4'). Prefer specific pages for large docs. Workspace-relative paths only."
        )
    return (
        "Render an attached image or PDF page and return OCR text of that render "
        "(this model is text-only and cannot see pixels). Also saves files under screenshots/. "
        "For PDFs, omit target_pages for up to the first "
        f"{_MAX_SCREENSHOT_PAGES} pages, or set target_pages for fewer "
        "(e.g. '3' or '2-4'). Prefer specific pages for large docs. Workspace-relative paths only. "
        "Expect OCR gaps on icons and diagrams."
    )


def attachment_workflow_instructions(*, supports_vision: bool) -> str:
    """System-prompt attachment block for the active model only (no mixed guidance)."""
    if supports_vision:
        return (
            "Users may attach files under uploads/ (PDF, DOCX, XLSX, PPTX, images, Markdown, TXT, CSV). "
            "Attachment workflow (THIS MODEL HAS VISION — you can see images): "
            "(1) Raster images (PNG/JPG/WEBP/GIF/…): call screenshot_document or parse_document — "
            "they save an optimized preview under screenshots/ and return the path; "
            "then call read_file on that path to see pixels. Do not use OCR to describe UI, icons, or diagrams. "
            "(2) PDF/DOCX/XLSX/PPTX: parse_document for text/tables; screenshot_document on pages with figures, "
            "then read_file the saved screenshot path(s). "
            "(3) Prefer specific pages; only read_file images you need this turn. "
            "For .md/.txt/.csv, use read_file(path) instead — no parse_document. "
            "Then draft with suggest_edit (creates a document if needed)."
        )
    return (
        "Users may attach files under uploads/ (PDF, DOCX, XLSX, PPTX, images, Markdown, TXT, CSV). "
        "Attachment workflow (THIS MODEL IS TEXT-ONLY — no image pixels): "
        "(1) Raster images: parse_document or screenshot_document returns OCR text only; you cannot see the image. "
        "(2) PDF/DOCX/XLSX/PPTX: parse_document for text/tables; screenshot_document OCR's page renders. "
        "(3) Prefer specific pages. Say when OCR is incomplete. "
        "For .md/.txt/.csv, use read_file(path) instead — no parse_document. "
        "Then draft with suggest_edit (creates a document if needed)."
    )


_ATTACHMENT_START = "Users may attach files under uploads/"
_ATTACHMENT_END = "Then draft with suggest_edit (creates a document if needed)."


def apply_attachment_workflow_for_model(prompt: str, *, supports_vision: bool) -> str:
    """Replace any stored attachment-workflow block with model-specific instructions."""
    block = attachment_workflow_instructions(supports_vision=supports_vision)
    text = prompt or ""
    # Prefer current wording; fall back to legacy start markers.
    start_markers = (
        _ATTACHMENT_START,
        "Users may attach files under uploads/",
    )
    end_markers = (
        _ATTACHMENT_END,
        "Then intake or draft with suggest_* tools.",
        "Then draft with suggest_edit when a document is open.",
        "Then draft with suggest_edit (creates a document if needed).",
    )
    start = -1
    start_len = 0
    for marker in start_markers:
        idx = text.find(marker)
        if idx >= 0:
            start = idx
            start_len = len(marker)
            break
    if start < 0:
        # Keep company prompts that omit attachments; append after a blank line.
        return text.rstrip() + "\n\n" + block
    end = -1
    end_len = 0
    for marker in end_markers:
        idx = text.find(marker, start)
        if idx >= 0:
            end = idx
            end_len = len(marker)
            break
    if end < 0:
        return text[:start] + block + text[start + start_len :]
    end += end_len
    return text[:start] + block + text[end:]


# Back-compat aliases (vision wording) for anything that still imports the constants.
PARSE_DOCUMENT_DESCRIPTION = parse_document_description(supports_vision=True)
SCREENSHOT_DOCUMENT_DESCRIPTION = screenshot_document_description(supports_vision=True)


def _parse_page_numbers(target_pages: str | None) -> list[int] | None:
    """Parse '1-5' / '1,3,5' into 1-indexed page numbers."""
    if not target_pages or not target_pages.strip():
        return None
    pages: list[int] = []
    for part in target_pages.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_s, end_s = part.split("-", 1)
            start, end = int(start_s), int(end_s)
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(part))
    return pages or None


def _workspace_rel_path(path: str) -> str:
    """LocalBackend rejects absolute-looking paths like /screenshots/..."""
    return path.lstrip("/") or "."


def _tesseract_lang(code: str) -> str:
    key = (code or "en").strip().lower()
    return _TESSERACT_LANG.get(key, key)


def _prepare_vision_image(
    data: bytes, max_dim: int = _MAX_VISION_DIM
) -> tuple[bytes, str]:
    """Downscale + JPEG-encode for cheaper vision tokens / smaller history payloads.

    Vision billing is driven mainly by pixel dimensions; the JPEG pass also keeps
    tool-result bytes small so eviction/history stays light.
    """
    try:
        from PIL import Image
    except ImportError:
        return data, "image/png"
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGB")
            elif img.mode != "RGB":
                img = img.convert("RGB")
            img.thumbnail((max_dim, max_dim))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80, optimize=True)
            return buf.getvalue(), "image/jpeg"
    except Exception:
        return data, "image/png"


def _downscale_image(data: bytes, max_dim: int = _MAX_VISION_DIM) -> bytes:
    """Back-compat wrapper — prefer ``_prepare_vision_image`` for media type."""
    prepared, _media_type = _prepare_vision_image(data, max_dim=max_dim)
    return prepared


def _optimized_vision_path(out_path: str, media_type: str) -> str:
    """Match file extension to the encoded payload."""
    if media_type == "image/jpeg":
        return str(Path(out_path).with_suffix(".jpg"))
    if media_type == "image/png":
        return str(Path(out_path).with_suffix(".png"))
    if media_type == "image/webp":
        return str(Path(out_path).with_suffix(".webp"))
    return out_path


async def _write_optimized_vision_file(
    backend: Any, out_path: str, data: bytes
) -> tuple[str | None, str | None]:
    """Optimize + write an image for later ``read_file`` vision pulls.

    Returns ``(saved_path, error)``.
    """
    prepared, media_type = _prepare_vision_image(data)
    saved_path = _optimized_vision_path(out_path, media_type)
    result = await backend.write(saved_path, prepared)
    err = getattr(result, "error", None)
    if err:
        return None, str(err)
    return saved_path, None


def _vision_read_hint(paths: list[str]) -> str:
    """Tell vision models to pull pixels via read_file (deepagents path-first)."""
    if len(paths) == 1:
        return (
            f'Call read_file(path="{paths[0]}") to see the image pixels '
            "(you have vision). Do not use OCR to describe UI/icons/diagrams."
        )
    listed = ", ".join(f'"{p}"' for p in paths)
    return (
        f"Call read_file on the path(s) you need ({listed}) to see image pixels "
        "(you have vision). Prefer one page at a time."
    )


def _ocr_image_bytes(data: bytes, *, ext: str, lang: str) -> str:
    """OCR a raster image with the system Tesseract CLI (no ImageMagick)."""
    if not shutil.which("tesseract"):
        raise RuntimeError(
            "Tesseract is not installed. On macOS: brew install tesseract. "
            "On Ubuntu: apt-get install tesseract-ocr."
        )
    suffix = ext if ext.startswith(".") else f".{ext}"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        proc = subprocess.run(
            [
                "tesseract",
                tmp_path,
                "stdout",
                "-l",
                _tesseract_lang(lang),
                "--psm",
                "3",
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "tesseract failed").strip()
            raise RuntimeError(err)
        text = (proc.stdout or "").strip()
        return text or "(No text detected in image.)"
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def cap_parse_text(text: str, *, max_chars: int = MAX_PARSE_TEXT_CHARS) -> str:
    """Trim oversized parse output so one document cannot flood the context window."""
    if len(text) <= max_chars:
        return text
    head = max(max_chars // 2 - 80, 200)
    tail = max(max_chars - head - 160, 200)
    return (
        f"{text[:head]}\n\n"
        f"…[truncated: showing head/tail of {len(text)} characters; "
        f"use screenshot_document on specific pages for diagrams]…\n\n"
        f"{text[-tail:]}"
    )


def _format_parse_result(num_pages: int, text: str, *, max_pages: int = MAX_PARSE_PAGES) -> str:
    body = cap_parse_text(text)
    header = f"[{num_pages} page(s)]"
    if num_pages >= max_pages:
        header += (
            f" — parse capped at {max_pages} pages; "
            "use screenshot_document with target_pages for later pages"
        )
    return f"{header}\n\n{body}"


def _parse_with_liteparse(parser: Any, data: bytes, *, path: str) -> str:
    """Parse via LiteParse. PDFs can use raw bytes; other formats need a named temp file."""
    ext = Path(path).suffix.lower()
    if ext == ".pdf" or not ext:
        result = parser.parse(data)
        return _format_parse_result(result.num_pages, result.text)

    with tempfile.TemporaryDirectory(prefix="liteparse_doc_") as tmpdir:
        tmp_path = Path(tmpdir) / (Path(path).name or f"doc{ext}")
        tmp_path.write_bytes(data)
        result = parser.parse(tmp_path)
        return _format_parse_result(result.num_pages, result.text)


def _build_liteparse_toolset(
    settings: Settings,
    *,
    model: str | None = None,
    parser: Any | None = None,
    ocr_fn: Callable[..., str] | None = None,
) -> FunctionToolset[Any] | None:
    """OpenAgents LiteParse tools compatible with liteparse 2.x (sync parse/screenshot).

    Stock pydantic-deep LiteparseToolset still calls LiteParse(install_if_not_available=...)
    and parse_async/screenshot_async, which newer liteparse removed.

    Vision path matches deepagents: save optimized images under screenshots/ and return
    paths only. Multimodal models pull pixels via ``read_file`` (image_support=True).

    Tool descriptions are written for the given ``model``'s vision capability so the
    agent is not told about OCR and vision in the same breath.
    """
    ocr_lang = settings.liteparse_ocr_language or "en"
    ocr_impl = ocr_fn or _ocr_image_bytes
    supports_vision = model_supports_vision(model)
    parse_desc = parse_document_description(supports_vision=supports_vision)
    shot_desc = screenshot_document_description(supports_vision=supports_vision)

    if parser is None:
        try:
            from liteparse import LiteParse
        except ImportError:
            _log.warning("liteparse package not installed; parse_document tools disabled")
            return None
        parser = LiteParse(
            ocr_enabled=True,
            ocr_language=ocr_lang,
            dpi=150,
            quiet=True,
            max_pages=MAX_PARSE_PAGES,
        )

    toolset: FunctionToolset[Any] = FunctionToolset(id="deep-liteparse")

    @toolset.tool(description=parse_desc)
    async def parse_document(ctx: RunContext[Any], path: str) -> str:
        """Extract text — or save an optimized image preview for vision models.

        Args:
            path: Path to the document in the backend filesystem.
        """
        backend = ctx.deps.backend
        file_bytes: bytes | None = await backend.read_bytes(path)
        if not file_bytes:
            return f"File not found: {path}"
        ext = Path(path).suffix.lower()
        try:
            # Raster images: vision models get a path to read_file; text-only get OCR.
            if ext in _IMAGE_EXTENSIONS:
                use_vision = model_supports_vision(getattr(ctx.deps, "model", None))
                if use_vision:
                    saved, err = await _write_optimized_vision_file(
                        backend, "screenshots/page_1.jpg", file_bytes
                    )
                    if err or not saved:
                        return f"Could not save image preview ({err or 'unknown error'})."
                    return (
                        f"Saved optimized preview of {path} at {saved}.\n"
                        + _vision_read_hint([saved])
                    )
                text = await asyncio.to_thread(
                    ocr_impl,
                    file_bytes,
                    ext=ext,
                    lang=ocr_lang,
                )
                return f"[1 page (OCR)]\n\n{cap_parse_text(text)}"
            return await asyncio.to_thread(
                _parse_with_liteparse,
                parser,
                file_bytes,
                path=path,
            )
        except Exception as exc:
            return f"Parse error: {exc}"

    async def _ocr_page(
        data: bytes, *, page_num: int, ext: str = ".png"
    ) -> str:
        try:
            text = await asyncio.to_thread(
                ocr_impl,
                data,
                ext=ext,
                lang=ocr_lang,
            )
            body = cap_parse_text(text or "(No text detected.)", max_chars=12_000)
        except Exception as exc:
            body = f"(OCR failed: {exc})"
        return f"--- page {page_num} ---\n{body}"

    @toolset.tool(description=shot_desc)
    async def screenshot_document(
        ctx: RunContext[Any],
        path: str,
        output_dir: str = "screenshots",
        target_pages: str | None = None,
    ) -> str:
        """Render pages to screenshots/ (optimized); OCR for text-only models.

        Args:
            path: Path to the document in the backend filesystem.
            output_dir: Workspace-relative directory where screenshots are saved.
            target_pages: Pages to screenshot, e.g. "1-5" or "1,3,5".
                None = first 200 pages (see ``_MAX_SCREENSHOT_PAGES``).
        """
        backend = ctx.deps.backend
        file_bytes = await backend.read_bytes(path)
        if not file_bytes:
            return f"File not found: {path}"
        ext = Path(path).suffix.lower()
        out_dir = _workspace_rel_path(output_dir)
        use_vision = model_supports_vision(getattr(ctx.deps, "model", None))

        # Already a raster image — save optimized preview (+ OCR when text-only).
        if ext in _IMAGE_EXTENSIONS:
            saved, err = await _write_optimized_vision_file(
                backend, f"{out_dir.rstrip('/')}/page_1.jpg", file_bytes
            )
            if err or not saved:
                return f"No screenshots saved ({err or 'unknown error'})."
            if not use_vision:
                ocr_block = await _ocr_page(file_bytes, page_num=1, ext=ext)
                return (
                    f"Saved image at {saved}. Base model has no vision — "
                    f"OCR of the render:\n\n{ocr_block}"
                )
            return (
                f"Saved optimized image at {saved}.\n" + _vision_read_hint([saved])
            )

        try:
            # None → first N pages; agent passes target_pages to request fewer (or specific pages).
            page_numbers = _parse_page_numbers(target_pages)
            if page_numbers is None:
                page_numbers = list(range(1, _MAX_SCREENSHOT_PAGES + 1))
            elif len(page_numbers) > _MAX_SCREENSHOT_PAGES:
                page_numbers = page_numbers[:_MAX_SCREENSHOT_PAGES]
            with tempfile.TemporaryDirectory(prefix="liteparse_ss_") as tmpdir:
                tmp_input = Path(tmpdir) / Path(path).name
                tmp_input.write_bytes(file_bytes)
                screenshots = await asyncio.to_thread(
                    parser.screenshot,
                    tmp_input,
                    page_numbers=page_numbers,
                )
                if not screenshots:
                    return "No screenshots generated."
                saved: list[str] = []
                errors: list[str] = []
                ocr_blocks: list[str] = []
                for screenshot in screenshots:
                    if not screenshot.image_bytes:
                        continue
                    out_path = f"{out_dir.rstrip('/')}/page_{screenshot.page_num}.jpg"
                    written, err = await _write_optimized_vision_file(
                        backend, out_path, screenshot.image_bytes
                    )
                    if err or not written:
                        errors.append(f"{out_path}: {err or 'write failed'}")
                        continue
                    saved.append(written)
                    if not use_vision:
                        ocr_blocks.append(
                            await _ocr_page(
                                screenshot.image_bytes,
                                page_num=screenshot.page_num,
                            )
                        )
                if not saved:
                    detail = "; ".join(errors) if errors else "unknown write failure"
                    return f"No screenshots saved ({detail})."
                if not use_vision:
                    summary = (
                        f"Rendered {len(saved)} page(s) under {out_dir}/ and OCR'd them "
                        f"(Base model has no vision):\n"
                        + "\n".join(saved)
                        + "\n\n"
                        + "\n\n".join(ocr_blocks)
                    )
                    if errors:
                        summary += "\n\nSome pages failed:\n" + "\n".join(errors)
                    return summary
                summary = (
                    f"Saved {len(saved)} optimized page image(s) under {out_dir}/:\n"
                    + "\n".join(saved)
                    + "\n"
                    + _vision_read_hint(saved)
                )
                if errors:
                    summary += "\n\nSome pages failed:\n" + "\n".join(errors)
                return summary
        except Exception as exc:
            return f"Screenshot error: {exc}"

    return toolset


def _templates_base() -> Path:
    settings = get_settings()
    if settings.templates_dir:
        return Path(settings.templates_dir)
    return Path(__file__).resolve().parents[4] / "templates"


def _load_default_persona() -> tuple[str, str]:
    """Fallback persona when no pack/company text is available."""
    try:
        from openagents_api.agents import try_load_agent

        pack = try_load_agent(None)
        return pack.agent_md, pack.soul_md
    except Exception:
        pass
    base = _templates_base()
    agent_path = base / "agent.md"
    soul_path = base / "soul.md"
    agent_md = (
        agent_path.read_text(encoding="utf-8")
        if agent_path.exists()
        else "You help users accomplish tasks using the selected Agent."
    )
    soul_md = (
        soul_path.read_text(encoding="utf-8")
        if soul_path.exists()
        else "Be precise, collaborative, and honest about uncertainty."
    )
    return agent_md, soul_md


@dataclass
class OpenAgentsDeepDeps(DeepAgentDeps):
    """DeepAgentDeps + OpenAgents HITL / metering fields (mirrors AgentRunState)."""

    user_id: str = ""
    workspace_id: uuid.UUID = field(default_factory=uuid.uuid4)
    thread_id: uuid.UUID = field(default_factory=uuid.uuid4)
    document_id: uuid.UUID | None = None
    document_md: str = ""
    document_path: str = ""
    uses_document: bool = False
    canvas_id: uuid.UUID | None = None
    canvas_scene: dict[str, Any] | None = None
    canvas_title: str = "Canvas"
    uses_canvas: bool = False
    canvas_destructive_confirmed: bool = False
    preferred_artifact_pane: str | None = None
    openrouter_api_key: str = ""
    model: str = "openrouter:z-ai/glm-5.2"
    workspace_dir: str = ""
    pending: list[PendingSuggestion] = field(default_factory=list)
    pending_changes: list[PendingChangeView] = field(default_factory=list)
    pending_changes_text: str = ""
    agent_md: str = ""
    soul_md: str = ""
    # Published company persona (server-only; concatenated above user extensions).
    company_agent_md: str = ""
    company_soul_md: str = ""
    loaded_skills: list[str] = field(default_factory=list)
    skills_catalog_text: str = ""
    loaded_skill_text: str = ""
    predefined_skills_text: str = ""
    ui_events: asyncio.Queue[Any] | None = None
    # True when docker sandbox was requested but slot/start failed (no shell).
    execute_degraded: bool = False
    # When set, commit_or_queue_suggestion mirrors document_md updates here too.
    # (document_md itself is a str copy — not shared with AgentRunState.)
    _run_state: Any | None = field(default=None, repr=False, compare=False)
    # OpenRouter MCP image / multimodal generation billed this run (USD).
    multimodal_cost_usd: float = 0.0


def deep_agent_security_hooks(*, enabled: bool = True) -> list[Any]:
    """Claude Code-style PRE/POST hooks (blocks destructive host patterns)."""
    if not enabled:
        return []
    return list(default_security_hook())


def deep_agent_security_capabilities(
    *,
    prompt_injection: bool = True,
    secret_redaction: bool = True,
    tool_guard: bool = True,
) -> list[Any]:
    """Beta shields: injection defense + secret redaction + ToolGuard placeholder."""
    caps: list[Any] = []
    if prompt_injection:
        caps.append(PromptInjection(sensitivity="medium"))
    if secret_redaction:
        caps.append(SecretRedaction())
    if tool_guard:
        # Do not block execute — sandbox isolation is the gate.
        caps.append(ToolGuard(blocked=[]))
    return caps


def materialize_deep_context_files(
    workspace_dir: str,
    *,
    agent_md: str,
    soul_md: str,
) -> None:
    """Write user AGENTS.md / SOUL.md for pydantic-deep discovery.

    Only user extensions are written — company proprietary defaults are injected
    via instructions, never onto the workspace filesystem.
    """
    root = Path(workspace_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / "AGENTS.md").write_text(agent_md or "", encoding="utf-8")
    (root / "SOUL.md").write_text(soul_md or "", encoding="utf-8")


def build_deep_deps(
    state: AgentRunState,
    *,
    backend_handle: AgentBackendHandle,
    todos: list[Any] | None = None,
) -> OpenAgentsDeepDeps:
    """Compose sandbox/local backend + OpenAgents run state for a deep agent turn."""
    # Disk AGENTS.md / SOUL.md = user extensions only (never write company IP to files).
    materialize_deep_context_files(
        state.workspace_dir,
        agent_md=state.agent_md,
        soul_md=state.soul_md,
    )
    company_agent = getattr(state, "company_agent_md", "") or ""
    company_soul = getattr(state, "company_soul_md", "") or ""
    deps = OpenAgentsDeepDeps(
        backend=backend_handle.backend,
        todos=list(todos or []),
        user_id=state.user_id,
        workspace_id=state.workspace_id,
        thread_id=state.thread_id,
        document_id=state.document_id,
        document_md=state.document_md,
        document_path=state.document_path,
        uses_document=bool(getattr(state, "uses_document", False)),
        canvas_id=getattr(state, "canvas_id", None),
        canvas_scene=getattr(state, "canvas_scene", None),
        canvas_title=getattr(state, "canvas_title", None) or "Canvas",
        uses_canvas=bool(getattr(state, "uses_canvas", False)),
        canvas_destructive_confirmed=bool(
            getattr(state, "canvas_destructive_confirmed", False)
        ),
        preferred_artifact_pane=getattr(state, "preferred_artifact_pane", None),
        openrouter_api_key=state.openrouter_api_key,
        model=state.model,
        workspace_dir=state.workspace_dir,
        pending=state.pending,
        pending_changes=state.pending_changes,
        pending_changes_text=state.pending_changes_text,
        agent_md=state.agent_md,
        soul_md=state.soul_md,
        company_agent_md=company_agent,
        company_soul_md=company_soul,
        loaded_skills=state.loaded_skills,
        skills_catalog_text=state.skills_catalog_text,
        loaded_skill_text=state.loaded_skill_text,
        predefined_skills_text=getattr(state, "predefined_skills_text", "") or "",
        ui_events=state.ui_events,
        execute_degraded=backend_handle.degraded,
        _run_state=state,
    )
    # pydantic-deep uploads_section → ## Uploaded Files in system prompt
    if state.workspace_dir:
        register_workspace_uploads(deps, state.workspace_dir)
    return deps


DEEP_SYSTEM_INSTRUCTIONS = (
    DEFAULT_SYSTEM_PROMPT
    + " "
    "Pure additions (appends, empty-doc drafts) apply immediately; "
    "edits that change or remove existing text are queued for Accept/Reject (red/green diff). "
    "Never claim a review-queued edit is already saved. "
    "Prefer small find/replace patches via suggest_edit(old_text=…, new_text=…) "
    "with the minimal unique substring. "
    "Use native plan mode for multi-step work; mark todos completed only after the real tool succeeded. "
    "When blocked on a high-impact decision, call ask_user with 1–4 questions "
    "(each with 2–4 options), then END YOUR TURN. "
    "When the user replies with clarifying answers or says continue, CONTINUE that plan. "
    "For web research, use configured MCP tools (e.g. firecrawl_search / scrape / crawl) "
    "and/or subagents; cite real sources only. "
    "Workspace uploads under uploads/ → parse_document / screenshot_document only — "
    "never use MCP web tools for local files. "
    "Filesystem tools may write memory/, research/, diagrams/, and other/ — "
    "never write the active document markdown directly; always use suggest_edit. "
    "For figures: save PNG/SVG under diagrams/, then embed via suggest_edit. "
    "Never claim you created or listed a file unless you called filesystem tools this turn. "
    "If an MCP/image tool returns Upstream error, HTTP 4xx/5xx, TOOL FAILED, or "
    "'Fix the errors and try again', the call failed — tell the user and do not invent "
    "diagrams/ paths, costs, or image details unless this turn's tool result includes real paths. "
    + attachment_workflow_instructions(supports_vision=True)
    + " "
    + "Load skills before following a playbook. "
    + "The document body is not in system instructions — call read_document "
    + "(or read_file on the active path) when you need the current text."
)


def openagents_run_tools(*, hitl: bool = True, uses_canvas: bool = False) -> list[Any]:
    """HITL (+ optional canvas) tools registered for a deep agent run."""
    from openagents_api.canvas_tools import OPENAGENTS_CANVAS_TOOLS

    tools: list[Any] = list(OPENAGENTS_HITL_TOOLS) if hitl else []
    if hitl and uses_canvas:
        tools.extend(OPENAGENTS_CANVAS_TOOLS)
    return tools


def build_deep_agent(
    model: str | None = None,
    *,
    system_prompt: str | None = None,
    tool_groups: dict[str, bool] | None = None,
    skill_directories: list[str] | None = None,
    include_execute: bool | None = None,
    safety: Any | None = None,
    pack_slug: str | None = None,
    pack_source: str | None = None,
    agent_slug: str | None = None,
    agent_source: str | None = None,
    user_mcp_configs: list[McpServerConfig] | None = None,
    uses_canvas: bool = False,
    uses_document: bool = True,
) -> Agent[OpenAgentsDeepDeps, str]:
    """Build a pydantic-deep agent with OpenAgents HITL tools + shields.

    Filesystem/execute backend is injected per-run via ``build_deep_deps``
    (LocalBackend or DockerSandbox).
    """
    from openagents_api.agent_runtime import AgentSafetyConfig
    from openagents_api.artifact_pane_policy import ARTIFACT_PANE_INSTRUCTIONS
    from openagents_api.company_config import DEFAULT_TOOL_GROUPS, merge_tool_groups

    settings = get_settings()
    groups = merge_tool_groups(tool_groups if tool_groups is not None else DEFAULT_TOOL_GROUPS)
    resolved_model = model or settings.default_model
    supports_vision = model_supports_vision(resolved_model)
    base_instructions = (system_prompt or "").strip() or DEEP_SYSTEM_INSTRUCTIONS
    if uses_canvas and uses_document:
        base_instructions = f"{base_instructions.rstrip()}\n\n{ARTIFACT_PANE_INSTRUCTIONS}"
    elif uses_canvas:
        base_instructions = (
            f"{base_instructions.rstrip()}\n\n"
            "This agent has an Excalidraw Canvas in the Artifacts pane. "
            "Use canvas_* tools for diagrams, architecture, and brainstorming. "
            "Never clear or fully replace the canvas without ask_user confirmation."
        )
    instructions = apply_attachment_workflow_for_model(
        base_instructions, supports_vision=supports_vision
    )

    resolved_slug = (agent_slug or pack_slug or "").strip()
    resolved_source = (agent_source or pack_source or "").strip()

    tools: list[Any] = openagents_run_tools(
        hitl=groups.get("hitl", True),
        uses_canvas=uses_canvas,
    )
    if resolved_slug in {"agent-builder", "pack-builder"}:
        from openagents_api.agent_builder_tools import AGENT_BUILDER_TOOLS

        tools.extend(AGENT_BUILDER_TOOLS)
    elif resolved_source == "user":
        from openagents_api.user_agent_tools import USER_AGENT_EDIT_NOTE, USER_AGENT_TOOLS

        tools.extend(USER_AGENT_TOOLS)
        instructions = f"{instructions.rstrip()}\n\n{USER_AGENT_EDIT_NOTE}"
    toolsets: list[Any] = []
    mcp_enabled = groups.get("mcp", True) or groups.get("firecrawl", True)
    if mcp_enabled:
        platform = resolve_mcp_server_configs(
            mcp_servers_json=settings.mcp_servers_json or None,
            firecrawl_api_key=settings.firecrawl_api_key,
        )
        merged = merge_mcp_server_configs(platform, user_mcp_configs or [])
        toolsets.extend(create_mcp_toolsets(configs=merged))
    if groups.get("document_parse", True):
        liteparse = _build_liteparse_toolset(settings, model=resolved_model)
        if liteparse is not None:
            toolsets.append(liteparse)

    deep_builtins = groups.get("deep_builtins", True)
    skills_dirs = skill_directories
    if skills_dirs is None:
        try:
            from openagents_api.agents import agents_root

            pack_skills = agents_root() / "research-assistant" / "skills"
            if pack_skills.is_dir():
                skills_dirs = [str(pack_skills)]
        except Exception:
            skills_dirs = None
        if skills_dirs is None:
            fallback = _templates_base() / "skills"
            skills_dirs = [str(fallback)] if fallback.is_dir() else None

    execute_enabled = (
        bool(settings.agent_execute) if include_execute is None else bool(include_execute)
    )
    safety_cfg: AgentSafetyConfig = (
        safety if isinstance(safety, AgentSafetyConfig) else AgentSafetyConfig()
    )

    agent = create_deep_agent(
        model=resolved_model,
        instructions=instructions,
        tools=tools,
        toolsets=toolsets or None,
        include_plan=deep_builtins,
        include_todo=deep_builtins,
        include_subagents=deep_builtins,
        include_skills=bool(skills_dirs),
        skill_directories=skills_dirs,
        include_memory=deep_builtins,
        include_filesystem=deep_builtins,
        # Backend is provided via deps at runtime — force tool presence from runtime.
        include_execute=execute_enabled,
        # Custom liteparse toolset above — stock include_liteparse breaks on liteparse>=2.
        include_liteparse=False,
        context_manager=True,
        # Summarize conversation history at 90% of the model context window (deep default).
        context_manager_max_tokens=context_window_for_model(resolved_model),
        summarization_model=_SUMMARIZATION_MODEL,
        # Drop older screenshots from model-visible history (keeps latest only).
        max_binary_content=_MAX_BINARY_CONTENT_IN_HISTORY,
        cost_tracking=True,
        web_search=False,
        web_fetch=False,
        forking=False,
        # Enable thinking; per-run ModelSettings(thinking=...) from the chat picker overrides effort.
        thinking=True,
        # GLM 5.2 only: prefer Together, then OpenRouter auto fallbacks.
        model_settings=settings_for_model(resolved_model),
        hooks=deep_agent_security_hooks(enabled=safety_cfg.filesystem_hooks),
        capabilities=deep_agent_security_capabilities(
            prompt_injection=safety_cfg.prompt_injection,
            secret_redaction=safety_cfg.secret_redaction,
            tool_guard=safety_cfg.tool_guard,
        ),
        deps_type=OpenAgentsDeepDeps,
    )

    @agent.instructions
    def persona(ctx: RunContext[OpenAgentsDeepDeps]) -> str:
        """Pack persona (authoritative) + user workspace extensions."""
        pack_agent = (ctx.deps.company_agent_md or "").strip()
        pack_soul = (ctx.deps.company_soul_md or "").strip()
        user_agent = (ctx.deps.agent_md or "").strip()
        user_soul = (ctx.deps.soul_md or "").strip()
        parts = [
            "Pack rules below take precedence over any user extensions when they conflict.",
        ]
        if pack_agent:
            parts.append(f"## Agent instructions (authoritative)\n{pack_agent}")
        if pack_soul:
            parts.append(f"## Pack soul.md (authoritative)\n{pack_soul}")
        if user_agent:
            parts.append(f"## User agent.md (extension)\n{user_agent}")
        if user_soul:
            parts.append(f"## User soul.md (extension)\n{user_soul}")
        if len(parts) == 1:
            default_agent_md, default_soul_md = _load_default_persona()
            parts.append(f"## agent.md\n{default_agent_md}")
            parts.append(f"## soul.md\n{default_soul_md}")
        return "\n\n".join(parts)

    @agent.instructions
    def predefined_skills(ctx: RunContext[OpenAgentsDeepDeps]) -> str:
        """Library skills the user rooted on this agent (deselected = omitted)."""
        text = (ctx.deps.predefined_skills_text or "").strip()
        if not text:
            return (
                "## Predefined skills\n"
                "None selected for this agent. The full skills library is still "
                "available under `skills/` for on-demand load."
            )
        return text

    @agent.instructions
    def document_context(ctx: RunContext[OpenAgentsDeepDeps]) -> str:
        if not ctx.deps.document_id:
            return "No active document is open."
        path = (ctx.deps.document_path or "").strip() or "document.md"
        return (
            f"Active document path: `{path}` (id={ctx.deps.document_id}).\n"
            "The document body is NOT in these instructions — call `read_document` "
            "or `read_file` on that path when you need the text. "
            "Use `suggest_edit` for all document writes."
        )

    @agent.instructions
    def pending_changes_context(ctx: RunContext[OpenAgentsDeepDeps]) -> str:
        text = ctx.deps.pending_changes_text or ""
        if not text:
            return (
                "## Pending changes\n"
                "None. Saved document/file content is the source of truth until you queue new suggestions."
            )
        return text

    @agent.instructions
    def memory_context(ctx: RunContext[OpenAgentsDeepDeps]) -> str:
        prefs = read_workspace_file_content(ctx.deps.workspace_dir, "memory/preferences.md")
        company = read_workspace_file_content(ctx.deps.workspace_dir, "memory/company.md")
        parts: list[str] = []
        if prefs.strip():
            parts.append(f"### memory/preferences.md\n{prefs[:4000]}")
        if company.strip():
            parts.append(f"### memory/company.md\n{company[:4000]}")
        if not parts:
            return "No workspace memory files loaded yet."
        return "## Workspace memory\n" + "\n\n".join(parts)

    @agent.instructions
    def execute_availability(ctx: RunContext[OpenAgentsDeepDeps]) -> str:
        if ctx.deps.execute_degraded:
            return f"## Execution\n{EXECUTE_UNAVAILABLE_NOTE}"
        return ""

    return agent  # type: ignore[return-value]
