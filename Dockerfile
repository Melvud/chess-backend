# Base image with Python 3.11 (Debian Bookworm)
FROM python:3.11-slim-bookworm

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV PORT 8080
ENV NODE_ENV production
ENV STOCKFISH_PATH /app/bin/stockfish
# Explicitly add node_modules/.bin to PATH
ENV PATH /app/node_modules/.bin:$PATH

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    ca-certificates \
    libstdc++6 \
    libgomp1 \
    wget \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 18.x
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download and Prepare Stockfish 17
RUN mkdir -p bin && \
    wget https://github.com/official-stockfish/Stockfish/releases/download/sf_17/stockfish-ubuntu-x86-64-avx2.tar && \
    tar -xf stockfish-ubuntu-x86-64-avx2.tar && \
    mv stockfish/stockfish-ubuntu-x86-64-avx2 bin/stockfish && \
    chmod +x bin/stockfish && \
    rm -rf stockfish stockfish-ubuntu-x86-64-avx2.tar

# Copy dependency files
COPY package*.json ./
COPY requirements.txt ./

# Install dependencies
RUN npm install
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Build Node.js app
RUN npx tsc -p . && npx tsc-alias -p tsconfig.json

# Final preparations
RUN chmod +x scripts/start.sh

# Expose port
EXPOSE 8080

# Start via start.sh
ENTRYPOINT ["/bin/bash", "/app/scripts/start.sh"]
