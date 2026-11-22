# The demo's image (ADR 0007). Node runs the server's TypeScript directly through type
# stripping, as it does locally, so only the page needs a build. Nothing here is specific
# to Railway: the same image runs on any container host.
ARG NODE_IMAGE=node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Node 26 no longer ships corepack; a pinned one installs pnpm at the version package.json names.
RUN npm install -g corepack@0.36.0 && corepack enable
# Manifests first, so dependency layers are reused when only source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @holdfast/web... --filter @holdfast/server...
COPY shared/ shared/
COPY web/ web/
RUN pnpm --filter @holdfast/web build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN npm install -g corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY server/package.json server/
# Production dependencies of the server and what it uses from the workspace, nothing else.
RUN pnpm install --frozen-lockfile --prod --filter @holdfast/server...

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app ./
COPY --chown=node:node shared/src shared/src
COPY --chown=node:node server/src server/src
COPY --chown=node:node server/drizzle server/drizzle
COPY --from=build --chown=node:node /app/web/dist web/dist
ENV WEB_DIST=/app/web/dist
USER node
EXPOSE 3000
CMD ["node", "server/src/main.ts"]
