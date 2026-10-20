// Вспомогательные функции: экранирование, форматирование, разбивка текста.

export const TG_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих 0/O, 1/I

/** Экранирует пользовательский текст для HTML-разметки Telegram. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Подстановка {name} в шаблон текста. */
export function fmt(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k] ?? "") : m));
}

function randomInt(n: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

export function makeCode(length = 4): string {
  let s = "";
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function randomToken(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function plural(n: number, forms: readonly string[]): string {
  const a = Math.abs(n) % 100, b = Math.abs(n) % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";
}

export function userLink(userId: number, name?: string | null, username?: string | null): string {
  const parts = [`<a href="tg://user?id=${userId}">${esc(name || "Без имени")}</a>`];
  if (username) parts.push(`@${esc(username)}`);
  parts.push(`<code>${userId}</code>`);
  return parts.join(" · ");
}

/** Добавляет к ссылке параметр ?key=value (сайт так узнаёт, как его открыли). */
export function withParam(url: string, key: string, value: string): string {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const [path, query = ""] = base.split(/\?(.*)/s, 2) as [string, string?];
  const params = new URLSearchParams(query);
  params.set(key, value);
  return `${path}?${params.toString()}${hash}`;
}

export function isValidHttpsUrl(url: string): boolean {
  if (!url || url.length > 512 || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.hostname.startsWith(".");
  } catch {
    return false;
  }
}

/** Режет длинный текст на части по строкам, чтобы не превысить лимит Telegram. */
export function splitText(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (let line of text.split("\n")) {
    while (line.length > limit) {
      let cut = limit;
      const amp = line.lastIndexOf("&", cut - 1); // не разрезаем HTML-сущность вроде &amp;
      if (amp !== -1 && !line.slice(amp, cut).includes(";")) cut = amp;
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ----------------------- даты в часовом поясе -----------------------

function parts(d: Date, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** Сегодняшняя дата в часовом поясе как YYYY-MM-DD. */
export function todayIso(tz: string, now = new Date()): string {
  const p = parts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD → ДД.ММ.ГГГГ */
export function ruDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function makeIsoDate(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/** «20.10 14:05» в часовом поясе. */
export function fmtDt(value: Date | string | null | undefined, tz: string): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "—";
  const p = parts(d, tz);
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
