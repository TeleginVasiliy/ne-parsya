// Разбор входящего апдейта Telegram и выбор обработчика.
// Порядок важен: меню прерывает любые диалоги, «просто сообщения» — в самом конце.
import { T } from "./texts.ts";
import type { Config } from "./config.ts";
import { log } from "./config.ts";
import { Ctx } from "./ctx.ts";
import * as db from "./db.ts";
import * as A from "./admin.ts";
import * as C from "./client.ts";
import * as O from "./order.ts";
import * as P from "./payment.ts";
import { looksLikeSiteText } from "./siteOrders.ts";
import * as screen from "./screen.ts";
import * as tg from "./tg.ts";
import type { Msg } from "./tg.ts";

// ----------------------- антифлуд -----------------------
// Не больше 25 событий за 10 секунд от одного пользователя (в пределах одного запуска функции).
export const FLOOD = { limit: 25, window: 10_000 };
const hits = new Map<number, number[]>();
const warned = new Map<number, number>();

function flooding(uid: number): "ok" | "drop" | "warn" {
  const now = Date.now();
  const q = (hits.get(uid) ?? []).filter((t) => now - t <= FLOOD.window);
  if (q.length >= FLOOD.limit) {
    hits.set(uid, q);
    if (now - (warned.get(uid) ?? 0) > FLOOD.window) {
      warned.set(uid, now);
      return "warn";
    }
    return "drop";
  }
  q.push(now);
  hits.set(uid, q);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > FLOOD.window) hits.delete(k);
  return "ok";
}

// ----------------------- команды -----------------------
function command(m: Msg): { name: string; args: string } | null {
  const text: string = m.text ?? "";
  if (!text.startsWith("/")) return null;
  const [head, ...rest] = text.split(/\s+/);
  const name = head.slice(1).split("@")[0].toLowerCase();
  return { name, args: text.slice(head.length).trim() || rest.join(" ") };
}

const MENU_TEXT: Record<string, string> = {
  [T.BTN_SITE]: "site", "🌐 Сайт": "site", // старая надпись — у клиентов ещё может быть прежняя клавиатура
  [T.BTN_ORDER]: "new", [T.BTN_MY]: "my", [T.BTN_CONTACT]: "contact",
  [T.BTN_EXAMPLES]: "examples", [T.BTN_REVIEWS]: "reviews", [T.BTN_FAQ]: "faq",
};

/** Обрабатывает апдейт. Возвращает true, если стоит сразу запустить фоновые задачи (например, рассылку). */
export async function handleUpdate(config: Config, update: Msg, fresh: Promise<boolean> = Promise.resolve(true)): Promise<boolean> {
  const msg: Msg | null = update.message ?? null;
  const cbq: Msg | null = update.callback_query ?? null;
  const skip = async () => (await fresh, false); // повтор всё равно отмечаем
  if (!msg && !cbq) return await skip();
  const from = (msg ?? cbq)!.from;
  if (!from || from.is_bot) return await skip();
  if (msg && msg.chat?.type !== "private") return await skip(); // бот работает только в личных сообщениях
  const ctx = new Ctx(config, msg, cbq);

  const admin = config.isAdmin(from.id);
  // Альбом из нескольких фото приходит пачкой — не считаем это флудом
  if (!admin && !msg?.media_group_id) {
    const f = flooding(from.id);
    if (f !== "ok") {
      if (!await fresh) return false;
      if (cbq) await ctx.answer(T.TOO_FAST);
      else if (f === "warn") await ctx.reply(T.TOO_FAST);
      return false;
    }
  }

  // Учёт пользователя и очередь его сообщений — двумя запросами одновременно (быстрее ответ).
  // Очередь: сообщения одного пользователя — строго по одному (например, альбом файлов в анкете)
  const [isFresh, u, locked] = await Promise.all([
    fresh,
    db.touchUser(from.id, [from.first_name, from.last_name].filter(Boolean).join(" ") || null, from.username ?? null),
    db.lock(from.id),
  ]);
  ctx.isNewUser = u.inserted;
  try {
    if (!isFresh) {
      ctx.answered = true; // повтор того же нажатия — Telegram уже получил ответ
      return false;
    }
    if (!admin && u.blocked) {
      if (cbq) await ctx.answer();
      return false;
    }
    if (locked) {
      ctx.state = locked.state;
      ctx.data = locked.data;
    } else await ctx.loadState();
    return msg ? await onMessage(ctx, msg) : await onCallback(ctx, cbq!);
  } catch (e) {
    log(`Ошибка при обработке апдейта ${update.update_id}: ${(e as Error).stack ?? e}`);
    if (cbq) await tg.call("answerCallbackQuery", { callback_query_id: cbq.id, text: T.ERROR, show_alert: true });
    else await tg.sendText(ctx.chatId, T.ERROR);
    return false;
  } finally {
    if (cbq && !ctx.answered) await ctx.answer().catch(() => {});
    // Очередь освобождаем сразу: следующее нажатие клиента не будет ждать
    if (locked) await db.unlock(from.id).catch(() => {});
  }
}

