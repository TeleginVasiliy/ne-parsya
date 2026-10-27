// Админы: карточки заказов, цена, статусы, отправка работы, переписка, команды, /setsite.
import { T } from "./texts.ts";
import type { Ctx } from "./ctx.ts";
import * as db from "./db.ts";
import type { Order } from "./db.ts";
import * as K from "./kb.ts";
import {
  adminName, adminUrl, markAccepted, applyMenuButton, isDashboardUrl, normalizeSiteUrl, resetUrlCache, changeStatus, deadlineLabel, deliverResult, getWebappUrl, notifyClient, prepayAmount,
  logResultFiles, refreshOrderCards, sendAdminCard, sendAdminMessageToClient, sendOffer, sendOrderFiles, sendPaymentInstructions, statusLabel,
} from "./services.ts";
import { reviewCardText } from "./client.ts";
import { clientText } from "./services.ts";
import { pushReviews } from "./cloud.ts";
import * as tg from "./tg.ts";
import { esc, fmt, isValidHttpsUrl, money } from "./util.ts";

const PER_PAGE = 8;
const STATUS = T.STATUS as Record<string, string>;

// ======================= права =======================

/** Действовать может ответственный или владелец. Ничей заказ закрепляется за нажавшим. */
async function canAct(ctx: Ctx, o: Order): Promise<Order | null> {
  const uid = ctx.uid;
  if (o.admin_id === null && await db.takeOrder(o.id, uid)) {
    await refreshOrderCards(ctx.config, o.id);
    await markAccepted(ctx.config, o.id);
  }
  const fresh = (await db.getOrder(o.id))!;
  if (fresh.admin_id === uid || ctx.config.isOwner(uid)) return fresh;
  await ctx.answer(fmt(T.NOT_YOURS, { name: await adminName(fresh.admin_id) }), true);
  return null;
}

async function orderOrAlert(ctx: Ctx, orderId: number): Promise<Order | null> {
  const o = await db.getOrder(orderId);
  if (!o) await ctx.answer(T.ORDER_NOT_AVAILABLE, true);
  return o;
}

async function actable(ctx: Ctx, orderId: number): Promise<Order | null> {
  const o = await orderOrAlert(ctx, orderId);
  return o ? await canAct(ctx, o) : null;
}

// ======================= кнопки на карточке =======================

