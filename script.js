(function () {
  'use strict';

  var API = {
    USD: { all: 'https://ve.dolarapi.com/v1/dolares', one: 'https://ve.dolarapi.com/v1/dolares/oficial' },
    EUR: { all: 'https://ve.dolarapi.com/v1/euros',   one: 'https://ve.dolarapi.com/v1/euros/oficial' }
  };
  var RATE_KEY = 'bcv_rates_v4', HIST_KEY = 'calc_history_v4', DAYS_KEY = 'bcv_rate_days', WAKE_KEY = 'keep_awake';
  var MAX_DIGITS = 15, MAX_LEN = 60, MAX_HIST = 100, MAX_DAYS = 90;
  var SYM = { USD: '$', EUR: '€' };
  var NAME = { USD: 'Dólares (USD)', EUR: 'Euros (EUR)' };
  var THEME_KEY = 'calc_theme';
  var THEMES = { purple: '#f5f0ff', green: '#effaf3', blue: '#eef5ff', orange: '#fff6ed', pink: '#fff0f6' };

  // ---------- Estado ----------
  var page = 'home';            // 'home' | 'calc' | 'cur'
  var cur = 'USD';              // moneda de la pestaña de conversión
  var dir = 'VES';              // 'VES' = de Bs a divisa · 'FX' = de divisa a Bs
  function blank() { return { expr: '', hist: '', just: false, err: '' }; }
  function newRate() { return { v: null, p: null, date: '', iso: '', src: 'none' }; }
  var S = { calc: blank(), cur: blank() };
  var R = { USD: newRate(), EUR: newRate() };
  var log = [], lastLogged = '', days = {}, keepOn = false, wake = null, toastT = null, logT = null;

  var $ = function (id) { return document.getElementById(id); };
  var elMenu = $('menu'), elModal = $('rateModal');
  var elRateInput = $('rateInput'), elRateError = $('rateError');

  // Solo toca el DOM si el texto cambió
  function setT(el, t) { if (el.textContent !== t) el.textContent = t; }

  var MODE_KEY = 'calc_mode', mode = 'auto';
  var NATIVE_OK = { App: 1, Share: 1, Clipboard: 1, SystemBars: 1 };
  function plug(n) {
    var C = window.Capacitor;
    if (!C) return null;
    if (C.Plugins && C.Plugins[n]) return C.Plugins[n];
    return (NATIVE_OK[n] && C.isNativePlatform && C.isNativePlatform() && C.registerPlugin) ? C.registerPlugin(n) : null;
  }
  function isDark() { return mode === 'dark' || (mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches); }
  function paintBars() {
    var t = document.documentElement.getAttribute('data-theme') || 'purple', col = isDark() ? '#120f1c' : THEMES[t];
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', col);
    var SY = plug('SystemBars');
    if (SY) { try { SY.setStyle({ style: isDark() ? 'DARK' : 'LIGHT' }); } catch (e) {} }
    var SB = plug('StatusBar');
    if (SB) { try { SB.setBackgroundColor({ color: col }); SB.setStyle({ style: isDark() ? 'DARK' : 'LIGHT' }); } catch (e) {} }
  }
  function applyMode(m, save) {
    if (m !== 'light' && m !== 'dark') m = 'auto';
    mode = m;
    document.documentElement.setAttribute('data-mode', isDark() ? 'dark' : 'light');
    var bs = document.querySelectorAll('[data-m]');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-m') === m);
    paintBars();
    if (save) { try { localStorage.setItem(MODE_KEY, m); } catch (e) {} }
  }
  function applyTheme(t, save) {
    if (!THEMES[t]) t = 'purple';
    document.documentElement.setAttribute('data-theme', t);
    paintBars();
    var btns = document.querySelectorAll('.theme-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-t') === t);
    if (save) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} }
  }

  // ---------- Formato es-VE ----------
  function addThousands(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function fmt(n, d) {
    if (!isFinite(n) || Math.abs(n) >= 1e18) return '—';
    var p = Math.abs(n).toFixed(d).split('.');
    var out = addThousands(p[0]) + (p[1] ? ',' + p[1] : '');
    return (n < 0 && /[1-9]/.test(out)) ? '-' + out : out;
  }
  function pretty(s) {
    if (!s) return '0';
    return s
      .replace(/\d+(\.\d*)?/g, function (m) {
        var p = m.split('.');
        return addThousands(p[0]) + (p.length > 1 ? ',' + p[1] : '');
      })
      .replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/\+/g, ' + ')
      .replace(/([\d,)%])-/g, '$1 − ')
      .replace(/^-/, '−');
  }
  function gap(o, p) { var g = (p / o - 1) * 100; return (g > 0 ? '+' : '') + fmt(g, 1) + '%'; }

  // ---------- Motor matemático (sin eval) ----------
  function evaluate(src) {
    var s = src;
    while (/[-+*\/.(]$/.test(s)) s = s.slice(0, -1);
    if (!s) return 0;
    var open = (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;
    while (open-- > 0) s += ')';
    var pos = 0;
    function peek() { return s.charAt(pos); }
    function nan() { return new Error('NAN'); }
    function expr() {
      var v = term();
      while (peek() === '+' || peek() === '-') {
        var o = s.charAt(pos++), r = term();
        if (s.charAt(pos - 1) === '%') r = v * r;
        v = o === '+' ? v + r : v - r;
      }
      return v;
    }
    function term() {
      var v = unary();
      while (peek() === '*' || peek() === '/') {
        var o = s.charAt(pos++), r = unary();
        if (o === '/') { if (r === 0) throw new Error('DIV0'); v /= r; } else v *= r;
      }
      return v;
    }
    function unary() {
      if (peek() === '-') { pos++; return -unary(); }
      var v = prim();
      while (peek() === '%') { pos++; v /= 100; }
      return v;
    }
    function prim() {
      if (peek() === '(') {
        pos++;
        var v = expr();
        if (peek() !== ')') throw nan();
        pos++;
        return v;
      }
      var m = /^[0-9]*\.?[0-9]*/.exec(s.slice(pos))[0];
      if (!m || m === '.') throw nan();
      pos += m.length;
      return parseFloat(m);
    }
    var res = expr();
    if (pos < s.length) throw nan();
    if (isNaN(res)) throw nan();
    if (!isFinite(res) || Math.abs(res) >= 1e15) throw new Error('OVF');
    return res;
  }
  function toPlain(x) {
    x = parseFloat(x.toPrecision(12));
    var s = x.toFixed(10).replace(/\.?0+$/, '');
    return (s === '-0' || s === '') ? '0' : s;
  }

  // ---------- Almacenamiento ----------
  function readJson(key, fallback) {
    try { var o = JSON.parse(localStorage.getItem(key)); return o || fallback; } catch (e) { return fallback; }
  }
  function writeJson(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  // ---------- Tasas ----------
  function apiDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear();
  }
  function saveCache() {
    var o = readJson(RATE_KEY, {});
    ['USD', 'EUR'].forEach(function (k) {
      var c = R[k];
      if (c.v && c.src === 'api') o[k] = { v: c.v, p: c.p, date: c.date, iso: c.iso };
    });
    writeJson(RATE_KEY, o);
  }
  function loadCache(k) {
    var o = readJson(RATE_KEY, {})[k];
    if (!o || !(o.v > 0)) return false;
    var c = R[k];
    c.v = o.v; c.p = o.p > 0 ? o.p : null; c.date = o.date || ''; c.iso = o.iso || ''; c.src = 'cached';
    return true;
  }
  function statusText(k) {
    var c = R[k], r = c.v ? fmt(c.v, 2) : '';
    if (c.src === 'api') return 'Tasa BCV oficial: Bs. ' + r;
    if (c.src === 'cached') return 'Sin conexión · última tasa' + (c.date ? ' (' + c.date + ')' : '') + ': Bs. ' + r;
    if (c.src === 'manual') return 'Modo manual: Bs. ' + r;
    if (c.src === 'dated') return 'Tasa del ' + c.date + ': Bs. ' + r;
    return 'Sin tasa · toca "Editar tasa"';
  }
  function setChip(el, k) {
    var t = statusText(k), s = R[k].src;
    if (el.textContent !== t) el.textContent = t;
    if (el.getAttribute('data-state') !== s) el.setAttribute('data-state', s);
  }

  function pick(list, name) {
    if (!list || !list.length) return null;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].fuente === name) return list[i];
    return null;
  }
  function val(o) {
    if (!o) return null;
    var v = parseFloat(o.promedio != null ? o.promedio : o.venta != null ? o.venta : o.compra);
    return isFinite(v) && v > 0 ? v : null;
  }
  async function getJson(url, ctrl) {
    var r = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  async function loadRate(k, ctrl) {
    var o = null, p = null, upd = '';
    try {
      var list = await getJson(API[k].all, ctrl);
      var ob = pick(list, 'oficial');
      o = val(ob); p = val(pick(list, 'paralelo')); upd = (ob && ob.fechaActualizacion) || '';
    } catch (e) { /* se intenta el endpoint oficial */ }
    if (!o) {
      try {
        var one = await getJson(API[k].one, ctrl);
        o = val(one); p = null; upd = (one && one.fechaActualizacion) || '';
      } catch (e2) { /* sin respuesta */ }
    }
    if (!o) return false;
    var c = R[k];
    c.v = o; c.p = p; c.iso = upd; c.date = upd ? apiDate(upd) : ''; c.src = 'api';
    return true;
  }

  async function fetchRates() {
    $('homeStatus').textContent = 'Obteniendo tasas…';
    $('homeStatus').hidden = false;
    $('homeStatus').setAttribute('data-state', 'loading');
    $('curStatus').textContent = 'Obteniendo tasas…';
    $('curStatus').setAttribute('data-state', 'loading');
    ['USD', 'EUR'].forEach(function (k) {
      var c = R[k];
      if (c.src === 'manual' || c.src === 'dated') { c.v = null; c.p = null; c.src = 'none'; }
    });
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 10000);
    var res = [false, false];
    try { res = await Promise.all([loadRate('USD', ctrl), loadRate('EUR', ctrl)]); }
    catch (e) { /* se usa la caché */ }
    clearTimeout(timer);
    ['USD', 'EUR'].forEach(function (k, i) {
      if (!res[i]) {
        var c = R[k];
        if (!c.v) loadCache(k);
        c.src = c.v ? 'cached' : 'none';
      }
    });
    if (res[0]) saveDay(R.USD.iso);
    saveCache();
    render();
    return res[0] || res[1];
  }

  // ---------- Tasas por fecha ----------
  function dayKey(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var z = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function dayLabel(k) { var p = k.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function saveDay(iso) {
    days[dayKey(iso)] = { o: R.USD.v, p: R.USD.p, e: R.EUR.v };
    var keys = Object.keys(days).sort().reverse();
    for (var i = MAX_DAYS; i < keys.length; i++) delete days[keys[i]];
    writeJson(DAYS_KEY, days);
  }
  function renderRates() {
    var box = $('ratesList');
    box.innerHTML = '';
    var keys = Object.keys(days).sort().reverse();
    if (!keys.length) {
      var e = document.createElement('p');
      e.className = 'hist-empty';
      e.textContent = 'Las tasas se guardan cada vez que abres la app con internet.';
      box.appendChild(e);
      return;
    }
    keys.forEach(function (k) {
      var d = days[k];
      var row = document.createElement('div'); row.className = 'hist-item';
      var a = document.createElement('div'); a.className = 'hist-a'; a.textContent = dayLabel(k);
      var b = document.createElement('div'); b.className = 'hist-b'; b.textContent = 'Dólar Bs. ' + fmt(d.o, 2);
      var m = document.createElement('div'); m.className = 'hist-m';
      var parts = [];
      if (d.e) parts.push('Euro Bs. ' + fmt(d.e, 2));
      if (d.p) parts.push('Paralelo Bs. ' + fmt(d.p, 2) + ' (' + gap(d.o, d.p) + ')');
      m.textContent = parts.join(' · ');
      row.appendChild(a); row.appendChild(b); row.appendChild(m);
      row.addEventListener('click', function () { useDay(k); });
      box.appendChild(row);
    });
  }
  function useDay(k) {
    var d = days[k];
    if (!d || !(d.o > 0)) return;
    var lbl = dayLabel(k);
    R.USD.v = d.o; R.USD.p = d.p > 0 ? d.p : null; R.USD.date = lbl; R.USD.src = 'dated';
    if (d.e > 0) { R.EUR.v = d.e; R.EUR.p = null; R.EUR.date = lbl; R.EUR.src = 'dated'; }
    $('ratesPanel').hidden = true;
    page = 'cur';
    toast('Usando la tasa del ' + lbl);
    render();
  }

  // ---------- Historial ----------
  function pushHist(item) {
    log.unshift(item);
    if (log.length > MAX_HIST) log.length = MAX_HIST;
    writeJson(HIST_KEY, log);
  }
  function fmtDate(ts) {
    var d = new Date(ts), z = function (n) { return ('0' + n).slice(-2); };
    return z(d.getDate()) + '/' + z(d.getMonth() + 1) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  }
  function renderHist() {
    var box = $('histList');
    box.innerHTML = '';
    if (!log.length) {
      var e = document.createElement('p');
      e.className = 'hist-empty';
      e.textContent = 'Aún no hay operaciones.';
      box.appendChild(e);
      return;
    }
    log.forEach(function (it) {
      var row = document.createElement('div'); row.className = 'hist-item';
      var a = document.createElement('div'); a.className = 'hist-a';
      var b = document.createElement('div'); b.className = 'hist-b';
      var m = document.createElement('div'); m.className = 'hist-m';
      if (it.t === 'fx') {
        var tag = document.createElement('span'); tag.className = 'hist-tag';
        tag.textContent = it.c === 'EUR' ? 'Euro' : 'Dólar';
        a.appendChild(tag); a.appendChild(document.createTextNode(it.a));
        b.textContent = '= ' + it.b;
        m.textContent = 'Tasa BCV ' + fmt(it.r, 2) + ' · ' + fmtDate(it.d);
      } else {
        a.textContent = it.a; b.textContent = it.b; m.textContent = fmtDate(it.d);
      }
      row.appendChild(a); row.appendChild(b); row.appendChild(m);
      row.addEventListener('click', function () { reuse(it); });
      box.appendChild(row);
    });
  }
  function reuse(it) {
    var st;
    if (it.t === 'fx') {
      if (it.v == null) return;
      page = 'cur'; cur = it.c === 'EUR' ? 'EUR' : 'USD'; dir = it.dir === 'FX' ? 'FX' : 'VES';
      st = S.cur; st.expr = String(it.v);
    } else {
      if (it.p == null) return;
      page = 'calc'; st = S.calc; st.expr = String(it.p);
    }
    st.hist = ''; st.err = ''; st.just = true;
    $('histPanel').hidden = true;
    render();
  }
  function logConversion() {
    var c = R[cur], v;
    try { v = evaluate(S.cur.expr); } catch (e) { return; }
    if (!(v > 0) || !c.v) return;
    var fx = dir === 'FX', out = fx ? v * c.v : v / c.v;
    var a = (fx ? SYM[cur] + ' ' : 'Bs. ') + fmt(v, 2);
    var b = (fx ? 'Bs. ' : SYM[cur] + ' ') + fmt(out, 2);
    var key = a + b + c.v + cur;
    if (key === lastLogged) return;
    lastLogged = key;
    pushHist({ t: 'fx', c: cur, a: a, b: b, r: c.v, d: Date.now(), dir: dir, v: toPlain(v) });
  }

  // ---------- Render ----------
  function fit(el, big, small) {
    var size = window.innerHeight <= 640 ? small : big;
    if (!el._w) el._w = el.clientWidth;
    var len = el.textContent.length;
    if (el._w && len) size = Math.min(size, Math.max(16, Math.floor(el._w / (len * 0.64))));
    var px = size + 'px';
    if (el.style.fontSize !== px) el.style.fontSize = px;
  }

  // Variación frente al último día guardado anterior
  function setVar(id, v, field) {
    var el = $(id), keys = Object.keys(days).sort().reverse(), today = dayKey(R.USD.iso), t = '', dirn = '';
    for (var i = 0; v && i < keys.length; i++) {
      var prev = days[keys[i]][field];
      if (keys[i] < today && prev > 0) {
        var g = (v / prev - 1) * 100;
        if (Math.abs(g) >= 0.005) { t = (g > 0 ? '▲ +' : '▼ ') + fmt(g, 2) + '%'; dirn = g > 0 ? 'up' : 'down'; }
        break;
      }
    }
    setT(el, t); el.setAttribute('data-dir', dirn);
  }

  function renderHome() {
    var u = R.USD, e = R.EUR;
    $('dolarVal').textContent = u.v ? 'Bs. ' + fmt(u.v, 2) : '—';
    $('dolarPar').textContent = (u.v && u.p) ? 'Paralelo: Bs. ' + fmt(u.p, 2) + ' · brecha ' + gap(u.v, u.p) : '';
    $('euroVal').textContent = e.v ? 'Bs. ' + fmt(e.v, 2) : '—';
    $('euroPar').textContent = (e.v && e.p) ? 'Paralelo: Bs. ' + fmt(e.p, 2) + ' · brecha ' + gap(e.v, e.p) : '';
    setVar('dolarVar', u.v, 'o'); setVar('euroVar', e.v, 'e');
    var age = u.iso ? Math.floor((Date.now() - new Date(u.iso)) / 864e5) : 0;
    $('updText').textContent = 'Última actualización: ' + (u.date || e.date || 'sin datos') + (age >= 4 ? ' · hace ' + age + ' días' : '');
    setChip($('homeStatus'), u.v ? 'USD' : (e.v ? 'EUR' : 'USD'));
    $('homeStatus').hidden = (u.v ? u : e).src === 'api';
  }

  function renderCalc() {
    var st = S.calc, m = $('cMain'), sub = $('cSub');
    setT($('cHist'), st.hist);
    if (st.err) {
      m.classList.add('error'); m.style.fontSize = ''; m._w = 0; setT(m, st.err); setT(sub, '');
      return;
    }
    m.classList.remove('error');
    setT(m, pretty(st.expr));
    fit(m, 56, 40);
    var v;
    try { v = evaluate(st.expr); } catch (e) { v = null; }
    var hasOp = /[-+*\/()%]/.test(st.expr.replace(/^-/, ''));
    setT(sub, (hasOp && !st.just && v !== null) ? pretty(toPlain(v)) : '');
  }

  function renderCur() {
    var st = S.cur, c = R[cur], fx = dir === 'FX';
    var m = $('uMain'), out = $('uOut'), alt = $('uAlt');
    setT($('inTag'), fx ? SYM[cur] : 'Bs.');
    setT($('inName'), fx ? NAME[cur] : 'Bolívares (VES)');
    setT($('outTag'), fx ? 'Bs.' : SYM[cur]);
    setT($('outName'), fx ? 'Bolívares (VES)' : NAME[cur]);
    $('swapBtn').classList.toggle('flip', fx);
    setChip($('curStatus'), cur);
    setT($('uHist'), st.hist);
    setT(alt, '');
    if (st.err) {
      m.classList.add('error'); m.style.fontSize = ''; m._w = 0; setT(m, st.err); setT(out, '—');
      return;
    }
    m.classList.remove('error');
    setT(m, pretty(st.expr));
    fit(m, 38, 30);
    var v;
    try { v = evaluate(st.expr); } catch (e) { v = null; }
    if (!c.v) setT(out, 'Sin tasa');
    else if (v === null) setT(out, '—');
    else {
      setT(out, fmt(fx ? v * c.v : v / c.v, 2));
      if (c.p) setT(alt, 'Paralelo: ' + (fx ? 'Bs. ' + fmt(v * c.p, 2) : SYM[cur] + ' ' + fmt(v / c.p, 2)));
    }
  }

  function render() {
    $('pgHome').hidden = page !== 'home';
    $('pgCalc').hidden = page !== 'calc';
    $('pgCur').hidden = page !== 'cur';
    $('keypad').hidden = page === 'home';
    ['home', 'calc', 'cur'].forEach(function (k) {
      $('nav' + k.charAt(0).toUpperCase() + k.slice(1)).classList.toggle('active', page === k);
    });
    $('navCurLbl').textContent = cur === 'USD' ? 'Calculadora dólar' : 'Calculadora euro';
    $('navSym').textContent = SYM[cur];
    $('curSwitch').textContent = cur === 'USD' ? 'Calcular a tasa euro' : 'Calcular a tasa dólar';
    $('curSwitch').hidden = page !== 'cur';
    $('wakeBtn').textContent = 'Pantalla encendida: ' + (keepOn ? 'Sí' : 'No');
    if (page === 'home') renderHome();
    else if (page === 'calc') renderCalc();
    else renderCur();
  }

  function renderView() {
    if (page === 'calc') renderCalc();
    else if (page === 'cur') renderCur();
  }

  // ---------- Teclado ----------
  function isOp(c) { return c !== '' && '+-*/'.indexOf(c) !== -1; }
  function isValEnd(c) { return /[0-9.)%]/.test(c); }

  function handleKey(key) {
    if (page === 'home') return;
    var st = S[page];
    var last = st.expr.charAt(st.expr.length - 1);
    var curNum = (st.expr.match(/[0-9.]*$/) || [''])[0];

    if (st.err) {
      st.err = ''; st.expr = ''; st.hist = ''; st.just = false;
      if (key === 'AC' || key === 'DEL') return renderView();
      last = ''; curNum = '';
    }

    if (/^[0-9]$/.test(key) || key === '.') {
      if (st.just) { st.expr = ''; st.hist = ''; st.just = false; last = ''; curNum = ''; }
      if (st.expr.length >= MAX_LEN) return;
      if (last === ')' || last === '%') { st.expr += '*'; curNum = ''; }
      if (key === '.') {
        if (curNum.indexOf('.') !== -1) return;
        st.expr += curNum === '' ? '0.' : '.';
      } else {
        if (curNum.replace('.', '').length >= MAX_DIGITS) return;
        if (curNum === '0') st.expr = st.expr.slice(0, -1) + key; else st.expr += key;
      }

    } else if (isOp(key)) {
      st.just = false;
      if (st.expr === '' || last === '(') {
        if (key === '-') st.expr += '-';
        return renderView();
      }
      if (st.expr === '-') return;
      if (last === '.') { st.expr = st.expr.slice(0, -1); last = st.expr.charAt(st.expr.length - 1); }
      if (isOp(last)) {
        st.expr = st.expr.slice(0, -1);
        if (st.expr === '' || st.expr.slice(-1) === '(') { if (key === '-') st.expr += '-'; return renderView(); }
      }
      if (st.expr.length >= MAX_LEN) return;
      st.expr += key;

    } else if (key === '()') {
      if (st.just) { st.just = false; st.hist = ''; }
      if (st.expr.length >= MAX_LEN) return;
      var open = (st.expr.match(/\(/g) || []).length - (st.expr.match(/\)/g) || []).length;
      if (open > 0 && isValEnd(last)) st.expr += ')';
      else if (isValEnd(last)) st.expr += '*(';
      else st.expr += '(';

    } else if (key === '%') {
      if (!isValEnd(last) || last === '.') return;
      st.just = false;
      st.expr += '%';

    } else if (key === '=') {
      if (st.expr === '' || st.just) { if (page === 'cur') logConversion(); return; }
      try {
        var res = evaluate(st.expr);
        st.hist = pretty(st.expr.replace(/[-+*\/.(]+$/, '')) + ' =';
        if (page === 'calc') {
          pushHist({ t: 'calc', a: st.hist.replace(/ =$/, ''), b: '= ' + pretty(toPlain(res)), d: Date.now(), p: toPlain(res) });
        }
        st.expr = toPlain(res);
        st.just = true;
        if (page === 'cur') logConversion();
      } catch (e) {
        st.err = e.message === 'DIV0' ? 'No se puede dividir entre 0'
               : e.message === 'OVF' ? 'Número demasiado grande'
               : 'Formato incorrecto';
      }

    } else if (key === 'DEL') {
      st.just = false; st.hist = '';
      st.expr = st.expr.slice(0, -1);

    } else if (key === 'AC') {
      st.expr = ''; st.hist = ''; st.just = false;
    }
    renderView();
    if (page === 'cur') { clearTimeout(logT); logT = setTimeout(logConversion, 2000); }
  }

  // ---------- Modal tasa manual ----------
  function openModal() {
    elRateError.textContent = '';
    $('rateTitle').textContent = 'Tasa manual (Bs. por ' + cur + ')';
    elRateInput.value = R[cur].v ? fmt(R[cur].v, 2) : '';
    elRateInput.setAttribute('data-shown', elRateInput.value);
    elModal.hidden = false;
    setTimeout(function () { elRateInput.focus(); }, 50);
  }
  function closeModal() { elModal.hidden = true; elRateInput.blur(); }
  function parseRate(str) {
    var s = str.replace(/\s/g, '');
    if (s.indexOf(',') !== -1 || /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    var v = parseFloat(s);
    return isFinite(v) && v > 0 ? v : null;
  }
  function saveManual() {
    var v = (R[cur].v && elRateInput.value === elRateInput.getAttribute('data-shown')) ? R[cur].v : parseRate(elRateInput.value);
    if (!v) { elRateError.textContent = 'Ingresa una tasa válida mayor a 0.'; return; }
    var c = R[cur];
    c.v = v; c.p = null; c.date = ''; c.iso = ''; c.src = 'manual';
    saveCache(); closeModal(); render();
  }

  // ---------- Copiar, compartir, avisos ----------
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, 1800);
  }
  function legacyCopy(txt) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;-webkit-user-select:text;user-select:text;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, txt.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function copyText(txt) {
    var CP = plug('Clipboard');
    if (CP) { try { return CP.write({ string: txt }).then(function () { return true; }, function () { return false; }); } catch (e) {} }
    if (legacyCopy(txt)) return Promise.resolve(true);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(txt).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }
  function ratesText() {
    var t = 'Tasa BCV';
    if (R.USD.v) t += '\nDólar: Bs. ' + fmt(R.USD.v, 2);
    if (R.EUR.v) t += '\nEuro: Bs. ' + fmt(R.EUR.v, 2);
    var d = R.USD.date || R.EUR.date;
    if (d) t += '\nActualización: ' + d;
    return t;
  }
  function copyValue() {
    var txt = '';
    if (page === 'calc') {
      if (S.calc.err) { toast('No hay resultado para copiar'); return; }
      txt = $('cSub').textContent || $('cMain').textContent;
    } else if (page === 'cur') {
      var o = $('uOut').textContent;
      if (S.cur.err || !R[cur].v || !/\d/.test(o)) { toast('No hay monto para copiar'); return; }
      txt = (dir === 'FX' ? 'Bs. ' : SYM[cur] + ' ') + o;
    } else return;
    copyText(txt).then(function (ok) {
      if (ok && navigator.vibrate) { try { navigator.vibrate(25); } catch (e) {} }
      toast(ok ? 'Copiado: ' + txt : 'No se pudo copiar');
    });
  }
  function attachLongPress(el) {
    var timer = null, armed = false, x = 0, y = 0;
    function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
    function finish() { cancel(); if (armed) { armed = false; copyValue(); } }
    el.addEventListener('pointerdown', function (e) {
      x = e.clientX; y = e.clientY; armed = false; cancel();
      timer = setTimeout(function () {
        timer = null; armed = true;
        if (navigator.vibrate) { try { navigator.vibrate(20); } catch (err) {} }
      }, 500);
    });
    el.addEventListener('pointermove', function (e) {
      if (Math.abs(e.clientX - x) > 12 || Math.abs(e.clientY - y) > 12) { cancel(); armed = false; }
    });
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('pointerleave', function () { cancel(); armed = false; });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ---------- Pantalla encendida ----------
  async function setWake(on, silent) {
    if (on) {
      var KA = plug('KeepAwake');
      if (KA) {
        try { await KA.keepAwake(); keepOn = true; if (!silent) toast('La pantalla no se apagará'); } catch (e) { keepOn = false; }
      } else if (!('wakeLock' in navigator)) {
        keepOn = false;
        if (!silent) toast('Este WebView no lo permite');
      } else {
        try {
          wake = await navigator.wakeLock.request('screen');
          wake.addEventListener('release', function () { wake = null; });
          keepOn = true;
          if (!silent) toast('La pantalla no se apagará');
        } catch (e) {
          keepOn = false;
          if (!silent) toast('No se pudo activar');
        }
      }
    } else {
      keepOn = false;
      if (wake) { try { await wake.release(); } catch (e) {} wake = null; }
      var KB = plug('KeepAwake');
      if (KB) { try { await KB.allowSleep(); } catch (e) {} }
      if (!silent) toast('Pantalla normal');
    }
    if (!silent) { try { localStorage.setItem(WAKE_KEY, keepOn ? '1' : '0'); } catch (e) {} }
    render();
  }

  // ---------- Eventos ----------
  var delT = null, delI = null;
  function stopDel() { clearTimeout(delT); clearInterval(delI); delT = delI = null; }
  $('keypad').addEventListener(window.PointerEvent ? 'pointerdown' : 'click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('.key') : null;
    if (!b) return;
    handleKey(b.getAttribute('data-key'));
    if (navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
    stopDel();
    if (window.PointerEvent && b.getAttribute('data-key') === 'DEL') {
      delT = setTimeout(function () { delI = setInterval(function () { handleKey('DEL'); }, 60); }, 400);
    }
  });
  // Borrar rápido: mantener pulsado ⌫
  ['pointerup', 'pointercancel'].forEach(function (n) { document.addEventListener(n, stopDel); });
  $('keypad').addEventListener('pointerleave', stopDel);
  $('keypad').addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
  document.querySelector('.nav').addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('.nav-btn') : null;
    if (!b) return;
    page = b.getAttribute('data-page');
    render();
  });

  function openHist() { renderHist(); $('histPanel').hidden = false; }
  function openRates() { renderRates(); $('ratesPanel').hidden = false; }
  $('histClose').addEventListener('click', function () { $('histPanel').hidden = true; });
  $('histClear').addEventListener('click', function () { log = []; lastLogged = ''; writeJson(HIST_KEY, log); renderHist(); });
  $('ratesClose').addEventListener('click', function () { $('ratesPanel').hidden = true; });

  $('menuBtn').addEventListener('click', function (e) { e.stopPropagation(); elMenu.hidden = !elMenu.hidden; });
  document.addEventListener('click', function () { elMenu.hidden = true; });
  elMenu.addEventListener('click', function (e) {
    var act = e.target.getAttribute('data-act');
    if (!act) return;
    elMenu.hidden = true;
    if (act === 'history') openHist();
    else if (act === 'rates') openRates();
    else if (act === 'wake') setWake(!keepOn);
    else if (act === 'apk') window.location.href = 'Calculadora-BCV.apk';
    else if (act === 'theme') $('themeModal').hidden = false;
    else if (act === 'cur') { cur = cur === 'USD' ? 'EUR' : 'USD'; page = 'cur'; lastLogged = ''; render(); }
  });

  $('swapBtn').addEventListener('click', function () {
    logConversion();
    dir = dir === 'VES' ? 'FX' : 'VES';
    render();
  });
  $('rateBtn').addEventListener('click', openModal);
  $('rateCancel').addEventListener('click', closeModal);
  $('rateSave').addEventListener('click', saveManual);
  $('rateRetry').addEventListener('click', async function () {
    closeModal();
    var ok = await fetchRates();
    if (!ok) toast('No se pudo conectar');
  });
  elRateInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveManual(); });

  // Inicio
  $('refreshBtn').addEventListener('click', async function () {
    var ok = await fetchRates();
    toast(ok ? 'Tasas actualizadas' : 'Sin conexión · se muestra la última tasa');
  });
  $('shareBtn').addEventListener('click', function () {
    var t = ratesText();
    var SP = plug('Share');
    if (SP) {
      SP.share({ text: t }).catch(function () {});
    } else if (navigator.share) {
      navigator.share({ text: t }).catch(function () {});
    } else {
      copyText(t).then(function (ok) { toast(ok ? 'Tasas copiadas' : 'No se pudo compartir'); });
    }
  });

  $('copyCalc').addEventListener('click', copyValue);
  $('copyCur').addEventListener('click', copyValue);
  $('themeModal').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.theme-btn') : null;
    if (b) { if (b.getAttribute('data-m')) applyMode(b.getAttribute('data-m'), true); else applyTheme(b.getAttribute('data-t'), true); return; }
    if (e.target === $('themeModal') || e.target.id === 'themeClose') $('themeModal').hidden = true;
  });

  attachLongPress($('pgCalc'));
  attachLongPress($('pgCur'));

  document.addEventListener('visibilitychange', function () {
    if (keepOn && !wake && document.visibilityState === 'visible') setWake(true, true);
  });
  window.addEventListener('resize', function () {
    $('cMain')._w = 0; $('uMain')._w = 0;
    if (page !== 'home') render();
  });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  // ---------- Inicio de la app ----------
  log = readJson(HIST_KEY, []);
  days = readJson(DAYS_KEY, {});
  try { keepOn = localStorage.getItem(WAKE_KEY) === '1'; } catch (e) {}
  var th = 'purple';
  try { th = localStorage.getItem(THEME_KEY) || 'purple'; } catch (e) {}
  var md = 'auto';
  try { md = localStorage.getItem(MODE_KEY) || 'auto'; } catch (e) {}
  applyMode(md, false);
  applyTheme(th, false);
  if (window.matchMedia) { try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { applyMode(mode, false); }); } catch (e) {} }
  var isNative = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  if (!isNative) {
    var installed = window.matchMedia && matchMedia('(display-mode: standalone)').matches;
    if (/^https?:/.test(location.protocol) && /Android/i.test(navigator.userAgent) && !/; wv\)/.test(navigator.userAgent) && !installed) $('apkBtn').hidden = false;
    if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  var AP = plug('App');
  if (AP) AP.addListener('backButton', function () {
    var layers = ['rateModal', 'themeModal', 'histPanel', 'ratesPanel', 'menu'];
    for (var i = 0; i < layers.length; i++) { var el = $(layers[i]); if (!el.hidden) { el.hidden = true; return; } }
    if (page !== 'home') { page = 'home'; render(); } else AP.exitApp();
  });
  loadCache('USD'); loadCache('EUR');
  render();
  fetchRates();
  if (keepOn) setWake(true, true);
})();
