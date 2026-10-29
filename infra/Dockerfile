# One image per service: docker build -f infra/Dockerfile --build-arg APP=proxy .
# APP is one of proxy, api, worker, notifier.
FROM node:22-slim AS build
ARG APP
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@spend-brake/${APP}...
# A self-contained production copy of the app and its workspace packages.
RUN pnpm --filter @spend-brake/${APP} deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
CMD ["npm", "start"]
