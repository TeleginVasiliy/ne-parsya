#!/bin/sh
# Собирает бота в один файл для вставки в редактор Supabase (Edge Functions → bot → index.ts)
set -e
cd "$(dirname "$0")"
DENO=${DENO:-deno}
$DENO check src/index.ts
$DENO bundle --external "npm:*" --platform deno -o dist/bot.js src/index.ts
{ echo "// «Не Парься» — Telegram-бот для Supabase Edge Functions. Собрано из папки source/src командой build.sh."
  echo "// Вставьте ВЕСЬ этот файл в Supabase → Edge Functions → bot → index.ts и нажмите Deploy."
  echo "// @ts-nocheck"
  cat dist/bot.js; } > dist/index.ts
rm dist/bot.js
echo "Готово: dist/index.ts ($(wc -c < dist/index.ts) байт)"
