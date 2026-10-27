// Оформление заказа в боте (пошаговая форма) и приём заказов с сайта.
import { T } from "./texts.ts";
import type { Config } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import * as db from "./db.ts";
import * as K from "./kb.ts";
import * as screen from "./screen.ts";
import { getWebappUrl, notifyNewOrder } from "./services.ts";
import { createSiteOrder, normalizePayload, parseSiteText } from "./siteOrders.ts";
import * as tg from "./tg.ts";
import { addDays, esc, fmt, makeIsoDate, plural, ruDate, todayIso } from "./util.ts";

// deno-lint-ignore no-explicit-any
type A = Record<string, any>;
type Btn = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
const WORK_TYPES = T.WORK_TYPES as Record<string, any>;
// deno-lint-ignore no-explicit-any
const VOLUME = T.VOLUME as Record<string, any>;
const TYPE_KEYS = Object.keys(WORK_TYPES);
const MAX_FILES = 20;

// Группы = «шаги» в прогрессе. Внутри группы может быть несколько вопросов.
const GROUPS = ["type", "subject", "topic", "uni", "volume", "deadline", "orig", "design", "extras", "files", "comment"];
const Q_GROUP: Record<string, string> = {
  type: "type", subject: "subject", topic: "topic", uni: "uni", course: "uni",
  volume: "volume", deadline: "deadline", date: "deadline", orig: "orig", orig_sys: "orig", ai: "orig",
  fmt_std: "design", fmt_font: "design", fmt_font_text: "design", fmt_size: "design",
  fmt_size_text: "design", fmt_spacing: "design", fmt_parts: "design",
  pr_style: "design", pr_palette: "design", pr_palette_text: "design", pr_format: "design",
  pr_anim: "design", pr_speech: "design",
  extras: "extras", files: "files", comment: "comment",
};
const TEXT_QUESTIONS = new Set(["subject", "topic", "uni", "volume", "date", "fmt_font_text", "fmt_size_text", "pr_palette_text", "comment"]);
// Простые вопросы «выбери один вариант из списка»: вопрос → (варианты, текст)
const SIMPLE_CHOICES: Record<string, [readonly string[], string]> = {
  orig_sys: [T.ORIG_SYSTEMS, T.Q_ORIG_SYS],
  fmt_std: [T.FMT_STANDARD, T.Q_FMT_STD],
  fmt_font: [T.FMT_FONTS, T.Q_FMT_FONT],
  fmt_size: [T.FMT_SIZES, T.Q_FMT_SIZE],
  fmt_spacing: [T.FMT_SPACING, T.Q_FMT_SPACING],
  pr_style: [T.PR_STYLES, T.Q_PR_STYLE],
  pr_palette: [T.PR_PALETTES, T.Q_PR_PALETTE],
  pr_format: [T.PR_FORMATS, T.Q_PR_FORMAT],
  pr_anim: [T.PR_ANIM, T.Q_PR_ANIM],
};
const MULTI: Record<string, [readonly string[], string]> = { fmt_parts: [T.FMT_PARTS, T.Q_FMT_PARTS], extras: [T.EXTRAS, T.Q_EXTRAS] };

// ======================= логика переходов =======================

const work = (a: A) => WORK_TYPES[a.type ?? ""] ?? { design: "text", volume: "pages", name: "" };
const activeGroups = (a: A) => GROUPS.filter((g) => g !== "design" || work(a).design);

function firstQuestion(group: string, a: A): string {
  if (group === "design") return work(a).design === "pres" ? "pr_style" : "fmt_std";
  return group;
}

function nextGroupQuestion(group: string, a: A): string {
  const groups = activeGroups(a);
  const i = groups.indexOf(group);
  return i + 1 < groups.length ? firstQuestion(groups[i + 1], a) : "confirm";
}

