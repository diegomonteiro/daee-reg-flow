# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Dependencies (clean production node_modules)
# ==============================================================================
FROM node:24-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ==============================================================================
# Stage 2: Production Runtime (SP-ÁGUAS | REG-FLOW)
# ==============================================================================
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    BASE_PATH=/reg-flow \
    TRUST_PROXY=1 \
    NODE_OPTIONS="--max-old-space-size=1024"

# Runtime geoespacial: os rasters são preparados offline e montados pelo Compose.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/hydrology/requirements.txt /tmp/hydrology-requirements.txt
RUN python3 -m venv /opt/hydrology \
    && /opt/hydrology/bin/pip install --no-cache-dir -r /tmp/hydrology-requirements.txt \
    && rm /tmp/hydrology-requirements.txt
ENV DEM_PYTHON=/opt/hydrology/bin/python

# Copy production dependencies
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Copy application source and official cartographic layers
COPY --chown=node:node package.json ./
COPY --chown=node:node app.js ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node models ./models
COPY --chown=node:node services ./services
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node routes ./routes
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public

# Run as non-root user for security
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "./bin/www"]
