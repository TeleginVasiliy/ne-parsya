// Настройки бота. Берутся из Supabase → Edge Functions → Secrets
// (и перечитываются при каждом запросе — после правки ничего перезапускать не нужно).

export interface Config {
  token: string;
  adminIds: number[];
  ownerId: number;
  webappUrl: string;
  paymentDetails: string;
  pay: PayOptions;
  prepaymentPercent: number;
  tz: string;
  setupMode: boolean;
  isAdmin(id?: number | null): boolean;
  isOwner(id?: number | null): boolean;
  secrets: string[];
}

/** Быстрая оплата: номер для СБП, карта (кнопки «Скопировать») и ссылки банков на оплату. */
export interface PayOptions {
  phone: string;
  bank: string;
  card: string;
  links: { name: string; url: string }[];
}

export class ConfigError extends Error {}

function env(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

function parseIds(raw: string): number[] {
  const ids: number[] = [];
  for (const part of raw.replace(/[; ]/g, ",").split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (!/^-?\d+$/.test(p)) {
      throw new ConfigError(`ADMIN_IDS: «${p}» — не число. Нужны числовые ID через запятую (узнать свой: отправьте боту /id).`);
    }
    ids.push(Number(p));
  }
  return ids;
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("ru", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(): Config {
  const token = env("BOT_TOKEN");
  if (!token || !token.includes(":")) {
    throw new ConfigError("BOT_TOKEN не задан: добавьте его в Supabase → Edge Functions → Secrets.");
  }
  const ownerRaw = env("OWNER_ID");
  if (ownerRaw && !/^-?\d+$/.test(ownerRaw)) throw new ConfigError("OWNER_ID должен быть числом (узнать: /id).");
  const ownerId = ownerRaw ? Number(ownerRaw) : 0;
  const adminIds = parseIds(env("ADMIN_IDS"));
  if (ownerId && !adminIds.includes(ownerId)) adminIds.push(ownerId); // владелец всегда админ

  let percent = parseInt(env("PREPAYMENT_PERCENT") || "100", 10);
  if (isNaN(percent)) percent = 100;
  percent = Math.max(1, Math.min(100, percent));

  // В поле секрета переносы строк можно писать как \n
  // Перенос строки часто пишут как «\n» или «/n» — оба превращаем в настоящий перенос, лишние «\» убираем
  const details = (Deno.env.get("PAYMENT_DETAILS") ?? "").replace(/\\n|\/n(?![a-zа-яё])/g, "\n").replace(/\\/g, "").trim();
  const links = (Deno.env.get("PAYMENT_LINKS") ?? "").replace(/\\n/g, "\n").split(/[\n;]+/).map((line) => {
    // «Т-Банк | https://…» или просто ссылка
    const m = /^\s*(.*?)\s*\|\s*(https:\/\/\S+)\s*$/.exec(line) ?? /^\s*()(https:\/\/\S+)\s*$/.exec(line);
    return m ? { name: m[1] || "банк", url: m[2] } : null;
  }).filter((x): x is { name: string; url: string } => !!x).slice(0, 6);
  const pay: PayOptions = {
    phone: env("PAYMENT_PHONE").replace(/[^\d+]/g, ""), bank: env("PAYMENT_BANK"), card: env("PAYMENT_CARD").replace(/[^\d ]/g, "").trim(), links,
  };
  let tz = env("TIMEZONE") || "Europe/Moscow";
  if (!validTz(tz)) tz = "Europe/Moscow";

  const secrets = [token, pay.phone, pay.card, ...details.split("\n").map((l) => l.trim()).filter((l) => l.length >= 6)];
  return {
    token, adminIds, ownerId, webappUrl: env("WEBAPP_URL"), paymentDetails: details, pay, prepaymentPercent: percent, tz,
    setupMode: !ownerId,
    isAdmin: (id) => !!id && adminIds.includes(id),
    isOwner: (id) => !!ownerId && id === ownerId,
    secrets,
  };
}

/** Логи без токена и реквизитов. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out;
}

let SECRETS: string[] = [];
export function setLogSecrets(s: string[]) {
  SECRETS = s;
}
export function log(...args: unknown[]) {
  console.log(redact(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "), SECRETS));
}
