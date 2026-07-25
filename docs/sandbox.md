# Agent sandbox

The deep agent can edit files and (optionally) run shell commands through a pluggable sandbox backend.

## Modes

| `AGENT_SANDBOX` | Behavior |
|-----------------|----------|
| `local` (default) | Host filesystem backend via pydantic-ai backends. Fine for trusted local dev. |
| `docker` | Isolated container from `AGENT_SANDBOX_IMAGE`. Preferred for shared hosts. |

Related env:

| Variable | Role |
|----------|------|
| `AGENT_EXECUTE` | When `true`, offer execute/shell when a sandbox is available |
| `AGENT_SANDBOX_IMAGE` | Image tag (default `openagents-agent-sandbox:latest`) |
| `AGENT_SANDBOX_MAX_CONCURRENT` | Max concurrent Docker sandboxes (default `1`) |

Admins can override these at runtime under **Admin → Tools → Agent sandbox** (`system_settings.agent_runtime`). Overrides apply on the next agent run — no redeploy.

## Soft-degrade

Docker sandbox acquisition can fail when:

- The concurrency slot is full (`AGENT_SANDBOX_MAX_CONCURRENT`)
- The Docker daemon is unreachable
- The image is missing or fails to start

In those cases OpenAgents **soft-degrades** to filesystem-only (no host execute fallback). The agent can still use file tools and document suggestions; shell execute is unavailable until a slot frees up.

## Building the sandbox image

Dockerfile: [`apps/api/docker/agent-sandbox.Dockerfile`](../apps/api/docker/agent-sandbox.Dockerfile)

```bash
# From repo root, on the machine that will run Docker sandboxes:
docker build -f apps/api/docker/agent-sandbox.Dockerfile -t openagents-agent-sandbox:latest .
docker images | grep openagents-agent-sandbox
```

If the API runs in Compose and you set `AGENT_SANDBOX=docker`, the API process must be able to talk to the Docker socket (or a remote Docker API) and the image name must match `AGENT_SANDBOX_IMAGE`.

## Local vs Docker checklist

**Local / solo laptop**

- Keep `AGENT_SANDBOX=local`
- Keep `AGENT_EXECUTE=true` if you want shell for Coding Assistant

**Shared VPS**

- Build the sandbox image on the host
- Set `AGENT_SANDBOX=docker`
- Keep `AGENT_SANDBOX_MAX_CONCURRENT=1` until you have headroom
- Do not expose the Docker socket beyond the API process

## Related

- [configuration.md](configuration.md)
- [deployment.md](deployment.md)
