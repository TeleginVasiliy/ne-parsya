// Связь бота с сайтом.
// Бот → сайт: заказы, оплаты, чеки и файлы (кабинет клиента и админ-панель).
// Сайт → бот: заказы с сайта, действия админов на сайте (цена, статус,
// сообщение клиенту) и готовые работы, загруженные через админ-панель.
import { T } from "./texts.ts";
import type { Config } from "./config.ts";
import { log } from "./config.ts";
import * as db from "./db.ts";
import type { Order } from "./db.ts";
import * as K from "./kb.ts";
import * as screen from "./screen.ts";
import {
  changeStatus, deliverResult, notifyOrderAdmins, offerText, paymentDetailsText, paymentKb, paymentText, prepayAmount,
  refreshOrderCards, sendOffer, sendPaymentInstructions, sendStoredFile, undeliveredReason,
} from "./services.ts";
import { createSiteOrder, normalizePayload } from "./siteOrders.ts";
import * as tg from "./tg.ts";
import { esc, fmt, randomHex } from "./util.ts";

const INCOMING_MAX_AGE = 7 * 24 * 3600; // заказ с сайта действителен 7 дней
// deno-lint-ignore no-explicit-any
const WORK_TYPES = T.WORK_TYPES as Record<string, any>;

// ======================= Storage =======================
/** Проверка хранилища для страницы ?setup=1: может ли бот загружать файлы (чеки, файлы клиентов). */
export async function checkStorage(): Promise<string | null> {
  try {
    await upload("private", "setup-check.txt", new TextEncoder().encode("ok"), "text/plain");
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const storageUrl = () => (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
function storageKey(): string {
  // STORAGE_KEY — свой секрет с ключом Secret (sb_secret_…), если встроенный ключ Supabase не подходит
  const k = Deno.env.get("STORAGE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
  if (k) return k;
  try { // новые проекты: SUPABASE_SECRET_KEYS = {"default": "sb_secret_…"}
    return Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string || "";
  } catch {
    return "";
  }
}
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function upload(bucket: string, path: string, data: Uint8Array, contentType: string) {
  const key = storageKey();
  const headers: Record<string, string> = { apikey: key, "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${storageUrl()}/storage/v1/object/${bucket}/${encPath(path)}`, { method: "POST", headers, body: data as BodyInit });
  if (!res.ok) throw new Error(`upload ${bucket}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export const publicUrl = (bucket: string, path: string) => `${storageUrl()}/storage/v1/object/public/${bucket}/${encPath(path)}`;

const RU: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n",
  о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

/** Имя файла для адреса в хранилище: Supabase принимает только латиницу («Invalid key» на русских буквах). */
export function safeName(name: string | null | undefined, fallback = "file"): string {
  const latin = [...(name || fallback)].map((ch) => {
    const low = ch.toLowerCase();
    if (!(low in RU)) return ch;
    const t = RU[low];
    return ch !== low && t ? t[0].toUpperCase() + t.slice(1) : t;
  }).join("");
  const n = latin.replace(/[^A-Za-z0-9_.\-]+/g, "_").replace(/_+/g, "_").replace(/^[._]+|[._]+$/g, "") || fallback;
  return n.slice(-80);
}

function mime(fileType: string, name: string): string {
  if (fileType === "photo") return "image/jpeg";
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  return ({
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", doc: "application/msword", zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

// ======================= бот → сайт =======================

async function pushOrder(o: Order) {
  // Файлы: готовые работы — в публичную папку со случайным адресом, файлы клиента — в закрытую.
  // Ошибка с одним файлом не мешает выгрузить заказ: статус и суммы на сайте обновятся в любом случае,
  // а файл попробуем загрузить ещё раз при следующем изменении заказа.
  for (const f of await db.allFiles(o.id)) {
    if (f.cloud_path || String(f.file_id).startsWith("http")) continue; // уже в облаке
    try {
      let name: string = f.file_name || (f.file_type === "photo" ? "photo.jpg" : "file");
      if (f.file_type === "photo" && !name.includes(".")) name += ".jpg";
      const data = await tg.download(f.file_id);
      if (!data) {
        await db.setFileCloud(f.id, "skip", ""); // слишком большой — не пытаемся снова
        continue;
      }
      const [bucket, path] = f.kind === "result"
        ? ["results", `${randomHex(16)}/${safeName(name)}`]
        : ["private", `client/${o.code}/${f.id}_${safeName(name)}`];
      await upload(bucket, path, data, mime(f.file_type, name));
      const cloudId = `bot-${f.id}`;
      await db.exec(
        `insert into cloud_files(id, order_id, kind, name, bucket, path, size, source, delivered, created_at)
         values($1, $2, $3, $4, $5, $6, $7, 'bot', true, $8)
         on conflict (id) do update set name = excluded.name, bucket = excluded.bucket, path = excluded.path, size = excluded.size`,
        [cloudId, o.id, f.kind, name, bucket, path, data.length, f.created_at]);
      await db.setFileCloud(f.id, path, cloudId);
    } catch (e) {
      log(`Файл заказа #${o.code} не загрузился на сайт: ${(e as Error).message}`);
    }
  }
  // Готовая работа заменена — старые файлы с сайта убираем
  await db.exec(
    `delete from cloud_files c where c.order_id = $1 and (c.source = 'bot' or c.delivered)
     and not exists (select 1 from bot_files f where f.cloud_id = c.id)`, [o.id]);

  // Чеки
  for (const p of await db.paymentsForOrder(o.id)) {
    if (p.cloud_path || !p.file_id) continue;
    try {
      const data = await tg.download(p.file_id);
      if (!data) {
        await db.setPaymentCloud(p.id, "skip");
        continue;
      }
      const ext = p.file_type === "photo" ? "jpg" : "pdf";
      const path = `receipts/${o.code}/${p.id}.${ext}`;
      await upload("private", path, data, ext === "jpg" ? "image/jpeg" : "application/pdf");
      await db.setPaymentCloud(p.id, path);
    } catch (e) {
      log(`Чек по заказу #${o.code} не загрузился на сайт: ${(e as Error).message}`);
    }
  }
  await db.exec(
    `insert into cloud_payments(id, order_id, kind, amount, status, confirmed_by, receipt_path, created_at, confirmed_at)
     select p.id, p.order_id, p.kind, p.amount, p.status, u.first_name,
            nullif(p.cloud_path, 'skip'), p.created_at, p.confirmed_at
     from bot_payments p left join bot_users u on u.id = p.confirmed_by where p.order_id = $1
     on conflict (id) do update set status = excluded.status, confirmed_by = excluded.confirmed_by,
       receipt_path = excluded.receipt_path, confirmed_at = excluded.confirmed_at, amount = excluded.amount`, [o.id]);

  const token = await db.siteToken(o.user_id);
  const typeName = (WORK_TYPES[o.data?.type] ?? WORK_TYPES.other).name;
  await db.exec(
    `insert into cloud_orders(id, code, tg_user_id, client_name, client_username, client_token, type, type_name, status,
       price, prepay, paid, deadline, deadline_text, source, admin_name, reject_reason, lines, created_at, updated_at)
     select o.id, o.code, o.user_id, u.first_name, u.username, $2, o.data->>'type', $3, o.status,
       o.price, o.prepay, o.paid, o.data->>'deadline', o.deadline_text, o.source, a.first_name, o.reject_reason,
       coalesce(o.data->'lines', '[]'::jsonb), o.created_at, o.updated_at
     from bot_orders o left join bot_users u on u.id = o.user_id left join bot_users a on a.id = o.admin_id
     where o.id = $1
     on conflict (id) do update set client_name = excluded.client_name, client_username = excluded.client_username,
       client_token = excluded.client_token, type = excluded.type, type_name = excluded.type_name, status = excluded.status,
       price = excluded.price, prepay = excluded.prepay, paid = excluded.paid, deadline = excluded.deadline,
       deadline_text = excluded.deadline_text, admin_name = excluded.admin_name, reject_reason = excluded.reject_reason,
       lines = excluded.lines, updated_at = excluded.updated_at`, [o.id, token, typeName]);
}

export async function pushChanged(): Promise<number> {
  let pushed = 0;
  for (const o of await db.ordersToSync()) {
    try {
      await pushOrder(o);
      await db.markSynced(o.id, o.version);
      pushed++;
    } catch (e) {
      log(`Не удалось выгрузить заказ #${o.code} на сайт: ${(e as Error).message}`);
    }
  }
  return pushed;
}

// ======================= подпись Telegram (initData) =======================

async function hmac(key: Uint8Array<ArrayBuffer> | Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data))) as Uint8Array<ArrayBuffer>;
}

/** Проверяет подпись данных мини-приложения. Возвращает пользователя или null. */
// deno-lint-ignore no-explicit-any
export async function checkInitData(token: string, initData: string, maxAge = INCOMING_MAX_AGE): Promise<Record<string, any> | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), token);
  const sign = [...await hmac(secret, check)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sign !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAge) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