export async function cbAdmin(ctx: Ctx, action: string, orderId: number) {
  const cfg = ctx.config;
  const chat = ctx.chatId;
  switch (action) {
    case "take": {
      const o = await orderOrAlert(ctx, orderId);
      if (!o) return;
      if (!await db.takeOrder(o.id, ctx.uid)) {
        const fresh = (await db.getOrder(o.id))!;
        await ctx.answer(fmt(T.TAKEN_ALREADY, { name: await adminName(fresh.admin_id) }), true);
      } else {
        await ctx.answer(T.TAKEN_OK);
        await markAccepted(cfg, o.id); // клиент сразу видит, что заказ принят
      }
      await refreshOrderCards(cfg, o.id);
      return;
    }
    case "open": {
      const o = await orderOrAlert(ctx, orderId);
      if (!o) return;
      await ctx.answer();
      await sendAdminCard(cfg, o, ctx.uid);
      return;
    }
    case "files": {
      const o = await orderOrAlert(ctx, orderId);
      if (!o) return;
      await ctx.answer();
      const sent = await sendOrderFiles(o, ctx.uid, "client") + await sendOrderFiles(o, ctx.uid, "result");
      if (!sent) await ctx.reply(`У заказа #${o.code} нет файлов.`);
      return;
    }
    case "cancel":
      await ctx.clearState();
      await ctx.answer();
      await tg.editText(chat, ctx.cbMsg.message_id, T.ADMIN_CANCELLED);
      return;
    case "price": {
      const o = await actable(ctx, orderId);
      if (!o) return;
      if (o.paid || !["new", "accepted", "awaiting_payment"].includes(o.status)) return void await ctx.answer(T.PRICE_LOCKED, true);
      await ctx.answer();
      await ctx.setState("adm_price", { order_id: o.id });
      await ctx.reply(fmt(T.ASK_PRICE, { code: o.code }), K.adminCancelKb(o.id));
      return;
    }
    case "dl_same": {
      if (ctx.state !== "adm_deadline") return void await ctx.answer();
      await ctx.answer();
      const o = (await db.getOrder(orderId))!;
      await tg.editMarkup(chat, ctx.cbMsg.message_id, null);
      await finishPrice(ctx, deadlineLabel(o));
      return;
    }
    case "msg": {
      const o = await actable(ctx, orderId);
      if (!o) return;
      await ctx.answer();
      await ctx.setState("adm_message", { order_id: o.id });
      await ctx.reply(fmt(T.ASK_MSG, { code: o.code }), K.adminCancelKb(o.id));
      return;
    }
    case "status": {
      const o = await actable(ctx, orderId);
      if (!o) return;
      await ctx.answer();
      await ctx.reply(fmt(T.ASK_STATUS, { code: o.code, status: statusLabel(o.status) }), K.statusKb(o));
      return;
    }
    case "result": {
      const o = await actable(ctx, orderId);
      if (!o) return;
      await ctx.answer();
      await ctx.setState("adm_result", { order_id: o.id, files: [] });
      await ctx.reply(fmt(T.ASK_RESULT, { code: o.code }), K.adminCancelKb(o.id));
      return;
    }
    case "result_done":
      if (ctx.state !== "adm_result") return void await ctx.answer();
      return await resultDone(ctx);
    case "transfer": {
      const o = await actable(ctx, orderId);
      if (!o) return;
      const others: [number, string][] = [];
      for (const a of cfg.adminIds) if (a !== o.admin_id) others.push([a, await adminName(a)]);
      await ctx.answer();
      if (!others.length) return void await ctx.reply(T.NO_OTHER_ADMINS);
      await ctx.reply(fmt(T.ASK_TRANSFER, { code: o.code }), K.transferKb(o.id, others));
      return;
    }
    case "reject": {
      const o = await actable(ctx, orderId);
      if (!o) return;
      await ctx.answer();
      await ctx.setState("adm_reject", { order_id: o.id });
      await ctx.reply(fmt(T.ASK_REJECT, { code: o.code }), K.adminCancelKb(o.id));
      return;
    }
  }
  await ctx.answer();
}

// ---------- цена ----------
export async function onPrice(ctx: Ctx) {
  const digits = String(ctx.msg!.text).toLowerCase().replace(/[\s₽руб.]/g, "");
  if (!/^\d+$/.test(digits) || !(+digits > 0 && +digits < 10_000_000)) return void await ctx.reply(T.BAD_PRICE);
  const o = (await db.getOrder(ctx.data.order_id))!;
  await ctx.setState("adm_deadline", { ...ctx.data, price: +digits });
  const suggestion = deadlineLabel(o);
  await ctx.reply(T.ASK_DEADLINE, K.adminDeadlineKb(o.id, suggestion !== "—" ? suggestion : null));
}

export async function onDeadline(ctx: Ctx) {
  const text = String(ctx.msg!.text).trim();
  const len = [...text].length;
  if (len < 2 || len > 60) return void await ctx.reply(T.BAD_DEADLINE_TEXT);
  await finishPrice(ctx, text);
}

async function finishPrice(ctx: Ctx, deadline: string) {
  const { order_id, price } = ctx.data;
  await ctx.clearState();
  let o = (await db.getOrder(order_id))!;
  if (o.paid || !["new", "accepted", "awaiting_payment"].includes(o.status)) return void await ctx.reply(T.PRICE_LOCKED);
  await db.setPrice(o.id, price, prepayAmount(price, ctx.config.prepaymentPercent), deadline);
  if (o.status === "awaiting_payment") await db.setStatus(o.id, "accepted"); // пересчитали цену — клиент заново соглашается
  o = (await db.getOrder(o.id))!;
  await sendOffer(ctx.config, o);
  await refreshOrderCards(ctx.config, o.id);
  await ctx.reply(fmt(T.PRICE_SENT, { code: o.code, price: money(price), deadline: esc(deadline) }));
}

