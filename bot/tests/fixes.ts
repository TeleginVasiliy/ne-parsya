// Исправления: чат не пустеет при ошибке Telegram, честная причина вместо «заблокировал бота»,
// клавиатура меню не пропадает, кнопка «Назад», повторный заказ с сайта, вход в кабинет из сайта.
// Запуск: deno run -A tests/fixes.ts
Deno.env.set("NP_TEST", "1");
import { assert, Driver, FakeTelegram, ok, PASSED, PG, PORT, resetDb, TOKEN } from "./harness.ts";

const ME = 111, OWNER = 222, C1 = 501, C2 = 502;
for (const [k, v] of Object.entries({
  BOT_TOKEN: TOKEN, ADMIN_IDS: `${ME},${OWNER}`, OWNER_ID: String(OWNER), WEBAPP_URL: "https://neparsya.github.io/ne-parsya/",
  PAYMENT_DETAILS: "Карта 2200", PREPAYMENT_PERCENT: "100", SUPABASE_DB_URL: PG,
  TG_API_BASE: `http://127.0.0.1:${PORT}`, SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_ROLE_KEY: "k",
  FUNCTION_URL: "https://proj.supabase.co/functions/v1/bot",
})) Deno.env.set(k, v);

const { handler } = await import("../src/index.ts");
const db = await import("../src/db.ts");
const { FLOOD } = await import("../src/router.ts");
const { sha256Hex } = await import("../src/util.ts");
FLOOD.limit = 1e9;