/** Заказ с сайта по подписи Telegram. Бросает Error с понятной причиной. */
export async function acceptSignedOrder(config: Config, initData: string, payload: unknown) {
  const u = await checkInitData(config.token, initData);
  if (!u) throw new Error("старая или неверная подпись Telegram");
  const data = normalizePayload(payload);
  if (!data) throw new Error("некорректная заявка");
  await db.upsertUser(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ") || null, u.username ?? null);
  const urow = await db.getUser(u.id);
  if (urow?.blocked && !config.isAdmin(u.id)) throw new Error("клиент заблокирован");
  return await createSiteOrder(config, u.id, data);
}

// ======================= сайт → бот =======================

export async function importIncoming(config: Config): Promise<number> {
  // Берём заказ «в работу» атомарно — два параллельных запуска не создадут дубль
  const rows = await db.q<{ id: number; init_data: string; payload: unknown }>(
    `update incoming_orders set state = 'processing' where id in (
       select id from incoming_orders where state = 'pending' order by id limit 20 for update skip locked)
     returning id, init_data, payload`);
  for (const row of rows) {
    let state = "done", result = "";
    try {
      result = (await acceptSignedOrder(config, row.init_data, row.payload)).code;
    } catch (e) {
      state = "error";
      result = (e as Error).message;
    }
    await db.exec("update incoming_orders set state = $1, result = $2 where id = $3", [state, result, row.id]);
  }
  return rows.length;
}

export async function applyActions(config: Config): Promise<number> {
  const rows = await db.q(
    `update cloud_actions set state = 'processing' where id in (
       select id from cloud_actions where state = 'pending' order by id limit 30 for update skip locked)
     returning id, order_id, action, payload, created_by`);
  rows.sort((a, b) => a.id - b.id);
  for (const row of rows) {
    let state = "done", result = "выполнено";
    let o = await db.getOrder(Number(row.order_id));
    const payload = row.payload ?? {};
    const who = esc(row.created_by || "админ");
    try {
      if (!o) throw new Error("заказ не найден");
      if (row.action === "price") {
        const price = parseInt(payload.price) || 0;
        const deadline = String(payload.deadline ?? "").trim().slice(0, 60) || "по договорённости";
        if (!(price > 0 && price < 10_000_000)) throw new Error("неверная цена");
        if (o.paid || !["new", "accepted", "awaiting_payment"].includes(o.status)) throw new Error("цену уже нельзя менять — заказ оплачен или в работе");
        await db.setPrice(o.id, price, prepayAmount(price, config.prepaymentPercent), deadline);
        if (o.status === "awaiting_payment" || o.status === "new") await db.setStatus(o.id, "accepted"); // цена назначена — заказ принят
        o = (await db.getOrder(o.id))!;
        await sendOffer(config, o);
        await refreshOrderCards(config, o.id);
        await notifyOrderAdmins(config, o, fmt(T.CLOUD_ACTION_DONE, { who, code: o.code, what: `цена ${price} ₽, срок ${esc(deadline)}` }));
      } else if (row.action === "status") {
        const status = String(payload.status ?? "");
        if (!(T.STATUS_MANUAL as readonly string[]).includes(status)) throw new Error("неизвестный статус");
        await changeStatus(config, o.id, status);
        await notifyOrderAdmins(config, o, fmt(T.CLOUD_ACTION_DONE, {
          who, code: o.code, what: `статус «${(T.STATUS as Record<string, string>)[status]}»`,
        }));
      } else if (row.action === "bundle") {
        await applyBundle(config, o, payload, who);
      } else if (row.action === "delete") {
        // Сначала сообщаем админам заказа, потом удаляем — карточки заказа уберутся из их чатов
        await notifyOrderAdmins(config, o, fmt(T.CLOUD_ACTION_DONE, { who, code: o.code, what: "заказ удалён" }));
        const cards = await db.deleteOrder(o.id);
        await Promise.all(cards.map((c) => tg.deleteMessage(c.chat_id, c.message_id)));
        await db.exec("update cloud_actions set state = 'done', result = 'заказ удалён' where id = $1", [row.id]);
        continue;
      } else if (row.action === "message") {
        const text = String(payload.text ?? "").trim().slice(0, 3500);
        if (!text) throw new Error("пустое сообщение");
        const header = fmt(T.ADMIN_REPLY_HEADER, { order: fmt(T.ADMIN_REPLY_ORDER, { code: o.code }) });
        if (!await screen.newScreen(o.user_id, `${header}\n\n${esc(text)}`, K.backToOrderKb(o.id))) throw new Error(undeliveredReason(o.user_id));
      } else throw new Error("неизвестное действие");
      await db.touchOrder(o.id);
    } catch (e) {
      state = "error";
      result = (e as Error).message;
    }
    await db.exec("update cloud_actions set state = $1, result = $2 where id = $3", [state, result, row.id]);
  }
  return rows.length;
}

/** «Отправить всё сразу» из админ-панели: цена, срок, статус, сообщение и файлы — клиенту одним экраном. */
// deno-lint-ignore no-explicit-any
async function applyBundle(config: Config, order: Order, payload: Record<string, any>, who: string) {
  let o = order;
  const parts: string[] = [];
  const done: string[] = [];
  let kb: { inline_keyboard: unknown[][] } | null = null;
  const text = String(payload.text ?? "").trim().slice(0, 3500);
  if (text) {
    parts.push(`${fmt(T.ADMIN_REPLY_HEADER, { order: fmt(T.ADMIN_REPLY_ORDER, { code: o.code }) })}\n\n${esc(text)}`);
    done.push("сообщение");
  }

  const price = parseInt(payload.price) || 0;
  if (payload.price !== undefined && payload.price !== null && payload.price !== "") {
    if (!(price > 0 && price < 10_000_000)) throw new Error("неверная цена");
    if (o.paid || !["new", "accepted", "awaiting_payment"].includes(o.status)) throw new Error("цену уже нельзя менять — заказ оплачен или в работе");
    const deadline = String(payload.deadline ?? "").trim().slice(0, 60) || o.deadline_text || "по договорённости";
    await db.setPrice(o.id, price, prepayAmount(price, config.prepaymentPercent), deadline);
    if (o.status === "awaiting_payment" || o.status === "new") await db.setStatus(o.id, "accepted"); // цена назначена — заказ принят
    o = (await db.getOrder(o.id))!;
    parts.push(offerText(config, o));
    kb = K.offerKb(o.id);
    done.push(`цена ${price} ₽, срок ${esc(deadline)}`);
  } else if (String(payload.deadline ?? "").trim() && o.price) {
    const deadline = String(payload.deadline).trim().slice(0, 60);
    await db.setPrice(o.id, o.price, o.prepay ?? o.price, deadline);
    o = (await db.getOrder(o.id))!;
    parts.push(`⏰ Срок по заказу <b>#${o.code}</b>: <b>${esc(deadline)}</b>`);
    done.push(`срок ${esc(deadline)}`);
  }

  const files = payload.batch
    ? await db.q(`update cloud_files set delivered = true where batch = $1 and order_id = $2 and kind = 'result' and delivered = false
                  returning id, name, bucket, path`, [String(payload.batch), o.id])
    : [];
  const status = String(payload.status ?? "");
  if (status && !files.length) {
    if (!(T.STATUS_MANUAL as readonly string[]).includes(status)) throw new Error("неизвестный статус");
    if (status !== o.status) {
      await db.setStatus(o.id, status);
      o = (await db.getOrder(o.id))!;
      const note = (T.STATUS_CLIENT as Record<string, string>)[status];
      if (note && !price) parts.push(fmt(note, { code: o.code }));
      done.push(`статус «${(T.STATUS as Record<string, string>)[status]}»`);
    }
  }

  let sentFiles = false;
  if (files.length) {
    await db.deleteFiles(o.id, "result"); // новая версия работы заменяет прошлую
    for (const f of files) {
      await db.addFile(o.id, "result", { file_id: publicUrl(f.bucket, f.path), type: "document", name: f.name }, f.path, f.id);
    }
    done.push(`готовая работа (файлов: ${files.length})`);
    if (Math.max(0, (o.price || 0) - o.paid) > 0) {
      await db.setStatus(o.id, "awaiting_final");
      o = (await db.getOrder(o.id))!;
      parts.push(paymentText(config, o, "final"));
      kb = paymentKb(config, o, "final");
    } else {
      // Файлы уходят новым экраном; прежний экран убираем, только когда всё дошло
      const before = await screen.begin(o.user_id);
      const ids: number[] = [];
      for (const f of await db.getFiles(o.id, "result")) {
        const m = await sendStoredFile(o.user_id, f);
        if (!m) {
          if (ids.length) await screen.commit(o.user_id, { ...before, ids: [] }, ids);
          throw new Error(undeliveredReason(o.user_id));
        }
        ids.push(m.message_id);
      }
      await screen.commit(o.user_id, before, ids);
      await db.setStatus(o.id, "review");
      o = (await db.getOrder(o.id))!;
      parts.push(fmt(T.RESULT_DELIVERED, { code: o.code }));
      kb = K.acceptWorkKb(o.id);
      sentFiles = true;
    }
  }
  if (!parts.length && !done.length) throw new Error("нечего отправлять — заполните хотя бы одно поле");
  if (parts.length) {
    const body = parts.join("\n\n— — —\n\n");
    const markup = K.withOrderButton(kb as never, o.id);
    const msg = sentFiles ? await screen.add(o.user_id, body, markup) : await screen.newScreen(o.user_id, body, markup);
    if (!msg) throw new Error(undeliveredReason(o.user_id));
  }
  await refreshOrderCards(config, o.id);
  await notifyOrderAdmins(config, o, fmt(T.CLOUD_ACTION_DONE, { who, code: o.code, what: done.join(", ") || "сообщение" }));
}

/** Готовые работы, загруженные админом на сайте, — клиенту в Telegram. */
export async function deliverSiteResults(config: Config): Promise<number> {
  const rows = await db.q(
    `update cloud_files set delivered = true where id in (
       select id from cloud_files where source = 'site' and kind = 'result' and delivered = false and batch is null
       order by created_at limit 50 for update skip locked)
     returning id, order_id, name, bucket, path, created_at`);
  const byOrder = new Map<number, db.Row[]>();
  for (const r of rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))) {
    byOrder.set(Number(r.order_id), [...(byOrder.get(Number(r.order_id)) ?? []), r]);
  }
  for (const [orderId, files] of byOrder) {
    const o = await db.getOrder(orderId);
    if (!o) continue;
    await db.deleteFiles(orderId, "result"); // новая версия работы заменяет прошлую
    for (const f of files) {
      // Telegram сам скачает файл по ссылке, когда бот отправит его клиенту
      await db.addFile(orderId, "result", { file_id: publicUrl(f.bucket, f.path), type: "document", name: f.name }, f.path, f.id);
    }
    if (Math.max(0, (o.price || 0) - o.paid) > 0) {
      await changeStatus(config, orderId, "awaiting_final", { notify: false });
      await sendPaymentInstructions(config, (await db.getOrder(orderId))!, "final");
    } else {
      await deliverResult(config, orderId);
    }
    await notifyOrderAdmins(config, o, fmt(T.CLOUD_RESULT_SENT, { code: o.code, n: files.length }));
  }
  return rows.length;
}

export async function pushSettings(config: Config) {
  const rows: [string, string][] = [
    ["payment_details", paymentDetailsText(config)],
    ["payment_extra", JSON.stringify({ phone: config.pay.phone, bank: config.pay.bank, card: config.pay.card, links: config.pay.links })],
  ];
  for (const [key, value] of rows) {
    await db.exec("insert into site_settings(key, value) values($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
  }
}

/** Всё, что пришло с сайта, плюс выгрузка изменений бота. */
export async function syncOnce(config: Config) {
  const stats = { incoming: 0, actions: 0, results: 0, pushed: 0 };
  for (const [key, fn] of [["incoming", importIncoming], ["actions", applyActions], ["results", deliverSiteResults]] as const) {
    try {
      stats[key] = await fn(config);
    } catch (e) {
      log(`Синхронизация (${key}) не удалась: ${(e as Error).message}`);
    }
  }
  stats.pushed = await pushChanged();
  return stats;
}
