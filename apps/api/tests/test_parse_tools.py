"""Seam C: parse_document / screenshot_document tools (faked LiteParse/OCR)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic_ai_backends import LocalBackend
from pydantic_deep.deps import ensure_async

from openagents_api.config import Settings
from openagents_api.deep_agent_builder import (
    MAX_PARSE_PAGES,
    MAX_PARSE_TEXT_CHARS,
    _MAX_SCREENSHOT_PAGES,
    _MAX_VISION_DIM,
    _build_liteparse_toolset,
    _prepare_vision_image,
    apply_attachment_workflow_for_model,
    attachment_workflow_instructions,
    cap_parse_text,
    parse_document_description,
    screenshot_document_description,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@dataclass
class FakeParseResult:
    num_pages: int
    text: str


@dataclass
class FakeScreenshot:
    page_num: int
    image_bytes: bytes


@dataclass
class FakeParser:
    pages: int = 3
    text: str = "hello from pdf"
    screenshot_pages: list[int] = field(default_factory=lambda: [1, 2, 3])
    last_page_numbers: list[int] | None = None

    def parse(self, data: Any, **kwargs: Any) -> FakeParseResult:
        return FakeParseResult(num_pages=self.pages, text=self.text)

    def screenshot(self, path: Any, *, page_numbers: list[int] | None = None, **kwargs: Any) -> list[FakeScreenshot]:
        self.last_page_numbers = list(page_numbers or [])
        pages = page_numbers or self.screenshot_pages
        return [FakeScreenshot(page_num=p, image_bytes=PNG) for p in pages]


def _ctx(root: Path, *, model: str | None = None) -> SimpleNamespace:
    backend = ensure_async(LocalBackend(root_dir=str(root), enable_execute=False))
    return SimpleNamespace(deps=SimpleNamespace(backend=backend, model=model))


def test_cap_parse_text_keeps_short_unchanged() -> None:
    assert cap_parse_text("short") == "short"


def test_prepare_vision_image_downscales_and_jpeg_encodes() -> None:
    from PIL import Image

    img = Image.new("RGB", (2000, 1600), color=(12, 34, 56))
    buf = __import__("io").BytesIO()
    img.save(buf, format="PNG")
    raw = buf.getvalue()

    prepared, media_type = _prepare_vision_image(raw)
    assert media_type == "image/jpeg"
    assert len(prepared) < len(raw)
    with Image.open(__import__("io").BytesIO(prepared)) as out:
        assert max(out.size) <= _MAX_VISION_DIM
        assert out.format == "JPEG"


def test_tool_descriptions_differ_by_vision() -> None:
    vision_parse = parse_document_description(supports_vision=True)
    text_parse = parse_document_description(supports_vision=False)
    assert "read_file" in vision_parse.lower()
    assert "cannot see" in text_parse.lower() or "ocr" in text_parse.lower()

    vision_shot = screenshot_document_description(supports_vision=True)
    text_shot = screenshot_document_description(supports_vision=False)
    assert "read_file" in vision_shot.lower()
    assert "text-only" in text_shot.lower() or "ocr" in text_shot.lower()


def test_attachment_workflow_rewritten_per_model() -> None:
    base = (
        "Intro. "
        + attachment_workflow_instructions(supports_vision=True)
        + " Outro."
    )
    text_only = apply_attachment_workflow_for_model(base, supports_vision=False)
    assert "TEXT-ONLY" in text_only
    assert "HAS VISION" not in text_only
    vision = apply_attachment_workflow_for_model(base, supports_vision=True)
    assert "HAS VISION" in vision
    assert "read_file" in vision.lower()


def test_cap_parse_text_truncates_with_head_and_tail() -> None:
    body = "A" * (MAX_PARSE_TEXT_CHARS + 5_000)
    out = cap_parse_text(body)
    assert len(out) < len(body)
    assert "truncated" in out.lower()
    assert out.startswith("A" * 100)
    assert out.endswith("A" * 100)


@pytest.mark.asyncio
async def test_parse_document_ocr_for_images_text_only_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "scan.png").write_bytes(PNG)

    def fake_ocr(data: bytes, *, ext: str, lang: str) -> str:
        assert data == PNG
        return "OCR line one"

    toolset = _build_liteparse_toolset(
        Settings(),
        parser=FakeParser(),
        ocr_fn=fake_ocr,
    )
    assert toolset is not None
    fn = toolset.tools["parse_document"].function
    # No model / text-only → OCR (legacy GLM Base path).
    result = await fn(
        _ctx(tmp_path, model="openrouter:z-ai/glm-5.2"),
        path="uploads/scan.png",
    )
    assert isinstance(result, str)
    assert "OCR line one" in result
    assert "1 page (OCR)" in result


@pytest.mark.asyncio
async def test_parse_document_path_first_for_vision_images(tmp_path: Path) -> None:
    (tmp_path / "uploads").mkdir()
    # Valid PNG so Pillow can optimize it.
    from PIL import Image

    buf = __import__("io").BytesIO()
    Image.new("RGB", (64, 64), color=(1, 2, 3)).save(buf, format="PNG")
    (tmp_path / "uploads" / "ui.png").write_bytes(buf.getvalue())

    toolset = _build_liteparse_toolset(
        Settings(),
        parser=FakeParser(),
        ocr_fn=lambda *a, **k: "should not be used",
    )
    assert toolset is not None
    result = await toolset.tools["parse_document"].function(
        _ctx(tmp_path, model="openrouter:minimax/minimax-m3"),
        path="uploads/ui.png",
    )
    assert isinstance(result, str)
    assert "read_file" in result.lower()
    assert "screenshots/" in result
    assert (tmp_path / "screenshots").is_dir()
    saved = list((tmp_path / "screenshots").glob("page_1.*"))
    assert len(saved) == 1


@pytest.mark.asyncio
async def test_parse_document_caps_pages_and_text(tmp_path: Path) -> None:
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "big.pdf").write_bytes(b"%PDF-1.4\n" + b"x" * 40)

    huge = "W" * (MAX_PARSE_TEXT_CHARS + 10_000)
    parser = FakeParser(pages=MAX_PARSE_PAGES + 20, text=huge)
    toolset = _build_liteparse_toolset(Settings(), parser=parser, ocr_fn=lambda *a, **k: "")
    assert toolset is not None
    result = await toolset.tools["parse_document"].function(
        _ctx(tmp_path), path="uploads/big.pdf"
    )
    assert "truncated" in result.lower()
    assert "capped" in result.lower()
    assert str(MAX_PARSE_PAGES) in result
    assert len(result) < len(huge)


@pytest.mark.asyncio
async def test_screenshot_document_path_first_for_vision(tmp_path: Path) -> None:
    (tmp_path / "uploads").mkdir()
    from PIL import Image

    buf = __import__("io").BytesIO()
    Image.new("RGB", (80, 60), color=(9, 9, 9)).save(buf, format="PNG")
    (tmp_path / "uploads" / "fig.png").write_bytes(buf.getvalue())

    toolset = _build_liteparse_toolset(
        Settings(),
        parser=FakeParser(),
        ocr_fn=lambda *a, **k: "",
    )
    assert toolset is not None
    result = await toolset.tools["screenshot_document"].function(
        _ctx(tmp_path, model="openrouter:anthropic/claude-sonnet-5"),
        path="uploads/fig.png",
    )
    assert isinstance(result, str)
    assert "read_file" in result.lower()
    assert "BinaryContent" not in result
    saved = list((tmp_path / "screenshots").glob("page_1.*"))
    assert len(saved) == 1


@pytest.mark.asyncio
async def test_screenshot_document_ocr_for_text_only_base(tmp_path: Path) -> None:
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "deck.pdf").write_bytes(b"%PDF-1.4\n" + b"y" * 40)

    def fake_ocr(data: bytes, *, ext: str, lang: str) -> str:
        assert data == PNG
        return "diagram label FOO"

    toolset = _build_liteparse_toolset(
        Settings(),
        parser=FakeParser(),
        ocr_fn=fake_ocr,
    )
    assert toolset is not None
    result = await toolset.tools["screenshot_document"].function(
        _ctx(tmp_path, model="openrouter:z-ai/glm-5.2"),
        path="uploads/deck.pdf",
        target_pages="1",
    )
    assert isinstance(result, str)
    assert "no vision" in result.lower()
    assert "diagram label FOO" in result
    assert "--- page 1 ---" in result


@pytest.mark.asyncio
async def test_screenshot_document_honors_target_pages(tmp_path: Path) -> None:
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "deck.pdf").write_bytes(b"%PDF-1.4\n" + b"y" * 40)

    # FakeParser returns tiny invalid PNG bytes — write still succeeds (Pillow fallback).
    parser = FakeParser()
    toolset = _build_liteparse_toolset(Settings(), parser=parser, ocr_fn=lambda *a, **k: "")
    assert toolset is not None
    result = await toolset.tools["screenshot_document"].function(
        _ctx(tmp_path, model="openrouter:anthropic/claude-sonnet-5"),
        path="uploads/deck.pdf",
        target_pages="1-20",
    )
    assert isinstance(result, str)
    assert parser.last_page_numbers == list(range(1, 21))
    assert "read_file" in result.lower()
    saved = list((tmp_path / "screenshots").glob("page_*.*"))
    assert len(saved) == 20


@pytest.mark.asyncio
async def test_screenshot_document_defaults_to_max_pages_when_target_omitted(
    tmp_path: Path,
) -> None:
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "deck.pdf").write_bytes(b"%PDF-1.4\n" + b"y" * 40)

    parser = FakeParser()
    toolset = _build_liteparse_toolset(Settings(), parser=parser, ocr_fn=lambda *a, **k: "")
    assert toolset is not None
    result = await toolset.tools["screenshot_document"].function(
        _ctx(tmp_path, model="openrouter:anthropic/claude-sonnet-5"),
        path="uploads/deck.pdf",
    )
    assert isinstance(result, str)
    assert parser.last_page_numbers == list(range(1, _MAX_SCREENSHOT_PAGES + 1))
    assert len(parser.last_page_numbers) == 200
