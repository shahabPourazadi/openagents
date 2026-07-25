FROM python:3.12-slim

WORKDIR /app

# Node.js + LiteParse CLI + OCR/Office stack for deep-agent document parsing.
# - tesseract: raster image OCR (parse_document on PNG/JPG/…)
# - imagemagick: LiteParse image pipeline
# - libreoffice: DOCX/XLSX/PPTX/ODF conversion for LiteParse
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tesseract-ocr \
    tesseract-ocr-eng \
    imagemagick \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    fonts-dejavu-core \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @llamaindex/liteparse \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# pyproject readme= requires README.md at sync time
COPY apps/api/pyproject.toml apps/api/uv.lock apps/api/README.md ./
COPY apps/api/src ./src
COPY templates /app/templates
COPY agents /app/agents
COPY skills /app/skills

RUN uv sync --frozen --no-dev


ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH=/app/src
ENV TEMPLATES_DIR=/app/templates
ENV AGENTS_DIR=/app/agents
ENV SKILLS_DIR=/app/skills

RUN mkdir -p /app/data /tmp/openagents-workspaces /tmp/openagents-uploads

EXPOSE 8000
CMD ["uvicorn", "openagents_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
