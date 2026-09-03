# API image: Fastify service and the wa-leg CLI, with Chromium for PDF export.
# Build from the repository root: docker build -f deploy/api.Dockerfile .
FROM node:22-bookworm-slim
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
# Headless Chromium and its system libraries, shared by every user of the image.
RUN npx -y playwright@1.62.1 install --with-deps chromium-headless-shell \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm
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
RUN pnpm install --frozen-lockfile --filter @wa-leg/api...
COPY --chown=node:node tsconfig.base.json ./
COPY --chown=node:node apps/api apps/api
COPY --chown=node:node apps/dev-oidc/users.json apps/dev-oidc/users.json
COPY --chown=node:node packages packages
COPY --chown=node:node design/templates design/templates
COPY --chown=node:node reference reference
# uid 1000 (node) matches the ubuntu user on the box, which owns the bind-mounted data directories.
RUN mkdir -p /data /app/.cache && chown node:node /app /app/.cache /data
USER node
ENV NODE_ENV=production
EXPOSE 4800
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:4800/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@wa-leg/api", "start"]