try {
  await resetDb();
  const tg = new FakeTelegram();
  tg.start();
  const d = new Driver(tg, handler);
  await d.init();
  const setup = await (await handler(new Request("https://proj.supabase.co/functions/v1/bot?setup=1"))).text();
  assert(setup.includes("Хранилище файлов работает"), setup);
  ok("?setup=1 проверяет, что бот может сохранять файлы на сайт");
  const owner = d.user(OWNER, "Пётр"), c = d.user(C1, "Аня");
  await d.send(d.user(ME, "Вася"), "/start");
  await d.send(owner, "/start");
  const kick = async () => assert((await handler(new Request(`http://x/bot?kick=${(await sha256Hex(`kick:${TOKEN}`)).slice(0, 40)}`))).status === 200);

  // --- клавиатура меню: одно сообщение, переживает любые переходы, /start ставит свежее
  await d.send(c, "/start");
  assert(tg.menus(C1) === 1);
  await d.send(c, "📦 Мои заказы");
  await d.send(c, "❓ Вопросы и ответы");
  await d.send(c, "🖼 Примеры работ");
  assert(tg.menus(C1) === 1 && tg.visible(C1).length === 1, JSON.stringify(tg.visible(C1)));
  await d.send(c, "/start");
  assert(tg.menus(C1) === 1, "старое сообщение с меню заменено новым, а не задвоено");
  // Чат из прошлой версии бота (клавиатуру уже удалили): меню вернётся при первом же экране
  await db.exec("update bot_screens set ids = '[]'::jsonb where chat_id = $1", [C1]);
  for (const m of tg.msgs.values()) if (m.chat === C1) m.deleted = true;
  await d.send(c, "📦 Мои заказы");
  assert(tg.menus(C1) === 1, "клавиатура вернулась");
  ok("клавиатура главного меню всегда в чате: не удаляется при переходах, возвращается в старых чатах");

  // --- «Назад»
  await d.send(c, "❓ Вопросы и ответы");
  await d.send(c, "🖼 Примеры работ");
  assert(tg.findButton(C1, "Назад"));
  await d.click(c, "Назад");
  assert(tg.visible(C1).length === 1 && tg.visible(C1)[0].includes("Вопросы"), JSON.stringify(tg.visible(C1)));
  await d.click(c, "Назад");
  assert(tg.visible(C1)[0].includes("заказ"), JSON.stringify(tg.visible(C1)));
  ok("«◀️ Назад» возвращает прошлые экраны по очереди");

  // --- повторный заказ с сайта: тот же номер заявки, другое содержимое — новый заказ
  await d.webapp(c, { kind: "np_order", id: "R1R1", type: "essay", lines: [["📝", "Работа", "Эссе"]] });
  await d.webapp(c, { kind: "np_order", id: "R1R1", type: "essay", lines: [["📝", "Работа", "Эссе"]] }); // двойное нажатие
  assert((await db.userOrders(C1)).length === 1 && tg.lastText(C1).includes("уже принят"));
  await d.webapp(c, { kind: "np_order", id: "R1R1", type: "report", lines: [["📝", "Работа", "Реферат"], ["📚", "Предмет", "История"]] });
  const orders = await db.userOrders(C1);
  assert(orders.length === 2 && orders[0].code !== "R1R1" && tg.lastText(C1).includes("принят") && !tg.lastText(C1).includes("уже"),
    JSON.stringify(orders.map((o) => o.code)));
  assert(tg.sentTo(OWNER).some((t) => t.includes(`#${orders[0].code}`)), "второй заказ пришёл админам");
  ok("второй заказ с сайта создаётся и приходит админам (дубль — только при повторе той же заявки)");

  // --- Telegram отклонил сообщение: прежний экран остаётся, админ видит настоящую причину
  const o = orders[0];
  await d.send(owner, `/order ${o.code}`);
  await d.click(owner, "Взять заказ");
  const before = tg.visible(C1);
  tg.reject.set(C1, "Bad Request: message is too long");
  await d.click(owner, "Назначить цену");
  await d.send(owner, "3000");
  await d.send(owner, "3 дня");
  tg.reject.delete(C1);
  assert(JSON.stringify(tg.visible(C1)) === JSON.stringify(before) && tg.menus(C1) === 1, "чат клиента не опустел");
  const warn = tg.sentTo(OWNER).filter((t) => t.includes("не дошло")).pop() ?? "";
  assert(warn.includes("message is too long") && !tg.sentTo(OWNER).some((t) => t.includes("заблокировал")), warn);
  assert((await db.getUser(C1))!.bot_blocked === false);
  ok("ошибка Telegram не стирает чат клиента; админ видит причину, а не «заблокировал бота»");

  // --- разметка, которую Telegram не понял, — сообщение уходит простым текстом
  tg.reject.set(C1, "Bad Request: can't parse entities: unsupported start tag");
  await d.send(c, "📦 Мои заказы");
  tg.reject.delete(C1);
  assert(tg.visible(C1).length === 1 && tg.visible(C1)[0].includes("заказ") && !tg.visible(C1)[0].includes("<b>"), JSON.stringify(tg.visible(C1)));
  ok("сообщение с неподходящей разметкой всё равно доходит (простым текстом)");

  // --- настоящая блокировка — по-прежнему «заблокировал бота»
  const c2 = d.user(C2, "Боря");
  await d.webapp(c2, { kind: "np_order", id: "B2B2", type: "essay", lines: [["📝", "Работа", "Эссе"]] });
  tg.blocked.add(C2);
  await db.exec("insert into cloud_actions(order_id, action, payload) values($1, 'message', '{\"text\":\"Привет\"}')", [(await db.getOrderByCode("B2B2"))!.id]);
  await kick();
  const act = (await db.q("select state, result from cloud_actions order by id desc limit 1"))[0];
  assert(act.state === "error" && act.result === "клиент заблокировал бота" && (await db.getUser(C2))!.bot_blocked === true, JSON.stringify(act));
  tg.blocked.delete(C2);
  ok("если клиент правда заблокировал бота — так и пишем");

  // --- сайт: имя бота и вход в кабинет
  const info = await (await handler(new Request("http://x/bot/api/info"))).json();
  assert(info.ok && info.bot === "ne_parsya_bot", JSON.stringify(info));
  await d.send(c, "/start cabinet");
  const cab = tg.findButton(C1, "Кабинет на сайте");
  assert(cab && String(cab[1].web_app?.url).includes("cabinet.html?t=") && tg.findButton(C1, "в браузере")![1].url === cab[1].web_app.url);
  ok("сайт узнаёт имя бота сам; «Войти через Telegram» — бот присылает ссылку на кабинет");

  // --- статус на сайте обновляется, даже если файл заказа не загрузился в хранилище
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1"); // хранилище недоступно
  await d.doc(c, "Методичка.pdf");
  await db.exec("insert into cloud_actions(order_id, action, payload) values($1, 'status', '{\"status\":\"in_work\"}')", [o.id]);
  await kick();
  Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${PORT}`);
  const co = (await db.q("select status from cloud_orders where id = $1", [o.id]))[0];
  assert(co?.status === "in_work", JSON.stringify(co));
  ok("статус в админ-панели обновляется, даже когда файл заказа не загрузился");

  await tg.stop();
  console.log(`\n✅ Исправления: все проверки пройдены (${PASSED.length})`);
  await db.close();
  Deno.exit(0);
} catch (e) {
  console.error(e);
  console.log(`\n✗ ПРОВАЛ после ${PASSED.length} проверок`);
  Deno.exit(1);
}