// ---------- сообщение клиенту ----------
export async function onAdminMessage(ctx: Ctx) {
  const orderId = ctx.data.order_id;
  await ctx.clearState();
  const o = (await db.getOrder(orderId))!;
  const ok = await sendAdminMessageToClient(ctx.msg!, o.user_id, o);
  await ctx.reply(ok ? T.MSG_SENT : T.MSG_FAILED, null, ctx.msg!.message_id);
}

// ---------- статус ----------
export async function cbSetStatus(ctx: Ctx, orderId: number, status: string) {
  const o = await actable(ctx, orderId);
  if (!o) return;
  await ctx.answer();
  if (!(T.STATUS_MANUAL as readonly string[]).includes(status)) return;
  await changeStatus(ctx.config, o.id, status);
  await tg.editText(ctx.chatId, ctx.cbMsg.message_id, fmt(T.STATUS_CHANGED, { code: o.code, status: STATUS[status] }));
}

// ---------- готовая работа ----------
export async function onResultFile(ctx: Ctx) {
  const f = tg.extractFile(ctx.msg!)!;
  const files = [...(ctx.data.files ?? []), { file_id: f.file_id, type: f.type, name: f.name }];
  await ctx.updateData({ files });
  await ctx.reply(fmt(T.RESULT_FILE_OK, { n: files.length }), K.adminResultKb(ctx.data.order_id));
}

export async function onResultOther(ctx: Ctx) {
  await ctx.reply(T.FILES_HINT, K.adminResultKb(ctx.data.order_id));
}

async function resultDone(ctx: Ctx) {
  const { files, order_id } = ctx.data;
  if (!files?.length) return void await ctx.answer(T.RESULT_EMPTY, true);
  await ctx.clearState();
  await ctx.answer();
  await tg.editMarkup(ctx.chatId, ctx.cbMsg.message_id, null);
  let o = (await db.getOrder(order_id))!;
  // Новые файлы добавляются к прошлым: вся история работы остаётся у клиента и в админ-панели
  const ids: number[] = [];
  for (const f of files) ids.push(await db.addFile(o.id, "result", f));
  const added = (await db.getFiles(o.id, "result")).filter((f) => ids.includes(f.id));
  await logResultFiles(o, added, (await db.getUser(ctx.uid))?.first_name ?? null);
  const remaining = Math.max(0, (o.price || 0) - o.paid);
  if (remaining > 0) {
    // Предоплата была неполной — сначала доплата, потом файлы
    await changeStatus(ctx.config, o.id, "awaiting_final", { notify: false });
    o = (await db.getOrder(o.id))!;
    await sendPaymentInstructions(ctx.config, o, "final");
    await ctx.reply(fmt(T.RESULT_WAITS_PAYMENT, { amount: money(remaining) }));
    return;
  }
  if (await deliverResult(ctx.config, o.id, added)) await ctx.reply(fmt(T.RESULT_SENT, { code: o.code }));
}

// ---------- передать ----------
export async function cbTransferTo(ctx: Ctx, orderId: number, to: number) {
  const o = await actable(ctx, orderId);
  if (!o) return;
  await ctx.answer();
  if (!ctx.config.isAdmin(to)) return;
  await db.assignOrder(o.id, to);
  await refreshOrderCards(ctx.config, o.id);
  const fresh = (await db.getOrder(o.id))!;
  const by = await adminName(ctx.uid);
  if (to !== ctx.uid) {
    await tg.sendText(to, fmt(T.TRANSFERRED_TO_YOU, { code: fresh.code, by }));
    await sendAdminCard(ctx.config, fresh, to);
  }
  await tg.editText(ctx.chatId, ctx.cbMsg.message_id, fmt(T.TRANSFERRED, { code: fresh.code, name: await adminName(to) }));
}

