// Точка входа облачной функции «bot» в Supabase.
//   POST от Telegram (вебхук)          — сообщения и нажатия кнопок;
//   ?setup=1                            — подключение: вебхук, команды, расписание (открыть один раз в браузере);
//   ?cron=<ключ> / ?kick=<ключ>         — фоновые задачи (расписание) и «пинок» от сайта;
//   POST …/api/order                    — заказ с сайта, открытого внутри Telegram.
import { T } from "./texts.ts";
import { ConfigError, loadConfig, log, setLogSecrets } from "./config.ts";
import type { Config } from "./config.ts";
import * as db from "./db.ts";
import * as K from "./kb.ts";
import { amountDue, applyMenuButton, cabinetLink, getWebappUrl, setupCommands, statusLabel, typeName } from "./services.ts";
import { acceptSignedOrder, checkInitData, checkStorage, pushChanged, pushReviews, pushSettings } from "./cloud.ts";
import * as screen from "./screen.ts";
import { runJobs } from "./jobs.ts";
import { handleUpdate } from "./router.ts";
import * as tg from "./tg.ts";
import { sha256Hex } from "./util.ts";
import { background, flush } from "./bg.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const text = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Дело, которое можно доделать после ответа (Supabase не обрывает его сразу). */
async function later(job: Promise<unknown>) {
  background(job);
  await flush(); // в Supabase очередь пуста сразу (дела идут после ответа), в тестах — дожидаемся
}

const secretFor = async (config: Config, purpose: string) => (await sha256Hex(`${purpose}:${config.token}`)).slice(0, 40);

/** Регион базы: из секрета DB_REGION или из адреса подключения (…aws-0-eu-central-1.pooler…). */
function dbRegion(): string {
  const manual = (Deno.env.get("DB_REGION") ?? "").trim().toLowerCase();
  if (/^[a-z]{2}-[a-z]+-\d$/.test(manual)) return manual;
  return /aws-\d+-([a-z]{2}-[a-z]+-\d)\./.exec(Deno.env.get("SUPABASE_DB_URL") ?? "")?.[1] ?? "";
}

function functionUrl(req: Request): string {
  const override = Deno.env.get("FUNCTION_URL");
  if (override) return override.replace(/\/+$/, "");
  const segs = new URL(req.url).pathname.split("/").filter(Boolean).filter((s) => s !== "functions" && s !== "v1");
  return `${(Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "")}/functions/v1/${segs[0] || "bot"}`;
}

async function ensureUsername() {
  if (K.BOT_USERNAME) return;
  let name = await db.getSetting("bot_username");
  if (!name) {
    const me = await tg.call<{ username: string }>("getMe", {});
    name = me?.username ?? "";
    if (name) await db.setSetting("bot_username", name);
  }
  K.setBotUsername(name ?? "");
}

// ----------------------- первичная настройка -----------------------
async function setup(req: Request, config: Config): Promise<Response> {
  const report: string[] = [];
  let me;
  try {
    me = await tg.api("getMe");
  } catch (e) {
    return text(`❌ Telegram не принял BOT_TOKEN (${(e as tg.TgError).description}). Проверьте токен в Edge Functions → Secrets.`, 400);
  }
  await db.setSetting("bot_username", me.username);
  K.setBotUsername(me.username);
  const base = functionUrl(req);
  // Функция должна работать рядом с базой: каждое нажатие — это несколько запросов к ней
  const region = dbRegion();
  const hookUrl = region ? `${base}?forceFunctionRegion=${region}` : base;
  const withRegion = (u: string) => (region ? `${u}&forceFunctionRegion=${region}` : u);
  await tg.api("setWebhook", {
    url: hookUrl, secret_token: await secretFor(config, "webhook"), allowed_updates: ["message", "callback_query"], max_connections: 40,
  });
  report.push(`✅ Бот @${me.username} подключён: Telegram присылает сообщения сюда, компьютер больше не нужен.`);

  // Замер: сколько длится один запрос к базе отсюда
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) await db.q("select 1");
  const ms = Math.round((performance.now() - t0) / 5);
  const here = Deno.env.get("SB_REGION") ?? "";
  report.push(`⏱ Отклик базы: ${ms} мс на запрос` + (here ? ` (бот работает в регионе ${here}${region ? `, база — ${region}` : ""})` : "") + ".");
  if (ms > 25 && !region) {
    report.push("⚠️ Бот работает далеко от базы, поэтому отвечает медленнее. Посмотрите регион базы: Project Settings → General " +
      "(например eu-central-1 — это Франкфурт), добавьте секрет DB_REGION с этим значением и откройте эту страницу ещё раз.");
  }

  await setupCommands(config);
  const url = await getWebappUrl(config);
  await applyMenuButton(url);
  report.push(url ? `✅ Кнопка «🌐 Сайт» ведёт на ${url}` : "ℹ️ Ссылка на сайт не задана — добавьте секрет WEBAPP_URL или отправьте боту /setsite https://ваш-сайт");

  const kick = withRegion(`${base}?kick=${await secretFor(config, "kick")}`);
  const cron = withRegion(`${base}?cron=${await secretFor(config, "cron")}`);
  await db.setSetting("kick_url", kick); // сайт будит бота, когда появляется заказ или действие админа
  try {
    await db.exec("select cron.unschedule('np-bot') where exists (select 1 from cron.job where jobname = 'np-bot')");
    await db.exec(
      `select cron.schedule('np-bot', '* * * * *', format('select net.http_post(url := %L, body := ''{}''::jsonb)', $1::text))`, [cron]);
    report.push("✅ Расписание включено: раз в минуту бот проверяет напоминания, рассылки и сайт.");
  } catch (e) {
    report.push(`⚠️ Расписание не включилось (${(e as Error).message}). Бот работает, но напоминания будут приходить только когда кто-то пишет боту. Выполните заново supabase-setup.sql и откройте эту страницу ещё раз.`);
  }
  const storageError = await checkStorage();
  report.push(storageError
    ? `⚠️ Бот не может сохранять файлы на сайт (${storageError.slice(0, 200)}). Чеки и файлы клиентов не появятся в админ-панели. ` +
      "Как исправить: Supabase → Project Settings → API Keys → скопируйте ключ Secret (sb_secret_…) → Edge Functions → Secrets → " +
      "добавьте секрет STORAGE_KEY с этим ключом и откройте эту страницу ещё раз."
    : "✅ Хранилище файлов работает: чеки и файлы клиентов попадают в админ-панель.");
  await pushSettings(config).catch(() => {});
  const reviewsError = await pushReviews();
  report.push(reviewsError
    ? `⚠️ Отзывы не попадают на сайт (${reviewsError.slice(0, 200)}). Выполните заново supabase-setup.sql в Supabase → SQL Editor и откройте эту страницу ещё раз.`
    : "✅ Опубликованные отзывы выложены на сайт.");
  if (config.setupMode) report.push("⚙️ Режим настройки: напишите боту /id и добавьте секреты ADMIN_IDS и OWNER_ID.");
  else report.push(`👥 Админов: ${config.adminIds.length}. Владелец: ${config.ownerId}.`);
  return text(report.join("\n\n"));
}

