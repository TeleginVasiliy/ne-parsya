// Фоновые задачи (каждую минуту по расписанию Supabase): напоминания об оплате,
// автоотмена, запрос отзыва, рассылка и связь с сайтом.
import { T } from "./texts.ts";
import type { Config } from "./config.ts";
import { log } from "./config.ts";
import * as db from "./db.ts";
import * as K from "./kb.ts";
import { changeStatus, notifyClient, notifyOrderAdmins } from "./services.ts";
import { runBroadcasts } from "./admin.ts";
import { pushSettings, syncOnce } from "./cloud.ts";
import { fmt } from "./util.ts";

const REMIND_AFTER_H = 24;
const CANCEL_AFTER_H = 72;
const REVIEW_AFTER_H = 24;
const EVERY_MIN = 10; // напоминания проверяем раз в 10 минут

export async function runReminders(config: Config) {
  // 1) Ожидает оплаты > 72 ч — автоотмена; > 24 ч — одно напоминание
  for (const o of await db.ordersAwaitingSince("awaiting_payment", CANCEL_AFTER_H)) {
    if (o.paid) continue;
    if (await changeStatus(config, o.id, "cancelled", { notify: false, expected: ["awaiting_payment"] })) {
      await notifyClient(config, o, fmt(T.AUTO_CANCELLED, { code: o.code }));
      await notifyOrderAdmins(config, o, fmt(T.AUTO_CANCELLED, { code: o.code }));
    }
  }
  for (const o of await db.ordersAwaitingSince("awaiting_payment", REMIND_AFTER_H)) {
    if (!o.remind_sent) {
      await db.markReminded(o.id);
      await notifyClient(config, o, fmt(T.PAY_REMINDER, { code: o.code }), K.payKb(o.id, false, config.pay, o.price ? Math.max(0, (o.prepay || o.price) - o.paid) : 0, o.code));
    }
  }
  // 2) Работа готова, ждёт доплаты > 24 ч — напоминание (без автоотмены)
  for (const o of await db.ordersAwaitingSince("awaiting_final", REMIND_AFTER_H)) {
    if (!o.remind_sent) {
      await db.markReminded(o.id);
      await notifyClient(config, o, fmt(T.PAY_REMINDER_FINAL, { code: o.code }), K.payKb(o.id, true, config.pay, Math.max(0, (o.price || 0) - o.paid), o.code));
    }
  }
  // 3) Через сутки после «Выполнен» — просим оценку
  for (const o of await db.ordersDoneBefore(REVIEW_AFTER_H)) {
    if (await db.markReviewRequested(o.id)) await notifyClient(config, o, fmt(T.REVIEW_ASK, { code: o.code }), K.ratingKb(o.id));
  }
  await db.exec("delete from bot_handoff where created_at < now() - interval '1 day'"); // брошенные заявки с сайта
  await db.cleanup();
}

/** Напоминания не чаще раза в 10 минут — даже если нас будят чаще. */
async function remindersDue(): Promise<boolean> {
  return !!(await db.one(
    `insert into bot_settings(key, value) values('jobs_at', now()::text)
     on conflict (key) do update set value = excluded.value
     where bot_settings.value is null or bot_settings.value::timestamptz < now() - make_interval(mins => $1)
     returning key`, [EVERY_MIN]));
}

export async function runJobs(config: Config, opts: { reminders?: boolean } = {}) {
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      log(`Фоновая задача «${name}» не удалась: ${(e as Error).message}`);
    }
  };
  await step("сайт", () => syncOnce(config));
  if (opts.reminders !== false && await remindersDue()) {
    await step("напоминания", () => runReminders(config));
    await step("реквизиты на сайт", () => pushSettings(config));
  }
  await step("рассылка", () => runBroadcasts());
}