// ---------- отклонить ----------
export async function onRejectReason(ctx: Ctx) {
  const reason = [...String(ctx.msg!.text).trim()].slice(0, 500).join("");
  const orderId = ctx.data.order_id;
  await ctx.clearState();
  const o = (await db.getOrder(orderId))!;
  await db.setRejectReason(o.id, reason);
  await changeStatus(ctx.config, o.id, "cancelled", { notify: false });
  await notifyClient(ctx.config, o, fmt(T.REJECTED_CLIENT, { code: o.code, reason: esc(reason) }));
  await ctx.reply(fmt(T.REJECTED, { code: o.code }));
}

// ======================= отзывы =======================
export async function cbPublish(ctx: Ctx, reviewId: number) {
  if (!await db.publishReview(reviewId, ctx.uid)) return void await ctx.answer(T.REVIEW_PUBLISHED, true);
  await ctx.answer(T.REVIEW_PUBLISHED);
  const r = (await db.getReview(reviewId))!;
  const o = (await db.getOrder(r.order_id))!;
  const siteError = await pushReviews(); // и на сайт
  if (siteError) await ctx.reply(fmt(T.REVIEW_SITE_FAILED, { error: esc(siteError.slice(0, 300)) }));
  const text = reviewCardText(o, await clientText(r.user_id), r.rating, r.text) +
    fmt(T.REVIEW_PUBLISHED_MARK, { name: await adminName(ctx.uid) });
  await Promise.all((await db.getCards("review", reviewId)).map((c) => tg.editText(c.chat_id, c.message_id, text)));
}

// ======================= команды =======================
async function renderOrders(adminId: number, status: string, mine: number, page: number): Promise<[string, unknown]> {
  const [orders, total] = await db.listOrders(status === "any" ? null : status, mine ? adminId : null, PER_PAGE, page * PER_PAGE);
  let text = fmt(T.ORDERS_TITLE, { scope: mine ? T.SCOPE_MINE : T.SCOPE_ALL, status: STATUS[status] ?? T.STATUS_ANY, n: total });
  if (!total) text += "\n\n" + T.ORDERS_EMPTY;
  return [text, K.ordersFilterKb(status, mine, page, total, orders, PER_PAGE)];
}

export async function cmdOrders(ctx: Ctx) {
  await ctx.clearState();
  const [text, kb] = await renderOrders(ctx.uid, "any", 0, 0);
  await ctx.reply(text, kb as tg.Markup);
}

export async function cbOrders(ctx: Ctx, status: string, mine: number, page: number) {
  await ctx.answer();
  const [text, kb] = await renderOrders(ctx.uid, status, mine, page);
  await tg.editText(ctx.chatId, ctx.cbMsg.message_id, text, kb as tg.Markup);
}

export async function cmdPanel(ctx: Ctx) {
  await ctx.clearState();
  const url = await getWebappUrl(ctx.config);
  if (!url) return void await ctx.reply(T.PANEL_NO_SITE);
  await ctx.reply(T.PANEL_LINK, { inline_keyboard: [[{ text: T.BTN_PANEL, url: adminUrl(url) }]] });
}

export async function cmdOrder(ctx: Ctx, arg: string) {
  await ctx.clearState();
  const o = arg ? await db.getOrderByCode(arg) : null;
  if (!o) return void await ctx.reply(T.ORDER_NOT_FOUND);
  await sendAdminCard(ctx.config, o, ctx.uid);
}

