# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.typecheck.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY scenarios ./scenarios
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CA_HOST=0.0.0.0 \
    CA_PORT=4310 \
    CA_DATA_DIR=/data
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/cli/package.json ./apps/cli/package.json
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/cli/dist ./apps/cli/dist
COPY scenarios ./scenarios
COPY scripts ./scripts
COPY docs ./docs
RUN mkdir -p /data/demo /data/live
VOLUME ["/data"]
EXPOSE 4310
CMD ["node", "apps/server/dist/server.mjs"]
