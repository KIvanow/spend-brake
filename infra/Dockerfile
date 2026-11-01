# One image per service: docker build -f infra/Dockerfile --build-arg APP=proxy .
# APP is one of proxy, api, worker, notifier, billing, or ee (with START=start:api or start:worker for
# the API and worker with the commercial features; see infra/docker-compose.ee.yml).
FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build
ARG APP
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY ee ee
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@spend-brake/${APP}...
# A self-contained production copy of the app and its workspace packages.
RUN pnpm --filter @spend-brake/${APP} deploy --prod --legacy /out

FROM node:22-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG START=start
ENV NODE_ENV=production BRAKE_START=${START}
WORKDIR /app
# Mount point for verified catalog updates (owned by the service user, so a fresh volume is too).
RUN mkdir /catalog && chown node:node /catalog
COPY --from=build --chown=node:node /out .
USER node
CMD ["sh", "-c", "exec npm run \"$BRAKE_START\""]
