"""OpenAgents API — Pydantic AI deep-agent backend with specialized Agents."""

__version__ = "0.1.0"


def main() -> None:
    import uvicorn

    uvicorn.run("openagents_api.main:app", host="0.0.0.0", port=8000, reload=True)