// ----------------------- запросы -----------------------
export async function handler(req: Request): Promise<Response> {
  try {
    return await handle(req);
  } finally {
    await flush(); // вне Supabase (в тестах) дожидаемся фоновых дел
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) return text(`⚠️ ${e.message}`, 200);
    throw e;
  }
  setLogSecrets(config.secrets);
  tg.setToken(config.token);
  const url = new URL(req.url);

  // Клавиатура главного меню: её сообщение бот держит в чате клиента постоянно
  screen.setMenuFactory(async (chatId) => {
    const url = await getWebappUrl(config);
    return { text: T.MENU_HINT, markup: K.mainMenu(url, config.isAdmin(chatId) ? K.adminPanelUrl(url) : null) };
  });

  try {
    if (url.searchParams.has("setup")) return await setup(req, config);
    await ensureUsername();

    if (url.pathname.endsWith("/api/info")) {
      // Сайт узнаёт имя бота сам — даже если в config.js оно не вписано
      return json({ ok: true, bot: K.BOT_USERNAME });
    }

    const cron = url.searchParams.get("cron"), kick = url.searchParams.get("kick");
    if (cron || kick) {
      if (cron === await secretFor(config, "cron")) await runJobs(config);
      else if (kick === await secretFor(config, "kick")) await runJobs(config, { reminders: false });
      else return text("forbidden", 403);
      return text("ok");
    }

    if (url.pathname.endsWith("/api/my") && req.method === "POST") {
      // Сайт, открытый в Telegram, показывает клиенту его активные заказы (по подписи Telegram)
      let body: { initData?: string } = {};
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }
      const u = await checkInitData(config.token, String(body?.initData ?? ""), 24 * 3600);
      if (!u) return json({ ok: false, error: "подпись Telegram не подошла" }, 403);
      const orders = (await db.userOrders(u.id, 10)).filter((o) => !["done", "cancelled"].includes(o.status));
      return json({
        ok: true,
        cabinet: await cabinetLink(config, u.id),
        orders: orders.map((o) => ({
          code: o.code, type_name: typeName(o), status: o.status, status_label: statusLabel(o.status), price: o.price,
          paid: o.paid, due: o.status === "awaiting_payment" ? amountDue(o, "prepay") : o.status === "awaiting_final" ? amountDue(o, "final") : 0,
          deadline_text: o.deadline_text,
        })),
      });
    }

    if (url.pathname.endsWith("/api/order") && req.method === "POST") {
      // deno-lint-ignore no-explicit-any
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }
      try {
        const order = await acceptSignedOrder(config, String(body?.initData ?? ""), body?.order);
        await later(pushChanged());
        return json({ ok: true, code: order.code });
      } catch (e) {
        return json({ ok: false, error: (e as Error).message }, 400);
      }
    }

    if (req.method === "POST" && req.headers.has("x-telegram-bot-api-secret-token")) {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== await secretFor(config, "webhook")) return text("forbidden", 403);
      const update = await req.json();
      // Повтор апдейта отсекаем тем же заходом в базу, что и учёт пользователя (запросы идут одновременно)
      const fresh = typeof update.update_id === "number" ? db.claimUpdate(update.update_id) : Promise.resolve(true);
      const wantJobs = await handleUpdate(config, update, fresh);
      // После ответа: выгрузить изменения на сайт (и запустить рассылку, если её только что подтвердили)
      await later(wantJobs ? runJobs(config, { reminders: false }) : pushChanged());
      return text("ok");
    }

    return text(`🤖 ${T.BRAND}: бот работает. Для настройки откройте эту ссылку с ?setup=1 на конце.`);
  } catch (e) {
    log(`Ошибка: ${(e as Error).stack ?? e}`);
    return text("error", 200); // Telegram не будет бесконечно повторять апдейт
  }
}

if (!Deno.env.get("NP_TEST")) Deno.serve(handler); // в тестах обработчик вызывается напрямую