function nextQuestion(q: string, a: A): string {
  const simple: Record<string, string> = {
    type: "subject", subject: "topic", topic: "uni", course: "volume", volume: "deadline",
    date: "orig", fmt_std: "fmt_font", fmt_font_text: "fmt_size", fmt_size_text: "fmt_spacing",
    fmt_spacing: "fmt_parts", pr_style: "pr_palette", pr_palette_text: "pr_format",
    pr_format: "pr_anim", pr_anim: "pr_speech",
  };
  if (q === "uni") return a.uni ? "course" : "volume";
  if (q === "deadline") return a.deadline_choice === "date" ? "date" : "orig";
  if (q === "orig") return "ai"; // систему антиплагиата не спрашиваем — сразу процент ИИ
  if (q === "fmt_font") return a.fmt_font === "другой" ? "fmt_font_text" : "fmt_size";
  if (q === "fmt_size") return a.fmt_size === "другой" ? "fmt_size_text" : "fmt_spacing";
  if (q === "pr_palette") return a.pr_palette === "свой вариант" ? "pr_palette_text" : "pr_format";
  if (q in simple) return simple[q];
  return nextGroupQuestion(Q_GROUP[q], a);
}

/** Переход к следующему вопросу с учётом режима «Изменить». */
function advance(data: A, q: string) {
  const a = data.a;
  let nq = nextQuestion(q, a);
  const edit: string[] | null = data.edit;
  if (edit !== null && edit !== undefined) {
    if (q === "type") {
      // Сменили тип — объём и оформление нужно спросить заново
      edit.splice(0, edit.length, "volume", ...(work(a).design ? ["design"] : []));
    }
    if (nq === "confirm" || Q_GROUP[nq] !== Q_GROUP[q]) nq = edit.length ? firstQuestion(edit.shift()!, a) : "confirm";
  }
  data.hist.push(q);
  data.q = nq;
}

const today = (config: Config) => todayIso(config.tz);

// ======================= отрисовка вопросов =======================

const fbtn = (text: string, q: string, v: string | number): Btn => ({ text, callback_data: K.cb("f", q, v) });

function rows(buttons: Btn[], width: number): Btn[][] {
  const out: Btn[][] = [];
  for (let i = 0; i < buttons.length; i += width) out.push(buttons.slice(i, i + width));
  return out;
}

function navRows(data: A): Btn[][] {
  const row: Btn[] = [];
  const editing = data.edit !== null && data.edit !== undefined;
  if (data.hist.length || editing) row.push(fbtn(T.BTN_BACK, "_nav", "back"));
  // Далеко ушли по анкете — можно сразу вернуться к первому вопросу, а не листать «Назад»
  if (!editing && data.hist.length > 1) row.push(fbtn(T.BTN_FORM_START, "_nav", "start"));
  const cancel = fbtn(T.BTN_CANCEL, "_nav", "cancel");
  return row.length > 1 ? [row, [cancel]] : [[...row, cancel]];
}

/** «минимализм» → «Минимализм», но названия вроде «eTXT» не трогаем. */
function cap(label: string): string {
  if (label.length > 1 && label[0] !== label[0].toUpperCase() && label[1] === label[1].toLowerCase()) {
    return label[0].toUpperCase() + label.slice(1);
  }
  return label;
}

function choiceRows(q: string, options: readonly string[], width = 2, extra: [string, string][] = [], selected?: string[]): Btn[][] {
  const buttons = options.map((label, i) => {
    const mark = selected ? (selected.includes(label) ? "✅ " : "▫️ ") : "";
    return fbtn(mark + cap(label), q, i);
  });
  return [...rows(buttons, width), ...extra.map(([v, label]) => [fbtn(label, q, v)])];
}

