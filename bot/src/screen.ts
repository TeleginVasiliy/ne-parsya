// Чистый чат: у клиента в чате всегда виден только один «экран».
//
// Каждое новое сообщение бота (меню, шаг анкеты, уведомление о цене или статусе,
// ответ исполнителя) заменяет предыдущее, нажатия кнопок меню тоже удаляются.
// Ничего не теряется:
//   • кнопка «⬅️ Назад» возвращает предыдущий экран (бот помнит несколько последних);
//   • заказы, цены, реквизиты, статусы и готовые файлы всегда есть в «📦 Мои заказы»;
//   • сообщение «Главное меню 👇» с клавиатурой не удаляется никогда — поэтому клавиатура
//     не пропадает, а чат не становится пустым (пустой чат Telegram показывает как «Запустить»).
// Если Telegram не принял новое сообщение, старый экран остаётся на месте.
// У админов чат не чистится.
import * as db from "./db.ts";
import * as tg from "./tg.ts";
import type { Markup, Msg } from "./tg.ts";
import { background } from "./bg.ts";

export const BACK_TEXT = "◀️ Назад";
export const BACK_DATA = "c:back:0";
export const HOME_TEXT = "⏮ В начало";
export const HOME_DATA = "c:home:0";
const HISTORY = 6; // сколько прошлых экранов можно вернуть кнопкой «Назад»

/** Экран, который можно показать снова: текст и кнопки (без «Назад» — её добавляем сами). */
type Snap = { t: string; k: Markup };
export interface ScreenState {
  ids: number[];
  menu: number | null; // сообщение с клавиатурой главного меню
  cur: Snap | null;
  hist: Snap[];
}

// Клавиатура главного меню (её даёт index.ts — ей нужна ссылка на сайт из настроек; у админов в ней есть админ-панель)
let menuFactory: ((chatId: number) => Promise<{ text: string; markup: Markup }>) | null = null;
export function setMenuFactory(fn: typeof menuFactory) {
  menuFactory = fn;
}

// Старые сообщения удаляются уже после ответа Telegram — пользователь этого не ждёт
function remove(chatId: number, ids: number[]) {
  if (ids.length) background(Promise.all(ids.map((id) => tg.deleteMessage(chatId, id))));
}

const isInline = (k: Markup) => !k || Array.isArray(k.inline_keyboard);
const strip = (k: Markup): Markup => {
  if (!k?.inline_keyboard) return k;
  const rows = k.inline_keyboard.filter((row: { callback_data?: string }[]) =>
    !row.some((b) => b.callback_data === BACK_DATA || b.callback_data === HOME_DATA));
  return rows.length ? { ...k, inline_keyboard: rows } : null;
};
/** Добавляет «⬅️ Назад», если есть куда возвращаться, а если шагов назад много — ещё и «⏮ В начало». */
function withBack(k: Markup, canGoBack: boolean | number): Markup {
  const depth = Number(canGoBack);
  if (!depth || !isInline(k)) return k;
  const row = [{ text: BACK_TEXT, callback_data: BACK_DATA }];
  if (depth > 1) row.push({ text: HOME_TEXT, callback_data: HOME_DATA });
  return { inline_keyboard: [...(strip(k)?.inline_keyboard ?? []), row] };
}

/** Добавить сообщения к текущему экрану (удалятся при следующем переходе). */
export async function track(chatId: number, ...ids: (number | undefined | null)[]) {
  const add = ids.filter((i): i is number => !!i);
  if (!add.length) return;
  const s = await db.getScreen(chatId);
  await db.setScreen(chatId, { ...s, ids: [...s.ids, ...add] });
}

/** Удалить текущий экран. keep — сообщение, которое нужно оставить. */
export async function clear(chatId: number, keep?: number) {
  const s = await db.getScreen(chatId);
  await db.setScreen(chatId, { ...s, ids: [] });
  remove(chatId, s.ids.filter((i) => i !== keep && i !== s.menu));
}

/** Запомнить, что сейчас на экране (до отправки новых сообщений — чтобы потом убрать их разом). */
export async function begin(chatId: number): Promise<ScreenState> {
  return await db.getScreen(chatId);
}

/** Завершить переход: новые сообщения становятся экраном, а то, что было до begin(), удаляется.
 *  Прежний экран уходит в историю — «⬅️ Назад» вернёт его. */
export async function commit(chatId: number, before: ScreenState, newIds: number[], snap: Snap | null = null) {
  const now = await db.getScreen(chatId);
  const added = now.ids.filter((i) => !before.ids.includes(i)); // появилось, пока отправляли
  const hist = before.cur ? [...before.hist, before.cur].slice(-HISTORY) : before.hist;
  await db.setScreen(chatId, { ...now, ids: [...new Set([...added, ...newIds])], cur: snap, hist });
  remove(chatId, before.ids.filter((i) => !newIds.includes(i) && i !== now.menu));
}