async function onMessage(ctx: Ctx, m: Msg): Promise<boolean> {
  const cfg = ctx.config, uid = ctx.uid, st = ctx.state;
  const cmd = command(m);
  const isAdmin = cfg.isAdmin(uid), isOwner = cfg.isOwner(uid);
  const hasFile = !!(m.document || m.photo);

  // 1) Меню и команды клиента — в любом состоянии
  const menu = cmd ? cmd.name : MENU_TEXT[m.text ?? ""];
  if (cmd?.name === "start") return void await C.cmdStart(ctx, cmd.args), false;
  if (cmd?.name === "id" || cmd?.name === "myid") return void await C.cmdId(ctx), false;
  if (menu === "site") return void await C.cmdSite(ctx), false;
  if (menu === "new") return void await C.cmdNew(ctx), false;
  if (menu === "my") return void await C.cmdMy(ctx), false;
  if (menu === "contact" && !cmd) return void await C.cmdContact(ctx), false;
  if (menu === "examples" && !cmd) return void await C.cmdPage(ctx, "ex"), false;
  if (menu === "reviews" && !cmd) return void await C.cmdPage(ctx, "rv"), false;
  if (menu === "faq") return void await C.cmdPage(ctx, "faq"), false;

  // 2) Ссылка на сайт (владелец)
  if (cmd?.name === "setsite" && isOwner) return void await A.cmdSetsite(ctx, cmd.args), false;
  if (cmd?.name === "setsite" && isAdmin) return void await ctx.reply(T.OWNER_ONLY), false;
  if (st === "site_url" && m.text && isOwner) return void await A.onNewUrl(ctx), false;

  // 3) Админы
  if (isAdmin) {
    if (st === "adm_price" && m.text) return void await A.onPrice(ctx), false;
    if (st === "adm_deadline" && m.text) return void await A.onDeadline(ctx), false;
    if (st === "adm_message") return void await A.onAdminMessage(ctx), false;
    if (st === "adm_result") return void await (hasFile ? A.onResultFile(ctx) : A.onResultOther(ctx)), false;
    if (st === "adm_reject" && m.text) return void await A.onRejectReason(ctx), false;
    if (cmd?.name === "orders") return void await A.cmdOrders(ctx), false;
    if (cmd?.name === "panel") return void await A.cmdPanel(ctx), false;
    if (cmd?.name === "order") return void await A.cmdOrder(ctx, cmd.args), false;
    if (cmd?.name === "block") return void await A.cmdBlock(ctx, cmd.args, true), false;
    if (cmd?.name === "unblock") return void await A.cmdBlock(ctx, cmd.args, false), false;
    if (cmd && ["stats", "broadcast", "admins"].includes(cmd.name)) {
      if (!isOwner) return void await ctx.reply(T.OWNER_ONLY), false;
      if (cmd.name === "stats") return void await A.cmdStats(ctx), false;
      if (cmd.name === "admins") return void await A.cmdAdmins(ctx), false;
      return void await A.cmdBroadcast(ctx), false;
    }
    if (st === "adm_broadcast") return void await A.onBroadcastMessage(ctx), false;
    if (st === null && m.reply_to_message) return void await A.onAdminReply(ctx), false;
  }

  // 4) Чек об оплате
  if (st === "receipt") return void await P.onReceipt(ctx), false;

  // 5) Заказ с сайта и анкета
  if (m.web_app_data) return void await O.onWebAppData(ctx), false;
  if ((st === null || st === "paste") && looksLikeSiteText(m.text)) return void await O.onPastedSiteOrder(ctx), false;
  if (st === "paste") return void await screen.hint(m, T.PASTE_BAD), false;
  if (st === "form") {
    if (m.text) return void await O.onFormText(ctx), false;
    if (hasFile) return void await O.onFormFile(ctx), false;
    return void await screen.hint(m, T.CHOOSE_BUTTON), false;
  }

  // 6) Отзыв и переписка по заказу
  if (st === "review_text" && m.text) return void await C.onReviewText(ctx), false;
  if (st === "client_chat") return void await C.onOrderMessage(ctx), false;
  if (st === "attach") return void await C.onAttach(ctx), false;

  // 7) Всё остальное — исполнителю
  if (st === null) await C.onFreeMessage(ctx);
  return false;
}

