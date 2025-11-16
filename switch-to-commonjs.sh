#!/bin/bash
# switch-to-commonjs.sh - Переключение на CommonJS (исправление ESM проблем)

set -e

echo "🔧 Переключение на CommonJS для исправления ESM проблем..."
echo ""

# Backup текущих файлов
echo "💾 Создание backup..."
cp package.json package.json.backup 2>/dev/null || true
cp tsconfig.json tsconfig.json.backup 2>/dev/null || true
echo "  ✅ Backup создан"
echo ""

# Копирование новых конфигов
echo "📋 Установка новых конфигураций..."

cp outputs/package-commonjs.json package.json
echo "  ✅ package.json (CommonJS)"

cp outputs/tsconfig-commonjs.json tsconfig.json
echo "  ✅ tsconfig.json (CommonJS)"

echo ""

# Копирование исправленных файлов (с обычными TypeScript импортами)
echo "📦 Обновление исходного кода..."

cp outputs/server.ts src/server.ts
echo "  ✅ src/server.ts"

cp outputs/src-lib-chessCom.ts src/lib/chessCom.ts
echo "  ✅ src/lib/chessCom.ts"

cp outputs/src-lib-lichess.ts src/lib/lichess.ts
echo "  ✅ src/lib/lichess.ts"

cp outputs/src-lib-helpers.ts src/lib/helpers.ts
echo "  ✅ src/lib/helpers.ts"

cp outputs/src-types-enums.ts src/types/enums.ts
echo "  ✅ src/types/enums.ts"

cp outputs/src-types-eval.ts src/types/eval.ts
echo "  ✅ src/types/eval.ts"

cp outputs/src-types-chessCom.ts src/types/chessCom.ts
echo "  ✅ src/types/chessCom.ts"

cp outputs/src-types-lichess.ts src/types/lichess.ts
echo "  ✅ src/types/lichess.ts"

cp outputs/src-types-game.ts src/types/game.ts
echo "  ✅ src/types/game.ts"

echo ""
echo "✅ Все файлы обновлены!"
echo ""

# Переустановка зависимостей
echo "📦 Переустановка зависимостей..."
rm -rf node_modules package-lock.json
npm install
echo "  ✅ npm install завершен"
echo ""

# Тест компиляции
echo "🔨 Тестирование компиляции..."
npm run build

if [ $? -eq 0 ]; then
    echo ""
    echo "✅✅✅ УСПЕХ! Проект собирается!"
    echo ""
    echo "🚀 Готово к деплою:"
    echo "  git add ."
    echo "  git commit -m 'Fix: switch to CommonJS for proper module resolution'"
    echo "  git push"
    echo "  flyctl deploy"
    echo ""
    echo "ℹ️  Backup файлы сохранены:"
    echo "  package.json.backup"
    echo "  tsconfig.json.backup"
else
    echo ""
    echo "❌ Компиляция не удалась"
    echo ""
    echo "Восстановление из backup:"
    echo "  cp package.json.backup package.json"
    echo "  cp tsconfig.json.backup tsconfig.json"
    exit 1
fi
