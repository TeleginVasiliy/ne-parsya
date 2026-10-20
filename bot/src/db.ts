// Хранилище: таблицы bot_* в базе Supabase (Postgres).
// Все «гонки» (два админа берут заказ, двойное нажатие «Оплата получена»)
// решаются атомарными UPDATE … WHERE: побеждает тот, чей запрос изменил строку.
import postgres from "npm:postgres@3.4.5";
import { makeCode, randomToken } from "./util.ts";
import type { ScreenState } from "./screen.ts";

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;
export interface Order {
  id: number;
  code: string;
  user_id: number;
  // deno-lint-ignore no-explicit-any
  data: Record<string, any>;
  source: string;
  status: string;
  price: number | null;
  prepay: number | null;
  paid: number;
  deadline_text: string | null;
  admin_id: number | null;
  reject_reason: string | null;
  created_at: Date;
  updated_at: Date;
  status_changed_at: Date;
  done_at: Date | null;
  remind_sent: boolean;
  review_requested: boolean;
  version: number;
  synced_version: number;
}

// deno-lint-ignore no-explicit-any
let sql: any = null;

export function connect(url?: string) {
  if (sql) return sql;
  const dsn = url || Deno.env.get("SUPABASE_DB_URL") || Deno.env.get("DATABASE_URL");
  if (!dsn) throw new Error("Нет адреса базы (SUPABASE_DB_URL)");
  sql = postgres(dsn, {
    prepare: false, max: 4, idle_timeout: 240, // соединение живёт между запросами — без повторного «рукопожатия»
    connect_timeout: 15, onnotice: () => {},
    types: { bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) } },
  });
  return sql;
}

export async function close() {
  if (sql) await sql.end({ timeout: 2 });
  sql = null;
}

export const counters = { queries: 0 }; // для замеров в тестах

export async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  counters.queries++;
  // deno-lint-ignore no-explicit-any
  const rows = await connect().unsafe(text, params as any[]);
  return [...rows] as T[];
}

export async function one<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}

/** Выполняет запрос и возвращает число изменённых строк. */
export async function exec(text: string, params: unknown[] = []): Promise<number> {
  counters.queries++;
  const res = await connect().unsafe(text, params);
  return res.count ?? 0;
}

// Любое изменение заказа увеличивает версию — так сайт получит все изменения
const TOUCH = "updated_at = now(), version = version + 1";

// ========================= settings =========================
export async function getSetting(key: string): Promise<string | null> {
  return (await one<{ value: string }>("select value from bot_settings where key = $1", [key]))?.value ?? null;
}

export async function setSetting(key: string, value: string) {
  await exec("insert into bot_settings(key, value) values($1, $2) on conflict (key) do update set value = excluded.value",
    [key, value]);
}

// ========================= users =========================
/** Создаёт или обновляет пользователя. true — если он новый. */
export async function upsertUser(id: number, firstName: string | null, username: string | null): Promise<boolean> {
  const row = await one<{ inserted: boolean }>(
    `insert into bot_users(id, first_name, username, last_seen) values($1, $2, $3, now())
     on conflict (id) do update set first_name = coalesce(excluded.first_name, bot_users.first_name),
       username = excluded.username, last_seen = now()
     returning (xmax = 0) as inserted`, [id, firstName, username]);
  return !!row?.inserted;
}

/** Вход апдейта: создать/обновить пользователя, снять «заблокировал бота», узнать, новый ли он и не заблокирован ли. */
export async function touchUser(id: number, firstName: string | null, username: string | null): Promise<{ inserted: boolean; blocked: boolean }> {
  const row = await one<{ inserted: boolean; blocked: boolean }>(
    `insert into bot_users(id, first_name, username, last_seen) values($1, $2, $3, now())
     on conflict (id) do update set first_name = coalesce(excluded.first_name, bot_users.first_name),
       username = excluded.username, last_seen = now(), bot_blocked = false
     returning (xmax = 0) as inserted, blocked`, [id, firstName, username]);
  return { inserted: !!row?.inserted, blocked: !!row?.blocked };
}

export async function setSourceIfEmpty(id: number, source: string) {
  await exec("update bot_users set source = $1 where id = $2 and source is null", [source, id]);
}

export async function getUser(id: number): Promise<Row | null> {
  return await one("select * from bot_users where id = $1", [id]);
}

