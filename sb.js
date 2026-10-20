/* ==========================================================================
   «Не Парься» — маленький клиент Supabase для кабинета и админ-панели.
   Без внешних библиотек: база (REST), вход админа по паролю, файлы (Storage).
   Адрес и публичный ключ берутся из config.js → supabase.
   ========================================================================== */

(function () {
  'use strict';

  var CFG = (window.SITE_CONFIG && window.SITE_CONFIG.supabase) || {};
  var URL_ = String(CFG.url || '').trim().replace(/\/+$/, '');
  var KEY = String(CFG.key || '').trim();
  var SESSION_KEY = 'np-admin-session';
  var session = null;

  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }

  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* без запоминания входа */ }
  }

  function headers(extra, auth) {
    var h = { apikey: KEY };
    if (auth && session && session.access_token) h.Authorization = 'Bearer ' + session.access_token;
    else if (/^eyJ/.test(KEY)) h.Authorization = 'Bearer ' + KEY; // старый формат anon-ключа
    for (var k in extra || {}) h[k] = extra[k];
    return h;
  }

  function check(r) {
    if (r.ok) return r.status === 204 ? null : r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    return r.text().then(function (t) {
      var err = new Error('HTTP ' + r.status);
      err.status = r.status;
      try { var j = JSON.parse(t); err.message = j.msg || j.message || j.error_description || j.error || err.message; } catch (e) { /* текст как есть */ }
      throw err;
    });
  }

  // Токен входа живёт час — обновляем заранее
  function ensureFresh() {
    if (!session || !session.refresh_token) return Promise.resolve();
    if (session.expires_at && Date.now() / 1000 < session.expires_at - 60) return Promise.resolve();
    return fetch(URL_ + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(check).then(storeAuth).catch(function (e) { saveSession(null); throw e; });
  }

  function storeAuth(j) {
    saveSession({
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      email: (j.user && j.user.email) || (session && session.email) || ''
    });
    return session;
  }

  function rest(method, path, opts) {
    opts = opts || {};
    return ensureFresh().then(function () {
      var h = headers({ 'Content-Type': 'application/json' }, opts.auth !== false);
      if (opts.prefer) h.Prefer = opts.prefer;
      return fetch(URL_ + '/rest/v1/' + path, {
        method: method, headers: h, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
      });
    }).then(check);
  }

  window.SB = {
    enabled: !!(URL_ && KEY),
    url: URL_,
    session: function () { return session; },

    signIn: function (email, password) {
      return fetch(URL_ + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ email: email, password: password })
      }).then(check).then(storeAuth);
    },
    signOut: function () { saveSession(null); },

    select: function (table, query) { return rest('GET', table + (query ? '?' + query : '')); },
    insert: function (table, row) { return rest('POST', table, { body: row, prefer: 'return=representation' }); },
    rpc: function (name, args, opts) { return rest('POST', 'rpc/' + name, { body: args || {}, auth: !(opts && opts.anon) }); },
    insertAnon: function (table, row) { return rest('POST', table, { body: row, prefer: 'return=minimal', auth: false }); },

    upload: function (bucket, path, file) {
      return ensureFresh().then(function () {
        return fetch(URL_ + '/storage/v1/object/' + bucket + '/' + encodePath(path), {
          method: 'POST', headers: headers({ 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'false' }, true),
          body: file
        });
      }).then(check);
    },
    signedUrl: function (bucket, path, seconds) {
      return ensureFresh().then(function () {
        return fetch(URL_ + '/storage/v1/object/sign/' + bucket + '/' + encodePath(path), {
          method: 'POST', headers: headers({ 'Content-Type': 'application/json' }, true),
          body: JSON.stringify({ expiresIn: seconds || 3600 })
        });
      }).then(check).then(function (j) {
        var u = j.signedURL || j.signedUrl || '';
        return /^https?:/.test(u) ? u : URL_ + '/storage/v1' + u;
      });
    },
    publicUrl: function (bucket, path) { return URL_ + '/storage/v1/object/public/' + bucket + '/' + encodePath(path); }
  };

  function encodePath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }
})();