export async function cmdBlock(ctx: Ctx, arg: string, value: boolean) {
  if (!/^-?\d+$/.test(arg)) return void await ctx.reply(value ? T.BLOCK_USAGE : T.UNBLOCK_USAGE);
  const uid = Number(arg);
  if (value && ctx.config.isAdmin(uid)) return void await ctx.reply(T.CANNOT_BLOCK_ADMIN);
  if (!await db.getUser(uid)) await db.upsertUser(uid, null, null); // можно заблокировать и того, кто ещё не писал
  await db.setBlocked(uid, value);
  await ctx.reply(fmt(value ? T.BLOCKED_OK : T.UNBLOCKED_OK, { id: uid }));
}

export async function cmdStats(ctx: Ctx) {
  const s = await db.stats();
  const src = T.SOURCE_LABEL as Record<string, string>;
  // deno-lint-ignore no-explicit-any
  const types = T.WORK_TYPES as Record<string, any>;
  const bySource = s.bySource.map((r) => `• ${src[r.source] ?? r.source}: ${r.n}`).join("\n") || "—";
  const byType = s.byType.map((r) => `• ${types[r.type]?.name ?? r.type}: ${r.n}`).join("\n") || "—";
  const byAdmin = s.byAdmin.map((r) => `• ${esc(r.first_name || r.admin_id)}: ${r.n} заказ(ов), оплачено ${money(r.paid)}`).join("\n") || "—";
  const conv = s.total ? `${Math.round(100 * s.paidOrders / s.total)}%` : "—";
  await ctx.reply(fmt(T.STATS, {
    total: s.total, week: s.week, month: s.month, paid_sum: money(s.paidSum), avg: s.avg ? money(s.avg) : "—", conv,
    paid_orders: s.paidOrders, users: s.users, users_site: s.usersSite, by_source: bySource, by_type: byType, by_admin: byAdmin,
  }));
}

export async function cmdAdmins(ctx: Ctx) {
  const counts = await db.activeCountByAdmin();
  const lines = [T.ADMINS_TITLE, ""];
  for (const id of ctx.config.adminIds) {
    const u = await db.getUser(id);
    const name = u?.first_name ? esc(u.first_name) : T.ADMIN_NOT_STARTED;
    lines.push(fmt(T.ADMINS_LINE, { mark: ctx.config.isOwner(id) ? "👑" : "👤", name, id, n: counts.get(id) ?? 0 }));
  }
  await ctx.reply(lines.join("\n"));
}

export async function cmdBroadcast(ctx: Ctx) {
  await ctx.setState("adm_broadcast", {});
  await ctx.reply(T.BROADCAST_ASK, K.adminCancelKb(0));
}

export async function onBroadcastMessage(ctx: Ctx) {
  await ctx.updateData({ chat_id: ctx.chatId, message_id: ctx.msg!.message_id });
  await ctx.reply(fmt(T.BROADCAST_CONFIRM, { n: await db.countBroadcastTargets() }), K.broadcastKb());
}

/** Возвращает true, если рассылка запущена (её разошлют фоновые задачи). */
export async function cbBroadcast(ctx: Ctx, action: string): Promise<boolean> {
  const data = ctx.data;
  await ctx.clearState();
  await ctx.answer();
  if (action !== "go" || !data.message_id) {
    await tg.editText(ctx.chatId, ctx.cbMsg.message_id, T.ADMIN_CANCELLED);
    return false;
  }
  await tg.editText(ctx.chatId, ctx.cbMsg.message_id, T.BROADCAST_STARTED);
  await db.exec("insert into bot_broadcasts(owner_id, from_chat, message_id) values($1, $2, $3)", [ctx.uid, data.chat_id, data.message_id]);
  return true;
}

