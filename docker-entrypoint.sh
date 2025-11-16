#!/bin/sh
set -e

# Устанавливаем права на выполнение для Stockfish при каждом запуске
if [ -f /app/bin/stockfish ]; then
  echo "Setting execute permissions for Stockfish..."
  chmod +x /app/bin/stockfish
  ls -la /app/bin/stockfish
else
  echo "WARNING: Stockfish binary not found at /app/bin/stockfish"
fi

# Запускаем основную команду
exec "$@"
