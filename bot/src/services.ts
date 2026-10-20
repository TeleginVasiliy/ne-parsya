// Общая логика, которой пользуются разные обработчики.
import { T } from "./texts.ts";
import type { Config } from "./config.ts";
import * as db from "./db.ts";
import type { Order } from "./db.ts";
import * as K from "./kb.ts";
import * as screen from "./screen.ts";
import * as tg from "./tg.ts";
import type { Msg } from "./tg.ts";
import { esc, fmt, fmtDt, isIsoDate, money, ruDate, userLink } from "./util.ts";

const STATUS = T.STATUS as Record<string, string>;
const STATUS_CLIENT = T.STATUS_CLIENT as Record<string, string>;
// deno-lint-ignore no-explicit-any
const WORK_TYPES = T.WORK_TYPES as Record<string, any>;
export const statusLabel = (s: string) => STATUS[s] ?? s;

// ======================= ссылка на сайт и команды =======================

// Страницы входа и панели управления — это не сайт: в мини-приложении они просят логин
export const NOT_A_SITE = new Set(["app.netlify.com", "netlify.com", "www.netlify.com", "github.com", "www.github.com",
  "gitlab.com", "www.gitlab.com", "accounts.google.com", "vercel.com", "supabase.com", "app.supabase.com"]);

/** Ссылку из панели Netlify (app.netlify.com/sites/имя или /projects/имя) превращает в адрес самого сайта. */
export function normalizeSiteUrl(raw: string): string {
  const url = raw.trim();
  try {
    const u = new URL(url);
    const m = /^\/(?:sites|projects)\/([a-z0-9-]+)/i.exec(u.pathname);
    if (u.hostname.toLowerCase() === "app.netlify.com" && m) return `https://${m[1].toLowerCase()}.netlify.app`;
  } catch {
    // не ссылка — вернём как есть, проверка ниже скажет, что не так
  }
  return url;
}

