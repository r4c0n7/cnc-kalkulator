/*
 * CNC milling cost engine.
 * Pure functions, no DOM. Works in the browser (window.CNCCalc) and in Node (require).
 * The calculation scheme follows the German Zuschlagskalkulation with machine hour rates:
 *   material cost + production cost (machine hours × workplace rate) + one-time costs
 *   = manufacturing cost, + sales/admin overhead = cost price, + profit = net price.
 * Formulas and sources: docs/METHODOLOGY.md
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./data.js'));
  else root.CNCCalc = factory(root.CNCData);
})(typeof self !== 'undefined' ? self : this, function (DATA) {
  const pct = (v) => (Number(v) || 0) / 100;
  const num = (v, d = 0) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? d : Number(v));
  const byId = (list, id) => list.find((x) => String(x.id) === String(id));
  const round2 = (v) => Math.round(v * 100) / 100;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* Merge user settings over the reference data, one level deep for lists by id. */
  function resolveSettings(overrides) {
    const s = clone(DATA);
    if (!overrides) return s;
    for (const key of Object.keys(overrides)) {
      const val = overrides[key];
      if (Array.isArray(s[key]) && val && typeof val === 'object' && !Array.isArray(val)) {
        for (const id of Object.keys(val)) {
          const item = byId(s[key], id);
          if (item) deepAssign(item, val[id]);
          // shop-defined entries (e.g. an own machine) copy an existing one via `base`
          else if (val[id] && val[id].base && byId(s[key], val[id].base)) {
            s[key].push(deepAssign({ ...clone(byId(s[key], val[id].base)), id }, val[id]));
          }
        }
      } else if (s[key] && typeof s[key] === 'object' && !Array.isArray(s[key])) {
        deepAssign(s[key], val);
      } else {
        s[key] = val;
      }
    }
    return s;
  }

  function deepAssign(target, src) {
    for (const k of Object.keys(src || {})) {
      if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && target[k] && typeof target[k] === 'object') deepAssign(target[k], src[k]);
      else target[k] = src[k];
    }
    return target;
  }

  /*
   * Machine hour rate after VDI 3258 (machine only, no labour).
   * Imputed interest is charged on half the replacement value (average tied-up capital).
   */
  function machineHourRate(v) {
    const depreciation = num(v.price) / Math.max(1, num(v.years, 1));
    const interest = (num(v.price) / 2) * pct(v.interest);
    const space = num(v.area) * num(v.rent);
    const energy = num(v.powerKw) * pct(v.load) * num(v.energyPrice) * num(v.hours);
    const maintenance = num(v.price) * pct(v.maintenance);
    const yearly = depreciation + interest + space + energy + maintenance;
    const hours = Math.max(1, num(v.hours, 1));
    return { depreciation, interest, space, energy, maintenance, yearly, hours, perHour: yearly / hours };
  }

  /*
   * Labour cost per productive hour: gross wage + employer on-costs, divided by the
   * share of paid hours that are productive (holidays, sickness, training), divided by
   * the number of machines one operator runs. Remaining production overhead (Rest-FGK:
   * supervision, work preparation, QA staff, building rest) is a surcharge on it.
   */
  function labourRate(wage, labour) {
    const effective = (num(wage) * (1 + pct(labour.nonWageCosts))) / Math.max(0.01, pct(labour.productiveShare)) / Math.max(1, num(labour.multiMachine, 1));
    const restOverhead = effective * pct(labour.restOverhead);
    return { effective, restOverhead, perHour: effective + restOverhead };
  }

  /* The rate charged per machine hour: the shop's own number, or derived per VDI 3258. */
  function workplaceRate(machine, settings) {
    const m = machineHourRate(machine.vdi);
    const l = labourRate(machine.wage, settings.defaults.labour);
    const derived = m.perHour + l.perHour;
    const direct = machine.rateMode !== 'vdi' && num(machine.rate) > 0;
    return { machine: m, labour: l, derived, perHour: direct ? num(machine.rate) : derived, mode: direct ? 'direct' : 'vdi' };
  }

  /*
   * Face milling with the shop's face mill: the number of tracks follows from the
   * part width and the usable cutter width, each track runs the part length plus the
   * cutter diameter plus overrun. A Ø63 cutter on an 80 mm wide plate needs 2 tracks,
   * a Ø100 cutter only 1.
   */
  function facing(width, length, strategy, feed) {
    const d = Math.max(1, num(strategy.faceMillD, 63));
    const usable = d * pct(num(strategy.faceStepover, 85));
    const tracks = width > 0 ? Math.max(1, Math.ceil(width / usable)) : 0;
    const path = tracks * (length + d + num(strategy.faceOverrun, 10));
    return { tracks, path, minutes: feed > 0 ? path / feed : 0 };
  }

  /* ---------- geometry ---------- */

  function geometry(input, mat, cx, d) {
    const a = num(input.allowance, d.material.allowance);
    const kerf = num(d.material.sawKerf);
    const x = num(input.x), y = num(input.y), z = num(input.z);
    let boxVol, blankVol, boughtVol, boxSurface;
    if (input.shape === 'round') {
      const dia = num(input.diameter), len = num(input.length);
      const bd = dia + 2 * a, bl = len + 2 * a;
      boxVol = (Math.PI / 4) * dia * dia * len / 1000;
      blankVol = (Math.PI / 4) * bd * bd * bl / 1000;
      boughtVol = (Math.PI / 4) * bd * bd * (bl + kerf) / 1000;
      boxSurface = (Math.PI * dia * len + 2 * (Math.PI / 4) * dia * dia) / 100;
    } else {
      const bx = x + 2 * a, by = y + 2 * a, bz = z + 2 * a;
      boxVol = x * y * z / 1000;
      blankVol = bx * by * bz / 1000;
      boughtVol = (bx + kerf) * by * bz / 1000;
      boxSurface = 2 * (x * y + x * z + y * z) / 100;
    }
    const partVol = num(input.partVolume) > 0 ? num(input.partVolume) : boxVol * pct(num(input.fill, 60));
    const removedVol = Math.max(0, blankVol - partVol);
    const surface = num(input.surfaceArea) > 0 ? num(input.surfaceArea) : boxSurface * cx.surfaceFactor;
    const finishArea = num(input.finishArea) > 0 ? num(input.finishArea) : surface;
    return {
      boxVol, blankVol, boughtVol, partVol, removedVol, surface, finishArea,
      blankMass: boughtVol * mat.density / 1000,
      partMass: partVol * mat.density / 1000,
      removedShare: blankVol > 0 ? removedVol / blankVol : 0,
      invalid: partVol > blankVol || boxVol <= 0,
    };
  }

  /* ---------- the calculation ---------- */

  function calculate(input, overrides) {
    const S = resolveSettings(overrides);
    const d = S.defaults;
    const mat = byId(S.materials, input.materialId) || S.materials[0];
    const mach = byId(S.machines, input.machineId) || S.machines[0];
    const cx = byId(S.complexity, input.complexity) || S.complexity[1];
    const gt = byId(S.generalTolerances, input.generalTol) || S.generalTolerances[1];
    const ra = byId(S.roughness, input.roughness) || S.roughness[1];
    const fx = byId(S.fixtures, input.fixture) || S.fixtures[0];
    const fin = byId(S.finishes, input.finish) || S.finishes[0];
    const qty = Math.max(1, Math.round(num(input.quantity, 1)));
    const setups = Math.max(1, Math.round(num(input.setups, 1)));
    const tools = Math.max(1, Math.round(num(input.tools, 6)));
    const holes = Math.max(0, num(input.holes));
    const threads = Math.max(0, num(input.threads));
    const holeDepth = Math.max(0, num(input.holeDepth, 10));
    const pockets = Math.max(0, num(input.pockets));
    const tight = (input.tight || [])
      .map((t) => ({ tol: byId(S.tightTolerances, t.tol), count: Math.max(0, num(t.count)) }))
      .filter((t) => t.tol && t.count > 0);
    const repeat = !!input.repeat;

    const rate = workplaceRate(mach, S);
    const geo = geometry(input, mat, cx, d);
    const warnings = [];

    /* removal rate: material × machine × complexity, capped by spindle power */
    const qTech = mat.qRough * mach.qFactor * cx.qFactor;
    const qPower = (mach.spindleKw * mach.efficiency * 60000) / mat.kc;
    const q = Math.min(qTech, qPower);
    if (qPower < qTech) warnings.push(`Spindelleistung begrenzt das Zeitspanvolumen auf ${qPower.toFixed(0)} cm³/min.`);

    /* face milling of the large flat sides with the shop's face mill */
    const st = d.strategy;
    const faceLen = input.shape === 'round' ? num(input.length) : Math.max(num(input.x), num(input.y));
    const faceWid = input.shape === 'round' ? num(input.diameter) : Math.min(num(input.x), num(input.y));
    const facedSides = Math.max(0, Math.round(num(input.facedSides, Math.min(setups, 2))));
    const face = facing(faceWid, faceLen, st, mat.faceFeed || mat.finish * 40);
    const facedArea = facedSides * faceLen * faceWid / 100;
    const facedVol = facedSides * faceLen * faceWid * num(st.faceStock, 1) / 1000;

    /* minutes per part */
    const tFace = facedSides * face.minutes;
    const tRough = Math.max(0, geo.removedVol - facedVol) / q;
    const tFinish = (Math.max(0, geo.finishArea - facedArea) / (mat.finish * mach.finishFactor)) * ra.factor * gt.finishFactor;
    const tHole = 0.1 + (holeDepth / mat.drillFeed) * 1.3;
    const tDrill = holes * tHole;
    const tThreadOne = st.threadMethod === 'mill'
      ? 0.4 + 0.6 * Math.sqrt(150 / mat.drillFeed)
      : 0.1 + 0.3 * Math.sqrt(150 / mat.drillFeed);
    const tTap = threads * (tHole + tThreadOne);
    const tTight = tight.reduce((s, t) => s + t.count * t.tol.passMin * (t.tol.fit ? Math.max(1, num(st.fitPasses, 2)) : 1), 0);
    const tToolChange = (tools + 2 * (setups - 1)) * d.tool.changeMin;
    const calibration = num(mach.calibration, 1) > 0 ? num(mach.calibration, 1) : 1;
    const tCutRaw = (tFace + tRough + tFinish + tDrill + tTap + tTight) * (1 + pct(d.airCutShare)) + tToolChange;
    const tCut = tCutRaw * calibration;
    const tClamp = setups * fx.clampMin;
    const tMachine = tCut + tClamp;
    const hardToCut = ['Edelstahl', 'Titan'].includes(mat.group) ? 1.4 : 1;
    const tDeburr = input.deburr === false ? 0 : cx.deburrMin * hardToCut;
    const tPolish = (ra.polishMin || 0) * (geo.finishArea / 100) * hardToCut;
    const tInspect = gt.inspectMin + tight.reduce((s, t) => s + t.count * t.tol.inspMin, 0) + (ra.inspAdd || 0);
    const tCmm = input.cmm ? 5 + tight.reduce((s, t) => s + t.count, 0) : 0;

    /* scrap: the worst class present decides */
    const scrapPct = Math.max(gt.scrap, ...tight.map((t) => t.tol.scrap));
    const yieldF = 1 / (1 - pct(scrapPct));

    /* one-time effort */
    let setupMin = setups * d.tool.setupBaseMin + tools * d.tool.setupPerToolMin + fx.setupMin;
    let camHours = (0.4 + 0.3 * setups + 0.08 * pockets + 0.015 * holes + 0.03 * threads
      + tight.reduce((s, t) => s + t.count * t.tol.camMin, 0) / 60) * cx.camFactor * mach.camFactor;
    if (repeat) { setupMin *= 0.7; camHours = 0.1; }

    /* ---------- cost lines (per lot, net, before overhead) ---------- */
    const lines = [];
    const add = (group, label, amount, kind, note) => lines.push({ group, label, amount: amount || 0, kind, note });

    // material
    if (!input.materialProvided) {
      const raw = geo.blankMass * mat.price * qty * yieldF;
      const cut = d.material.cutCost * qty * yieldF;
      const mgk = (raw + cut) * pct(d.material.overhead);
      const matTotal = Math.max(d.material.minCharge, raw + cut + mgk);
      add('Material', `Rohteil ${mat.name}`, matTotal - mgk - cut, 'var', `${fmt(geo.blankMass, 3)} kg × ${fmt(mat.price)} €/kg je Stück`);
      add('Material', 'Zuschnitt (Säge)', cut, 'var', `${fmt(d.material.cutCost)} € je Stück`);
      add('Material', 'Materialgemeinkosten', mgk, 'var', `${d.material.overhead} % (Einkauf, Lager, Prüfung)`);
    } else {
      add('Material', 'Material beigestellt', 0, 'var', 'vom Kunden geliefert');
    }

    // production
    const machHours = (tMachine / 60) * qty * yieldF;
    add('Fertigung', `Maschinenzeit ${mach.name}`, machHours * rate.perHour, 'var', `${fmt(tMachine, 1)} min × ${fmt(rate.perHour)} €/h je Stück`);
    add('Fertigung', 'Werkzeugverschleiß', (tCut / 60) * qty * yieldF * mat.toolCost, 'var', `${fmt(mat.toolCost)} €/Spindelstunde`);
    if (tPolish > 0) add('Fertigung', 'Polieren (Hand)', (tPolish / 60) * qty * yieldF * d.manualRate, 'var', `${fmt(tPolish, 1)} min je Stück`);
    if (tDeburr > 0) add('Fertigung', 'Entgraten (Hand)', (tDeburr / 60) * qty * yieldF * d.manualRate, 'var', `${fmt(tDeburr, 1)} min je Stück`);
    add('Qualität', 'Maßprüfung', (tInspect / 60) * qty * d.qsRate, 'var', `${fmt(tInspect, 1)} min je Stück`);
    if (tCmm > 0) add('Qualität', 'KMG-Messung', (tCmm / 60) * qty * d.cmmRate, 'var', `${fmt(tCmm, 1)} min je Stück`);

    // one-time
    add('Einmalig', 'Rüsten', (setupMin / 60) * rate.perHour, 'once', `${fmt(setupMin, 0)} min`);
    add('Einmalig', 'CAM-Programmierung', camHours * d.camRate, 'once', repeat ? 'Wiederholteil: Programm prüfen' : `${fmt(camHours, 2)} h × ${fmt(d.camRate)} €/h`);
    if (fx.cost > 0 && !repeat) add('Einmalig', `Spannmittel: ${fx.label}`, fx.cost, 'once');
    if (num(input.specialTools) > 0) add('Einmalig', 'Sonderwerkzeuge', num(input.specialTools), 'once');
    if (input.fai) add('Einmalig', 'Erstmusterprüfbericht (EMPB)', d.faiHours * d.qsRate, 'once', `${fmt(d.faiHours)} h`);
    if (input.cert31) add('Einmalig', 'Werkszeugnis 3.1 (EN 10204)', d.cert31, 'once');

    // finishing
    if (fin.id !== 'none') {
      const units = fin.unit === 'dm2' ? geo.surface / 100 : fin.unit === 'kg' ? geo.partMass : 1;
      const base = Math.max(fin.minLot, units * fin.price * qty);
      const total = base * (1 + pct(d.finishHandling)) + d.finishTransport;
      add('Oberfläche', fin.label, total, 'var', `${fmt(units, 2)} ${fin.unit === 'dm2' ? 'dm²' : fin.unit} je Stück, Mindestpauschale ${fmt(fin.minLot)} €`);
      if (!finishFits(fin, mat)) warnings.push(`${fin.label} passt nicht zu ${mat.group}.`);
    }

    // ---------- Zuschlagskalkulation ----------
    const manufacturing = lines.reduce((s, l) => s + l.amount, 0);
    const salesOverhead = manufacturing * pct(d.salesOverhead);
    const costPrice = manufacturing + salesOverhead;
    const logistics = d.packagingLot + d.packagingPart * qty + (input.shipping === false ? 0 : d.shipping);
    const profit = (costPrice + logistics) * pct(d.profit);
    const cashPrice = costPrice + logistics + profit;
    const targetPrice = cashPrice / (1 - pct(d.cashDiscount));
    let net = targetPrice / (1 - pct(d.discount));
    const minOrderApplied = net < d.minOrder;
    if (minOrderApplied) net = d.minOrder;
    const vat = net * pct(d.vat);

    const oneTime = lines.filter((l) => l.kind === 'once').reduce((s, l) => s + l.amount, 0);
    const markup = net / Math.max(0.01, manufacturing + logistics);

    // warnings from tolerance and surface data
    tight.forEach((t) => t.tol.warn && warnings.push(t.tol.warn));
    if (ra.warn) warnings.push(ra.warn);
    if (geo.invalid) warnings.push('Fertigteilvolumen ist größer als das Rohteil: Maße oder Volumen prüfen.');
    if (setups > 3 && mach.id !== 'ax5') warnings.push(`${setups} Aufspannungen: 5-Achs-Bearbeitung könnte Rüst- und Spannzeit sparen.`);
    if (minOrderApplied) warnings.push(`Mindestauftragswert ${fmt(d.minOrder)} € angewendet.`);

    // lead time: CAM + production on one shift-pair (14 h/day) + external finishing
    const prodHours = setupMin / 60 + machHours;
    const leadDays = Math.ceil(num(d.leadBaseDays, 5) + camHours / 6 + prodHours / 14 + (fin.id !== 'none' ? 5 : 0) + (input.fai ? 1 : 0));

    return {
      input: { ...input, quantity: qty, setups, tools },
      material: mat, machine: mach, rate, geo,
      times: { tFace, tRough, tFinish, tDrill, tTap, tTight, tToolChange, tCutRaw, tCut, tClamp, tMachine, tDeburr, tPolish, tInspect, tCmm, setupMin, camHours, q, qTech, qPower, calibration },
      face: { ...face, sides: facedSides, cutterD: num(st.faceMillD) },
      scrapPct, lines,
      check: targetCheck(input, qty, costPrice + logistics, net),
      totals: {
        manufacturing, salesOverhead, costPrice, logistics, profit, cashPrice, targetPrice, net, vat,
        gross: net + vat, perPart: net / qty, oneTime, oneTimeShare: oneTime / Math.max(0.01, manufacturing), markup,
      },
      leadDays, warnings,
    };
  }

  /*
   * Does a target price per part (from the customer or a platform) pay off for us?
   * Below the cost price we lose money, between cost price and our net price we earn
   * less than the planned profit.
   */
  function targetCheck(input, qty, costLot, netLot) {
    const target = num(input.targetPrice);
    if (!(target > 0)) return null;
    const revenue = target * qty;
    const result = revenue - costLot;
    const status = revenue >= netLot - 0.005 ? 'ok' : result >= 0 ? 'tight' : 'loss';
    return { target, revenue, result, margin: result / revenue, status, ourPerPart: netLot / qty, costPerPart: costLot / qty };
  }

  /*
   * Calibration: compare the computed cycle time with a measured run time of a real part
   * on the same machine. The factor is stored on the machine and scales later estimates.
   */
  function calibrationFactor(input, overrides, measuredMin) {
    const r = calculate(input, overrides);
    const raw = r.times.tCutRaw;
    return raw > 0 && num(measuredMin) > 0 ? num(measuredMin) / raw : 1;
  }

  function finishFits(fin, mat) {
    if (fin.metals === 'all') return true;
    if (fin.metals === 'metal') return mat.group !== 'Kunststoff';
    return fin.metals === mat.group;
  }

  /* Unit price over a list of quantities: shows how one-time costs spread out. */
  function quantityCurve(input, overrides, quantities) {
    const qs = quantities || [1, 2, 5, 10, 25, 50, 100, 250, 500];
    return qs.map((q) => {
      const r = calculate({ ...input, quantity: q }, overrides);
      return { quantity: q, perPart: r.totals.perPart, net: r.totals.net, oneTimePerPart: r.totals.oneTime * r.totals.markup / q };
    });
  }

  /*
   * Design-for-manufacturing hints: re-run the calculation with one requirement relaxed
   * and report the saving. Only alternatives that actually save money are returned.
   */
  function savingsHints(input, overrides) {
    const base = calculate(input, overrides).totals.net;
    const S = resolveSettings(overrides);
    const hints = [];
    const tryAlt = (label, alt) => {
      const r = calculate({ ...input, ...alt }, overrides).totals.net;
      if (base - r > 0.5) hints.push({ label, saving: base - r, share: (base - r) / base });
    };
    if (input.generalTol === 'f') tryAlt('Allgemeintoleranz ISO 2768-m statt -f', { generalTol: 'm' });
    const tight = input.tight || [];
    tight.forEach((t, i) => {
      const idx = S.tightTolerances.findIndex((x) => x.id === t.tol);
      if (idx > 0 && num(t.count) > 0) {
        const looser = S.tightTolerances[idx - 1];
        const next = tight.map((x, j) => (j === i ? { ...x, tol: looser.id } : x));
        const cur = S.tightTolerances[idx];
        tryAlt(`${t.count}× ${cur.label} auf ${looser.label} öffnen`, { tight: next });
      }
    });
    const raIdx = S.roughness.findIndex((x) => x.id === input.roughness);
    if (raIdx > 1) tryAlt('Oberfläche Ra 3,2 statt feiner (nur Funktionsflächen fein)', { roughness: 'ra32' });
    if (input.materialId === '14301') tryAlt('1.4305 statt 1.4301 (bessere Zerspanbarkeit, wenn nicht geschweißt wird)', { materialId: '14305' });
    if (num(input.setups) > 2) tryAlt('Eine Aufspannung weniger (Bauteil umkonstruieren)', { setups: num(input.setups) - 1 });
    const qty = Math.max(1, num(input.quantity, 1));
    const perNow = base / qty;
    const dbl = calculate({ ...input, quantity: qty * 2 }, overrides).totals.perPart;
    if (perNow - dbl > 0.5) hints.push({ label: `Bei ${qty * 2} Stück sinkt der Stückpreis auf ${fmt(dbl)} €`, saving: (perNow - dbl) * qty, share: (perNow - dbl) / perNow, perPart: true });
    return hints.sort((a, b) => b.saving - a.saving);
  }

  function fmt(v, digits = 2) {
    return Number(v || 0).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  return { calculate, quantityCurve, savingsHints, machineHourRate, labourRate, workplaceRate, facing, calibrationFactor, targetCheck, resolveSettings, geometry, fmt, round2, data: DATA };
});
