// Сквозные сценарии облачного бота: настоящая база Postgres + имитация Telegram.
// Запуск: deno run -A tests/scenarios.ts [a|b|c|all]
Deno.env.set("NP_TEST", "1");
import { assert, contains, Driver, FakeTelegram, ok, PASSED, PG, PORT, resetDb, TOKEN } from "./harness.ts";

const ME = 111, OWNER = 222, C1 = 501, C2 = 502, C3 = 503;

function env(over: Record<string, string> = {}) {
  const base: Record<string, string> = {
    BOT_TOKEN: TOKEN, ADMIN_IDS: `${ME},${OWNER}`, OWNER_ID: String(OWNER), WEBAPP_URL: "",
    PAYMENT_DETAILS: "💳 Карта: <code>2200 1234 5678 9010</code>\\n🏦 Банк: Тест", PREPAYMENT_PERCENT: "100",
    SUPABASE_DB_URL: PG, TG_API_BASE: `http://127.0.0.1:${PORT}`, SUPABASE_URL: `http://127.0.0.1:${PORT}`,
    SUPABASE_SERVICE_ROLE_KEY: "service-key", FUNCTION_URL: "https://proj.supabase.co/functions/v1/bot",
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) Deno.env.set(k, v);
}

const { handler } = await import("../src/index.ts");
const db = await import("../src/db.ts");
const { FLOOD } = await import("../src/router.ts");
const { runReminders } = await import("../src/jobs.ts");
const { splitText } = await import("../src/util.ts");

async function build(over: Record<string, string> = {}) {
  await db.close();
  await resetDb();
  env(over);
  const tg = new FakeTelegram();
  tg.start();
  const d = new Driver(tg, handler);
  await d.init();
  FLOOD.limit = 1e9; // тест жмёт быстрее человека; антифлуд проверяется отдельно
  const res = await handler(new Request("https://proj.supabase.co/functions/v1/bot?setup=1"));
  const report = await res.text();
  assert(report.includes("подключён"), report);
  const me = d.user(ME, "Вася", "vasya"), owner = d.user(OWNER, "Пётр", "boss");
  if (over.OWNER_ID !== "") {
    await d.send(me, "/start");
    await d.send(owner, "/start");
  }
  return { tg, d, me, owner, report };
}

const order = async (code: string) => (await db.getOrderByCode(code))!;

async function fillCoursework(d: Driver, tg: FakeTelegram, c: { id: number; first_name: string }) {
  await d.send(c, "📝 Оформить заказ");
  assert(tg.lastText(c.id).includes("Шаг 1/11"), tg.lastText(c.id));
  await d.click(c, "Курсовая работа");
  assert(tg.lastText(c.id).includes("Шаг 2/11"), tg.lastText(c.id) + JSON.stringify(tg.calls.slice(-4)));
  await d.send(c, "Экономика предприятия");
  await d.send(c, "Анализ финансовой устойчивости <ООО> & партнёры");
  await d.send(c, "РЭУ");
  await d.click(c, "3");
  await d.click(c, "30");
  await d.click(c, "Ввести дату");
  await d.send(c, "01.01.2020");
  assert(tg.lastText(c.id).includes("прошла"));
  await d.send(c, "32.13.2026");
  assert(tg.lastText(c.id).includes("Не получилось"));
  const f = new Date(Date.now() + 10 * 864e5);
  await d.send(c, `${String(f.getDate()).padStart(2, "0")}.${String(f.getMonth() + 1).padStart(2, "0")}.${f.getFullYear()}`);
  await d.click(c, "70%");
  assert(tg.lastText(c.id).includes("Шаг 8/11"), tg.lastText(c.id));
  await d.click(c, "ГОСТ");
  await d.click(c, "Times New Roman");
  await d.click(c, "14");
  await d.click(c, "1.5");
  await d.click(c, "Титульный лист");
  await d.click(c, "Список литературы");
  assert(String(tg.findButton(c.id, "Титульный")![1].text).includes("✅ Титульный лист"));
  await d.click(c, "Готово");
  await d.click(c, "Речь для защиты");
  await d.click(c, "Готово");
  await d.send(c, "просто текст на шаге файлов");
  assert(tg.lastText(c.id).includes("Пришлите файл"));
  await d.doc(c, "metodichka.pdf");
  await d.photo(c, "task_photo");
  assert(tg.lastText(c.id).includes("Файлов получено: <b>2</b>"), tg.lastText(c.id));
  await d.click(c, "Готово");
  await d.send(c, "Нужен акцент на практической части");
  const summary = tg.lastText(c.id);
  assert(summary.includes("Проверьте заказ") && summary.includes("&lt;ООО&gt; &amp;"), summary);
}

