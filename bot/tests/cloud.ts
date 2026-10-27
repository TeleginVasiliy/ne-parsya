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
  // (копия уже ушла админам при загрузке, поэтому клиенту — по готовому идентификатору Telegram)
  const adminCopy = tg.methods("sendDocument").find((p) => p.chat_id === OWNER && p.document?.upload === "referat.docx");
  assert(adminCopy && /Отправлено клиенту/.test(adminCopy.caption ?? ""), "админ видит, какой файл ушёл");
  assert(wo.status === "review" && sentDoc.document === "tg_referat.docx", JSON.stringify(sentDoc));
  co = (await db.q("select * from cloud_orders where code = 'W1W1'"))[0];
  const cab2 = (await asRole("anon", null, "select client_cabinet($1) c", [co.client_token]))[0].c;
  const wCab = cab2.orders.find((o: any) => o.code === "W1W1");
  assert(wCab.status === "review" && wCab.paid === 3000 && wCab.files.length === 1 && wCab.files[0].name === "referat.docx", JSON.stringify(wCab));
  ok("готовая работа из панели: запрос доплаты → оплата → файл клиенту в Telegram и в кабинете");

  // --- 6. Новая версия работы из бота добавляется к прошлой (ничего не пропадает)
  await d.send(owner, "/order W1W1");
  await d.click(owner, "Отправить готовую работу");
  await d.doc(owner, "referat_v2.docx", "application/msword");
  await d.click(owner, "Готово");
  const files = await db.q("select * from cloud_files where order_id = $1 and kind = 'result' and source = 'bot'", [w.id]);
  assert(files.length === 1 && files[0].bucket === "results" && /^[0-9a-f]{32}\/referat_v2\.docx$/.test(files[0].path) && tg.storage.has(`results/${files[0].path}`));
  assert((await db.q("select 1 from cloud_files where id = 'site-1'")).length === 1, "прошлая версия работы осталась");
  await d.send(c, "📦 Мои заказы");
  await d.click(c, "#W1W1");
  await d.click(c, "Получить готовую работу");
  const got = tg.methods("sendDocument").filter((p) => p.chat_id === C1).slice(-2).map((p) => p.document);
  assert(JSON.stringify(got) === '["tg_referat.docx","file_referat_v2.docx"]', JSON.stringify(got));
  const chat = await asRole("authenticated", "admin@mail.ru", "select author, name, text, files from cloud_messages where order_id = $1 order by id", [w.id]);
  assert(chat.length === 2 && chat.every((m: any) => m.author === "admin" && m.files.length === 1), JSON.stringify(chat));
  assert(chat[0].files[0].id === "site-1" && chat[1].files[0].id === files[0].id, JSON.stringify(chat));
  ok("готовая работа из бота попадает на сайт по случайному адресу и добавляется к прошлой; в «Мои заказы» — все файлы");

  // --- 7. Реквизиты и кнопка кабинета
  await handler(new Request(`http://x/bot?cron=${(await sha256Hex(`cron:${TOKEN}`)).slice(0, 40)}`));
  assert((await db.q("select value from site_settings where key = 'payment_details'"))[0].value.includes("2200"));
  await d.send(c, "📦 Мои заказы");
  const url = tg.findButton(C1, "Кабинет на сайте")![1].web_app.url;
  assert(url === `https://ne-parsya.netlify.app/cabinet.html?t=${encodeURIComponent(co.client_token)}&bot=ne_parsya_bot`, url);
  ok("реквизиты на сайте; в «Мои заказы» — кнопка личного кабинета с ключом клиента");

  // --- 8. Отзывы только через бота, заказы вручную, удаление заказа из панели
  const refused = async (role: string, email: string | null, sql: string, params: unknown[] = []) => {
    try {
      await asRole(role, email, sql, params);
      return false;
    } catch {
      return true;
    }
  };
  assert(await refused("anon", null, "insert into reviews(name, message, rating) values('Спам', 'Лучший сервис!!!', 5)"), "аноним не пишет отзывы");
  await asRole("authenticated", "admin@mail.ru", "insert into manual_orders(client_name, amount) values('Олег', 3000)");
  assert(await refused("authenticated", "stranger@mail.ru", "insert into manual_orders(client_name, amount) values('x', 1)"));
  assert((await asRole("authenticated", "stranger@mail.ru", "select * from manual_orders")).length === 0);
  const mo = await asRole("authenticated", "admin@mail.ru", "select * from manual_orders");
  assert(mo.length === 1 && mo[0].amount === 3000 && mo[0].created_by === "admin@mail.ru", JSON.stringify(mo));
  assert(await refused("authenticated", "admin@mail.ru", "insert into manual_orders(client_name, amount) values('Олег', 0)"), "сумма > 0");
  await asRole("authenticated", "admin@mail.ru", "delete from manual_orders where id = $1", [mo[0].id]);
  assert((await db.q("select * from manual_orders")).length === 0);

  const del = (await db.getOrderByCode("API1"))!;
  await asRole("authenticated", "admin@mail.ru", "insert into cloud_actions(order_id, action) values($1, 'delete')", [del.id]);
  await kick();
  const delAct = (await db.q("select state, result from cloud_actions where action = 'delete'"))[0];
  assert(delAct.state === "done", JSON.stringify(delAct));
  assert(!await db.getOrder(del.id) && (await db.q("select 1 from cloud_orders where id = $1", [del.id])).length === 0);
  assert((await db.q("select 1 from bot_payments where order_id = $1", [del.id])).length === 0);
  assert(tg.sentTo(OWNER).some((t) => t.includes("заказ удалён")));
  ok("сайт: отзывы пишет только бот; заказы вручную — только админам; «Удалить» убирает заказ отовсюду");

  // --- 9. Отзыв без текста тоже на сайте; «Удалить» в панели убирает отзыв и с сайта, и из бота
  const rvOrder = (await db.q("select * from bot_orders order by id limit 1"))[0];
  await db.exec("insert into bot_reviews(order_id, user_id, rating, published) values($1, $2, 4, true)", [rvOrder.id, rvOrder.user_id]);
  await (await import("../src/cloud.ts")).pushChanged();
  const onSite = await asRole("anon", null, "select * from reviews where order_code = $1", [rvOrder.code]);
  assert(onSite.length === 1 && onSite[0].message === "" && onSite[0].rating === 4 && onSite[0].work, JSON.stringify(onSite));
  await asRole("authenticated", "admin@mail.ru", "insert into cloud_actions(order_id, action) values($1, 'review_delete')", [rvOrder.id]);
  await kick();
  assert((await db.q("select state from cloud_actions where action = 'review_delete'"))[0].state === "done");
  assert((await db.q("select 1 from bot_reviews where order_id = $1", [rvOrder.id])).length === 0);
  assert((await db.q("select 1 from reviews where order_code = $1", [rvOrder.code])).length === 0);
  await (await import("../src/cloud.ts")).pushChanged();
  assert((await db.q("select 1 from reviews where order_code = $1", [rvOrder.code])).length === 0, "удалённый не возвращается");
  ok("отзыв-оценка без текста виден на сайте; «Удалить» в панели убирает отзыв и с сайта, и из бота");

  // --- 10. Методичка с сайта, «Прикрепить файл», переписка в панели, реквизиты в напоминании
  // Посетитель может только загрузить файл в site-uploads; чужие файлы не видит
  await asRole("anon", null, "insert into storage.objects(bucket_id, name) values('private', 'site-uploads/a1b2c3d4e5f6/metodichka.pdf')");
  assert(await refused("anon", null, "insert into storage.objects(bucket_id, name) values('private', 'receipts/X/1.jpg')"), "только site-uploads");
  assert((await asRole("anon", null, "select * from storage.objects")).length === 0, "аноним не видит файлы");
  tg.storage.set("private/site-uploads/a1b2c3d4e5f6/metodichka.pdf", { data: new TextEncoder().encode("pdf"), type: "application/pdf" });
  const withFile = { kind: "np_order", id: "MF01", type: "coursework", lines: [["📝", "Работа", "Курсовая работа"], ["📎", "Методичка", "прикреплена: Методичка.pdf"]],
    files: [{ path: "site-uploads/a1b2c3d4e5f6/metodichka.pdf", name: "Методичка.pdf", size: 3 }, { path: "receipts/X/1.jpg", name: "чужой" }] };
  await asRole("anon", null, "insert into incoming_orders(init_data, payload) values($1, $2::text::jsonb)",
    [await initData({ id: C1, first_name: "Аня" }), JSON.stringify(withFile)]);
  await kick();
  const mf = (await db.getOrderByCode("MF01"))!;
  const mfFiles = await db.getFiles(mf.id, "client");
  assert(mfFiles.length === 1 && mfFiles[0].file_name === "Методичка.pdf", JSON.stringify(mfFiles)); // чужой путь отброшен
  assert(tg.lastText(C1).includes("Файлы с сайта (1 шт.)") && tg.findButton(C1, "Прикрепить файл"), tg.lastText(C1));
  // бот скачал закрытый файл со своим ключом и отправил админам
  assert(tg.methods("sendDocument").some((p) => [ME, OWNER].includes(p.chat_id) && p.document?.upload === "Методичка.pdf"));
  assert(tg.methods("sendDocument").filter((p) => p.chat_id === OWNER).pop()!.document?.includes?.("Методичка"));
  const mfCloud = await asRole("authenticated", "admin@mail.ru", "select * from cloud_files where order_id = $1", [mf.id]);
  assert(mfCloud.length === 1 && mfCloud[0].kind === "client" && mfCloud[0].bucket === "private", JSON.stringify(mfCloud));
  ok("методичка с сайта: загрузка только в свою папку, файл прикреплён к заказу и пришёл админам");

  await d.click(c, "Прикрепить файл");
  assert(tg.lastText(C1).includes("Пришлите файлы к заказу"));
  await d.doc(c, "zadanie.docx", "application/msword");
  await d.doc(c, "primer.pdf");
  assert(tg.lastText(C1).includes("файлов: 2") && tg.findButton(C1, "Готово"), tg.lastText(C1));
  await d.send(c, "И ещё: нужен список из 20 источников");
  assert((await db.getFiles(mf.id, "client")).length === 3);
  assert(tg.sentTo(OWNER).some((t) => t.includes("20 источников")));
  await d.click(c, "Готово");
  assert(tg.lastText(C1).includes("Заказ #MF01"));
  // Сообщение из панели — тоже в переписке
  await asRole("authenticated", "admin@mail.ru", "insert into cloud_actions(order_id, action, payload) values($1, 'message', $2::text::jsonb)",
    [mf.id, JSON.stringify({ text: "Получил, спасибо!" })]);
  await kick();
  await (await import("../src/cloud.ts")).pushChanged();
  const log = await asRole("authenticated", "admin@mail.ru", "select author, name, text, files from cloud_messages where order_id = $1 order by id", [mf.id]);
  assert(log.length === 4 && log[0].author === "client" && log[0].files[0].name === "zadanie.docx" && log[2].text.includes("20 источников") &&
    log[3].author === "admin" && log[3].name === "admin@mail.ru" && log[3].text === "Получил, спасибо!", JSON.stringify(log));
  const clientFile = await asRole("authenticated", "admin@mail.ru", "select * from cloud_files where id = $1", [log[0].files[0].id]);
  assert(clientFile.length === 1, "файл из переписки есть на сайте");
  assert((await asRole("authenticated", "stranger@mail.ru", "select * from cloud_messages")).length === 0, "переписку видят только админы");
  ok("«📎 Прикрепить файл» в любой момент; переписка (клиент, админ, файлы) видна в админ-панели");

  // Напоминание об оплате — сразу с реквизитами; кнопка «Оплатить» есть и под другими сообщениями
  await asRole("authenticated", "admin@mail.ru", "insert into cloud_actions(order_id, action, payload) values($1, 'price', $2::text::jsonb)",
    [mf.id, JSON.stringify({ price: 5000, deadline: "неделя" })]);
  await kick();
  await d.click(c, "Согласен");
  await asRole("authenticated", "admin@mail.ru", "insert into cloud_actions(order_id, action, payload) values($1, 'message', $2::text::jsonb)",
    [mf.id, JSON.stringify({ text: "Жду оплату" })]);
  await kick();
  assert(tg.lastText(C1).includes("Жду оплату") && tg.findButton(C1, "💳 Оплатить"), tg.lastText(C1));
  await db.exec("update bot_orders set status_changed_at = now() - interval '25 hours' where id = $1", [mf.id]);
  await (await import("../src/jobs.ts")).runReminders((await import("../src/config.ts")).loadConfig());
  const remind = tg.lastText(C1);
  assert(remind.includes("Напоминаю") && remind.includes("2200") && remind.includes("<code>MF01</code>") && tg.findButton(C1, "Я оплатил"), remind);
  ok("напоминание об оплате — с реквизитами; «💳 Оплатить» под любым сообщением, пока заказ не оплачен");

  await tg.stop();
  console.log(`\n✅ Связь с сайтом: все проверки пройдены (${PASSED.length})`);
  await db.close();
  Deno.exit(0);
} catch (e) {
  console.error(e);
  console.log(`\n✗ ПРОВАЛ после ${PASSED.length} проверок`);
  Deno.exit(1);
}
