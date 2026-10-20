// Связь бота с сайтом: выгрузка заказов/оплат/файлов, кабинет клиента,
// заказы с сайта по подписи Telegram, действия и файлы из админ-панели, «пинок» сайта.
// Запуск: deno run -A tests/cloud.ts
Deno.env.set("NP_TEST", "1");
import { assert, Driver, FakeTelegram, ok, PASSED, PG, PORT, resetDb, TOKEN } from "./harness.ts";

const ME = 111, OWNER = 222, C1 = 501;
for (const [k, v] of Object.entries({
  BOT_TOKEN: TOKEN, ADMIN_IDS: `${ME},${OWNER}`, OWNER_ID: String(OWNER), WEBAPP_URL: "https://ne-parsya.netlify.app",
  PAYMENT_DETAILS: "Карта 2200 1234 5678 9010", PREPAYMENT_PERCENT: "50", SUPABASE_DB_URL: PG,
  TG_API_BASE: `http://127.0.0.1:${PORT}`, SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_ROLE_KEY: "service-key",
  FUNCTION_URL: "https://proj.supabase.co/functions/v1/bot",
})) Deno.env.set(k, v);

const { handler } = await import("../src/index.ts");
const db = await import("../src/db.ts");
const { FLOOD } = await import("../src/router.ts");
const { sha256Hex } = await import("../src/util.ts");
FLOOD.limit = 1e9;

