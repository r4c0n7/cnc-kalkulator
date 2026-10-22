/*
 * STEP import and geometry analysis.
 * The STEP file is triangulated in the browser by occt-import-js (OpenCascade compiled
 * to WebAssembly, loaded from jsDelivr). The file never leaves the browser.
 * analyze() works on the triangulated result and is plain JS, so it is testable in Node.
 *
 * What is derived from the model:
 *   bounding box (sorted so x ≥ y ≥ z, the part lies on its largest face),
 *   volume (divergence theorem over the closed mesh), surface area,
 *   holes: concave cylindrical B-rep faces grouped by axis and radius,
 *   thread candidates: holes whose diameter matches a metric tap drill,
 *   smallest inner radius (limits the smallest end mill), freeform faces,
 *   suggestions for setups, tools and complexity.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CNCStep = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const OCCT_VERSION = '0.0.23';
  const OCCT_BASE = `https://cdn.jsdelivr.net/npm/occt-import-js@${OCCT_VERSION}/dist/`;

  /* Metric coarse threads: tap drill diameter → thread */
  const TAP_DRILLS = [
    [1.6, 'M2'], [2.05, 'M2,5'], [2.5, 'M3'], [3.3, 'M4'], [4.2, 'M5'], [5.0, 'M6'],
    [6.8, 'M8'], [8.5, 'M10'], [10.2, 'M12'], [12.0, 'M14'], [14.0, 'M16'], [17.5, 'M20'],
  ];

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const norm = (a) => { const l = len(a) || 1; return scale(a, 1 / l); };

  /* Build an orthonormal basis (u, v) perpendicular to axis. */
  function basis(axis) {
    const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(axis, helper));
    return [u, cross(axis, u)];
  }

  /* Algebraic circle fit (Kåsa) on 2D points. Returns centre, radius, rms residual. */
  function fitCircle(pts) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    const n = pts.length;
    for (const [x, y] of pts) {
      const z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
    }
    // solve [sxx sxy sx; sxy syy sy; sx sy n] [a b c]^T = [sxz syz sz]
    const M = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
      [M[i], M[p]] = [M[p], M[i]];
      if (Math.abs(M[i][i]) < 1e-12) return null;
      for (let r = 0; r < 3; r++) {
        if (r === i) continue;
        const f = M[r][i] / M[i][i];
        for (let c = i; c < 4; c++) M[r][c] -= f * M[i][c];
      }
    }
    const a = M[0][3] / M[0][0], b = M[1][3] / M[1][1], c = M[2][3] / M[2][2];
    const cx = a / 2, cy = b / 2;
    const r = Math.sqrt(Math.max(0, c + cx * cx + cy * cy));
    let err = 0;
    for (const [x, y] of pts) err += (Math.hypot(x - cx, y - cy) - r) ** 2;
    return { cx, cy, r, rms: Math.sqrt(err / n) };
  }

  /* Flatten occt meshes into one vertex/triangle list with B-rep face ids. */
  function flatten(result) {
    const verts = [], tris = [], faceOf = [];
    let faceBase = 0;
    for (const mesh of result.meshes || []) {
      const p = mesh.attributes.position.array, idx = mesh.index.array;
      const off = verts.length;
      for (let i = 0; i < p.length; i += 3) verts.push([p[i], p[i + 1], p[i + 2]]);
      const triCount = idx.length / 3;
      const triFace = new Array(triCount).fill(-1);
      (mesh.brep_faces || []).forEach((f, k) => { for (let t = f.first; t <= f.last; t++) triFace[t] = faceBase + k; });
      for (let t = 0; t < triCount; t++) {
        tris.push([idx[3 * t] + off, idx[3 * t + 1] + off, idx[3 * t + 2] + off]);
        faceOf.push(triFace[t] >= 0 ? triFace[t] : faceBase + (mesh.brep_faces || []).length + t);
      }
      faceBase += (mesh.brep_faces || []).length + triCount;
    }
    return { verts, tris, faceOf };
  }

  function analyze(result) {
    const { verts, tris, faceOf } = flatten(result);
    if (!tris.length) throw new Error('Die STEP-Datei enthält keine Volumenkörper.');

    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let i = 0; i < 3; i++) { if (v[i] < min[i]) min[i] = v[i]; if (v[i] > max[i]) max[i] = v[i]; }

    let volume = 0, area = 0;
    const faces = new Map();
    for (let t = 0; t < tris.length; t++) {
      const [a, b, c] = tris[t].map((i) => verts[i]);
      const n = cross(sub(b, a), sub(c, a));
      const A = len(n) / 2;
      volume += dot(a, cross(b, c)) / 6;
      area += A;
      if (A <= 0) continue;
      const f = faceOf[t];
      if (!faces.has(f)) faces.set(f, { normals: [], points: [], cents: [], area: 0 });
      const F = faces.get(f);
      F.normals.push([...norm(n), A]);
      F.cents.push(scale([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]], 1 / 3));
      F.points.push(a, b, c);
      F.area += A;
    }
    volume = Math.abs(volume);

    /* classify every B-rep face */
    const cylinders = [];
    let planarArea = 0, freeformArea = 0;
    for (const F of faces.values()) {
      const n0 = F.normals[0];
      let planar = true;
      for (const n of F.normals) if (dot(n, n0) < 0.999) { planar = false; break; }
      if (planar) { planarArea += F.area; continue; }
      // axis from the most divergent normal pair
      let best = 0, axis = null;
      for (const n of F.normals) {
        const c = cross(n0, n), l = len(c);
        if (l > best) { best = l; axis = c; }
      }
      if (!axis || best < 0.05) { freeformArea += F.area; continue; }
      axis = norm(axis);
      if (F.normals.some((n) => Math.abs(dot(n, axis)) > 0.05)) { freeformArea += F.area; continue; }
      const [u, v] = basis(axis);
      const pts2 = F.points.map((p) => [dot(p, u), dot(p, v)]);
      const fit = fitCircle(pts2);
      if (!fit || fit.r <= 0 || fit.rms > Math.max(0.02 * fit.r, 0.01)) { freeformArea += F.area; continue; }
      const centre = [fit.cx, fit.cy];
      // concave (hole, inner radius) if the face normals point towards the axis
      let inward = 0;
      F.cents.forEach((c, i) => {
        const radial = [dot(c, u) - centre[0], dot(c, v) - centre[1]];
        const nn = F.normals[i];
        if (radial[0] * dot(nn, u) + radial[1] * dot(nn, v) < 0) inward++;
      });
      const angles = pts2.map(([x, y]) => Math.atan2(y - centre[1], x - centre[0]));
      const ax = F.points.map((p) => dot(p, axis));
      cylinders.push({
        axis, u, v, centre, r: fit.r, concave: inward > F.cents.length / 2,
        span: angularSpan(angles), lo: Math.min(...ax), hi: Math.max(...ax), area: F.area,
      });
    }

    /* group concave cylinder faces that share axis line and radius (split hole faces) */
    const groups = [];
    for (const c of cylinders.filter((x) => x.concave)) {
      const g = groups.find((G) => Math.abs(Math.abs(dot(G.axis, c.axis)) - 1) < 1e-3
        && Math.abs(G.r - c.r) < Math.max(0.01, 0.01 * c.r)
        && sameLine(G, c));
      if (g) { g.span += c.span; g.lo = Math.min(g.lo, c.lo); g.hi = Math.max(g.hi, c.hi); }
      else groups.push({ ...c });
    }
    const holes = groups.filter((g) => g.span >= 300).map((g) => ({
      d: 2 * g.r, depth: g.hi - g.lo, axis: g.axis.map((x) => Math.round(x * 1000) / 1000), thread: tapMatch(2 * g.r),
    }));
    const fillets = groups.filter((g) => g.span < 300);
    const minInnerRadius = fillets.length ? Math.min(...fillets.map((g) => g.r)) : null;

    /* suggestions */
    const dims = sub(max, min).sort((a, b) => b - a);
    const dirs = [];
    holes.forEach((h) => { if (!dirs.some((d) => Math.abs(Math.abs(dot(d, h.axis)) - 1) < 1e-2)) dirs.push(h.axis); });
    const nonAxis = dirs.filter((d) => Math.max(...d.map(Math.abs)) < 0.99).length;
    const setups = Math.min(6, Math.max(2, dirs.length + 1));
    const holeDiameters = new Set(holes.map((h) => h.d.toFixed(1)));
    const threads = holes.filter((h) => h.thread);
    const tools = Math.min(30, 4 + holeDiameters.size + new Set(threads.map((h) => h.thread)).size + (fillets.length ? 1 : 0));
    const faceCount = faces.size;
    const freeShare = freeformArea / Math.max(1, area);
    let complexity = faceCount < 30 ? 1 : faceCount < 80 ? 2 : faceCount < 200 ? 3 : faceCount < 500 ? 4 : 5;
    if (freeShare > 0.15) complexity = Math.max(complexity, 4);
    if (minInnerRadius !== null && minInnerRadius < 1) complexity = Math.min(5, complexity + 1);
    // drilled holes up to Ø20; larger bores are circular-milled and counted like pockets
    const drilled = holes.filter((h) => h.d <= 20.05);
    const bores = holes.filter((h) => h.d > 20.05);

    return {
      bbox: { x: dims[0], y: dims[1], z: dims[2] },
      volume: volume / 1000, // cm³
      area: area / 100,      // cm²
      fill: volume / Math.max(1e-9, dims[0] * dims[1] * dims[2]) * 100,
      faceCount, holes, threads: threads.length, minInnerRadius, freeformShare: freeShare,
      planarShare: planarArea / Math.max(1, area), angledHoleAxes: nonAxis,
      suggest: {
        x: round1(dims[0]), y: round1(dims[1]), z: round1(dims[2]),
        partVolume: round1(volume / 1000), surfaceArea: round1(area / 100),
        holes: drilled.length,
        pockets: bores.length,
        threads: threads.length,
        holeDepth: drilled.length ? round1(drilled.reduce((s, h) => s + h.depth, 0) / drilled.length) : 10,
        setups, tools, complexity,
        machineId: nonAxis > 0 || freeShare > 0.15 ? 'ax5' : null,
      },
    };
  }

  function sameLine(a, b) {
    // distance between the two axis lines, measured in a's (u, v) plane
    const cB = add3(scale(b.u, b.centre[0]), scale(b.v, b.centre[1]));
    const du = dot(cB, a.u) - a.centre[0], dv = dot(cB, a.v) - a.centre[1];
    return Math.hypot(du, dv) < Math.max(0.05, 0.02 * a.r);
  }
  function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

  /* Angular coverage of a set of angles in degrees (largest gap removed). */
  function angularSpan(angles) {
    if (angles.length < 2) return 0;
    const s = angles.map((a) => (a + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
    let gap = s[0] + 2 * Math.PI - s[s.length - 1];
    for (let i = 1; i < s.length; i++) gap = Math.max(gap, s[i] - s[i - 1]);
    return (2 * Math.PI - gap) * 180 / Math.PI;
  }

  function tapMatch(d) {
    const hit = TAP_DRILLS.find(([td]) => Math.abs(td - d) <= 0.06);
    return hit ? hit[1] : null;
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  /* ---------- semantic PMI (STEP AP242) ---------- */

  /* ISO 286 IT grade → tolerance class of the cost model */
  const IT_CLASS = { 4: 't005', 5: 't005', 6: 't010', 7: 't020', 8: 't050', 9: 't050', 10: 't100', 11: 't100' };

  /* half tolerance band in mm → tolerance class (null = within general tolerance) */
  function classOf(half) {
    if (!(half > 0)) return null;
    if (half <= 0.005) return 't005';
    if (half <= 0.01) return 't010';
    if (half <= 0.02) return 't020';
    if (half <= 0.05) return 't050';
    if (half <= 0.1) return 't100';
    return null;
  }

  const GEO_TYPES = {
    FLATNESS_TOLERANCE: 'Ebenheit', STRAIGHTNESS_TOLERANCE: 'Geradheit', ROUNDNESS_TOLERANCE: 'Rundheit',
    CYLINDRICITY_TOLERANCE: 'Zylinderform', PERPENDICULARITY_TOLERANCE: 'Rechtwinkligkeit',
    PARALLELISM_TOLERANCE: 'Parallelität', ANGULARITY_TOLERANCE: 'Neigung', POSITION_TOLERANCE: 'Position',
    CONCENTRICITY_TOLERANCE: 'Koaxialität', COAXIALITY_TOLERANCE: 'Koaxialität', SYMMETRY_TOLERANCE: 'Symmetrie',
    CIRCULAR_RUNOUT_TOLERANCE: 'Rundlauf', TOTAL_RUNOUT_TOLERANCE: 'Gesamtlauf',
    LINE_PROFILE_TOLERANCE: 'Linienform', SURFACE_PROFILE_TOLERANCE: 'Flächenform',
  };

  /*
   * Read semantic PMI from the STEP text: ± dimension tolerances (PLUS_MINUS_TOLERANCE
   * with TOLERANCE_VALUE), ISO fits (LIMITS_AND_FITS) and geometric tolerances.
   * Only AP242 files exported with semantic PMI carry this; AP203/AP214 return nothing.
   */
  function parsePmi(text) {
    const start = text.indexOf('DATA;');
    const body = start >= 0 ? text.slice(start + 5) : text;
    const rec = new Map();
    for (const m of body.matchAll(/#(\d+)\s*=\s*([\s\S]*?);\s*(?=#\d+\s*=|ENDSEC)/g)) rec.set(m[1], m[2].replace(/\s+/g, ' '));
    const inch = /CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text);
    const toMm = inch ? 25.4 : 1;
    const valueOf = (ref) => {
      const t = rec.get(String(ref).replace('#', '')) || '';
      const m = t.match(/(?:LENGTH_MEASURE|POSITIVE_LENGTH_MEASURE)\s*\(\s*([-+\d.Ee]+)\s*\)/);
      return m ? Number(m[1]) * toMm : null;
    };
    const dims = [], fits = [], geo = [];
    const tolValues = new Map();
    for (const [id, t] of rec) {
      const m = t.match(/^TOLERANCE_VALUE\s*\(\s*(#\d+)\s*,\s*(#\d+)\s*\)/);
      if (m) tolValues.set(id, [valueOf(m[1]), valueOf(m[2])]);
    }
    for (const [, t] of rec) {
      let m = t.match(/^PLUS_MINUS_TOLERANCE\s*\(\s*#(\d+)\s*,\s*#(\d+)/);
      if (m && tolValues.has(m[1])) {
        const [lo, hi] = tolValues.get(m[1]);
        if (lo !== null && hi !== null) {
          const half = Math.abs(hi - lo) / 2;
          const target = rec.get(m[2]) || '';
          dims.push({ half, cls: classOf(half), kind: /DIMENSIONAL_SIZE/.test(target) ? 'Maß' : 'Lage' });
        }
        continue;
      }
      m = t.match(/^LIMITS_AND_FITS\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/);
      if (m) {
        const grade = Number((m[1].match(/(\d+)/) || [])[1]);
        fits.push({ fit: m[1], kind: m[2], cls: IT_CLASS[grade] || (grade <= 4 ? 't005' : null) });
        continue;
      }
      m = t.match(/^\(?\s*([A-Z_]+_TOLERANCE)\s*\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*(#\d+)/);
      if (m && GEO_TYPES[m[1]]) {
        const v = valueOf(m[2]);
        geo.push({ type: GEO_TYPES[m[1]], value: v, cls: classOf(v !== null ? v / 2 : null) });
        continue;
      }
      // complex entity: ( GEOMETRIC_TOLERANCE('name','',#value,#target) … POSITION_TOLERANCE() )
      m = t.match(/^\(\s*GEOMETRIC_TOLERANCE\s*\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*(#\d+)/);
      if (m) {
        const type = Object.keys(GEO_TYPES).find((k) => new RegExp(`\\b${k}\\s*\\(\\s*\\)`).test(t));
        if (type) {
          const v = valueOf(m[1]);
          geo.push({ type: GEO_TYPES[type], value: v, cls: classOf(v !== null ? v / 2 : null) });
        }
        continue;
      }
      // limit dimension (e.g. Ø34,8–35,2): representation with 'upper limit' and 'lower limit'
      m = t.match(/^SHAPE_DIMENSION_REPRESENTATION\s*\(\s*'[^']*'\s*,\s*\(([^)]*)\)/);
      if (m) {
        const items = m[1].split(',').map((x) => x.trim().replace('#', ''));
        const pick = (label) => {
          const id = items.find((i) => new RegExp(`'${label}'`).test(rec.get(i) || ''));
          return id ? valueOf(id) : null;
        };
        const up = pick('upper limit'), lo = pick('lower limit');
        if (up !== null && lo !== null) {
          const half = Math.abs(up - lo) / 2;
          dims.push({ half, cls: classOf(half), kind: 'Grenzmaß' });
        }
      }
    }
    const counts = {};
    [...dims, ...fits, ...geo].forEach((x) => { if (x.cls) counts[x.cls] = (counts[x.cls] || 0) + 1; });
    return { inch, dims, fits, geo, counts, found: dims.length + fits.length + geo.length };
  }

  /* ---------- browser loading ---------- */
  let occtPromise = null;
  function loadOcct() {
    if (occtPromise) return occtPromise;
    occtPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OCCT_BASE + 'occt-import-js.js';
      s.onload = () => self.occtimportjs({ locateFile: (f) => OCCT_BASE + f }).then(resolve, reject);
      s.onerror = () => { occtPromise = null; reject(new Error('STEP-Modul konnte nicht geladen werden. Internetverbindung prüfen.')); };
      document.head.appendChild(s);
    });
    return occtPromise;
  }

  async function readFile(file) {
    const occt = await loadOcct();
    const buf = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase();
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.3 };
    const res = name.endsWith('.igs') || name.endsWith('.iges') ? occt.ReadIgesFile(buf, params) : occt.ReadStepFile(buf, params);
    if (!res || !res.success) throw new Error('Die Datei ließ sich nicht als STEP lesen. Bitte als STEP AP214 oder AP242 exportieren.');
    const analysis = analyze(res);
    analysis.bodies = (res.meshes || []).length;
    analysis.pmi = name.endsWith('.igs') || name.endsWith('.iges') ? null : parsePmi(new TextDecoder('latin1').decode(buf));
    return { raw: res, analysis };
  }

  return { analyze, parsePmi, classOf, readFile, fitCircle, angularSpan, tapMatch, OCCT_VERSION };
});
