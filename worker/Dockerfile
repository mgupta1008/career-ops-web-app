FROM mcr.microsoft.com/playwright:v1.58.1-jammy

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

# Install only worker and its workspace dependencies
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --filter worker... --no-frozen-lockfile

# Source code is mounted by docker-compose in dev
CMD ["pnpm", "--filter", "worker", "dev"]
