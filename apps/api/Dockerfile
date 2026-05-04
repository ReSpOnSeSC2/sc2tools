# Render builds with this Dockerfile.
#
# Build is a two-stage container:
#   1. python-deps: install the analyzer's Python deps into a virtualenv
#      that the runtime stage copies wholesale. Keeps the final image
#      small (no build-essential, no scipy/wheel/manylinux noise) and
#      lets us cache requirements independently of source changes.
#   2. runtime: Node 22 LTS slim, plus python3 + the venv from stage 1.
#      The Express server spawns scripts/{macro,apm,spatial,ml}_cli.py
#      out of /opt/sc2-analyzer using /opt/sc2-py/bin/python.
#
# Required build-time context: the repository root, so the COPY of
# `SC2Replay-Analyzer/` resolves. In Render this means setting the
# Dockerfile path to `apps/api/Dockerfile` and the build context to `.`
# (the repo root) — see render.yaml.
ARG PYTHON_IMAGE=python:3.12-slim-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- Stage 1: Python deps ----
FROM ${PYTHON_IMAGE} AS python-deps
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        build-essential \
        gcc \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/sc2-py
ENV PATH="/opt/sc2-py/bin:${PATH}"
COPY SC2Replay-Analyzer/requirements.txt /tmp/sc2-requirements.txt
RUN /opt/sc2-py/bin/pip install --upgrade pip wheel setuptools \
    && /opt/sc2-py/bin/pip install --no-deps-on-error -r /tmp/sc2-requirements.txt

# ---- Stage 2: runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    PORT=8080 \
    SC2_PY_PYTHON=/opt/sc2-py/bin/python \
    SC2_PY_ANALYZER_DIR=/opt/sc2-analyzer \
    PATH="/opt/sc2-py/bin:${PATH}"

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        python3 \
        python3-distutils \
        libgomp1 \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Bring in the prebuilt Python virtualenv with sc2reader / numpy / etc.
COPY --from=python-deps /opt/sc2-py /opt/sc2-py

# The analyzer's CLIs and shared modules. Everything under
# `scripts/`, `core/`, `analytics/`, `data/` is read at runtime.
COPY SC2Replay-Analyzer /opt/sc2-analyzer

WORKDIR /app

# Install Node deps separately so npm cache reuses across source changes.
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm ci --omit=dev

COPY apps/api/ ./

EXPOSE 8080

# tini handles SIGTERM cleanly so Render shutdowns drain in-flight
# requests instead of dropping them.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
