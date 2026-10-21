// Клиент: старт, меню, мои заказы, контент, отзывы и переписка с исполнителем.
import { T } from "./texts.ts";
import type { Ctx } from "./ctx.ts";
import * as db from "./db.ts";
import type { Order } from "./db.ts";
import * as K from "./kb.ts";
import * as screen from "./screen.ts";
import {
  askReview, cabinetLink, changeStatus, clientOrderText, clientText, getWebappUrl, notifyOrderAdmins, relayToAdmins,
  sendStoredFile, setupCommands, undeliveredReason, workSummary,
} from "./services.ts";
import { createSiteOrder, fetchHandoff, HANDOFF_CODE_RE } from "./siteOrders.ts";
import { startForm } from "./order.ts";
import * as tg from "./tg.ts";
import { esc, fmt } from "./util.ts";
import DEFAULT_CONTENT from "./content.json" with { type: "json" };

// ======================= старт и меню =======================

export async function cmdStart(ctx: Ctx, arg: string) {
  await ctx.clearState();
  const uid = ctx.uid, chat = ctx.chatId, cfg = ctx.config;
  const fromSite = arg === "site" || arg.startsWith("order_");
  await db.setSourceIfEmpty(uid, fromSite ? "site" : (!arg ? "bot" : arg.slice(0, 32)));
  const url = await getWebappUrl(cfg);
  if (cfg.isAdmin(uid)) await setupCommands(cfg, uid); // админские команды видны только админам

  if (arg === "cabinet") return await cmdCabinet(ctx);
  const greeting = fromSite ? T.START_FROM_SITE : (url ? T.START : T.START_NO_SITE);
  // Приветствие — новый экран; всё прежнее из чата убирается
  await screen.newScreen(chat, greeting, K.startInline(url), ctx.msg!.message_id, { menu: false });
  await screen.ensureMenu(chat, undefined, true); // свежая клавиатура главного меню (старая убирается)
  if (cfg.setupMode) {
    await screen.add(chat, T.SETUP_MODE);
    await screen.add(chat, fmt(T.MY_ID, { id: uid }));
  }
  if (cfg.isOwner(uid) && !url) await screen.add(chat, T.OWNER_NO_SITE);
  if (cfg.isAdmin(uid) && ctx.isNewUser) await screen.add(chat, T.HELP_ADMIN_HINT);

  if (arg.startsWith("order_")) {
    const code = arg.slice("order_".length);
    const data = HANDOFF_CODE_RE.test(code) ? await fetchHandoff(code) : null;
    if (data) await createSiteOrder(cfg, uid, data);
    else {
      await ctx.setState("paste", {});
      await screen.add(chat, HANDOFF_CODE_RE.test(code) ? T.HANDOFF_NOT_FOUND : T.PASTE_PROMPT);
    }
  }
}

/** Сайт → «Войти через Telegram»: личная ссылка на кабинет (здесь и для браузера). */
export async function cmdCabinet(ctx: Ctx) {
  await ctx.clearState();
  const link = await cabinetLink(ctx.config, ctx.uid);
  const kb = link ? { inline_keyboard: [[{ text: T.BTN_CABINET, web_app: { url: link } }], [{ text: T.BTN_CABINET_BROWSER, url: link }]] } : null;
  await screen.newScreen(ctx.chatId, link ? T.CABINET_OPEN : T.CABINET_NO_SITE, kb, ctx.msg?.message_id, { menu: false });
  await screen.ensureMenu(ctx.chatId);
}

/** Числовой ID — нужен для ADMIN_IDS / OWNER_ID. */
export async function cmdId(ctx: Ctx) {
  await screen.newScreen(ctx.chatId, fmt(T.MY_ID, { id: ctx.uid }), null, ctx.msg!.message_id);
}

export async function cmdSite(ctx: Ctx) {
  await ctx.clearState();
  const url = await getWebappUrl(ctx.config);
  const [text, kb] = url ? [T.SITE_OPEN, K.siteInline(url)] : [T.SITE_NOT_SET, K.mainMenu(null)];
  await screen.newScreen(ctx.chatId, text, kb, ctx.msg!.message_id);
}

