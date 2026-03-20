#!/bin/sh
set -e

# Устанавливаем права на выполнение для Stockfish при каждом запуске
echo "Setting executable permissions for Stockfish..."
chmod +x /app/bin/stockfish

# Проверяем, что файл существует и executable
if [ ! -x /app/bin/stockfish ]; then
    echo "ERROR: Stockfish binary is not executable!"
    ls -la /app/bin/stockfish
    exit 1
fi

echo "Stockfish is ready!"
ls -la /app/bin/stockfish

# Запускаем сервис распознавания в фоне
echo "Starting Recognition Service..."
python3 chessml/fastapi_server.py &

# Запускаем основную команду
exec "$@"