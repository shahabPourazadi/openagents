"""Seam A: promote inline tool-result images to durable Assets."""

from __future__ import annotations

import base64
import json
import uuid
from pathlib import Path

import pytest

from openagents_api.workspace_assets import list_assets, read_asset_bytes

def _make_png() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


_PNG = _make_png()
_PNG_B64 = base64.b64encode(_PNG).decode("ascii")


@pytest.fixture
def local_assets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from openagents_api.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("OPENAGENTS_S3_ENDPOINT", "")
    monkeypatch.setattr("openagents_api.workspace_assets.use_s3", lambda: False)
    monkeypatch.setattr(
        "openagents_api.workspace_assets.uploads_root",
        lambda: tmp_path / "openagents-uploads",
    )
    return tmp_path


def test_promote_inline_png_saves_durable_asset_and_returns_path_metadata(
    local_assets: Path,
) -> None:
    from openagents_api.tool_media import promote_tool_result_media

    ws_id = uuid.uuid4()
    payload = json.dumps(
        {
            "content": [
                {
                    "type": "image",
                    "media_type": "image/png",
                    "data": _PNG_B64,
                }
            ]
        }
    )

    result = promote_tool_result_media(ws_id, payload)

    assert len(result.images) == 1
    path = result.images[0]
    assert path.startswith("diagrams/generated-")
    assert path.endswith(".png")
    assert _PNG_B64 not in result.content
    assert path in result.content
    assert '"media_type"' not in result.content or "image/png" not in result.content

    stored = read_asset_bytes(ws_id, path)
    assert stored == _PNG
    assert any(a["path"] == path for a in list_assets(ws_id))


def test_persist_tool_result_images_from_binary_content_bytes(
    local_assets: Path,
) -> None:
    """Raw BinaryContent.data (pre-AG-UI) must save a PIL-loadable PNG."""
    import io

    from PIL import Image
    from pydantic_ai import BinaryContent

    from openagents_api.durable_media_toolset import persist_tool_result_images

    buf = io.BytesIO()
    Image.new("RGB", (48, 48), (10, 20, 30)).save(buf, format="PNG")
    png = buf.getvalue()
    ws_id = uuid.uuid4()

    rewritten = persist_tool_result_images(
        [BinaryContent(data=png, media_type="image/png"), "ok"],
        workspace_id=ws_id,
        sandbox_dir=local_assets / "sandbox",
    )
    assert rewritten is not None
    new_result, promotion = rewritten
    assert promotion.images
    assert new_result["images"] == promotion.images
    stored = read_asset_bytes(ws_id, promotion.images[0])
    assert stored is not None
    loaded = Image.open(io.BytesIO(stored))
    loaded.load()
    assert loaded.size == (48, 48)
    assert (local_assets / "sandbox" / promotion.images[0]).is_file()


def test_promote_rejects_corrupt_png_bytes(local_assets: Path) -> None:
    """Must not persist a PNG magic header with a broken body (browser-broken asset)."""
    from openagents_api.tool_media import promote_tool_result_media

    corrupt = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        + b"\x00\x00\x04\x00\x00\x00\x04\x00\x08\x02\x00\x00\x00"
        + b"\x00" * 200
        + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    payload = json.dumps(
        [
            {
                "data": base64.b64encode(corrupt).decode("ascii"),
                "media_type": "image/png",
                "kind": "binary",
            }
        ]
    )
    ws_id = uuid.uuid4()
    result = promote_tool_result_media(ws_id, payload)
    assert result.images == []
    assert list_assets(ws_id) == []


def test_promote_agui_binary_content_urlsafe_base64_is_valid_png(
    local_assets: Path,
) -> None:
    """AG-UI dumps BinaryContent with URL-safe base64 (-/_). Must decode to a loadable PNG."""
    import io

    from PIL import Image
    from pydantic_ai import BinaryContent
    from pydantic_ai.ui.ag_ui._utils import dump_tool_return_content

    from openagents_api.tool_media import promote_tool_result_media

    im = Image.new("RGB", (64, 64), (12, 34, 56))
    px = im.load()
    assert px is not None
    for y in range(64):
        for x in range(64):
            px[x, y] = (x * 3 % 256, y * 5 % 256, (x * y) % 256)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    png = buf.getvalue()

    payload = dump_tool_return_content(
        [BinaryContent(data=png, media_type="image/png")]
    )
    assert "-" in payload or "_" in payload  # url-safe alphabet present

    ws_id = uuid.uuid4()
    result = promote_tool_result_media(ws_id, payload)
    assert len(result.images) == 1
    stored = read_asset_bytes(ws_id, result.images[0])
    assert stored is not None
    loaded = Image.open(io.BytesIO(stored))
    loaded.load()
    assert loaded.size == (64, 64)


