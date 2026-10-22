/*
 * Reference data for the CNC milling cost model.
 * Every value is a default the shop can override in the settings panel.
 * Sources and reasoning: docs/METHODOLOGY.md
 *
 * Material fields
 *   density   g/cm³
 *   price     €/kg, small-quantity cut-to-size price (net, 2026)
 *   qRough    effective roughing removal rate on the reference 3-axis VMC, cm³/min
 *             (average over a job incl. small tools and air cuts, not the catalogue peak)
 *   kc        specific cutting force, N/mm² (for the spindle power limit)
 *   finish    effective finishing rate, cm²/min at Ra 3.2
 *   drillFeed drilling feed with carbide drill, mm/min
 *   toolCost  tool wear per spindle hour, €/h
 *   faceFeed  face milling feed rate vf, mm/min
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CNCData = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const materials = [
    { id: 'al6082', group: 'Aluminium', name: 'EN AW-6082 T6 (AlSi1MgMn)', density: 2.70, price: 9.5, qRough: 120, kc: 800, finish: 60, drillFeed: 600, toolCost: 3, faceFeed: 3000 },
    { id: 'al7075', group: 'Aluminium', name: 'EN AW-7075 T651 (AlZn5,5MgCu)', density: 2.81, price: 16, qRough: 110, kc: 850, finish: 60, drillFeed: 550, toolCost: 3.5, faceFeed: 3000 },
    { id: 'al5083', group: 'Aluminium', name: 'EN AW-5083 (AlMg4,5Mn0,7)', density: 2.66, price: 8.5, qRough: 95, kc: 750, finish: 50, drillFeed: 500, toolCost: 3, faceFeed: 2500 },
    { id: 's235', group: 'Stahl', name: 'S235JR (1.0038)', density: 7.85, price: 2.8, qRough: 40, kc: 1800, finish: 28, drillFeed: 160, toolCost: 6, faceFeed: 900 },
    { id: 'c45', group: 'Stahl', name: 'C45 (1.0503)', density: 7.85, price: 3.5, qRough: 35, kc: 2000, finish: 25, drillFeed: 150, toolCost: 6.5, faceFeed: 800 },
    { id: '42crmo4', group: 'Stahl', name: '42CrMo4+QT (1.7225), vergütet', density: 7.85, price: 4.5, qRough: 25, kc: 2300, finish: 20, drillFeed: 110, toolCost: 8, faceFeed: 600 },
    { id: '12312', group: 'Stahl', name: '1.2312 Werkzeugstahl, vorvergütet', density: 7.85, price: 6.5, qRough: 25, kc: 2200, finish: 20, drillFeed: 110, toolCost: 8, faceFeed: 600 },
    { id: 'gjl250', group: 'Guss', name: 'EN-GJL-250 Grauguss', density: 7.20, price: 3.5, qRough: 50, kc: 1200, finish: 30, drillFeed: 200, toolCost: 5, faceFeed: 1000 },
    { id: '14305', group: 'Edelstahl', name: '1.4305 (V2A, Automatenqualität)', density: 7.90, price: 7.5, qRough: 22, kc: 2100, finish: 17, drillFeed: 90, toolCost: 9, faceFeed: 550 },
    { id: '14301', group: 'Edelstahl', name: '1.4301 (V2A)', density: 7.90, price: 7, qRough: 18, kc: 2300, finish: 15, drillFeed: 80, toolCost: 10, faceFeed: 500 },
    { id: '14404', group: 'Edelstahl', name: '1.4404 (V4A)', density: 8.00, price: 13, qRough: 15, kc: 2400, finish: 14, drillFeed: 70, toolCost: 11, faceFeed: 450 },
    { id: 'cw614n', group: 'Buntmetall', name: 'Messing CW614N (CuZn39Pb3)', density: 8.47, price: 11, qRough: 100, kc: 750, finish: 55, drillFeed: 450, toolCost: 3, faceFeed: 2500 },
    { id: 'cuetp', group: 'Buntmetall', name: 'Kupfer Cu-ETP (CW004A)', density: 8.93, price: 12, qRough: 45, kc: 1100, finish: 30, drillFeed: 200, toolCost: 6, faceFeed: 1200 },
    { id: 'ti64', group: 'Titan', name: 'Titan Grade 5 (Ti6Al4V)', density: 4.43, price: 75, qRough: 10, kc: 1500, finish: 10, drillFeed: 60, toolCost: 18, faceFeed: 300 },
    { id: 'pomc', group: 'Kunststoff', name: 'POM-C (Acetal)', density: 1.41, price: 12, qRough: 200, kc: 300, finish: 80, drillFeed: 800, toolCost: 1.5, faceFeed: 4000 },
    { id: 'pa6', group: 'Kunststoff', name: 'PA6 (Polyamid)', density: 1.14, price: 9, qRough: 180, kc: 300, finish: 70, drillFeed: 700, toolCost: 1.5, faceFeed: 3500 },
    { id: 'peek', group: 'Kunststoff', name: 'PEEK natur', density: 1.31, price: 200, qRough: 120, kc: 400, finish: 60, drillFeed: 500, toolCost: 3, faceFeed: 2500 },
  ];

  /*
   * Machine hour rate inputs follow VDI 3258: depreciation, imputed interest on half
   * the replacement value, floor space, energy, maintenance, divided by run hours.
   * Labour and remaining production overhead (Rest-FGK) are added on top to get the
   * workplace rate (Platzkostensatz). Most shops know their rate per machine already
   * (e.g. 80 €/h, 90 €/h): rateMode 'direct' uses that number, 'vdi' derives it.
   * calibration scales the computed cycle time after comparing it with real run times.
   */
  const machines = [
    {
      id: 'vmc3', axes: 3, rateMode: 'direct', rate: 80, calibration: 1, name: '3-Achs-Bearbeitungszentrum', qFactor: 1.0, finishFactor: 1.0, camFactor: 1.0,
      spindleKw: 15, efficiency: 0.8,
      vdi: { price: 180000, years: 10, interest: 6, area: 20, rent: 120, powerKw: 20, load: 50, energyPrice: 0.22, maintenance: 4, hours: 3000 },
      wage: 22,
    },
    {
      id: 'hsc3', axes: 3, rateMode: 'direct', rate: 85, calibration: 1, name: '3-Achs HSC (Alu/Kunststoff)', qFactor: 1.35, finishFactor: 1.3, camFactor: 1.0,
      spindleKw: 18, efficiency: 0.8,
      vdi: { price: 260000, years: 10, interest: 6, area: 22, rent: 120, powerKw: 25, load: 50, energyPrice: 0.22, maintenance: 4, hours: 3000 },
      wage: 22,
    },
    {
      id: 'ax5', axes: 5, rateMode: 'direct', rate: 110, calibration: 1, name: '5-Achs-Bearbeitungszentrum', qFactor: 1.05, finishFactor: 1.1, camFactor: 1.4,
      spindleKw: 20, efficiency: 0.8,
      vdi: { price: 450000, years: 10, interest: 6, area: 28, rent: 120, powerKw: 30, load: 50, energyPrice: 0.22, maintenance: 4, hours: 3000 },
      wage: 25,
    },
    {
      id: 'small', axes: 3, active: false, rateMode: 'direct', rate: 55, calibration: 1, name: 'Kleine Fräse / Portal (bis 3 kW)', qFactor: 0.45, finishFactor: 0.7, camFactor: 1.0,
      spindleKw: 2.2, efficiency: 0.8,
      vdi: { price: 35000, years: 8, interest: 6, area: 8, rent: 120, powerKw: 4, load: 50, energyPrice: 0.22, maintenance: 4, hours: 1600 },
      wage: 20,
    },
  ];

  /* General tolerance of the drawing (ISO 2768-1) — applies to the whole part. */
  const generalTolerances = [
    { id: 'c', name: 'ISO 2768-c (grob)', finishFactor: 0.9, inspectMin: 1, scrap: 0.5 },
    { id: 'm', name: 'ISO 2768-m (mittel, Standard)', finishFactor: 1.0, inspectMin: 2, scrap: 1.0 },
    { id: 'f', name: 'ISO 2768-f (fein)', finishFactor: 1.15, inspectMin: 3, scrap: 1.5 },
  ];

  /*
   * Toleranced features tighter than the general tolerance.
   * passMin  machine minutes for one extra finishing pass on the feature (incl. probing);
   *          fits (from IT9) get strategy.fitPasses passes, the shop default is 2
   * inspMin  extra measuring minutes per feature and part
   * scrap    scrap rate in % once at least one feature of this class exists
   * camMin   extra CAM/preparation minutes per feature (one-time)
   */
  const tightTolerances = [
    { id: 't100', label: '±0,1 mm', it: 'IT11', passMin: 0.2, fit: false, inspMin: 0.3, scrap: 1.0, camMin: 0 },
    { id: 't050', label: '±0,05 mm', it: 'IT9', passMin: 0.35, fit: true, inspMin: 0.6, scrap: 2.0, camMin: 2 },
    { id: 't020', label: '±0,02 mm', it: 'IT7', passMin: 0.75, fit: true, inspMin: 1.2, scrap: 4.0, camMin: 4 },
    { id: 't010', label: '±0,01 mm', it: 'IT6', passMin: 1.5, fit: true, inspMin: 2.5, scrap: 7.0, camMin: 6, warn: 'Toleranz ±0,01 mm: klimatisierte Fertigung und Messraum nötig, oft Reiben oder Feinbohren.' },
    { id: 't005', label: '±0,005 mm', it: 'IT5', passMin: 3.0, fit: true, inspMin: 4.0, scrap: 12.0, camMin: 10, warn: 'Toleranz ±0,005 mm liegt außerhalb normaler Fräsgenauigkeit: Schleifen oder Läppen einplanen.' },
  ];

  /* Surface roughness of the finished faces. factor multiplies finishing time,
     polishMin is manual polishing in minutes per dm² of finished surface. */
  const roughness = [
    { id: 'ra63', label: 'Ra 6,3 µm (geschruppt-fein)', factor: 0.8 },
    { id: 'ra32', label: 'Ra 3,2 µm (Standard gefräst)', factor: 1.0 },
    { id: 'ra16', label: 'Ra 1,6 µm (feingeschlichtet)', factor: 1.5 },
    { id: 'ra08', label: 'Ra 0,8 µm (sehr fein)', factor: 2.3, inspAdd: 1, polishMin: 0.5 },
    { id: 'ra04', label: 'Ra 0,4 µm (Schleifen/Polieren)', factor: 4.0, inspAdd: 2, polishMin: 3, warn: 'Ra 0,4 µm ist mit Fräsen allein kaum prozesssicher: Schleifen oder Polieren einplanen.' },
  ];

  /* Part complexity as seen from the CAM side. */
  const complexity = [
    { id: 1, label: 'Einfach: Platte, Bohrungen, offene Konturen', qFactor: 1.0, camFactor: 0.6, deburrMin: 1.5, surfaceFactor: 1.1 },
    { id: 2, label: 'Normal: Taschen, Absätze, Gewinde', qFactor: 0.85, camFactor: 1.0, deburrMin: 3, surfaceFactor: 1.3 },
    { id: 3, label: 'Anspruchsvoll: tiefe Taschen, dünne Wände', qFactor: 0.7, camFactor: 1.6, deburrMin: 5, surfaceFactor: 1.6 },
    { id: 4, label: 'Komplex: Freiformflächen, viele Merkmale', qFactor: 0.55, camFactor: 2.5, deburrMin: 8, surfaceFactor: 2.0 },
    { id: 5, label: 'Sehr komplex: Mikromerkmale, 5-Achs-Simultan', qFactor: 0.4, camFactor: 4.0, deburrMin: 12, surfaceFactor: 2.5 },
  ];

  /* Clamping concept: per-part load/unload time and one-time setup effort. */
  const fixtures = [
    { id: 'vise', label: 'Schraubstock', clampMin: 1.5, setupMin: 0, cost: 0 },
    { id: 'softjaw', label: 'Weiche Backen (gefräst)', clampMin: 1.2, setupMin: 30, cost: 25 },
    { id: 'fixture', label: 'Sondervorrichtung', clampMin: 1.0, setupMin: 60, cost: 250 },
    { id: 'vacuum', label: 'Vakuumspanntisch', clampMin: 0.8, setupMin: 15, cost: 0 },
    { id: 'zero', label: 'Nullpunktspannsystem', clampMin: 0.5, setupMin: 10, cost: 0 },
  ];

  /*
   * External or in-house finishing. unit: 'dm2' (surface), 'kg' (mass) or 'pc' (piece).
   * minLot is the minimum charge per batch typical for subcontractors.
   */
  const finishes = [
    { id: 'none', label: 'Keine', unit: 'pc', price: 0, minLot: 0, metals: 'all' },
    { id: 'bead', label: 'Glasperlstrahlen', unit: 'dm2', price: 0.25, minLot: 30, metals: 'all' },
    { id: 'anod', label: 'Eloxieren E6/EV1 natur', unit: 'dm2', price: 0.55, minLot: 80, metals: 'Aluminium' },
    { id: 'anodc', label: 'Eloxieren farbig (schwarz, rot …)', unit: 'dm2', price: 0.75, minLot: 90, metals: 'Aluminium' },
    { id: 'hard', label: 'Harteloxieren', unit: 'dm2', price: 1.5, minLot: 120, metals: 'Aluminium' },
    { id: 'powder', label: 'Pulverbeschichten', unit: 'dm2', price: 0.6, minLot: 60, metals: 'metal' },
    { id: 'zinc', label: 'Galvanisch verzinken + Passivieren', unit: 'dm2', price: 0.4, minLot: 50, metals: 'Stahl' },
    { id: 'black', label: 'Brünieren', unit: 'dm2', price: 0.3, minLot: 40, metals: 'Stahl' },
    { id: 'nickel', label: 'Chemisch Nickel', unit: 'dm2', price: 1.8, minLot: 120, metals: 'metal' },
    { id: 'harden', label: 'Härten / Vergüten', unit: 'kg', price: 4, minLot: 90, metals: 'Stahl' },
    { id: 'passiv', label: 'Beizen + Passivieren', unit: 'dm2', price: 0.35, minLot: 60, metals: 'Edelstahl' },
  ];

  /*
   * Shop-wide defaults. All percentages are in percent.
   * strategy is the shop's own machining strategy; two shops with different tools get
   * different times for the same part (e.g. Ø63 vs Ø100 face mill on an 80 mm plate).
   */
  const defaults = {
    strategy: {
      faceMillD: 63,      // largest face mill the spindle takes, mm
      faceStepover: 85,   // usable cutter width in % of the diameter (Ø100 covers an 80 mm plate in one track)
      faceOverrun: 10,    // approach + overrun beyond the cutter diameter, mm
      faceStock: 1,       // stock per faced side that the face mill removes, mm
      fitPasses: 2,       // finishing passes around every fit (Passmaß)
      threadMethod: 'tap', // 'tap' rigid tapping or 'mill' thread milling
    },
    labour: { nonWageCosts: 25, productiveShare: 80, restOverhead: 120, multiMachine: 1 },
    camRate: 85,
    manualRate: 58,
    qsRate: 75,
    cmmRate: 95,
    material: { allowance: 3, sawKerf: 3, cutCost: 2.5, overhead: 8, minCharge: 5 },
    tool: { changeMin: 0.15, setupPerToolMin: 3, setupBaseMin: 30 },
    finishHandling: 10,
    finishTransport: 25,
    salesOverhead: 12,
    profit: 10,
    discount: 0,
    cashDiscount: 2,
    vat: 19,
    packagingLot: 8,
    packagingPart: 0.4,
    shipping: 12,
    airCutShare: 10,
    cert31: 25,
    faiHours: 1.5,
    minOrder: 60,
    leadBaseDays: 5,    // order backlog and material procurement before machining starts
  };

  return { materials, machines, generalTolerances, tightTolerances, roughness, complexity, fixtures, finishes, defaults };
});
