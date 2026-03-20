# Base image with Python 3.11
FROM python:3.11-slim-bookworm

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1
ENV NODE_ENV production
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

# Build Node.js app
RUN npm run build

# Expose port
EXPOSE 8080

# Start both servers: Python in background, Node in foreground
# PYTHONUNBUFFERED ensures logs are visible immediately
CMD python3 chessml/fastapi_server.py & node dist/server.js
