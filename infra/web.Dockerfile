# The dashboard: static files behind nginx, which also forwards /v1 to the admin API.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile
# The dashboard imports browser-safe parts of @spend-brake/shared: build that first.
RUN pnpm turbo run build --filter=@spend-brake/web...

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