/** Сообщение «Главное меню 👇» с клавиатурой: отправить, если его ещё нет (или заменить на свежее). */
export async function ensureMenu(chatId: number, s?: ScreenState, renew = false): Promise<void> {
  if (!menuFactory) return;
  const state = s ?? await db.getScreen(chatId);
  if (state.menu && !renew) return;
  const { text, markup } = await menuFactory(chatId);
  const msg = await tg.sendText(chatId, text, markup);
  if (!msg) return;
  const fresh = await db.getScreen(chatId);
  const old = fresh.menu;
  await db.setScreen(chatId, { ...fresh, menu: msg.message_id, ids: fresh.ids.filter((i) => i !== msg.message_id) });
  if (old && old !== msg.message_id) remove(chatId, [old]);
}

/** Новый экран: отправляет сообщение, затем убирает предыдущий экран и нажатие пользователя.
 *  Если Telegram не принял сообщение, прежний экран не трогаем — чат не опустеет. */
export async function newScreen(chatId: number, text: string, markup?: Markup, userMsgId?: number | null,
  opts: { history?: boolean; menu?: boolean } = {}): Promise<Msg | null> {
  const old = await db.getScreen(chatId);
  const remember = opts.history !== false;
  const depth = remember ? old.hist.length + (old.cur ? 1 : 0) : 0;
  const msg = await tg.sendText(chatId, text, withBack(markup, depth));
  if (!msg) {
    if (userMsgId) await track(chatId, userMsgId);
    return null;
  }
  // Прошлый экран уходит в историю. Шаги анкеты (history: false) сами в историю не попадают
  const hist = old.cur ? [...old.hist, old.cur].slice(-HISTORY) : old.hist;
  const cur = remember && isInline(markup) ? { t: text, k: strip(markup) ?? null } : null;
  await db.setScreen(chatId, { ...old, ids: [msg.message_id], cur, hist });
  remove(chatId, [...old.ids.filter((i) => i !== old.menu), ...(userMsgId ? [userMsgId] : [])]);
  if (!old.menu && opts.menu !== false) await ensureMenu(chatId); // клавиатура пропала (старый чат) — возвращаем
  return msg;
}

/** Переход внутри того же сообщения (список заказов → заказ): правка на месте, «Назад» вернёт прошлое. */
export async function editScreen(chatId: number, messageId: number, text: string, markup?: Markup): Promise<Msg | null> {
  const old = await db.getScreen(chatId);
  const hist = old.cur ? [...old.hist, old.cur].slice(-HISTORY) : old.hist;
  const msg = await tg.editText(chatId, messageId, text, withBack(markup, hist.length));
  if (!msg) return await newScreen(chatId, text, markup);
  await db.setScreen(chatId, { ...old, cur: { t: text, k: strip(markup) ?? null }, hist });
  return msg;
}

/** «⬅️ Назад»: показать предыдущий экран (home — самый первый из запомненных). false — возвращаться некуда. */
export async function back(chatId: number, messageId: number, home = false): Promise<boolean> {
  const s = await db.getScreen(chatId);
  const prev = home ? s.hist[0] : s.hist[s.hist.length - 1];
  if (!prev) return false;
  const hist = home ? [] : s.hist.slice(0, -1);
  const markup = withBack(prev.k, hist.length);
  // Чаще всего «Назад» нажимают на текущем экране — правим его на месте, без мигания
  if (s.ids.includes(messageId) && await tg.editText(chatId, messageId, prev.t, markup)) {
    await db.setScreen(chatId, { ...s, ids: [messageId], cur: prev, hist });
    remove(chatId, s.ids.filter((i) => i !== messageId && i !== s.menu));
    return true;
  }
  const msg = await tg.sendText(chatId, prev.t, markup);
  if (!msg) return false;
  await db.setScreen(chatId, { ...s, ids: [msg.message_id], cur: prev, hist });
  remove(chatId, s.ids.filter((i) => i !== s.menu));
  return true;
}

/** Сделать уже отправленное сообщение (например, фото) новым экраном. */
export async function adopt(chatId: number, msg: Msg | null, userMsgId?: number | null) {
  const old = await db.getScreen(chatId);
  if (!msg) return; // ничего не отправилось — прежний экран остаётся
  await db.setScreen(chatId, { ...old, ids: [msg.message_id], cur: null });
  remove(chatId, [...old.ids.filter((i) => i !== msg.message_id && i !== old.menu), ...(userMsgId ? [userMsgId] : [])]);
}

/** Ещё одно сообщение в рамках текущего экрана (подсказка, ошибка, второе сообщение). */
export async function add(chatId: number, text: string, markup?: Markup): Promise<Msg | null> {
  const msg = await tg.sendText(chatId, text, markup);
  if (msg) await track(chatId, msg.message_id);
  return msg;
}

/** Ответ-подсказка на сообщение пользователя: и его сообщение, и подсказка уйдут с экраном. */
export async function hint(m: Msg, text: string, markup?: Markup): Promise<Msg | null> {
  await track(m.chat.id, m.message_id);
  return await add(m.chat.id, text, markup);
}