function renderQuestion(data: A, config: Config): [string, { inline_keyboard: Btn[][] }] {
  const q: string = data.q, a: A = data.a;
  const groups = activeGroups(a);
  const step = groups.indexOf(Q_GROUP[q]) + 1;
  const head = fmt(T.FORM_TITLE, { step, total: groups.length }) + "\n\n";
  let text: string;
  let kb: Btn[][] = [];

  if (q === "type") {
    text = T.Q_TYPE;
    const soon = T.SOON_TYPES as readonly string[];
    kb = rows(TYPE_KEYS.map((key, i) => fbtn(`${WORK_TYPES[key].emoji} ${WORK_TYPES[key].name}${soon.includes(key) ? T.SOON_MARK : ""}`, q, i)), 2);
  } else if (q === "subject") {
    text = T.Q_SUBJECT;
  } else if (q === "topic") {
    text = T.Q_TOPIC;
    kb = [[fbtn(T.BTN_TOPIC_AUTO, q, "auto")]];
  } else if (q === "uni") {
    text = T.Q_UNI;
    kb = [[fbtn(T.BTN_SKIP, q, "skip")]];
  } else if (q === "course") {
    text = T.Q_COURSE;
    kb = choiceRows(q, T.COURSES.map(([, label]) => label), 4, [["skip", T.BTN_SKIP]]);
  } else if (q === "volume") {
    const vol = VOLUME[work(a).volume];
    text = vol.ask;
    kb = [...rows(vol.quick.map((n: number) => fbtn(String(n), q, n)), 4), [fbtn("Пока не знаю ➡️", q, "skip")]];
  } else if (q === "deadline") {
    text = T.Q_DEADLINE;
    const b = T.DEADLINE_QUICK.map(([v, label]) => fbtn(label, q, v));
    kb = [b.slice(0, 2), b.slice(2, 4), b.slice(4)];
  } else if (q === "date") {
    text = fmt(T.Q_DATE, { example: ruDate(addDays(today(config), 7)) });
  } else if (q === "orig") {
    text = T.Q_ORIG;
    kb = rows(T.ORIGINALITY.map(([v, label]) => fbtn(label, q, v)), 3);
  } else if (q === "ai") {
    text = T.Q_AI;
    kb = rows(T.AI_LEVELS.map(([v, label]) => fbtn(label, q, v)), 2);
  } else if (q in SIMPLE_CHOICES) {
    const [options, t] = SIMPLE_CHOICES[q];
    text = t;
    kb = choiceRows(q, options, q === "pr_style" || q === "pr_palette" ? 1 : 2);
  } else if (q === "pr_speech") {
    text = T.Q_PR_SPEECH;
    kb = [[fbtn("Да", q, "yes"), fbtn("Нет", q, "no")]];
  } else if (q in MULTI) {
    const [options, t] = MULTI[q];
    text = t;
    kb = choiceRows(q, options, 1, [["done", T.BTN_DONE]], a[q] ?? []);
  } else if (q === "files") {
    const n = (a.files ?? []).length;
    text = T.Q_FILES + (n ? `\n\nУже прикреплено: <b>${n}</b>` : "");
    kb = [[fbtn(n ? T.BTN_DONE : T.BTN_SKIP, q, "done")]];
  } else if (q === "comment") {
    text = T.Q_COMMENT;
    kb = [[fbtn(T.BTN_SKIP, q, "skip")]];
  } else if (q === "fmt_font_text" || q === "fmt_size_text" || q === "pr_palette_text") {
    text = { fmt_font_text: T.Q_FMT_FONT_TEXT, fmt_size_text: T.Q_FMT_SIZE_TEXT, pr_palette_text: T.Q_PR_PALETTE_TEXT }[q];
  } else {
    text = T.Q_TYPE; // на всякий случай
  }
  kb.push(...navRows(data));
  return [head + text, { inline_keyboard: kb }];
}

// ======================= сводка =======================

