/* UI for the CNC cost calculator. Plain browser script, no build step. */
(function () {
  'use strict';
  const C = window.CNCCalc, D = window.CNCData, STEP = window.CNCStep;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmt = (v, d = 2) => C.fmt(v, d);
  const eur = (v, d = 2) => `${fmt(v, d)} €`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DEFAULT_INPUT = {
    materialId: 'al6082', machineId: 'auto', shape: 'block', x: 100, y: 60, z: 20, diameter: 40, length: 80,
    allowance: 3, partVolume: '', fill: 55, surfaceArea: '', materialProvided: false,
    setups: 2, facedSides: '', tools: 8, holes: 6, holeDepth: 15, threads: 4, pockets: 2, complexity: 2, fixture: 'vise',
    generalTol: 'm', roughness: 'ra32', tight: D.tightTolerances.map((t) => ({ tol: t.id, count: 0 })),
    finish: 'none', specialTools: '', deburr: true, cmm: false, fai: false, cert31: false,
    quantity: 10, targetPrice: '', repeat: false, shipping: true,
    customer: { company: '', contact: '', email: '', part: '', note: '' },
  };
  const DEFAULT_SHOP = { name: '', email: '', address: '', validity: 30 };

  /*
   * ---------- storage ----------
   * Every value is kept in cookies (first-party, scoped to this page's path, one year) and
   * mirrored to localStorage, because browsers drop cookies for pages opened from file://.
   * A cookie holds at most ~4 KB, so values are split into numbered chunks:
   *   cnc_input=3 (chunk count), cnc_input_0 … cnc_input_2 (URI-encoded JSON parts).
   * Each record carries a timestamp; on load the newer of cookie and localStorage wins.
   * Nothing works worse without storage — it only means nothing is remembered.
   */
  const COOKIE_PATH = location.pathname.replace(/[^/]*$/, '') || '/';
  const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
  const CHUNK = 3500;
  const MAX_CHUNKS = 12;
  const cookieName = (k) => k.replace(/[^a-z0-9]/gi, '_');
  const cookies = () => Object.fromEntries(document.cookie.split('; ').filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)]; }));
  const writeCookie = (name, value, maxAge) => {
    document.cookie = `${name}=${value}; path=${COOKIE_PATH}; max-age=${maxAge}; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  };
  const cookieStore = {
    get(k) {
      const all = cookies(), base = cookieName(k), n = Number(all[base]);
      if (!(n > 0)) return null;
      let s = '';
      for (let i = 0; i < n; i++) { if (all[`${base}_${i}`] === undefined) return null; s += all[`${base}_${i}`]; }
      return JSON.parse(decodeURIComponent(s));
    },
    set(k, rec) {
      const base = cookieName(k), enc = encodeURIComponent(JSON.stringify(rec));
      const old = Number(cookies()[base]) || 0, n = Math.ceil(enc.length / CHUNK);
      // cookies travel with every request; beyond ~40 KB servers answer 431, so keep it local only
      if (n > MAX_CHUNKS) { this.del(k); return; }
      for (let i = 0; i < n; i++) writeCookie(`${base}_${i}`, enc.slice(i * CHUNK, (i + 1) * CHUNK), COOKIE_MAX_AGE);
      for (let i = n; i < old; i++) writeCookie(`${base}_${i}`, '', 0);
      writeCookie(base, String(n), COOKIE_MAX_AGE);
    },
    del(k) {
      const base = cookieName(k), old = Number(cookies()[base]) || 0;
      for (let i = 0; i < old; i++) writeCookie(`${base}_${i}`, '', 0);
      writeCookie(base, '', 0);
    },
  };
  const store = {
    get(k, fb) {
      let c = null, l = null;
      try { c = cookieStore.get(k); } catch { /* unreadable cookie */ }
      try { const v = localStorage.getItem(k); l = v ? JSON.parse(v) : null; } catch { /* private mode */ }
      // records are {t, v}; older builds stored the bare value in localStorage
      const norm = (r) => (r && typeof r === 'object' && 't' in r && 'v' in r ? r : r == null ? null : { t: 0, v: r });
      c = norm(c); l = norm(l);
      const best = c && l ? (c.t >= l.t ? c : l) : c || l;
      return best ? best.v : fb;
    },
    set(k, v) {
      const rec = { t: Date.now(), v };
      try { cookieStore.set(k, rec); } catch { /* cookies blocked */ }
      try { localStorage.setItem(k, JSON.stringify(rec)); } catch { /* private mode */ }
    },
    del(k) {
      try { cookieStore.del(k); } catch { /* ignore */ }
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    },
  };
  const STORE_KEYS = ['cnc.input', 'cnc.settings', 'cnc.theme', 'cnc.ui', 'cnc.step'];
  let ui = Object.assign({ tab: 'tab-calc', measured: '', vdi: null, tableOpen: false }, store.get('cnc.ui', {}));
  const saveUi = () => store.set('cnc.ui', ui);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const setPath = (o, p, v) => { const ks = p.split('.'); let a = o; ks.slice(0, -1).forEach((k) => { if (a[k] == null || typeof a[k] !== 'object') a[k] = {}; a = a[k]; }); a[ks[ks.length - 1]] = v; };

  let input = Object.assign(clone(DEFAULT_INPUT), store.get('cnc.input', {}));
  input.customer = Object.assign(clone(DEFAULT_INPUT.customer), input.customer || {});
  if (!Array.isArray(input.tight) || input.tight.length !== D.tightTolerances.length) input.tight = clone(DEFAULT_INPUT.tight);
  let settings = store.get('cnc.settings', {});

  // a shop link carries the shop settings in the URL hash: #s=<base64 json>
  (function readShareLink() {
    const m = location.hash.match(/[#&]s=([^&]+)/);
    if (!m) return;
    try {
      settings = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1])))));
      store.set('cnc.settings', settings);
      history.replaceState(null, '', location.pathname);
    } catch { /* ignore broken link */ }
  })();

  const resolved = () => C.resolveSettings(settings);
  const shop = () => Object.assign({}, DEFAULT_SHOP, settings.shop || {});

  /* ---------- tabs and theme ---------- */
  function showTab(tab) {
    $$('.tabs [role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $$('.view').forEach((v) => { v.hidden = v.id !== tab.getAttribute('aria-controls'); });
    if (tab.id === 'tab-shop') { renderShop(); if (ui.vdi) showVdi(ui.vdi); }
    if (tab.id === 'tab-calc') render();
    ui.tab = tab.id; saveUi();
  }
  $$('.tabs [role="tab"]').forEach((tab) => tab.addEventListener('click', () => showTab(tab)));
  (function theme() {
    const saved = store.get('cnc.theme', null);
    if (saved) document.documentElement.dataset.theme = saved;
    $('#themeToggle').addEventListener('click', () => {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store.set('cnc.theme', next);
      render();
    });
  })();

  /* ---------- form setup ---------- */
  function fillSelect(sel, items, value, label, groupKey) {
    sel.innerHTML = '';
    if (groupKey) {
      const groups = {};
      items.forEach((it) => { (groups[it[groupKey]] = groups[it[groupKey]] || []).push(it); });
      for (const g of Object.keys(groups)) {
        const og = document.createElement('optgroup'); og.label = g;
        groups[g].forEach((it) => og.appendChild(new Option(label(it), it.id)));
        sel.appendChild(og);
      }
    } else items.forEach((it) => sel.appendChild(new Option(label(it), it.id)));
    sel.value = value;
  }

  function setupSelects() {
    const S = resolved();
    fillSelect($('#material'), S.materials, input.materialId, (m) => m.name, 'group');
    const machines = S.machines.filter((m) => m.active !== false);
    $('#machine').innerHTML = '';
    $('#machine').appendChild(new Option('Automatisch, günstigste', 'auto'));
    machines.forEach((m) => $('#machine').appendChild(new Option(`${m.name} (${fmt(C.workplaceRate(m, S).perHour, 0)} €/h)`, m.id)));
    $('#machine').value = machines.some((m) => m.id === input.machineId) ? input.machineId : 'auto';
    fillSelect($('#complexity'), S.complexity, input.complexity, (c) => c.label);
    fillSelect($('#fixture'), S.fixtures, input.fixture, (f) => f.label);
    fillSelect($('#generalTol'), S.generalTolerances, input.generalTol, (g) => g.name);
    fillSelect($('#roughness'), S.roughness, input.roughness, (r) => r.label);
    fillSelect($('#finish'), S.finishes, input.finish, (f) => f.label);
    $('#ladder').innerHTML = S.tightTolerances.map((t, i) => `
      <tr><td>${esc(t.label)}</td><td class="it">${esc(t.it)}</td>
      <td><input type="number" min="0" step="1" data-tight="${i}" aria-label="Anzahl Merkmale mit ${esc(t.label)}" value="${input.tight[i] ? input.tight[i].count || '' : ''}" placeholder="0"></td></tr>`).join('');
  }

  function writeForm() {
    $$('[data-k]').forEach((el) => {
      const v = getPath(input, el.dataset.k);
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.tagName === 'SELECT') { if (v !== undefined) el.value = String(v); }
      else el.value = v ?? '';
    });
    $$('[data-shape]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.shape === input.shape)));
    $('#dimsBlock').hidden = input.shape === 'round';
    $('#dimsRound').hidden = input.shape !== 'round';
  }

  $('#form').addEventListener('input', onFormChange);
  $('#form').addEventListener('change', onFormChange);
  function onFormChange(e) {
    const el = e.target;
    if (el.dataset.tight !== undefined) {
      input.tight[Number(el.dataset.tight)].count = el.value === '' ? 0 : Number(el.value);
    } else if (el.dataset.k) {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'number' && v !== '') v = Number(v);
      if (el.dataset.k === 'complexity') v = Number(v);
      setPath(input, el.dataset.k, v);
    } else return;
    store.set('cnc.input', input);
    scheduleRender();
  }
  $$('[data-shape]').forEach((b) => b.addEventListener('click', () => {
    input.shape = b.dataset.shape; store.set('cnc.input', input); writeForm(); render();
  }));

  let raf = 0;
  function scheduleRender() { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); }

  /* ---------- calculation ---------- */
  function engineInput() {
    const i = clone(input);
    i.tight = (i.tight || []).filter((t) => Number(t.count) > 0);
    if (i.facedSides === '' || i.facedSides === null) delete i.facedSides;
    return i;
  }

  /* "auto" picks the cheapest active machine; 5-axis only parts need a 5-axis machine */
  function pickMachine(inp) {
    const S = resolved();
    if (inp.machineId && inp.machineId !== 'auto') return { id: inp.machineId, auto: false };
    let cands = S.machines.filter((m) => m.active !== false);
    if (Number(inp.complexity) >= 5 || inp.needs5) cands = cands.filter((m) => m.axes === 5);
    if (!cands.length) cands = S.machines;
    let best = null;
    for (const m of cands) {
      const r = C.calculate({ ...inp, machineId: m.id }, settings);
      if (!best || r.totals.net < best.net) best = { id: m.id, net: r.totals.net };
    }
    return { id: best.id, auto: true };
  }

  function compute() {
    const inp = engineInput();
    const pick = pickMachine(inp);
    inp.machineId = pick.id;
    const r = C.calculate(inp, settings);
    r.autoMachine = pick.auto;
    r.curve = C.quantityCurve(inp, settings, uniqueSorted([1, 5, 10, 25, 50, 100, 250, 500, inp.quantity]));
    r.hints = C.savingsHints(inp, settings);
    return r;
  }
  const uniqueSorted = (a) => [...new Set(a.map((x) => Math.max(1, Math.round(Number(x) || 1))))].sort((x, y) => x - y);

  /* ---------- result panel ---------- */
  const ICON_WARN = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 6v4M8 11.6v.4" stroke="currentColor" stroke-width="1.6"/></svg>';
  const ICON_OK = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const ICON_X = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8"/></svg>';

  let last = null;
  function render() {
    let r;
    try { r = compute(); } catch (err) { $('#result').innerHTML = `<div class="sec"><div class="flag loss">${ICON_X}<span>Berechnung nicht möglich: ${esc(err.message)}</span></div></div>`; return; }
    last = r;
    const t = r.totals, q = r.input.quantity, tm = r.times;
    const groups = ['Material', 'Fertigung', 'Qualität', 'Oberfläche', 'Einmalig'];
    const maxLine = Math.max(...r.lines.map((l) => l.amount), 1);
    const linesHtml = groups.map((g) => {
      const ls = r.lines.filter((l) => l.group === g && (l.amount > 0 || g === 'Material'));
      if (!ls.length) return '';
      const sum = ls.reduce((s, l) => s + l.amount, 0);
      return `<tr class="g"><td>${g}</td><td class="n">${eur(sum)}</td></tr>` + ls.map((l) => `
        <tr><td>${esc(l.label)}${l.note ? `<div class="why">${esc(l.note)}</div>` : ''}<div class="bar" style="width:${(l.amount / maxLine * 100).toFixed(1)}%"></div></td><td class="n">${eur(l.amount)}</td></tr>`).join('');
    }).join('');

    const timeRows = [
      ['Planfräsen', tm.tFace], ['Schruppen', tm.tRough], ['Schlichten', tm.tFinish], ['Bohren', tm.tDrill],
      ['Gewinde', tm.tTap], ['Passmaße', tm.tTight], ['Werkzeugwechsel', tm.tToolChange], ['Spannen', tm.tClamp],
    ].filter((x) => x[1] > 0.005);
    const tMax = Math.max(...timeRows.map((x) => x[1]), 0.01);

    const check = r.check;
    const checkHtml = check ? `<div class="flag ${check.status === 'ok' ? 'ok' : check.status === 'tight' ? 'warn' : 'loss'}">
        ${check.status === 'ok' ? ICON_OK : check.status === 'tight' ? ICON_WARN : ICON_X}
        <span>${check.status === 'ok' ? 'Zielpreis deckt Kosten und Gewinn.' : check.status === 'tight' ? 'Zielpreis deckt die Kosten, aber nicht den vollen Gewinn.' : 'Zielpreis liegt unter den Selbstkosten.'}
        Ergebnis ${eur(check.result)} (${fmt(check.margin * 100, 1)} % vom Umsatz), Selbstkosten ${eur(check.costPerPart)} je Stück.</span></div>` : '';

    const s = shop();
    $('#result').innerHTML = `
      <div class="tb">
        <div class="price">
          <span class="k">Stückpreis netto bei ${fmt(q, 0)} Stück</span>
          <div class="big">${eur(t.perPart)}</div>
          <div class="per">Auftrag ${eur(t.net)} netto · ${eur(t.gross)} brutto inkl. ${fmt(resolved().defaults.vat, 0)} % MwSt.</div>
        </div>
        <div><label>Maschine${r.autoMachine ? ', automatisch' : ''}</label><b>${esc(r.machine.name)}</b></div>
        <div><label>Stundensatz</label><b>${eur(r.rate.perHour)}/h</b></div>
        <div><label>Laufzeit je Teil</label><b>${fmt(tm.tMachine, 1)} min</b></div>
        <div><label>Lieferzeit, geschätzt</label><b>${r.leadDays} Arbeitstage</b></div>
        <div><label>Rohteil</label><b>${fmt(r.geo.blankMass, 2)} kg</b></div>
        <div><label>Einmalkosten</label><b>${eur(t.oneTime)}</b></div>
      </div>
      ${checkHtml ? `<div class="sec">${checkHtml}</div>` : ''}
      ${r.warnings.length ? `<div class="sec">${r.warnings.map((w) => `<div class="flag warn">${ICON_WARN}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}
      <div class="sec">
        <h3>Wofür Sie bezahlen</h3>
        <table class="costs">
          ${linesHtml}
          <tr class="sum"><td>Herstellkosten</td><td class="n">${eur(t.manufacturing)}</td></tr>
          <tr><td>Verwaltung und Vertrieb, ${fmt(resolved().defaults.salesOverhead, 0)} %</td><td class="n">${eur(t.salesOverhead)}</td></tr>
          <tr><td>Verpackung und Versand</td><td class="n">${eur(t.logistics)}</td></tr>
          <tr><td>Gewinn, ${fmt(resolved().defaults.profit, 0)} %</td><td class="n">${eur(t.profit)}</td></tr>
          ${t.targetPrice - t.cashPrice > 0.005 ? `<tr><td>Skonto-Vorhalt</td><td class="n">${eur(t.targetPrice - t.cashPrice)}</td></tr>` : ''}
          ${t.net - t.targetPrice > 0.005 ? `<tr><td>${t.net > t.targetPrice && r.warnings.some((w) => w.startsWith('Mindestauftragswert')) ? 'Auffüllung Mindestauftragswert' : 'Rabatt-Vorhalt'}</td><td class="n">${eur(t.net - t.targetPrice)}</td></tr>` : ''}
          <tr class="sum"><td>Auftrag netto</td><td class="n">${eur(t.net)}</td></tr>
        </table>
      </div>
      <div class="sec">
        <h3>Laufzeit je Teil: ${fmt(tm.tMachine, 1)} min</h3>
        <div class="times">${timeRows.map(([n, v]) => `<span>${n}</span><div class="t" style="width:${(v / tMax * 100).toFixed(1)}%"></div><span>${fmt(v, 1)} min</span>`).join('')}</div>
        <p class="note" style="margin:8px 0 0">Zeitspanvolumen ${fmt(tm.q, 0)} cm³/min${r.face.sides ? `, Planfräsen mit Ø${fmt(r.face.cutterD, 0)} in ${r.face.tracks} ${r.face.tracks === 1 ? 'Bahn' : 'Bahnen'} je Seite` : ''}${tm.calibration !== 1 ? `, kalibriert ×${fmt(tm.calibration, 2)}` : ''}. Rüsten ${fmt(tm.setupMin, 0)} min, Programmieren ${fmt(tm.camHours, 1)} h einmalig.</p>
      </div>
      <div class="sec">
        <h3>Stückpreis nach Menge</h3>
        <div class="chart" id="chart"></div>
        <details id="tiersDetails"${ui.tableOpen ? ' open' : ''}><summary>Als Tabelle</summary>
          <table class="tiers"><thead><tr><th>Stück</th><th>je Stück</th><th>Auftrag</th></tr></thead>
          <tbody>${r.curve.map((c) => `<tr class="${c.quantity === q ? 'cur' : ''}"><td>${fmt(c.quantity, 0)}</td><td>${eur(c.perPart)}</td><td>${eur(c.net)}</td></tr>`).join('')}</tbody></table>
        </details>
      </div>
      ${r.hints.length ? `<div class="sec"><h3>So wird es günstiger</h3><ul class="hints">${r.hints.slice(0, 5).map((h) => `<li><span>${esc(h.label)}</span><b>−${eur(h.perPart ? h.saving / q : h.saving)}${h.perPart ? ' je Stück' : ''}</b></li>`).join('')}</ul></div>` : ''}
      <div class="sec">
        <div class="actions">
          <button type="button" class="btn" id="sendRequest">${s.email ? 'Anfrage senden' : 'Anfrage als E-Mail'}</button>
          <button type="button" class="btn ghost" id="printOffer">Angebot drucken</button>
          <button type="button" class="btn ghost" id="saveCalc">Kalkulation sichern</button>
          <label class="btn ghost">Laden<input type="file" accept=".json" id="loadCalc" class="sr"></label>
        </div>
        <p class="note" style="margin:8px 0 0">Richtwert. Verbindlich nach Prüfung von Modell und Zeichnung.</p>
      </div>`;
    drawChart(r);
    $('#miniPrice').textContent = `${eur(t.perPart)} je Stück · ${fmt(q, 0)} Stück`;
    $('#tiersDetails').addEventListener('toggle', (e) => { ui.tableOpen = e.target.open; saveUi(); });
    $('#sendRequest').onclick = sendRequest;
    $('#printOffer').onclick = () => { buildOffer(); window.print(); };
    $('#saveCalc').onclick = () => download(`kalkulation-${dateStamp()}.json`, { input, result: summary(r) });
    $('#loadCalc').onchange = (e) => readJson(e.target.files[0], (j) => {
      input = Object.assign(clone(DEFAULT_INPUT), j.input || j);
      store.set('cnc.input', input); setupSelects(); writeForm(); render();
    });
  }

  /* ---------- chart: unit price vs quantity (single series, log x) ---------- */
  function drawChart(r) {
    const el = $('#chart'); if (!el) return;
    const pts = r.curve, W = 430, H = 170, L = 52, R = 12, T = 10, B = 26;
    const xs = pts.map((p) => Math.log10(p.quantity)), ys = pts.map((p) => p.perPart);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1, yMax = niceMax(Math.max(...ys));
    const X = (v) => L + (x1 === x0 ? 0 : (v - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - v / yMax) * (H - T - B);
    const ticksY = [0, yMax / 2, yMax];
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(Math.log10(p.quantity)).toFixed(1)},${Y(p.perPart).toFixed(1)}`).join('');
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stückpreis fällt von ${eur(pts[0].perPart)} bei ${pts[0].quantity} Stück auf ${eur(pts[pts.length - 1].perPart)} bei ${pts[pts.length - 1].quantity} Stück">
      ${ticksY.map((v) => `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/><text class="axis-t" x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v, 0)} €</text>`).join('')}
      ${pts.map((p) => `<text class="axis-t" x="${X(Math.log10(p.quantity))}" y="${H - 8}" text-anchor="middle">${p.quantity}</text>`).join('')}
      <path class="line" d="${path}"/>
      <line class="hair" id="hair" y1="${T}" y2="${H - B}" visibility="hidden"/>
      ${pts.map((p) => `<circle class="dot${p.quantity === r.input.quantity ? ' cur' : ''}" r="${p.quantity === r.input.quantity ? 5 : 4}" cx="${X(Math.log10(p.quantity))}" cy="${Y(p.perPart)}"/>`).join('')}
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" id="hit"/>
    </svg><div class="tip" id="tip" hidden></div>`;
    const svg = $('svg', el), tip = $('#tip', el), hair = $('#hair', el);
    const show = (evt) => {
      const rect = svg.getBoundingClientRect();
      const sx = (evt.clientX - rect.left) * (W / rect.width);
      let best = pts[0], bd = Infinity;
      pts.forEach((p) => { const d = Math.abs(X(Math.log10(p.quantity)) - sx); if (d < bd) { bd = d; best = p; } });
      const px = X(Math.log10(best.quantity));
      hair.setAttribute('x1', px); hair.setAttribute('x2', px); hair.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.style.left = `${px * rect.width / W}px`;
      tip.style.top = `${Y(best.perPart) * rect.height / H}px`;
      tip.textContent = `${best.quantity} Stück: ${eur(best.perPart)} je Stück`;
    };
    $('#hit', el).addEventListener('pointermove', show);
    $('#hit', el).addEventListener('pointerleave', () => { tip.hidden = true; hair.setAttribute('visibility', 'hidden'); });
  }
  function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil(v / p * 2) / 2 * p; }

  /* ---------- request, offer, files ---------- */
  function summary(r) {
    return {
      date: new Date().toISOString().slice(0, 10), material: r.material.name, machine: r.machine.name, quantity: r.input.quantity,
      perPart: C.round2(r.totals.perPart), net: C.round2(r.totals.net), gross: C.round2(r.totals.gross), oneTime: C.round2(r.totals.oneTime),
      cycleMin: C.round2(r.times.tMachine), leadDays: r.leadDays, lines: r.lines.map((l) => ({ group: l.group, label: l.label, amount: C.round2(l.amount) })),
    };
  }

  function requestText(r) {
    const c = input.customer, S = resolved();
    const tight = input.tight.filter((t) => t.count > 0).map((t) => `${t.count}× ${S.tightTolerances.find((x) => x.id === t.tol).label}`).join(', ') || 'keine';
    const dims = input.shape === 'round' ? `Ø${input.diameter} × ${input.length} mm` : `${input.x} × ${input.y} × ${input.z} mm`;
    return [
      `Anfrage CNC-Frästeil${c.part ? `: ${c.part}` : ''}`, '',
      `Firma: ${c.company}`, `Ansprechpartner: ${c.contact}`, `E-Mail: ${c.email}`, '',
      `Werkstoff: ${r.material.name}${input.materialProvided ? ' (beigestellt)' : ''}`,
      `Abmessungen: ${dims}`, `Stückzahl: ${r.input.quantity}${input.repeat ? ' (Wiederholteil)' : ''}`,
      `Allgemeintoleranz: ${S.generalTolerances.find((g) => g.id === input.generalTol).name}`, `Enge Toleranzen: ${tight}`,
      `Rauheit: ${S.roughness.find((x) => x.id === input.roughness).label}`, `Oberfläche: ${r.input.finish === 'none' ? 'keine' : S.finishes.find((f) => f.id === input.finish).label}`,
      `Prüfung: ${[input.cmm && 'KMG', input.fai && 'Erstmusterprüfbericht', input.cert31 && 'Zeugnis 3.1'].filter(Boolean).join(', ') || 'Standard'}`, '',
      `Richtpreis: ${eur(r.totals.perPart)} je Stück, ${eur(r.totals.net)} netto gesamt`,
      `Laufzeit je Teil: ${fmt(r.times.tMachine, 1)} min, Lieferzeit ca. ${r.leadDays} Arbeitstage`, '',
      c.note ? `Hinweise: ${c.note}` : '', 'STEP-Modell und Zeichnung bitte an diese E-Mail anhängen.',
    ].join('\n');
  }

  function sendRequest() {
    if (!last) return;
    const to = shop().email || '';
    const subject = `Anfrage Frästeil${input.customer.part ? ' ' + input.customer.part : ''}, ${last.input.quantity} Stück`;
    location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(requestText(last))}`;
  }

  function buildOffer() {
    const r = last; if (!r) return;
    const s = shop(), c = input.customer, S = resolved();
    const no = `A-${dateStamp()}-${String(Math.floor(Math.random() * 900) + 100)}`;
    const valid = new Date(Date.now() + (Number(s.validity) || 30) * 864e5).toLocaleDateString('de-DE');
    const tiers = r.curve.filter((p) => [1, 10, 25, 50, 100, r.input.quantity].includes(p.quantity));
    $('#offer').innerHTML = `
      <div class="head">
        <div><h1>${esc(s.name || 'Angebot')}</h1><p class="small">${esc(s.address || '')}${s.email ? ` · ${esc(s.email)}` : ''}</p></div>
        <div><p><b>${esc(c.company || 'Kunde')}</b><br>${esc(c.contact || '')}<br>${esc(c.email || '')}</p></div>
      </div>
      <div class="tb2">
        <div><label>Angebot</label>${no}</div><div><label>Datum</label>${new Date().toLocaleDateString('de-DE')}</div><div><label>Gültig bis</label>${valid}</div>
        <div><label>Teil / Zeichnung</label>${esc(c.part || '–')}</div><div><label>Werkstoff</label>${esc(r.material.name)}</div><div><label>Stückzahl</label>${r.input.quantity}</div>
        <div><label>Allgemeintoleranz</label>${esc(S.generalTolerances.find((g) => g.id === input.generalTol).name)}</div><div><label>Rauheit</label>${esc(S.roughness.find((x) => x.id === input.roughness).label)}</div><div><label>Lieferzeit</label>ca. ${r.leadDays} Arbeitstage</div>
      </div>
      <h2>Preis</h2>
      <table><thead><tr><th>Position</th><th class="n">Menge</th><th class="n">Einzelpreis</th><th class="n">Gesamt</th></tr></thead><tbody>
        <tr><td>CNC-Frästeil ${esc(c.part || '')}, ${esc(r.material.name)}, inkl. Rüsten und Programmierung</td><td class="n">${r.input.quantity}</td><td class="n">${eur(r.totals.perPart)}</td><td class="n">${eur(r.totals.net)}</td></tr>
        <tr><td colspan="3">Mehrwertsteuer ${fmt(S.defaults.vat, 0)} %</td><td class="n">${eur(r.totals.vat)}</td></tr>
        <tr class="sum"><td colspan="3">Gesamt brutto</td><td class="n">${eur(r.totals.gross)}</td></tr></tbody></table>
      <h2>Staffelpreise</h2>
      <table><thead><tr><th>Stück</th><th class="n">je Stück netto</th><th class="n">Auftrag netto</th></tr></thead><tbody>
        ${tiers.map((p) => `<tr><td>${p.quantity}</td><td class="n">${eur(p.perPart)}</td><td class="n">${eur(p.net)}</td></tr>`).join('')}</tbody></table>
      <h2>Zusammensetzung</h2>
      <table><tbody>${r.lines.filter((l) => l.amount > 0).map((l) => `<tr><td>${esc(l.group)}: ${esc(l.label)}</td><td class="n">${eur(l.amount)}</td></tr>`).join('')}
        <tr><td>Verwaltung und Vertrieb</td><td class="n">${eur(r.totals.salesOverhead)}</td></tr>
        <tr><td>Verpackung und Versand</td><td class="n">${eur(r.totals.logistics)}</td></tr>
        <tr><td>Gewinn</td><td class="n">${eur(r.totals.profit)}</td></tr>
        ${r.totals.net - r.totals.cashPrice > 0.005 ? `<tr><td>Skonto, Rabatt, Mindestauftrag</td><td class="n">${eur(r.totals.net - r.totals.cashPrice)}</td></tr>` : ''}
        <tr class="sum"><td>Auftrag netto</td><td class="n">${eur(r.totals.net)}</td></tr></tbody></table>
      <h2>Bedingungen</h2>
      <p>Preise netto zzgl. MwSt., ${S.defaults.cashDiscount ? `${fmt(S.defaults.cashDiscount, 0)} % Skonto bei Zahlung in 10 Tagen, ` : ''}30 Tage netto. Grundlage sind das übermittelte Modell und die Zeichnung; Änderungen ändern den Preis. Laufzeit je Teil ${fmt(r.times.tMachine, 1)} min.</p>
      ${c.note ? `<p>Hinweise: ${esc(c.note)}</p>` : ''}`;
  }

  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function readJson(file, cb) {
    if (!file) return;
    file.text().then((t) => cb(JSON.parse(t))).catch(() => alert('Die Datei ist kein gültiges JSON.'));
  }
  const dateStamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
  window.addEventListener('beforeprint', buildOffer);

  /* ---------- STEP import ---------- */
  let stepData = null;
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadStep(f); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#stepFile').click(); } });
  $('#stepFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadStep(f); });

  /* what the found-table and "apply" need, small enough for cookies */
  function compactAnalysis(a) {
    return {
      volume: a.volume, area: a.area, fill: a.fill, faceCount: a.faceCount, minInnerRadius: a.minInnerRadius,
      freeformShare: a.freeformShare, bodies: a.bodies, suggest: a.suggest,
      holes: a.holes.map((h) => ({ d: Math.round(h.d * 100) / 100, thread: h.thread })),
      pmi: a.pmi ? { found: a.pmi.found, counts: a.pmi.counts } : null,
    };
  }

  async function loadStep(file) {
    const st = $('#stepStatus');
    st.className = 'status'; st.textContent = `${file.name} wird gelesen …`;
    try {
      const t0 = performance.now();
      const { raw, analysis } = await STEP.readFile(file);
      stepData = { name: file.name, raw, a: analysis };
      store.set('cnc.step', { name: file.name, a: compactAnalysis(analysis) });
      st.textContent = `${file.name} gelesen in ${fmt((performance.now() - t0) / 1000, 1)} s.`;
      showStep();
    } catch (err) {
      st.className = 'status err'; st.textContent = err.message || String(err);
    }
  }

  function showStep() {
    const a = stepData.a, s = a.suggest, p = a.pmi;
    const threadNames = [...new Set(a.holes.filter((h) => h.thread).map((h) => h.thread))];
    const pmiText = p && p.found ? Object.entries(p.counts).map(([k, n]) => `${n}× ${resolved().tightTolerances.find((t) => t.id === k).label}`).join(', ') || `${p.found} Angaben, alle gröber als ±0,1 mm` : 'keine (nur AP242 mit semantischer PMI)';
    $('#found').innerHTML = `
      <tr><td>Abmessungen</td><td>${fmt(s.x, 1)} × ${fmt(s.y, 1)} × ${fmt(s.z, 1)} mm</td></tr>
      <tr><td>Volumen</td><td>${fmt(a.volume, 1)} cm³, Füllgrad ${fmt(a.fill, 0)} %</td></tr>
      <tr><td>Oberfläche</td><td>${fmt(a.area, 0)} cm²</td></tr>
      <tr><td>Bohrungen bis Ø20</td><td>${s.holes}${s.holes ? ` (Ø ${[...new Set(a.holes.filter((h) => h.d <= 20.05).map((h) => fmt(h.d, 1)))].join(', ')})` : ''}</td></tr>
      <tr><td>Gewinde-Kernlöcher</td><td>${s.threads}${threadNames.length ? ` (${threadNames.join(', ')})` : ''}</td></tr>
      <tr><td>Große Bohrungen</td><td>${s.pockets}</td></tr>
      <tr><td>Kleinster Innenradius</td><td>${a.minInnerRadius ? `${fmt(a.minInnerRadius, 2)} mm` : '–'}</td></tr>
      <tr><td>Flächen im Modell</td><td>${a.faceCount}, Freiform ${fmt(a.freeformShare * 100, 0)} %</td></tr>
      <tr><td>Toleranzen aus dem Modell</td><td>${esc(pmiText)}</td></tr>
      ${a.bodies > 1 ? `<tr><td colspan="2" class="note">${a.bodies} Körper in der Datei. Für die Kalkulation zählt die Summe; bei Baugruppen bitte das Einzelteil hochladen.</td></tr>` : ''}`;
    $('#applyNote').textContent = `Vorschlag: ${s.setups} Aufspannungen, ${s.tools} Werkzeuge, Komplexität ${s.complexity}${s.machineId ? ', 5-Achs' : ''}.`;
    $('#model').hidden = false;
    $('#preview').hidden = !stepData.raw;
    if (stepData.raw) drawPreview(stepData.raw);
  }

  $('#applyStep').addEventListener('click', () => {
    if (!stepData) return;
    const a = stepData.a, s = a.suggest;
    Object.assign(input, {
      shape: 'block', x: s.x, y: s.y, z: s.z, partVolume: s.partVolume, surfaceArea: s.surfaceArea,
      holes: s.holes, threads: s.threads, holeDepth: s.holeDepth, pockets: s.pockets, setups: s.setups, tools: s.tools, complexity: s.complexity,
      needs5: !!s.machineId,
    });
    if (a.pmi && a.pmi.found) input.tight = resolved().tightTolerances.map((t) => ({ tol: t.id, count: a.pmi.counts[t.id] || 0 }));
    if (!input.customer.part) input.customer.part = stepData.name.replace(/\.(step|stp|igs|iges)$/i, '');
    store.set('cnc.input', input); setupSelects(); writeForm(); render();
    $('#applyNote').textContent = 'Übernommen. Bitte Taschen und Toleranzen anhand der Zeichnung prüfen.';
  });

  /* flat-shaded isometric preview, painter's algorithm */
  function drawPreview(raw) {
    const cv = $('#preview'), ctx = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const tris = [];
    const a = Math.PI / 6, cosA = Math.cos(a), sinA = Math.sin(a);
    const light = norm3([0.4, 0.5, 0.8]);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const m of raw.meshes || []) {
      const p = m.attributes.position.array, idx = m.index.array;
      const step = Math.max(1, Math.floor(idx.length / 3 / 60000));
      for (let t = 0; t < idx.length / 3; t += step) {
        const v = [0, 1, 2].map((k) => { const i = idx[3 * t + k] * 3; return [p[i], p[i + 1], p[i + 2]]; });
        const n = norm3(cross3(sub3(v[1], v[0]), sub3(v[2], v[0])));
        const proj = v.map(([x, y, z]) => [(x - y) * cosA, -(z) - (x + y) * sinA, x + y + z]);
        proj.forEach(([px, py]) => { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); });
        tris.push({ proj, depth: proj[0][2] + proj[1][2] + proj[2][2], shade: Math.abs(n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) });
      }
    }
    tris.sort((p, q) => p.depth - q.depth);
    const pad = 16, sc = Math.min((cv.width - 2 * pad) / (maxX - minX || 1), (cv.height - 2 * pad) / (maxY - minY || 1));
    const ox = (cv.width - (maxX - minX) * sc) / 2, oy = (cv.height - (maxY - minY) * sc) / 2;
    const dark = css.getPropertyValue('--sheet').trim().startsWith('#18');
    for (const t of tris) {
      const l = dark ? 30 + t.shade * 45 : 55 + t.shade * 35;
      ctx.fillStyle = ctx.strokeStyle = `hsl(193 35% ${l}%)`;
      ctx.beginPath();
      t.proj.forEach(([x, y], i) => { const X = ox + (x - minX) * sc, Y = oy + (y - minY) * sc; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath(); ctx.fill(); ctx.lineWidth = 0.5; ctx.stroke();
    }
  }
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm3 = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };

  /* ---------- shop settings ---------- */
  function saveSettings() { store.set('cnc.settings', settings); $('#shopTitle').textContent = shop().name || 'Frästeil-Kalkulation'; }

  function renderShop() {
    const S = resolved();
    $$('[data-s]').forEach((el) => {
      const own = getPath(settings, el.dataset.s);
      const eff = own !== undefined ? own : getPath(el.dataset.s.startsWith('shop.') ? { shop: DEFAULT_SHOP } : S, el.dataset.s);
      el.value = eff ?? '';
    });
    $('#machinesTbl').innerHTML = `<thead><tr><th>Aktiv</th><th>Maschine</th><th>Achsen</th><th>Stundensatz €/h</th><th>Ermittlung</th><th>Spindel kW</th><th>Kalibrierung</th><th></th></tr></thead><tbody>
      ${S.machines.map((m) => {
        const wr = C.workplaceRate(m, S);
        return `<tr data-m="${esc(m.id)}">
          <td><input type="checkbox" data-mf="active" ${m.active === false ? '' : 'checked'} aria-label="${esc(m.name)} aktiv"></td>
          <td><input type="text" data-mf="name" value="${esc(m.name)}" aria-label="Name"></td>
          <td><select data-mf="axes" aria-label="Achsen"><option value="3" ${m.axes !== 5 ? 'selected' : ''}>3</option><option value="5" ${m.axes === 5 ? 'selected' : ''}>5</option></select></td>
          <td>${m.rateMode === 'vdi' ? `<b>${fmt(wr.perHour)}</b>` : `<input type="number" min="1" step="1" data-mf="rate" value="${m.rate}" aria-label="Stundensatz">`}</td>
          <td><select data-mf="rateMode" aria-label="Ermittlung"><option value="direct" ${m.rateMode !== 'vdi' ? 'selected' : ''}>eigener Satz</option><option value="vdi" ${m.rateMode === 'vdi' ? 'selected' : ''}>VDI 3258</option></select></td>
          <td><input type="number" min="0.5" step="0.5" data-mf="spindleKw" value="${m.spindleKw}" aria-label="Spindelleistung"></td>
          <td><input type="number" min="0.2" max="5" step="0.01" data-mf="calibration" value="${m.calibration ?? 1}" aria-label="Kalibrierfaktor"></td>
          <td><button type="button" class="btn ghost" data-vdi="${esc(m.id)}">VDI-Rechner</button></td></tr>`;
      }).join('')}</tbody>`;
    $('#materialsTbl').innerHTML = `<thead><tr><th>Werkstoff</th><th>€/kg</th><th>Dichte g/cm³</th><th>Zeitspanvolumen cm³/min</th><th>Schlichten cm²/min</th><th>Werkzeug €/h</th></tr></thead><tbody>
      ${S.materials.map((m) => `<tr data-mat="${esc(m.id)}"><td>${esc(m.name)}</td>
        <td><input type="number" min="0" step="0.1" data-af="price" value="${m.price}" aria-label="Preis ${esc(m.name)}"></td>
        <td class="n">${fmt(m.density, 2)}</td>
        <td><input type="number" min="1" step="1" data-af="qRough" value="${m.qRough}" aria-label="Zeitspanvolumen"></td>
        <td><input type="number" min="1" step="1" data-af="finish" value="${m.finish}" aria-label="Schlichtleistung"></td>
        <td><input type="number" min="0" step="0.5" data-af="toolCost" value="${m.toolCost}" aria-label="Werkzeugkosten"></td></tr>`).join('')}</tbody>`;
  }

  $('#view-shop').addEventListener('input', (e) => {
    // save while typing; fields that re-render their panel wait for 'change'
    if (e.target.dataset.vf || e.target.dataset.mf === 'rateMode' || e.target.type === 'file') return;
    onShopChange(e);
  });
  $('#view-shop').addEventListener('change', onShopChange);
  function onShopChange(e) {
    const el = e.target;
    if (el.dataset.s) {
      let v = el.type === 'number' ? (el.value === '' ? undefined : Number(el.value)) : el.value;
      setPath(settings, el.dataset.s, v);
    } else if (el.dataset.mf) {
      const id = el.closest('tr').dataset.m; settings.machines = settings.machines || {}; settings.machines[id] = settings.machines[id] || {};
      settings.machines[id][el.dataset.mf] = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.dataset.mf === 'axes' ? Number(el.value) : el.value;
      if (el.dataset.mf === 'rateMode') { saveSettings(); renderShop(); }
    } else if (el.dataset.af) {
      const id = el.closest('tr').dataset.mat; settings.materials = settings.materials || {}; settings.materials[id] = settings.materials[id] || {};
      settings.materials[id][el.dataset.af] = Number(el.value);
    } else if (el.dataset.vf) {
      const id = el.dataset.vm; settings.machines = settings.machines || {}; settings.machines[id] = settings.machines[id] || {};
      if (el.dataset.vf === 'wage') settings.machines[id].wage = Number(el.value);
      else { settings.machines[id].vdi = settings.machines[id].vdi || {}; settings.machines[id].vdi[el.dataset.vf] = Number(el.value); }
      showVdi(id);
    } else return;
    saveSettings(); setupSelects();
  }

  $('#view-shop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vdi]'); if (b) showVdi(b.dataset.vdi);
  });

  const VDI_FIELDS = [
    ['price', 'Anschaffung', '€'], ['years', 'Nutzungsdauer', 'Jahre'], ['interest', 'Kalk. Zins', '%'], ['area', 'Fläche', 'm²'],
    ['rent', 'Raumkosten', '€/m²·a'], ['powerKw', 'Anschlussleistung', 'kW'], ['load', 'mittlere Auslastung', '%'],
    ['energyPrice', 'Strompreis', '€/kWh'], ['maintenance', 'Instandhaltung', '% p.a.'], ['hours', 'Laufstunden', 'h/Jahr'],
  ];
  function showVdi(id) {
    const S = resolved(), m = S.machines.find((x) => x.id === id); if (!m) return;
    if (ui.vdi !== id) { ui.vdi = id; saveUi(); }
    const wr = C.workplaceRate({ ...m, rateMode: 'vdi' }, S), mh = wr.machine;
    $('#vdiBox').innerHTML = `<h3 style="margin:16px 0 4px;font-size:16px">VDI 3258: ${esc(m.name)}</h3>
      <div class="vdi">${VDI_FIELDS.map(([k, l, u]) => `<label class="f"><span>${l}</span><span class="unit"><input type="number" step="any" data-vm="${esc(id)}" data-vf="${k}" value="${m.vdi[k]}"><i>${u}</i></span></label>`).join('')}
        <label class="f"><span>Bruttolohn Bediener</span><span class="unit"><input type="number" step="0.5" data-vm="${esc(id)}" data-vf="wage" value="${m.wage}"><i>€/h</i></span></label>
        <div class="vdi-out">Abschreibung ${eur(mh.depreciation, 0)} + Zinsen ${eur(mh.interest, 0)} + Raum ${eur(mh.space, 0)} + Energie ${eur(mh.energy, 0)} + Instandhaltung ${eur(mh.maintenance, 0)} = ${eur(mh.yearly, 0)} im Jahr.<br>
        Maschine <b>${eur(mh.perHour)}/h</b> + Lohn ${eur(wr.labour.effective)}/h + Rest-Gemeinkosten ${eur(wr.labour.restOverhead)}/h = <b>${eur(wr.derived)}/h</b>
        <button type="button" class="btn ghost" id="useVdi" style="margin-left:8px">Als Stundensatz übernehmen</button></div></div>`;
    $('#useVdi').onclick = () => {
      settings.machines = settings.machines || {}; settings.machines[id] = Object.assign(settings.machines[id] || {}, { rate: Math.round(wr.derived * 100) / 100, rateMode: 'direct' });
      saveSettings(); setupSelects(); renderShop(); showVdi(id);
    };
  }

  $('#addMachine').addEventListener('click', () => {
    const id = 'm' + Date.now().toString(36);
    settings.machines = settings.machines || {};
    settings.machines[id] = { base: 'vmc3', name: 'Neue Maschine', rate: 80 };
    saveSettings(); setupSelects(); renderShop();
  });

  $('#measured').addEventListener('input', (e) => { ui.measured = e.target.value; saveUi(); });
  $('#calibrate').addEventListener('click', () => {
    const measured = Number($('#measured').value);
    if (!(measured > 0) || !last) { $('#calibNote').textContent = 'Erst eine Laufzeit in Minuten eingeben.'; return; }
    const inp = engineInput(); inp.machineId = last.machine.id;
    const f = C.calibrationFactor(inp, settings, measured);
    settings.machines = settings.machines || {}; settings.machines[last.machine.id] = Object.assign(settings.machines[last.machine.id] || {}, { calibration: Math.round(f * 1000) / 1000 });
    saveSettings(); renderShop();
    $('#calibNote').textContent = `${last.machine.name}: Faktor ${fmt(f, 3)} gespeichert (berechnet ${fmt(last.times.tCutRaw, 1)} min, gemessen ${fmt(measured, 1)} min).`;
  });

  $('#exportSettings').addEventListener('click', () => download(`betrieb-einstellungen-${dateStamp()}.json`, settings));
  $('#importSettings').addEventListener('change', (e) => readJson(e.target.files[0], (j) => { settings = j; saveSettings(); setupSelects(); renderShop(); $('#settingsStatus').textContent = 'Einstellungen geladen.'; }));
  $('#shareSettings').addEventListener('click', async () => {
    const code = btoa(unescape(encodeURIComponent(JSON.stringify(settings))));
    const url = `${location.origin}${location.pathname}#s=${encodeURIComponent(code)}`;
    try { await navigator.clipboard.writeText(url); $('#settingsStatus').textContent = 'Link kopiert. Wer ihn öffnet, rechnet mit Ihren Sätzen.'; }
    catch { $('#settingsStatus').textContent = url; }
  });
  $('#resetSettings').addEventListener('click', () => {
    if (!confirm('Alle Betriebseinstellungen auf die Standardwerte zurücksetzen?')) return;
    settings = {}; store.del('cnc.settings'); saveSettings(); setupSelects(); renderShop(); $('#settingsStatus').textContent = 'Zurückgesetzt.';
  });

  /* ---------- method view ---------- */
  function renderMethod() {
    $('#methodDoc').innerHTML = `
      <h2>So wird gerechnet</h2>
      <p>Die Kalkulation folgt der Zuschlagskalkulation mit Maschinenstundensätzen, wie sie in deutschen Lohnfertigern üblich ist. Jeder Posten im Ergebnis entspricht einer Zeile unten.</p>
      <h3>Maschinenstundensatz</h3>
      <p>Der Betrieb trägt seinen Satz je Maschine ein. Wer ihn ermitteln will, rechnet nach VDI 3258:</p>
      <div class="formula">Maschine €/h = (Anschaffung / Nutzungsjahre + Anschaffung / 2 × Zins + Fläche × Raumkosten + kW × Auslastung × Strompreis × Stunden + Anschaffung × Instandhaltung) / Laufstunden</div>
      <div class="formula">Platzkosten €/h = Maschine + Lohn × (1 + Lohnnebenkosten) / produktiver Anteil × (1 + Rest-Gemeinkosten)</div>
      <h3>Laufzeit je Teil</h3>
      <div class="formula">Planfräsen = Seiten × Bahnen × (Länge + Ø Messerkopf + Überlauf) / Vorschub, Bahnen = ⌈Breite / (Ø × nutzbare Breite)⌉</div>
      <div class="formula">Schruppen = abzutragendes Volumen / Zeitspanvolumen; Zeitspanvolumen = Werkstoff × Maschine × Komplexität, begrenzt durch P × η × 60 000 / kc</div>
      <div class="formula">Schlichten = Fläche / Schlichtleistung × Rauheitsfaktor × Toleranzfaktor</div>
      <div class="formula">Passmaße = Anzahl × Schlichtdurchgänge (Standard 2) × Zeit je Durchgang</div>
      <p>Dazu Bohren, Gewinde, Werkzeugwechsel, Luftschnitte und Spannen. Der Kalibrierfaktor je Maschine gleicht alles an gemessene Laufzeiten an.</p>
      <h3>Einmalkosten</h3>
      <p>Rüsten (je Aufspannung und Werkzeug) zum Platzkostensatz, CAM-Programmierung nach Aufspannungen, Merkmalen und Komplexität, Spannmittel, Erstmusterprüfung, Zeugnisse. Sie verteilen sich auf die Stückzahl. Deshalb fällt der Stückpreis mit der Menge.</p>
      <h3>Toleranzen</h3>
      <p>Die Allgemeintoleranz (ISO 2768) wirkt auf das Schlichten der ganzen Kontur. Jedes enger tolerierte Merkmal kostet zusätzliche Schlichtdurchgänge, Messzeit und erhöht den Ausschuss. ±0,01 mm hebt den Preis in unseren Tests um 50–100 %, wie veröffentlichte Branchenwerte.</p>
      <h3>Vom Kostenpreis zum Angebot</h3>
      <div class="formula">Herstellkosten = Material (+ Materialgemeinkosten) + Fertigung + Prüfung + Oberfläche + Einmalkosten</div>
      <div class="formula">Angebot netto = (Herstellkosten × (1 + Verwaltung/Vertrieb) + Versand) × (1 + Gewinn) / (1 − Skonto) / (1 − Rabatt)</div>
      <h3>Geprüft gegen</h3>
      <table><tbody>
        <tr><td>VDI-3258-Beispiel (17,88 €/h)</td><td>exakt</td></tr>
        <tr><td>Stundensätze 2026: 3-Achs 70–120 €/h, 5-Achs 100–160 €/h</td><td>im Bereich</td></tr>
        <tr><td>±0,01 mm: +50–100 %</td><td>im Bereich</td></tr>
        <tr><td>Edelstahl +30–80 % Bearbeitungszeit</td><td>im Bereich</td></tr>
        <tr><td>Messerkopf Ø63 statt Ø100 auf 80er Platte, 300 mm lang: ca. 20 s mehr (Praxiswert)</td><td>25 s</td></tr>
        <tr><td>NIST-Testteile: Bohrungen und Toleranzen aus STEP AP242</td><td>wie Zeichnung</td></tr>
      </tbody></table>
      <p>Quellen: VDI 3258; Branchenwerte 2026 zu Stundensätzen, Toleranz- und Werkstoffaufschlägen; NIST MBE PMI Testteile; Praxiswerte eines Industriemeisters.</p>`;
  }

  $('#clearAll').addEventListener('click', () => {
    if (!confirm('Alle gespeicherten Eingaben und Betriebseinstellungen in diesem Browser löschen?')) return;
    STORE_KEYS.forEach((k) => store.del(k));
    location.reload();
  });

  /* ---------- start ---------- */
  saveSettings();
  setupSelects();
  writeForm();
  renderMethod();
  $('#measured').value = ui.measured || '';
  render();
  (function restoreStep() {
    const saved = store.get('cnc.step', null);
    if (!saved || !saved.a) return;
    stepData = { name: saved.name, raw: null, a: saved.a };
    showStep();
    $('#stepStatus').textContent = `${saved.name}: gespeicherte Analyse. Für die 3D-Vorschau die Datei erneut laden.`;
  })();
  const startTab = document.getElementById(ui.tab) || $('#tab-calc');
  showTab(startTab);
})();
