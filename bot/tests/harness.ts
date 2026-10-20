// Имитация Telegram Bot API и хранилища Supabase для сквозных тестов облачного бота.
// Бот работает по-настоящему: настоящая база Postgres, настоящий код функции,
// только вместо api.telegram.org — этот сервер.
import { sha256Hex } from "../src/util.ts";

export const PORT = 18765;
export const TOKEN = "123456:TEST-TOKEN-SECRET";
export const PG = Deno.env.get("TEST_PG") ?? "postgres://postgres@127.0.0.1:54329/nptest";

type Any = Record<string, any>;
export interface Stored {
  chat: number;
  id: number;
  text: string | null;
  markup: Any | null;
  bot: boolean;
  deleted: boolean;
  photo?: boolean;
  method: string;
}

export class FakeTelegram {
  calls: { method: string; p: Any }[] = [];
  msgs = new Map<string, Stored>();
  counters = new Map<number, number>();
  blocked = new Set<number>();
  /** Чаты, где Telegram отклоняет новые сообщения с этой причиной («can't parse…» — только с HTML-разметкой). */
  reject = new Map<number, string>();
  answers: string[] = [];
  files = new Map<string, Uint8Array>();
  storage = new Map<string, { data: Uint8Array; type: string }>();
  server?: Deno.HttpServer;

  nextId(chat: number) {
    const n = (this.counters.get(chat) ?? 0) + 1;
    this.counters.set(chat, n);
    return n;
  }

  store(chat: number, text: string | null, markup: Any | null, bot: boolean, method: string, photo = false): Stored {
    const m: Stored = { chat, id: this.nextId(chat), text, markup, bot, deleted: false, photo, method };
    this.msgs.set(`${chat}:${m.id}`, m);
    return m;
  }

  start() {
    this.server = Deno.serve({ port: PORT, hostname: "127.0.0.1", onListen: () => {} }, (req) => this.handle(req));
  }