/** Строки заявки в том же формате, что и на сайте. */
export function buildLines(a: A): string[][] {
  const t = work(a);
  const lines: string[][] = [];
  const add = (icon: string, label: string, value: unknown) => {
    if (value) lines.push([icon, label, String(value)]);
  };
  add("📝", "Работа", t.name);
  add("📚", "Предмет", a.subject);
  add("🎯", "Тема", a.topic_auto ? "подберёт исполнитель" : a.topic);
  const course = a.course;
  const courseLabel = course ? ((T.COURSE_LABEL as Record<string, string>)[course] ?? `${course} курс`) : "";
  if (a.uni || courseLabel) add("🎓", a.uni ? "ВУЗ" : "Курс", [a.uni, courseLabel].filter(Boolean).join(", "));
  const vol = a.volume;
  if (vol) {
    if (t.volume === "free") add("📄", "Объём", vol);
    else add("📄", "Объём", `${vol} ${plural(Number(vol), VOLUME[t.volume].forms)}`);
  }
  const dl = a.deadline;
  if (dl === "flex") add("⏰", "Срок", "не горит");
  else if (dl) {
    const word = (T.DEADLINE_WORDS as Record<string, string>)[a.deadline_choice ?? ""];
    add("⏰", "Срок", ruDate(dl) + (word ? ` (${word})` : ""));
  }
  if (a.orig === "none") add("🔍", "Оригинальность", "проверка не нужна");
  else if (a.orig) add("🔍", "Оригинальность", `${a.orig}%`);
  if (a.ai === "any") add("🤖", "Процент ИИ", "не важно");
  else if (a.ai === "0") add("🤖", "Процент ИИ", "0% — без ИИ");
  else if (a.ai) add("🤖", "Процент ИИ", `не более ${a.ai}%`);

  if (t.design === "text") {
    const font = a.fmt_font === "другой" ? a.fmt_font_text : a.fmt_font;
    const size = a.fmt_size === "другой" ? a.fmt_size_text : a.fmt_size;
    const fontPart = font && size ? `${font} ${size}` : (font || (size ? `кегль ${size}` : ""));
    add("🖋", "Оформление", [a.fmt_std, fontPart, a.fmt_spacing ? `интервал ${a.fmt_spacing}` : ""].filter(Boolean).join(", "));
    add("📑", "Нужно", (a.fmt_parts ?? []).join(", "));
  }
  if (t.design === "pres") {
    const palette = a.pr_palette === "свой вариант" ? a.pr_palette_text : a.pr_palette;
    add("🎨", "Дизайн", [a.pr_style ? `стиль ${a.pr_style}` : "", palette ? `цвета «${palette}»` : ""].filter(Boolean).join(", "));
    add("💻", "Формат", [a.pr_format, a.pr_anim].filter(Boolean).join(", "));
    if (a.pr_speech) add("🎙", "Текст выступления", a.pr_speech === "yes" ? "нужен" : "не нужен");
  }
  add("➕", "Доп. услуги", (a.extras ?? []).join(", "));
  if (a.files?.length) add("📎", "Файлы", `${a.files.length} шт.`);
  add("💬", "Комментарий", a.comment);
  return lines;
}

function renderSummary(data: A): [string, { inline_keyboard: Btn[][] }] {
  const body = buildLines(data.a).map(([icon, label, value]) => `${icon} <b>${esc(label)}:</b> ${esc(value)}`).join("\n");
  return [`${T.SUMMARY_TITLE}\n\n${body}\n\n${T.SUMMARY_FOOTER}`, {
    inline_keyboard: [[fbtn(T.BTN_SEND, "_nav", "send")], [fbtn(T.BTN_EDIT, "_nav", "edit"), fbtn(T.BTN_CANCEL, "_nav", "cancel")]],
  }];
}

function renderEditMenu(data: A): [string, { inline_keyboard: Btn[][] }] {
  const labels = T.GROUP_LABELS as Record<string, string>;
  const kb = rows(activeGroups(data.a).map((g) => fbtn(labels[g], "_nav", `g-${g}`)), 2);
  kb.push([fbtn(T.BTN_TO_SUMMARY, "_nav", "summary")]);
  return [T.EDIT_WHAT, { inline_keyboard: kb }];
}

