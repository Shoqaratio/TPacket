# API image. Contains Node.js only to run the engine's bundled grader (same code as the browser).
FROM node:22-bookworm-slim AS engine
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @netlab/engine --include-workspace-root=false
COPY packages/engine packages/engine
COPY tsconfig.base.json ./
RUN cd packages/engine && node build-grader.mjs

FROM python:3.12-slim-bookworm
COPY --from=engine /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY apps/api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/api/ .
COPY --from=engine /src/packages/engine/dist/grader.mjs /app/grader/grader.mjs
ENV NETLAB_GRADER_PATH=/app/grader/grader.mjs \
    NETLAB_NODE_BIN=/usr/local/bin/node \
    PYTHONDONTWRITEBYTECODE=1
RUN useradd --system --uid 10001 netlab
USER netlab
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
