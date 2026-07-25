# Slim image for deep-agent DockerSandbox (diagram SVG→PNG via rsvg-convert).
# Build: docker build -f apps/api/docker/agent-sandbox.Dockerfile -t openagents-agent-sandbox:latest .
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    librsvg2-bin \
    fonts-dejavu-core \
    ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Non-root-friendly default; DockerSandbox runs commands in work_dir.
CMD ["bash"]