  async stop() {
    await this.server?.shutdown();
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Хранилище Supabase
    if (url.pathname.startsWith("/storage/v1/object/public/") && req.method === "GET") {
      const f = this.storage.get(decodeURIComponent(url.pathname.slice("/storage/v1/object/public/".length)));
      return f ? new Response(f.data as BodyInit, { headers: { "content-type": f.type } }) : new Response("not found", { status: 404 });
    }
    if (url.pathname.startsWith("/storage/v1/object/")) {
      const key = decodeURIComponent(url.pathname.slice("/storage/v1/object/".length));
      this.storage.set(key, { data: new Uint8Array(await req.arrayBuffer()), type: req.headers.get("content-type") ?? "" });
      return Response.json({ Key: key });
    }
    if (url.pathname.startsWith("/file/")) {
      const path = url.pathname.split("/").pop()!;
      return new Response(this.files.get(path) ?? new TextEncoder().encode(`data of ${path}`));
    }
    const method = url.pathname.split("/").pop()!;
    // deno-lint-ignore no-explicit-any
    let p: any;
    if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      // Файл, загруженный ботом напрямую (как настоящий Telegram: поля формы + сам файл)
      const form = await req.formData();
      p = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") p[k] = /^[[{]/.test(v) ? JSON.parse(v) : /^-?\d+$/.test(v) ? Number(v) : v;
        else p[k] = { upload: v.name, size: v.size };
      }
    } else p = await req.json();
    this.calls.push({ method, p });
    const ok = (result: unknown) => Response.json({ ok: true, result });
    const fail = (code: number, description: string) => Response.json({ ok: false, error_code: code, description });
    const chat = Number(p.chat_id);
    const sends = ["sendMessage", "sendPhoto", "sendDocument", "copyMessage"];
    if (sends.includes(method) && this.blocked.has(chat)) return fail(403, "Forbidden: bot was blocked by the user");
    const why = this.reject.get(chat);
    if (sends.includes(method) && why && (!why.includes("parse") || p.parse_mode)) return fail(400, why);
    switch (method) {
      case "getMe":
        return ok({ id: 999, is_bot: true, username: "ne_parsya_bot", first_name: "Не Парься" });
      case "sendMessage": {
        if (String(p.text).length > 4096) return fail(400, "Bad Request: message is too long");
        const m = this.store(chat, p.text, p.reply_markup ?? null, true, method);
        return ok({ message_id: m.id, chat: { id: chat }, text: p.text });
      }
      case "sendDocument":
        // Настоящий Telegram по ссылке отправляет документом только PDF, ZIP и GIF
        if (typeof p.document === "string" && /^https?:/.test(p.document) && !/\.(pdf|zip|gif)$/i.test(p.document)) {
          return fail(400, "Bad Request: wrong file identifier/HTTP URL specified");
        }
        if (typeof p.document === "object") {
          const m = this.store(chat, p.caption ?? null, p.reply_markup ?? null, true, method);
          return ok({ message_id: m.id, chat: { id: chat }, document: { file_id: `tg_${p.document.upload}`, file_name: p.document.upload } });
        }
      // falls through
      case "sendPhoto":
      case "copyMessage": {
        const m = this.store(chat, p.caption ?? null, p.reply_markup ?? null, true, method, method === "sendPhoto");
        return ok({ message_id: m.id, chat: { id: chat } });
      }
      case "editMessageText":
      case "editMessageCaption":
      case "editMessageMedia":
      case "editMessageReplyMarkup": {
        const m = this.msgs.get(`${chat}:${p.message_id}`);
        if (!m || m.deleted) return fail(400, "Bad Request: message to edit not found");
        if (method === "editMessageText") m.text = p.text;
        if (method === "editMessageCaption") m.text = p.caption;
        if (method === "editMessageMedia") m.text = p.media.caption;
        m.markup = p.reply_markup ?? null;
        return ok({ message_id: m.id, chat: { id: chat } });
      }
      case "deleteMessage": {
        const m = this.msgs.get(`${chat}:${p.message_id}`);
        if (!m || m.deleted) return fail(400, "Bad Request: message to delete not found");
        m.deleted = true;
        return ok(true);
      }
      case "answerCallbackQuery":
        if (p.text) this.answers.push(p.text);
        return ok(true);
      case "getFile":
        return ok({ file_id: p.file_id, file_size: 1000, file_path: `f_${p.file_id}` });
      default:
        return ok(true);
    }
  }

  // ------------- что видно в чате -------------
  sentTo(chat: number): string[] {
    return [...this.msgs.values()].filter((m) => m.chat === chat && m.bot && m.text !== null).map((m) => m.text!);
  }
  lastText(chat: number): string {
    const t = this.sentTo(chat);
    return t[t.length - 1] ?? "";
  }
  /** Сообщения бота, которые клиент видит сейчас (не удалённые). Сообщение с клавиатурой меню не считаем — оно в чате всегда. */
  visible(chat: number): string[] {
    return [...this.msgs.values()].filter((m) => m.chat === chat && m.bot && !m.deleted && !m.markup?.keyboard).map((m) => m.text ?? "");
  }
  /** Сколько в чате сообщений с клавиатурой главного меню (должно быть ровно одно). */
  menus(chat: number): number {
    return [...this.msgs.values()].filter((m) => m.chat === chat && m.bot && !m.deleted && m.markup?.keyboard).length;
  }
  methods(name: string) {
    return this.calls.filter((c) => c.method === name).map((c) => c.p);
  }
  /** Последнее видимое сообщение с кнопкой, в тексте которой есть label. */
  findButton(chat: number, label: string): [number, Any, Stored] | null {
    const list = [...this.msgs.values()].filter((m) => m.chat === chat && !m.deleted && m.markup?.inline_keyboard).reverse();
    for (const m of list) {
      for (const row of m.markup!.inline_keyboard) for (const b of row) if (String(b.text).includes(label)) return [m.id, b, m];
    }
    return null;
  }
  deleted(chat: number, id: number) {
    return !!this.msgs.get(`${chat}:${id}`)?.deleted;
  }
}

export interface User {
  id: number;
  first_name: string;
  username?: string;
}

/** Водитель: шлёт апдейты в функцию бота так же, как это делает Telegram. */
export class Driver {
  updateId = 1000;
  secret = "";
  constructor(public tg: FakeTelegram, public handler: (r: Request) => Promise<Response>) {}