/** Показывает текущий вопрос: правит сообщение формы или присылает новое. */
async function show(ctx: Ctx, data: A, editMsg?: tg.Msg | null, view?: string) {
  const [text, kb] = view === "edit_menu" ? renderEditMenu(data) : data.q === "confirm" ? renderSummary(data) : renderQuestion(data, ctx.config);
  if (editMsg && editMsg.message_id === data.msg) {
    if (await tg.editText(ctx.chatId, editMsg.message_id, text, kb)) {
      await ctx.setData(data);
      return;
    }
  }
  // Новый шаг заменяет предыдущий: старый вопрос, ответы и подсказки удаляются
  const msg = await screen.newScreen(ctx.chatId, text, kb, null, { history: false }); // у анкеты свой «Назад»
  if (msg) data.msg = msg.message_id;
  await ctx.setData(data);
}

export async function startForm(ctx: Ctx) {
  await ctx.setState("form", { q: "type", a: {}, hist: [], edit: null, msg: null });
  await show(ctx, ctx.data);
}

// ======================= заказ с сайта =======================

export async function onWebAppData(ctx: Ctx) {
  const data = normalizePayload(ctx.msg!.web_app_data.data);
  if (!data) {
    await screen.newScreen(ctx.chatId, T.SITE_DATA_BAD);
    return;
  }
  await ctx.clearState();
  await createSiteOrder(ctx.config, ctx.uid, data);
}

export async function onPastedSiteOrder(ctx: Ctx) {
  await screen.track(ctx.chatId, ctx.msg!.message_id); // вставленный текст тоже уберём
  const data = parseSiteText(ctx.msg!.text);
  if (!data) {
    await screen.add(ctx.chatId, T.PASTE_BAD);
    return;
  }
  await ctx.clearState();
  await createSiteOrder(ctx.config, ctx.uid, data);
}

// ======================= ответы кнопками =======================

