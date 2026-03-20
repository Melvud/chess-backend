#!/bin/bash
set -e

echo "--- DOCKER RUNTIME DIAGNOSTICS ---"
echo "Current directory: $(pwd)"
echo "Listing dist directory:"
ls -R dist || echo "ERROR: dist directory not found!"

# Function to handle shutdown signals
cleanup() {
    echo "Stopping background processes..."
    kill $PYTHON_PID 2>/dev/null || true
    exit 0
}

# Trap SIGINT and SIGTERM
trap cleanup SIGINT SIGTERM

echo "Starting FastAPI Recognition Service..."
# Use stdbuf to avoid output buffering
python3 chessml/fastapi_server.py &
PYTHON_PID=$!
echo "FastAPI PID: $PYTHON_PID"

echo "Starting Node.js Gateway..."
node dist/server.js &
NODE_PID=$!
echo "Node.js PID: $NODE_PID"

# Wait for Node.js process to exit
wait $NODE_PID
NODE_STATUS=$?

echo "Node.js Gateway exited with status $NODE_STATUS. Shutting down..."
cleanup