  async init() {
    this.secret = (await sha256Hex(`webhook:${TOKEN}`)).slice(0, 40);
  }

  user(id: number, first_name: string, username?: string): User {
    return { id, first_name, username };
  }

  async post(update: Any) {
    const res = await this.handler(new Request("http://localhost/bot", {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": this.secret, "content-type": "application/json" },
      body: JSON.stringify({ update_id: ++this.updateId, ...update }),
    }));
    if (res.status !== 200) throw new Error(`webhook HTTP ${res.status}`);
    await res.text();
  }

  async send(u: User, text: string | null, extra: Any = {}): Promise<Stored> {
    const m = this.tg.store(u.id, text, null, false, "user");
    await this.post({ message: { message_id: m.id, from: { ...u, is_bot: false }, chat: { id: u.id, type: "private" }, date: 0, ...(text !== null ? { text } : {}), ...extra } });
    return m;
  }

  async reply(u: User, text: string, replyTo: number) {
    return await this.send(u, text, { reply_to_message: { message_id: replyTo } });
  }

  async doc(u: User, name: string, mime = "application/pdf", extra: Any = {}) {
    return await this.send(u, null, { document: { file_id: `file_${name}`, file_unique_id: name, file_name: name, mime_type: mime }, ...extra });
  }

  async photo(u: User, id: string, extra: Any = {}) {
    return await this.send(u, null, { photo: [{ file_id: `small_${id}`, file_unique_id: "s" }, { file_id: id, file_unique_id: id }], ...extra });
  }

  async webapp(u: User, payload: unknown) {
    return await this.send(u, null, { web_app_data: { data: typeof payload === "string" ? payload : JSON.stringify(payload), button_text: "🌐 Сайт" } });
  }

  async press(u: User, messageId: number, data: string) {
    const stored = this.tg.msgs.get(`${u.id}:${messageId}`);
    await this.post({
      callback_query: {
        id: String(++this.updateId), from: { ...u, is_bot: false }, data, chat_instance: "x",
        message: { message_id: messageId, chat: { id: u.id, type: "private" }, date: 0, ...(stored?.photo ? { photo: [{ file_id: "p" }] } : {}) },
      },
    });
  }

  async click(u: User, label: string) {
    const found = this.tg.findButton(u.id, label);
    if (!found) throw new Error(`Кнопка «${label}» не найдена у ${u.id}. Последнее: ${this.tg.lastText(u.id).slice(0, 300)}`);
    const [mid, b] = found;
    if (!b.callback_data) throw new Error(`«${label}» — не callback-кнопка`);
    await this.press(u, mid, b.callback_data);
  }
}

export async function resetDb() {
  const run = async (args: string[]) => {
    const out = await new Deno.Command("psql", { args: ["-h", "127.0.0.1", "-p", "54329", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q", ...args], stdout: "null", stderr: "piped" }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  };
  await run(["-c", "drop database if exists nptest with (force)", "-c", "create database nptest"]);
  const root = new URL("..", import.meta.url).pathname;
  const candidates = [Deno.env.get("SETUP_SQL"), `${root}../supabase-setup.sql`, `${root}../site/supabase-setup.sql`, `${root}../ne-parsya/supabase-setup.sql`];
  const file = candidates.find((f) => f && (() => { try { return Deno.statSync(f).isFile; } catch { return false; } })())!;
  const sql = Deno.readTextFileSync(file)
    .replace(/^create extension if not exists pg_net.*$/m, "")
    .replace(/^create extension if not exists pg_cron;$/m, "");
  Deno.writeTextFileSync("/tmp/np_setup_test.sql", sql);
  await run(["-d", "nptest", "-f", `${root}tests/fake_supabase.sql`]);
  await run(["-d", "nptest", "-f", "/tmp/np_setup_test.sql"]);
}

export const PASSED: string[] = [];
export function ok(name: string) {
  PASSED.push(name);
  console.log(`  ✓ ${name}`);
}
export function assert(cond: unknown, msg = "проверка не прошла"): asserts cond {
  if (!cond) throw new Error(msg);
}
export const contains = (texts: string[], needle: string) => texts.some((t) => (t ?? "").includes(needle));
