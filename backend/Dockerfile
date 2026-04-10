FROM node:24-alpine

RUN corepack enable
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

# Copy workspace configuration
COPY pnpm-workspace.yaml package.json ./

# Copy package manifests used by the workspace graph
COPY backend/package.json ./backend/
COPY worker/package.json ./worker/
COPY web/package.json ./web/
COPY shared/package.json ./shared/

# Install only backend and its workspace dependencies
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --filter backend... --no-frozen-lockfile

# Source code is mounted by docker-compose in dev
EXPOSE 5001

CMD ["pnpm", "--filter", "backend", "dev"]
