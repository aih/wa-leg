# Web image: the Vite bundle served by Caddy, which also terminates TLS and proxies /api, /oidc and /mail.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/dev-oidc/package.json apps/dev-oidc/
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY packages/bill-document/package.json packages/bill-document/
COPY packages/billref/package.json packages/billref/
COPY packages/note-schema/package.json packages/note-schema/
COPY packages/workflow-machine/package.json packages/workflow-machine/
RUN pnpm install --frozen-lockfile --filter @wa-leg/web...
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages packages
RUN pnpm --filter @wa-leg/web build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
