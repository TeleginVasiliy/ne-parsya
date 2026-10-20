// Оплата по реквизитам: согласие с ценой → чек → подтверждение админом.
import { T } from "./texts.ts";
import type { Ctx } from "./ctx.ts";
import * as db from "./db.ts";
import * as K from "./kb.ts";
import * as screen from "./screen.ts";
import {
  adminName, amountDue, changeStatus, clientText, deliverResult, notifyClient, notifyOrderAdmins, sendPaymentInstructions,
} from "./services.ts";
import { ownOrder } from "./client.ts";
import * as tg from "./tg.ts";
import { fmt, money } from "./util.ts";

const KIND_BY_STATUS: Record<string, string> = { awaiting_payment: "prepay", awaiting_final: "final" };
const PAYMENT_KIND = T.PAYMENT_KIND as Record<string, string>;

export async function cbAgree(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  if (!o.price || !await changeStatus(ctx.config, o.id, "awaiting_payment", { notify: false, expected: ["new"] })) {
    await ctx.answer(T.ORDER_NOT_AVAILABLE, true);
    return;
  }
  await ctx.answer();
  const fresh = (await db.getOrder(o.id))!;
  await sendPaymentInstructions(ctx.config, fresh, "prepay");
  await notifyOrderAdmins(ctx.config, fresh, fmt(T.CLIENT_AGREED, { code: fresh.code }));
}

export async function cbPay(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  const kind = KIND_BY_STATUS[o.status];
  if (!kind) {
    await ctx.answer(T.ORDER_NOT_AVAILABLE, true);
    return;
  }
  await ctx.answer();
  await sendPaymentInstructions(ctx.config, o, kind);
}

export async function cbReceipt(ctx: Ctx, orderId: number) {
  const o = await ownOrder(ctx, orderId);
  if (!o) return;
  const kind = KIND_BY_STATUS[o.status];
  if (!kind) {
    await ctx.answer(T.ORDER_NOT_AVAILABLE, true);
    return;
  }
  await ctx.answer();
  await ctx.setState("receipt", { order_id: o.id, kind });
  await screen.newScreen(ctx.chatId, fmt(T.SEND_RECEIPT, { code: o.code }), K.backToOrderKb(o.id));
}

const isReceipt = (f: db.FileRef | null) =>
  !!f && (f.type === "photo" || (f.mime ?? "").startsWith("image/") || f.mime === "application/pdf");

async function paymentCaption(paymentId: number) {
  const p = (await db.getPayment(paymentId))!;
  const o = (await db.getOrder(p.order_id))!;
  return fmt(T.PAYMENT_CARD, {
    code: o.code, kind: PAYMENT_KIND[p.kind], client: await clientText(o.user_id), amount: money(p.amount),
    price: money(o.price), paid: money(o.paid),
  });
}

export async function onReceipt(ctx: Ctx) {
  const m = ctx.msg!;
  const f = tg.extractFile(m);
  if (!isReceipt(f)) {
    await screen.hint(m, T.RECEIPT_HINT);
    return;
  }
  const { order_id, kind } = ctx.data;
  const o = await db.getOrder(order_id);
  await ctx.clearState();
  if (!o || o.status !== { prepay: "awaiting_payment", final: "awaiting_final" }[kind as string]) {
    await screen.newScreen(ctx.chatId, T.ORDER_NOT_AVAILABLE, null, m.message_id);
    return;
  }
  const amount = amountDue(o, kind);
  const paymentId = await db.createPayment(o.id, kind, amount, f!);
  const caption = await paymentCaption(paymentId);
  for (const adminId of ctx.config.adminIds) { // чек — всем админам
    const msg = await tg.sendFile(adminId, f!.type, f!.file_id, caption, K.paymentCardKb(paymentId));
    if (msg) {
      await db.addCard(adminId, msg.message_id, "payment", paymentId);
      await db.mapMessage(adminId, msg.message_id, o.user_id, o.id);
    }
  }
  // Чек уже у админов (и сохранён в базе) — в чате оставляем только подтверждение
  await screen.newScreen(ctx.chatId, T.RECEIPT_RECEIVED, K.backToOrderKb(o.id), m.message_id);
}

/** Снимает кнопки с чека у всех админов и дописывает, кто его обработал. */
async function markPaymentCards(paymentId: number, mark: string) {
  const caption = (await paymentCaption(paymentId)) + mark;
  await Promise.all((await db.getCards("payment", paymentId)).map((c) =>
    tg.call("editMessageCaption", { chat_id: c.chat_id, message_id: c.message_id, caption: caption.slice(0, 1024), parse_mode: "HTML" })
  ));
}

export async function cbPaymentDecision(ctx: Ctx, action: string, paymentId: number) {
  const p = await db.getPayment(paymentId);
  if (!p) {
    await ctx.answer(T.PAY_ALREADY, true);
    return;
  }
  const ok = action === "ok";
  // Атомарно: второе нажатие (или второй админ) сюда уже не пройдёт
  if (!await db.resolvePayment(p.id, ok ? "confirmed" : "rejected", ctx.uid)) {
    await ctx.answer(T.PAY_ALREADY, true);
    return;
  }
  await ctx.answer(ok ? "✅" : "⚠️");
  const name = await adminName(ctx.uid);
  const o = (await db.getOrder(p.order_id))!;
  if (!ok) {
    await markPaymentCards(p.id, fmt(T.PAY_NO_MARK, { name }));
    await notifyClient(ctx.config, o, fmt(T.PAYMENT_NOT_FOUND, { code: o.code }), K.resendReceiptKb(o.id));
    return;
  }
  await db.addPaid(o.id, p.amount);
  if (!o.admin_id) await db.takeOrder(o.id, ctx.uid); // кто подтвердил оплату — тот и ведёт
  await markPaymentCards(p.id, fmt(T.PAY_DONE_MARK, { name }));
  if (p.kind === "prepay") {
    await changeStatus(ctx.config, o.id, "in_work", { notify: false });
    await notifyClient(ctx.config, o, fmt(T.PAYMENT_CONFIRMED, { code: o.code }));
  } else {
    await notifyClient(ctx.config, o, fmt(T.PAYMENT_CONFIRMED_FINAL, { code: o.code }));
    await deliverResult(ctx.config, o.id);
  }
}