export async function cmdNew(ctx: Ctx) {
  await screen.track(ctx.chatId, ctx.msg!.message_id); // нажатие уйдёт вместе с прошлым экраном
  await startForm(ctx);
}

export async function cbNew(ctx: Ctx) {
  await ctx.answer();
  await startForm(ctx);
}

export async function cmdMy(ctx: Ctx) {
  await ctx.clearState();
  const orders = await db.userOrders(ctx.uid);
  const cabinet = orders.length ? await cabinetLink(ctx.config, ctx.uid) : null;
  await screen.newScreen(ctx.chatId, orders.length ? T.MY_TITLE : T.MY_EMPTY, orders.length ? K.myOrdersKb(orders, cabinet) : null,
    ctx.msg!.message_id);
}

export async function cmdContact(ctx: Ctx) {
  await ctx.clearState();
  await screen.newScreen(ctx.chatId, T.CONTACT_PROMPT, null, ctx.msg!.message_id);
}

export async function cmdPage(ctx: Ctx, kind: string) {
  await ctx.clearState();
  await showPage(ctx, kind, 0, null, ctx.msg!.message_id);
}

// ======================= мои заказы =======================

async function ownOrder(ctx: Ctx, orderId: number): Promise<Order | null> {
  const o = await db.getOrder(orderId);
  if (!o || o.user_id !== ctx.uid) {
    await ctx.answer(T.ORDER_NOT_AVAILABLE, true);
    return null;
  }
  return o;
}
export { ownOrder };

export async function cbList(ctx: Ctx) {
  await ctx.answer();
  const orders = await db.userOrders(ctx.uid);
  const cabinet = orders.length ? await cabinetLink(ctx.config, ctx.uid) : null;
  await screen.editScreen(ctx.chatId, ctx.cbMsg.message_id, orders.length ? T.MY_TITLE : T.MY_EMPTY,
    orders.length ? K.myOrdersKb(orders, cabinet) : null);
}

export async function cbOpen(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  await ctx.answer();
  await screen.editScreen(ctx.chatId, ctx.cbMsg.message_id, clientOrderText(o), K.orderDetailKb(o));
}

export async function cbFiles(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  const files = ["review", "done"].includes(o.status) ? await db.getFiles(o.id, "result") : [];
  if (!files.length) {
    await ctx.answer(T.NO_RESULT_FILES, true);
    return;
  }
  await ctx.answer();
  const before = await screen.begin(ctx.chatId);
  const ids: number[] = [];
  for (const f of files) {
    const sent = await sendStoredFile(ctx.chatId, f);
    if (sent) ids.push(sent.message_id);
  }
  if (!ids.length) {
    await ctx.reply(fmt(T.FILES_NOT_SENT, { reason: esc(undeliveredReason(ctx.uid)) }));
    return;
  }
  const note = await tg.sendText(ctx.chatId, fmt(T.RESULT_FILES_HERE, { code: o.code }), K.backToOrderKb(o.id));
  if (note) ids.push(note.message_id);
  await screen.commit(ctx.chatId, before, ids);
}

export async function cbWrite(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  await ctx.answer();
  await ctx.setState("client_chat", { order_id: o.id });
  await screen.newScreen(ctx.chatId, fmt(T.WRITE_ORDER_PROMPT, { code: o.code }), K.backToOrderKb(o.id));
}

export async function cbDiscuss(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  await ctx.answer();
  await ctx.setState("client_chat", { order_id: o.id });
  await screen.newScreen(ctx.chatId, T.DISCUSS, K.backToOrderKb(o.id));
  await notifyOrderAdmins(ctx.config, o, fmt(T.CLIENT_WANTS_DISCUSS, { code: o.code }));
}

export async function cbAccept(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  if (!await changeStatus(ctx.config, o.id, "done", { notify: false, expected: ["review"] })) {
    await ctx.answer(T.ORDER_NOT_AVAILABLE, true);
    return;
  }
  await ctx.answer("🎉");
  await askReview(ctx.config, (await db.getOrder(o.id))!, fmt(T.WORK_ACCEPTED, { code: o.code }));
  await notifyOrderAdmins(ctx.config, o, fmt(T.CLIENT_ACCEPTED_WORK, { code: o.code }));
}

