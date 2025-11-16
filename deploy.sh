#!/bin/bash
# deploy.sh - Скрипт для быстрого деплоя на Fly.io

set -e  # Остановка при ошибке

echo "🚀 Chess Analysis Backend - Деплой на Fly.io"
echo "=============================================="
echo ""

# Проверка наличия flyctl
if ! command -v flyctl &> /dev/null; then
    echo "❌ flyctl не установлен!"
    echo "Установи его: https://fly.io/docs/hands-on/install-flyctl/"
    exit 1
fi

# Проверка авторизации
if ! flyctl auth whoami &> /dev/null; then
    echo "❌ Не авторизован в Fly.io!"
    echo "Выполни: flyctl auth login"
    exit 1
fi

echo "✅ flyctl установлен и авторизован"
echo ""

# Проверка необходимых файлов
REQUIRED_FILES=("package.json" "tsconfig.json" "Dockerfile" "fly.toml" "src/server.ts")
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo "❌ Отсутствует файл: $file"
        exit 1
    fi
done

echo "✅ Все необходимые файлы на месте"
echo ""

# Опциональные шаги
read -p "Запустить npm run build локально для проверки? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "📦 Сборка TypeScript..."
    npm run build
    echo "✅ Сборка успешна"
    echo ""
fi

# Проверка существования приложения
APP_NAME=$(grep "^app = " fly.toml | cut -d'"' -f2)
echo "📱 Имя приложения: $APP_NAME"
echo ""

if flyctl apps list | grep -q "$APP_NAME"; then
    echo "✅ Приложение $APP_NAME уже существует"
    
    read -p "Показать текущий статус? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        flyctl status -a "$APP_NAME"
        echo ""
    fi
else
    echo "⚠️  Приложение $APP_NAME не существует"
    read -p "Создать новое приложение? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        flyctl launch --no-deploy
        echo "✅ Приложение создано"
    else
        echo "❌ Отменено"
        exit 1
    fi
fi

echo ""
echo "🚀 Начинаю деплой..."
echo ""

# Деплой
flyctl deploy

# Проверка статуса
echo ""
echo "✅ Деплой завершен!"
echo ""
echo "📊 Статус приложения:"
flyctl status -a "$APP_NAME"

echo ""
echo "🌍 URL приложения:"
flyctl info -a "$APP_NAME" | grep "Hostname"

echo ""
echo "📝 Логи (Ctrl+C для выхода):"
read -p "Показать логи? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    flyctl logs -a "$APP_NAME"
fi

echo ""
echo "✅ Готово! Приложение задеплоено и работает"
echo ""
echo "Полезные команды:"
echo "  flyctl logs -a $APP_NAME          # Логи"
echo "  flyctl status -a $APP_NAME        # Статус"
echo "  flyctl dashboard -a $APP_NAME     # Dashboard"
echo "  flyctl ssh console -a $APP_NAME   # SSH в контейнер"
