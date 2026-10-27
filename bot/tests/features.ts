// Новое: «отправить всё сразу» из панели, русские имена файлов, быстрая оплата (СБП, копирование),
// активный заказ на сайте, без выбора системы антиплагиата. Запуск: deno run -A tests/features.ts
Deno.env.set("NP_TEST", "1");
import { assert, Driver, FakeTelegram, ok, PASSED, PG, PORT, resetDb, TOKEN } from "./harness.ts";

const ME = 111, OWNER = 222, C1 = 501;
for (const [k, v] of Object.entries({
  BOT_TOKEN: TOKEN, ADMIN_IDS: `${ME},${OWNER}`, OWNER_ID: String(OWNER), WEBAPP_URL: "https://neparsya.github.io/ne-parsya/",
  PAYMENT_DETAILS: "", PAYMENT_PHONE: "+7 (999) 123-45-67", PAYMENT_BANK: "Т-Банк", PAYMENT_CARD: "2200 1234 5678 9010",
  PAYMENT_LINKS: "Т-Банк | https://www.tbank.ru/rm/test.user1/abc", PREPAYMENT_PERCENT: "100", SUPABASE_DB_URL: PG,
  TG_API_BASE: `http://127.0.0.1:${PORT}`, SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_SERVICE_ROLE_KEY: "k",
  FUNCTION_URL: "https://proj.supabase.co/functions/v1/bot",
})) Deno.env.set(k, v);

const { handler } = await import("../src/index.ts");
const db = await import("../src/db.ts");
const { FLOOD } = await import("../src/router.ts");
const { safeName } = await import("../src/cloud.ts");
const { sha256Hex } = await import("../src/util.ts");
FLOOD.limit = 1e9;