export function isDashboardUrl(url: string): boolean {
  try {
    return NOT_A_SITE.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Ссылка из базы (её задаёт /setsite) или из секрета WEBAPP_URL. Пусто — ссылки нет. */
let urlCache: { at: number; value: string | null } | null = null;
export function resetUrlCache() {
  urlCache = null;
}

export async function getWebappUrl(config: Config): Promise<string | null> {
  if (!urlCache || Date.now() - urlCache.at > 15_000) urlCache = { at: Date.now(), value: await db.getSetting("webapp_url") };
  const saved = urlCache.value;
  // /setsite главнее секрета (пустая строка — «убрана»)
  const url = normalizeSiteUrl(saved !== null ? saved : config.webappUrl);
  return url && !isDashboardUrl(url) ? url : null;
}

/** Синяя кнопка слева от поля ввода — у всех пользователей сразу. */
export async function applyMenuButton(url: string | null) {
  const button = url ? { type: "web_app", text: T.MENU_WEBAPP_TEXT, web_app: { url: K.siteUrl(url, "menu") } } : { type: "commands" };
  await tg.call("setChatMenuButton", { menu_button: button });
}

function siteBase(siteUrl: string): string {
  let base = siteUrl.split("?", 1)[0].split("#", 1)[0];
  if (!base.endsWith("/")) {
    const last = base.split("/").pop() ?? "";
    base = base.split("/").length > 3 && last.includes(".") ? base.slice(0, base.lastIndexOf("/") + 1) : base + "/";
  }
  return base;
}

export function cabinetUrl(siteUrl: string, token: string, bot: string): string {
  return `${siteBase(siteUrl)}cabinet.html?t=${encodeURIComponent(token)}` + (bot ? `&bot=${bot}` : "");
}

export const adminUrl = (siteUrl: string) => `${siteBase(siteUrl)}admin.html`;

/** Ссылка на личный кабинет клиента на сайте. */
export async function cabinetLink(config: Config, userId: number): Promise<string | null> {
  const url = await getWebappUrl(config);
  return url ? cabinetUrl(url, await db.siteToken(userId), K.BOT_USERNAME) : null;
}

const cmd = (command: string, description: string) => ({ command, description });
export const CLIENT_COMMANDS = [
  cmd("start", "Главное меню"), cmd("site", "Открыть сайт и собрать заказ"), cmd("new", "Оформить заказ в боте"),
  cmd("my", "Мои заказы"), cmd("faq", "Вопросы и ответы"),
];
export const ADMIN_COMMANDS = [
  cmd("panel", "Админ-панель на сайте"), cmd("id", "Мой числовой ID"), cmd("orders", "Заказы с фильтрами"),
  cmd("order", "Карточка заказа: /order A7K2"), cmd("block", "Заблокировать: /block id"), cmd("unblock", "Разблокировать: /unblock id"),
];
export const OWNER_COMMANDS = [
  cmd("setsite", "Ссылка на сайт"), cmd("stats", "Статистика"), cmd("broadcast", "Рассылка всем"), cmd("admins", "Админы и их заказы"),
];

/** Клиенты видят только свои команды; админы и владелец — расширенные списки. */
export async function setupCommands(config: Config, onlyChat?: number) {
  if (onlyChat === undefined) await tg.call("setMyCommands", { commands: CLIENT_COMMANDS, scope: { type: "default" } });
  for (const adminId of config.adminIds) {
    if (onlyChat !== undefined && adminId !== onlyChat) continue;
    const cmds = [...CLIENT_COMMANDS, ...ADMIN_COMMANDS, ...(config.isOwner(adminId) ? OWNER_COMMANDS : [])];
    // У админа, который ещё не нажимал /start, Telegram вернёт ошибку — это нормально
    await tg.call("setMyCommands", { commands: cmds, scope: { type: "chat", chat_id: adminId } });
  }
}

// ======================= тексты заказа =======================

// deno-lint-ignore no-explicit-any
export function deadlineLabel(orderOrData: Record<string, any>): string {
  const data = orderOrData.data ?? orderOrData;
  const dl = data.deadline;
  if (dl === "flex") return "не горит";
  if (dl) return isIsoDate(dl) ? ruDate(dl) : esc(dl);
  return "—";
}

export const typeName = (o: Order) => (WORK_TYPES[o.data?.type] ?? WORK_TYPES.other).name as string;

// deno-lint-ignore no-explicit-any
export function linesText(data: Record<string, any>): string {
  return (data.lines ?? []).map(([icon, label, value]: string[]) => `${esc(icon)} <b>${esc(label)}:</b> ${esc(value)}`).join("\n");
}

export async function adminName(adminId: number | null | undefined): Promise<string> {
  if (!adminId) return "—";
  const u = await db.getUser(adminId);
  return esc(u?.first_name || String(adminId));
}

export async function clientText(userId: number): Promise<string> {
  const u = await db.getUser(userId);
  return userLink(userId, u?.first_name, u?.username);
}

export async function adminCardText(config: Config, o: Order, title?: string): Promise<string> {
  let price = "";
  if (o.price) {
    price = fmt(T.ADMIN_PRICE_LINE, { price: money(o.price), deadline: esc(o.deadline_text || "—"), paid: money(o.paid) });
  }
  if (o.reject_reason) price += fmt(T.ADMIN_REJECT_LINE, { reason: esc(o.reject_reason) });
  return fmt(T.ADMIN_CARD, {
    title: title ?? fmt(T.ADMIN_CARD_TITLE, { code: o.code }),
    source: (T.SOURCE_LABEL as Record<string, string>)[o.source] ?? o.source,
    created: fmtDt(o.created_at, config.tz),
    client: await clientText(o.user_id),
    status: statusLabel(o.status),
    admin: o.admin_id ? await adminName(o.admin_id) : T.ADMIN_NOBODY,
    price,
    lines: linesText(o.data),
  });
}

export function clientOrderText(o: Order): string {
  const parts = [`🧾 <b>Заказ #${o.code}</b>`, `Статус: <b>${statusLabel(o.status)}</b>`];
  if (o.price) {
    parts.push(`Цена: <b>${money(o.price)}</b> · срок: ${esc(o.deadline_text || "—")}`);
    if (o.paid) parts.push(`Оплачено: ${money(o.paid)}`);
  }
  if (o.reject_reason) parts.push(`Причина отмены: ${esc(o.reject_reason)}`);
  parts.push("", linesText(o.data));
  return parts.join("\n");
}

// ======================= карточки у админов =======================

export async function sendAdminCard(config: Config, o: Order, adminId: number, title?: string): Promise<Msg | null> {
  let text = await adminCardText(config, o, title);
  if (o.admin_id && o.admin_id !== adminId && !config.isOwner(adminId)) text += fmt(T.ADMIN_TAKEN_BY, { name: await adminName(o.admin_id) });
  const msg = await tg.sendText(adminId, text, K.adminCardKb(o, adminId, config));
  if (msg) {
    await db.addCard(adminId, msg.message_id, "order", o.id);
    await db.mapMessage(adminId, msg.message_id, o.user_id, o.id);
  }
  return msg;
}

/** Перерисовывает карточку заказа у всех админов (статус, ответственный, кнопки). */
export async function refreshOrderCards(config: Config, orderId: number) {
  const o = await db.getOrder(orderId);
  if (!o) return;
  const base = await adminCardText(config, o);
  const taken = o.admin_id ? fmt(T.ADMIN_TAKEN_BY, { name: await adminName(o.admin_id) }) : "";
  await Promise.all((await db.getCards("order", orderId)).map((card) => {
    const viewer = card.chat_id;
    const text = o.admin_id && o.admin_id !== viewer && !config.isOwner(viewer) ? base + taken : base;
    return tg.editText(card.chat_id, card.message_id, text, K.adminCardKb(o, viewer, config) ?? { inline_keyboard: [] });
  }));
}

/** Отправляет файл заказа. Файл из админ-панели (ссылка на хранилище) после первой отправки
 *  запоминается по идентификатору Telegram — повторно он уходит мгновенно. */
export async function sendStoredFile(chatId: number, f: db.Row, caption?: string | null, markup?: tg.Markup): Promise<Msg | null> {
  const msg = await tg.sendFile(chatId, f.file_type, f.file_id, caption, markup, f.file_name);
  const tgId = tg.sentFileId(msg);
  if (msg && tgId && /^https?:/.test(f.file_id)) await db.setFileTgId(f.id, tgId);
  return msg;
}

export async function sendOrderFiles(o: Order, chatId: number, kind = "client"): Promise<number> {
  const files = await db.getFiles(o.id, kind);
  for (const f of files) {
    const msg = await sendStoredFile(chatId, f, fmt(T.ADMIN_FILE_CAPTION, { code: o.code }));
    if (msg) await db.mapMessage(chatId, msg.message_id, o.user_id, o.id);
  }
  return files.length;
}

/** Новый заказ — всем админам: карточка, затем файлы. */
export async function notifyNewOrder(config: Config, o: Order) {
  const title = fmt(T.ADMIN_NEW_ORDER, { code: o.code });
  for (const adminId of config.adminIds) {
    if (await sendAdminCard(config, o, adminId, title)) await sendOrderFiles(o, adminId);
  }
}

/** Кому писать о заказе: ответственному (+ копия владельцу) или всем, если никто не взял. */
export function orderAdminTargets(config: Config, o: Order | null): number[] {
  if (o?.admin_id) {
    const targets = [o.admin_id];
    if (config.ownerId && !targets.includes(config.ownerId)) targets.push(config.ownerId);
    return targets;
  }
  return [...config.adminIds];
}

export async function notifyOrderAdmins(config: Config, o: Order, text: string) {
  for (const adminId of orderAdminTargets(config, o)) {
    const msg = await tg.sendText(adminId, text);
    if (msg) await db.mapMessage(adminId, msg.message_id, o.user_id, o.id);
  }
}

/** Пишет клиенту. Если он заблокировал бота — сообщает ответственным админам. */
export async function notifyClient(config: Config, o: Order, text: string, markup?: { inline_keyboard: unknown[][] } | null): Promise<boolean> {
  // Уведомление — новый «экран» клиента; к нему кнопка «Открыть заказ», где вся информация
  // deno-lint-ignore no-explicit-any
  const msg = await screen.newScreen(o.user_id, text, K.withOrderButton(markup as any, o.id));
  if (!msg) {
    await warnClientUnreachable(config, o);
    return false;
  }
  return true;
}

/** Почему клиенту не ушло сообщение — понятным текстом (для админов и журнала панели). */
export function undeliveredReason(userId: number): string {
  const e = tg.failureOf(userId);
  if (tg.isBlockedError(e)) return "клиент заблокировал бота";
  return e ? `Telegram не принял сообщение: ${e.description || e.code}` : "Telegram не принял сообщение";
}

export async function warnClientUnreachable(config: Config, o: Order) {
  const e = tg.failureOf(o.user_id);
  const warn = tg.isBlockedError(e)
    ? fmt(T.CLIENT_BLOCKED_BOT, { client: await clientText(o.user_id), code: o.code })
    : fmt(T.CLIENT_NOT_DELIVERED, { client: await clientText(o.user_id), code: o.code, reason: esc(e?.description || "без описания") });
  for (const adminId of orderAdminTargets(config, o)) await tg.sendText(adminId, warn);
}

// ======================= статусы и оплата =======================

export async function changeStatus(config: Config, orderId: number, status: string, opts: { notify?: boolean; expected?: string[] } = {}): Promise<boolean> {
  if (!await db.setStatus(orderId, status, opts.expected)) return false;
  const o = (await db.getOrder(orderId))!;
  if ((opts.notify ?? true) && STATUS_CLIENT[status]) await notifyClient(config, o, fmt(STATUS_CLIENT[status], { code: o.code }));
  await refreshOrderCards(config, orderId);
  return true;
}

/** Админ взял заказ (или занялся им) — клиент видит «Принят». Только из «Новый». */
export async function markAccepted(config: Config, orderId: number, notify = true) {
  await changeStatus(config, orderId, "accepted", { expected: ["new"], notify });
}

export const prepayAmount = (price: number, percent: number) => Math.max(1, Math.ceil(price * percent / 100));

/** Сколько клиенту платить сейчас: предоплату или остаток. */
export function amountDue(o: Order, kind: string): number {
  if (kind === "prepay") return Math.max(0, (o.prepay || o.price || 0) - o.paid);
  return Math.max(0, (o.price || 0) - o.paid);
}

export function offerText(config: Config, o: Order): string {
  const payLine = (o.prepay ?? 0) >= (o.price ?? 0)
    ? fmt(T.OFFER_PAY_FULL, { amount: money(o.price) })
    : fmt(T.OFFER_PAY_PART, { amount: money(o.prepay), percent: config.prepaymentPercent });
  return fmt(T.OFFER, { code: o.code, price: money(o.price), deadline: esc(o.deadline_text || "—"), pay_line: payLine });
}

export async function sendOffer(config: Config, o: Order): Promise<boolean> {
  return await notifyClient(config, o, offerText(config, o), K.offerKb(o.id));
}

/** Реквизиты: текст из PAYMENT_DETAILS плюс номер для СБП и карта (если заданы). */
export function paymentDetailsText(config: Config): string {
  const parts: string[] = [];
  if (config.paymentDetails) parts.push(config.paymentDetails);
  const p = config.pay;
  if (p.phone && !config.paymentDetails.includes(p.phone)) {
    parts.push(fmt(T.PAY_SBP_LINE, {
      phone: esc(p.phone), bank: p.bank ? `, банк получателя: <b>${esc(p.bank)}</b>` : "",
      bank_step: p.bank ? ` и выберите банк получателя — <b>${esc(p.bank)}</b>` : " и выберите банк получателя",
    }));
  }
  if (p.card && !config.paymentDetails.replace(/\s/g, "").includes(p.card.replace(/\s/g, ""))) {
    parts.push(fmt(T.PAY_CARD_LINE, { card: esc(p.card) }));
  }
  return parts.join("\n\n") || T.NO_PAYMENT_DETAILS;
}

export function paymentText(config: Config, o: Order, kind: string): string {
  const template = kind === "final" ? T.PAY_INSTRUCTIONS_FINAL : T.PAY_INSTRUCTIONS;
  return fmt(template, { code: o.code, amount: money(amountDue(o, kind)), details: paymentDetailsText(config) });
}

export const paymentKb = (config: Config, o: Order, kind: string) =>
  K.payKb(o.id, kind === "final", config.pay, amountDue(o, kind), o.code);

export async function sendPaymentInstructions(config: Config, o: Order, kind: string): Promise<boolean> {
  return await notifyClient(config, o, paymentText(config, o, kind), paymentKb(config, o, kind));
}

/** Отправляет клиенту готовую работу и переводит заказ «На проверке». */
export async function deliverResult(config: Config, orderId: number): Promise<boolean> {
  const o = (await db.getOrder(orderId))!;
  const files = await db.getFiles(orderId, "result");
  // Прежний экран убираем только когда всё дошло — иначе клиент остался бы с пустым чатом
  const before = await screen.begin(o.user_id);
  const sent: number[] = [];
  for (const f of files) {
    const msg = await sendStoredFile(o.user_id, f);
    if (!msg) {
      await warnClientUnreachable(config, o);
      if (sent.length) await screen.commit(o.user_id, { ...before, ids: [] }, sent); // дошедшие файлы — в экран
      return false;
    }
    sent.push(msg.message_id); // файлы — часть экрана, их можно получить снова
  }
  const done = await tg.sendText(o.user_id, fmt(T.RESULT_DELIVERED, { code: o.code }), K.withOrderButton(K.acceptWorkKb(orderId), orderId));
  if (done) sent.push(done.message_id);
  await screen.commit(o.user_id, before, sent);
  await changeStatus(config, orderId, "review", { notify: false });
  return true;
}

// ======================= переписка =======================

/** Пересылает сообщение клиента админам с пометкой «от кого и по какому заказу». */
export async function relayToAdmins(config: Config, m: Msg, o: Order | null): Promise<number> {
  const client = await clientText(m.from.id);
  const where = o ? fmt(T.ADMIN_MSG_ORDER, { code: o.code, status: statusLabel(o.status) }) : T.ADMIN_MSG_NO_ORDER;
  const header = fmt(T.ADMIN_MSG_FROM, { client, order: where }) + T.ADMIN_REPLY_HINT;
  let delivered = 0;
  for (const adminId of orderAdminTargets(config, o)) {
    let ids: number[];
    if (m.text) {
      // Текст — одним сообщением вместе с пометкой
      const msg = await tg.sendText(adminId, `${header}\n\n${esc(m.text)}`);
      ids = msg ? [msg.message_id] : [];
    } else {
      const head = await tg.sendText(adminId, header);
      const copy = await tg.copyMessage(adminId, m.chat.id, m.message_id);
      ids = [head, copy].filter(Boolean).map((x) => x!.message_id);
    }
    for (const mid of ids) await db.mapMessage(adminId, mid, m.from.id, o?.id ?? null);
    if (ids.length) delivered++;
  }
  return delivered;
}

/** Ответ админа уходит клиенту от имени бота. */
export async function sendAdminMessageToClient(m: Msg, userId: number, o: Order | null): Promise<boolean> {
  const header = fmt(T.ADMIN_REPLY_HEADER, { order: o ? fmt(T.ADMIN_REPLY_ORDER, { code: o.code }) : "" });
  if (m.text) return !!await screen.newScreen(userId, `${header}\n\n${esc(m.text)}`);
  // Ответ исполнителя — новый экран клиента; прежний убираем, только если ответ дошёл
  const before = await screen.begin(userId);
  const noCaption = !!(m.video_note || m.sticker || m.dice || m.location || m.contact);
  const ids: number[] = [];
  let result: Msg | null;
  if (noCaption) {
    const head = await tg.sendText(userId, header);
    if (!head) return false;
    ids.push(head.message_id);
    result = await tg.copyMessage(userId, m.chat.id, m.message_id);
  } else {
    const caption = header + (m.caption ? `\n\n${esc(m.caption)}` : "");
    result = await tg.copyMessage(userId, m.chat.id, m.message_id, caption.slice(0, 1024));
  }
  if (result) ids.push(result.message_id);
  if (ids.length) await screen.commit(userId, result ? before : { ...before, ids: [] }, ids);
  return !!result;
}
