# syntax=docker/dockerfile:1.7
#
# Compass Tools - production image for the self-hosted (OVHcloud VPS + Docker Compose + Cloudflare Tunnel) deployment.
# See docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md. NOT used by the Vercel or Cloudflare Workers deployments.
#
# Stages
#   deps     reproducible dependency install from package-lock.json (+ `prisma generate` via the project's postinstall)
#   builder  `next build` (standalone output)
#   tools    builder + full dependencies: Prisma CLI migrations and operational scripts (tsx). Run on demand, never long-lived.
#   runner   the production server: only the traced standalone output, non-root. THIS is the default (last) target.
#
# Build:   docker compose build app            (or: docker build --build-arg APP_BASE_URL=https://www.compass-tools.com -t compass-tools .)
#
# SECRETS: none are needed, accepted or baked in. The only build argument is APP_BASE_URL, which is a PUBLIC origin. Every secret
# (DATABASE_URL, CARD_ENCRYPTION_KEY, GOOGLE_CLIENT_SECRET, ...) reaches the container at RUN time from the protected .env file via
# compose.yaml. The build context must not contain .env or key files: see .dockerignore.

# Pinned by version AND digest (the multi-arch index digest, verified against Docker Hub on 2026-10-13). A floating tag such as
# `node:24` could change under a rebuild; the digest cannot. Update policy: docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md (Updating base images).
# Debian bookworm: the project's native modules (sharp/libvips, the Prisma schema engine) ship glibc builds for it.
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# openssl: required by the Prisma schema engine (prisma migrate). ca-certificates: TLS to Google and Gmail.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---- deps -------------------------------------------------------------------------------------------------------------------
FROM base AS deps
# Only what `npm ci` and the postinstall `prisma generate` need, so this layer is cached until the lockfile or schema changes.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

# ---- builder ----------------------------------------------------------------------------------------------------------------
FROM deps AS builder
COPY . .
# The statically generated public pages (canonical URLs, sitemap, Open Graph) bake the site's origin in AT BUILD TIME, and the
# Gmail OAuth redirect URI is derived from the same value at run time. Changing the domain therefore needs a rebuild.
ARG APP_BASE_URL
ENV NEXT_OUTPUT=standalone \
    APP_BASE_URL=${APP_BASE_URL} \
    NODE_OPTIONS=--max-old-space-size=3072
RUN case "${APP_BASE_URL}" in \
      https://*) ;; \
      *) echo "ERROR: build argument APP_BASE_URL must be the public https origin, e.g. https://www.compass-tools.com" >&2; exit 1 ;; \
    esac \
 && npx prisma generate \
 && npm run build \
 && test -f .next/standalone/server.js

# ---- tools ------------------------------------------------------------------------------------------------------------------
FROM builder AS tools
ENV NODE_ENV=production
USER node
# Default is read-only: it only reports migration status. Applying migrations is always an explicit, separate command.
CMD ["npx", "prisma", "migrate", "status"]

# ---- runner -----------------------------------------------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=1024 \
    UPLOAD_STORAGE_DIR=/var/lib/compass-tools/uploads
# The traced standalone server (its own minimal node_modules), then the static assets it does not copy itself.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# `sharp` (company-logo processing) is a native addon. Next's file tracer copies its .node file but not always the libvips
# libraries beside it, so take the COMPLETE platform packages from the dependency install. (The app also loads sharp lazily, so a
# problem here could only ever affect logo processing, never server start-up.)
COPY --from=deps --chown=node:node /app/node_modules/@img ./node_modules/@img
# Small, dependency-free helpers: container health probe and the daily CVV-cleanup scheduler.
COPY --from=builder --chown=node:node /app/scripts/healthcheck.mjs /app/scripts/cvv-cleanup-scheduler.mjs ./scripts/
# Lead documents (uploads) live OUTSIDE the image and OUTSIDE the container's writable layer: compose.yaml bind-mounts a host directory
# over this path. The directory is created here (owned by the unprivileged `node` user, uid/gid 1000, mode 0700) only so the mount point
# exists and has the right owner if someone runs the image by hand - without the bind mount the application treats the store as
# unavailable in production rather than silently keeping customer files in a layer that disappears with the container.
RUN mkdir -p /var/lib/compass-tools/uploads \
 && chown node:node /var/lib/compass-tools/uploads \
 && chmod 0700 /var/lib/compass-tools/uploads
# Defence in depth: a local .env must never be present in the image (the build context excludes it; this fails the build if one slipped in).
RUN ! find /app -maxdepth 2 \( -name '.env' -o -name '.env.*' \) ! -name '.env.example' | grep -q .
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "server.js"]
