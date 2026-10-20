// Замер: сколько запросов к базе и к Telegram уходит на одно нажатие (меньше — быстрее отклик).
Deno.env.set("NP_TEST", "1");
import { Driver, FakeTelegram, PG, PORT, resetDb, TOKEN } from "./harness.ts";
for (const [k, v] of Object.entries({ BOT_TOKEN: TOKEN, ADMIN_IDS: "111", OWNER_ID: "111", SUPABASE_DB_URL: PG,
  TG_API_BASE: `http://127.0.0.1:${PORT}`, SUPABASE_URL: `http://127.0.0.1:${PORT}`, WEBAPP_URL: "https://x.github.io/s/" })) Deno.env.set(k, v);
const { handler } = await import("../src/index.ts");
const db = await import("../src/db.ts");
await resetDb();
const tg = new FakeTelegram();
tg.start();
await (await handler(new Request("https://p.supabase.co/functions/v1/bot?setup=1"))).text();
const d = new Driver(tg, handler);
await d.init();
const c = d.user(501, "Аня");
await d.send(c, "/start");
async function measure(name: string, fn: () => Promise<unknown>) {
  const q0 = db.counters.queries, t0 = tg.calls.length, ms = performance.now();
  await fn();
  console.log(`${name.padEnd(28)} база: ${String(db.counters.queries - q0).padStart(3)}  Telegram: ${String(tg.calls.length - t0).padStart(2)}  ${Math.round(performance.now() - ms)} мс`);
}
await measure("/start", () => d.send(c, "/start"));
await measure("📝 Оформить заказ", () => d.send(c, "📝 Оформить заказ"));
await measure("кнопка «Реферат»", () => d.click(c, "Реферат"));
await measure("текст «История»", () => d.send(c, "История России"));
await measure("кнопка «Тему подберёт»", () => d.click(c, "Тему подберёт"));
await measure("📦 Мои заказы", () => d.send(c, "📦 Мои заказы"));
await tg.stop();
await db.close();
Deno.exit(0);
