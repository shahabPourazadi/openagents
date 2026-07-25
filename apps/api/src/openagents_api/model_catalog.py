"""Admin-managed OpenRouter model tiers (Base / Pro / Max) + ZDR."""

from __future__ import annotations

import logging
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from openagents_api.config import Settings, get_settings
from openagents_api.models import SystemSettings
from openagents_api.schemas import ModelOption

_log = logging.getLogger(__name__)

TIER_ORDER = ("base", "pro", "max")

DEFAULT_MODEL_TIERS: list[dict[str, Any]] = [
    {
        "tier": "base",
        "enabled": True,
        "label": "Base",
        "model_slug": "z-ai/glm-5.2",
        "provider": "together",
        "allow_fallbacks": True,
        "reasoning_mode": "efforts",
        "reasoning_efforts": ["high", "xhigh"],
        "context_window": 1_048_576,
        "price_input_per_m": 0.93,
        "price_output_per_m": 3.0,
        "supports_vision": False,
        "input_modalities": ["text"],
        "output_modalities": ["text"],
    },
    {
        "tier": "pro",
        "enabled": True,
        "label": "Pro",
        "model_slug": "anthropic/claude-sonnet-5",
        "provider": "auto",
        "allow_fallbacks": True,
        "reasoning_mode": "efforts",
        "reasoning_efforts": ["low", "medium", "high", "max", "xhigh"],
        "context_window": 1_000_000,
        "price_input_per_m": 2.0,
        "price_output_per_m": 10.0,
        "supports_vision": True,
        "input_modalities": ["text", "image"],
        "output_modalities": ["text"],
    },
    {
        "tier": "max",
        "enabled": True,
        "label": "Max",
        "model_slug": "openai/gpt-5.6-terra",
        "provider": "auto",
        "allow_fallbacks": True,
        "reasoning_mode": "efforts",
        "reasoning_efforts": ["low", "medium", "high", "xhigh"],
        "context_window": 1_050_000,
        "price_input_per_m": 2.5,
        "price_output_per_m": 15.0,
        "supports_vision": True,
        "input_modalities": ["text", "image"],
        "output_modalities": ["text"],
    },
]


_MODALITY_ORDER = ("text", "image", "video", "audio", "file")


