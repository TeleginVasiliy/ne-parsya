/* ==========================================================================
   «Не Парься» — кабинет клиента.
   Заказы берутся из облака по личному ключу клиента (?t=… из бота).
   Ключ запоминается в браузере, чтобы кабинет открывался и без ссылки.
   ========================================================================== */
(function () {
  'use strict';

  var TOKEN_KEY = 'np-cabinet-token';
  var params = new URLSearchParams(location.search);
  var BOT = String((window.SITE_CONFIG || {}).botUsername || params.get('bot') || '').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(BOT)) BOT = '';
  var TGW = (window.Telegram && window.Telegram.WebApp) || null;
  var IN_TG = !!(TGW && TGW.platform && TGW.platform !== 'unknown');
  var $ = function (s) { return document.querySelector(s); };

  var STATUS = {
    new: '🆕 Новый', awaiting_payment: '💳 Ожидает оплаты', in_work: '🛠 В работе', review: '🔎 На проверке',
    awaiting_final: '💳 Ожидает доплаты', done: '✅ Выполнен', cancelled: '❌ Отменён'
  };
  // Шаги прогресса: Новый → Оплата → В работе → Проверка → Готово
  var STEP = { new: 1, awaiting_payment: 2, in_work: 3, awaiting_final: 4, review: 4, done: 5, cancelled: 0 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return n == null ? '—' : Number(n).toLocaleString('ru-RU') + ' ₽'; }
  function date(s) {
    if (!s) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { var p = s.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
    var d = new Date(s);
    return isNaN(d) ? s : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }
  function toast(text) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }
  // Реквизиты приходят с тегами <code> и <b> (из бота) — остальное экранируем
  function details(text) {
    return esc(text).replace(/&lt;code&gt;([\s\S]*?)&lt;\/code&gt;/g, '<code title="Нажмите, чтобы скопировать">$1</code>')
      .replace(/&lt;b&gt;([\s\S]*?)&lt;\/b&gt;/g, '<b>$1</b>').replace(/\n/g, '<br>');
  }
  // Быстрая оплата: ссылки банков и кнопки «Скопировать» (номер для СБП, карта, сумма)
  function quickPay(due) {
    var x = window.__payExtra || {};
    var out = (x.links || []).map(function (l) {
      return '<a class="btn btn--primary btn--sm js-ext" href="' + esc(l.url) + '" target="_blank" rel="noopener">💳 Оплатить: ' + esc(l.name) + '</a>';
    });
    if (x.phone) out.push('<button type="button" class="btn btn--ghost btn--sm js-copy" data-copy="' + esc(x.phone) + '">📋 Номер для СБП</button>');
    if (x.card) out.push('<button type="button" class="btn btn--ghost btn--sm js-copy" data-copy="' + esc(String(x.card).replace(/\s/g, '')) + '">📋 Номер карты</button>');
    if (x.phone || x.card) out.push('<button type="button" class="btn btn--ghost btn--sm js-copy" data-copy="' + Math.round(due) + '">📋 Сумма</button>');
    return out.length ? '<div class="pay-box__quick">' + out.join('') + '</div>' : '';
  }
  function copy(text) {
    var done = function () { toast('Скопировано: ' + text); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); } catch (e) { /* ничего */ }
    t.remove();
  }
  function botLink(start) { return BOT ? 'https://t.me/' + BOT + (start ? '?start=' + start : '') : '#'; }
  function openBot(e) {
    if (IN_TG && BOT) { e.preventDefault(); TGW.close(); } // мы уже в Telegram — просто возвращаемся в чат
  }

  var token = params.get('t') || '';
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else token = localStorage.getItem(TOKEN_KEY) || '';
  } catch (e) { /* без запоминания */ }
  if (params.get('t')) history.replaceState(null, '', location.pathname + (BOT ? '?bot=' + BOT : '')); // ключ не светим в адресе

  function renderNoAccess(text) {
    $('#content').innerHTML = '<div class="p-empty"><b>' + esc(text) + '</b>' +
      'Откройте кабинет из бота: «📦 Мои заказы» → «🌐 Кабинет на сайте».' +
      (BOT ? '<p style="margin-top:14px"><a class="btn btn--primary" id="toBot" href="' + botLink() + '" target="_blank" rel="noopener">Перейти в бота</a></p>' : '') +
      '</div>';
    var b = $('#toBot');
    if (b) b.addEventListener('click', openBot);
  }

  function orderCard(o) {
    var due = 0, payKind = '';
    if (o.status === 'awaiting_payment') { due = Math.max(0, (o.prepay || o.price || 0) - (o.paid || 0)); payKind = 'Оплата'; }
    if (o.status === 'awaiting_final') { due = Math.max(0, (o.price || 0) - (o.paid || 0)); payKind = 'Доплата'; }
    var step = STEP[o.status] || 0;
    var steps = '';
    for (var i = 1; i <= 5; i++) steps += '<span class="' + (i <= step ? 'on' : '') + '"></span>';
    var lines = (o.lines || []).map(function (l) {
      return '<li><span>' + esc(l[0]) + '</span><span><b>' + esc(l[1]) + ':</b> ' + esc(l[2]) + '</span></li>';
    }).join('');
    var files = (o.files || []).map(function (f) {
      return '<a class="file-link" href="' + SB.publicUrl('results', f.path) + '" target="_blank" rel="noopener" download>' + esc(f.name || 'Файл') + '</a>';
    }).join('');
    return '<article class="o-card">' +
      '<div class="o-card__head"><div><div class="o-card__code">#' + esc(o.code) + '</div>' +
      '<div class="o-card__type">' + esc(o.type_name || '') + ' · от ' + date(o.created_at) + '</div></div>' +
      '<span class="pill" data-s="' + esc(o.status) + '">' + esc(STATUS[o.status] || o.status) + '</span></div>' +
      (o.status !== 'cancelled' ? '<div><div class="steps" aria-hidden="true">' + steps + '</div>' +
        '<div class="steps-labels"><span>Заявка</span><span>Оплата</span><span>Работа</span><span>Проверка</span><span>Готово</span></div></div>' : '') +
      '<div class="money"><div><small>Цена</small><b>' + (o.price ? money(o.price) : 'ещё считаем') + '</b></div>' +
      '<div><small>Оплачено</small><b>' + money(o.paid || 0) + '</b></div>' +
      '<div><small>Срок</small><b>' + esc(o.deadline_text || date(o.deadline)) + '</b></div></div>' +
      (o.reject_reason ? '<p class="p-muted">Причина отмены: ' + esc(o.reject_reason) + '</p>' : '') +
      (due ? '<div class="pay-box"><b>' + payKind + ': ' + money(due) + '</b>' +
        '<div class="pay-box__details">' + details(window.__payDetails || 'Реквизиты пришлёт исполнитель в чате') + '</div>' +
        quickPay(due) +
        '<div class="p-muted">В комментарии к переводу укажите номер заказа: <code>' + esc(o.code) + '</code></div>' +
        '<a class="btn btn--primary btn--sm js-bot" href="' + botLink() + '" target="_blank" rel="noopener">📸 Я оплатил — отправить чек в боте</a></div>' : '') +
      (files ? '<div class="files"><b>📎 Готовая работа</b>' + files + '</div>' : '') +
      '<details class="o-more"><summary>Подробности заказа</summary><ul class="o-lines">' + lines + '</ul></details>' +
      '</article>';
  }

  function load(silent) {
    if (!SB.enabled) { renderNoAccess('Кабинет пока не подключён'); return; }
    if (!token) { renderNoAccess('Не нашли ваш кабинет'); return; }
    SB.rpc('client_cabinet', { p_token: token }, { anon: true }).then(function (data) {
      if (!data) { renderNoAccess('Ссылка на кабинет устарела'); return; }
      window.__payDetails = data.payment_details;
      try { window.__payExtra = JSON.parse(data.payment_extra || '{}'); } catch (e) { window.__payExtra = {}; }
      if (data.name) $('#hello').textContent = data.name + ', ваши заказы';
      var orders = data.orders || [];
      $('#content').innerHTML = orders.length
        ? '<div class="orders">' + orders.map(orderCard).join('') + '</div>'
        : '<div class="p-empty"><b>Заказов пока нет</b>Оформите заказ на сайте или в боте — он появится здесь.</div>';
      document.querySelectorAll('.js-bot').forEach(function (a) { a.addEventListener('click', openBot); });
    }).catch(function () {
      if (!silent) $('#content').innerHTML = '<div class="p-empty"><b>Не получилось загрузить заказы</b>Проверьте интернет и нажмите «Обновить».</div>';
    });
  }

  if (IN_TG) { try { TGW.ready(); TGW.expand(); } catch (e) { /* старый Telegram */ } }
  if (BOT) $('#homeLink').href = 'index.html?bot=' + BOT;
  $('#refresh').addEventListener('click', function () { load(false); toast('Обновлено'); });
  // Нажатие на номер карты / телефона копирует его (работает и после автообновления)
  $('#content').addEventListener('click', function (e) {
    var c = e.target.closest('.pay-box code');
    if (c) copy(c.textContent);
    var b = e.target.closest('.js-copy');
    if (b) copy(b.getAttribute('data-copy'));
    var a = e.target.closest('.js-ext');
    if (a && IN_TG && TGW.openLink) { e.preventDefault(); TGW.openLink(a.href); } // банк откроется в браузере/приложении
  });
  load(false);
  setInterval(function () { if (!document.hidden) load(true); }, 30000);
})();
