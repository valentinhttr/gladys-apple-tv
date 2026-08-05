# -----------------------------------------------------------------------------
# Apple TV integration image.
#
# Two runtimes in one image, on purpose: the Gladys integration SDK is Node.js,
# and pyatv — the only complete implementation of the Apple protocols — is
# Python. The Node process owns the Gladys side and drives a long-lived Python
# worker over a pipe (see src/pyatv-bridge.js and src/pyatv_bridge.py).
#
# Gladys sandbox constraints:
#   - the root filesystem is mounted READ-ONLY -> never write outside /data
#   - /data is the only writable volume (it holds the pairing credentials)
#   - the container runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

FROM node:24-bookworm-slim

ARG PYATV_VERSION=0.18.0

LABEL org.opencontainers.image.source="https://github.com/valentinhttr/gladys-apple-tv"
LABEL org.opencontainers.image.description="Gladys Assistant integration for Apple TV"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# pyatv lives in its own virtualenv: the Debian Python stays untouched, and the
# build toolchain some of its dependencies need is removed right after.
RUN apt-get update \
  && apt-get install --no-install-recommends -y \
    ca-certificates \
    dumb-init \
    python3 \
    python3-venv \
    build-essential \
    python3-dev \
  && python3 -m venv /opt/pyatv \
  && /opt/pyatv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/pyatv/bin/pip install --no-cache-dir "pyatv==${PYATV_VERSION}" \
  && apt-get purge --auto-remove -y build-essential python3-dev \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYATV_PYTHON=/opt/pyatv/bin/python3 \
    PYATV_STORAGE_FILE=/data/pyatv.json

WORKDIR /app

# Production dependencies first: they change far less often than the code.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js gladys-assistant-integration.json ./
COPY src ./src

# Fail the build here rather than at the user's home: prove the interpreter,
# pyatv and the worker all load in the final image.
RUN /opt/pyatv/bin/python3 src/pyatv_bridge.py --self-test

VOLUME ["/data"]
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