/** Рассылка порциями (≈20 сообщений/с — ниже лимита Telegram); не успели — продолжим в следующий раз. */
export async function runBroadcasts(budgetMs = 100_000, pauseMs = 50) {
  const started = Date.now();
  for (const b of await db.q("select * from bot_broadcasts where state = 'running' order by id")) {
    let { last_user, ok, blocked, failed } = b;
    while (Date.now() - started < budgetMs) {
      const batch = await db.broadcastTargets(last_user, 50);
      if (!batch.length) break;
      for (const uid of batch) {
        if (Date.now() - started >= budgetMs) break;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await tg.api("copyMessage", { chat_id: uid, from_chat_id: b.from_chat, message_id: b.message_id });
            ok++;
            break;
          } catch (e) {
            if (e instanceof tg.TgError && e.code === 429) {
              await new Promise((r) => setTimeout(r, Math.min(e.retryAfter + 1, 10) * 1000));
              continue;
            }
            if (e instanceof tg.TgError && e.code === 403) {
              await db.setBotBlocked(uid, true);
              blocked++;
            } else failed++;
            break;
          }
        }
        last_user = uid;
        await new Promise((r) => setTimeout(r, pauseMs));
      }
      await db.exec("update bot_broadcasts set last_user = $1, ok = $2, blocked = $3, failed = $4 where id = $5",
        [last_user, ok, blocked, failed, b.id]);
    }
    if ((await db.broadcastTargets(last_user, 1)).length) return; // время вышло — продолжим позже
    if (await db.exec("update bot_broadcasts set state = 'done' where id = $1 and state = 'running'", [b.id])) {
      await tg.sendText(b.owner_id, fmt(T.BROADCAST_DONE, { ok, blocked, failed }));
    }
  }
}

// ======================= ответ клиенту реплаем =======================
export async function onAdminReply(ctx: Ctx) {
  const m = ctx.msg!;
  const link = await db.lookupMessage(ctx.chatId, m.reply_to_message.message_id);
  if (!link) return void await ctx.reply(T.ADMIN_NOT_REPLY);
  const o = link.order_id ? await db.getOrder(link.order_id) : null;
  const ok = await sendAdminMessageToClient(m, link.user_id, o);
  await ctx.reply(ok ? T.MSG_SENT : T.MSG_FAILED, null, m.message_id);
}

// ======================= /setsite (только владелец) =======================
async function saveUrl(ctx: Ctx, raw: string): Promise<boolean> {
  const url = normalizeSiteUrl(raw); // ссылку из панели Netlify превращаем в адрес сайта
  if (!isValidHttpsUrl(url)) return void await ctx.reply(T.SITE_BAD), false;
  if (isDashboardUrl(url)) return void await ctx.reply(T.SITE_IS_DASHBOARD), false;
  await db.setSetting("webapp_url", url);
  resetUrlCache();
  await applyMenuButton(url); // кнопка меню обновляется у всех сразу
  await ctx.reply(fmt(T.SITE_UPDATED, { url: esc(url) }), K.siteInline(url, T.BTN_SITE_TEST));
  await ctx.reply(T.MENU_HINT, K.mainMenu(url, K.adminPanelUrl(url))); // и у себя — reply-клавиатура
  return true;
}

export async function cmdSetsite(ctx: Ctx, arg: string) {
  await ctx.clearState();
  if (arg) return void await saveUrl(ctx, arg);
  const url = await getWebappUrl(ctx.config);
  await ctx.reply(url ? fmt(T.SITE_CURRENT, { url: esc(url) }) : T.SITE_CURRENT_NONE, K.siteSettingsKb(!!url));
}

export async function cbSite(ctx: Ctx, action: string) {
  await ctx.answer();
  if (action === "edit") {
    await ctx.setState("site_url", {});
    await ctx.reply(T.SITE_ASK);
    return;
  }
  await ctx.clearState();
  resetUrlCache();
  await db.setSetting("webapp_url", ""); // пустая строка = «ссылки нет» (и секрет WEBAPP_URL не подставляется)
  await applyMenuButton(null);
  await tg.editText(ctx.chatId, ctx.cbMsg.message_id, T.SITE_REMOVED);
  await ctx.reply(T.MENU_HINT, K.mainMenu(null));
}

export async function onNewUrl(ctx: Ctx) {
  if (await saveUrl(ctx, String(ctx.msg!.text).trim())) await ctx.clearState();
}