async function scenarioMain() {
  console.log("\n▶ Основные сценарии (предоплата 100%)");
  const { tg, d, me, owner, report } = await build();
  assert(report.includes("Расписание не включилось"), "локально pg_cron нет — бот должен честно об этом сказать");
  const hook = tg.methods("setWebhook").pop()!;
  assert(hook.url === "https://proj.supabase.co/functions/v1/bot" && hook.secret_token?.length === 40);
  assert((await db.getSetting("kick_url"))!.startsWith("https://proj.supabase.co/functions/v1/bot?kick="));
  const forged = await handler(new Request("http://x/bot", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "bad" }, body: "{}" }));
  assert(forged.status === 403);
  ok("?setup=1: вебхук с секретом, адрес для «пинка» с сайта; чужие запросы без секрета отклоняются");

  const c1 = d.user(C1, "Аня", "anya");
  assert(tg.methods("setChatMenuButton").some((m) => m.menu_button.type === "commands"));
  await d.send(c1, "/start");
  assert(contains(tg.sentTo(C1), "Оформите заказ прямо здесь") && !tg.findButton(C1, "Открыть сайт"));
  const menu = [...tg.msgs.values()].filter((m) => m.chat === C1 && m.text === "Главное меню 👇").pop()!.markup!;
  assert(menu.keyboard.flat().every((b: any) => !b.web_app));
  assert(contains(tg.sentTo(OWNER), "ссылка на сайт пока не задана") && !contains(tg.sentTo(C1), "Для владельца"));
  ok("/start с пустой ссылкой: кнопок сайта нет, владельцу — напоминание");

  const cmds = tg.methods("setMyCommands");
  const def = cmds.filter((c) => c.scope.type === "default").pop()!;
  const ownerCmds = cmds.filter((c) => c.scope.chat_id === OWNER).pop()!, meCmds = cmds.filter((c) => c.scope.chat_id === ME).pop()!;
  const names = (c: any) => c.commands.map((x: any) => x.command);
  assert(!names(def).includes("orders") && names(ownerCmds).includes("stats") && !names(meCmds).includes("stats") && names(meCmds).includes("orders"));
  ok("команды: клиенты не видят админских, только владелец видит /stats");

  await d.send(me, "/setsite https://ne-parsya.netlify.app");
  assert(tg.lastText(ME).includes("только владельцу"));
  await d.send(owner, "/setsite http://ne-parsya.netlify.app");
  assert(tg.lastText(OWNER).includes("https://") && (await db.getSetting("webapp_url")) === null);
  await d.send(owner, "/setsite https://app.netlify.com/teams/abc/overview");
  assert(tg.lastText(OWNER).includes("страницу входа"));
  await d.send(owner, "/setsite https://app.netlify.com/projects/leafy-pegasus-a7fd49/overview");
  assert((await db.getSetting("webapp_url")) === "https://leafy-pegasus-a7fd49.netlify.app", "ссылка из панели Netlify → адрес сайта");
  await d.send(owner, "/setsite https://ne-parsya.netlify.app");
  assert(tg.sentTo(OWNER).at(-2)!.includes("Ссылка обновлена"));
  let mb = tg.methods("setChatMenuButton").pop()!.menu_button;
  assert(mb.type === "web_app" && mb.web_app.url === "https://ne-parsya.netlify.app?from=menu&bot=ne_parsya_bot" && mb.text === "🌐 Сайт (предпочтительно)", JSON.stringify(mb));
  ok("/setsite: http и страница входа отклонены, https сохранён, кнопка меню обновлена");

  await d.send(owner, "/setsite");
  await d.click(owner, "Изменить");
  await d.send(owner, "не ссылка");
  assert(tg.lastText(OWNER).includes("https://"));
  await d.send(owner, "https://new-site.example.com/path?x=1");
  assert((await db.getSetting("webapp_url")) === "https://new-site.example.com/path?x=1");
  mb = tg.methods("setChatMenuButton").pop()!.menu_button;
  assert(mb.web_app.url === "https://new-site.example.com/path?x=1&from=menu&bot=ne_parsya_bot", mb.web_app.url);
  await d.send(owner, "/setsite");
  await d.click(owner, "Убрать ссылку");
  assert((await db.getSetting("webapp_url")) === "" && tg.methods("setChatMenuButton").pop()!.menu_button.type === "commands");
  await d.send(owner, "/setsite https://ne-parsya.netlify.app");
  ok("/setsite → «Изменить» (параметры ссылки сохраняются) → «Убрать ссылку»");

  await d.send(c1, "/start site");
  assert(tg.sentTo(C1).slice(-2).some((t) => t.includes("с сайта")));
  assert(tg.findButton(C1, "Открыть сайт и собрать заказ")![1].web_app.url === "https://ne-parsya.netlify.app?from=inline&bot=ne_parsya_bot");
  const menu2 = [...tg.msgs.values()].filter((m) => m.chat === C1 && m.text === "Главное меню 👇").pop()!.markup!;
  assert(menu2.keyboard[0][0].web_app.url === "https://ne-parsya.netlify.app?from=kb&bot=ne_parsya_bot");
  assert((await db.getUser(C1))!.source === "bot");
  const c2 = d.user(C2, "Борис");
  await d.send(c2, "/start site");
  assert((await db.getUser(C2))!.source === "site");
  ok("/start со ссылкой: web_app-кнопки (inline/menu/kb), deep link site → источник «site»");

  // --- курсовая в боте
  await fillCoursework(d, tg, c1);
  await d.click(c1, "Изменить");
  await d.click(c1, "Срок");
  await d.click(c1, "Не горит");
  assert(tg.lastText(C1).includes("не горит"));
  const [sendMid, sendBtn] = tg.findButton(C1, "Отправить")!;
  await d.click(c1, "Отправить");
  let o = (await db.userOrders(C1))[0];
  assert(contains(tg.sentTo(C1), `Заказ #${o.code} принят`) && o.source === "bot");
  assert((await db.getFiles(o.id, "client")).length === 2);
  const lines = Object.fromEntries(o.data.lines.map(([, l, v]: string[]) => [l, v]));
  assert(lines["Оформление"] === "ГОСТ, Times New Roman 14, интервал 1.5", JSON.stringify(lines));
  assert(lines["Нужно"] === "титульный лист, список литературы" && lines["Срок"] === "не горит");
  for (const admin of [ME, OWNER]) {
    const files = tg.calls.filter((c) => ["sendDocument", "sendPhoto"].includes(c.method) && c.p.chat_id === admin);
    assert(contains(tg.sentTo(admin), `Новый заказ #${o.code}`) && files.length === 2, `${admin}: ${files.length}`);
  }
  ok(`курсовая: 11 шагов, валидация даты, мультивыбор, файлы, правка шага → #${o.code} у обоих админов с файлами`);

  await d.press(c1, sendMid, sendBtn.callback_data);
  assert((await db.userOrders(C1)).length === 1 && tg.answers.at(-1)!.includes("устарела"));
  ok("двойное «Отправить» — второй заказ не создаётся");

  const [oMid, oBtn] = tg.findButton(OWNER, "Взять заказ")!;
  await d.click(me, "Взять заказ");
  await d.press(owner, oMid, oBtn.callback_data);
  o = (await db.getOrder(o.id))!;
  assert(o.admin_id === ME && tg.answers.some((a) => a.includes("уже взял")));
  const ownerCard = [...tg.msgs.values()].find((m) => m.chat === OWNER && m.text?.includes(`Заказ #${o.code}`))!;
  assert(ownerCard.text!.includes("Ответственный: Вася"), ownerCard.text!);
  ok("«Взять заказ»: закрепился за первым, второму — «уже взял», карточки обновлены");

  await d.send(c1, "Можно добавить ещё один раздел?");
  assert(tg.lastText(ME).includes("Можно добавить ещё один раздел?") && tg.lastText(ME).includes(`заказ #${o.code}`));
  assert(tg.lastText(OWNER).includes("Можно добавить"));
  const relayMid = Math.max(...[...tg.msgs.values()].filter((m) => m.chat === ME && m.bot).map((m) => m.id));
  await d.reply(me, "Да, конечно <b>!</b>", relayMid);
  assert(tg.lastText(C1).includes("Исполнитель") && tg.lastText(C1).includes("&lt;b&gt;"));
  await d.send(me, "просто текст без реплая");
  assert(tg.lastText(ME).includes("реплаем"));
  ok("переписка: клиент → ответственный + копия владельцу; ответ реплаем → клиенту (с экранированием)");

  // --- цена
  await d.click(me, "Назначить цену");
  await d.send(me, "сколько-то");
  assert(tg.lastText(ME).includes("целое число"));
  await d.send(me, "4 500 ₽");
  await d.send(me, "к 30.10");
  const offer = tg.lastText(C1);
  assert(offer.includes("4 500 ₽") && offer.includes("к 30.10") && offer.includes("К оплате: <b>4 500 ₽</b>"), offer);
  await d.click(c1, "Обсудить");
  assert(contains(tg.sentTo(ME), "хочет обсудить"));
  await d.send(c1, "А можно за 4000?");
  assert(tg.lastText(ME).includes("А можно за 4000?") && tg.visible(C1).length === 1);
  await d.click(c1, "Открыть заказ");
  await d.click(c1, "Согласен");
  o = (await db.getOrder(o.id))!;
  const pay = tg.lastText(C1);
  assert(o.status === "awaiting_payment" && pay.includes("<code>2200 1234 5678 9010</code>") && pay.includes(`<code>${o.code}</code>`), pay);
  ok("цена: валидация, предложение, «Обсудить», «Согласен» → реквизиты в <code>, номер заказа");

  // --- чек
  await d.click(c1, "Я оплатил");
  await d.send(c1, "я перевёл");
  assert(tg.lastText(C1).includes("скриншот"));
  await d.photo(c1, "receipt1");
  assert(tg.lastText(C1).includes("Чек получен") && contains(tg.sentTo(ME), "Чек по заказу") && contains(tg.sentTo(OWNER), "Чек по заказу"));
  const [mMid, mBtn] = tg.findButton(ME, "Оплата получена")!;
  await d.click(owner, "Оплата не найдена");
  assert(tg.lastText(C1).includes("Не нашли оплату"));
  await d.press(me, mMid, mBtn.callback_data);
  assert(tg.answers.some((a) => a.includes("уже обработан")));
  await d.click(c1, "Прислать чек ещё раз");
  await d.doc(c1, "check.pdf");
  const [wMid, wBtn] = tg.findButton(OWNER, "Оплата получена")!;
  await d.click(me, "Оплата получена");
  await d.press(owner, wMid, wBtn.callback_data);
  o = (await db.getOrder(o.id))!;
  assert(o.status === "in_work" && o.paid === 4500, `${o.status} ${o.paid}`);
  assert(tg.lastText(C1).includes("Оплата заказа") && tg.lastText(C1).includes("получена"));
  const marks = [...tg.msgs.values()].filter((m) => m.text?.includes("Оплату подтвердил Вася"));
  assert(marks.length === 2 && marks.every((m) => !m.markup), String(marks.length));
  ok("оплата: «не найдена» → повторный чек → «получена» один раз, у второго админа кнопки сняты");

  // --- готовая работа
  await d.click(me, "Отправить готовую работу");
  await d.doc(me, "kursovaya_final.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await d.click(me, "Готово");
  o = (await db.getOrder(o.id))!;
  assert(o.status === "review" && contains(tg.sentTo(C1), "готова"));
  assert(JSON.stringify(tg.methods("sendDocument").filter((p) => p.chat_id === C1).map((p) => p.document)) === '["file_kursovaya_final.docx"]');
  await d.click(c1, "Работа принята");
  o = (await db.getOrder(o.id))!;
  assert(o.status === "done");
  ok("готовая работа → «На проверке» → клиент принял → «Выполнен»");

  // --- отзыв
  const config = (await import("../src/config.ts")).loadConfig();
  // Приглашение оценить приходит сразу вместе с «Выполнен», с кратким описанием работы; повторно не приходит
  assert(tg.findButton(C1, "5 ⭐") && tg.lastText(C1).includes("Оцените") && tg.lastText(C1).includes("📝 "), tg.lastText(C1));
  await db.exec("update bot_orders set done_at = now() - interval '25 hours' where id = $1", [o.id]);
  await runReminders(config);
  assert(tg.sentTo(C1).filter((t) => t.includes("Оцените")).length === 1);
  await d.click(c1, "5 ⭐");
  await d.send(c1, "Всё супер, спасибо!");
  assert(contains(tg.sentTo(ME), "Отзыв по заказу") && contains(tg.sentTo(OWNER), "Всё супер") && contains(tg.sentTo(OWNER), "Работа: "));
  await d.send(c1, "⭐ Отзывы");
  assert(tg.lastText(C1).includes("Текст отзыва — замените реальным") && tg.lastText(C1).includes("замените своими"));
  await d.click(owner, "Опубликовать");
  assert(!tg.findButton(ME, "Опубликовать") && contains(tg.sentTo(ME), "Опубликовал Пётр"));
  await d.send(c1, "⭐ Отзывы");
  assert(tg.lastText(C1).includes("Всё супер, спасибо!") && !tg.lastText(C1).includes("замените"));
  const siteReview = (await db.q("select * from reviews where order_code = $1", [o.code]))[0];
  assert(siteReview && siteReview.message === "Всё супер, спасибо!" && siteReview.rating === 5 && siteReview.work, JSON.stringify(siteReview));
  ok("отзыв: приглашение сразу при «Выполнен» (один раз) → 5⭐ + текст → админам → «Опубликовать» → в боте и на сайте с описанием работы");

  // --- заказ с сайта через sendData
  const payload = {
    kind: "np_order", v: 1, id: "A7K2", type: "presentation", deadline: "flex",
    lines: [["📝", "Работа", "Презентация"], ["📚", "Предмет", "История"], ["⏰", "Срок", "не горит"], ["💬", "Комментарий", "<script>alert(1)</script>"]],
  };
  await d.webapp(c2, payload);
  let o2 = await order("A7K2");
  assert(o2 && o2.source === "site" && o2.data.type === "presentation" && contains(tg.sentTo(ME), "Новый заказ #A7K2") && contains(tg.sentTo(ME), "&lt;script&gt;"));
  await d.webapp(c2, payload);
  assert((await db.userOrders(C2)).length === 1 && tg.lastText(C2).includes("уже принят"));
  await d.webapp(c2, "{broken json");
  assert(tg.lastText(C2).includes("Не получилось прочитать"));
  ok("сайт → sendData: заказ #A7K2, дубль не создаётся, мусор отклоняется, HTML экранирован");

  await d.doc(c2, "metodichka_site.pdf");
  assert((await db.getFiles(o2.id, "client")).length === 1);
  assert(tg.methods("copyMessage").filter((p) => p.chat_id === ME || p.chat_id === OWNER).length === 2);
  const headMid = Math.max(...[...tg.msgs.values()].filter((m) => m.chat === OWNER && m.bot).map((m) => m.id));
  await d.send(owner, null, { reply_to_message: { message_id: headMid }, document: { file_id: "answer.pdf", file_unique_id: "a", file_name: "answer.pdf" }, caption: "Вот пример оформления" });
  const toClient = tg.methods("copyMessage").filter((p) => p.chat_id === C2).pop()!;
  assert(toClient.caption.includes("Исполнитель") && toClient.caption.includes("Вот пример оформления"));
  ok("медиа: файл клиента прикреплён к заказу и переслан обоим; ответ админа файлом с подписью");

  // --- вставка текста и bot_handoff
  const c3 = d.user(C3, "Вика");
  const siteText = "🧾 Заявка #Q9W8 с сайта «Не Парься»\n📝 Работа: Курсовая работа\n📚 Предмет: Право\n📄 Объём: 25 стр.\n" +
    "⏰ Срок: 25.12.2026 (через неделю)\n💬 Комментарий: строка 1\nстрока 2\n\n📋 Полная заявка скопирована — вставлю её следующим сообщением";
  await d.send(c3, "/start order_Q9W8");
  assert(tg.lastText(C3).includes("Вставьте её сюда"));
  await d.send(c3, "что-то другое");
  assert(tg.lastText(C3).includes("Не получилось распознать"));
  await d.send(c3, siteText);
  const o3 = await order("Q9W8");
  assert(o3 && o3.user_id === C3 && o3.data.type === "coursework" && o3.data.deadline === "2026-12-25");
  assert(Object.fromEntries(o3.data.lines.map(([, l, v]: string[]) => [l, v]))["Комментарий"] === "строка 1\nстрока 2");
  await db.exec("insert into bot_handoff(code, payload) values($1, $2::text::jsonb)", ["AbCdEf123456", JSON.stringify({
    kind: "np_order", id: "Z5X4", type: "control", deadline: "", lines: [["📝", "Работа", "Контрольная работа"], ["📄", "Объём", "5 задач"]],
  })]);
  await d.send(c3, "/start order_AbCdEf123456");
  const o4 = await order("Z5X4");
  assert(o4?.data.type === "control" && !(await db.one("select 1 from bot_handoff where code = 'AbCdEf123456'")));
  await d.send(c3, "/start order_ZZZZZZZZZZZZ");
  assert(tg.lastText(C3).includes("Не нашёл заявку"));
  ok("сайт → вставка текста (тип, срок, многострочный комментарий) и bot_handoff (забрал и удалил)");

  // --- презентация и контрольная
  await d.send(c2, "📝 Оформить заказ");
  await d.click(c2, "Презентация");
  await d.send(c2, "Маркетинг");
  await d.click(c2, "Тему подберёт исполнитель");
  await d.click(c2, "Пропустить");
  assert(tg.lastText(C2).includes("слайдов"));
  await d.send(c2, "15");
  await d.click(c2, "Неделя");
  await d.click(c2, "Не нужно");
  assert(tg.lastText(C2).includes("Шаг 8/11") && tg.lastText(C2).includes("Дизайн"));
  await d.click(c2, "Минимализм");
  await d.click(c2, "Свой вариант");
  await d.send(c2, "бордовый и бежевый");
  await d.click(c2, "Canva");
  await d.click(c2, "Минимальные анимации");
  await d.click(c2, "Да");
  await d.click(c2, "Готово");
  await d.click(c2, "Пропустить");
  await d.click(c2, "Пропустить");
  let summ = tg.lastText(C2);
  assert(summ.includes("стиль минимализм, цвета «бордовый и бежевый»") && summ.includes("Canva, минимальные анимации"), summ);
  assert(summ.includes("15 слайдов") && summ.includes("подберёт исполнитель") && summ.includes("проверка не нужна"));
  await d.click(c2, "Отправить");
  ok("презентация: слайды, дизайн (стиль, своя палитра, формат, анимации, текст выступления)");

  await d.send(c2, "📝 Оформить заказ");
  await d.click(c2, "Контрольная работа");
  await d.send(c2, "Высшая математика");
  await d.send(c2, "Пределы и производные");
  await d.send(c2, "МГТУ");
  await d.click(c2, "Магистратура");
  assert(tg.lastText(C2).includes("задач") && tg.lastText(C2).includes("Шаг 5/10"));
  await d.click(c2, "◀️ Назад");
  assert(tg.lastText(C2).includes("курсе"));
  await d.click(c2, "Колледж");
  await d.send(c2, "8");
  await d.click(c2, "Завтра");
  await d.click(c2, "80%");
  assert(tg.lastText(C2).includes("Дополнительные услуги") && tg.lastText(C2).includes("Шаг 8/10"));
  await d.click(c2, "Срочное выполнение");
  await d.click(c2, "Готово");
  await d.click(c2, "Пропустить");
  await d.click(c2, "Пропустить");
  await d.click(c2, "Изменить");
  await d.click(c2, "Тип работы");
  await d.click(c2, "Решение задач");
  assert(tg.lastText(C2).includes("задач") && !tg.lastText(C2).includes("Объём"));
  await d.send(c2, "6");
  summ = tg.lastText(C2);
  assert(summ.includes("Решение задач") && summ.includes("6 задач") && summ.includes("МГТУ, колледж") && summ.includes("Оригинальность:</b> 80%") && !summ.includes("eTXT"), summ);
  await d.click(c2, "Отправить");
  ok("контрольная: 10 шагов, «Назад», смена типа через «Изменить» переспрашивает объём");

  await d.send(c2, "📝 Оформить заказ");
  await d.send(c2, "📦 Мои заказы");
  assert(tg.lastText(C2).includes("Ваши заказы"));
  const cab = tg.findButton(C2, "Кабинет на сайте")![1].web_app.url as string;
  assert(cab.startsWith("https://ne-parsya.netlify.app/cabinet.html?t=") && cab.endsWith("&bot=ne_parsya_bot"), cab);
  await d.click(c2, "#A7K2");
  assert(tg.lastText(C2).includes("Заказ #A7K2"));
  ok("меню прерывает оформление; «Мои заказы» → кабинет на сайте и подробности");

  await d.send(c1, "🖼 Примеры работ");
  assert(tg.lastText(C1).includes("Пример — замените своими"));
  await d.click(c1, "▶️");
  assert(tg.lastText(C1).includes("Презентация"));
  await d.send(c1, "❓ Вопросы и ответы");
  await d.click(c1, "▶️");
  assert(tg.lastText(C1).includes("Как оплатить"));
  const content = JSON.parse((await db.getSetting("content"))!);
  content.faq = [{ q: "Новый вопрос?", a: "Новый ответ" }];
  await db.setSetting("content", JSON.stringify(content));
  await d.send(c1, "❓ Вопросы и ответы");
  assert(tg.lastText(C1).includes("Новый вопрос?"));
  await db.exec("delete from bot_settings where key = 'content'"); // нет строки — встроенный контент
  ok("примеры и FAQ: листалка ◀️ ▶️; правка в таблице bot_settings видна сразу");

  // --- передача, статус, отклонение, блок
  o2 = await order("A7K2");
  await d.send(owner, "/order A7K2");
  await d.click(owner, "Передать другому админу");
  await d.click(owner, "Вася");
  assert((await db.getOrder(o2.id))!.admin_id === ME && contains(tg.sentTo(ME), "Вам передали заказ"));
  await d.send(me, "/order A7K2");
  await d.click(me, "🔄 Статус");
  await d.click(me, "В работе");
  assert((await db.getOrder(o2.id))!.status === "in_work" && tg.lastText(C2).includes("взят в работу"));
  await d.click(me, "Отклонить");
  await d.send(me, "Не моя специализация");
  assert((await db.getOrder(o2.id))!.status === "cancelled" && tg.lastText(C2).includes("Не моя специализация"));
  ok("передача владельцем → Васе; смена статуса с уведомлением; отклонение с причиной");

  await d.send(me, "/block 503");
  const before = tg.calls.length;
  await d.send(c3, "привет");
  assert(!tg.calls.slice(before).some((c) => [ME, OWNER, C3].includes(c.p.chat_id)));
  await d.send(me, `/block ${OWNER}`);
  assert(tg.lastText(ME).includes("нельзя"));
  await d.send(me, "/unblock 503");
  ok("/block, /unblock: заблокированный клиент игнорируется, админа заблокировать нельзя");

  tg.blocked.add(C3);
  await d.send(owner, "/order Q9W8");
  await d.click(owner, "Написать клиенту");
  await d.send(owner, "Есть вопрос по заказу");
  assert(tg.lastText(OWNER).includes("заблокировал бота") && (await db.getUser(C3))!.bot_blocked === true);
  tg.blocked.delete(C3);
  ok("клиент заблокировал бота: админу понятное сообщение, флаг в базе");

  const long = Array.from({ length: 200 }, (_, i) => `Строка ${i} ` + "я".repeat(90)).join("\n");
  const parts = splitText(long);
  assert(parts.length > 1 && parts.every((p) => p.length <= 4096) && parts.join("\n") === long);
  await d.send(c1, "А".repeat(3990));
  assert(tg.methods("sendMessage").filter((p) => p.chat_id === OWNER).slice(-2).every((p) => p.text.length <= 4096));
  ok("разбивка сообщений > 4096 символов");

  await d.send(me, "/orders");
  assert(tg.lastText(ME).includes("Заказы"));
  await d.click(me, "👤 Мои");
  assert(tg.lastText(ME).includes("мои"));
  await d.send(me, "/stats");
  assert(tg.lastText(ME).includes("только владельцу"));
  await d.send(owner, "/stats");
  const st = tg.lastText(OWNER);
  assert(st.includes("Оплачено: <b>4 500 ₽</b>") && st.includes("Конверсия") && st.includes("сайт"), st);
  await d.send(owner, "/admins");
  assert(tg.lastText(OWNER).includes("Вася") && tg.lastText(OWNER).includes("👑"));
  await d.send(me, "/panel");
  assert(tg.findButton(ME, "Открыть админ-панель")![1].url === "https://ne-parsya.netlify.app/admin.html");
  tg.blocked.add(C2);
  await d.send(owner, "/broadcast");
  await d.send(owner, "🎉 Скидка 10% на курсовые до конца месяца!");
  await d.click(owner, "📣 Отправить");
  const rep = tg.lastText(OWNER);
  assert(rep.includes("Рассылка завершена") && rep.includes("заблокировали бота: <b>1</b>"), rep);
  assert((await db.getUser(C2))!.bot_blocked === true);
  tg.blocked.delete(C2);
  ok("/orders с фильтром, /stats, /admins, /panel, /broadcast (заблокировавшие помечены)");

  // --- чистый чат
  const c6 = d.user(506, "Чистюля");
  await d.send(c6, "/start");
  assert(tg.visible(506).length === 1 && tg.menus(506) === 1, "приветствие + сообщение с клавиатурой меню");
  const taps = [(await d.send(c6, "📦 Мои заказы")).id];
  assert(tg.visible(506).length === 1);
  taps.push((await d.send(c6, "❓ Вопросы и ответы")).id);
  await d.click(c6, "▶️");
  assert(tg.visible(506).length === 1);
  taps.push((await d.send(c6, "📝 Оформить заказ")).id);
  await d.click(c6, "Реферат");
  taps.push((await d.send(c6, "И")).id);
  assert(tg.visible(506).length === 2);
  taps.push((await d.send(c6, "История России")).id);
  assert(tg.visible(506).length === 1 && tg.visible(506)[0].includes("Шаг 3/11"));
  for (const label of ["Тему подберёт", "Пропустить", "10", "Не горит", "Не нужно", "ГОСТ", "Arial", "12", "1.5"]) await d.click(c6, label);
  await d.click(c6, "Готово");
  await d.click(c6, "Готово");
  await d.click(c6, "Пропустить");
  await d.click(c6, "Пропустить");
  await d.click(c6, "Отправить");
  let vis = tg.visible(506);
  assert(vis.length === 1 && vis[0].includes("принят"), JSON.stringify(vis));
  assert(taps.every((t) => tg.deleted(506, t)), "нажатия и ответы клиента удаляются");
  const o6 = (await db.userOrders(506))[0];
  await d.click(owner, "Взять заказ");
  await d.click(owner, "Назначить цену");
  await d.send(owner, "2000");
  await d.send(owner, "3 дня");
  vis = tg.visible(506);
  assert(vis.length === 1 && vis[0].includes("2 000 ₽"));
  await d.click(c6, "Согласен");
  assert(tg.visible(506).length === 1 && tg.visible(506)[0].includes("Оплата заказа"));
  await d.send(c6, "📦 Мои заказы");
  await d.click(c6, `#${o6.code}`);
  const card = tg.visible(506)[0];
  assert(tg.visible(506).length === 1 && card.includes("2 000 ₽") && card.includes("Ожидает оплаты") && card.includes("Реферат"));
  await d.click(c6, "Оплатить");
  assert(tg.visible(506)[0].includes("<code>2200 1234 5678 9010</code>"));
  ok("чистый чат: один экран, нажатия и ответы удаляются; цена, статус и реквизиты — в «Мои заказы»");

  // --- повтор апдейта от Telegram и логи
  const n = tg.calls.length;
  const res = await handler(new Request("http://x/bot", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": d.secret },
    body: JSON.stringify({ update_id: d.updateId, message: { message_id: 1, from: { id: C1, first_name: "Аня" }, chat: { id: C1, type: "private" }, text: "/start" } }),
  }));
  assert(res.status === 200 && tg.calls.length === n, "повтор того же апдейта не обрабатывается");
  const { redact } = await import("../src/config.ts");
  assert(redact(`token=${TOKEN} pay=💳 Карта: <code>2200 1234 5678 9010</code>`, config.secrets).includes("token=***") &&
    !redact(`💳 Карта: <code>2200 1234 5678 9010</code>`, config.secrets).includes("2200 1234"));
  ok("повтор апдейта Telegram не дублирует действие; токен и реквизиты вырезаются из логов");
  await tg.stop();
}