async function onCallback(ctx: Ctx, cbq: Msg): Promise<boolean> {
  const cfg = ctx.config, uid = ctx.uid, st = ctx.state;
  const isAdmin = cfg.isAdmin(uid), isOwner = cfg.isOwner(uid);
  const parts = String(cbq.data ?? "").split(":");
  const [prefix] = parts;
  const n = (i: number) => Number(parts[i]);
  if (!cbq.message) return false;

  if (prefix === "site" && isOwner) return void await A.cbSite(ctx, parts[1]), false;
  if (isAdmin) {
    if (prefix === "a") return void await A.cbAdmin(ctx, parts[1], n(2)), false;
    if (prefix === "st") return void await A.cbSetStatus(ctx, n(1), parts[2]), false;
    if (prefix === "tr") return void await A.cbTransferTo(ctx, n(1), n(2)), false;
    if (prefix === "pub") return void await A.cbPublish(ctx, n(1)), false;
    if (prefix === "ol") return void await A.cbOrders(ctx, parts[1], n(2), n(3)), false;
    if (prefix === "bc" && isOwner) return await A.cbBroadcast(ctx, parts[1]);
    if (prefix === "p") return void await P.cbPaymentDecision(ctx, parts[1], n(2)), false;
  }
  if (cbq.data === screen.BACK_DATA || cbq.data === screen.HOME_DATA) {
    // «⬅️ Назад» / «⏮ В начало»: прошлый (или самый первый) экран. Незаконченные шаги (анкета, сообщение исполнителю) при этом закрываются
    if (st && !isAdmin) await ctx.clearState();
    if (!await screen.back(ctx.chatId, cbq.message.message_id, cbq.data === screen.HOME_DATA)) await ctx.answer(T.NOTHING_BACK, true);
    return false;
  }
  if (prefix === "c") {
    const o = n(2);
    const handlers: Record<string, () => Promise<void>> = {
      agree: () => P.cbAgree(ctx, o), pay: () => P.cbPay(ctx, o), receipt: () => P.cbReceipt(ctx, o),
      new: () => C.cbNew(ctx), list: () => C.cbList(ctx), open: () => C.cbOpen(ctx, o), files: () => C.cbFiles(ctx, o),
      write: () => C.cbWrite(ctx, o), discuss: () => C.cbDiscuss(ctx, o), accept: () => C.cbAccept(ctx, o),
      accept_yes: () => C.cbAcceptYes(ctx, o), attach: () => C.cbAttach(ctx, o),
      cancel: () => C.cbCancel(ctx, o), cancel_yes: () => C.cbCancelYes(ctx, o),
    };
    if (handlers[parts[1]]) await handlers[parts[1]]();
    return false;
  }
  if (prefix === "f") {
    if (st === "form") return void await O.onFormButton(ctx, parts[1], parts.slice(2).join(":")), false;
    return void await ctx.answer(T.STALE_BUTTON), false;
  }
  if (prefix === "pg") return void await C.cbPage(ctx, parts[1], n(2)), false;
  if (prefix === "rv") {
    if (n(2) > 0) return void await C.cbRate(ctx, n(1), n(2)), false;
    if (st === "review_text") return void await C.cbReviewSkip(ctx), false;
  }
  return false;
}