export async function onFormButton(ctx: Ctx, q: string, v: string) {
  const data = ctx.data;
  if (!data?.a || ctx.cbMsg?.message_id !== data.msg) {
    await ctx.answer(T.STALE_BUTTON);
    return;
  }
  const a = data.a;
  if (q === "_nav") {
    await ctx.answer();
    if (v === "cancel") {
      await ctx.clearState();
      await tg.editText(ctx.chatId, ctx.cbMsg.message_id, T.FORM_CANCELLED);
      return;
    }
    if (v === "back") {
      if (data.hist.length) data.q = data.hist.pop();
      else if (data.edit !== null && data.edit !== undefined) {
        data.edit = null;
        data.q = "confirm";
      }
      return await show(ctx, data, ctx.cbMsg);
    }
    if (v === "start") {
      // Ответы сохраняются — на каждом шаге можно оставить прежний или выбрать другой
      data.hist = [];
      data.q = "type";
      return await show(ctx, data, ctx.cbMsg);
    }
    if (v === "edit") return await show(ctx, data, ctx.cbMsg, "edit_menu");
    if (v === "summary") {
      data.q = "confirm";
      data.edit = null;
      return await show(ctx, data, ctx.cbMsg);
    }
    if (v.startsWith("g-")) {
      data.edit = [];
      data.hist = [];
      data.q = firstQuestion(v.slice(2), a);
      return await show(ctx, data, ctx.cbMsg);
    }
    if (v === "send") return await submit(ctx, data);
    return;
  }

  if (q !== data.q) {
    await ctx.answer(T.STALE_BUTTON);
    return;
  }
  const idx = /^\d+$/.test(v) ? Number(v) : -1;
  // ВКР пока не принимаем: кнопка видна с пометкой «скоро», нажатие только объясняет
  if (q === "type" && (T.SOON_TYPES as readonly string[]).includes(TYPE_KEYS[idx])) return void await ctx.answer(T.SOON_ALERT, true);
  await ctx.answer();
  const pick = (options: readonly string[]) => (idx >= 0 && idx < options.length ? options[idx] : null);

  if (q === "type") {
    const key = idx >= 0 && idx < TYPE_KEYS.length ? TYPE_KEYS[idx] : null;
    if (!key) return;
    if (a.type !== key) delete a.volume; // единицы объёма зависят от типа
    a.type = key;
  } else if (q === "topic" && v === "auto") {
    a.topic_auto = true;
    a.topic = null;
  } else if (q === "uni" && v === "skip") {
    a.uni = a.course = null;
  } else if (q === "course") {
    a.course = v === "skip" ? null : (idx >= 0 && idx < T.COURSES.length ? T.COURSES[idx][0] : null);
  } else if (q === "volume") {
    a.volume = v === "skip" ? null : (idx >= 0 ? idx : null);
  } else if (q === "deadline") {
    a.deadline_choice = v;
    if (v === "flex") a.deadline = "flex";
    else if (idx >= 0) a.deadline = addDays(today(ctx.config), idx);
  } else if (q === "orig") {
    a.orig = v;
    if (v === "none") a.orig_sys = null;
  } else if (q === "ai") {
    if (!T.AI_LEVELS.some(([key]) => key === v)) return;
    a.ai = v;
  } else if (q in SIMPLE_CHOICES) {
    const value = pick(SIMPLE_CHOICES[q][0]);
    if (value === null) return;
    a[q] = value;
  } else if (q === "pr_speech") {
    a[q] = v;
  } else if (q in MULTI) {
    if (v !== "done") {
      const value = pick(MULTI[q][0]);
      const chosen: string[] = a[q] ??= [];
      if (value && chosen.includes(value)) chosen.splice(chosen.indexOf(value), 1);
      else if (value) chosen.push(value);
      return await show(ctx, data, ctx.cbMsg);
    }
  } else if (q === "files" && v === "done") {
    // дальше
  } else if (q === "comment" && v === "skip") {
    a.comment = null;
  } else {
    await screen.add(ctx.chatId, T.CHOOSE_BUTTON);
    return;
  }
  advance(data, q);
  await show(ctx, data, ctx.cbMsg);
}

// ======================= ответы текстом =======================

const DATE_RE = /^\s*(\d{1,2})[.\-/ ](\d{1,2})(?:[.\-/ ](\d{2,4}))?\s*$/;

export function parseUserDate(text: string, config: Config): string | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = m[3];
  const now = today(config);
  const year = y ? +y + (y.length === 2 ? 2000 : 0) : +now.slice(0, 4);
  let result = makeIsoDate(year, mo, d);
  if (!result) return null;
  if (!y && result < now) result = makeIsoDate(year + 1, mo, d); // «25.01» в декабре — значит, следующий год
  return result;
}

