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

# Запускаем основную команду
exec "$@"