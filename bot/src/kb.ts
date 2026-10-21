// Клавиатуры и данные кнопок (формат «префикс:значение:значение», как раньше).
import { T } from "./texts.ts";
import type { Config, PayOptions } from "./config.ts";
import type { Order } from "./db.ts";
import { withParam } from "./util.ts";

type Btn = Record<string, unknown>;
type Inline = { inline_keyboard: Btn[][] };

export const cb = (...parts: (string | number)[]) => parts.join(":");
const btn = (text: string, data: string): Btn => ({ text, callback_data: data });
const inline = (rows: Btn[][]): Inline => ({ inline_keyboard: rows });

/** Раскладка кнопок по рядам: adjust(2) — по две; adjust(1, 2) — 1, потом по 2. */
function adjust(buttons: Btn[], ...sizes: number[]): Btn[][] {
  const rows: Btn[][] = [];
  let i = 0, s = 0;
  while (i < buttons.length) {
    const size = sizes[Math.min(s, sizes.length - 1)];
    rows.push(buttons.slice(i, i + size));
    i += size;
    s++;
  }
  return rows;
}

// ---------------- ссылки на сайт ----------------
// Параметр from подсказывает сайту, как его открыли:
// kb — reply-кнопка (доступен sendData), menu/inline — кнопка меню или под сообщением.
export let BOT_USERNAME = "";
export function setBotUsername(name: string) {
  BOT_USERNAME = name;
}

export function siteUrl(url: string, how: string): string {
  const u = withParam(url, "from", how);
  return BOT_USERNAME ? withParam(u, "bot", BOT_USERNAME) : u;
}

// ---------------- клиент ----------------
/** Адрес админ-панели рядом с сайтом: …/ne-parsya/ → …/ne-parsya/admin.html */
export function adminPanelUrl(webappUrl: string | null): string | null {
  if (!webappUrl) return null;
  try {
    const u = new URL(webappUrl);
    if (!u.pathname.endsWith("/") && !/\.[a-z0-9]+$/i.test(u.pathname)) u.pathname += "/";
    return new URL("admin.html", u.origin + u.pathname).href;
  } catch {
    return null;
  }
}

