/* ==========================================================================
   «Не Парься» — админ-панель.
   Данные выгружает бот в Supabase. Действия (цена, статус, сообщение)
   записываются в очередь — бот сразу выполняет их и пишет клиенту.
   Готовые работы загружаются прямо в хранилище — клиент сразу видит их
   в кабинете, а бот отправит их в Telegram. Отзывы с сайта можно скрыть или удалить.
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var STATUS = {
    new: '🆕 Новый', awaiting_payment: '💳 Ожидает оплаты', in_work: '🛠 В работе', review: '🔎 На проверке',
    awaiting_final: '💳 Ожидает доплаты', done: '✅ Выполнен', cancelled: '❌ Отменён'
  };
  var MANUAL = ['new', 'awaiting_payment', 'in_work', 'review', 'done', 'cancelled'];
  var ACTION_NAME = { price: 'Цена', status: 'Статус', message: 'Сообщение', bundle: 'Отправлено клиенту' };
  var STATE_NAME = { pending: 'отправляется', processing: 'отправляется', done: 'выполнено', error: 'ошибка' };
  var MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  var data = { orders: [], payments: [], files: [], actions: [], reviews: [] };
  var current = null; // открытый заказ

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return n == null ? '—' : Math.round(n).toLocaleString('ru-RU') + ' ₽'; }
  function dt(s) {
    if (!s) return '—';
    var d = new Date(s);
    return isNaN(d) ? s : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function toast(text) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }
  function pill(s) { return '<span class="pill" data-s="' + esc(s) + '">' + esc(STATUS[s] || s) + '</span>'; }
  function randomHex(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  // Адрес файла в хранилище — только латиница (на русских буквах Supabase отвечает «Invalid key»).
  // Настоящее имя файла сохраняется отдельно и показывается клиенту.
  var RU = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
    ь: '', э: 'e', ю: 'yu', я: 'ya' };
  function safeName(name) {
    var latin = Array.from(String(name || 'file')).map(function (ch) {
      var low = ch.toLowerCase();
      if (!(low in RU)) return ch;
      var t = RU[low];
      return ch !== low && t ? t[0].toUpperCase() + t.slice(1) : t;
    }).join('');
    return (latin.replace(/[^A-Za-z0-9_.\-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'file').slice(-80);
  }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : randomHex(16); }

  /* ---------------- вход ---------------- */
  function showLogin(msg) {
    $('#app').hidden = true;
    $('#who').hidden = true;
    $('#loginForm').hidden = false;
    $('#loginError').hidden = !msg;
    $('#loginError').textContent = msg || '';
  }

  function start() {
    if (!SB.enabled) {
      $('#fatal').hidden = false;
      $('#fatal').textContent = 'Панель не подключена: впишите адрес и ключ Supabase в config.js (раздел supabase).';
      return;
    }
    if (!SB.session()) { showLogin(); return; }
    SB.rpc('is_panel_admin').then(function (ok) {
      if (!ok) { SB.signOut(); showLogin('У этого e-mail нет доступа к панели. Добавьте его в таблицу panel_admins (README).'); return; }
      $('#loginForm').hidden = true;
      $('#app').hidden = false;
      $('#who').hidden = false;
      $('#whoEmail').textContent = SB.session().email;
      loadAll();
    }).catch(function () { SB.signOut(); showLogin('Сессия истекла — войдите снова.'); });
  }

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    $('#loginBtn').disabled = true;
    SB.signIn($('#email').value.trim(), $('#password').value).then(start, function () {
      showLogin('Неверный e-mail или пароль.');
    }).then(function () { $('#loginBtn').disabled = false; });
  });
  $('#logout').addEventListener('click', function () { SB.signOut(); showLogin(); });
  $('#reload').addEventListener('click', function () { loadAll(); toast('Обновлено'); });

  /* ---------------- данные ---------------- */
  // redraw — перерисовать открытую карточку (после своих действий; при автообновлении — нет,
  // чтобы не стереть набираемый текст)
  function loadAll(redraw) {
    return Promise.all([
      SB.select('cloud_orders', 'select=*&order=id.desc&limit=2000'),
      SB.select('cloud_payments', 'select=*&order=id.desc&limit=5000'),
      SB.select('cloud_files', 'select=*&order=created_at.desc&limit=5000'),
      SB.select('cloud_actions', 'select=*&order=id.desc&limit=300'),
      SB.select('reviews', 'select=*&order=created_at.desc&limit=1000').catch(function () { return []; })
    ]).then(function (r) {
      data = { orders: r[0] || [], payments: r[1] || [], files: r[2] || [], actions: r[3] || [], reviews: r[4] || [] };
      var pending = data.actions.filter(function (a) { return a.state === 'pending'; }).length;
      var last = data.orders.reduce(function (m, o) { return o.updated_at > m ? o.updated_at : m; }, '');
      $('#syncNote').textContent = 'Последнее обновление от бота: ' + dt(last) +
        (pending ? ' · в очереди: ' + pending + ' действ.' : '');
      renderReport();
      renderOrders();
      renderReviews();
      if (current && redraw) openOrder(current.id, true);
    }).catch(function (e) {
      if (e.status === 401) { SB.signOut(); showLogin('Сессия истекла — войдите снова.'); return; }
      toast('Не получилось загрузить данные: ' + e.message);
    });
  }

  /* ---------------- отчёт ---------------- */
  function renderReport() {
    var o = data.orders, now = Date.now();
    var paidSum = data.payments.filter(function (p) { return p.status === 'confirmed'; })
      .reduce(function (s, p) { return s + (p.amount || 0); }, 0);
    var paidOrders = o.filter(function (x) { return x.paid > 0; });
    var avg = paidOrders.length ? paidOrders.reduce(function (s, x) { return s + (x.price || 0); }, 0) / paidOrders.length : null;
    var days = function (n) { return o.filter(function (x) { return now - new Date(x.created_at) < n * 864e5; }).length; };
    var count = function (list) { return o.filter(function (x) { return list.indexOf(x.status) !== -1; }).length; };
    var fromSite = o.filter(function (x) { return x.source === 'site'; }).length;
    var tiles = [
      ['Заказов всего', o.length, 'за 7 дней: ' + days(7) + ' · за 30: ' + days(30)],
      ['Оплачено', money(paidSum), 'подтверждённые оплаты'],
      ['Средний чек', avg ? money(avg) : '—', 'по оплаченным заказам'],
      ['Конверсия в оплату', o.length ? Math.round(100 * paidOrders.length / o.length) + '%' : '—', paidOrders.length + ' из ' + o.length],
      ['В работе', count(['in_work', 'review', 'awaiting_final']), 'в работе, на проверке, ждут доплаты'],
      ['Ждут оплаты', count(['awaiting_payment']), 'согласились с ценой'],
      ['Новые без цены', o.filter(function (x) { return x.status === 'new' && !x.price; }).length, 'нужно назначить цену'],
      ['С сайта / из бота', fromSite + ' / ' + (o.length - fromSite), 'источник заказа']
    ];
    $('#kpis').innerHTML = tiles.map(function (t) {
      return '<div class="kpi"><small>' + esc(t[0]) + '</small><b>' + esc(t[1]) + '</b><span>' + esc(t[2]) + '</span></div>';
    }).join('');

    // Выручка по месяцам (6 последних)
    var months = [], d = new Date();
    for (var i = 5; i >= 0; i--) {
      var m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      months.push({ key: m.getFullYear() + '-' + m.getMonth(), label: MONTHS[m.getMonth()], sum: 0 });
    }
    data.payments.forEach(function (p) {
      if (p.status !== 'confirmed') return;
      var t = new Date(p.confirmed_at || p.created_at);
      var k = t.getFullYear() + '-' + t.getMonth();
      months.forEach(function (mm) { if (mm.key === k) mm.sum += p.amount || 0; });
    });
    var max = Math.max.apply(null, months.map(function (mm) { return mm.sum; }).concat([1]));
    $('#revBars').innerHTML = months.map(function (mm) {
      var h = Math.max(1, Math.round(150 * mm.sum / max));
      return '<div class="vbar" tabindex="0" data-tip="' + esc(mm.label + ': ' + money(mm.sum)) + '">' +
        (mm.sum ? '<em>' + esc(shortMoney(mm.sum)) + '</em>' : '') + '<i style="height:' + h + 'px"></i></div>';
    }).join('');
    $('#revLabels').innerHTML = months.map(function (mm) { return '<span>' + mm.label + '</span>'; }).join('');

    // Заказы по типам
    var types = {};
    o.forEach(function (x) { var k = x.type_name || 'Другое'; types[k] = (types[k] || 0) + 1; });
    var rows = Object.keys(types).map(function (k) { return [k, types[k]]; }).sort(function (a, b) { return b[1] - a[1]; });
    var tmax = rows.length ? rows[0][1] : 1;
    $('#typeBars').innerHTML = rows.length ? rows.map(function (r) {
      return '<div class="hbar" tabindex="0" data-tip="' + esc(r[0] + ': ' + r[1] + ' заказ(ов)') + '">' +
        '<span class="hbar__name">' + esc(r[0]) + '</span>' +
        '<span class="hbar__track"><i style="width:' + Math.max(2, Math.round(100 * r[1] / tmax)) + '%"></i></span>' +
        '<b>' + r[1] + '</b></div>';
    }).join('') : '<p class="p-muted">Заказов пока нет</p>';

    // По админам
    var admins = {};
    o.forEach(function (x) {
      var k = x.admin_name || '— не взят';
      admins[k] = admins[k] || { n: 0, active: 0, paid: 0 };
      admins[k].n++;
      admins[k].paid += x.paid || 0;
      if (['done', 'cancelled'].indexOf(x.status) === -1) admins[k].active++;
    });
    $('#adminTable').innerHTML = '<thead><tr><th>Админ</th><th class="num">Заказов</th><th class="num">Активных</th><th class="num">Оплачено</th></tr></thead><tbody>' +
      Object.keys(admins).map(function (k) {
        var a = admins[k];
        return '<tr style="cursor:default"><td>' + esc(k) + '</td><td class="num" data-l="Заказов">' + a.n + '</td>' +
          '<td class="num" data-l="Активных">' + a.active + '</td><td class="num" data-l="Оплачено">' + money(a.paid) + '</td></tr>';
      }).join('') + '</tbody>';
  }

  function shortMoney(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс' : String(n);
  }

  // Подсказка при наведении / фокусе на столбец
  var tip = $('#tip');
  function showTip(el, x, y) {
    tip.textContent = el.getAttribute('data-tip');
    tip.hidden = false;
    var r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + 'px';
    tip.style.top = Math.max(8, y - r.height - 12) + 'px';
  }
  document.addEventListener('mousemove', function (e) {
    var el = e.target.closest && e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest && e.target.closest('[data-tip]');
    if (el) { var r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); }
  });
  document.addEventListener('focusout', function () { tip.hidden = true; });

  /* ---------------- заказы ---------------- */
  Object.keys(STATUS).forEach(function (s) {
    var opt = document.createElement('option');
    opt.value = s;
    opt.textContent = STATUS[s];
    $('#fStatus').appendChild(opt);
  });
  $('#q').addEventListener('input', renderOrders);
  $('#fStatus').addEventListener('change', renderOrders);

  function renderOrders() {
    var q = $('#q').value.trim().toLowerCase(), st = $('#fStatus').value;
    var list = data.orders.filter(function (o) {
      if (st && o.status !== st) return false;
      if (!q) return true;
      var hay = [o.code, o.client_name, o.client_username, o.type_name].concat((o.lines || []).map(function (l) { return l[2]; }))
        .join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    $('#ordersTable').innerHTML = '<thead><tr><th>Заказ</th><th>Клиент</th><th>Тип</th><th>Статус</th>' +
      '<th class="num">Цена</th><th class="num">Оплачено</th><th>Создан</th></tr></thead><tbody>' +
      (list.length ? list.map(function (o) {
        return '<tr data-id="' + o.id + '" tabindex="0"><td><b>#' + esc(o.code) + '</b></td>' +
          '<td data-l="Клиент">' + esc(o.client_name || '—') + '</td><td data-l="Тип">' + esc(o.type_name || '') + '</td>' +
          '<td>' + pill(o.status) + '</td><td class="num" data-l="Цена">' + money(o.price) + '</td>' +
          '<td class="num" data-l="Оплачено">' + money(o.paid) + '</td><td data-l="Создан">' + dt(o.created_at) + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="p-muted">Ничего не найдено</td></tr>') + '</tbody>';
  }
  $('#ordersTable').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (tr) openOrder(Number(tr.getAttribute('data-id')));
  });
  $('#ordersTable').addEventListener('keydown', function (e) {
    var tr = e.target.closest('tr[data-id]');
    if (tr && e.key === 'Enter') openOrder(Number(tr.getAttribute('data-id')));
  });

  /* ---------------- карточка заказа ---------------- */
  function openOrder(id, keepOpen) {
    var o = data.orders.filter(function (x) { return x.id === id; })[0];
    if (!o) return;
    current = o;
    var pays = data.payments.filter(function (p) { return p.order_id === id; });
    var files = data.files.filter(function (f) { return f.order_id === id; });
    var acts = data.actions.filter(function (a) { return a.order_id === id; }).slice(0, 15);
    var tg = o.client_username ? '@' + o.client_username : 'id ' + o.tg_user_id;
    var html =
      '<div class="drawer__head"><h2 class="p-title" style="margin:0">#' + esc(o.code) + '</h2>' +
      '<button type="button" class="icon-btn" id="closeDrawer" aria-label="Закрыть">✕</button></div>' +
      '<div class="section-box"><div class="p-row">' + pill(o.status) + '<span class="p-muted">' + esc(o.type_name || '') + '</span></div>' +
      '<dl class="kv"><dt>Клиент</dt><dd>' + esc(o.client_name || '—') + ' · <a href="' +
      (o.client_username ? 'https://t.me/' + esc(o.client_username) : 'tg://user?id=' + o.tg_user_id) +
      '" target="_blank" rel="noopener">' + esc(tg) + '</a></dd>' +
      '<dt>Цена</dt><dd>' + money(o.price) + (o.prepay && o.price && o.prepay < o.price ? ' (предоплата ' + money(o.prepay) + ')' : '') + '</dd>' +
      '<dt>Оплачено</dt><dd>' + money(o.paid) + '</dd><dt>Срок</dt><dd>' + esc(o.deadline_text || o.deadline || '—') + '</dd>' +
      '<dt>Ведёт</dt><dd>' + esc(o.admin_name || 'никто') + '</dd><dt>Источник</dt><dd>' + (o.source === 'site' ? '🌐 сайт' : '🤖 бот') + '</dd>' +
      '<dt>Создан</dt><dd>' + dt(o.created_at) + '</dd>' +
      (o.reject_reason ? '<dt>Отмена</dt><dd>' + esc(o.reject_reason) + '</dd>' : '') + '</dl></div>' +
      '<div class="section-box"><h4>Заявка</h4><ul class="o-lines">' + (o.lines || []).map(function (l) {
        return '<li><span>' + esc(l[0]) + '</span><span><b>' + esc(l[1]) + ':</b> ' + esc(l[2]) + '</span></li>';
      }).join('') + '</ul></div>' +
      // одна форма — всё уходит клиенту одним сообщением
      '<div class="section-box"><h4>📨 Отправить клиенту</h4><form id="fAll" class="send-all">' +
      (['new', 'awaiting_payment'].indexOf(o.status) !== -1 && !o.paid ?
        '<div class="p-row"><input class="input" type="number" min="1" step="1" name="price" placeholder="Цена, ₽" value="' + (o.price || '') + '" style="flex:1">' +
        '<input class="input" name="deadline" maxlength="60" placeholder="Срок: дата или «3 дня»" value="' + esc(o.deadline_text || '') + '" style="flex:1"></div>' :
        '<input class="input" name="deadline" maxlength="60" placeholder="Новый срок (если меняется)" value="">') +
      '<select class="input" name="status"><option value="">Статус — не менять (сейчас: ' + esc(STATUS[o.status] || o.status) + ')</option>' +
      MANUAL.filter(function (s) { return s !== o.status; }).map(function (s) { return '<option value="' + s + '">' + STATUS[s] + '</option>'; }).join('') +
      '</select>' +
      '<textarea class="input textarea" name="text" maxlength="3500" rows="3" placeholder="Сообщение клиенту (необязательно)"></textarea>' +
      '<label class="p-muted">📎 Готовая работа (необязательно, до 20 МБ на файл)<input class="input" type="file" name="files" multiple></label>' +
      '<button class="btn btn--primary">📨 Отправить всё клиенту</button>' +
      '<p class="p-muted">Заполните только то, что нужно, — клиент получит всё одним сообщением в Telegram и увидит в кабинете.' +
      (o.price && o.paid < o.price ? ' Готовая работа уйдёт после доплаты ' + money(o.price - o.paid) + '.' : '') + '</p></form>' +
      fileList(files.filter(function (f) { return f.kind === 'result'; })) + '</div>' +
      '<div class="section-box"><h4>💳 Оплаты</h4>' + (pays.length ? pays.map(function (p) {
        return '<div class="p-row"><b>' + money(p.amount) + '</b><span class="p-muted">' + (p.kind === 'final' ? 'доплата' : 'оплата') + ' · ' +
          ({ pending: 'проверяется', confirmed: 'подтверждена' + (p.confirmed_by ? ' (' + esc(p.confirmed_by) + ')' : ''), rejected: 'не найдена' }[p.status] || p.status) +
          ' · ' + dt(p.created_at) + '</span>' +
          (p.receipt_path ? '<button type="button" class="btn btn--ghost btn--sm js-sign" data-path="' + esc(p.receipt_path) + '">Чек</button>' : '') + '</div>';
      }).join('') : '<p class="p-muted">Оплат ещё не было</p>') + '</div>' +
      '<div class="section-box"><h4>📁 Файлы клиента</h4>' +
      (files.filter(function (f) { return f.kind === 'client'; }).map(function (f) {
        return '<button type="button" class="file-link js-sign" data-path="' + esc(f.path) + '" style="text-align:left">' + esc(f.name) + '</button>';
      }).join('') || '<p class="p-muted">Нет файлов</p>') + '</div>' +
      (acts.length ? '<div class="section-box"><h4>🕑 Действия с сайта</h4><div class="act-list">' + acts.map(function (a) {
        return '<div><span class="act-state" data-s="' + esc(a.state) + '">' + esc(STATE_NAME[a.state] || a.state) + '</span>' +
          '<b>' + esc(ACTION_NAME[a.action] || a.action) + '</b><span class="p-muted">' + dt(a.created_at) + ' · ' + esc(a.created_by || '') +
          (a.state === 'error' ? ' · ' + esc(a.result) : '') + '</span></div>';
      }).join('') + '</div></div>' : '');
    $('#drawerBox').innerHTML = html;
    bindDrawer(o);
    var dlg = $('#drawer');
    if (!dlg.open && !keepOpen) dlg.showModal();
  }

  function fileList(files) {
    if (!files.length) return '';
    return '<div class="files">' + files.map(function (f) {
      return '<a class="file-link" href="' + SB.publicUrl(f.bucket, f.path) + '" target="_blank" rel="noopener">' + esc(f.name) +
        (f.source === 'site' && !f.delivered ? ' · отправляется' : '') + '</a>';
    }).join('') + '</div>';
  }

  function bindDrawer(o) {
    $('#closeDrawer').addEventListener('click', function () { $('#drawer').close(); current = null; });
    var fa = $('#fAll');
    fa.addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {};
      var price = fa.price ? fa.price.value.trim() : '';
      if (price && Number(price) !== o.price) payload.price = Number(price);
      var deadline = fa.deadline.value.trim();
      if (deadline && (payload.price || deadline !== (o.deadline_text || ''))) payload.deadline = deadline;
      if (payload.price && !deadline) { toast('Укажите срок вместе с ценой'); return; }
      if (fa.status.value) payload.status = fa.status.value;
      var text = fa.text.value.trim();
      if (text) payload.text = text;
      var files = Array.prototype.slice.call(fa.files.files);
      var big = files.filter(function (f) { return f.size > 20 * 1024 * 1024; });
      if (big.length) { toast('Файлы больше 20 МБ Telegram не пропустит: ' + big.map(function (f) { return f.name; }).join(', ')); return; }
      if (!files.length && !Object.keys(payload).length) { toast('Заполните хотя бы одно поле'); return; }
      var btn = fa.querySelector('button');
      btn.disabled = true;
      btn.textContent = files.length ? 'Загружаю файлы…' : 'Отправляю…';
      var batch = files.length ? uuid() : null;
      if (batch) payload.batch = batch;
      files.reduce(function (p, f) {
        return p.then(function () {
          var path = randomHex(16) + '/' + safeName(f.name);
          return SB.upload('results', path, f).then(function () {
            return SB.insert('cloud_files', { id: uuid(), order_id: o.id, kind: 'result', name: f.name, bucket: 'results',
                                              path: path, size: f.size, source: 'site', delivered: false, batch: batch });
          });
        });
      }, Promise.resolve()).then(function () {
        return SB.insert('cloud_actions', { order_id: o.id, action: 'bundle', payload: payload });
      }).then(function () {
        toast('Отправлено! Клиент получит всё одним сообщением.');
        fa.reset();
        setTimeout(function () { loadAll(true); }, 2500); // бот выполняет за пару секунд — покажем результат
        return loadAll(true);
      }).catch(function (err) { toast('Не получилось: ' + err.message); })
        .then(function () { btn.disabled = false; btn.textContent = '📨 Отправить всё клиенту'; });
    });
    $$('.js-sign', $('#drawerBox')).forEach(function (b) {
      b.addEventListener('click', function () {
        var w = window.open('', '_blank');
        SB.signedUrl('private', b.getAttribute('data-path'), 600).then(function (u) {
          if (w) w.location = u; else location.href = u;
        }).catch(function (err) { if (w) w.close(); toast('Не открылся файл: ' + err.message); });
      });
    });
  }
  $('#drawer').addEventListener('close', function () { current = null; });
  $('#drawer').addEventListener('click', function (e) { if (e.target === $('#drawer')) $('#drawer').close(); });

  /* ---------------- отзывы ---------------- */
  function renderReviews() {
    var list = data.reviews;
    $('#reviewsList').innerHTML = list.length ? list.map(function (r) {
      var who = [r.university, r.work].filter(Boolean).map(esc).join(' · ');
      return '<article class="rv-card' + (r.approved ? '' : ' rv-card--hidden') + '" data-id="' + r.id + '">' +
        '<div class="p-row"><b>' + '★'.repeat(r.rating) + '<span class="rv-off">' + '★'.repeat(5 - r.rating) + '</span></b>' +
        '<span class="p-muted">' + dt(r.created_at) + (r.approved ? '' : ' · скрыт с сайта') + '</span></div>' +
        '<div><b>' + esc(r.name) + '</b>' + (who ? ' <span class="p-muted">' + who + '</span>' : '') + '</div>' +
        '<p class="rv-text">' + esc(r.message) + '</p>' +
        '<div class="p-row"><button type="button" class="btn btn--ghost btn--sm" data-rv="toggle">' +
        (r.approved ? '🙈 Скрыть' : '👁 Показать на сайте') + '</button>' +
        '<button type="button" class="btn btn--ghost btn--sm rv-del" data-rv="delete">🗑 Удалить</button></div></article>';
    }).join('') : '<p class="p-muted">Отзывов пока нет.</p>';
  }
  function noRights(rows) {
    if (rows && rows.length) return false;
    toast('Нет прав на отзывы. Выполните заново supabase-setup.sql в Supabase → SQL Editor.');
    return true;
  }
  $('#reviewsList').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-rv]');
    if (!b) return;
    var card = b.closest('[data-id]'), id = Number(card.getAttribute('data-id'));
    var r = data.reviews.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    if (b.getAttribute('data-rv') === 'delete') {
      if (!confirm('Удалить отзыв «' + r.name + '» навсегда?')) return;
      b.disabled = true;
      SB.remove('reviews', 'id=eq.' + id).then(function (rows) {
        if (noRights(rows)) return;
        toast('Отзыв удалён');
        loadAll();
      }, function (err) { toast('Не удалось удалить: ' + err.message); }).then(function () { b.disabled = false; });
      return;
    }
    b.disabled = true;
    SB.update('reviews', 'id=eq.' + id, { approved: !r.approved }).then(function (rows) {
      if (noRights(rows)) return;
      toast(r.approved ? 'Отзыв скрыт с сайта' : 'Отзыв снова на сайте');
      loadAll();
    }, function (err) { toast('Не получилось: ' + err.message); }).then(function () { b.disabled = false; });
  });

  /* ---------------- вкладки ---------------- */
  $$('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      $$('.tabs button').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      ['report', 'orders', 'reviews'].forEach(function (t) { $('#tab-' + t).hidden = b.getAttribute('data-tab') !== t; });
    });
  });

  setInterval(function () { if (!document.hidden && SB.session() && !$('#app').hidden) loadAll(); }, 30000);
  start();
})();
