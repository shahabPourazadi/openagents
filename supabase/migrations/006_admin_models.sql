-- Admin-managed OpenRouter model tiers + ZDR toggle.

alter table public.system_settings
  add column if not exists zdr_only boolean not null default false;

alter table public.system_settings
  add column if not exists model_tiers jsonb;

-- Seed current Base / Pro / Max catalog when null (idempotent).
update public.system_settings
set model_tiers = '[
  {
    "tier": "base",
    "enabled": true,
    "label": "Base",
    "model_slug": "z-ai/glm-5.2",
    "provider": "together",
    "allow_fallbacks": true,
    "reasoning_efforts": ["high", "xhigh"],
    "context_window": 1048576,
    "price_input_per_m": 0.93,
    "price_output_per_m": 3.0,
    "supports_vision": false
  },
  {
    "tier": "pro",
    "enabled": true,
    "label": "Pro",
    "model_slug": "anthropic/claude-sonnet-5",
    "provider": "auto",
    "allow_fallbacks": true,
    "reasoning_efforts": ["low", "medium", "high", "max", "xhigh"],
    "context_window": 1000000,
    "price_input_per_m": 2.0,
    "price_output_per_m": 10.0,
    "supports_vision": true
  },
  {
    "tier": "max",
    "enabled": true,
    "label": "Max",
    "model_slug": "openai/gpt-5.6-terra",
    "provider": "auto",
    "allow_fallbacks": true,
    "reasoning_efforts": ["low", "medium", "high", "xhigh"],
    "context_window": 1050000,
    "price_input_per_m": 2.5,
    "price_output_per_m": 15.0,
    "supports_vision": true
  }
]'::jsonb
where id = 1 and model_tiers is null;

alter table public.system_settings
  alter column model_tiers set default '[]'::jsonb;
