# ============================================
# Stage 1: Stockfish Downloader
# ============================================
FROM alpine:latest AS downloader
WORKDIR /tmp/sf
RUN apk add --no-cache curl tar

# Download and extract official Stockfish 17.1
RUN curl -L https://github.com/official-stockfish/Stockfish/releases/download/sf_17.1/stockfish-ubuntu-x86-64-avx2.tar | tar x && \
    find . -type f -name "stockfish*" -exec mv {} stockfish-binary \; && \
    chmod +x stockfish-binary

# ============================================
# Stage 2: Node.js Builder
# ============================================
FROM node:18-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY . .
RUN npx tsc -p . && npx tsc-alias -p tsconfig.json

# ============================================
# Stage 3: Final Production Image
# ============================================
FROM node:18-slim

# Set environment variables
ENV PORT 8080
ENV NODE_ENV production
ENV STOCKFISH_PATH /app/bin/stockfish
ENV IDLE_TIMEOUT_MS 300000
ENV ENGINE_DEPTH 12
ENV ENGINE_MULTIPV 3
ENV ENGINE_THREADS 7
ENV ENGINE_HASH_MB 2048
ENV ENGINE_WORKERS_MAX 7
ENV ENGINE_MAX_CONCURRENT_JOBS 3

WORKDIR /app

# Install system dependencies (Stockfish only)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy only production Node.js dependencies
COPY package*.json ./
RUN npm install --production --no-optional

# Copy build artifacts from previous stages
COPY --from=builder /app/dist ./dist
COPY --from=downloader /tmp/sf/stockfish-binary ./bin/stockfish

# Copy only server-related files (exclude chessml and models)
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docker-entrypoint.sh ./

# Ensure permissions
RUN chmod +x scripts/start.sh && \
    chmod +x ./bin/stockfish && \
    chmod +x docker-entrypoint.sh && \
    ln -s /app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 8080

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Entrypoint and CMD
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bash", "scripts/start.sh"]
