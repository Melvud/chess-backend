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
FROM python:3.11-slim-bookworm

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV PORT 8080
ENV NODE_ENV production
ENV STOCKFISH_PATH /app/bin/stockfish
ENV IDLE_TIMEOUT_MS 0

WORKDIR /app

# Install system dependencies (Node.js + AI requirements)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy only production Node.js dependencies
COPY package*.json ./
RUN npm install --production --no-optional

# Copy build artifacts from previous stages
COPY --from=builder /app/dist ./dist
COPY --from=downloader /tmp/sf/stockfish-binary ./bin/stockfish

# Copy the rest of the application (AI models, public assets, scripts)
COPY . .

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

# Entrypoint and CMD using the user's suggested entrypoint
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bash", "scripts/start.sh"]
