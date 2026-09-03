FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* .npmrc ./
COPY apps/dev-oidc/package.json apps/dev-oidc/package.json
RUN pnpm install --frozen-lockfile --filter @wa-leg/dev-oidc
COPY apps/dev-oidc apps/dev-oidc
WORKDIR /app/apps/dev-oidc
EXPOSE 4801
CMD ["pnpm", "start"]