async function scenarioPrepay() {
  console.log("\n▶ Предоплата 50%, напоминания, автоотмена, ошибки, антифлуд");
  const { tg, d, me, owner } = await build({ PREPAYMENT_PERCENT: "50", WEBAPP_URL: "https://app.netlify.com/projects/ne-parsya/overview" });
  const config = (await import("../src/config.ts")).loadConfig();
  const c = d.user(C1, "Аня");
  await d.send(c, "/start");
  const siteBtn = tg.findButton(C1, "Открыть сайт")![1].web_app.url as string;
  assert(siteBtn.startsWith("https://ne-parsya.netlify.app?from=inline"), "секрет WEBAPP_URL со ссылкой из панели Netlify исправляется: " + siteBtn);
  await d.webapp(c, { kind: "np_order", id: "P5P5", type: "referat", lines: [["📝", "Работа", "Реферат"], ["📄", "Объём", "15 стр."]] });
  let o = await order("P5P5");
  await d.click(owner, "Назначить цену");
  await d.send(owner, "3001");
  await d.send(owner, "5 дней");
  assert(tg.lastText(C1).includes("1 501 ₽") && tg.lastText(C1).includes("предоплата 50%"));
  await d.click(c, "Согласен");
  await d.click(c, "Я оплатил");
  await d.photo(c, "r1");
  await d.click(me, "Оплата получена");
  o = (await db.getOrder(o.id))!;
  assert(o.paid === 1501 && o.status === "in_work" && o.admin_id === OWNER, JSON.stringify([o.paid, o.status, o.admin_id]));
  await d.click(owner, "Отправить готовую работу");
  await d.doc(owner, "referat.docx", "application/msword");
  await d.click(owner, "Готово");
  o = (await db.getOrder(o.id))!;
  assert(o.status === "awaiting_final" && tg.lastText(C1).includes("Осталось доплатить: <b>1 500 ₽</b>"));
  assert(!tg.methods("sendDocument").some((p) => p.chat_id === C1));
  await d.click(c, "Я оплатил");
  await d.doc(c, "check2.pdf");
  await d.click(owner, "Оплата получена");
  o = (await db.getOrder(o.id))!;
  assert(o.paid === 3001 && o.status === "review" && tg.methods("sendDocument").some((p) => p.chat_id === C1));
  ok("предоплата 50%: 1 501 ₽ → работа ждёт доплаты 1 500 ₽ → после подтверждения файл отправлен");

  const c2 = d.user(C2, "Дима");
  await d.send(c2, "/start");
  await d.webapp(c2, { kind: "np_order", id: "R7R7", type: "essay", lines: [["📝", "Работа", "Эссе"]] });
  const r = await order("R7R7");
  await d.click(me, "Взять заказ");
  await d.click(me, "Назначить цену");
  await d.send(me, "1000");
  await d.send(me, "2 дня");
  await d.click(c2, "Согласен");
  await db.exec("update bot_orders set status_changed_at = now() - interval '25 hours' where id = $1", [r.id]);
  await runReminders(config);
  await runReminders(config);
  assert(tg.sentTo(C2).filter((t) => t.includes("Напоминаю")).length === 1);
  await db.exec("update bot_orders set status_changed_at = now() - interval '73 hours' where id = $1", [r.id]);
  await runReminders(config);
  assert((await db.getOrder(r.id))!.status === "cancelled" && tg.lastText(C2).includes("отменён"));
  ok("«Ожидает оплаты»: напоминание через 24 ч (один раз), автоотмена через 72 ч");

  // Задачи по расписанию: напоминания не чаще раза в 10 минут, ключ обязателен
  const { sha256Hex } = await import("../src/util.ts");
  const cronKey = (await sha256Hex(`cron:${TOKEN}`)).slice(0, 40);
  assert((await handler(new Request("http://x/bot?cron=wrong"))).status === 403);
  assert((await handler(new Request(`http://x/bot?cron=${cronKey}`))).status === 200);
  const at = await db.getSetting("jobs_at");
  await handler(new Request(`http://x/bot?cron=${cronKey}`));
  assert(at && (await db.getSetting("jobs_at")) === at);
  ok("расписание: без ключа — отказ, напоминания не чаще раза в 10 минут");

  await db.setSetting("content", "{испорчен");
  await d.send(c, "❓ Вопросы и ответы");
  assert(tg.lastText(C1).includes("Вопросы и ответы"), "испорченный JSON — встроенный контент");
  await db.exec("alter table bot_reviews rename to bot_reviews_x");
  await d.send(c, "⭐ Отзывы");
  await db.exec("alter table bot_reviews_x rename to bot_reviews");
  assert(tg.lastText(C1).includes("что-то пошло не так"));
  await d.send(c, "❓ Вопросы и ответы");
  assert(tg.lastText(C1).includes("Вопросы и ответы"));
  ok("ошибки: пользователю — сообщение, бот работает дальше; испорченный контент не ломает бота");

  FLOOD.limit = 25;
  const flood = d.user(504, "Флудер");
  for (let i = 0; i < 40; i++) await d.send(flood, "❓ Вопросы и ответы");
  assert(tg.sentTo(504).filter((t) => t === "Не так быстро 🙂").length === 1);
  assert(tg.sentTo(504).filter((t) => t.includes("Вопросы и ответы")).length === 25);
  ok("антифлуд: лишние сообщения отбрасываются, предупреждение одно");
  await tg.stop();
}