async function hmacHex(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
/** initData так, как его подписывает Telegram. */
async function initData(user: Record<string, unknown>, token = TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const p = new URLSearchParams({ auth_date: String(authDate), query_id: "AAE", user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmacHex(new TextEncoder().encode("WebAppData"), token);
  p.set("hash", [...await hmacHex(secret, check)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}

/** Запрос «как с сайта» — от роли anon/authenticated, с правилами доступа (RLS). */
async function asRole(role: string, email: string | null, sql: string, params: unknown[] = []) {
  const claims = JSON.stringify(email ? { email, role } : { role });
  // set_config(..., true) живёт до конца транзакции — выполняем всё одной транзакцией
  const sqlc = db.connect();
  return await sqlc.begin(async (tx: any) => {
    await tx.unsafe(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await tx.unsafe(`set local role ${role}`);
    return [...await tx.unsafe(sql, params)];
  });
}

try {
  await resetDb();
  const tg = new FakeTelegram();
  tg.start();
  const d = new Driver(tg, handler);
  await d.init();
  await (await handler(new Request("https://proj.supabase.co/functions/v1/bot?setup=1"))).text();
  const me = d.user(ME, "Вася"), owner = d.user(OWNER, "Пётр"), c = d.user(C1, "Аня", "anya");
  await d.send(me, "/start");
  await d.send(owner, "/start");
  await d.send(c, "/start");
  const kickKey = (await sha256Hex(`kick:${TOKEN}`)).slice(0, 40);
  const kick = async () => assert((await handler(new Request(`http://x/bot?kick=${kickKey}`))).status === 200);

  // --- 1. Заказ с сайта внутри Telegram: incoming_orders + подпись
  const payload = { kind: "np_order", id: "W1W1", type: "referat", lines: [["📝", "Работа", "Реферат"], ["📄", "Объём", "15 стр."]] };
  await asRole("anon", null, "insert into incoming_orders(init_data, payload) values($1, $2::text::jsonb)",
    [await initData({ id: C1, first_name: "Аня" }), JSON.stringify(payload)]);
  await asRole("anon", null, "insert into incoming_orders(init_data, payload) values($1, $2::text::jsonb)",
    [await initData({ id: 777, first_name: "Хакер" }, "999:WRONG"), JSON.stringify({ ...payload, id: "BAD1" })]);
  await asRole("anon", null, "insert into incoming_orders(init_data, payload) values($1, $2::text::jsonb)",
    [await initData({ id: C1, first_name: "Аня" }, TOKEN, Math.floor(Date.now() / 1000) - 8 * 86400), JSON.stringify({ ...payload, id: "OLD1" })]);
  const calls = await db.q("select url from net.calls");
  assert(calls.length === 3 && calls.every((c) => String(c.url).includes("?kick=")), "сайт будит бота сразу после вставки");
  await kick();
  const w = await db.getOrderByCode("W1W1");
  assert(w && w.user_id === C1 && w.source === "site" && !(await db.getOrderByCode("BAD1")) && !(await db.getOrderByCode("OLD1")));
  const inc = await db.q("select state, result from incoming_orders order by id");
  assert(inc[0].state === "done" && inc[1].state === "error" && inc[2].state === "error", JSON.stringify(inc));
  assert(tg.lastText(C1).includes("#W1W1 принят"));
  ok("заказ с сайта (Telegram): подпись проверена, принят сразу; поддельный и просроченный отклонены");

  const api = await handler(new Request("http://x/bot/api/order", {
    method: "POST", body: JSON.stringify({ initData: await initData({ id: C1, first_name: "Аня" }), order: { ...payload, id: "API1" } }),
  }));
  const apiRes = await api.json();
  assert(apiRes.ok && apiRes.code === "API1");
  const apiBad = await handler(new Request("http://x/bot/api/order", { method: "POST", body: JSON.stringify({ initData: "hash=x", order: payload }) }));
  assert(apiBad.status === 400);
  ok("прямой приём заказа с сайта (…/api/order): с подписью — принят, без — отказ");

  // --- 2. Ход заказа в боте → на сайте
  await d.send(owner, "/order W1W1");
  await d.click(owner, "Взять заказ");
  await d.click(owner, "Назначить цену");
  await d.send(owner, "3000");
  await d.send(owner, "5 дней");
  await d.click(c, "Согласен");
  await d.click(c, "Я оплатил");
  await d.photo(c, "receipt-photo");
  await d.click(me, "Оплата получена");
  await d.doc(c, "zadanie.pdf"); // файл клиента после заказа — к его последнему активному заказу (API1)
  let co = (await db.q("select * from cloud_orders where code = 'W1W1'"))[0];
  assert(co && co.status === "in_work" && co.price === 3000 && co.paid === 1500 && co.admin_name === "Пётр" && co.client_name === "Аня", JSON.stringify(co));
  assert(co.lines.length === 2 && co.client_token.length >= 24);
  const pays = await db.q("select * from cloud_payments where order_id = $1", [w.id]);
  assert(pays.length === 1 && pays[0].status === "confirmed" && pays[0].confirmed_by === "Вася" && pays[0].receipt_path === `receipts/W1W1/${pays[0].id}.jpg`);
  assert(tg.storage.has(`private/${pays[0].receipt_path}`));
  const cf = await db.q("select * from cloud_files where order_id = (select id from bot_orders where code = 'API1')");
  assert(cf.length === 1 && cf[0].bucket === "private" && cf[0].kind === "client" && tg.storage.has(`private/${cf[0].path}`));
  ok("бот → сайт: заказ, цена, оплата, чек и файл клиента выгружаются сразу после действия");

  // --- 3. Кабинет клиента (аноним по ключу) и права доступа
  const cab = (await asRole("anon", null, "select client_cabinet($1) c", [co.client_token]))[0].c;
  assert(cab.name === "Аня" && cab.orders.length === 2 && cab.payment_details.includes("2200"), JSON.stringify(cab).slice(0, 300));
  assert((await asRole("anon", null, "select client_cabinet($1) c", ["x".repeat(30)]))[0].c.orders.length === 0);
  assert((await asRole("anon", null, "select client_cabinet($1) c", ["short"]))[0].c === null);
  let denied = false;
  try {
    await asRole("anon", null, "select * from bot_orders");
  } catch {
    denied = true;
  }
  assert(denied, "посетители не видят таблицы бота");
  assert((await asRole("authenticated", "stranger@mail.ru", "select * from cloud_orders")).length === 0);
  await db.exec("insert into panel_admins(email) values('admin@mail.ru')");
  assert((await asRole("authenticated", "admin@mail.ru", "select * from cloud_orders")).length === 2);
  ok("кабинет: клиент видит свои заказы по ключу; таблицы бота закрыты; панель — только для админов из panel_admins");

  // --- 4. Действия админа на сайте
  const api1 = (await db.getOrderByCode("API1"))!;
  await asRole("authenticated", "admin@mail.ru",
    "insert into cloud_actions(order_id, action, payload) values($1, 'price', $2::text::jsonb), ($1, 'message', $3::text::jsonb), ($4, 'status', $5::text::jsonb)",
    [api1.id, JSON.stringify({ price: 2000, deadline: "3 дня" }), JSON.stringify({ text: "Привет <b>с сайта</b>" }), w.id, JSON.stringify({ status: "nonsense" })]);
  let stranger = false;
  try {
    await asRole("authenticated", "stranger@mail.ru", "insert into cloud_actions(order_id, action) values($1, 'status')", [w.id]);
  } catch {
    stranger = true;
  }
  assert(stranger, "чужой не может слать действия");
  await kick();
  const acts = await db.q("select action, state, result, created_by from cloud_actions order by id");
  assert(acts[0].state === "done" && acts[1].state === "done" && acts[2].state === "error" && acts[0].created_by === "admin@mail.ru", JSON.stringify(acts));
  const a1 = (await db.getOrder(api1.id))!;
  assert(a1.price === 2000 && a1.prepay === 1000 && tg.sentTo(C1).some((t) => t.includes("с сайта") && t.includes("&lt;b&gt;")));
  assert(tg.sentTo(OWNER).some((t) => t.includes("С сайта (admin@mail.ru)")));
  ok("админ-панель: цена и сообщение клиенту выполнены сразу (с экранированием), неверный статус — ошибка");

  // --- 5. Готовая работа из панели: остаток к доплате → после оплаты файл уходит клиенту
  tg.storage.set("results/abc123/referat.docx", { data: new TextEncoder().encode("docx"), type: "application/msword" });
  await asRole("authenticated", "admin@mail.ru",
    "insert into cloud_files(id, order_id, kind, name, bucket, path, source) values('site-1', $1, 'result', 'referat.docx', 'results', 'abc123/referat.docx', 'site')",
    [w.id]);
  await kick();
  let wo = (await db.getOrder(w.id))!;
  assert(wo.status === "awaiting_final" && tg.lastText(C1).includes("Осталось доплатить"));
  assert((await db.q("select delivered from cloud_files where id = 'site-1'"))[0].delivered === true);
  await d.click(c, "Я оплатил");
  await d.doc(c, "check.pdf");
  await d.click(owner, "Оплата получена");
  wo = (await db.getOrder(w.id))!;
  const sentDoc = tg.methods("sendDocument").filter((p) => p.chat_id === C1).pop()!;
  // Word-файл по ссылке Telegram не принимает — бот скачивает его из хранилища и загружает сам, под настоящим именем
  assert(wo.status === "review" && sentDoc.document?.upload === "referat.docx", JSON.stringify(sentDoc));
  co = (await db.q("select * from cloud_orders where code = 'W1W1'"))[0];
  const cab2 = (await asRole("anon", null, "select client_cabinet($1) c", [co.client_token]))[0].c;
  const wCab = cab2.orders.find((o: any) => o.code === "W1W1");
  assert(wCab.status === "review" && wCab.paid === 3000 && wCab.files.length === 1 && wCab.files[0].name === "referat.docx", JSON.stringify(wCab));
  ok("готовая работа из панели: запрос доплаты → оплата → файл клиенту в Telegram и в кабинете");

  // --- 6. Готовая работа из бота заменяет прошлую
  await d.send(owner, "/order W1W1");
  await d.click(owner, "Отправить готовую работу");
  await d.doc(owner, "referat_v2.docx", "application/msword");
  await d.click(owner, "Готово");
  const files = await db.q("select * from cloud_files where order_id = $1 and kind = 'result' and source = 'bot'", [w.id]);
  assert(files.length === 1 && files[0].bucket === "results" && /^[0-9a-f]{32}\/referat_v2\.docx$/.test(files[0].path) && tg.storage.has(`results/${files[0].path}`));
  assert(!(await db.q("select 1 from cloud_files where id = 'site-1'")).length, "прошлая версия работы убрана");
  ok("готовая работа из бота попадает на сайт по случайному адресу и заменяет прошлую");

  // --- 7. Реквизиты и кнопка кабинета
  await handler(new Request(`http://x/bot?cron=${(await sha256Hex(`cron:${TOKEN}`)).slice(0, 40)}`));
  assert((await db.q("select value from site_settings where key = 'payment_details'"))[0].value.includes("2200"));
  await d.send(c, "📦 Мои заказы");
  const url = tg.findButton(C1, "Кабинет на сайте")![1].web_app.url;
  assert(url === `https://ne-parsya.netlify.app/cabinet.html?t=${encodeURIComponent(co.client_token)}&bot=ne_parsya_bot`, url);
  ok("реквизиты на сайте; в «Мои заказы» — кнопка личного кабинета с ключом клиента");

  await tg.stop();
  console.log(`\n✅ Связь с сайтом: все проверки пройдены (${PASSED.length})`);
  await db.close();
  Deno.exit(0);
} catch (e) {
  console.error(e);
  console.log(`\n✗ ПРОВАЛ после ${PASSED.length} проверок`);
  Deno.exit(1);
}
