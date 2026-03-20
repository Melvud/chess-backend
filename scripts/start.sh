#!/bin/bash
set -e

# Start the Node.js server
# The Recognition (Python) service will be started on-demand by Node.js
echo "Starting Node.js Gateway on port ${PORT:-8080}..."
exec node dist/server.js
