'use strict';

// Readings file: headerless CSV of `timestamp,level_ft`. ISO 8601 timestamps
// with Z or an offset are converted to Pacific time; timestamps without one
// are taken as Pacific wall time already. Header and # comment rows are skipped.
const DATA_URL = 'data.csv';

// USACE operating targets, Corps project datum. Checked against Seattle District
// release 26-004 (Feb 27, 2026): winter level 20 ft, refill begins Feb 15,
// target 22 ft. The date full is reached moves with snowpack (Apr 1 in 2026,
// ~Jun 1 in 2025); May 1 is the typical target. Dec 1 for the winter level
// matches the archive (December daily means 20.0–20.1 every year).
const WINTER_FT = 20.0;
const SUMMER_FT = 22.0;
const REFILL_START = [1, 15]; // [month index, day]
const SUMMER_FULL = [4, 1];
const WINTER_REACHED = [11, 1];
// The archive shows drawdown starting in June, not after summer.
const DRAWDOWN_START = [5, 15];

// Readings below this are gauge glitches (the scraped feed once read ~19.1 ft
// for 14 hours on 2024-02-12/13) and are dropped before averaging.
const MIN_PLAUSIBLE_FT = 19.5;
// Rises ending in this window are the Locks refilling the lake, not rain.
const REFILL_SEASON = [[1, 15], [4, 31]];

const DAY = 86400000;
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const H = 300;
const BLUE = '2.5px solid #1D5FA6', ORANGE_D = '2px dashed #B05410', ORANGE = '2px solid #B05410',
  GREY = '2px solid #8A99A2', INK_D = '2px dotted #10222F', BAND = '8px solid rgba(29,95,166,0.18)';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fd = (ti) => { const d = new Date(ti); return M[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); };
