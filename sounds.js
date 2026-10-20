/* ==========================================================================
   «Не Парься» — мягкие ASMR-звуки интерфейса
   Всё генерируется через Web Audio API, никаких аудиофайлов.
   Принципы: низкие частоты, плавный attack/release, lowpass-фильтр,
   случайная вариация тона ±4%, тихая громкость.
   AudioContext создаётся только после первого действия пользователя.
   ========================================================================== */

(function () {
  'use strict';

  var STORAGE_KEY = 'np-sound-v1';
  var ctx = null;        // AudioContext (создаётся лениво)
  var bus = null;        // общий фильтр, куда подключаются все звуки
  var master = null;     // общий регулятор громкости
  var noiseBuffer = null;
  var lastPlayed = {};   // защита от «дребезга» одинаковых звуков

  // Настройки по умолчанию: звук включён, громкость умеренная
  var settings = { enabled: true, volume: 0.55 };

  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (typeof saved.enabled === 'boolean') settings.enabled = saved.enabled;
      if (typeof saved.volume === 'number') settings.volume = Math.min(1, Math.max(0, saved.volume));
    }
  } catch (e) { /* localStorage недоступен — работаем с настройками по умолчанию */ }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* ничего страшного */ }
  }

  // Квадратичная кривая: так регулятор громкости ощущается естественнее
  function masterGain() {
    return settings.enabled ? Math.pow(settings.volume, 2) * 0.9 : 0;
  }

  // Создаём / возобновляем аудиоконтекст (только из обработчика действия пользователя)
  function ensureContext() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }

      // Общая цепочка: lowpass → компрессор → громкость → динамики
      bus = ctx.createBiquadFilter();
      bus.type = 'lowpass';
      bus.frequency.value = 2600;
      bus.Q.value = 0.4;

      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 20;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;

      master = ctx.createGain();
      master.gain.value = masterGain();

      bus.connect(comp);
      comp.connect(master);
      master.connect(ctx.destination);

      // Буфер белого шума для «деревянных» и «воздушных» призвуков
      noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
      var data = noiseBuffer.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Разблокировка звука по первому взаимодействию
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (evt) {
    window.addEventListener(evt, function unlock() {
      ensureContext();
    }, { once: true, passive: true, capture: true });
  });

  // Случайная вариация тона ±4%
  function vary(f, amount) {
    var a = amount == null ? 0.04 : amount;
    return f * (1 + (Math.random() * 2 - 1) * a);
  }

  /* Тональный «кирпичик»: осциллятор с огибающей и своим фильтром
     o.freq, o.to — начальная и конечная частоты
     o.dur — длительность, o.attack — атака, o.peak — громкость
     o.type — форма волны, o.at — задержка старта, o.lp — частота фильтра */
  function tone(o) {
    var t = ctx.currentTime + (o.at || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    var lp = ctx.createBiquadFilter();

    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || o.dur * 0.7));

    lp.type = 'lowpass';
    lp.frequency.value = o.lp || 1800;
    lp.Q.value = 0.3;

    var attack = o.attack || 0.006;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.peak || 0.3, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    osc.connect(lp);
    lp.connect(g);
    g.connect(bus);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  /* Шумовой «кирпичик»: короткий отфильтрованный шум
     o.filter — тип фильтра, o.freq — частота, o.to — свип частоты */
  function noise(o) {
    var t = ctx.currentTime + (o.at || 0);
    var src = ctx.createBufferSource();
    var f = ctx.createBiquadFilter();
    var g = ctx.createGain();

    src.buffer = noiseBuffer;
    f.type = o.filter || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
    f.Q.value = o.q || 1;

    var attack = o.attack || 0.003;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.peak || 0.1, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    src.connect(f);
    f.connect(g);
    g.connect(bus);
    src.start(t, Math.random() * 0.3);
    src.stop(t + o.dur + 0.05);
  }

  /* --- Библиотека звуков -------------------------------------------------- */
  var library = {
    // Лёгкий тап по дереву — обычные кнопки
    tap: function () {
      var f = vary(210);
      tone({ freq: f, to: f * 0.72, dur: 0.13, peak: 0.5, attack: 0.004, lp: 900 });
      tone({ freq: f * 2.45, to: f * 2.1, dur: 0.06, peak: 0.1, type: 'triangle', lp: 1600 });
      noise({ freq: vary(1100), q: 1.4, dur: 0.035, peak: 0.12 });
    },

    // Мягкий щелчок — навигация, мелкие действия
    click: function () {
      var f = vary(360);
      tone({ freq: f, to: f * 0.7, dur: 0.075, peak: 0.32, attack: 0.003, lp: 1400 });
      noise({ freq: vary(1700), q: 2, dur: 0.018, peak: 0.06 });
    },

    // «Поп» пузырька — выбор чипсов и карточек
    pop: function () {
      var f = vary(250);
      tone({ freq: f, to: f * 2.1, glide: 0.06, dur: 0.12, peak: 0.42, attack: 0.005, lp: 1500 });
      tone({ freq: f * 2.3, to: f * 2.7, dur: 0.07, peak: 0.05, at: 0.03, lp: 1800 });
    },

    // Переключатель: вверх — включение, вниз — выключение
    toggleOn: function () {
      var f = vary(300);
      tone({ freq: f, to: f * 0.8, dur: 0.06, peak: 0.28, lp: 1200 });
      tone({ freq: f * 1.33, to: f * 1.1, dur: 0.08, peak: 0.3, at: 0.055, lp: 1400 });
    },
    toggleOff: function () {
      var f = vary(400);
      tone({ freq: f, to: f * 0.8, dur: 0.06, peak: 0.28, lp: 1200 });
      tone({ freq: f * 0.75, to: f * 0.6, dur: 0.08, peak: 0.3, at: 0.055, lp: 1000 });
    },

    // Переход между шагами: мягкий «вжух» + низкий тон
    step: function () {
      noise({ filter: 'lowpass', freq: 280, to: 1300, q: 0.7, dur: 0.24, attack: 0.06, peak: 0.12 });
      var f = vary(220);
      tone({ freq: f, to: f * 1.35, dur: 0.22, attack: 0.03, peak: 0.2, lp: 900 });
    },

    // Успешная отправка: мягкое «маримба»-арпеджио
    success: function () {
      var base = vary(330, 0.03);
      [1, 1.26, 1.5, 2].forEach(function (k, i) {
        var at = i * 0.085;
        tone({ freq: base * k, dur: 0.55, peak: 0.24, attack: 0.008, at: at, lp: 1700 });
        tone({ freq: base * k * 2, dur: 0.18, peak: 0.04, type: 'triangle', attack: 0.006, at: at, lp: 2200 });
      });
    },

    // Смена темы: плавное скольжение тона (вверх в день, вниз в ночь)
    themeLight: function () {
      var f = vary(280);
      tone({ freq: f, to: f * 1.5, dur: 0.45, attack: 0.03, peak: 0.22, lp: 1500 });
      noise({ freq: 1900, q: 3, dur: 0.3, attack: 0.08, peak: 0.025 });
    },
    themeDark: function () {
      var f = vary(420);
      tone({ freq: f, to: f * 0.66, dur: 0.5, attack: 0.03, peak: 0.22, lp: 1100 });
      noise({ filter: 'lowpass', freq: 900, to: 300, q: 0.6, dur: 0.35, attack: 0.05, peak: 0.05 });
    },

    // Едва слышный тик — слайдеры
    tick: function () {
      tone({ freq: vary(520, 0.02), dur: 0.03, peak: 0.07, attack: 0.002, lp: 1200 });
    },

    // Мягкий «тук-тук» — ошибка валидации (без резкости)
    error: function () {
      tone({ freq: 170, to: 150, dur: 0.12, peak: 0.35, lp: 700 });
      tone({ freq: 150, to: 130, dur: 0.14, peak: 0.3, at: 0.11, lp: 700 });
    }
  };

  // Минимальный интервал между одинаковыми звуками (мс)
  var GAP = { tick: 45, default: 35 };

  function play(name) {
    if (!settings.enabled || settings.volume <= 0) return;
    var fn = library[name];
    if (!fn) return;
    var now = performance.now();
    var gap = GAP[name] || GAP.default;
    if (lastPlayed[name] && now - lastPlayed[name] < gap) return;
    lastPlayed[name] = now;
    if (!ensureContext()) return;
    try { fn(); } catch (e) { /* звук — не критичная функция */ }
  }

  function applyGain() {
    if (master && ctx) master.gain.setTargetAtTime(masterGain(), ctx.currentTime, 0.03);
  }

  // Публичное API
  window.Sound = {
    play: play,
    isEnabled: function () { return settings.enabled; },
    getVolume: function () { return settings.volume; },
    setEnabled: function (on) {
      settings.enabled = !!on;
      persist();
      applyGain();
    },
    setVolume: function (v) {
      settings.volume = Math.min(1, Math.max(0, v));
      persist();
      applyGain();
    }
  };
})();