def _normalize_modality_list(raw: Any, *, fallback: list[str]) -> list[str]:
    if not isinstance(raw, list) or not raw:
        return list(fallback)
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        key = str(item or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(key)
    if not out:
        return list(fallback)
    # Stable OpenRouter-like order for known kinds; keep unknowns at the end.
    ranked = [m for m in _MODALITY_ORDER if m in seen]
    extras = [m for m in out if m not in _MODALITY_ORDER]
    return ranked + extras


def modalities_from_vision(supports_vision: bool) -> tuple[list[str], list[str]]:
    inputs = ["text", "image"] if supports_vision else ["text"]
    return inputs, ["text"]


def normalize_model_slug(raw: str) -> str:
    slug = (raw or "").strip()
    if slug.startswith("openrouter:"):
        slug = slug.split(":", 1)[1].strip()
    return slug


def openrouter_model_id(slug: str) -> str:
    return f"openrouter:{normalize_model_slug(slug)}"


def default_model_tiers() -> list[dict[str, Any]]:
    return deepcopy(DEFAULT_MODEL_TIERS)


def normalize_tiers(raw: Any) -> list[dict[str, Any]]:
    """Merge DB JSON with defaults so all three tiers always exist."""
    by_tier: dict[str, dict[str, Any]] = {
        t["tier"]: deepcopy(t) for t in DEFAULT_MODEL_TIERS
    }
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            tier = str(item.get("tier") or "").strip().lower()
            if tier not in by_tier:
                continue
            base = by_tier[tier]
            slug = normalize_model_slug(str(item.get("model_slug") or base["model_slug"]))
            provider = str(item.get("provider") or "auto").strip() or "auto"
            efforts = item.get("reasoning_efforts")
            if not isinstance(efforts, list):
                efforts = list(base["reasoning_efforts"])
            efforts = [str(e) for e in efforts if e]
            mode = str(item.get("reasoning_mode") or "").strip().lower()
            if mode not in ("efforts", "toggle", "none"):
                # Empty efforts after OpenRouter sync ⇒ on/off toggle (e.g. MiniMax M3).
                mode = "efforts" if efforts else "toggle"
            supports_vision = bool(
                item.get("supports_vision", base.get("supports_vision", True))
            )
            fallback_in, fallback_out = modalities_from_vision(supports_vision)
            base.update(
                {
                    "enabled": bool(item.get("enabled", True)),
                    "label": str(item.get("label") or base["label"]).strip() or base["label"],
                    "model_slug": slug,
                    "provider": provider,
                    "allow_fallbacks": bool(item.get("allow_fallbacks", True)),
                    "reasoning_mode": mode,
                    "reasoning_efforts": efforts if mode == "efforts" else [],
                    "context_window": int(
                        item.get("context_window") or base["context_window"] or 1_000_000
                    ),
                    "price_input_per_m": (
                        float(item["price_input_per_m"])
                        if item.get("price_input_per_m") is not None
                        else base.get("price_input_per_m")
                    ),
                    "price_output_per_m": (
                        float(item["price_output_per_m"])
                        if item.get("price_output_per_m") is not None
                        else base.get("price_output_per_m")
                    ),
                    "supports_vision": supports_vision,
                    # Prefer stored OpenRouter lists; otherwise derive from vision flag
                    # (do not inherit default-tier modalities from a different slug).
                    "input_modalities": _normalize_modality_list(
                        item.get("input_modalities"),
                        fallback=fallback_in,
                    ),
                    "output_modalities": _normalize_modality_list(
                        item.get("output_modalities"),
                        fallback=fallback_out,
                    ),
                }
            )
    return [by_tier[t] for t in TIER_ORDER]


@dataclass
class ModelCatalog:
    zdr_only: bool
    tiers: list[dict[str, Any]]

    def enabled_tiers(self) -> list[dict[str, Any]]:
        return [t for t in self.tiers if t.get("enabled")]

    def tier_for_model(self, model: str | None) -> dict[str, Any] | None:
        if not model:
            return None
        bare = normalize_model_slug(model)
        for t in self.tiers:
            if normalize_model_slug(str(t.get("model_slug") or "")) == bare:
                return t
        return None

    def default_model_id(self) -> str:
        enabled = self.enabled_tiers()
        for t in enabled:
            if t.get("tier") == "base":
                return openrouter_model_id(str(t["model_slug"]))
        if enabled:
            return openrouter_model_id(str(enabled[0]["model_slug"]))
        # Fallback: first default tier even if all disabled (should be validated away)
        return openrouter_model_id(DEFAULT_MODEL_TIERS[0]["model_slug"])

    def to_model_options(self) -> list[ModelOption]:
        out: list[ModelOption] = []
        for t in self.enabled_tiers():
            mode = str(t.get("reasoning_mode") or "efforts")
            if mode not in ("efforts", "toggle", "none"):
                mode = "efforts"
            efforts = (
                [str(e) for e in (t.get("reasoning_efforts") or []) if e]
                if mode == "efforts"
                else []
            )
            if mode == "toggle":
                reasoning_label = "on/off"
            elif efforts:
                reasoning_label = ", ".join(efforts)
            else:
                reasoning_label = None
            out.append(
                ModelOption(
                    id=openrouter_model_id(str(t["model_slug"])),
                    label=str(t.get("label") or str(t["tier"]).title()),
                    context_window=int(t.get("context_window") or 1_000_000),
                    price_input_per_m=t.get("price_input_per_m"),
                    price_output_per_m=t.get("price_output_per_m"),
                    reasoning=reasoning_label,
                    reasoning_efforts=efforts,
                    reasoning_mode=mode,
                )
            )
        return out


async def load_model_catalog(session: AsyncSession) -> ModelCatalog:
    from openagents_api.company_config import ensure_system_settings

    row = await ensure_system_settings(session)
    return ModelCatalog(
        zdr_only=bool(getattr(row, "zdr_only", False)),
        tiers=normalize_tiers(getattr(row, "model_tiers", None)),
    )


async def ensure_model_tiers(session: AsyncSession) -> SystemSettings:
    """Ensure system_settings has model_tiers + zdr_only populated."""
    from openagents_api.company_config import ensure_system_settings

    row = await ensure_system_settings(session)
    if getattr(row, "model_tiers", None) is None or (
        isinstance(row.model_tiers, list) and len(row.model_tiers) == 0
    ):
        row.model_tiers = default_model_tiers()
    else:
        row.model_tiers = normalize_tiers(row.model_tiers)
    if getattr(row, "zdr_only", None) is None:
        row.zdr_only = False
    return row


async def fetch_openrouter_model_meta(
    slug: str,
    *,
    settings: Settings | None = None,
) -> dict[str, Any]:
    """Fetch reasoning / pricing / context from OpenRouter Models API."""
    s = settings or get_settings()
    slug = normalize_model_slug(slug)
    if not slug or "/" not in slug:
        raise ValueError("model_slug must look like author/model (e.g. minimax/minimax-m3)")

    api_key = (s.openrouter_api_key or "").strip()
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    url = f"https://openrouter.ai/api/v1/models/{slug}"
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 404:
                # Fallback: list models and match id
                resp = await client.get(
                    "https://openrouter.ai/api/v1/models", headers=headers
                )
                resp.raise_for_status()
                data = resp.json()
                rows = data.get("data") if isinstance(data, dict) else data
                match = None
                if isinstance(rows, list):
                    for row in rows:
                        if isinstance(row, dict) and row.get("id") == slug:
                            match = row
                            break
                if not match:
                    raise LookupError(f"OpenRouter model not found: {slug}")
                model = match
            else:
                resp.raise_for_status()
                payload = resp.json()
                model = payload.get("data") if isinstance(payload, dict) and "data" in payload else payload
                if not isinstance(model, dict):
                    raise LookupError(f"Unexpected OpenRouter response for {slug}")
    except httpx.HTTPError as exc:
        _log.warning("OpenRouter model lookup failed for %s: %s", slug, exc)
        raise RuntimeError(f"OpenRouter lookup failed for {slug}: {exc}") from exc

    pricing = model.get("pricing") if isinstance(model.get("pricing"), dict) else {}
    # OpenRouter prices are $/token strings; convert to $/1M.
    def _per_m(key: str) -> float | None:
        raw = pricing.get(key)
        if raw is None:
            return None
        try:
            return float(raw) * 1_000_000
        except (TypeError, ValueError):
            return None

    reasoning = model.get("reasoning") if isinstance(model.get("reasoning"), dict) else {}
    supported_params = model.get("supported_parameters") or []
    has_reasoning_param = any(
        p in supported_params for p in ("reasoning", "include_reasoning", "reasoning_effort")
    )
    efforts_raw = reasoning.get("supported_efforts") if reasoning else None
    efforts: list[str] = []
    reasoning_mode = "none"

    if isinstance(efforts_raw, list) and len(efforts_raw) > 0:
        efforts = [str(e) for e in efforts_raw if e and str(e) != "none"]
        reasoning_mode = "efforts" if efforts else "toggle"
    elif reasoning and "supported_efforts" in reasoning and efforts_raw is None:
        # Explicit null allowlist = all gateway efforts accepted.
        efforts = ["low", "medium", "high", "xhigh"]
        reasoning_mode = "efforts"
    elif reasoning or has_reasoning_param:
        # Supports reasoning but no effort levels (e.g. MiniMax M3) → on/off toggle.
        reasoning_mode = "toggle"
        efforts = []
    else:
        reasoning_mode = "none"
        efforts = []

    arch = model.get("architecture") if isinstance(model.get("architecture"), dict) else {}
    modality_raw = str(arch.get("modality") or "")
    # OpenRouter: "text+image+video->text" or explicit input/output modality lists.
    if "->" in modality_raw:
        in_part, out_part = modality_raw.split("->", 1)
        parsed_in = [p.strip().lower() for p in in_part.split("+") if p.strip()]
        parsed_out = [p.strip().lower() for p in out_part.split("+") if p.strip()]
    else:
        parsed_in = []
        parsed_out = []
    if isinstance(arch.get("input_modalities"), list) and arch["input_modalities"]:
        parsed_in = [str(m).strip().lower() for m in arch["input_modalities"] if m]
    if isinstance(arch.get("output_modalities"), list) and arch["output_modalities"]:
        parsed_out = [str(m).strip().lower() for m in arch["output_modalities"] if m]
    supports_vision = any(m in ("image", "file") for m in parsed_in) or "image" in modality_raw.lower()
    fallback_in, fallback_out = modalities_from_vision(supports_vision)
    input_modalities = _normalize_modality_list(parsed_in, fallback=fallback_in)
    output_modalities = _normalize_modality_list(parsed_out, fallback=fallback_out)

    ctx = model.get("context_length") or model.get("top_provider", {})
    if isinstance(ctx, dict):
        ctx = ctx.get("context_length")
    try:
        context_window = int(ctx) if ctx else 1_000_000
    except (TypeError, ValueError):
        context_window = 1_000_000

    return {
        "model_slug": slug,
        "reasoning_mode": reasoning_mode,
        "reasoning_efforts": efforts,
        "context_window": context_window,
        "price_input_per_m": _per_m("prompt"),
        "price_output_per_m": _per_m("completion"),
        "supports_vision": supports_vision,
        "input_modalities": input_modalities,
        "output_modalities": output_modalities,
        "name": model.get("name"),
    }


async def apply_tier_updates(
    session: AsyncSession,
    *,
    zdr_only: bool | None,
    tier_updates: list[dict[str, Any]] | None,
    settings: Settings | None = None,
    refresh_meta: bool = True,
) -> ModelCatalog:
    """Apply admin updates; refresh OpenRouter meta when model_slug changes."""
    row = await ensure_model_tiers(session)
    tiers = normalize_tiers(row.model_tiers)
    by_tier = {t["tier"]: t for t in tiers}

    if zdr_only is not None:
        row.zdr_only = bool(zdr_only)

    if tier_updates:
        enabled_count = sum(1 for t in tiers if t.get("enabled"))
        for upd in tier_updates:
            tier = str(upd.get("tier") or "").strip().lower()
            if tier not in by_tier:
                raise ValueError(f"Unknown tier: {tier}")
            cur = by_tier[tier]
            if "enabled" in upd and upd["enabled"] is not None:
                new_enabled = bool(upd["enabled"])
                if not new_enabled and cur.get("enabled"):
                    if enabled_count <= 1:
                        raise ValueError("At least one model tier must remain enabled")
                    enabled_count -= 1
                elif new_enabled and not cur.get("enabled"):
                    enabled_count += 1
                cur["enabled"] = new_enabled
            if upd.get("label") is not None:
                cur["label"] = str(upd["label"]).strip() or cur["label"]
            if upd.get("provider") is not None:
                p = str(upd["provider"]).strip() or "auto"
                cur["provider"] = p
            if upd.get("allow_fallbacks") is not None:
                cur["allow_fallbacks"] = bool(upd["allow_fallbacks"])
            if upd.get("model_slug") is not None:
                new_slug = normalize_model_slug(str(upd["model_slug"]))
                if not new_slug:
                    raise ValueError(f"model_slug required for tier {tier}")
                cur["model_slug"] = new_slug
                # Admin save always includes slug — refresh OpenRouter meta so
                # modalities / reasoning / pricing stay in sync.
                if refresh_meta:
                    meta = await fetch_openrouter_model_meta(new_slug, settings=settings)
                    cur["reasoning_mode"] = meta.get("reasoning_mode") or "none"
                    cur["reasoning_efforts"] = meta.get("reasoning_efforts") or []
                    cur["context_window"] = meta["context_window"]
                    if meta.get("price_input_per_m") is not None:
                        cur["price_input_per_m"] = meta["price_input_per_m"]
                    if meta.get("price_output_per_m") is not None:
                        cur["price_output_per_m"] = meta["price_output_per_m"]
                    cur["supports_vision"] = meta.get("supports_vision", True)
                    cur["input_modalities"] = meta.get("input_modalities") or ["text"]
                    cur["output_modalities"] = meta.get("output_modalities") or ["text"]

    row.model_tiers = [by_tier[t] for t in TIER_ORDER]
    return ModelCatalog(zdr_only=bool(row.zdr_only), tiers=normalize_tiers(row.model_tiers))