const fs = (ti) => { const d = new Date(ti); return M[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
const sg = (x, p = 2) => (x > 0.004 ? '+' : x < -0.004 ? '−' : '±') + Math.abs(x).toFixed(p);
const ft = (x) => x == null ? '—' : x.toFixed(2) + ' ft';
const mean = (xs) => xs.reduce((p, c) => p + c, 0) / xs.length;
const pct = (x) => x.toFixed(2) + '%';

// ---------- data ----------

// US Pacific UTC offset in ms for a UTC instant. DST rules: 2007 on, second
// Sunday of March to first Sunday of November; before that, first Sunday of
// April to last Sunday of October. Changes happen at 2 AM local.
const dstCache = new Map();
function pacificOffset(utc) {
  const y = new Date(utc).getUTCFullYear();
  let b = dstCache.get(y);
  if (!b) {
    const nthSun = (m, n) => { const dow = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + (7 - dow) % 7 + 7 * (n - 1); };
    const lastSun = (m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
    b = y >= 2007
      ? [Date.UTC(y, 2, nthSun(2, 2), 10), Date.UTC(y, 10, nthSun(10, 1), 9)]
      : [Date.UTC(y, 3, nthSun(3, 1), 10), Date.UTC(y, 9, lastSun(9), 9)];
    dstCache.set(y, b);
  }
  return (utc >= b[0] && utc < b[1] ? -7 : -8) * 3600000;
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;

function parseReadings(text) {
  const byDay = new Map();
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const comma = line.indexOf(',');
    if (comma < 0) continue;
    const ts = line.slice(0, comma).trim();
    const val = parseFloat(line.slice(comma + 1));
    const m = TS_RE.exec(ts);
    if (!m || !Number.isFinite(val) || val < MIN_PLAUSIBLE_FT) continue;
    // `at` is Pacific wall-clock time encoded as a UTC epoch, so all later
    // date math and formatting can use getUTC* without shifting it.
    let at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0);
    if (m[7]) {
      const z = m[7] === 'Z' ? 0 : (m[7][0] === '-' ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(-2));
      const utc = at - z * 60000;
      at = utc + pacificOffset(utc);
    }
    const day = Math.floor(at / DAY) * DAY;
    const e = byDay.get(day);
    if (e) { e.sum += val; e.n++; } else byDay.set(day, { sum: val, n: 1 });
    if (!last || at >= last.at) last = { at, val, hasTime: m[4] != null };
  }
  if (!byDay.size) throw new Error('No readings found in ' + DATA_URL);

  // One slot per calendar day from first to last; missing days stay null.
  const keys = [...byDay.keys()].sort((a, b) => a - b);
  const start = keys[0], end = keys[keys.length - 1];
  const N = Math.round((end - start) / DAY) + 1;
  const t = new Array(N), v = new Array(N).fill(null), yr = new Array(N), doy = new Array(N);
  for (let i = 0; i < N; i++) {
    t[i] = start + i * DAY;
    const y = new Date(t[i]).getUTCFullYear();
    yr[i] = y; doy[i] = Math.round((t[i] - Date.UTC(y, 0, 1)) / DAY);
    const e = byDay.get(t[i]);
    if (e) v[i] = Math.round(e.sum / e.n * 1000) / 1000;
  }
  return { t, v, yr, doy, N, END: end, last };
}

// Nearest day with data within `reach` days of i (prefers earlier on ties).
function nearIdx(D, i, reach = 3) {
  for (let k = 0; k <= reach; k++) {
    if (i - k >= 0 && i - k < D.N && D.v[i - k] != null) return i - k;
    if (k && i + k >= 0 && i + k < D.N && D.v[i + k] != null) return i + k;
  }
  return -1;
}
const near = (D, i, reach) => { const j = nearIdx(D, i, reach); return j < 0 ? null : D.v[j]; };

// Typical level for each day of year: average of every year in the archive,
// then a circular ±7-day smoothing so it reads as a schedule, not weather.
function typicalCurve(D) {
  const sum = new Array(366).fill(0), n = new Array(366).fill(0);
  D.v.forEach((x, i) => { if (x != null) { sum[D.doy[i]] += x; n[D.doy[i]]++; } });
  const out = [];
  for (let d = 0; d < 366; d++) {
    let s = 0, c = 0;
    for (let k = -7; k <= 7; k++) { const j = (d + k + 366) % 366; s += sum[j]; c += n[j]; }
    out.push(c ? s / c : null);
  }
  return out;
}

const doyOf = (ti) => { const y = new Date(ti).getUTCFullYear(); return Math.round((ti - Date.UTC(y, 0, 1)) / DAY); };
// Next occurrence (today or later) of a fixed month/day.
const nextDate = (END, [m, d]) => { const y = new Date(END).getUTCFullYear(); const a = Date.UTC(y, m, d); return a >= END ? a : Date.UTC(y + 1, m, d); };

function phaseOf(ti) {
  const d = new Date(ti), md = d.getUTCMonth() * 100 + d.getUTCDate();
  const k = ([m, dd]) => m * 100 + dd;
  if (md >= k(WINTER_REACHED) || md < k(REFILL_START)) return 'Winter hold';
  if (md < k(SUMMER_FULL)) return 'Spring refill';
  if (md < k(DRAWDOWN_START)) return 'Summer full';
  return 'Drawdown';
}

// ---------- svg helpers ----------

const mkY = (lo, hi) => (x) => (hi - x) / (hi - lo) * H;
function domain(all) {
  const xs = all.filter((x) => x != null);
  let lo = Math.min(...xs) - 0.05, hi = Math.max(...xs) + 0.05;
  const span = hi - lo, step = span < 0.5 ? 0.1 : span < 1.6 ? 0.25 : 0.5;
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  return { lo, hi, step };
}
function yTicksOf(dm, Y) {
  const out = [];
  for (let x = dm.lo; x <= dm.hi + 1e-9; x += dm.step) out.push({ label: x.toFixed(dm.step < 0.25 ? 1 : 2), top: pct(Y(x) / H * 100) });
  return out;
}
const xAt = (j, len) => (j / Math.max(1, len - 1) * 1000).toFixed(1);
function pathOf(arr, len, Y) {
  let p = '', pen = false;
  arr.forEach((val, j) => { if (val == null) { pen = false; return; } p += (pen ? 'L' : 'M') + xAt(j, len) + ' ' + Y(val).toFixed(1); pen = true; });
  return p;
}
// Filled band between lo and hi, split wherever either side has no data.
function bandOf(lo, hi, len, Y) {
  let p = '', seg = [];
  const flush = () => {
    if (seg.length > 1) {
      seg.forEach((j, k) => { p += (k ? 'L' : 'M') + xAt(j, len) + ' ' + Y(hi[j]).toFixed(1); });
      for (let k = seg.length - 1; k >= 0; k--) p += 'L' + xAt(seg[k], len) + ' ' + Y(lo[seg[k]]).toFixed(1);
      p += 'Z';
    }
    seg = [];
  };
  for (let j = 0; j < lo.length; j++) { if (lo[j] == null || hi[j] == null) flush(); else seg.push(j); }
  flush();
  return p;
}
const yLabelsHtml = (ticks) => ticks.map((t) => `<span style="top:${t.top}">${esc(t.label)}</span>`).join('');
const gridHtml = (ticks) => ticks.map((t) => `<div class="gridline" style="top:${t.top}"></div>`).join('');
const xLabelsHtml = (ticks) => ticks.map((t) => `<span style="left:${t.left}">${esc(t.label)}</span>`).join('');

// ---------- sections ----------

function renderHero(D, S) {
  const { cur, L, ly } = S;
  $('phase').textContent = phaseOf(D.END);
  $('cur').textContent = cur.toFixed(2);
  const delta = (p) => { const x = near(D, L - p); return x == null ? '—' : sg(cur - x) + ' ft'; };
  $('d1').textContent = delta(1);
  $('d7').textContent = delta(7);
  $('d30').textContent = delta(30);

  const wk = near(D, L - 7);
  const ch = wk == null ? 0 : D.v[L] - wk;
  const dir = ch < -0.01 ? 'falling' : ch > 0.01 ? 'rising' : 'holding steady';
  const toFull = (SUMMER_FT - cur) * 12, aboveWinter = (cur - WINTER_FT) * 12;
  const a = toFull >= 0 ? toFull.toFixed(1) + ' inches below summer full' : (-toFull).toFixed(1) + ' inches above summer full';
  const b = aboveWinter >= 0 ? aboveWinter.toFixed(1) + ' inches above the winter hold' : (-aboveWinter).toFixed(1) + ' inches below the winter hold';
  $('heroLine').textContent = 'The lake is ' + dir + '. It sits ' + a + ' and ' + b + '.';

  // Staff gauge: 19.5–22.5 ft over the 310px board.
  const Ys = (x) => 10 + (22.5 - Math.min(22.5, Math.max(19.5, x))) * 100;
  let ticks = '', major = '';
  for (let k = 0; k <= 30; k++) {
    const y = Ys(19.5 + k * 0.1).toFixed(1);
    if (k % 10 === 5) major += 'M24 ' + y + 'H88';
    else if (k % 5 === 0) ticks += 'M24 ' + y + 'H56';
    else ticks += 'M24 ' + y + 'H40';
  }
  for (let k = 0; k <= 150; k++) if (k % 5) ticks += 'M24 ' + Ys(19.5 + k * 0.02).toFixed(1) + 'H30';
  const wy = Ys(cur);
  let wave = 'M0 ' + wy.toFixed(1);
  for (let x = 0; x <= 200; x += 10) wave += ' Q' + (x + 5) + ' ' + (wy + (x / 10 % 2 ? 3 : -3)).toFixed(1) + ' ' + (x + 10) + ' ' + wy.toFixed(1);
  const waterH = (320 - wy).toFixed(1);
  const mono = 'font-family="IBM Plex Mono, monospace"';
  const yFull = Ys(SUMMER_FT), yWinter = Ys(WINTER_FT);
  let lyHtml = '';
  if (ly != null) {
    const lyY = Ys(ly);
    // Keep the label clear of the "now" label and the 20/22 ft labels.
    const taken = [wy + 5, yFull + 4, yWinter + 4];
    const lyTextY = [lyY + 4, lyY + 16, lyY - 8, lyY + 28, lyY - 20]
      .find((y) => taken.every((o) => Math.abs(y - o) >= 13)) ?? lyY + 4;
    lyHtml = `<path d="M88 ${lyY.toFixed(1)}H102" stroke="#F0A060" stroke-width="2.5" fill="none"></path>
      <text x="108" y="${lyTextY.toFixed(1)}" ${mono} font-size="11" fill="#F0A060">last yr ${ly.toFixed(2)}</text>`;
  }
  $('gauge').innerHTML = `
    <rect x="0" y="${wy.toFixed(1)}" width="200" height="${waterH}" fill="#2F78C4" opacity="0.28"></rect>
    <rect x="24" y="10" width="64" height="310" fill="#F4F1E8"></rect>
    <path d="${ticks}" stroke="#10222F" stroke-width="2" fill="none"></path>
    <path d="${major}" stroke="#10222F" stroke-width="4" fill="none"></path>
    <text x="84" y="54" ${mono} font-size="15" font-weight="600" fill="#10222F" text-anchor="end">22</text>
    <text x="84" y="154" ${mono} font-size="15" font-weight="600" fill="#10222F" text-anchor="end">21</text>
    <text x="84" y="254" ${mono} font-size="15" font-weight="600" fill="#10222F" text-anchor="end">20</text>
    <rect x="24" y="${wy.toFixed(1)}" width="64" height="${waterH}" fill="#2F78C4" opacity="0.55"></rect>
    <path d="${wave}" stroke="#8EC1F0" stroke-width="2.5" fill="none"></path>
    <line x1="88" y1="${yFull}" x2="104" y2="${yFull}" stroke="#A9BAC2" stroke-width="1"></line>
    <text x="108" y="${yFull + 4}" ${mono} font-size="11" fill="#A9BAC2">${SUMMER_FT.toFixed(1)} summer full</text>
    <line x1="88" y1="${yWinter}" x2="104" y2="${yWinter}" stroke="#A9BAC2" stroke-width="1"></line>
    <text x="108" y="${yWinter + 4}" ${mono} font-size="11" fill="#A9BAC2">${WINTER_FT.toFixed(1)} winter hold</text>
    ${lyHtml}
    <path d="M90 ${wy.toFixed(1)}l12 -7v14z" fill="#EAF0EE"></path>
    <text x="108" y="${(wy + 5).toFixed(1)}" ${mono} font-size="14" font-weight="600" fill="#EAF0EE">now ${cur.toFixed(2)}</text>`;
}

function renderTiles(D, S) {
  const { cur, L, ly, lyI } = S;
  const prior = [];
  for (let k = 1; k <= 3; k++) { const x = near(D, L - 365 * k); if (x != null) prior.push(x); }
  const avgNow = prior.length ? mean(prior) : null;

  let hiI = -1, loI = -1;
  for (let i = Math.max(0, D.N - 365); i < D.N; i++) {
    if (D.v[i] == null) continue;
    if (hiI < 0 || D.v[i] > D.v[hiI]) hiI = i;
    if (loI < 0 || D.v[i] < D.v[loI]) loI = i;
  }
  const wk = near(D, L - 7);
  const rate7 = wk == null ? null : D.v[L] - wk;
  const tiles = [
    ly == null
      ? { label: 'vs. last year', value: '—', sub: 'No reading for this date last year' }
      : { label: 'vs. last year', value: sg(cur - ly) + ' ft', sub: fd(D.t[lyI]) + ': ' + ly.toFixed(2) + ' ft' },
    avgNow == null
      ? { label: 'vs. typical for ' + fs(D.END), value: '—', sub: 'Not enough history yet' }
      : { label: 'vs. typical for ' + fs(D.END), value: sg(cur - avgNow) + ' ft', sub: 'Average of prior years: ' + avgNow.toFixed(2) + ' ft' },
    rate7 == null
      ? { label: 'Pace', value: '—', sub: 'No reading a week ago' }
      : { label: 'Pace', value: sg(rate7) + ' ft/wk', sub: rate7 < -0.01 && cur > WINTER_FT ? 'At this pace, ' + WINTER_FT.toFixed(1) + ' ft in about ' + Math.max(1, Math.round((cur - WINTER_FT) / -rate7)) + ' weeks' : 'Over the last 7 days' },
    { label: '12-month range', value: D.v[loI].toFixed(2) + '–' + D.v[hiI].toFixed(2), sub: 'Low ' + fs(D.t[loI]) + ' · High ' + fs(D.t[hiI]) }
  ];
  $('tiles').innerHTML = tiles.map((tl) => `<div class="tile">
    <span class="mono eyebrow">${esc(tl.label)}</span>
    <span class="tile-value">${esc(tl.value)}</span>
    <span class="tile-sub">${esc(tl.sub)}</span></div>`).join('');
}

// Builds everything for the main chart that doesn't depend on hover position.
function buildChart(D, S, range) {
  const { v, t, N, yr, doy } = D;
  if (range !== 'yr') {
    const W = Math.min(range, N), st = N - W;
    const at = (i) => (i >= 0 && i < N ? v[i] : null);
    const a = [], b = [], lo = [], hi = [], av = [];
    const withPrior = W <= 365;
    for (let i = st; i < N; i++) {
      a.push(v[i]);
      if (!withPrior) continue;
      b.push(at(i - 365));
      const xs = [];
      for (let k = 1; k <= 3; k++) { const x = at(i - 365 * k); if (x != null) xs.push(x); }
      lo.push(xs.length ? Math.min(...xs) : null);
      hi.push(xs.length ? Math.max(...xs) : null);
      av.push(xs.length ? mean(xs) : null);
    }
    const hasPrior = b.some((x) => x != null);
    const dm = domain(a.concat(b, lo, hi));
    const Y = mkY(dm.lo, dm.hi);
    const xTicks = [];
    for (let j = 0; j < W; j++) {
      const d = new Date(t[st + j]); let label = null;
      if (W <= 31) { if ((W - 1 - j) % 7 === 0) label = fs(t[st + j]); }
      else if (W <= 365) { if (d.getUTCDate() === 1) label = M[d.getUTCMonth()] + (d.getUTCMonth() === 0 ? ' ’' + String(d.getUTCFullYear()).slice(2) : ''); }
      else if (d.getUTCDate() === 1 && (d.getUTCMonth() === 0 || d.getUTCMonth() === 6)) label = d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : 'Jul';
      const left = j / (W - 1) * 100;
      if (label && left > 3 && left < 97) xTicks.push({ label, left: pct(left) });
    }
    const legend = [{ label: 'This period', border: BLUE }];
    if (hasPrior) legend.push({ label: 'Same days last year', border: ORANGE_D }, { label: 'Average of prior years', border: INK_D }, { label: 'Range of prior years', border: BAND });
    return {
      len: W, Y, st, a, b, av, hasPrior,
      paths: { a: pathOf(a, W, Y), b: hasPrior ? pathOf(b, W, Y) : '', bDash: '6 4', c: hasPrior ? pathOf(av, W, Y) : '', cColor: '#10222F', cDash: '1.5 3.5', r: '', band: hasPrior ? bandOf(lo, hi, W, Y) : '' },
      yTicks: yTicksOf(dm, Y), xTicks, legend, todayLeft: null
    };
  }
  // By year: the latest three calendar years laid over Jan–Dec.
  const endY = yr[N - 1];
  const years = [endY, endY - 1, endY - 2].filter((y) => y >= yr[0]);
  const byY = {};
  years.forEach((y) => { byY[y] = new Array(366).fill(null); });
  for (let i = 0; i < N; i++) if (byY[yr[i]]) byY[yr[i]][doy[i]] = v[i];
  const rl = S.typical;
  const all = [];
  years.forEach((y) => byY[y].forEach((x) => { if (x != null) all.push(x); }));
  const dm = domain(all.concat(rl));
  const Y = mkY(dm.lo, dm.hi);
  const MS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const styles = [[BLUE, '#1D5FA6'], [ORANGE, '#B05410'], [GREY, '#8A99A2']];
  const legend = years.map((y, k) => ({ label: String(y), border: styles[k][0] }));
  legend.push({ label: 'Typical year (archive average)', border: INK_D });
  return {
    len: 366, Y, years, byY, styles,
    paths: { a: pathOf(byY[years[0]], 366, Y), b: years[1] ? pathOf(byY[years[1]], 366, Y) : '', bDash: '0', c: years[2] ? pathOf(byY[years[2]], 366, Y) : '', cColor: '#8A99A2', cDash: '0', r: pathOf(rl, 366, Y), band: '' },
    yTicks: yTicksOf(dm, Y),
    xTicks: MS.map((d, m) => ({ label: M[m], left: pct((d + 15) / 365 * 100) })),
    legend, todayLeft: pct(doy[N - 1] / 365 * 100)
  };
}

function renderChart(C) {
  const p = C.paths;
  $('pA').setAttribute('d', p.a);
  $('pB').setAttribute('d', p.b);
  $('pB').setAttribute('stroke-dasharray', p.bDash);
  $('pC').setAttribute('d', p.c);
  $('pC').setAttribute('stroke', p.cColor);
  $('pC').setAttribute('stroke-dasharray', p.cDash);
  $('pR').setAttribute('d', p.r);
  $('pBand').setAttribute('d', p.band);
  $('mainY').innerHTML = yLabelsHtml(C.yTicks);
  $('mainGrid').innerHTML = gridHtml(C.yTicks);
  $('mainX').innerHTML = xLabelsHtml(C.xTicks);
  $('legend').innerHTML = C.legend.map((lg) => `<span><i style="border-top:${lg.border}"></i>${esc(lg.label)}</span>`).join('');
  const tl = $('todayLine');
  tl.hidden = C.todayLeft == null;
  if (C.todayLeft != null) tl.style.left = C.todayLeft;
}

function renderHover(D, S, C, hov) {
  let date, items, j, dotVal;
  if (C.years == null) {
    const W = C.len;
    j = hov == null ? W - 1 : Math.round(hov * (W - 1));
    dotVal = C.a[j];
    items = [{ label: 'Level', value: ft(C.a[j]), border: BLUE }];
    if (C.hasPrior) items.push({ label: 'Last year', value: ft(C.b[j]), border: ORANGE_D }, { label: 'Avg', value: ft(C.av[j]), border: INK_D });
    if (hov != null && C.a[j] != null) items.push({ label: 'vs. today', value: sg(S.cur - C.a[j]) + ' ft', border: '0 solid transparent' });
    date = fd(D.t[C.st + j]) + (C.a[j] == null ? ' · no reading' : '');
  } else {
    j = hov == null ? D.doy[D.N - 1] : Math.round(hov * 365);
    dotVal = C.byY[C.years[0]][j];
    items = C.years.map((y, k) => ({ label: String(y), value: ft(C.byY[y][j]), border: C.styles[k][0] }));
    date = fs(Date.UTC(2001, 0, 1) + j * DAY); // non-leap reference year for the label
  }
  $('readout').innerHTML = `<span class="date">${esc(date)}</span>` + items.map((ri) =>
    `<span class="item"><span class="sw" style="border-top:${ri.border}"></span><span class="k">${esc(ri.label)}</span><span class="v">${esc(ri.value)}</span></span>`).join('');
  const left = pct(j / (C.len - 1) * 100);
  const line = $('hoverLine'), dot = $('hoverDot');
  line.style.left = left;
  line.classList.toggle('on', hov != null);
  dot.hidden = dotVal == null;
  if (dotVal != null) { dot.style.left = left; dot.style.top = pct(C.Y(dotVal) / H * 100); }
}

const PER = [[1, '24 hours'], [3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '30 days'], [90, '90 days'], [365, '1 year']];

function renderChanges(D, S) {
  const rows = PER.map(([p, label]) => { const x = near(D, S.L - p); return { label, d: x == null ? null : S.cur - x }; });
  const mx = Math.max(0.05, ...rows.filter((r) => r.d != null).map((r) => Math.abs(r.d)));
  $('changes').innerHTML = rows.map(({ label, d }) => {
    if (d == null) return `<div class="change-row"><span class="lbl">${label}</span><div class="track"><div class="axis"></div></div><span class="val">—</span></div>`;
    const w = Math.abs(d) / mx * 50;
    return `<div class="change-row"><span class="lbl">${label}</span><div class="track"><div class="axis"></div>
      <div class="bar" style="left:${pct(d < 0 ? 50 - w : 50)};width:${pct(w)};background:${d >= 0 ? '#1D5FA6' : '#8A99A2'}"></div></div>
      <span class="val">${sg(d)}</span></div>`;
  }).join('');
}

function renderN(D, S, n) {
  const nn = Math.min(Math.max(1, n), S.L);
  const j = nearIdx(D, S.L - nn);
  $('nLabel').textContent = nn === 1 ? '1 day' : nn % 7 === 0 ? nn + ' days (' + nn / 7 + ' wk)' : nn + ' days';
  if (j < 0) { $('nDelta').textContent = '—'; $('nFrom').textContent = 'No reading near ' + fd(D.t[S.L - nn]); return; }
  $('nDelta').textContent = sg(S.cur - D.v[j]);
  $('nFrom').textContent = 'From ' + D.v[j].toFixed(2) + ' ft on ' + fd(D.t[j]) + ' to ' + S.cur.toFixed(2) + ' ft today';
}

function renderAhead(D, S) {
  const { cur, typical } = S, END = D.END;
  const typ = (ti) => typical[doyOf(ti)] ?? typical[(doyOf(ti) + 365) % 366];
  const off = cur - typ(END);
  // Typical seasonal curve plus today's departure from it, fading over ~3 weeks.
  const projAt = (k) => typ(END + k * DAY) + off * Math.exp(-k / 21);
  const proj = [], up = [], dn = [];
  for (let k = 0; k <= 84; k++) {
    const p = projAt(k);
    proj.push(p); up.push(p + 0.03 + 0.06 * Math.sqrt(k)); dn.push(p - 0.01 - 0.012 * Math.sqrt(k));
  }
  const act = [];
  for (let i = D.N - 29; i < D.N; i++) act.push(i >= 0 ? D.v[i] : null);
  act[28] = cur;
  const TOT = 113;
  const adm = domain(act.concat(up, dn));
  const AY = mkY(adm.lo, adm.hi);
  const X = (k) => ((k + 28) / (TOT - 1) * 1000).toFixed(1);
  let aPath = '', pen = false;
  act.forEach((x, j) => { if (x == null) { pen = false; return; } aPath += (pen ? 'L' : 'M') + X(j - 28) + ' ' + AY(x).toFixed(1); pen = true; });
  const pPath = proj.map((x, k) => (k ? 'L' : 'M') + X(k) + ' ' + AY(x).toFixed(1)).join('');
  let bPath = up.map((x, k) => (k ? 'L' : 'M') + X(k) + ' ' + AY(x).toFixed(1)).join('');
  for (let k = 84; k >= 0; k--) bPath += 'L' + X(k) + ' ' + AY(dn[k]).toFixed(1);
  bPath += 'Z';
  const kOf = (ut) => Math.round((ut - END) / DAY);
  const at = (k) => pct((k + 28) / (TOT - 1) * 100);

  const xt = [{ label: fs(END - 28 * DAY), left: '4%' }, { label: 'Today', left: at(0) }];
  for (let k = 1; k < 84; k++) { const d = new Date(END + k * DAY); if (d.getUTCDate() === 1 && k > 6 && k < 80) xt.push({ label: M[d.getUTCMonth()] + ' 1', left: at(k) }); }
  xt.push({ label: fs(END + 84 * DAY), left: '96%' });

  $('aActual').setAttribute('d', aPath);
  $('aProj').setAttribute('d', pPath);
  $('aBand').setAttribute('d', bPath);
  const ticks = yTicksOf(adm, AY);
  $('aheadY').innerHTML = yLabelsHtml(ticks);
  $('aheadGrid').innerHTML = gridHtml(ticks);
  $('aheadX').innerHTML = xLabelsHtml(xt);
  $('aToday').style.left = at(0);
  const kDec = kOf(nextDate(END, WINTER_REACHED));
  $('aDec1').hidden = kDec > 84;
  $('aDec1').style.left = at(kDec);

  // Milestones, soonest first.
  const kFeb = kOf(nextDate(END, REFILL_START)), kMay = kOf(nextDate(END, SUMMER_FULL));
  const inDays = (k) => k === 0 ? 'Today' : 'In ' + k + ' day' + (k === 1 ? '' : 's');
  const inches = (x) => Math.abs(x * 12).toFixed(1) + ' in ' + (x < 0 ? 'lower' : 'higher') + ' than today';
  const pDec = projAt(kDec);
  const md = ([m, d]) => M[m] + ' ' + d;
  const ms = [
    { k: kDec, when: md(WINTER_REACHED), title: 'Winter hold reached', sub: inDays(kDec) + ' · about ' + inches(pDec - cur), level: '≈' + pDec.toFixed(1) + ' ft' },
    { k: kDec + 14, when: 'Dec–Feb', title: 'Lowest water of the year', sub: 'Storms can add 0.2–0.5 ft for a few days.', level: '≈' + WINTER_FT.toFixed(1) + ' ft' },
    { k: kFeb, when: md(REFILL_START), title: 'Spring refill begins', sub: inDays(kFeb) + ' · the Locks start holding water back', level: WINTER_FT.toFixed(1) + ' ↑' },
    { k: kMay, when: md(SUMMER_FULL), title: 'Summer full', sub: inDays(kMay) + ' · about ' + inches(SUMMER_FT - cur) + '. Date varies with snowpack.', level: SUMMER_FT.toFixed(1) + ' ft' }
  ].sort((a, b) => a.k - b.k);
  $('milestones').innerHTML = ms.map((m) => `<div class="ms-row"><span class="ms-when">${esc(m.when)}</span>
    <span class="ms-body"><span class="ms-title">${esc(m.title)}</span><span class="ms-sub">${esc(m.sub)}</span></span>
    <span class="ms-level">${esc(m.level)}</span></div>`).join('');
}

function inRefill(ti) {
  const d = new Date(ti), md = d.getUTCMonth() * 100 + d.getUTCDate();
  const [[m0, d0], [m1, d1]] = REFILL_SEASON;
  return md >= m0 * 100 + d0 && md <= m1 * 100 + d1;
}

function renderStorms(D) {
  const { v, t, N } = D;
  const picks = [], used = new Array(N).fill(false);
  for (let r = 0; r < 4; r++) {
    let best = -1, bv = -Infinity;
    for (let i = 3; i < N; i++) {
      if (used[i] || v[i] == null || v[i - 3] == null || inRefill(t[i])) continue;
      const d = v[i] - v[i - 3];
      if (d > bv) { bv = d; best = i; }
    }
    if (best < 0 || bv <= 0) break;
    picks.push(best);
    for (let i = Math.max(0, best - 14); i < Math.min(N, best + 15); i++) used[i] = true;
  }
  $('storms').innerHTML = picks.map((i) => {
    const s0 = Math.max(0, i - 7), s1 = Math.min(N - 1, i + 13);
    const seg = v.slice(s0, s1 + 1);
    const xs = seg.filter((x) => x != null);
    const lo = Math.min(...xs), hi = Math.max(...xs);
    const sx = (j) => (j / 20 * 120).toFixed(1), sy = (x) => (36 - (x - lo) / Math.max(0.01, hi - lo) * 32).toFixed(1);
    let spark = '', pen = false;
    seg.forEach((x, j) => { if (x == null) { pen = false; return; } spark += (pen ? 'L' : 'M') + sx(j) + ' ' + sy(x); pen = true; });
    let hl = '';
    for (let k = i - 3; k <= i; k++) if (k >= s0 && v[k] != null) hl += (hl ? 'L' : 'M') + sx(k - s0) + ' ' + sy(v[k]);
    // First day the lake returns to within 0.03 ft of where the rise started.
    let back = -1;
    for (let k = i + 1; k < Math.min(N, i + 61); k++) if (v[k] != null && v[k] <= v[i - 3] + 0.03) { back = k; break; }
    const tail = back > 0 ? 'back down in ' + (back - i) + ' days' : i + 60 < N ? 'still up after 60 days' : 'not back down yet';
    return `<div class="storm">
      <div class="storm-head"><span class="storm-date">${fd(t[i - 3])}</span><span class="storm-rise">${sg(v[i] - v[i - 3])} ft</span></div>
      <svg viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
        <path d="${spark}" fill="none" stroke="#8A99A2" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>
        <path d="${hl}" fill="none" stroke="#1D5FA6" stroke-width="3" vector-effect="non-scaling-stroke"></path>
      </svg>
      <span class="storm-sub">${v[i - 3].toFixed(2)} → ${v[i].toFixed(2)} ft · ${tail}</span></div>`;
  }).join('');
}

// ---------- boot ----------

function formatUpdated(last) {
  const d = new Date(last.at);
  if (!last.hasTime) return 'Updated ' + fd(last.at);
  let h = d.getUTCHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
  return 'Updated ' + fd(last.at) + ', ' + h + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' ' + ap;
}

function start(D) {
  const L = D.N - 1;
  // "Now" is the latest single reading; history uses daily means.
  const cur = D.last.val;
  const lyI = nearIdx(D, L - 365);
  const S = { L, cur, lyI, ly: lyI < 0 ? null : D.v[lyI], typical: typicalCurve(D) };

  $('updated').textContent = formatUpdated(D.last);
  renderHero(D, S);
  renderTiles(D, S);
  renderChanges(D, S);
  renderAhead(D, S);
  renderStorms(D);
  $('footText').textContent += ' Archive runs from ' + fd(D.t[0]) + ' to ' + fd(D.END) + '.';

  // Range buttons + hover
  let range = 365, hov = null, C;
  const RANGES = [[30, '30D'], [90, '90D'], [365, '1Y'], [1095, '3Y'], ['yr', 'By year']];
  const draw = () => {
    C = buildChart(D, S, range);
    renderChart(C);
    renderHover(D, S, C, hov);
    $('ranges').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === String(range))));
  };
  $('ranges').innerHTML = RANGES.map(([k, label]) => `<button type="button" data-k="${k}" aria-pressed="false">${label}</button>`).join('');
  $('ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    range = b.dataset.k === 'yr' ? 'yr' : +b.dataset.k; hov = null; draw();
  });
  const plot = $('plot');
  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    hov = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    renderHover(D, S, C, hov);
  });
  plot.addEventListener('pointerleave', () => { hov = null; renderHover(D, S, C, hov); });
  draw();

  const slider = $('ndays');
  // Capped at 3 years, as in the design; longer spans make 1-day steps unusable.
  slider.max = String(Math.min(L, 1095));
  slider.value = String(Math.min(14, L));
  slider.addEventListener('input', () => renderN(D, S, parseInt(slider.value, 10) || 1));
  renderN(D, S, +slider.value);

  $('app').hidden = false;
}

fetch(DATA_URL, { cache: 'no-cache' })
  .then((r) => { if (!r.ok) throw new Error('Could not load ' + DATA_URL + ' (HTTP ' + r.status + ')'); return r.text(); })
  .then((text) => start(parseReadings(text)))
  .catch((err) => {
    console.error(err);
    $('updated').textContent = 'Data unavailable';
    const box = $('error');
    box.textContent = 'Lake data could not be loaded: ' + err.message + (location.protocol === 'file:' ? ' — open this page through a local web server (e.g. python3 -m http.server), not as a file.' : '');
    box.hidden = false;
  });