async function scenarioSetup() {
  console.log("\n▶ Режим настройки: OWNER_ID и ADMIN_IDS пустые");
  const { tg, d, report } = await build({ OWNER_ID: "", ADMIN_IDS: "" });
  assert(report.includes("Режим настройки"));
  const me = d.user(ME, "Вася");
  await d.send(me, "/start");
  assert(tg.sentTo(ME).at(-2)!.includes("режиме настройки") && tg.lastText(ME).includes("<code>111</code>"));
  const c = d.user(C1, "Аня");
  await d.send(c, "/id");
  assert(tg.visible(C1).at(-1)!.includes("<code>501</code>") && tg.menus(C1) === 1, "клавиатура меню появляется и у тех, кто не нажимал /start");
  await d.webapp(c, { kind: "np_order", id: "S1S1", type: "essay", lines: [["📝", "Работа", "Эссе"]] });
  assert(tg.lastText(C1).includes("принят"));
  await d.send(c, "вопрос");
  ok("режим настройки: /start и /id показывают число, заказы не падают");
  // Секреты поменяли — бот подхватывает сразу, без перезапуска
  Deno.env.set("ADMIN_IDS", String(ME));
  Deno.env.set("OWNER_ID", String(ME));
  await d.send(me, "/stats");
  assert(tg.lastText(ME).includes("Статистика"));
  ok("новые секреты ADMIN_IDS/OWNER_ID действуют сразу, без перезапуска");
  Deno.env.set("BOT_TOKEN", "");
  const res = await handler(new Request("http://x/bot?setup=1"));
  assert((await res.text()).includes("BOT_TOKEN не задан"));
  ok("без BOT_TOKEN — понятная подсказка вместо ошибки");
  await tg.stop();
}

const which = Deno.args[0] ?? "all";
try {
  if (which === "a" || which === "all") await scenarioMain();
  if (which === "b" || which === "all") await scenarioPrepay();
  if (which === "c" || which === "all") await scenarioSetup();
} catch (e) {
  console.error(e);
  console.log(`\n✗ ПРОВАЛ после ${PASSED.length} пройденных проверок`);
  Deno.exit(1);
}
console.log(`\n✅ Все проверки пройдены: ${PASSED.length}`);
await db.close();
Deno.exit(0);
