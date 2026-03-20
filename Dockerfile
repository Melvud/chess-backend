# Base image with Python 3.11
FROM python:3.11-slim-bookworm

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV PORT 8080
# Explicitly add node_modules/.bin to PATH
ENV PATH /app/node_modules/.bin:$PATH

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Download and install Stockfish 17.1 (Native Binary)
RUN mkdir -p /app/bin && \
    curl -L https://github.com/official-stockfish/Stockfish/releases/download/sf_17.1/stockfish-ubuntu-x86-64-avx2.tar | tar x -C /app/bin --strip-components=3 && \
    mv /app/bin/stockfish-ubuntu-x86-64-avx2 /app/bin/stockfish && \
    chmod +x /app/bin/stockfish

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files
COPY package*.json ./
COPY requirements.txt ./

# Install ALL dependencies (including devDependencies for tsc)
RUN npm install
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Ensure start script is executable
RUN chmod +x scripts/start.sh

# Build Node.js app using npx
RUN npx tsc -p . && npx tsc-alias -p tsconfig.json

# Expose port
ENV NODE_ENV production
EXPOSE 8080

# Use startup script to orchestrate services
CMD ["bash", "scripts/start.sh"]