export async function cbCancel(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  await ctx.answer();
  if (!["new", "accepted", "awaiting_payment"].includes(o.status) || o.paid) {
    await screen.newScreen(ctx.chatId, T.CANNOT_CANCEL, K.backToOrderKb(o.id));
    return;
  }
  await screen.newScreen(ctx.chatId, fmt(T.CANCEL_CONFIRM, { code: o.code }), K.cancelConfirmKb(o.id));
}

export async function cbCancelYes(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  if (o.paid || !await changeStatus(ctx.config, o.id, "cancelled", { notify: false, expected: ["new", "accepted", "awaiting_payment"] })) {
    await ctx.answer(T.CANNOT_CANCEL, true);
    return;
  }
  await ctx.answer();
  await tg.editText(ctx.chatId, ctx.cbMsg.message_id, fmt(T.CANCELLED_BY_CLIENT, { code: o.code }));
  await notifyOrderAdmins(ctx.config, o, fmt(T.CLIENT_CANCELLED, { code: o.code }));
}

// ======================= примеры, отзывы, FAQ =======================

// deno-lint-ignore no-explicit-any
type Item = Record<string, any>;

/** Контент из таблицы bot_settings (строка content) — правки видны сразу. */
export async function loadContent(): Promise<Item> {
  try {
    const raw = await db.getSetting("content");
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    }
  } catch {
    // испорченный JSON — показываем встроенный контент
  }
  return DEFAULT_CONTENT as Item;
}

async function pageItems(kind: string): Promise<Item[]> {
  const content = await loadContent();
  const list = (k: string) => (Array.isArray(content[k]) ? content[k] : []).filter((x: unknown) => x && typeof x === "object");
  if (kind === "ex") return list("examples");
  if (kind === "faq") return list("faq").filter((x: Item) => x.q);
  // Отзывы — только настоящие, опубликованные из бота (шаблоны-примеры не показываем)
  return (await db.publishedReviews()).map((r) => ({
    name: r.first_name || "Клиент", rating: r.rating, text: r.text || "", work: workSummary({ data: r.order_data ?? {} }),
  }));
}

function pageText(kind: string, item: Item): string {
  const mark = item.placeholder ? T.PLACEHOLDER_MARK : "";
  if (kind === "ex") {
    const head = [item.type, item.subject].filter(Boolean).map(esc).join(" · ");
    return `${T.EXAMPLES_TITLE}\n\n<b>${head}</b>\n${esc(item.description ?? "")}${mark}`;
  }
  if (kind === "rv") {
    const rating = Math.max(1, Math.min(5, parseInt(item.rating) || 5));
    const who = [item.university, item.work].filter(Boolean).map(esc).join(", ");
    const text = item.text ? `«${esc(item.text)}»\n\n` : "";
    return `${T.REVIEWS_TITLE}\n\n${"⭐".repeat(rating)}\n${text}— <b>${esc(item.name ?? "Клиент")}</b>` + (who ? `, ${who}` : "") + mark;
  }
  return `${T.FAQ_TITLE}\n\n<b>${esc(item.q)}</b>\n\n${esc(item.a ?? "")}`;
}

export async function showPage(ctx: Ctx, kind: string, index: number, current: tg.Msg | null, userMsgId?: number) {
  const items = await pageItems(kind);
  const chat = ctx.chatId;
  if (!items.length) {
    await screen.newScreen(chat, kind === "rv" ? T.REVIEWS_EMPTY : T.CONTENT_EMPTY, null, userMsgId);
    return;
  }
  index = ((index % items.length) + items.length) % items.length;
  const item = items[index];
  const text = pageText(kind, item);
  const kb = K.pagerKb(kind, index, items.length);
  const photo = kind === "ex" ? item.photo : null;
  if (current) {
    const hasPhoto = !!current.photo;
    if (photo && hasPhoto) {
      if (await tg.call("editMessageMedia", {
        chat_id: chat, message_id: current.message_id, media: { type: "photo", media: photo, caption: text.slice(0, 1024), parse_mode: "HTML" },
        reply_markup: kb ?? undefined,
      })) return;
    } else if (!photo && !hasPhoto) {
      if (await tg.editText(chat, current.message_id, text, kb)) return;
    }
    await tg.deleteMessage(chat, current.message_id); // тип сообщения меняется — шлём заново
  }
  if (photo) {
    const sent = await tg.call("sendPhoto", { chat_id: chat, photo, caption: text.slice(0, 1024), parse_mode: "HTML", reply_markup: kb ?? undefined });
    if (sent) {
      await screen.adopt(chat, sent, userMsgId);
      return;
    }
  }
  await screen.newScreen(chat, text, kb, userMsgId);
}

