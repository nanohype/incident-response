FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:24-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S marshal && adduser -u 1001 -S marshal -G marshal

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Security hardening
RUN chown -R marshal:marshal /app

USER marshal

EXPOSE 3001

# OTel auto-instrumentation: the --require hook loads SDK + instrumentations before
# user code, so http/fetch/aws-sdk/pg/etc. are traced automatically. Manual spans
# for business-logic milestones (see src/utils/tracing.ts) are created alongside.
# OTLP target is the cluster otel-collector (chart values OTEL_EXPORTER_OTLP_ENDPOINT).
ENV NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/index.js"]
