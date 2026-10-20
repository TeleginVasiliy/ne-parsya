/* ==========================================================================
   «Не Парься» — логика страницы
   Разделы:
   1. Утилиты и данные           6. Конструктор заказа
   2. Тема оформления            7. Сводка и текст заявки
   3. Шапка, меню, звук          8. Отправка в Telegram
   4. Рендер блоков из config    9. Лайтбокс, отзывы, FAQ
   5. Счётчики и появление       10. Запуск
                                 11. Живые данные (Supabase)
   ========================================================================== */

(function () {
  'use strict';

  /* ======================= 1. УТИЛИТЫ И ДАННЫЕ ======================= */

  var CFG = window.SITE_CONFIG || {};
  var TG_USER = String(CFG.telegramUsername || '').replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
  var DEFAULT_MSG = CFG.defaultMessage || 'Здравствуйте! Хочу заказать работу';
  var MAX_URL = CFG.maxUrlLength || 3800;
  var DRAFT_KEY = 'np-draft-v1';
  var THEME_KEY = 'np-theme';
  var VISIT_KEY = 'np-visited-v1';
  var REVIEW_KEY = 'np-review-at';

  // База Supabase: если url и ключ заполнены — счётчики и отзывы «живые»
  var sbUrl = function (u) {
    // Принимает любой вид адреса проекта (из панели, адрес функции, без https) → https://<код>.supabase.co
    u = String(u || '').trim().replace(/^['"\s]+|['"\s]+$/g, '');
    var m = u.match(/([a-z0-9]{20})\.supabase\.(co|in)/i) || u.match(/project\/([a-z0-9]{20})/i);
    return m ? 'https://' + m[1].toLowerCase() + '.supabase.co' : u.replace(/\/+$/, '');
  };
  var SB = {
    url: sbUrl(CFG.supabase && CFG.supabase.url),
    key: String((CFG.supabase && CFG.supabase.key) || '').replace(/[\s'"]/g, '')
  };
  var LIVE = !!(SB.url && SB.key);

  // Telegram-бот и Mini App. Если botUsername задан — заказы уходят в бота.
  // Имя бота: из config.js, а если там пусто — из ссылки, которой бот открыл сайт (?bot=имя)
  var BOT = String(CFG.botUsername || new URLSearchParams(location.search).get('bot') || '')
    .replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').trim();
  if (!/^[A-Za-z0-9_]{5,32}$/.test(BOT)) BOT = '';
  var TGW = (window.Telegram && window.Telegram.WebApp) || null;
  var IN_TG = !!(TGW && TGW.platform && TGW.platform !== 'unknown');
  // Как открыт сайт: keyboard — reply-кнопкой «🌐 Сайт» в боте (работает sendData),
  // link — кнопкой меню, кнопкой под сообщением или из профиля бота, browser — вне Telegram.
  // Бот добавляет к ссылке ?from=kb|menu|inline; без from=kb sendData не используем.
  var LAUNCH = !IN_TG ? 'browser' : (new URLSearchParams(location.search).get('from') === 'kb' ? 'keyboard' : 'link');

  function botLink(start) {
    return 'https://t.me/' + BOT + (start ? '?start=' + encodeURIComponent(start) : '');
  }

  // Код передачи заявки через Supabase: 12 символов [A-Za-z0-9]
  function makeHandoffCode() {
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    var rnd = new Uint8Array(12);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(rnd);
    else for (var i = 0; i < 12; i++) rnd[i] = Math.floor(Math.random() * 256);
    var out = '';
    for (var j = 0; j < 12; j++) out += abc[rnd[j] % abc.length];
    return out;
  }

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function play(name) { if (window.Sound) window.Sound.play(name); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Склонение: plural(5, ['задача', 'задачи', 'задач'])
  function plural(n, forms) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  // Ссылка на чат с подставленным текстом. encodeURIComponent корректно
  // кодирует кириллицу и эмодзи (в т.ч. суррогатные пары) в UTF-8.
  function tgLink(text) {
    var base = 'https://t.me/' + TG_USER;
    return text ? base + '?text=' + encodeURIComponent(text) : base;
  }

  // Локальная дата в формате YYYY-MM-DD (без сдвига часового пояса)
  function isoDate(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); }
  function ruDate(iso) { var p = iso.split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso; }

  // Номер заявки вида #A7K2 (без похожих символов 0/O, 1/I)
  function makeOrderId() {
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    var rnd = new Uint8Array(4);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(rnd);
    else for (var i = 0; i < 4; i++) rnd[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < 4; j++) out += abc[rnd[j] % abc.length];
    return out;
  }

  // Иконки (линейные, 24×24)
  var ICONS = {
    control: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
    rgr: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10.5h.01M12 10.5h.01M16 10.5h.01M8 14.5h.01M12 14.5h.01M16 14.5h.01M8 18.5h.01M12 18.5h.01M16 18.5h.01"/>',
    referat: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    essay: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    coursework: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    diploma: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/><path d="M22 10v6"/>',
    practice: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2 13h20"/>',
    presentation: '<path d="M2 3h20M4 3v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3M12 16v5M8 21h8"/><path d="m8 11 3-3 2 2 3-3"/>',
    drawings: '<path d="M3 21h18"/><path d="M5 21 12 4l7 17"/><path d="M8.5 13.5h7"/><circle cx="12" cy="4" r="1.5"/>',
    tasks: '<path d="M18 7V4H6l6 8-6 8h12v-3"/>',
    other: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'
  };
  function svg(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>'; }

  /* Типы работ.
     volume — чем измеряется объём; design — какой блок показывать на шаге 3:
     text — оформление текста, pres — дизайн презентации, draw — чертежи,
     optional — оформление по желанию (переключатель), none — без настроек */
  var WORK_TYPES = [
    { id: 'control', name: 'Контрольная работа', short: 'Контрольная', desc: 'Решение вариантов и заданий с понятными пояснениями.', volume: 'tasks', design: 'optional', tone: 'lav' },
    { id: 'rgr', name: 'РГР', short: 'РГР', desc: 'Расчётно-графическая: расчёты, графики, пояснительная записка.', volume: 'pages', design: 'text', tone: 'mint' },
    { id: 'referat', name: 'Реферат', short: 'Реферат', desc: 'Обзор источников по теме с грамотной структурой.', volume: 'pages', design: 'text', tone: 'peach' },
    { id: 'essay', name: 'Эссе', short: 'Эссе', desc: 'Авторский текст с аргументацией — на русском или английском.', volume: 'pages', design: 'text', tone: 'blue' },
    { id: 'coursework', name: 'Курсовая работа', short: 'Курсовая', desc: 'Теория, практическая часть, расчёты и литература.', volume: 'pages', design: 'text', tone: 'lav' },
    { id: 'diploma', name: 'ВКР / диплом', short: 'ВКР / диплом', desc: 'Выпускная работа под ключ: от плана до речи на защиту.', volume: 'pages', design: 'text', tone: 'mint' },
    { id: 'practice', name: 'Отчёт по практике', short: 'Отчёт по практике', desc: 'Отчёт, дневник и характеристика по программе практики.', volume: 'pages', design: 'text', tone: 'peach' },
    { id: 'presentation', name: 'Презентация', short: 'Презентация', desc: 'Слайды в нужном стиле, инфографика и текст выступления.', volume: 'slides', design: 'pres', tone: 'blue' },
    { id: 'drawings', name: 'Чертежи', short: 'Чертежи', desc: 'Чертежи и схемы по ЕСКД — в программе или от руки.', volume: 'sheets', design: 'draw', tone: 'lav' },
    { id: 'tasks', name: 'Решение задач', short: 'Решение задач', desc: 'Математика, физика, экономика и другие дисциплины.', volume: 'tasks', design: 'optional', tone: 'mint' },
    { id: 'other', name: 'Другое', short: 'Другое', desc: 'Не нашли своё? Опишите задачу — разберёмся.', volume: 'free', design: 'none', tone: 'peach' }
  ];
  function typeById(id) { for (var i = 0; i < WORK_TYPES.length; i++) if (WORK_TYPES[i].id === id) return WORK_TYPES[i]; return null; }

  // Как измеряется объём
  var VOLUME = {
    pages: { label: 'Объём, страниц', forms: ['стр.', 'стр.', 'стр.'], hint: 'Примерно, без титульного листа и приложений.', start: 10, step: 5 },
    slides: { label: 'Количество слайдов', forms: ['слайд', 'слайда', 'слайдов'], hint: 'Обычно 10–15 слайдов на доклад 7–10 минут.', start: 10, step: 1 },
    tasks: { label: 'Количество задач', forms: ['задача', 'задачи', 'задач'], hint: 'Сколько заданий в варианте — примерно.', start: 1, step: 1 },
    sheets: { label: 'Количество листов', forms: ['лист', 'листа', 'листов'], hint: 'Сколько чертежей или листов формата.', start: 1, step: 1 },
    free: { label: 'Объём', forms: ['', '', ''], hint: 'Опишите своими словами: например, «2 лабораторные по 5 стр.».' }
  };

  // Палитры презентации: [основной, второй, акцент, фон]
  var PALETTES = [
    { id: 'Классика', colors: ['#1f3a68', '#9aa7bd', '#c9a54a', '#ffffff'] },
    { id: 'Пастель', colors: ['#7d6bc4', '#f4c1ae', '#8fd3bc', '#fbf8ff'] },
    { id: 'Природа', colors: ['#2f6b4f', '#a7c9a0', '#e0b65a', '#f5f8f0'] },
    { id: 'Закат', colors: ['#c94a35', '#f3a26b', '#7a3e8e', '#fff6ef'] },
    { id: 'Монохром', colors: ['#1f1f1f', '#8a8a8a', '#c8c8c8', '#ffffff'] },
    { id: 'custom', name: 'Свой вариант', colors: null }
  ];

  // Шрифты презентации (подгружаются из Google Fonts только при открытии блока)
  var PRES_FONTS = [
    { id: 'Montserrat', css: "'Montserrat', sans-serif" },
    { id: 'Playfair Display', css: "'Playfair Display', serif" },
    { id: 'PT Serif', css: "'PT Serif', serif" },
    { id: 'Comfortaa', css: "'Comfortaa', sans-serif" },
    { id: 'Oswald', css: "'Oswald', sans-serif" },
    { id: 'на усмотрение исполнителя', name: 'На усмотрение', css: "'Manrope', sans-serif" }
  ];
  var PRES_FONTS_URL = 'https://fonts.googleapis.com/css2?family=Comfortaa:wght@700&family=Montserrat:wght@700&family=Oswald:wght@600&family=PT+Serif:wght@700&family=Playfair+Display:wght@700&display=swap';

  var COURSE_LABEL = { mag: 'магистратура', college: 'колледж' };
  var QUICK_LABEL = { '1': 'завтра', '3': 'через 3 дня', '7': 'через неделю', flex: 'не горит' };

  /* ======================= 2. ТЕМА ОФОРМЛЕНИЯ ======================= */

  var root = document.documentElement;

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function setTheme(theme, animate) {
    if (animate && !reduceMotion) {
      root.classList.add('theme-anim');
      clearTimeout(setTheme._t);
      setTheme._t = setTimeout(function () { root.classList.remove('theme-anim'); }, 650);
    }
    root.setAttribute('data-theme', theme);
    $('#themeToggle').setAttribute('aria-label', theme === 'dark' ? 'Включить дневную тему' : 'Включить ночную тему');
  }

  function initTheme() {
    setTheme(root.getAttribute('data-theme') || 'light', false);
    $('#themeToggle').addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      setTheme(next, true);
      play(next === 'dark' ? 'themeDark' : 'themeLight');
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* без сохранения */ }
    });
    // Если пользователь сам не выбирал тему — следуем за системной
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystem = function (e) { if (!storedTheme()) setTheme(e.matches ? 'dark' : 'light', true); };
    if (mq.addEventListener) mq.addEventListener('change', onSystem);
  }

  // Сайт открыт как Mini App внутри Telegram
  function initTelegram() {
    if (!IN_TG) return;
    try {
      TGW.ready();
      TGW.expand();
      if (!storedTheme() && (TGW.colorScheme === 'dark' || TGW.colorScheme === 'light')) setTheme(TGW.colorScheme, false);
    } catch (e) { /* старые клиенты Telegram */ }
    document.documentElement.classList.add('in-telegram');
  }

  /* ======================= 3. ШАПКА, МЕНЮ, ЗВУК ======================= */

  function initHeader() {
    var header = $('#header');
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Мобильное меню
    var burger = $('#burger'), nav = $('#nav');
    function setMenu(open) {
      nav.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    }
    burger.addEventListener('click', function () { setMenu(!nav.classList.contains('is-open')); });
    $$('a', nav).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    document.addEventListener('click', function (e) {
      if (nav.classList.contains('is-open') && !nav.contains(e.target) && !burger.contains(e.target)) setMenu(false);
    });

    // Поповер звука
    var btn = $('#soundBtn'), pop = $('#soundPop'), toggle = $('#soundToggle'), vol = $('#soundVolume');
    function refresh() {
      var on = window.Sound.isEnabled();
      btn.classList.toggle('is-muted', !on);
      toggle.checked = on;
      vol.value = Math.round(window.Sound.getVolume() * 100);
      vol.disabled = !on;
      vol.style.setProperty('--val', vol.value + '%');
    }
    function setPop(open) {
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
    }
    btn.addEventListener('click', function () { setPop(pop.hidden); });
    document.addEventListener('click', function (e) {
      if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) setPop(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { setPop(false); setMenu(false); } });
    toggle.addEventListener('change', function () {
      if (toggle.checked) { window.Sound.setEnabled(true); play('toggleOn'); }
      else { play('toggleOff'); setTimeout(function () { window.Sound.setEnabled(false); }, 160); }
      setTimeout(refresh, 170);
    });
    vol.addEventListener('input', function () {
      window.Sound.setVolume(vol.value / 100);
      vol.style.setProperty('--val', vol.value + '%');
      play('tick');
    });
    vol.addEventListener('change', function () { play('pop'); });
    refresh();
  }

  // Звуки для всех кнопок, ссылок и полей выбора (делегирование событий)
  function initUiSounds() {
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-sound], button, a');
      if (!el || el.closest('label')) return; // клики по label озвучивает событие change
      var s = el.getAttribute('data-sound');
      if (s === 'none') return;
      play(s || (el.tagName === 'A' ? 'click' : 'tap'));
    }, true);

    document.addEventListener('change', function (e) {
      var el = e.target;
      if (!el.matches || el.getAttribute('data-sound') === 'none') return;
      if (el.type === 'radio') play('pop');
      else if (el.type === 'checkbox') {
        if (el.closest('.switch')) play(el.checked ? 'toggleOn' : 'toggleOff');
        else play(el.checked ? 'pop' : 'click');
      }
    }, true);
  }

  /* ======================= 4. РЕНДЕР БЛОКОВ ИЗ CONFIG ======================= */

  // Счётчики показываются, только когда подключена база (цифры — живые)
  function renderStats() {
    var grid = $('#statsGrid');
    var stats = (CFG.stats || []).filter(function (s) { return s && s.source; });
    if (!LIVE || !stats.length) { grid.closest('section').hidden = true; return; }
    grid.style.gridTemplateColumns = 'repeat(' + stats.length + ', 1fr)';
    grid.innerHTML = stats.map(function (s) {
      return '<div class="stat reveal"><div class="stat__num is-loading" data-stat="' + esc(s.source) + '" data-suffix="' + esc(s.suffix || '') + '">…</div>' +
        '<div class="stat__label">' + esc(s.label || '') + '</div>' +
        (s.hint ? '<div class="stat__hint">' + esc(s.hint) + '</div>' : '') + '</div>';
    }).join('');
  }

  function renderServices() {
    $('#servicesGrid').innerHTML = WORK_TYPES.map(function (t) {
      return '<button type="button" class="service reveal" data-type="' + t.id + '" data-sound="pop" aria-label="' + esc(t.name) + ' — выбрать в конструкторе">' +
        '<span class="service__icon tone-' + t.tone + '">' + svg(t.id) + '</span>' +
        '<span class="service__title">' + esc(t.name) + '</span>' +
        '<span class="service__desc">' + esc(t.desc) + '</span>' +
        '<span class="service__price">Стоимость — индивидуально</span>' +
        '<span class="service__go">' + svg('arrow') + '</span>' +
        '</button>';
    }).join('');
  }

  function renderTypeGrid() {
    $('#typeGrid').innerHTML = WORK_TYPES.map(function (t) {
      return '<label class="type-card"><input type="radio" name="type" value="' + t.id + '">' +
        '<span class="type-card__inner"><span class="type-card__icon tone-' + t.tone + '">' + svg(t.id) + '</span>' +
        '<span class="type-card__name">' + esc(t.name) + '</span></span></label>';
    }).join('');
  }

  function renderPalettes() {
    $('#paletteGrid').innerHTML = PALETTES.map(function (p) {
      var dots = p.colors
        ? '<span class="palette__dots">' + p.colors.slice(0, 3).map(function (c) { return '<span style="background:' + c + '"></span>'; }).join('') + '</span>'
        : '<span class="palette__dots palette__dots--custom"><span></span></span>';
      return '<label class="palette"><input type="radio" name="pr_palette" value="' + esc(p.id) + '">' +
        '<span class="palette__inner">' + dots + '<span class="palette__name">' + esc(p.name || p.id) + '</span></span></label>';
    }).join('');
  }

  function renderPresFonts() {
    $('#pfontGrid').innerHTML = PRES_FONTS.map(function (f) {
      return '<label class="pfont"><input type="radio" name="pr_font" value="' + esc(f.id) + '">' +
        '<span class="pfont__inner"><span class="pfont__sample" style="font-family:' + esc(f.css) + '">Заголовок</span>' +
        '<span class="pfont__name">' + esc(f.name || f.id) + '</span></span></label>';
    }).join('');
  }

  var presFontsLoaded = false;
  function loadPresFonts() {
    if (presFontsLoaded) return;
    presFontsLoaded = true;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = PRES_FONTS_URL;
    document.head.appendChild(link);
  }

  var works = [];
  function renderWorks() {
    works = (CFG.portfolio || []).filter(Boolean);
    var section = $('#works');
    if (!works.length) { section.hidden = true; hideNav('works'); return; }
    $('#worksGrid').innerHTML = works.map(function (w, i) {
      return '<button type="button" class="work reveal" data-work="' + i + '" data-sound="pop" aria-label="Открыть пример: ' + esc(w.type || '') + '">' +
        '<span class="work__media">' + (w.placeholder ? '<span class="badge-example">Пример — замените своими</span>' : '') + workMedia(w) + '</span>' +
        '<span class="work__body"><span class="tag">' + esc(w.type || 'Работа') + '</span>' +
        '<span class="work__subject">' + esc(w.subject || '') + '</span>' +
        '<span class="work__desc">' + esc(w.description || '') + '</span></span></button>';
    }).join('');
  }
  function workMedia(w) {
    if (w.image) return '<img src="' + esc(w.image) + '" alt="' + esc((w.type || '') + ' — ' + (w.subject || '')) + '" loading="lazy">';
    return '<span class="placeholder">' + svg('image') + '<span>Здесь будет превью</span></span>';
  }

  var RATING_WORDS = ['', 'Плохо', 'Так себе', 'Нормально', 'Хорошо', 'Отлично'];

  // state: loading — грузим, error — не загрузилось, ready — данные есть
  function renderReviews(list, state) {
    var track = $('#reviewsTrack');
    list = list || [];
    if (state === 'loading') {
      track.innerHTML = '<div class="review review--empty card"><p>Загружаем отзывы…</p></div>';
    } else if (!list.length) {
      var text = state === 'error'
        ? '<b>Не получилось загрузить отзывы</b><p>Попробуйте обновить страницу чуть позже.</p>'
        : LIVE
          ? '<b>Пока нет отзывов</b><p>Заказывали у меня работу? Поделитесь впечатлением — ваш отзыв будет первым.</p>'
          : '<b>Отзывы скоро появятся</b>';
      track.innerHTML = '<div class="review review--empty card">' + text + '</div>';
    } else {
      track.innerHTML = list.map(function (r, i) {
        var rating = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 5)));
        var stars = '';
        for (var k = 1; k <= 5; k++) stars += '<span' + (k > rating ? ' class="off"' : '') + '>★</span>';
        var initial = String(r.name || '?').trim().charAt(0).toUpperCase();
        var meta = [r.university, r.work].filter(Boolean).map(esc).join(' · ');
        var date = '';
        if (r.created_at) {
          var d = new Date(r.created_at);
          if (!isNaN(d)) date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        }
        return '<article class="review card" aria-roledescription="отзыв" aria-label="Отзыв ' + (i + 1) + ' из ' + list.length + '">' +
          '<div class="review__head"><div class="review__stars" aria-label="Оценка ' + rating + ' из 5">' + stars + '</div>' +
          (date ? '<span class="review__date">' + esc(date) + '</span>' : '') + '</div>' +
          '<p class="review__text">' + esc(r.message || '') + '</p>' +
          '<div class="review__who"><span class="review__avatar" aria-hidden="true">' + esc(initial) + '</span>' +
          '<div><div class="review__name">' + esc(r.name || '') + '</div><div class="review__meta">' + meta + '</div></div></div></article>';
      }).join('');
    }
    $('#reviewsDots').innerHTML = list.length > 1 ? list.map(function (_, i) {
      return '<button type="button" data-dot="' + i + '" data-sound="click" aria-label="Отзыв ' + (i + 1) + '"></button>';
    }).join('') : '';
    track.scrollLeft = 0;
    updateCarousel();
  }

  function renderFaq() {
    var list = CFG.faq || [];
    if (!list.length) { $('#faq').hidden = true; return; }
    $('#faqList').innerHTML = list.map(function (f, i) {
      var body = String(f.a || '').split(/\n\s*\n/).map(function (p) { return '<p>' + esc(p.trim()) + '</p>'; }).join('');
      return '<div class="faq__item reveal">' +
        '<button type="button" class="faq__q" id="faq-q' + i + '" aria-expanded="false" aria-controls="faq-a' + i + '" data-sound="click">' +
        '<span>' + esc(f.q) + '</span><span class="faq__icon" aria-hidden="true"></span></button>' +
        '<div class="faq__a" id="faq-a' + i + '" role="region" aria-labelledby="faq-q' + i + '"><div>' + body + '</div></div></div>';
    }).join('');
  }

  function hideNav(id) { $$('[data-nav="' + id + '"]').forEach(function (a) { a.hidden = true; }); }

  function initStaticLinks() {
    $$('[data-tg-link]').forEach(function (a) {
      a.href = BOT ? botLink('site') : tgLink(DEFAULT_MSG);
      a.target = '_blank';
      a.rel = 'noopener';
      // Внутри Telegram мы уже в боте — кнопка просто возвращает в чат
      if (IN_TG) a.addEventListener('click', function (e) { e.preventDefault(); TGW.close(); });
    });
    $$('[data-tg-handle]').forEach(function (el) { el.textContent = '@' + (BOT || TG_USER); });
    // Ссылка в кабинет передаёт имя бота дальше (кабинет откроется и без него — по сохранённому ключу)
    $$('[data-cabinet]').forEach(function (a) {
      if (!LIVE) { a.hidden = true; return; }
      if (BOT) a.href = 'cabinet.html?bot=' + BOT;
    });
    $('#year').textContent = new Date().getFullYear();
  }

  /* ======================= 5. СЧЁТЧИКИ И ПОЯВЛЕНИЕ ======================= */

  function animateCount(el) {
    var target = Number(el.getAttribute('data-count')) || 0;
    var suffix = el.getAttribute('data-suffix') || '';
    var fmt = function (n) { return n.toLocaleString('ru-RU') + suffix; };
    if (reduceMotion || target === 0) { el.textContent = fmt(target); return; }
    var dur = 1700, t0 = performance.now();
    (function frame(now) {
      var p = Math.min(1, (now - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3); // easeOutCubic — быстро в начале, мягко в конце
      el.textContent = fmt(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(frame);
    })(t0);
  }

  // Число появляется, когда пришли данные из базы и блок виден на экране.
  // Повторные обновления (после нового отзыва) — без анимации.
  function tryAnimateStat(el) {
    if (!el.hasAttribute('data-count') || !el.hasAttribute('data-seen')) return;
    if (el.hasAttribute('data-shown')) {
      el.textContent = Number(el.getAttribute('data-count')).toLocaleString('ru-RU') + (el.getAttribute('data-suffix') || '');
      return;
    }
    el.setAttribute('data-shown', '1');
    animateCount(el);
  }

  function setStats(data) {
    if (!data) return;
    $$('[data-stat]').forEach(function (el) {
      var v = Number(data[el.getAttribute('data-stat')]);
      if (!isFinite(v)) return;
      el.setAttribute('data-count', String(v));
      el.classList.remove('is-loading');
      tryAnimateStat(el);
    });
  }

  var revealObserver = null;
  function initReveal() {
    var items = $$('.reveal');
    // Небольшая «лесенка» задержек для соседних карточек
    items.forEach(function (el) {
      var siblings = Array.prototype.filter.call(el.parentNode.children, function (c) { return c.classList.contains('reveal'); });
      var idx = siblings.indexOf(el);
      if (idx > 0) el.style.setProperty('--d', Math.min(idx % 6, 5) * 0.06 + 's');
    });
    if (!('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('in'); });
      $$('[data-stat]').forEach(function (el) { el.setAttribute('data-seen', '1'); tryAnimateStat(el); });
      return;
    }
    revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add('in');
        revealObserver.unobserve(en.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { revealObserver.observe(el); });

    var countObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.setAttribute('data-seen', '1');
        tryAnimateStat(en.target);
        countObserver.unobserve(en.target);
      });
    }, { threshold: 0.5 });
    $$('[data-stat]').forEach(function (el) { countObserver.observe(el); });
  }

  /* ======================= 6. КОНСТРУКТОР ЗАКАЗА ======================= */

  var form, steps, stepBtns;
  var current = 0;
  var orderId = '';
  var lastQuick = '';

  // Считываем все поля формы в простой объект
  function readForm() {
    var d = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') {
        if (!d[el.name]) d[el.name] = [];
        if (el.checked) d[el.name].push(el.value);
      } else if (el.type === 'radio') {
        if (el.checked) d[el.name] = el.value;
        else if (!(el.name in d)) d[el.name] = '';
      } else {
        d[el.name] = el.value;
      }
    });
    return d;
  }

  function writeForm(d) {
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !(el.name in d)) return;
      var v = d[el.name];
      if (el.type === 'checkbox') el.checked = Array.isArray(v) && v.indexOf(el.value) !== -1;
      else if (el.type === 'radio') el.checked = v === el.value;
      else el.value = v == null ? '' : v;
    });
  }

  function val(d, name) { return String(d[name] || '').trim(); }
  function has(d, name, v) { return Array.isArray(d[name]) && d[name].indexOf(v) !== -1; }

  // Какой блок оформления показывать на шаге 3
  function designMode(t, d) {
    if (!t) return 'none';
    if (t.design === 'optional') return has(d, 'need_format', '1') ? 'text' : 'off';
    return t.design;
  }

  // --- Черновик в localStorage ---
  var saveTimer = null;
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ v: 1, fields: readForm(), step: current, orderId: orderId })); } catch (e) { /* без черновика */ }
    }, 250);
  }
  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ничего */ } }

  // --- Синхронизация зависимых полей ---
  function syncUI() {
    var d = readForm();
    var t = typeById(d.type);

    // Тип выбран — убираем ошибку
    if (t) { $('#typeError').hidden = true; $('#typeField').classList.remove('is-invalid'); }

    // Тема: «подберёт исполнитель» блокирует поле
    $('#topic').disabled = has(d, 'topic_auto', '1');

    // Объём зависит от типа
    var vk = t ? t.volume : 'pages';
    var vc = VOLUME[vk];
    $('#volumeLabel').textContent = vc.label;
    $('#volumeHint').textContent = vc.hint;
    $('#volumeNum').hidden = vk === 'free';
    $('#volumeFree').hidden = vk !== 'free';
    $('#volumeLabel').setAttribute('for', vk === 'free' ? 'volumeFree' : 'volume');
    var n = parseInt(d.volume, 10);
    $('#volumeUnit').textContent = vk === 'free' ? '' : (vk === 'pages' ? 'стр.' : plural(isNaN(n) ? 5 : n, vc.forms));

    // Оригинальность
    var origOff = d.orig_system === 'none';
    var range = $('#originality');
    range.disabled = origOff;
    $('#originalityWrap').classList.toggle('is-disabled', origOff);
    range.style.setProperty('--val', ((range.value - range.min) / (range.max - range.min) * 100) + '%');
    var out = $('#originalityOut');
    var touched = !!d.orig_touched;
    out.textContent = origOff ? 'не нужна' : (touched ? range.value + '%' : 'не выбрано');
    out.classList.toggle('is-set', touched && !origOff);

    // Методичка
    $('#manualHint').hidden = d.manual !== 'yes';

    // Шаг 3: какой блок показать
    var mode = designMode(t, d);
    $('#fmtOptional').hidden = !(t && t.design === 'optional');
    $('#fmtBlock').hidden = mode !== 'text';
    $('#presBlock').hidden = mode !== 'pres';
    $('#drawBlock').hidden = mode !== 'draw';
    $('#noDesign').hidden = !(mode === 'none');
    var titles = { text: ['Оформление', 'Оформление текста'], pres: ['Дизайн', 'Дизайн презентации'], draw: ['Чертежи', 'Параметры чертежей'] };
    var tt = titles[t ? t.design : ''] || ['Оформление', 'Оформление'];
    $('#step3Label').textContent = tt[0];
    $('#step3Title').textContent = tt[1];
    if (mode === 'pres') loadPresFonts();

    // Оформление текста: «другой» шрифт/кегль/язык, превью шрифта
    $('#fmtFontOther').hidden = d.fmt_font !== 'other';
    $('#fmtSizeOther').hidden = d.fmt_size !== 'other';
    $('#langOther').hidden = d.lang !== 'other';
    $('#refsCountWrap').hidden = !has(d, 'parts', 'список литературы');
    var fp = $('#fontPreview');
    var fontClass = { 'Times New Roman': 'ff-times', 'Arial': 'ff-arial', 'Calibri': 'ff-calibri' }[d.fmt_font];
    fp.hidden = !fontClass;
    fp.className = 'font-preview ' + (fontClass || '');
    var size = d.fmt_size === 'other' ? parseInt(d.fmt_size_other, 10) : parseInt(d.fmt_size, 10);
    fp.style.fontSize = size >= 8 && size <= 28 ? Math.round(size * 1.25) + 'px' : '';
    fp.style.lineHeight = d.fmt_spacing ? String(Math.max(1.15, parseFloat(d.fmt_spacing) * 1.15)) : '';

    // Презентация: палитра и шрифт меняют превью
    var pres = $('#presBlock');
    var pal = null;
    PALETTES.forEach(function (p) { if (p.id === d.pr_palette) pal = p; });
    if (pal && pal.colors) {
      ['--p1', '--p2', '--p3', '--p-bg'].forEach(function (v, i) { pres.style.setProperty(v, pal.colors[i]); });
    } else {
      ['--p1', '--p2', '--p3', '--p-bg'].forEach(function (v) { pres.style.removeProperty(v); });
    }
    $('#paletteCustom').hidden = d.pr_palette !== 'custom';
    var pf = null;
    PRES_FONTS.forEach(function (f) { if (f.id === d.pr_font) pf = f; });
    if (pf) pres.style.setProperty('--p-font', pf.css); else pres.style.removeProperty('--p-font');
    $('#slidePreviewTitle').textContent = has(d, 'topic_auto', '1') ? 'Тема подберётся вместе с исполнителем' : (val(d, 'topic') || 'Тема вашей презентации');

    // Счётчик символов комментария
    $('#commentCount').textContent = String((d.comment || '').length);

    renderSummary(d);
    updateFab(d);
  }

  // --- Шаги ---
  function validateType() {
    var ok = !!readForm().type;
    $('#typeError').hidden = ok;
    $('#typeField').classList.toggle('is-invalid', !ok);
    if (!ok) {
      // Перезапуск анимации «покачивания»
      var f = $('#typeField');
      f.classList.remove('is-invalid'); void f.offsetWidth; f.classList.add('is-invalid');
    }
    return ok;
  }

  function validateDeadline() {
    var v = $('#deadline').value;
    var ok = !v || v >= isoDate(new Date());
    $('#deadlineError').hidden = ok;
    return ok;
  }

  function scrollToForm() {
    var top = form.getBoundingClientRect().top;
    var headerH = $('#header').offsetHeight;
    if (top < headerH || top > window.innerHeight * 0.6) {
      window.scrollTo({ top: window.scrollY + top - headerH - 12, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function goTo(i, opts) {
    opts = opts || {};
    i = Math.max(0, Math.min(steps.length - 1, i));
    var changed = i !== current;
    current = i;
    steps.forEach(function (s, k) {
      var active = k === i;
      s.hidden = !active;
      s.classList.toggle('is-active', active);
    });
    stepBtns.forEach(function (b, k) {
      b.classList.toggle('is-active', k === i);
      b.classList.toggle('is-done', k < i);
      b.setAttribute('aria-selected', String(k === i));
    });
    $('#progressBar').style.width = ((i + 1) / steps.length * 100) + '%';
    $('#stepCount').textContent = 'Шаг ' + (i + 1) + ' из ' + steps.length;
    $('#prevStep').hidden = i === 0;
    $('#nextStep').hidden = i === steps.length - 1;
    $('#reviewOrder').hidden = i !== steps.length - 1;
    if (changed && opts.sound !== false) play('step');
    if (changed && opts.scroll !== false) scrollToForm();
    if (changed && opts.focus !== false) {
      var title = steps[i].querySelector('.step__title');
      if (title) { title.setAttribute('tabindex', '-1'); title.focus({ preventScroll: true }); }
    }
    saveDraft();
  }

  // Переход вперёд с проверкой обязательных полей
  function tryGo(target) {
    if (target > 0 && !validateType()) {
      play('error');
      if (current !== 0) goTo(0, { sound: false });
      return;
    }
    if (target > 1 && current <= 1 && !validateDeadline()) {
      play('error');
      if (current !== 1) goTo(1, { sound: false });
      return;
    }
    goTo(target);
  }

  function selectType(id) {
    var input = form.querySelector('input[name="type"][value="' + id + '"]');
    if (!input) return;
    input.checked = true;
    syncUI();
    saveDraft();
    goTo(0, { sound: false, scroll: false, focus: false });
    var target = $('#builder');
    var headerH = $('#header').offsetHeight;
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - headerH + 40, behavior: reduceMotion ? 'auto' : 'smooth' });
    toast('Выбрано: ' + typeById(id).name + '. Продолжите заполнение 👇', '✓');
  }

  function initBuilder() {
    form = $('#orderForm');
    steps = $$('.step', form);
    stepBtns = $$('.stepper__item', form);

    // Звуки переходов играет goTo, а не общий обработчик
    ['#nextStep', '#prevStep', '#reviewOrder', '#summarySend'].forEach(function (s) { $(s).setAttribute('data-sound', 'none'); });
    stepBtns.forEach(function (b) { b.setAttribute('data-sound', 'none'); });

    $('#deadline').min = isoDate(new Date());

    // Восстанавливаем черновик
    var draft = loadDraft();
    if (draft && draft.fields) {
      writeForm(draft.fields);
      orderId = draft.orderId || '';
      lastQuick = draft.fields.deadline_quick || '';
    }

    form.addEventListener('input', onFormChange);
    form.addEventListener('change', onFormChange);
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    // Enter в текстовом поле не отправляет форму, а ведёт дальше
    form.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.matches('input[type="text"], input[type="number"], input[type="date"]')) {
        e.preventDefault();
        if (current < steps.length - 1) tryGo(current + 1);
      }
    });

    $('#nextStep').addEventListener('click', function () { tryGo(current + 1); });
    $('#prevStep').addEventListener('click', function () { goTo(current - 1); });
    stepBtns.forEach(function (b, k) { b.addEventListener('click', function () { if (k !== current) tryGo(k); }); });
    $('#reviewOrder').addEventListener('click', openPreview);
    $('#summarySend').addEventListener('click', openPreview);

    // Кнопки +/− у объёма
    $$('[data-num]', form).forEach(function (b) {
      b.addEventListener('click', function () {
        var t = typeById(readForm().type);
        var vc = VOLUME[t ? t.volume : 'pages'];
        var input = $('#volume');
        var cur = parseInt(input.value, 10);
        var dir = Number(b.getAttribute('data-num'));
        var next = isNaN(cur) ? vc.start : cur + dir * vc.step;
        input.value = Math.max(1, Math.min(999, next));
        syncUI(); saveDraft();
      });
    });

    // Очистка формы с подтверждением повторным нажатием
    var clearBtn = $('#clearForm');
    var clearTimer = null;
    clearBtn.addEventListener('click', function () {
      if (!clearBtn.classList.contains('is-confirm')) {
        clearBtn.classList.add('is-confirm');
        clearBtn.querySelector('span').textContent = 'Точно очистить?';
        clearTimer = setTimeout(resetClear, 3000);
        return;
      }
      clearTimeout(clearTimer);
      resetClear();
      form.reset();
      $('#origTouched').value = '';
      orderId = '';
      lastQuick = '';
      clearDraft();
      $('#typeError').hidden = true;
      $('#deadlineError').hidden = true;
      syncUI();
      goTo(0, { sound: false });
      toast('Форма очищена', '🧹');
    });
    function resetClear() {
      clearBtn.classList.remove('is-confirm');
      clearBtn.querySelector('span').textContent = 'Очистить форму';
    }

    syncUI();
    var startStep = draft && typeof draft.step === 'number' && readForm().type ? draft.step : 0;
    current = -1;
    goTo(startStep, { sound: false, scroll: false, focus: false });
  }

  function onFormChange(e) {
    var el = e.target;
    // Быстрый выбор срока проставляет дату
    if (el.name === 'deadline_quick' && e.type === 'change') {
      $('#deadline').value = el.value === 'flex' ? '' : addDays(Number(el.value));
      lastQuick = el.value;
      validateDeadline();
    }
    // Ручной ввод даты снимает быстрый выбор
    if (el.name === 'deadline') {
      $$('input[name="deadline_quick"]', form).forEach(function (r) { r.checked = false; });
      lastQuick = '';
      if (e.type === 'change') validateDeadline();
    }
    // Слайдер оригинальности: тихий тик на каждом шаге
    if (el.name === 'originality' && e.type === 'input') {
      $('#origTouched').value = '1';
      play('tick');
    }
    syncUI();
    saveDraft();
  }

  /* ======================= 7. СВОДКА И ТЕКСТ ЗАЯВКИ ======================= */

  /* Собираем только заполненные поля.
     p — приоритет: 1 — главное, 2 — важное, 3 — второстепенное
     (при слишком длинной ссылке второстепенное сокращается первым) */
  function collectLines(d) {
    var t = typeById(d.type);
    var L = [];
    var add = function (icon, label, value, p, key) { if (value) L.push({ icon: icon, label: label, value: value, p: p, key: key || '' }); };
    if (!t) return L;

    add('📝', 'Работа', t.name, 1);
    add('📚', 'Предмет', val(d, 'subject'), 1);
    add('🎯', 'Тема', has(d, 'topic_auto', '1') ? 'подберёт исполнитель' : val(d, 'topic'), 1, 'topic');

    var course = d.course ? (COURSE_LABEL[d.course] || d.course + ' курс') : '';
    var uni = val(d, 'university');
    if (uni || course) add('🎓', uni ? 'ВУЗ' : 'Курс', [uni, course].filter(Boolean).join(', '), 3);

    var volume = '';
    if (t.volume === 'free') volume = val(d, 'volume_free');
    else {
      var n = parseInt(d.volume, 10);
      if (n > 0) volume = n + ' ' + (t.volume === 'pages' ? 'стр.' : plural(n, VOLUME[t.volume].forms));
    }
    add('📄', 'Объём', volume, 1);

    var deadline = '';
    if (d.deadline_quick === 'flex') deadline = 'не горит';
    else if (d.deadline) deadline = ruDate(d.deadline) + (QUICK_LABEL[d.deadline_quick] ? ' (' + QUICK_LABEL[d.deadline_quick] + ')' : '');
    add('⏰', 'Срок', deadline, 1);

    if (d.orig_system === 'none') add('🔍', 'Оригинальность', 'проверка не нужна', 2);
    else {
      var pct = d.orig_touched ? d.originality + '%' : '';
      var sys = d.orig_system || '';
      add('🔍', 'Оригинальность', pct && sys ? pct + ' (' + sys + ')' : (pct || (sys ? 'система ' + sys : '')), 2);
    }

    if (d.manual === 'yes') add('📎', 'Методичка', 'есть, пришлю файлом в чат', 2);
    else if (d.manual === 'no') add('📎', 'Методичка', 'нет', 2);

    var mode = designMode(t, d);
    if (mode === 'text') {
      var font = d.fmt_font === 'other' ? val(d, 'fmt_font_other') : (d.fmt_font || '');
      var size = d.fmt_size === 'other' ? val(d, 'fmt_size_other') : (d.fmt_size || '');
      var fontPart = font && size ? font + ' ' + size : (font || (size ? 'кегль ' + size : ''));
      var fmt = [d.fmt_standard, fontPart, d.fmt_spacing ? 'интервал ' + d.fmt_spacing : '', d.fmt_margins ? 'поля ' + d.fmt_margins : ''].filter(Boolean);
      add('🖋', 'Оформление', fmt.join(', '), 3);

      var parts = (d.parts || []).map(function (p) {
        var c = parseInt(d.refs_count, 10);
        return p === 'список литературы' && c > 0 ? p + ' (' + c + ' ' + plural(c, ['источник', 'источника', 'источников']) + ')' : p;
      });
      add('📑', 'Нужно', parts.join(', '), 3);
      add('🌐', 'Язык', d.lang === 'other' ? val(d, 'lang_other') : (d.lang || ''), 3);
    }
    if (mode === 'pres') {
      var palette = d.pr_palette === 'custom' ? val(d, 'pr_palette_custom') || 'свой вариант' : d.pr_palette;
      var design = [d.pr_style ? 'стиль ' + d.pr_style : '', palette ? 'цвета «' + palette + '»' : '', d.pr_font ? 'шрифт ' + d.pr_font : ''].filter(Boolean);
      add('🎨', 'Дизайн', design.join(', '), 3);
      add('💻', 'Формат', [d.pr_format, d.pr_anim].filter(Boolean).join(', '), 3);
      if (d.pr_speech) add('🎙', 'Текст выступления', d.pr_speech === 'yes' ? 'нужен' : 'не нужен', 2);
      if (d.pr_template) add('🏫', 'Шаблон ВУЗа', d.pr_template === 'yes' ? 'есть, пришлю в чат' : 'нет', 3);
    }
    if (mode === 'draw') {
      add('📐', 'Чертежи', [d.dr_soft, d.dr_format ? 'формат ' + d.dr_format : ''].filter(Boolean).join(', '), 3);
    }

    add('➕', 'Доп. услуги', (d.extras || []).join(', '), 2);
    add('💬', 'Комментарий', val(d, 'comment'), 2, 'comment');
    add('👤', 'Имя', val(d, 'client_name'), 2);
    return L;
  }

  function compose(lines, id, footer) {
    var out = ['🧾 Заявка #' + id + ' с сайта «Не Парься»'];
    lines.forEach(function (l) { out.push(l.icon + ' ' + l.label + ': ' + l.value); });
    if (footer) out.push('', footer);
    return out.join('\n');
  }

  function cut(str, max) {
    var chars = Array.from(str); // по символам, чтобы не разрезать эмодзи
    return chars.length > max ? chars.slice(0, max - 1).join('').trim() + '…' : str;
  }

  /* Укладываем текст в лимит длины ссылки.
     Возвращает { full, link, shortened }: full — для буфера, link — для URL */
  function fitMessage(lines, id) {
    var full = compose(lines, id);
    if (tgLink(full).length <= MAX_URL) return { full: full, link: full, shortened: false };

    var note = '📋 Полная заявка скопирована — вставлю её следующим сообщением';
    var shorten = function (ls, max) {
      return ls.map(function (l) { return (l.key === 'comment' || l.key === 'topic') ? Object.assign({}, l, { value: cut(l.value, max) }) : l; });
    };
    var strategies = [
      function () { return shorten(lines, 400); },
      function () { return shorten(lines.filter(function (l) { return l.p < 3; }), 250); },
      function () { return shorten(lines.filter(function (l) { return l.p < 3; }), 100); },
      function () { return shorten(lines.filter(function (l) { return l.p < 2; }), 80); }
    ];
    for (var i = 0; i < strategies.length; i++) {
      var text = compose(strategies[i](), id, note);
      if (tgLink(text).length <= MAX_URL) return { full: full, link: text, shortened: true };
    }
    // Крайний случай: обрезаем текст посимвольно
    var chars = Array.from(compose(strategies[3](), id, ''));
    var tail = '…\n\n' + note;
    while (chars.length && tgLink(chars.join('') + tail).length > MAX_URL) chars.splice(-20, 20);
    return { full: full, link: chars.join('') + tail, shortened: true };
  }

  function currentOrder() {
    var d = readForm();
    var lines = collectLines(d);
    if (!lines.length) return null;
    if (!orderId) { orderId = makeOrderId(); saveDraft(); }
    var fit = fitMessage(lines, orderId);
    fit.lines = lines;
    return fit;
  }

  function renderSummary(d) {
    var lines = collectLines(d);
    var list = $('#summaryList');
    var prev = list.getAttribute('data-sig');
    var sig = JSON.stringify(lines);
    if (prev !== sig) {
      list.setAttribute('data-sig', sig);
      list.innerHTML = lines.map(function (l) {
        return '<li class="summary__item"><span class="summary__item-icon" aria-hidden="true">' + l.icon + '</span>' +
          '<span><span class="summary__item-label">' + esc(l.label) + '</span><span class="summary__item-value">' + esc(cut(l.value, 160)) + '</span></span></li>';
      }).join('');
    }
    $('#summaryEmpty').hidden = lines.length > 0;
    $('#summarySend').hidden = lines.length === 0;
    $('#summaryFilled').textContent = lines.length + ' ' + plural(lines.length, ['поле', 'поля', 'полей']);
    var t = typeById(d.type);
    var short = [];
    if (t) short.push(t.short);
    lines.forEach(function (l) { if (l.label === 'Объём' || l.label === 'Срок') short.push(l.value.replace(/ \(.+\)$/, '')); });
    $('#summaryShort').textContent = short.length ? short.join(' · ') : 'пока пусто — выберите тип работы';
  }

  // Мобильная плашка сводки: видна, пока конструктор на экране
  function initSummary() {
    var summary = $('#summary'), bar = $('#summaryBar');
    function setOpen(open) {
      summary.classList.toggle('is-open', open);
      bar.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('summary-open', open);
    }
    bar.addEventListener('click', function () { setOpen(!summary.classList.contains('is-open')); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    document.addEventListener('click', function (e) {
      if (summary.classList.contains('is-open') && !summary.contains(e.target)) setOpen(false);
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          document.body.classList.toggle('summary-on', en.isIntersecting);
          if (!en.isIntersecting) setOpen(false);
        });
      }, { rootMargin: '-30% 0px -10% 0px' }).observe($('#builder'));
    }
  }

  /* ======================= 8. ОТПРАВКА В TELEGRAM ======================= */

  // Копирование в буфер: сначала синхронный запасной вариант (работает
  // даже без HTTPS), затем современный Clipboard API
  function copyText(text) {
    var ok = false;
    try {
      // Внутри открытого модального окна остальная страница «инертна»,
      // поэтому временное поле кладём в само окно
      var host = document.querySelector('dialog[open]') || document.body;
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px;';
      host.appendChild(ta);
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
      host.removeChild(ta);
    } catch (e) { ok = false; }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(function () { /* уже скопировано запасным способом */ });
      ok = true;
    }
    return ok;
  }

  var preview = null;
  function openPreview() {
    if (!validateType()) { play('error'); goTo(0, { sound: false }); return; }
    if (!validateDeadline()) { play('error'); goTo(1, { sound: false }); return; }
    preview = currentOrder();
    if (!preview) return;
    $('#previewText').textContent = preview.full;
    var note = $('#previewNote');
    note.hidden = !preview.shortened;
    note.textContent = 'Заявка получилась длинной: в чат подставится сокращённая версия, а полная скопируется в буфер — просто вставьте её следующим сообщением.';
    // Обычная ссылка надёжнее window.open: её не блокируют попап-блокеры
    if (BOT) {
      // С базой — заявка уйдёт боту целиком по коду; без неё бот попросит вставить текст
      preview.handoff = LIVE ? makeHandoffCode() : '';
      $('#sendTelegram').href = botLink('order_' + (preview.handoff || orderId));
      note.hidden = true;
    } else {
      $('#sendTelegram').href = tgLink(preview.link);
    }
    play('pop');
    openModal($('#previewModal'));
  }

  function initSend() {
    $('#sendTelegram').addEventListener('click', function (e) {
      if (!preview) { e.preventDefault(); return; }
      if (BOT) { sendToBot(e); return; }
      // Переход по ссылке выполнит браузер, здесь — только копирование
      var copied = copyText(preview.full);
      play('success');
      closeModal($('#previewModal'));
      toast(copied
        ? 'Заявка скопирована — если текст не подставился, просто вставь его в чат'
        : 'Если текст не подставился, скопируйте заявку из окна предпросмотра', copied ? '✅' : 'ℹ️', 7000);
    });
  }

  // --- Отправка заказа в бота ---
  function sitePayload() {
    var d = readForm();
    return {
      kind: 'np_order', v: 1, id: orderId, type: d.type || 'other',
      deadline: d.deadline_quick === 'flex' ? 'flex' : (d.deadline || ''),
      lines: preview.lines.map(function (l) { return [l.icon, l.label, l.value]; })
    };
  }

  // sendData принимает до 4096 байт: при необходимости укорачиваем самые длинные поля
  function fitSendData(payload) {
    var size = function (str) { return new TextEncoder().encode(str).length; };
    var json = JSON.stringify(payload);
    while (size(json) > 4096) {
      var longest = payload.lines.reduce(function (a, b) { return b[2].length > a[2].length ? b : a; });
      longest[2] = cut(longest[2], Math.floor(Array.from(longest[2]).length * 0.8));
      json = JSON.stringify(payload);
    }
    return json;
  }

  function saveHandoff(code, payload) {
    return api('bot_handoff', { method: 'POST', prefer: 'return=minimal', body: { code: code, payload: payload }, keepalive: true });
  }

  function sendToBot(e, noApi, noCloud) {
    var payload = sitePayload();
    var copied = copyText(preview.full); // запасной вариант — текст в буфере
    play('success');

    // 0) Сайт выложил сам бот: заказ уходит ему напрямую, с подписью Telegram (initData)
    if (IN_TG && window.NP_BOT_API && TGW.initData && !noApi) {
      e.preventDefault();
      fetch(window.NP_BOT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: TGW.initData, order: payload })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function () {
        closeModal($('#previewModal'));
        toast('Заказ отправлен! Подтверждение уже в чате с ботом', '✅', 4000);
        setTimeout(function () { TGW.close(); }, 1200);
      }).catch(function () {
        sendToBot(e, true); // не вышло — пробуем через облако или ссылку
      });
      return;
    }

    // 0б) Есть облако (Supabase): заказ сохраняется и сразу принимается ботом в облаке (по подписи Telegram).
    //     Бот проверит подпись Telegram и пришлёт подтверждение, как только будет на связи.
    if (IN_TG && LIVE && TGW.initData && !noCloud) {
      e.preventDefault();
      api('incoming_orders', { method: 'POST', prefer: 'return=minimal', body: { init_data: TGW.initData, payload: payload } })
        .then(function () {
          closeModal($('#previewModal'));
          toast('Заказ сохранён! Подтверждение придёт в чат с ботом', '✅', 4000);
          setTimeout(function () { TGW.close(); }, 1500);
        }, function () {
          sendToBot(e, true, true); // облако недоступно — обычный путь через ссылку
        });
      return;
    }

    // 1) Сайт открыт reply-кнопкой бота: данные уходят напрямую, Mini App закрывается сам
    if (LAUNCH === 'keyboard') {
      e.preventDefault();
      try { TGW.sendData(fitSendData(payload)); return; } catch (err) { /* дальше — как по ссылке */ }
    }
    // 2) Сайт открыт внутри Telegram кнопкой меню / под сообщением: переходим в бота по ссылке
    if (IN_TG) {
      e.preventDefault();
      var go = function (start) {
        TGW.openTelegramLink(botLink(start));
        setTimeout(function () { TGW.close(); }, 400);
      };
      if (preview.handoff) {
        saveHandoff(preview.handoff, payload).then(
          function () { go('order_' + preview.handoff); },
          function () { go('order_' + orderId); } // база недоступна — бот попросит вставить текст
        );
      } else {
        go('order_' + orderId);
      }
      return;
    }
    // 3) Обычный браузер: ссылка на бота откроется сама, заявку сохраняем параллельно
    if (preview.handoff) saveHandoff(preview.handoff, payload).catch(function () { /* бот попросит вставить текст */ });
    closeModal($('#previewModal'));
    toast(preview.handoff
      ? 'Открываю бота — нажмите «Запустить», и заказ сразу примут. Текст заявки на всякий случай скопирован'
      : 'Заявка скопирована — в боте нажмите «Запустить» и вставьте её одним сообщением', copied ? '✅' : 'ℹ️', 8000);
  }

  // Плавающая кнопка: пустой конструктор — приветствие, иначе текущая сводка
  var fabOrder = null;
  function updateFab(d) {
    var fab = $('#fab');
    var lines = collectLines(d);
    if (BOT) {
      // С ботом: кнопка ведёт в бота, а при заполненном конструкторе копирует заявку
      fabOrder = lines.length ? fitMessage(lines, orderId || '—') : null;
      fab.href = botLink('site');
      fab.setAttribute('aria-label', 'Открыть бота в Telegram');
      return;
    }
    if (lines.length) {
      fabOrder = fitMessage(lines, orderId || '—');
      fab.href = tgLink(fabOrder.link);
      fab.setAttribute('aria-label', 'Написать в Telegram с текущей заявкой');
    } else {
      fabOrder = null;
      fab.href = tgLink(DEFAULT_MSG);
      fab.setAttribute('aria-label', 'Написать в Telegram');
    }
  }
  function initFab() {
    var fab = $('#fab');
    fab.target = '_blank';
    fab.rel = 'noopener';
    fab.addEventListener('click', function () {
      if (!fabOrder) return;
      // Номер заявки нужен настоящий — генерируем при первом использовании
      var order = currentOrder();
      if (order) {
        if (!BOT) fab.href = tgLink(order.link);
        if (copyText(order.full)) toast('Заявка скопирована — если текст не подставился, просто вставь его в чат', '✅', 6000);
      }
    });
  }

  /* --- Модальные окна (на базе <dialog>) --- */
  function openModal(dlg) {
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    document.body.style.overflow = 'hidden';
  }
  function closeModal(dlg) {
    if (typeof dlg.close === 'function' && dlg.open) dlg.close(); else dlg.removeAttribute('open');
  }
  function initModals() {
    $$('dialog.modal').forEach(function (dlg) {
      dlg.addEventListener('close', function () { document.body.style.overflow = ''; });
      dlg.addEventListener('click', function (e) {
        if (e.target === dlg || e.target.closest('[data-close]')) closeModal(dlg);
      });
    });
  }

  /* --- Тосты --- */
  function toast(text, icon, ms) {
    var box = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = (icon ? '<span class="toast__icon" aria-hidden="true">' + icon + '</span>' : '') + '<span>' + esc(text) + '</span>';
    box.appendChild(el);
    while (box.children.length > 2) box.removeChild(box.firstChild);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
    }, ms || 3200);
  }

  /* ======================= 9. ЛАЙТБОКС, ОТЗЫВЫ, FAQ ======================= */

  var lbIndex = 0;
  function showWork(i) {
    if (!works.length) return;
    lbIndex = (i + works.length) % works.length;
    var w = works[lbIndex];
    $('#lbMedia').innerHTML = workMedia(w);
    $('#lbType').textContent = w.type || 'Работа';
    $('#lbTitle').textContent = w.subject || '';
    $('#lbDesc').textContent = w.description || '';
    $('#lbCount').textContent = (lbIndex + 1) + ' / ' + works.length;
    var multi = works.length > 1;
    $('#lbPrev').hidden = !multi;
    $('#lbNext').hidden = !multi;
  }
  function initLightbox() {
    var lb = $('#lightbox');
    $('#worksGrid').addEventListener('click', function (e) {
      var card = e.target.closest('[data-work]');
      if (!card) return;
      showWork(Number(card.getAttribute('data-work')));
      openModal(lb);
    });
    $('#lbPrev').addEventListener('click', function () { showWork(lbIndex - 1); });
    $('#lbNext').addEventListener('click', function () { showWork(lbIndex + 1); });
    lb.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { showWork(lbIndex - 1); play('click'); }
      if (e.key === 'ArrowRight') { showWork(lbIndex + 1); play('click'); }
    });
    // Свайп по картинке на телефоне
    var x0 = null;
    $('#lbMedia').addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    $('#lbMedia').addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) { showWork(lbIndex + (dx < 0 ? 1 : -1)); play('click'); }
      x0 = null;
    });
  }

  function carouselStep() {
    var track = $('#reviewsTrack');
    var card = track.children[0];
    if (!card) return track.clientWidth;
    return card.getBoundingClientRect().width + parseFloat(getComputedStyle(track).columnGap || 12);
  }

  function updateCarousel() {
    var track = $('#reviewsTrack');
    var dots = $$('#reviewsDots button');
    var fitsAll = track.scrollWidth <= track.clientWidth + 4;
    $('#reviewsDots').hidden = fitsAll || !dots.length;
    $('.carousel__ctrls').style.visibility = fitsAll ? 'hidden' : '';
    var atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    var idx = atEnd ? dots.length - 1 : Math.round(track.scrollLeft / carouselStep());
    dots.forEach(function (d, k) { d.classList.toggle('is-active', k === idx); });
    $('#revPrev').disabled = track.scrollLeft <= 4;
    $('#revNext').disabled = atEnd;
  }

  function initCarousel() {
    var track = $('#reviewsTrack');
    var behavior = reduceMotion ? 'auto' : 'smooth';
    track.addEventListener('scroll', function () { requestAnimationFrame(updateCarousel); }, { passive: true });
    window.addEventListener('resize', updateCarousel);
    $('#revPrev').addEventListener('click', function () { track.scrollBy({ left: -carouselStep(), behavior: behavior }); });
    $('#revNext').addEventListener('click', function () { track.scrollBy({ left: carouselStep(), behavior: behavior }); });
    $('#reviewsDots').addEventListener('click', function (e) {
      var d = e.target.closest('[data-dot]');
      if (d) track.scrollTo({ left: Number(d.getAttribute('data-dot')) * carouselStep(), behavior: behavior });
    });
    track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); $('#revNext').click(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); $('#revPrev').click(); }
    });
  }

  /* ======================= 11. ЖИВЫЕ ДАННЫЕ (SUPABASE) ======================= */

  // Запрос к REST API Supabase. Ключ — публичный (publishable / anon).
  function api(path, opts) {
    opts = opts || {};
    var headers = { apikey: SB.key, 'Content-Type': 'application/json' };
    if (/^eyJ/.test(SB.key)) headers.Authorization = 'Bearer ' + SB.key; // старый формат anon-ключа
    if (opts.prefer) headers.Prefer = opts.prefer;
    return fetch(SB.url + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers: headers,
      keepalive: !!opts.keepalive, // запрос доживёт, даже если пользователь уйдёт со страницы
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          var err = new Error('HTTP ' + r.status);
          err.status = r.status;
          err.details = t;
          throw err;
        });
      }
      return r.status === 204 ? null : r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }

  // Посетитель считается один раз на браузер; дальше — только чтение цифр
  function loadStats() {
    if (!LIVE) return;
    var seen = null;
    try { seen = localStorage.getItem(VISIT_KEY); } catch (e) { seen = 'unknown'; }
    var rpc = seen ? 'get_stats' : 'register_visit';
    api('rpc/' + rpc, { method: 'POST', body: {} })
      .then(function (data) {
        if (!seen) { try { localStorage.setItem(VISIT_KEY, String(Date.now())); } catch (e) { /* без отметки */ } }
        setStats(data);
      })
      .catch(function (e) {
        console.warn('[Не Парься] Не удалось получить счётчики:', e.message, e.details || '');
        $('#statsGrid').closest('section').hidden = true;
      });
  }

  function loadReviews() {
    if (!LIVE) { $('#reviews').hidden = true; hideNav('reviews'); return; }
    renderReviews([], 'loading');
    api('reviews?select=id,created_at,name,university,work,message,rating&order=created_at.desc&limit=60')
      .then(function (rows) { renderReviews(rows || [], 'ready'); })
      .catch(function (e) {
        console.warn('[Не Парься] Не удалось загрузить отзывы:', e.message, e.details || '');
        renderReviews([], 'error');
      });
  }

  function initReviewForm() {
    if (!LIVE) return;
    $('#reviewsCta').hidden = false;
    var modal = $('#reviewModal');
    var rf = $('#reviewForm');
    var err = $('#reviewError');
    var submit = $('#reviewSubmit');

    if (CFG.reviewsModeration) $('#reviewLead').textContent = 'Отзыв появится на сайте после быстрой проверки.';

    $('#rvWork').innerHTML = WORK_TYPES.map(function (t) {
      return '<label class="chip"><input type="radio" name="work" value="' + esc(t.short) + '"><span>' + esc(t.short) + '</span></label>';
    }).join('');

    function showError(text) { err.textContent = text; err.hidden = !text; }

    $('#openReview').addEventListener('click', function () {
      showError('');
      openModal(modal);
    });
    rf.addEventListener('change', function (e) {
      if (e.target.name === 'rating') $('#ratingCaption').textContent = RATING_WORDS[Number(e.target.value)] || '';
    });
    $('#rvText').addEventListener('input', function () { $('#rvCount').textContent = String(this.value.length); });
    rf.addEventListener('input', function () { if (!err.hidden) showError(''); });

    rf.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(rf);
      var rating = Number(fd.get('rating'));
      var name = String(fd.get('name') || '').trim();
      var uni = String(fd.get('university') || '').trim();
      var work = String(fd.get('work') || '').trim();
      var message = String(fd.get('message') || '').trim();

      // Бот заполнил скрытое поле — делаем вид, что всё хорошо
      if (fd.get('website')) { closeModal(modal); return; }

      var problem = !rating ? 'Поставьте оценку — от 1 до 5 звёзд.'
        : !name ? 'Напишите, как подписать отзыв.'
        : message.length < 10 ? 'Напишите отзыв хотя бы в пару слов — минимум 10 символов.'
        : '';
      if (problem) { showError(problem); play('error'); return; }

      // Не чаще одного отзыва с браузера за 12 часов
      var last = 0;
      try { last = Number(localStorage.getItem(REVIEW_KEY)) || 0; } catch (e2) { /* без ограничения */ }
      if (Date.now() - last < 12 * 3600 * 1000) {
        showError('Вы уже оставили отзыв недавно. Спасибо! Новый можно будет добавить позже.');
        play('error');
        return;
      }

      showError('');
      submit.disabled = true;
      submit.textContent = 'Отправляем…';
      api('reviews', {
        method: 'POST',
        prefer: 'return=minimal',
        body: { name: name, university: uni || null, work: work || null, message: message, rating: rating }
      }).then(function () {
        try { localStorage.setItem(REVIEW_KEY, String(Date.now())); } catch (e3) { /* ничего */ }
        rf.reset();
        $('#ratingCaption').textContent = 'Выберите оценку';
        $('#rvCount').textContent = '0';
        closeModal(modal);
        play('success');
        toast(CFG.reviewsModeration ? 'Спасибо! Отзыв появится после проверки.' : 'Спасибо! Ваш отзыв опубликован.', '💜', 5000);
        loadReviews();
        api('rpc/get_stats', { method: 'POST', body: {} }).then(setStats).catch(function () { /* не критично */ });
      }).catch(function (e4) {
        console.warn('[Не Парься] Отзыв не отправлен:', e4.message, e4.details || '');
        // Понятная причина вместо общего «проверьте интернет» — так проще найти, что не так
        var d = String(e4.details || '');
        showError(e4.status === 400 || /check constraint|violates check/i.test(d)
          ? 'Проверьте поля: имя до 60 символов, отзыв от 10 до 1000 символов.'
          : e4.status === 401 || e4.status === 403
            ? (/row-level security/i.test(d)
              ? 'База не приняла отзыв (правила доступа). Владельцу сайта: выполните заново supabase-setup.sql. [код ' + e4.status + ']'
              : 'База отклонила ключ. Владельцу сайта: проверьте в config.js url и publishable-ключ Supabase. [код ' + e4.status + ']')
          : e4.status === 404
            ? 'В базе нет таблицы отзывов. Владельцу сайта: выполните supabase-setup.sql. [код 404]'
          : e4.status
            ? 'База временно не отвечает, попробуйте через минуту. [код ' + e4.status + ']'
            : 'Не удалось связаться с базой. Проверьте интернет; если не помогает — попробуйте с VPN или другой сетью.');
        play('error');
      }).then(function () {
        submit.disabled = false;
        submit.textContent = 'Опубликовать отзыв';
      });
    });
  }

  function initFaq() {
    $('#faqList').addEventListener('click', function (e) {
      var q = e.target.closest('.faq__q');
      if (!q) return;
      var item = q.parentNode;
      var open = !item.classList.contains('is-open');
      item.classList.toggle('is-open', open);
      q.setAttribute('aria-expanded', String(open));
    });
  }

  /* ======================= 10. ЗАПУСК ======================= */

  function init() {
    initTheme();
    initTelegram();
    initHeader();
    initUiSounds();

    renderStats();
    renderServices();
    renderTypeGrid();
    renderPalettes();
    renderPresFonts();
    renderWorks();
    renderFaq();
    initStaticLinks();

    initModals();
    initBuilder();
    initSummary();
    initSend();
    initFab();
    initLightbox();
    initCarousel();
    initFaq();
    initReveal();

    loadStats();
    loadReviews();
    initReviewForm();

    $('#servicesGrid').addEventListener('click', function (e) {
      var card = e.target.closest('[data-type]');
      if (card) selectType(card.getAttribute('data-type'));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
