#!/bin/bash

# Start the Python FastAPI server in the background
echo "Starting Python Recognition Service..."
python3 chessml/fastapi_server.py &

# Wait for the Python server to be ready (models can take time to load)
echo "Waiting for Python server to initialize models..."
max_retries=60
count=0
while ! curl -s http://localhost:8000/health > /dev/null; do
    sleep 2
    count=$((count + 1))
    if [ $count -ge $max_retries ]; then
        echo "Error: Python server failed to start within time limit."
        # Don't exit here, let Node start anyway if possible, 
        # or maybe we should exit to trigger a container restart.
        exit 1
    fi
    if [ $((count % 5)) -eq 0 ]; then
        echo "Still waiting for Python server ($count/$max_retries)..."
    fi
done

echo "Python server is ready!"

# Start the Node.js server (this replaces the shell process)
echo "Starting Node.js Gateway on port ${PORT:-8080}..."
exec node dist/server.js
