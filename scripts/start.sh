#!/bin/bash

# scripts/start.sh - Robust startup for Chess Backend on Railway
set -e

echo "--- Starting Chess Backend Initialization ---"

# 1. Ensure Stockfish is executable
if [ -f "/app/bin/stockfish" ]; then
    echo "Setting execution permissions for /app/bin/stockfish"
    chmod +x /app/bin/stockfish
else
    echo "WARNING: Stockfish binary not found at /app/bin/stockfish"
    # Try to find it if it was installed via apt
    if command -v stockfish &> /dev/null; then
        echo "Stockfish found in PATH: $(command -v stockfish)"
    fi
fi

# 2. Start Python Recognition Service in the background
echo "Starting Python Recognition Service (FastAPI) on port 8000..."
# PYTHONPATH helps with module discovery
export PYTHONPATH=$PYTHONPATH:/app
python3 chessml/fastapi_server.py &
PYTHON_PID=$!

# 3. Wait a few seconds for Python to bind to port
sleep 2

# 4. Start Node.js API Gateway in the foreground
echo "Starting Node.js API Gateway (Express) on port ${PORT:-8080}..."
# Use exec to let Node handle signals directly
exec node dist/server.js