export async function onFormText(ctx: Ctx) {
  const data = ctx.data;
  const q: string = data.q, a: A = data.a ?? {};
  const m = ctx.msg!;
  const text = String(m.text).trim();
  const example = ruDate(addDays(today(ctx.config), 7));

  if (q === "confirm") return void await screen.hint(m, T.CHOOSE_BUTTON);
  if (q === "files") return void await screen.hint(m, T.FILES_HINT);
  if (!TEXT_QUESTIONS.has(q)) return void await screen.hint(m, T.CHOOSE_BUTTON);

  const len = [...text].length;
  let error: string | null = null;
  if (q === "subject") {
    error = len >= 2 && len <= 120 ? null : T.BAD_SUBJECT;
    a.subject = text;
  } else if (q === "topic") {
    error = len >= 3 && len <= 300 ? null : T.BAD_TOPIC;
    a.topic = text;
    a.topic_auto = false;
  } else if (q === "uni") {
    error = len >= 2 && len <= 120 ? null : T.BAD_UNI;
    a.uni = text;
  } else if (q === "volume") {
    if (work(a).volume === "free") {
      error = len <= 120 ? null : T.BAD_FREE_VOLUME;
      a.volume = text;
    } else {
      const digits = text.replace(/\D/g, "");
      if (digits && digits.length <= 3 && +digits >= 1 && +digits <= 999) a.volume = +digits;
      else error = T.BAD_NUMBER;
    }
  } else if (q === "date") {
    const d = parseUserDate(text, ctx.config);
    if (d === null) error = fmt(T.BAD_DATE, { example });
    else if (d < today(ctx.config)) error = T.PAST_DATE;
    else a.deadline = d;
  } else if (q === "fmt_size_text") {
    error = /^\d+$/.test(text) && +text >= 8 && +text <= 28 ? null : T.BAD_SIZE;
    a.fmt_size_text = text;
  } else if (q === "fmt_font_text" || q === "pr_palette_text") {
    error = len >= 2 && len <= 80 ? null : T.BAD_SHORT;
    a[q] = text;
  } else if (q === "comment") {
    error = len <= 1500 ? null : T.BAD_COMMENT;
    a.comment = text;
  }
  if (error) {
    await screen.hint(m, error);
    return;
  }
  await screen.track(ctx.chatId, m.message_id); // ответ клиента уйдёт вместе с вопросом
  advance(data, q);
  await show(ctx, data);
}

export async function onFormFile(ctx: Ctx) {
  const data = ctx.data;
  const m = ctx.msg!;
  if (data.q !== "files") return void await screen.hint(m, T.CHOOSE_BUTTON);
  const files: A[] = data.a.files ??= [];
  if (files.length >= MAX_FILES) {
    await screen.add(ctx.chatId, fmt(T.FILES_LIMIT, { n: MAX_FILES }));
    return;
  }
  const f = tg.extractFile(m)!;
  files.push({ file_id: f.file_id, type: f.type, name: f.name });
  // Короткое подтверждение; предыдущее убираем, чтобы не засорять чат
  if (data.ack) await tg.deleteMessage(ctx.chatId, data.ack);
  const kb = { inline_keyboard: [[fbtn(T.BTN_DONE, "files", "done")]] };
  const ack = await screen.add(ctx.chatId, fmt(T.FILES_RECEIVED, { n: files.length }), kb);
  if (ack) {
    // Кнопка «Готово» теперь живёт в подтверждении — делаем его сообщением формы
    const old = data.msg;
    if (old && old !== ack.message_id && old !== data.ack) await tg.editMarkup(ctx.chatId, old, null);
    data.msg = data.ack = ack.message_id;
  }
  await ctx.setData(data);
}

// ======================= отправка =======================

async function submit(ctx: Ctx, data: A) {
  const a = data.a;
  if (!a.type) {
    data.q = "type";
    return await show(ctx, data, ctx.cbMsg);
  }
  const answers: A = {};
  for (const [k, v] of Object.entries(a)) if (k !== "files") answers[k] = v;
  const orderData = { type: a.type, type_name: work(a).name, lines: buildLines(a), deadline: a.deadline ?? null, answers };
  await ctx.clearState(); // сначала закрываем форму — повторное «Отправить» уже ничего не создаст
  const order = await db.createOrder(ctx.uid, orderData, "bot");
  for (const f of a.files ?? []) await db.addFile(order.id, "client", f);
  // Анкета и сводка убираются — заказ целиком лежит в «📦 Мои заказы»
  // Клавиатура меню и так всегда в чате — под подтверждением кнопка самого заказа
  await screen.newScreen(ctx.chatId, fmt(T.ORDER_ACCEPTED, { code: order.code }), K.backToOrderKb(order.id), null, { history: false });
  await notifyNewOrder(ctx.config, order);
}

