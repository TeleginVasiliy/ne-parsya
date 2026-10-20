// Запросы к Telegram Bot API без падений: ждём при флуд-лимите, помечаем
// заблокировавших бота, «message is not modified» и прочие отказы не роняют бота.
import * as db from "./db.ts";
import { log } from "./config.ts";
import { CAPTION_LIMIT, sleep, splitText } from "./util.ts";

// deno-lint-ignore no-explicit-any
export type Markup = Record<string, any> | null | undefined;
// deno-lint-ignore no-explicit-any
export type Msg = Record<string, any>;

let TOKEN = "";
export function setToken(token: string) {
  TOKEN = token;
}
const apiBase = () => (Deno.env.get("TG_API_BASE") || "https://api.telegram.org").replace(/\/+$/, "");

export class TgError extends Error {
  constructor(public method: string, public code: number, public description: string, public retryAfter = 0) {
    super(`${method}: ${code} ${description}`);
  }
}

/** Прямой вызов метода Bot API. Бросает TgError. Blob в параметрах — файл: тогда запрос уходит формой. */
// deno-lint-ignore no-explicit-any
export async function api(method: string, params: Record<string, any> = {}): Promise<any> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body[k] = v;
  const hasFile = Object.values(body).some((v) => v instanceof Blob);
  let payload: BodyInit = JSON.stringify(body);
  if (hasFile) {
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) {
      if (v instanceof File) form.append(k, v, v.name);
      else if (v instanceof Blob) form.append(k, v);
      else form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    payload = form;
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/bot${TOKEN}/${method}`, {
      method: "POST", headers: hasFile ? {} : { "Content-Type": "application/json" }, body: payload,
      signal: AbortSignal.timeout(hasFile ? 60000 : 30000),
    });
  } catch (e) {
    throw new TgError(method, 0, `network: ${(e as Error).name}`);
  }
  // deno-lint-ignore no-explicit-any
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new TgError(method, res.status, "bad response");
  }
  if (!data.ok) throw new TgError(method, data.error_code ?? res.status, data.description ?? "", data.parameters?.retry_after ?? 0);
  return data.result;
}

/** Почему не ушло последнее сообщение каждому чату: так админ узнаёт настоящую причину, а не всегда «заблокировал». */
const lastFailure = new Map<number, TgError>();
export function failureOf(chatId: number): TgError | null {
  return lastFailure.get(chatId) ?? null;
}
/** Клиент правда заблокировал бота (или удалил аккаунт), а не Telegram отклонил одно сообщение. */
export function isBlockedError(e: TgError | null): boolean {
  return !!e && e.code === 403 && /blocked|deactivated|kicked/i.test(e.description);
}

/** Вызов, который не роняет бота: null вместо ошибки. */
export async function call<T = Msg>(method: string, params: Record<string, unknown>, userId?: number | null): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await api(method, params);
      if (userId) lastFailure.delete(userId);
      return result;
    } catch (e) {
      if (!(e instanceof TgError)) throw e;
      if (e.code === 429) {
        await sleep(Math.min(e.retryAfter + 1, 10) * 1000);
        continue;
      }
      if (e.code === 0 && attempt < 2) {
        await sleep(500);
        continue;
      }
      if (userId) lastFailure.set(userId, e);
      if (isBlockedError(e)) {
        if (userId) await db.setBotBlocked(userId, true);
        log(`Пользователь ${userId} недоступен (заблокировал бота)`);
        return null;
      }
      if (!e.description.includes("message is not modified")) log(`Telegram отклонил ${method}: ${e.description}`);
      return null;
    }
  }
  return null;
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const HTML = { parse_mode: "HTML" };

/** Отправляет текст (с разбивкой на части > 4096). Кнопки — на последней части. */
export async function sendText(chatId: number, text: string, markup?: Markup, extra: Record<string, unknown> = {}): Promise<Msg | null> {
  const parts = splitText(text);
  let last: Msg | null = null;
  for (let i = 0; i < parts.length; i++) {
    const params = {
      chat_id: chatId, text: parts[i], ...HTML, link_preview_options: { is_disabled: true },
      reply_markup: i === parts.length - 1 ? markup ?? undefined : undefined, ...extra,
    };
    last = await call("sendMessage", params, chatId);
    // Telegram не понял разметку (например, «<» в тексте клиента) — отправляем тем же текстом без оформления
    if (!last && /can't parse entities/i.test(failureOf(chatId)?.description ?? "")) {
      last = await call("sendMessage", { ...params, parse_mode: undefined, text: stripTags(parts[i]) }, chatId);
    }
    if (!last) return null;
  }
  return last;
}

export async function sendFile(chatId: number, fileType: string, fileId: string, caption?: string | null, markup?: Markup,
  name?: string | null): Promise<Msg | null> {
  const cap = caption ? caption.slice(0, CAPTION_LIMIT) : undefined;
  if (fileType === "photo") {
    return await call("sendPhoto", { chat_id: chatId, photo: fileId, caption: cap, ...HTML, reply_markup: markup ?? undefined }, chatId);
  }
  let document: string | File = fileId;
  if (/^https?:\/\//.test(fileId)) {
    // Файл из админ-панели лежит в хранилище по ссылке. По ссылке Telegram принимает только PDF, ZIP и GIF,
    // поэтому скачиваем файл сами и загружаем в Telegram как обычный документ
    const file = await fetchAsFile(fileId, name);
    if (!file) {
      lastFailure.set(chatId, new TgError("sendDocument", 404, "файл не скачался из хранилища"));
      return null;
    }
    document = file;
  }
  return await call("sendDocument", { chat_id: chatId, document, caption: cap, ...HTML, reply_markup: markup ?? undefined }, chatId);
}

async function fetchAsFile(url: string, name?: string | null): Promise<File | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return null;
    const fallback = decodeURIComponent(url.split("?")[0].split("/").pop() || "file");
    return new File([await res.arrayBuffer()], name || fallback, { type: res.headers.get("content-type") || "application/octet-stream" });
  } catch (e) {
    log(`Не удалось скачать файл из хранилища: ${(e as Error).name}`);
    return null;
  }
}

/** Telegram-идентификатор отправленного файла: по нему файл можно переслать снова без скачивания. */
export function sentFileId(m: Msg | null): string | null {
  return m?.document?.file_id ?? (m?.photo?.length ? m.photo[m.photo.length - 1].file_id : null);
}

export async function editText(chatId: number, messageId: number, text: string, markup?: Markup): Promise<Msg | null> {
  return await call("editMessageText", {
    chat_id: chatId, message_id: messageId, text: text.slice(0, 4096), ...HTML, link_preview_options: { is_disabled: true },
    reply_markup: markup ?? undefined,
  });
}

export async function editMarkup(chatId: number, messageId: number, markup?: Markup) {
  return await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup ?? undefined });
}

export async function deleteMessage(chatId: number, messageId: number) {
  try {
    await api("deleteMessage", { chat_id: chatId, message_id: messageId });
    return true;
  } catch {
    return false; // старше 48 часов или уже удалено — не страшно
  }
}

export async function answer(cbId: string, text?: string, alert = false) {
  await call("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: alert || undefined });
}

export async function copyMessage(toChat: number, fromChat: number, messageId: number, caption?: string): Promise<Msg | null> {
  return await call("copyMessage", {
    chat_id: toChat, from_chat_id: fromChat, message_id: messageId,
    ...(caption !== undefined ? { caption, ...HTML } : {}),
  }, toChat);
}

/** Файл из сообщения: документ или фото (берём самое большое). */
export function extractFile(m: Msg): db.FileRef | null {
  if (m.document) {
    const d = m.document;
    return { file_id: d.file_id, type: "document", name: d.file_name || "файл", mime: d.mime_type || "" };
  }
  if (m.photo?.length) return { file_id: m.photo[m.photo.length - 1].file_id, type: "photo", name: "фото", mime: "image/jpeg" };
  return null;
}

export const MAX_TG_DOWNLOAD = 20 * 1024 * 1024; // больше Telegram боту не отдаёт

/** Скачивает файл из Telegram (до 20 МБ). */
export async function download(fileId: string): Promise<Uint8Array | null> {
  try {
    const f = await api("getFile", { file_id: fileId });
    if (f.file_size && f.file_size > MAX_TG_DOWNLOAD) return null;
    const res = await fetch(`${apiBase()}/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    log(`Не удалось скачать файл из Telegram: ${(e as Error).name}`);
    return null;
  }
}
