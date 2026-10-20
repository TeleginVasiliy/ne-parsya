// Проверка собранного файла (по умолчанию dist/index.ts): запускается как сервер, как в Supabase, и отвечает боту.
// Запуск: deno run -A tests/bundle_smoke.ts ["../2-бот-index.ts"]
import { assert, Driver, FakeTelegram, PG, PORT, resetDb, TOKEN } from "./harness.ts";

await resetDb();
const tg = new FakeTelegram();
tg.start();
const env = {
  BOT_TOKEN: TOKEN, ADMIN_IDS: "111", OWNER_ID: "111", SUPABASE_DB_URL: PG, TG_API_BASE: `http://127.0.0.1:${PORT}`,
  SUPABASE_URL: "http://127.0.0.1:8000", SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}', PAYMENT_DETAILS: "Карта 1",
};
const deno = Deno.execPath();
const proc = new Deno.Command(deno, { args: ["run", "-A", "--quiet", Deno.args[0] ?? "dist/index.ts"], env, stdout: "piped", stderr: "piped" }).spawn();
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  await new Promise((r) => setTimeout(r, 300));
  up = await fetch("http://127.0.0.1:8000/bot").then((r) => r.text()).then((t) => t.includes("бот работает")).catch(() => false);
}
try {
  assert(up, "собранный файл не запустился");
  const setup = await (await fetch("http://127.0.0.1:8000/functions/v1/bot?setup=1")).text();
  assert(setup.includes("подключён"), setup);
  const hook = tg.methods("setWebhook").pop()!;
  assert(hook.url === "http://127.0.0.1:8000/functions/v1/bot", hook.url);
  const d = new Driver(tg, (req) => fetch(new Request("http://127.0.0.1:8000/bot", req)));
  await d.init();
  const c = d.user(501, "Аня");
  await d.send(c, "/start");
  assert(tg.lastText(501).includes("Главное меню"), tg.lastText(501));
  await d.send(c, "📝 Оформить заказ");
  await d.click(c, "Реферат");
  assert(tg.lastText(501).includes("Шаг 2/11"));
  console.log("✅ Собранный файл dist/index.ts работает как функция Supabase");
} finally {
  proc.kill();
  await proc.status;
  await tg.stop();
}
Deno.exit(0);
