# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Dependencies (clean production node_modules)
# ==============================================================================
FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ==============================================================================
# Stage 2: Production Runtime (SP-ÁGUAS | REG-FLOW)
# ==============================================================================
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    BASE_PATH=/reg-flow \
    TRUST_PROXY=1 \
    NODE_OPTIONS="--max-old-space-size=1024"

# Copy production dependencies
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Copy application source and official cartographic layers
COPY --chown=node:node package.json ./
COPY --chown=node:node app.js ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node models ./models
COPY --chown=node:node routes ./routes
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public

# Run as non-root user for security
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/reg-flow/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "./bin/www"]
