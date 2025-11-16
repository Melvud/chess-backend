# syntax=docker/dockerfile:1.4

# Dockerfile для Chess Analysis Backend
# Multi-stage build для оптимизации размера

# ============================================
# Stage 1: Build TypeScript
# ============================================
FROM node:18-alpine AS builder

WORKDIR /app

# Копируем package files
COPY package*.json ./
COPY tsconfig.json ./

# Устанавливаем зависимости
RUN npm ci

# Копируем исходники
COPY src ./src

# Билдим TypeScript
RUN npm run build

# ============================================
# Stage 2: Download Stockfish binary
# ============================================
FROM alpine:latest AS stockfish-downloader

WORKDIR /stockfish

# Устанавливаем wget для скачивания
RUN apk add --no-cache wget

# Скачиваем Stockfish 17 для Linux
RUN wget https://github.com/official-stockfish/Stockfish/releases/download/sf_17/stockfish-ubuntu-x86-64-avx2.tar \
    && tar -xf stockfish-ubuntu-x86-64-avx2.tar \
    && mv stockfish/stockfish-ubuntu-x86-64-avx2 stockfish \
    && chmod +x stockfish

# ============================================
# Stage 3: Production image
# ============================================
FROM node:18-slim

# Установка зависимостей для Stockfish Ubuntu binary
# Stockfish требует glibc и стандартные C++ библиотеки
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    file \
    coreutils \
    libc6 \
    libstdc++6 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем только production зависимости
RUN npm ci --omit=dev

# Копируем собранный код из builder
COPY --from=builder /app/dist ./dist

# Создаем директорию для бинарников
RUN mkdir -p ./bin

# Копируем Stockfish с явным указанием прав доступа (BuildKit feature)
COPY --from=stockfish-downloader --chmod=755 /stockfish/stockfish ./bin/stockfish

# Проверяем, что файл существует и имеет права
RUN ls -la ./bin/stockfish && file ./bin/stockfish

# Тестируем запуск Stockfish (должен вывести "Stockfish 17 by...")
RUN echo "Testing Stockfish execution..." && \
    echo "quit" | timeout 5s ./bin/stockfish || \
    (echo "ERROR: Failed to execute Stockfish!" && exit 1)

# Копируем и настраиваем entrypoint скрипт
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Переменные окружения по умолчанию
ENV NODE_ENV=production
ENV PORT=8080
ENV STOCKFISH_PATH=/app/bin/stockfish
ENV ENGINE_DEPTH=16
ENV ENGINE_MULTIPV=3
ENV ENGINE_THREADS=2
ENV ENGINE_HASH_MB=256
ENV ENGINE_WORKERS_MAX=2
ENV ENGINE_MAX_CONCURRENT_JOBS=1
ENV LOG_LEVEL=info

# Открываем порт
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Используем entrypoint для установки прав при запуске
ENTRYPOINT ["docker-entrypoint.sh"]

# Запускаем сервер
CMD ["node", "dist/server.js"]