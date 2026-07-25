"""Per-model pydantic-ai ModelSettings helpers.

Accept any pydantic-ai model string (``openrouter:…``, ``openai:…``, ``ollama:…``,
etc.) when the matching provider env keys are set. OpenRouter-specific provider
routing and usage accounting apply only when the model id starts with
``openrouter:``.
"""

from __future__ import annotations

from typing import Any

# OpenRouter lists these as text→text only (no image input). Screenshot tools OCR instead.
_TEXT_ONLY_MODEL_MARKERS = ("z-ai/glm-5.2", "glm-5.2")

# Ask OpenRouter to return USD cost in the usage object (needed for Langfuse).
# https://openrouter.ai/docs/use-cases/usage-accounting
_OPENROUTER_USAGE = {"openrouter_usage": {"include": True}}

# Cached catalog for sync settings_for_model (refreshed by async loaders).
_catalog_cache: dict[str, Any] | None = None


def set_catalog_cache(*, zdr_only: bool, tiers: list[dict[str, Any]]) -> None:
    global _catalog_cache
    _catalog_cache = {"zdr_only": zdr_only, "tiers": tiers}


def clear_catalog_cache() -> None:
    global _catalog_cache
    _catalog_cache = None


def is_openrouter_model(model: str | None) -> bool:
    """True when the pydantic-ai model id targets OpenRouter."""
    return bool(model) and str(model).strip().lower().startswith("openrouter:")


def _bare_slug(model: str | None) -> str:
    if not model:
        return ""
    bare = model.split(":", 1)[-1].strip().lower()
    return bare


def model_supports_vision(model: str | None) -> bool:
    """False for known text-only models; True otherwise (or from catalog cache)."""
    if not model:
        return True
    bare = _bare_slug(model)
    if _catalog_cache:
        for t in _catalog_cache.get("tiers") or []:
            slug = str(t.get("model_slug") or "").lower()
            if slug == bare:
                return bool(t.get("supports_vision", True))
    return not any(m in bare for m in _TEXT_ONLY_MODEL_MARKERS)


def price_rates_for_model(model: str | None) -> tuple[float, float] | None:
    """Admin catalog list prices ($ / 1M tokens) for a model, if known.

    Returns ``(input_per_m, output_per_m)`` from the cached model tiers.
    """
    if not model or not _catalog_cache:
        return None
    bare = _bare_slug(model)
    for t in _catalog_cache.get("tiers") or []:
        slug = str(t.get("model_slug") or "").strip().lower()
        if slug != bare:
            continue
        inp = t.get("price_input_per_m")
        out = t.get("price_output_per_m")
        try:
            if inp is None or out is None:
                return None
            return (float(inp), float(out))
        except (TypeError, ValueError):
            return None
    return None


def openrouter_usage_settings() -> dict[str, Any]:
    """Enable OpenRouter usage accounting so responses include cost."""
    return dict(_OPENROUTER_USAGE)


def provider_settings_for_model(model: str | None) -> dict[str, Any] | None:
    """Build openrouter_provider prefs from admin catalog (+ ZDR). OpenRouter only."""
    if not is_openrouter_model(model):
        return None

    provider_obj: dict[str, Any] = {}
    zdr_only = bool(_catalog_cache.get("zdr_only")) if _catalog_cache else False
    tier = None
    if _catalog_cache and model:
        bare = _bare_slug(model)
        for t in _catalog_cache.get("tiers") or []:
            if str(t.get("model_slug") or "").lower() == bare:
                tier = t
                break

    if tier:
        pref = str(tier.get("provider") or "auto").strip() or "auto"
        if pref.lower() != "auto":
            provider_obj["order"] = [pref]
            provider_obj["allow_fallbacks"] = bool(tier.get("allow_fallbacks", True))
        elif tier.get("allow_fallbacks") is False:
            provider_obj["allow_fallbacks"] = False
    else:
        # Legacy fallback: GLM preferred Together when catalog not loaded.
        if "glm-5.2" in _bare_slug(model):
            provider_obj["order"] = ["together"]
            provider_obj["allow_fallbacks"] = True

    if zdr_only:
        provider_obj["zdr"] = True

    if not provider_obj:
        return None
    return {"openrouter_provider": provider_obj}


def settings_for_model(model: str | None) -> dict[str, Any] | None:
    """Default ModelSettings for a model id (None = no extras).

    Non-OpenRouter models (openai:, ollama:, …) get no OpenRouter extras.
    """
    if not is_openrouter_model(model):
        return None
    parts: list[dict[str, Any]] = [openrouter_usage_settings()]
    provider = provider_settings_for_model(model)
    if provider:
        parts.append(provider)
    return merge_model_settings(*parts)


def merge_model_settings(
    *parts: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Shallow-merge settings dicts; later parts win on key conflicts."""
    out: dict[str, Any] = {}
    for part in parts:
        if part:
            out.update(part)
    return out or None