async function hmac(key: Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
async function initData(user: Record<string, unknown>) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  p.set("hash", [...await hmac(await hmac(new TextEncoder().encode("WebAppData"), TOKEN), check)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  return p.toString();
}

try {
  await resetDb();
  const tg = new FakeTelegram();
  tg.start();
  const d = new Driver(tg, handler);
  await d.init();
  const setup = await (await handler(new Request("https://proj.supabase.co/functions/v1/bot?setup=1"))).text();
  assert(setup.includes("Отклик базы"), setup);
  ok("?setup=1 показывает отклик базы");
  const owner = d.user(OWNER, "Пётр"), c = d.user(C1, "Аня");
  await d.send(d.user(ME, "Вася"), "/start");
  await d.send(owner, "/start");
  await d.send(c, "/start");
  const kick = async () => assert((await handler(new Request(`http://x/bot?kick=${(await sha256Hex(`kick:${TOKEN}`)).slice(0, 40)}`))).status === 200);

  // --- без выбора системы антиплагиата
  await d.send(c, "📝 Оформить заказ");
  await d.click(c, "Реферат");
  await d.send(c, "История");
  await d.click(c, "Тему подберёт");
  await d.click(c, "Пропустить");
  await d.click(c, "10");
  await d.click(c, "Неделя");
  await d.click(c, "70%");
  assert(!tg.lastText(C1).includes("системе") && tg.lastText(C1).includes("процент ИИ"), tg.lastText(C1));
  await d.click(c, "до 10%");
  assert(tg.lastText(C1).includes("Оформление"), tg.lastText(C1));
  ok("анкета: после оригинальности — процент ИИ, затем оформление; систему антиплагиата не спрашивает");
  await d.send(c, "📦 Мои заказы"); // бросаем анкету

  // --- активный заказ на сайте (по подписи Telegram)
  await d.webapp(c, { kind: "np_order", id: "K1K1", type: "essay", lines: [["📝", "Работа", "Эссе"]] });
  const o = (await db.getOrderByCode("K1K1"))!;
  let my = await (await handler(new Request("http://x/bot/api/my", { method: "POST", body: JSON.stringify({ initData: await initData({ id: C1, first_name: "Аня" }) }) }))).json();
  assert(my.ok && my.orders.length === 1 && my.orders[0].code === "K1K1" && my.orders[0].status_label.includes("Новый"), JSON.stringify(my));
  assert(String(my.cabinet).startsWith("https://neparsya.github.io/ne-parsya/cabinet.html?t="));
  const bad = await handler(new Request("http://x/bot/api/my", { method: "POST", body: JSON.stringify({ initData: "user=%7B%22id%22%3A501%7D&hash=00" }) }));
  assert(bad.status === 403);
  ok("сайт в Telegram получает активные заказы клиента и ссылку на кабинет; без подписи — отказ");

  // --- «отправить всё сразу»: цена + срок + сообщение одним экраном
  const ins = (row: Record<string, unknown>) => db.exec(
    "insert into cloud_actions(order_id, action, payload, created_by) values($1, 'bundle', $2::text::jsonb, 'admin@mail.ru')",
    [o.id, JSON.stringify(row)]);
  await ins({ price: 2500, deadline: "3 дня", text: "Сделаю аккуратно <b>!</b>" });
  await kick();
  let vis = tg.visible(C1);
  assert(vis.length === 1 && vis[0].includes("Сделаю аккуратно &lt;b&gt;") && vis[0].includes("2 500 ₽") && vis[0].includes("3 дня"), JSON.stringify(vis));
  assert(tg.findButton(C1, "Согласен"), "в том же сообщении кнопки предложения");
  let act = (await db.q("select state, result from cloud_actions order by id desc limit 1"))[0];
  assert(act.state === "done", JSON.stringify(act));
  assert(tg.sentTo(OWNER).at(-1)!.includes("цена 2500 ₽, срок 3 дня") && tg.sentTo(OWNER).at(-1)!.includes("сообщение"));
  ok("«Отправить всё сразу»: сообщение, цена и срок приходят клиенту одним экраном с кнопками");

  // --- оплата: номер для СБП и карта в тексте, кнопки «Скопировать» только для карты и номера заказа
  await d.click(c, "Согласен");
  const pay = tg.lastText(C1);
  assert(pay.includes("<code>+79991234567</code>") && pay.includes("Банк получателя: <b>Т-Банк</b>") && pay.includes("<code>2200 1234 5678 9010</code>"), pay);
  assert(!pay.includes("Как оплатить"), pay);
  const msg = [...tg.msgs.values()].filter((m) => m.chat === C1 && !m.deleted).pop()!;
  const buttons = msg.markup!.inline_keyboard.flat();
  assert(!buttons.some((b: any) => b.url), "нет кнопок банков");
  assert(!buttons.some((b: any) => b.copy_text?.text === "+79991234567" || b.copy_text?.text === "2500"), "нет кнопок СБП и суммы");
  assert(buttons.some((b: any) => b.copy_text?.text === "2200123456789010") && buttons.some((b: any) => b.copy_text?.text === "K1K1"));
  ok("оплата: номер и банк получателя в тексте, кнопки только «Номер карты» и «Номер заказа»");

  await handler(new Request(`http://x/bot?cron=${(await sha256Hex(`cron:${TOKEN}`)).slice(0, 40)}`));
  const extra = JSON.parse((await db.q("select value from site_settings where key = 'payment_extra'"))[0].value);
  assert(extra.phone === "+79991234567" && extra.links[0].url.includes("tbank.ru"));
  const token = (await db.q("select client_token from cloud_orders where id = $1", [o.id]))[0].client_token;
  const cab = (await db.q("select client_cabinet($1) c", [token]))[0].c;
  assert(cab.payment_extra && JSON.parse(cab.payment_extra).card === "2200 1234 5678 9010" && cab.payment_details.includes("СБП"));
  ok("кабинет на сайте получает номер для СБП, карту и ссылки банков");

  // --- оплачен → «всё сразу» с готовой работой (русское имя файла) и статусом
  await d.click(c, "Я оплатил");
  await d.photo(c, "receipt");
  await d.click(owner, "Оплата получена");
  assert(safeName("Курсовая работа Иванов.docx") === "Kursovaya_rabota_Ivanov.docx", safeName("Курсовая работа Иванов.docx"));
  tg.storage.set("results/x1/Esse_Anna.docx", { data: new TextEncoder().encode("docx"), type: "application/msword" });
  await db.exec(`insert into cloud_files(id, order_id, kind, name, bucket, path, source, batch)
                 values('f-1', $1, 'result', 'Эссе Анна.docx', 'results', 'x1/Esse_Anna.docx', 'site', 'B1')`, [o.id]);
  await kick(); // файл из «всё сразу» сам по себе не уходит — ждёт своё действие
  assert((await db.q("select delivered from cloud_files where id = 'f-1'"))[0].delivered === false);
  await ins({ status: "in_work", text: "Готово, проверяйте", batch: "B1" });
  await kick();
  const fresh = (await db.getOrder(o.id))!;
  vis = tg.visible(C1);
  const doc = tg.methods("sendDocument").filter((p) => p.chat_id === C1).pop()!;
  // Клиент получает файл под настоящим (русским) именем — бот загружает его в Telegram сам
  assert(fresh.status === "review" && doc.document?.upload === "Эссе Анна.docx", `${fresh.status} ${JSON.stringify(doc?.document)}`);
  const f1 = (await db.q("select file_id from bot_files where cloud_id = 'f-1'"))[0];
  assert(f1.file_id === "tg_Эссе Анна.docx", "повторно файл уходит по идентификатору Telegram, без скачивания");
  assert(vis.length === 2 && vis[1].includes("Готово, проверяйте") && vis[1].includes("готова") && tg.findButton(C1, "Работа принята"), JSON.stringify(vis));
  ok("«всё сразу» с файлом: работа (имя файла латиницей) и сообщение — одним экраном, статус «На проверке»");

  await ins({});
  await kick();
  act = (await db.q("select state, result from cloud_actions order by id desc limit 1"))[0];
  assert(act.state === "error" && act.result.includes("нечего отправлять"));
  ok("пустая форма — понятная ошибка в панели");

  // --- файл из Telegram с русским именем выгружается на сайт
  await d.send(owner, "/order K1K1");
  await d.click(owner, "Отправить готовую работу");
  await d.doc(owner, "Итоговая версия.docx", "application/msword");
  await d.click(owner, "Готово");
  const cf = (await db.q("select path from cloud_files where order_id = $1 and source = 'bot'", [o.id]))[0];
  assert(/^[0-9a-f]{32}\/Itogovaya_versiya\.docx$/.test(cf.path) && tg.storage.has(`results/${cf.path}`), cf?.path);
  ok("файл из Telegram с русским именем попадает на сайт (адрес латиницей — без «Invalid key»)");

  await tg.stop();
  console.log(`\n✅ Новые функции: все проверки пройдены (${PASSED.length})`);
  await db.close();
  Deno.exit(0);
} catch (e) {
  console.error(e);
  console.log(`\n✗ ПРОВАЛ после ${PASSED.length} проверок`);
  Deno.exit(1);
}