/** adminUrl — только у админов: кнопка «Админ-панель» внизу клавиатуры. */
export function mainMenu(webappUrl: string | null, adminUrl: string | null = null) {
  const rows: Btn[][] = [];
  if (webappUrl) rows.push([{ text: T.BTN_SITE, web_app: { url: siteUrl(webappUrl, "kb") } }]);
  rows.push(
    [{ text: T.BTN_ORDER }, { text: T.BTN_MY }],
    [{ text: T.BTN_EXAMPLES }, { text: T.BTN_REVIEWS }],
    [{ text: T.BTN_FAQ }, { text: T.BTN_CONTACT }],
  );
  if (adminUrl) rows.push([{ text: T.BTN_ADMIN_PANEL, web_app: { url: adminUrl } }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, input_field_placeholder: T.INPUT_PLACEHOLDER };
}

export function startInline(webappUrl: string | null): Inline {
  const rows: Btn[][] = [];
  if (webappUrl) rows.push([{ text: T.BTN_OPEN_SITE, web_app: { url: siteUrl(webappUrl, "inline") } }]);
  rows.push([btn(T.BTN_ORDER_IN_BOT, cb("c", "new", 0))]);
  return inline(rows);
}

export function siteInline(webappUrl: string, text: string = T.BTN_OPEN_SITE): Inline {
  return inline([[{ text, web_app: { url: siteUrl(webappUrl, "inline") } }]]);
}

export const offerKb = (o: number) => inline([[btn(T.BTN_AGREE, cb("c", "agree", o))], [btn(T.BTN_DISCUSS, cb("c", "discuss", o))]]);

/** Кнопки оплаты: ссылки банков, «Скопировать» номер/карту/сумму, «Я оплатил». */
export function payKb(o: number, final = false, pay?: PayOptions | null, amount?: number, code?: string): Inline {
  const rows: Btn[][] = [];
  // Номер телефона и сумма видны в тексте (номер копируется нажатием), кнопками — только карта и номер заказа
  const copy: Btn[] = [];
  if (pay?.card) copy.push({ text: "📋 Номер карты", copy_text: { text: pay.card.replace(/\s/g, "") } });
  if (code && (pay?.phone || pay?.card)) copy.push({ text: `📋 Номер заказа`, copy_text: { text: code } });
  if (copy.length) rows.push(copy);
  rows.push([btn(T.BTN_PAID, cb("c", "receipt", o))]);
  if (!final) rows.push([btn(T.BTN_CANCEL_ORDER, cb("c", "cancel", o))]);
  return inline(rows);
}

export const resendReceiptKb = (o: number) => inline([[btn(T.BTN_RESEND_RECEIPT, cb("c", "receipt", o))]]);
export const backToOrderKb = (o: number) => inline([[btn(T.BTN_TO_ORDER, cb("c", "open", o))]]);

/** К уведомлению добавляет кнопку «Открыть заказ» — вся информация там. */
export function withOrderButton(markup: Inline | null | undefined, o: number): Inline {
  return inline([...(markup?.inline_keyboard ?? []), [btn(T.BTN_TO_ORDER, cb("c", "open", o))]]);
}

export const cancelConfirmKb = (o: number) =>
  inline([[btn(T.BTN_CANCEL_CONFIRM, cb("c", "cancel_yes", o)), btn(T.BTN_CANCEL_KEEP, cb("c", "open", o))]]);
export const acceptWorkKb = (o: number) => inline([[btn(T.BTN_ACCEPT_WORK, cb("c", "accept", o))]]);

function typeOf(o: Order) {
  // deno-lint-ignore no-explicit-any
  return (T.WORK_TYPES as any)[o.data?.type] ?? T.WORK_TYPES.other;
}
const statusIcon = (s: string) => ((T.STATUS as Record<string, string>)[s] ?? s).split(" ", 1)[0];

export function myOrdersKb(orders: Order[], cabinet?: string | null): Inline {
  const rows: Btn[][] = [];
  if (cabinet) rows.push([{ text: T.BTN_CABINET, web_app: { url: cabinet } }]); // кабинет на сайте
  for (const o of orders) rows.push([btn(`${statusIcon(o.status)} #${o.code} · ${typeOf(o).name}`, cb("c", "open", o.id))]);
  return inline(rows);
}

export function orderDetailKb(o: Order): Inline {
  const b: Btn[] = [];
  if ((o.status === "new" || o.status === "accepted") && o.price) b.push(btn(T.BTN_AGREE, cb("c", "agree", o.id)));
  if (o.status === "awaiting_payment") b.push(btn(T.BTN_PAY, cb("c", "pay", o.id)));
  if (o.status === "awaiting_final") b.push(btn(T.BTN_PAY_FINAL, cb("c", "pay", o.id)));
  if (o.status === "review") b.push(btn(T.BTN_ACCEPT_WORK, cb("c", "accept", o.id)));
  if (o.status === "review" || o.status === "done") b.push(btn(T.BTN_GET_WORK, cb("c", "files", o.id)));
  if (o.status !== "cancelled") b.push(btn(T.BTN_WRITE_ORDER, cb("c", "write", o.id)));
  if (["new", "accepted", "awaiting_payment"].includes(o.status) && !o.paid) b.push(btn(T.BTN_CANCEL_ORDER, cb("c", "cancel", o.id)));
  b.push(btn(T.BTN_TO_LIST, cb("c", "list", 0)));
  return inline(adjust(b, 1));
}

export function pagerKb(kind: string, index: number, total: number): Inline | null {
  if (total <= 1) return null;
  const prev = (index - 1 + total) % total, next = (index + 1) % total;
  return inline([[btn("◀️", cb("pg", kind, prev)), btn(`${index + 1} / ${total}`, cb("pg", kind, index)), btn("▶️", cb("pg", kind, next))]]);
}

export const ratingKb = (o: number) => inline([[1, 2, 3, 4, 5].map((r) => btn(`${r} ⭐`, cb("rv", o, r)))]);
export const skipReviewKb = (o: number) => inline([[btn(T.BTN_SKIP, cb("rv", o, 0))]]);

// ---------------- админ ----------------
export function adminCardKb(o: Order, viewer: number, config: Config): Inline | null {
  const owner = config.isOwner(viewer);
  const responsible = o.admin_id === viewer;
  const b: Btn[] = [];
  if (o.admin_id === null) b.push(btn(T.BTN_TAKE, cb("a", "take", o.id)));
  else if (!(responsible || owner)) return null; // заказ ведёт другой админ — у этого кнопок нет
  if (["new", "accepted", "awaiting_payment"].includes(o.status) && !o.paid) b.push(btn(T.BTN_PRICE, cb("a", "price", o.id)));
  b.push(btn(T.BTN_MSG, cb("a", "msg", o.id)));
  b.push(btn(T.BTN_STATUS, cb("a", "status", o.id)));
  if (["in_work", "review", "new", "accepted", "awaiting_payment"].includes(o.status)) b.push(btn(T.BTN_RESULT, cb("a", "result", o.id)));
  if (config.adminIds.length > 1) b.push(btn(T.BTN_TRANSFER, cb("a", "transfer", o.id)));
  if (o.status !== "done" && o.status !== "cancelled") b.push(btn(T.BTN_REJECT, cb("a", "reject", o.id)));
  b.push(btn(T.BTN_FILES, cb("a", "files", o.id)));
  return inline(adjust(b, 1, 2, 2, 2, 2));
}

export const adminCancelKb = (o: number) => inline([[btn(T.BTN_ADMIN_CANCEL, cb("a", "cancel", o))]]);

export function adminDeadlineKb(o: number, suggestion: string | null): Inline {
  const rows: Btn[][] = [];
  if (suggestion) rows.push([btn(T.BTN_AS_IN_ORDER.replace("{value}", suggestion).slice(0, 60), cb("a", "dl_same", o))]);
  rows.push([btn(T.BTN_ADMIN_CANCEL, cb("a", "cancel", o))]);
  return inline(rows);
}

export const adminResultKb = (o: number) =>
  inline([[btn(T.BTN_DONE, cb("a", "result_done", o)), btn(T.BTN_ADMIN_CANCEL, cb("a", "cancel", o))]]);

export function statusKb(o: Order): Inline {
  const b: Btn[] = [];
  for (const s of T.STATUS_MANUAL) if (s !== o.status) b.push(btn((T.STATUS as Record<string, string>)[s], cb("st", o.id, s)));
  b.push(btn(T.BTN_ADMIN_CANCEL, cb("a", "cancel", o.id)));
  return inline(adjust(b, 2));
}

export function transferKb(o: number, admins: [number, string][]): Inline {
  return inline([...admins.map(([id, name]) => [btn(name, cb("tr", o, id))]), [btn(T.BTN_ADMIN_CANCEL, cb("a", "cancel", o))]]);
}

export const paymentCardKb = (p: number) => inline([[btn(T.BTN_PAY_OK, cb("p", "ok", p))], [btn(T.BTN_PAY_NO, cb("p", "no", p))]]);
export const publishKb = (r: number) => inline([[btn(T.BTN_PUBLISH, cb("pub", r))]]);

export function ordersFilterKb(status: string, mine: number, page: number, total: number, orders: Order[], perPage: number): Inline {
  const rows: Btn[][] = orders.map((o) => [btn(`${statusIcon(o.status)} #${o.code} · ${typeOf(o).name}`, cb("a", "open", o.id))]);
  const nav: Btn[] = [];
  if (page > 0) nav.push(btn("◀️", cb("ol", status, mine, page - 1)));
  if ((page + 1) * perPage < total) nav.push(btn("▶️", cb("ol", status, mine, page + 1)));
  if (nav.length) rows.push(nav);
  rows.push([btn(mine ? "👥 Все" : "👤 Мои", cb("ol", status, mine ? 0 : 1, 0))]);
  const statusButtons = [btn((status === "any" ? "• " : "") + "Все", cb("ol", "any", mine, 0))];
  for (const [s, label] of Object.entries(T.STATUS)) statusButtons.push(btn((status === s ? "• " : "") + label, cb("ol", s, mine, 0)));
  rows.push(...adjust(statusButtons, 2));
  return inline(rows);
}

export const broadcastKb = () => inline([[btn(T.BTN_BROADCAST_GO, cb("bc", "go")), btn(T.BTN_ADMIN_CANCEL, cb("bc", "cancel"))]]);

export function siteSettingsKb(hasUrl: boolean): Inline {
  const b = [btn(T.BTN_SITE_EDIT, cb("site", "edit"))];
  if (hasUrl) b.push(btn(T.BTN_SITE_REMOVE, cb("site", "remove")));
  return inline([b]);
}