export async function cbPage(ctx: Ctx, kind: string, index: number) {
  await ctx.answer();
  await showPage(ctx, kind, index, ctx.cbMsg);
}

// ======================= отзыв после выполнения =======================

export async function cbRate(ctx: Ctx, orderId: number, rating: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  if (o.status !== "done") return void await ctx.answer(T.REVIEW_NOT_YET, true); // отзыв — только о выполненной работе
  const reviewId = await db.createReview(o.id, ctx.uid, rating);
  if (reviewId === null) {
    await ctx.answer(T.REVIEW_ALREADY, true);
    return;
  }
  await ctx.answer("⭐".repeat(rating));
  await ctx.setState("review_text", { review_id: reviewId, order_id: o.id });
  await screen.newScreen(ctx.chatId, `Ваша оценка: ${"⭐".repeat(rating)}\n\n${T.REVIEW_TEXT_ASK}`, K.skipReviewKb(o.id));
}

export function reviewCardText(o: Order, client: string, rating: number, text: string | null) {
  return fmt(T.ADMIN_REVIEW, {
    code: o.code, client, work: esc(workSummary(o)), stars: "⭐".repeat(rating), text: text ? esc(text) : "<i>без текста</i>",
  });
}

async function finishReview(ctx: Ctx, reviewId: number, text: string | null) {
  await db.setReviewText(reviewId, text);
  const review = (await db.getReview(reviewId))!;
  const o = (await db.getOrder(review.order_id))!;
  const card = reviewCardText(o, await clientText(review.user_id), review.rating, text);
  for (const adminId of ctx.config.adminIds) {
    const msg = await tg.sendText(adminId, card, K.publishKb(reviewId));
    if (msg) {
      await db.addCard(adminId, msg.message_id, "review", reviewId);
      await db.mapMessage(adminId, msg.message_id, review.user_id, o.id);
    }
  }
}

export async function cbReviewSkip(ctx: Ctx) {
  const reviewId = ctx.data.review_id;
  await ctx.clearState();
  await ctx.answer();
  await tg.editText(ctx.chatId, ctx.cbMsg.message_id, T.REVIEW_THANKS);
  await finishReview(ctx, reviewId, null);
}

export async function onReviewText(ctx: Ctx) {
  const text: string = ctx.msg!.text;
  if ([...text].length > 1000) {
    await screen.hint(ctx.msg!, T.BAD_REVIEW_TEXT);
    return;
  }
  const reviewId = ctx.data.review_id;
  await ctx.clearState();
  await screen.newScreen(ctx.chatId, T.REVIEW_THANKS, null, ctx.msg!.message_id);
  await finishReview(ctx, reviewId, text.trim());
}

// ======================= переписка с исполнителем =======================

async function relay(ctx: Ctx, o: Order | null) {
  const f = tg.extractFile(ctx.msg!);
  if (f && o) await db.addFile(o.id, "client", f); // файлы клиента прикрепляем к заказу
  await relayToAdmins(ctx.config, ctx.msg!, o);
  // Сообщение клиента уже у исполнителя — в чате оставляем только подтверждение
  await screen.newScreen(ctx.chatId, T.RELAYED, o ? K.backToOrderKb(o.id) : null, ctx.msg!.message_id);
}

export async function onOrderMessage(ctx: Ctx) {
  const orderId = ctx.data.order_id;
  await ctx.clearState();
  let o = await db.getOrder(orderId);
  if (o && o.user_id !== ctx.uid) o = null;
  await relay(ctx, o);
}

export async function onFreeMessage(ctx: Ctx) {
  if (ctx.config.isAdmin(ctx.uid)) {
    await ctx.reply(T.ADMIN_NOT_REPLY);
    return;
  }
  await relay(ctx, await db.activeOrderForUser(ctx.uid));
}
