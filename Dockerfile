# syntax=docker/dockerfile:1.4

FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

# ============================================
# Stockfish - ИСПРАВЛЕННЫЙ
# ============================================
FROM alpine:latest AS stockfish-downloader
WORKDIR /stockfish
RUN apk add --no-cache wget tar

# Скачиваем и ПРАВИЛЬНО переименовываем
RUN wget https://github.com/official-stockfish/Stockfish/releases/download/sf_17/stockfish-ubuntu-x86-64-avx2.tar && \
    tar -xf stockfish-ubuntu-x86-64-avx2.tar && \
    cd stockfish && \
    mv stockfish-ubuntu-x86-64-avx2 stockfish && \
    chmod 755 stockfish && \
    ls -la

# ============================================
# Production
# ============================================
FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production --no-optional

COPY --from=builder /app/dist ./dist

RUN mkdir -p ./bin

# ВАЖНО: копируем из правильного места
COPY --from=stockfish-downloader /stockfish/stockfish/stockfish ./bin/stockfish

# Явно устанавливаем права
RUN chmod +x ./bin/stockfish && ls -la ./bin/

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8080 \
    STOCKFISH_PATH=/app/bin/stockfish \
    ENGINE_DEPTH=12 \
    ENGINE_MULTIPV=3 \
    ENGINE_THREADS=7 \
    ENGINE_HASH_MB=2048 \
    ENGINE_WORKERS_MAX=7 \
    ENGINE_MAX_CONCURRENT_JOBS=3 \
    LOG_LEVEL=info

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]