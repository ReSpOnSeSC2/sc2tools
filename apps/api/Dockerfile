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
        python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY SC2Replay-Analyzer/requirements.txt /tmp/sc2-requirements.txt
# Single self-verifying RUN: create the venv, install deps, prove
# python+sc2reader work, all in one layer so a partial state can
# never be cached as "successful". Render's layer cache had a stale
# entry where `python -m venv` and `pip install` were each marked
# successful but the resulting /opt/sc2-py was empty when COPY'd into
# the runtime stage. By chaining venv creation + install + verify
# into a single RUN with `set -e` semantics (Docker's default), if
# any step doesn't actually produce a usable interpreter the layer
# is rejected and BuildKit retries on the next build instead of
# shipping a broken image.
#
# The `rm -rf /opt/sc2-py` at the start scrubs any stale files left
# by a previous failed run (defensive — should be a no-op on a
# from-scratch layer, but covers cache-pruning edge cases).
RUN rm -rf /opt/sc2-py \
    && python -m venv --copies /opt/sc2-py \
    && test -f /opt/sc2-py/bin/python \
    && test ! -L /opt/sc2-py/bin/python \
    && /opt/sc2-py/bin/pip install --upgrade pip wheel setuptools \
    && /opt/sc2-py/bin/pip install -r /tmp/sc2-requirements.txt \
    && /opt/sc2-py/bin/python --version \
    && /opt/sc2-py/bin/python -c "import sc2reader; print('stage1_sc2reader', sc2reader.__version__)" \
    && ls -la /opt/sc2-py/bin/python /opt/sc2-py/bin/pip
# CRITICAL: the venv MUST be created with --copies, not the default
# symlink-based layout. By default, /opt/sc2-py/bin/python is a symlink
# to /usr/local/bin/python — that path exists in this stage's
# python:3.12-slim base, but NOT in stage 2's node:22-bookworm-slim
# runtime image. Without --copies, the COPY --from=python-deps
# transfers a symlink whose target is missing on the runtime image,
# and the resulting "spawn /opt/sc2-py/bin/python ENOENT" surfaces
# at request time as preview_unavailable. The two `test` invocations
# above guarantee the binary is a real file, not a symlink, so a
# regression here fails the build.
ENV PATH="/opt/sc2-py/bin:${PATH}"

# ---- Stage 2: runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    PORT=8080 \
    SC2_PY_PYTHON=/opt/sc2-py/bin/python \
    SC2_PY_ANALYZER_DIR=/opt/sc2-analyzer \
    PATH="/opt/sc2-py/bin:${PATH}"

# libgomp1 is required by numpy/scipy at runtime. We deliberately do NOT
# install Debian's python3 here — Bookworm ships 3.11, but the venv's
# binary is linked against libpython3.12.so.1.0 which only ships with
# the upstream python:3.12 image. We bring that in via COPY below.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        libgomp1 \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

# Bring in the upstream CPython 3.12 install from stage 1. This includes
# /usr/local/lib/libpython3.12.so.1.0 (shared library the venv binary
# is dynamically linked against) and /usr/local/lib/python3.12 (the
# stdlib, located via the venv's pyvenv.cfg `home = /usr/local/bin`).
# Without this, /opt/sc2-py/bin/python fails to start with
# "error while loading shared libraries: libpython3.12.so.1.0".
COPY --from=python-deps /usr/local /usr/local
# Refresh the dynamic linker cache so libpython3.12.so.1.0 is found at
# /usr/local/lib (already on Debian's default search path, but ldconfig
# rebuilds the cache file the loader actually reads).
RUN ldconfig

# Bring in the prebuilt Python virtualenv with sc2reader / numpy / etc.
COPY --from=python-deps /opt/sc2-py /opt/sc2-py

# Build-time assertion: fail the image build if stage 1 didn't produce a
# usable venv with sc2reader installed. Without this, a silently-empty
# stage 1 (cache regression, env mismatch) can ship a runnable Node app
# that 502s every replay-preview request with `ENOENT spawn python`.
# Failing here surfaces the problem in the Render build log instead.
RUN /opt/sc2-py/bin/python --version \
    && /opt/sc2-py/bin/python -c "import sc2reader, sys; print('sc2reader', sc2reader.__version__, 'on', sys.version)"

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
