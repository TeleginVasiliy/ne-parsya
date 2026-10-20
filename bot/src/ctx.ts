// Контекст обработки одного апдейта: кто пишет, его шаг диалога, ответы на кнопки.
import type { Config } from "./config.ts";
import * as db from "./db.ts";
import * as tg from "./tg.ts";
import type { Msg } from "./tg.ts";

// deno-lint-ignore no-explicit-any
type Data = Record<string, any>;

export class Ctx {
  state: string | null = null;
  data: Data = {};
  isNewUser = false;
  answered = false;

  constructor(public config: Config, public msg: Msg | null, public cbq: Msg | null) {}

  get from(): Msg {
    return (this.msg ?? this.cbq)!.from;
  }
  get uid(): number {
    return this.from.id;
  }
  /** Чат, где всё происходит: для кнопки — чат её сообщения. */
  get chatId(): number {
    return this.msg ? this.msg.chat.id : (this.cbq!.message?.chat.id ?? this.uid);
  }
  get cbMsg(): Msg {
    return this.cbq!.message;
  }

  async loadState() {
    const s = await db.getState(this.uid);
    this.state = s.state;
    this.data = s.data;
  }

  async setState(state: string | null, data?: Data) {
    this.state = state;
    if (data !== undefined) this.data = data;
    await db.saveState(this.uid, this.state, this.data);
  }

  async updateData(patch: Data) {
    this.data = { ...this.data, ...patch };
    await db.saveState(this.uid, this.state, this.data);
  }

  async setData(data: Data) {
    this.data = data;
    await db.saveState(this.uid, this.state, this.data);
  }

  async clearState() {
    if (this.state === null && !Object.keys(this.data).length) return;
    this.state = null;
    this.data = {};
    await db.saveState(this.uid, null, {});
  }

  /** Ответ на нажатие кнопки (всплывашка или «часики» гаснут). */
  async answer(text?: string, alert = false) {
    if (!this.cbq || this.answered) return;
    this.answered = true;
    await tg.answer(this.cbq.id, text, alert);
  }

  /** Обычный ответ в чат (у админов — без чистки экрана). */
  async reply(text: string, markup?: tg.Markup, replyTo?: number) {
    return await tg.sendText(this.chatId, text, markup, replyTo ? { reply_parameters: { message_id: replyTo } } : {});
  }
}
