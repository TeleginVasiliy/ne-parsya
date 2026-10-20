// Заказы с сайта: четыре способа доставки.
// 1. sendData — сайт открыт reply-кнопкой «🌐 Сайт»: JSON приходит в web_app_data.
// 2. Облако: сайт в Telegram кладёт заказ в incoming_orders с подписью Telegram (initData).
// 3. bot_handoff: сайт кладёт JSON под кодом и открывает t.me/<бот>?start=order_<код>.
// 4. Запасной: клиент вставляет скопированный текст заявки («🧾 Заявка #…»).
import { T } from "./texts.ts";
import type { Config } from "./config.ts";
import * as db from "./db.ts";
import type { Order } from "./db.ts";
import * as K from "./kb.ts";
import * as screen from "./screen.ts";
import { notifyNewOrder } from "./services.ts";
import { fmt, isIsoDate, makeIsoDate } from "./util.ts";

const MAX_LINES = 40;
export const HANDOFF_CODE_RE = /^[A-Za-z0-9]{8,32}$/;
const SITE_ID_RE = /^[A-Z0-9]{4,8}$/;
// deno-lint-ignore no-explicit-any
const WORK_TYPES = T.WORK_TYPES as Record<string, any>;
const NAME_TO_TYPE = new Map(Object.entries(WORK_TYPES).map(([k, v]) => [v.name.toLowerCase(), k]));

function clean(value: unknown, limit: number): string {
  const s = String(value ?? "");
  return limit <= 60 ? s.split(/\s+/).filter(Boolean).join(" ").slice(0, limit) : s.trim().slice(0, limit);
}

function typeFromName(name: string): string {
  const n = name.trim().toLowerCase();
  if (NAME_TO_TYPE.has(n)) return NAME_TO_TYPE.get(n)!;
  for (const [full, key] of NAME_TO_TYPE) { // «Курсовая» → «Курсовая работа»
    if (full.startsWith(n) || n.startsWith(full.split(" ")[0])) return key;
  }
  return "other";
}

function parseDeadline(value: string): string | null {
  if (!value) return null;
  if (value === "flex" || value.toLowerCase().includes("не горит")) return "flex";
  if (isIsoDate(value)) return value;
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(value);
  return m ? makeIsoDate(+m[3], +m[2], +m[1]) : null;
}

// deno-lint-ignore no-explicit-any
export type SiteOrder = Record<string, any>;

/** Проверяет JSON с сайта и приводит к формату заказа. null — если мусор. */
export function normalizePayload(raw: unknown): SiteOrder | null {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  // deno-lint-ignore no-explicit-any
  const r = raw as any;
  if (!r || typeof r !== "object" || Array.isArray(r) || r.kind !== "np_order") return null;
  if (!Array.isArray(r.lines) || !r.lines.length) return null;
  const lines: string[][] = [];
  for (const item of r.lines.slice(0, MAX_LINES)) {
    if (!Array.isArray(item) || item.length !== 3) return null;
    const [icon, label, value] = [clean(item[0], 8), clean(item[1], 40), clean(item[2], 1500)];
    if (label && value) lines.push([icon, label, value]);
  }
  if (!lines.length) return null;
  let type = typeof r.type === "string" && WORK_TYPES[r.type] ? r.type : null;
  if (!type) {
    const work = lines.find(([, label]) => label === "Работа")?.[2] ?? "";
    type = work ? typeFromName(work) : "other";
  }
  const siteId = String(r.id ?? "").toUpperCase();
  return {
    type, type_name: WORK_TYPES[type].name, lines,
    deadline: parseDeadline(String(r.deadline ?? "")),
    site_id: SITE_ID_RE.test(siteId) ? siteId : null,
  };
}

const LINE_RE = /^(\S{1,8})\s+([^:\n]{1,40}):\s*(.+)$/u;
const HEADER_RE = /Заявка\s+#([A-Z0-9]{4,8})/;

export function looksLikeSiteText(text?: string | null): boolean {
  return !!text && [...text].slice(0, 10).join("").includes("🧾") && text.slice(0, 40).includes("Заявка");
}

/** Разбирает текст заявки, скопированный с сайта. */
export function parseSiteText(text: string): SiteOrder | null {
  if (!looksLikeSiteText(text)) return null;
  const header = HEADER_RE.exec(text.slice(0, 80));
  const lines: string[][] = [];
  for (const raw of text.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith("📋")) continue; // служебная пометка о сокращении
    const m = LINE_RE.exec(line);
    if (m) lines.push([m[1], m[2].trim(), m[3].trim()]);
    else if (lines.length && lines[lines.length - 1][1] === "Комментарий") lines[lines.length - 1][2] += "\n" + line;
  }
  const work = lines.find(([, label]) => label === "Работа")?.[2];
  if (!work) return null;
  const deadline = lines.find(([, label]) => label === "Срок")?.[2] ?? "";
  return normalizePayload({
    kind: "np_order", id: header?.[1] ?? null, type: typeFromName(work), deadline: parseDeadline(deadline) ?? "", lines,
  });
}

/** Забирает заявку, которую сайт положил в bot_handoff, и удаляет её. */
export async function fetchHandoff(code: string): Promise<SiteOrder | null> {
  if (!HANDOFF_CODE_RE.test(code)) return null;
  const row = await db.one<{ payload: unknown }>("delete from bot_handoff where code = $1 returning payload", [code]);
  return row ? normalizePayload(row.payload) : null;
}

/** Создаёт заказ из заявки сайта. Повтор той же заявки не создаёт дубль. */
export async function createSiteOrder(config: Config, userId: number, data: SiteOrder): Promise<Order> {
  if (data.site_id) {
    const existing = await db.findSiteDuplicate(userId, data.site_id, data.lines);
    if (existing) {
      await screen.newScreen(userId, fmt(T.ORDER_DUPLICATE, { code: existing.code }));
      return existing;
    }
  }
  // Номер заявки с сайта занят прошлым заказом — бот подберёт новый
  const order = await db.createOrder(userId, data, "site", data.site_id);
  await db.setSourceIfEmpty(userId, "site");
  await screen.newScreen(userId, fmt(T.ORDER_ACCEPTED_SITE, { code: order.code }), K.backToOrderKb(order.id));
  await notifyNewOrder(config, order);
  return order;
}