export async function setBlocked(id: number, blocked: boolean) {
  return await exec("update bot_users set blocked = $1 where id = $2", [blocked, id]) > 0;
}

export async function setBotBlocked(id: number, value: boolean) {
  await exec("update bot_users set bot_blocked = $1 where id = $2 and bot_blocked <> $1", [value, id]);
}

export async function broadcastTargets(after = 0, limit = 100000): Promise<number[]> {
  const rows = await q<{ id: number }>(
    "select id from bot_users where blocked = false and bot_blocked = false and id > $1 order by id limit $2",
    [after, limit]);
  return rows.map((r) => r.id);
}

export async function countBroadcastTargets(): Promise<number> {
  return (await one<{ n: number }>("select count(*)::int n from bot_users where blocked = false and bot_blocked = false"))!.n;
}

/** Личный ключ клиента для кабинета на сайте (создаётся один раз). */
export async function siteToken(userId: number): Promise<string> {
  const row = await one<{ site_token: string | null }>("select site_token from bot_users where id = $1", [userId]);
  if (row?.site_token) return row.site_token;
  const token = randomToken(24);
  await exec("update bot_users set site_token = $1 where id = $2 and site_token is null", [token, userId]);
  return (await one<{ site_token: string }>("select site_token from bot_users where id = $1", [userId]))?.site_token ?? token;
}

// ========================= orders =========================
// deno-lint-ignore no-explicit-any
export async function createOrder(userId: number, data: Record<string, any>, source: string, preferred?: string | null): Promise<Order> {
  const candidates = [...(preferred ? [preferred] : []), ...Array.from({ length: 20 }, () => makeCode())];
  for (const code of candidates) {
    const row = await one<Order>(
      `insert into bot_orders(code, user_id, data, source) values($1, $2, $3::text::jsonb, $4)
       on conflict (code) do nothing returning *`, [code, userId, JSON.stringify(data), source]);
    if (row) return row;
  }
  throw new Error("Не удалось подобрать свободный номер заказа");
}

export async function getOrder(id: number | null | undefined): Promise<Order | null> {
  if (!id) return null;
  return await one<Order>("select * from bot_orders where id = $1", [id]);
}

