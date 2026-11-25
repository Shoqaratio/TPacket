# Builds the SPA and serves it with Nginx, which also reverse-proxies /api to the API container.
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @netlab/web --workspace @netlab/engine --include-workspace-root=false
COPY packages/engine packages/engine
COPY apps/web apps/web
RUN npm run build -w @netlab/web

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 80