def test_sanitize_tool_result_for_ui_promotes_inline_image(
    local_assets: Path,
) -> None:
    from openagents_api.tool_media import sanitize_tool_result_for_ui

    ws_id = uuid.uuid4()
    payload = json.dumps(
        [
            {
                "media_type": "image/png",
                "data": _PNG_B64,
            }
        ]
    )

    out = sanitize_tool_result_for_ui(payload, workspace_id=ws_id)

    assert _PNG_B64 not in out
    parsed = json.loads(out)
    assert isinstance(parsed.get("images"), list)
    assert len(parsed["images"]) == 1
    assert parsed["images"][0].startswith("diagrams/generated-")
    assert read_asset_bytes(ws_id, parsed["images"][0]) == _PNG


def test_promote_sandbox_assets_classifies_images_and_files(
    local_assets: Path,
) -> None:
    from openagents_api.tool_media import promote_sandbox_assets

    ws_id = uuid.uuid4()
    sandbox = local_assets / "sandbox"
    (sandbox / "diagrams" / "screenshots").mkdir(parents=True)
    (sandbox / "other").mkdir(parents=True)
    shot = sandbox / "diagrams" / "screenshots" / "page-1.png"
    shot.write_bytes(_PNG)
    note = sandbox / "other" / "notes.txt"
    note.write_text("hello", encoding="utf-8")

    result = promote_sandbox_assets(
        ws_id,
        [
            "diagrams/screenshots/page-1.png",
            "other/notes.txt",
            "memory/ignore.md",
        ],
        sandbox_dir=sandbox,
    )

    assert result.images == ["diagrams/screenshots/page-1.png"]
    assert result.files == ["other/notes.txt"]
    assert read_asset_bytes(ws_id, "diagrams/screenshots/page-1.png") == _PNG
    assert read_asset_bytes(ws_id, "other/notes.txt") == b"hello"
    parsed = json.loads(result.content)
    assert parsed["images"] == ["diagrams/screenshots/page-1.png"]
    assert parsed["files"] == ["other/notes.txt"]


def test_sanitize_promotes_asset_paths_mentioned_in_tool_result(
    local_assets: Path,
) -> None:
    from openagents_api.tool_media import sanitize_tool_result_for_ui

    ws_id = uuid.uuid4()
    sandbox = local_assets / "sandbox"
    (sandbox / "diagrams").mkdir(parents=True)
    (sandbox / "diagrams" / "figure-1.png").write_bytes(_PNG)

    out = sanitize_tool_result_for_ui(
        json.dumps({"path": "diagrams/figure-1.png", "status": "wrote file"}),
        workspace_id=ws_id,
        sandbox_dir=sandbox,
    )

    parsed = json.loads(out)
    assert parsed["images"] == ["diagrams/figure-1.png"]
    assert read_asset_bytes(ws_id, "diagrams/figure-1.png") == _PNG
    assert "wrote file" in parsed.get("text", "")


def test_promote_reuses_existing_asset_with_same_bytes(local_assets: Path) -> None:
    """read_file after generate must not mint a second diagrams/generated-* path."""
    from openagents_api.tool_media import promote_tool_result_media

    ws_id = uuid.uuid4()
    payload = json.dumps(
        {
            "content": [
                {
                    "type": "image",
                    "media_type": "image/png",
                    "data": _PNG_B64,
                }
            ]
        }
    )
    first = promote_tool_result_media(ws_id, payload)
    second = promote_tool_result_media(ws_id, payload)
    assert first.images == second.images
    assert len(first.images) == 1
    assert len(list_assets(ws_id)) == 1


def test_sanitize_skips_inline_promote_for_read_file(local_assets: Path) -> None:
    from openagents_api.tool_media import sanitize_tool_result_for_ui

    ws_id = uuid.uuid4()
    payload = json.dumps(
        [
            {
                "data": _PNG_B64,
                "media_type": "image/png",
                "kind": "binary",
            }
        ]
    )
    out = sanitize_tool_result_for_ui(
        payload,
        workspace_id=ws_id,
        tool_name="read_file",
    )
    assert list_assets(ws_id) == []
    assert "generated-" not in out
    assert "image" in out.lower() or "omitted" in out.lower() or "Attached" in out