export async function getOrderByCode(code: string): Promise<Order | null> {
  return await one<Order>("select * from bot_orders where code = $1", [code.trim().replace(/^#+/, "").toUpperCase()]);
}

/** Та же заявка с сайта пришла повторно (двойное нажатие, запасной способ доставки).
 *  Дубль — только тот же номер И то же содержимое за последний час: старые версии сайта
 *  повторяли номер заявки и для следующих заказов, их больше не считаем дублями. */
// deno-lint-ignore no-explicit-any
export async function findSiteDuplicate(userId: number, siteId: string, lines: any[]): Promise<Order | null> {
  return await one<Order>(
    `select * from bot_orders where user_id = $1 and data->>'site_id' = $2 and data->'lines' = $3::text::jsonb
     and created_at > now() - interval '1 hour' order by id desc limit 1`, [userId, siteId, JSON.stringify(lines)]);
}

export async function userOrders(userId: number, limit = 15): Promise<Order[]> {
  return await q<Order>("select * from bot_orders where user_id = $1 order by id desc limit $2", [userId, limit]);
}

export async function activeOrderForUser(userId: number): Promise<Order | null> {
  return await one<Order>(
    "select * from bot_orders where user_id = $1 and status not in ('done', 'cancelled') order by id desc limit 1", [userId]);
}

export async function listOrders(status: string | null, adminId: number | null, limit = 10, offset = 0): Promise<[Order[], number]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (adminId) {
    params.push(adminId);
    where.push(`admin_id = $${params.length}`);
  }
  const clause = where.length ? "where " + where.join(" and ") : "";
  const total = (await one<{ n: number }>(`select count(*)::int n from bot_orders ${clause}`, params))!.n;
  const rows = await q<Order>(
    `select * from bot_orders ${clause} order by id desc limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset]);
  return [rows, total];
}

/** Закрепляет заказ, только если он ещё ничей. Атомарно. */
export async function takeOrder(orderId: number, adminId: number): Promise<boolean> {
  return await exec(`update bot_orders set admin_id = $1, ${TOUCH} where id = $2 and admin_id is null`, [adminId, orderId]) === 1;
}

export async function assignOrder(orderId: number, adminId: number) {
  await exec(`update bot_orders set admin_id = $1, ${TOUCH} where id = $2`, [adminId, orderId]);
}

/** Меняет статус. expected — статусы, из которых переход допустим (защита от гонок). */
export async function setStatus(orderId: number, status: string, expected?: string[] | null): Promise<boolean> {
  let text = `update bot_orders set status = $1, ${TOUCH}, status_changed_at = now(), remind_sent = false,
    done_at = case when $1 = 'done' then now() else done_at end where id = $2`;
  const params: unknown[] = [status, orderId];
  if (expected?.length) {
    params.push(expected);
    text += " and status = any($3::text[])";
  }
  return await exec(text, params) === 1;
}

export async function setPrice(orderId: number, price: number, prepay: number, deadlineText: string) {
  await exec(`update bot_orders set price = $1, prepay = $2, deadline_text = $3, ${TOUCH} where id = $4`,
    [price, prepay, deadlineText, orderId]);
}

export async function setRejectReason(orderId: number, reason: string) {
  await exec(`update bot_orders set reject_reason = $1, ${TOUCH} where id = $2`, [reason, orderId]);
}

export async function addPaid(orderId: number, amount: number) {
  await exec(`update bot_orders set paid = paid + $1, ${TOUCH} where id = $2`, [amount, orderId]);
}

export async function markReminded(orderId: number) {
  await exec("update bot_orders set remind_sent = true where id = $1", [orderId]);
}

export async function markReviewRequested(orderId: number): Promise<boolean> {
  return await exec("update bot_orders set review_requested = true where id = $1 and review_requested = false", [orderId]) === 1;
}

export async function ordersAwaitingSince(status: string, hours: number): Promise<Order[]> {
  return await q<Order>(
    "select * from bot_orders where status = $1 and status_changed_at <= now() - make_interval(hours => $2)", [status, hours]);
}

export async function ordersDoneBefore(hours: number): Promise<Order[]> {
  return await q<Order>(
    "select * from bot_orders where status = 'done' and review_requested = false and done_at <= now() - make_interval(hours => $1)",
    [hours]);
}

export async function activeCountByAdmin(): Promise<Map<number, number>> {
  const rows = await q<{ admin_id: number; n: number }>(
    `select admin_id, count(*)::int n from bot_orders where admin_id is not null
     and status not in ('done', 'cancelled') group by admin_id`);
  return new Map(rows.map((r) => [r.admin_id, r.n]));
}

export async function touchOrder(orderId: number) {
  await exec(`update bot_orders set ${TOUCH} where id = $1`, [orderId]);
}

// ========================= files =========================
export interface FileRef {
  file_id: string;
  type: string;
  name?: string | null;
  mime?: string;
}

export async function addFile(orderId: number, kind: string, f: FileRef, cloudPath: string | null = null, cloudId: string | null = null) {
  await exec(
    `insert into bot_files(order_id, kind, file_id, file_type, file_name, cloud_path, cloud_id)
     values($1, $2, $3, $4, $5, $6, $7)`, [orderId, kind, f.file_id, f.type, f.name ?? null, cloudPath, cloudId]);
  await touchOrder(orderId); // → синхронизация с сайтом
}

export async function getFiles(orderId: number, kind: string): Promise<Row[]> {
  return await q("select * from bot_files where order_id = $1 and kind = $2 order by id", [orderId, kind]);
}

export async function deleteFiles(orderId: number, kind: string) {
  await exec("delete from bot_files where order_id = $1 and kind = $2", [orderId, kind]);
}

export async function allFiles(orderId: number): Promise<Row[]> {
  return await q("select * from bot_files where order_id = $1 order by id", [orderId]);
}

/** Файл из хранилища уже загружен в Telegram — дальше пересылаем по его идентификатору. */
export async function setFileTgId(rowId: number, fileId: string) {
  await exec("update bot_files set file_id = $1 where id = $2", [fileId, rowId]);
}

export async function setFileCloud(rowId: number, cloudPath: string, cloudId: string) {
  await exec("update bot_files set cloud_path = $1, cloud_id = $2 where id = $3", [cloudPath, cloudId, rowId]);
}

// ========================= синхронизация с сайтом =========================
export async function ordersToSync(limit = 20): Promise<Order[]> {
  // Сначала самые свежие изменения: заказ, который почему-то не выгружается, не задерживает остальные
  return await q<Order>("select * from bot_orders where synced_version < version order by updated_at desc limit $1", [limit]);
}

export async function markSynced(orderId: number, version: number) {
  await exec("update bot_orders set synced_version = greatest(synced_version, $1) where id = $2", [version, orderId]);
}

export async function paymentsForOrder(orderId: number): Promise<Row[]> {
  return await q("select * from bot_payments where order_id = $1 order by id", [orderId]);
}

export async function setPaymentCloud(paymentId: number, path: string) {
  await exec("update bot_payments set cloud_path = $1 where id = $2", [path, paymentId]);
}

// ========================= payments =========================
export async function createPayment(orderId: number, kind: string, amount: number, f: FileRef): Promise<number> {
  const row = await one<{ id: number }>(
    "insert into bot_payments(order_id, kind, amount, file_id, file_type) values($1, $2, $3, $4, $5) returning id",
    [orderId, kind, amount, f.file_id, f.type]);
  await touchOrder(orderId);
  return row!.id;
}

export async function getPayment(id: number): Promise<Row | null> {
  return await one("select * from bot_payments where id = $1", [id]);
}

/** confirmed / rejected — только из pending. Второе нажатие вернёт false. */
export async function resolvePayment(id: number, status: string, adminId: number): Promise<boolean> {
  const row = await one<{ order_id: number }>(
    `update bot_payments set status = $1, confirmed_by = $2, confirmed_at = now()
     where id = $3 and status = 'pending' returning order_id`, [status, adminId, id]);
  if (!row) return false;
  await touchOrder(row.order_id);
  return true;
}

// ========================= messages map & cards =========================
export async function mapMessage(chatId: number, messageId: number, userId: number, orderId: number | null) {
  await exec(
    `insert into bot_messages_map(chat_id, message_id, user_id, order_id) values($1, $2, $3, $4)
     on conflict (chat_id, message_id) do update set user_id = excluded.user_id, order_id = excluded.order_id`,
    [chatId, messageId, userId, orderId]);
}

export async function lookupMessage(chatId: number, messageId: number): Promise<Row | null> {
  return await one("select * from bot_messages_map where chat_id = $1 and message_id = $2", [chatId, messageId]);
}

export async function addCard(chatId: number, messageId: number, kind: string, refId: number) {
  await exec(
    `insert into bot_cards(chat_id, message_id, kind, ref_id) values($1, $2, $3, $4)
     on conflict (chat_id, message_id) do update set kind = excluded.kind, ref_id = excluded.ref_id`,
    [chatId, messageId, kind, refId]);
}

export async function getCards(kind: string, refId: number): Promise<Row[]> {
  return await q("select * from bot_cards where kind = $1 and ref_id = $2", [kind, refId]);
}

// ========================= screens =========================
// В bot_screens.ids раньше лежал просто список сообщений; теперь — объект
// { ids, menu, cur, hist } (старый формат читается как раньше, база не меняется).
export async function getScreen(chatId: number): Promise<ScreenState> {
  const row = await one<{ ids: unknown }>("select ids from bot_screens where chat_id = $1", [chatId]);
  const v = row?.ids;
  if (Array.isArray(v)) return { ids: v as number[], menu: null, cur: null, hist: [] };
  // deno-lint-ignore no-explicit-any
  const o = (v && typeof v === "object" ? v : {}) as any;
  return {
    ids: Array.isArray(o.ids) ? o.ids : [], menu: typeof o.menu === "number" ? o.menu : null,
    cur: o.cur ?? null, hist: Array.isArray(o.hist) ? o.hist : [],
  };
}

export async function setScreen(chatId: number, s: ScreenState) {
  await exec(
    "insert into bot_screens(chat_id, ids) values($1, $2::text::jsonb) on conflict (chat_id) do update set ids = excluded.ids",
    [chatId, JSON.stringify({ ...s, ids: s.ids.slice(-50) })]);
}

// ========================= состояния диалогов =========================
// deno-lint-ignore no-explicit-any
export async function getState(userId: number): Promise<{ state: string | null; data: Record<string, any> }> {
  const row = await one<{ state: string | null; data: Row }>("select state, data from bot_states where user_id = $1", [userId]);
  return { state: row?.state ?? null, data: row?.data ?? {} };
}

// deno-lint-ignore no-explicit-any
export async function saveState(userId: number, state: string | null, data: Record<string, any>) {
  await exec(
    `insert into bot_states(user_id, state, data, updated_at) values($1, $2, $3::text::jsonb, now())
     on conflict (user_id) do update set state = excluded.state, data = excluded.data, updated_at = now()`,
    [userId, state, JSON.stringify(data)]);
}

// ========================= reviews =========================
export async function createReview(orderId: number, userId: number, rating: number): Promise<number | null> {
  const row = await one<{ id: number }>(
    "insert into bot_reviews(order_id, user_id, rating) values($1, $2, $3) on conflict (order_id) do nothing returning id",
    [orderId, userId, rating]);
  return row?.id ?? null;
}

export async function setReviewText(id: number, text: string | null) {
  await exec("update bot_reviews set text = $1 where id = $2", [text, id]);
}

export async function getReview(id: number): Promise<Row | null> {
  return await one("select * from bot_reviews where id = $1", [id]);
}

export async function publishReview(id: number, adminId: number): Promise<boolean> {
  return await exec("update bot_reviews set published = true, published_by = $1 where id = $2 and published = false",
    [adminId, id]) === 1;
}

export async function publishedReviews(): Promise<Row[]> {
  return await q(
    `select r.*, u.first_name, o.data as order_data from bot_reviews r
     left join bot_users u on u.id = r.user_id left join bot_orders o on o.id = r.order_id
     where r.published order by r.id desc`);
}

// ========================= stats =========================
export async function stats() {
  const n = async (text: string) => Number((await one<{ n: unknown }>(text))!.n ?? 0);
  const total = await n("select count(*) n from bot_orders");
  const week = await n("select count(*) n from bot_orders where created_at >= now() - interval '7 days'");
  const month = await n("select count(*) n from bot_orders where created_at >= now() - interval '30 days'");
  const paidSum = await n("select coalesce(sum(amount), 0) n from bot_payments where status = 'confirmed'");
  const paidOrders = await n("select count(*) n from bot_orders where paid > 0");
  const avgRow = await one<{ a: string | null }>("select avg(price) a from bot_orders where paid > 0 and price is not null");
  const users = await n("select count(*) n from bot_users");
  const usersSite = await n("select count(*) n from bot_users where source = 'site'");
  const bySource = await q<{ source: string; n: number }>(
    "select source, count(*)::int n from bot_orders group by source order by n desc");
  const byType = await q<{ type: string; n: number }>(
    "select data->>'type' as type, count(*)::int n from bot_orders group by 1 order by n desc");
  const byAdmin = await q<{ admin_id: number; first_name: string | null; n: number; paid: number }>(
    `select o.admin_id, u.first_name, count(*)::int n, coalesce(sum(o.paid), 0)::int paid from bot_orders o
     left join bot_users u on u.id = o.admin_id where o.admin_id is not null
     group by o.admin_id, u.first_name order by n desc`);
  return {
    total, week, month, paidSum, paidOrders, avg: avgRow?.a ? Math.round(Number(avgRow.a)) : null, users, usersSite,
    bySource, byType, byAdmin,
  };
}

// ========================= служебное =========================
/** true — апдейт новый; false — Telegram прислал его повторно. */
export async function claimUpdate(updateId: number): Promise<boolean> {
  return !!(await one("insert into bot_updates(update_id) values($1) on conflict do nothing returning update_id", [updateId]));
}

/** Очередь одного пользователя: его сообщения обрабатываются строго по одному.
 *  Заодно (тем же запросом) читает его шаг диалога. null — не дождались очереди. */
// deno-lint-ignore no-explicit-any
export async function lock(chatId: number, waitMs = 20000): Promise<{ state: string | null; data: Record<string, any> } | null> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const got = await one<{ state: string | null; data: Row | null }>(
      `with l as (
         insert into bot_locks(chat_id, until) values($1, now() + interval '40 seconds')
         on conflict (chat_id) do update set until = excluded.until where bot_locks.until < now()
         returning chat_id)
       select s.state, s.data from l left join bot_states s on s.user_id = l.chat_id`, [chatId]);
    if (got) return { state: got.state ?? null, data: got.data ?? {} };
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export async function unlock(chatId: number) {
  await exec("delete from bot_locks where chat_id = $1", [chatId]);
}

export async function cleanup() {
  await exec("delete from bot_updates where created_at < now() - interval '2 days'");
  await exec("delete from bot_locks where until < now() - interval '1 hour'");
  await exec("delete from bot_messages_map where created_at < now() - interval '180 days'");
}
