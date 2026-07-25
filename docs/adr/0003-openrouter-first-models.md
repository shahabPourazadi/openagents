# OpenRouter-first, provider-agnostic model IDs

OpenRouter remains the documented default (one key, many models, usage accounting). Any Pydantic AI model ID is accepted (`openai:`, `anthropic:`, `ollama:`, …); cost tracking degrades gracefully off-OpenRouter. A full multi-provider key-management UI was rejected for v1 as disproportionate to the value.
