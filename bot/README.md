# Бот «Не Парься» (Supabase Edge Function `bot`)

Исходники Telegram-бота. На сайт (GitHub Pages) эта папка не влияет.

## Сборка

```sh
cd bot
./build.sh          # проверка типов + сборка в один файл dist/index.ts
```

`dist/index.ts` целиком вставляется в Supabase → Edge Functions → bot → index.ts → Deploy,
затем один раз открыть `https://КОД.supabase.co/functions/v1/bot?setup=1`.

## Тесты

Нужны Deno и Postgres 16 на `127.0.0.1:54329` (пользователь `postgres` без пароля).
Схема базы берётся из `../supabase-setup.sql`.

```sh
deno run -A tests/scenarios.ts      # основные сценарии бота
deno run -A tests/cloud.ts          # связь с сайтом, RLS, кабинет, админ-панель
deno run -A tests/features.ts       # «отправить всё», русские имена файлов, быстрая оплата
deno run -A tests/fixes.ts          # клавиатура меню, «Назад», повторный заказ, ошибки доставки
deno run -A tests/bundle_smoke.ts dist/index.ts
```
