'use strict';

// Readings file: headerless CSV of `timestamp,level_ft`, one row per hour. ISO
// 8601 timestamps with Z or an offset are converted to Pacific time; timestamps
// without one are taken as Pacific wall time already. Header and # comment rows
// are skipped.
const DATA_URL = 'data.csv';

// Corps project datum. The winter hold is 20 ft (USACE Seattle District release
// 26-004). Summer full isn't a fixed number: it comes from the archive.
const WINTER_FT = 20.0;
// Spring refill counts as "reached full" on the first day at or above this.
const FULL_FT = 21.8;
// Summer low record: the first day from Jul 1 to Nov 14 at or below this.
const LOW_FT = 20.1;

// Calendar windows as [month index, day].
const REFILL_START = [1, 15];
const SUMMER_FULL_FROM = [4, 1];
const DECLINE_FROM = [6, 1];
const FALL_FROM = [9, 1];
const WINTER_FROM = [11, 1];
// Rises ending in this window are the Locks refilling the lake, not rain.
const REFILL_RISES = [[1, 10], [4, 20]];

// Readings below this are gauge glitches (the scraped feed once read ~19.1 ft
// for 14 hours on 2024-02-12/13) and are dropped.
const MIN_PLAUSIBLE_FT = 19.5;
// A reading this far from the median of the 5 hours around it is a one-hour
// spike (two on Dec 30, 2002) and is replaced with that median.
const SPIKE_FT = 0.25;

const DAY = 86400000;
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const H = 300;
const BLUE = '2.5px solid #1D5FA6', ORANGE_D = '2px dashed #B05410', ORANGE = '2px solid #B05410', INK = '2px solid #10222F',
  GREY = '1px solid #B4C0C6', INK_D = '2px dotted #10222F', BAND = '8px solid rgba(29,95,166,0.18)';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fd = (ti) => { const d = new Date(ti); return M[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); };
const fs = (ti) => { const d = new Date(ti); return M[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
const sg = (x, p = 2) => (x > 0.004 ? '+' : x < -0.004 ? '−' : '±') + Math.abs(x).toFixed(p);
const ft = (x) => x == null ? '—' : x.toFixed(2) + ' ft';
const mean = (xs) => xs.reduce((p, c) => p + c, 0) / xs.length;
const pct = (x) => x.toFixed(2) + '%';
function quantile(xs, p) {
  const s = xs.slice().sort((a, b) => a - b), x = (s.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
  return s[lo] + (s[hi] - s[lo]) * (x - lo);
}

// Calendar-day key 0–365 on a leap-year index, so Feb 29 has its own slot.
const keyOf = (ti) => { const d = new Date(ti); return Math.round((Date.UTC(2000, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2000, 0, 1)) / DAY); };
const keyAt = ([m, d]) => keyOf(Date.UTC(2000, m, d));
const fk = (k) => fs(Date.UTC(2000, 0, 1) + k * DAY);
const FEB29 = keyAt([1, 29]);

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
  const rows = [];
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
    rows.push({ at, val, hasTime: m[4] != null });
  }
  if (!rows.length) throw new Error('No readings found in ' + DATA_URL);
  rows.sort((a, b) => a.at - b.at);

  // Spike filter, judged against the unfiltered neighbours.
  const raw = rows.map((r) => r.val);
  rows.forEach((r, i) => {
    const med = quantile(raw.slice(Math.max(0, i - 2), i + 3), 0.5);
    if (Math.abs(r.val - med) >= SPIKE_FT) r.val = med;
  });

  const byDay = new Map();
  for (const r of rows) {
    const day = Math.floor(r.at / DAY) * DAY;
    const e = byDay.get(day);
    if (e) { e.sum += r.val; e.n++; } else byDay.set(day, { sum: r.val, n: 1 });
  }

  // One slot per calendar day from first to last. Daily means are rounded to
  // the gauge's 0.01 ft resolution.
  const keys = [...byDay.keys()].sort((a, b) => a - b);
  const start = keys[0], end = keys[keys.length - 1];
  const N = Math.round((end - start) / DAY) + 1;
  const t = new Array(N), v = new Array(N).fill(null), yr = new Array(N), key = new Array(N);
  for (let i = 0; i < N; i++) {
    t[i] = start + i * DAY;
    yr[i] = new Date(t[i]).getUTCFullYear();
    key[i] = keyOf(t[i]);
    const e = byDay.get(t[i]);
    if (e) v[i] = Math.round(e.sum / e.n * 100) / 100;
  }
  // Days with no readings are filled in linearly from the days either side.
  for (let i = 1; i < N; i++) {
    if (v[i] != null) continue;
    let j = i; while (v[j] == null) j++;
    for (let k = i; k < j; k++) v[k] = v[i - 1] + (v[j] - v[i - 1]) * (k - i + 1) / (j - i + 1);
    i = j;
  }
  return { t, v, yr, key, N, rows };
}

// Everything derived from the whole archive that more than one section uses.
function analyze(D) {
  const { t, v, yr, key, N, rows } = D;
  const L = N - 1, curYear = yr[L], firstYear = yr[0];

  // "Typical" values use every year before the current one.
  const byKey = [], byKeyYr = [], byYear = {};
  for (let k = 0; k < 366; k++) { byKey.push([]); byKeyYr.push([]); }
  for (let i = 0; i < N; i++) {
    if (!byYear[yr[i]]) byYear[yr[i]] = new Array(366).fill(null);
    byYear[yr[i]][key[i]] = v[i];
    if (yr[i] < curYear) { byKey[key[i]].push(v[i]); byKeyYr[key[i]].push(yr[i]); }
  }
  const smooth = (arr) => arr.map((_, k) => { let s = 0; for (let o = -3; o <= 3; o++) s += arr[(k + o + 366) % 366]; return s / 7; });
  const p10 = smooth(byKey.map((a) => quantile(a, 0.1)));
  const p50 = smooth(byKey.map((a) => quantile(a, 0.5)));
  const p90 = smooth(byKey.map((a) => quantile(a, 0.9)));

  // "Now" is the mean of the last 3 hourly readings; 24 hours ago is the mean
  // of the 3 readings up to one day before the last.
  const last = rows[rows.length - 1];
  const cur = mean(rows.slice(-3).map((r) => r.val));
  let e = rows.length;
  while (e > 3 && rows[e - 1].at > last.at - DAY) e--;
  const cur24 = mean(rows.slice(e - 3, e).map((r) => r.val));

  const keyT = key[L];
  const todays = byKey[keyT], todaysYr = byKeyYr[keyT];
  const nBelow = todays.filter((x) => x < cur).length;
  const rankText = nBelow >= todays.length / 2 ? 'higher than ' + nBelow + ' of ' + todays.length : 'lower than ' + (todays.length - nBelow) + ' of ' + todays.length;

  // First day each year reached full in spring, and first summer drop to LOW_FT.
  // The first year is skipped because the archive starts mid-summer.
  const fullHits = [], lowHits = [];
  const doneFull = new Set(), doneLow = new Set();
  const fullBy = keyAt([6, 31]), lowFrom = keyAt([6, 1]), lowTo = keyAt([10, 15]);
  for (let i = 0; i < N; i++) {
    const y = yr[i], k = key[i];
    if (y === firstYear) continue;
    if (!doneFull.has(y) && k <= fullBy && v[i] >= FULL_FT) { fullHits.push({ y, k }); doneFull.add(y); }
    if (!doneLow.has(y) && k >= lowFrom && k < lowTo && v[i] <= LOW_FT) { lowHits.push({ y, k }); doneLow.add(y); }
  }
  const medFullK = Math.round(quantile(fullHits.filter((h) => h.y < curYear).map((h) => h.k), 0.5));
  const earliestFull = fullHits.reduce((a, b) => (b.k < a.k ? b : a));
  const latestFull = fullHits.reduce((a, b) => (b.k > a.k ? b : a));

  // Highest level during the winter hold (after a storm).
  const wFrom = keyAt(WINTER_FROM), wTo = keyAt(REFILL_START);
  let wHi = -1;
  for (let i = 0; i < N; i++) if ((key[i] >= wFrom || key[i] < wTo) && (wHi < 0 || v[i] > v[wHi])) wHi = i;

  return {
    L, curYear, firstYear, byKey, byYear, years: Object.keys(byYear).map(Number).sort((a, b) => a - b),
    p10, p50, p90, last, cur, cur24, keyT, todayMs: t[L], ly: v[L - 365], lyI: L - 365,
    todays, todaysYr, typical: quantile(todays, 0.5), rankText, d7: cur - v[L - 7],
    // Typical summer full: the smoothed median across May 10–30.
    summerFull: mean(p50.slice(keyAt([4, 10]), keyAt([4, 31]))),
    fullHits, lowHits, medFullK, earliestFull, latestFull, wHi
  };
}

function phaseOf(k) {
  if (k >= keyAt(WINTER_FROM) || k < keyAt(REFILL_START)) return 'Winter hold';
  if (k < keyAt(SUMMER_FULL_FROM)) return 'Spring refill';
  if (k < keyAt(DECLINE_FROM)) return 'Summer full';
  if (k < keyAt(FALL_FROM)) return 'Summer decline';
  return 'Fall rains · drawdown to winter';
}

// Days from today to the next occurrence (after today) of a month/day.
function daysUntil(S, [m, d]) {
  let ms = Date.UTC(S.curYear, m, d);
  if (ms <= S.todayMs) ms = Date.UTC(S.curYear + 1, m, d);
  return Math.round((ms - S.todayMs) / DAY);
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
// A null breaks the line, except at index `bridge` (Feb 29 in a non-leap year).
function pathOf(arr, len, Y, bridge = -1) {
  let p = '', pen = false;
  arr.forEach((val, j) => {
    if (val == null) { if (j !== bridge) pen = false; return; }
    p += (pen ? 'L' : 'M') + xAt(j, len) + ' ' + Y(val).toFixed(1); pen = true;
  });
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

const inchesOff = (x, up, down) => Math.abs(x * 12).toFixed(1) + ' inches ' + (x >= 0 ? up : down);

function renderHero(D, S) {
  const { cur, ly, summerFull, d7 } = S;
  $('phase').textContent = phaseOf(S.keyT);
  $('cur').textContent = cur.toFixed(2);
  $('d1').textContent = sg(cur - S.cur24) + ' ft';
  $('d7').textContent = sg(d7) + ' ft';
  $('d30').textContent = sg(cur - D.v[S.L - 30]) + ' ft';

  const dir = d7 < -0.02 ? 'falling' : d7 > 0.02 ? 'rising' : 'holding steady';
  $('heroLine').textContent = 'The lake is ' + dir + ', ' + inchesOff(cur - WINTER_FT, 'above', 'below') + ' the winter hold and ' +
    inchesOff(summerFull - cur, 'below', 'above') + ' a typical summer full. It’s ' + S.rankText + ' past years on ' + fs(S.todayMs) + '.';

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
  for (let x = 0; x < 220; x += 10) wave += ' Q' + (x + 5) + ' ' + (wy + (x / 10 % 2 ? 3 : -3)).toFixed(1) + ' ' + (x + 10) + ' ' + wy.toFixed(1);
  const waterH = (320 - wy).toFixed(1);
  const mono = 'font-family="IBM Plex Mono, monospace"';
  const fullY = Ys(summerFull), winterY = Ys(WINTER_FT), lyY = Ys(ly);
  // Keep each side label clear of the "now" label, and last year's of all of them.
  const nowTextY = wy + 5;
  const labelY = (y) => Math.abs(y + 4 - nowTextY) < 14 ? (y + 4 < nowTextY ? nowTextY - 14 : nowTextY + 14) : y + 4;
  const fullTextY = labelY(fullY), winterTextY = labelY(winterY);
  const taken = [nowTextY, fullTextY, winterTextY];
  const lyTextY = [lyY + 4, lyY + 16, lyY - 8, lyY + 28, lyY - 20]
    .find((y) => taken.every((o) => Math.abs(y - o) >= 13)) ?? lyY + 4;
  $('gauge').innerHTML = `
    <rect x="0" y="${wy.toFixed(1)}" width="220" height="${waterH}" fill="#2F78C4" opacity="0.28"></rect>
    <rect x="24" y="10" width="64" height="310" fill="#F4F1E8"></rect>
    <path d="${ticks}" stroke="#10222F" stroke-width="2" fill="none"></path>
    <path d="${major}" stroke="#10222F" stroke-width="4" fill="none"></path>
    <text x="84" y="54" ${mono} font-size="15" font-weight="600" fill="#10222F" text-anchor="end">22</text>
    <text x="84" y="154" ${mono} font-size="15" font-weight="600" fill="#10222F" text-anchor="end">21</text>
    <text x="84" y="254" ${mono} font-size="15" font-weight="600" fill="#10222F" text-anchor="end">20</text>
    <rect x="24" y="${wy.toFixed(1)}" width="64" height="${waterH}" fill="#2F78C4" opacity="0.55"></rect>
    <path d="${wave}" stroke="#8EC1F0" stroke-width="2.5" fill="none"></path>
    <path d="M88 ${fullY.toFixed(1)}H104" stroke="#A9BAC2" stroke-width="1" fill="none"></path>
    <text x="108" y="${fullTextY.toFixed(1)}" ${mono} font-size="11" fill="#A9BAC2">${summerFull.toFixed(1)} summer full</text>
    <path d="M88 ${winterY.toFixed(1)}H104" stroke="#A9BAC2" stroke-width="1" fill="none"></path>
    <text x="108" y="${winterTextY.toFixed(1)}" ${mono} font-size="11" fill="#A9BAC2">${WINTER_FT.toFixed(1)} winter hold</text>
    <path d="M88 ${lyY.toFixed(1)}H102" stroke="#F0A060" stroke-width="2.5" fill="none"></path>
    <text x="108" y="${lyTextY.toFixed(1)}" ${mono} font-size="11" fill="#F0A060">last yr ${ly.toFixed(2)}</text>
    <path d="M90 ${wy.toFixed(1)}l12 -7v14z" fill="#EAF0EE"></path>
    <text x="108" y="${nowTextY.toFixed(1)}" ${mono} font-size="14" font-weight="600" fill="#EAF0EE">now ${cur.toFixed(2)}</text>`;
}

function renderTiles(D, S) {
  const { v, t, N } = D;
  const { cur, ly, typical, rankText, d7 } = S;
  let hiI = N - 365, loI = N - 365;
  for (let i = N - 365; i < N; i++) { if (v[i] > v[hiI]) hiI = i; if (v[i] < v[loI]) loI = i; }
  const tiles = [
    { label: 'vs. last year', value: sg(cur - ly) + ' ft', sub: fd(t[S.lyI]) + ': ' + ly.toFixed(2) + ' ft' },
    { label: 'vs. typical for ' + fs(S.todayMs), value: sg(cur - typical) + ' ft', sub: 'Median ' + typical.toFixed(2) + ' ft · ' + rankText.charAt(0).toUpperCase() + rankText.slice(1) + ' years' },
    { label: 'Last 7 days', value: sg(d7) + ' ft', sub: d7 > 0.02 ? 'Rising at about ' + (d7 * 12).toFixed(1) + ' in per week' : d7 < -0.02 ? 'Falling at about ' + Math.abs(d7 * 12).toFixed(1) + ' in per week' : 'Within a couple hundredths all week' },
    { label: '12-month range', value: v[loI].toFixed(2) + '–' + v[hiI].toFixed(2), sub: 'Low ' + fd(t[loI]) + ' · High ' + fd(t[hiI]) }
  ];
  $('tiles').innerHTML = tiles.map((tl) => `<div class="tile">
    <span class="mono eyebrow">${esc(tl.label)}</span>
    <span class="tile-value">${esc(tl.value)}</span>
    <span class="tile-sub">${esc(tl.sub)}</span></div>`).join('');
}

// Builds everything for the main chart that doesn't depend on hover position.
// `hy` is the highlighted year in By year mode, or null.
function buildChart(D, S, range, hy) {
  const { t, v, N, key } = D;
  const { p10, p50, p90, firstYear, curYear, byYear } = S;
  if (range !== 'yr') {
    const all = range === 'all';
    let times, a;
    const b = [], lo = [], hi = [], med = [];
    if (all) {
      times = []; a = [];
      for (let i = 0; i + 7 <= N; i += 7) { times.push(t[i]); a.push(mean(v.slice(i, i + 7))); }
      times.push(t[N - 1]); a.push(v[N - 1]);
    } else {
      const st = Math.max(0, N - range);
      times = t.slice(st); a = v.slice(st);
      if (range <= 365 && st >= 365) {
        for (let i = st; i < N; i++) { b.push(v[i - 365]); lo.push(p10[key[i]]); hi.push(p90[key[i]]); med.push(p50[key[i]]); }
      }
    }
    const len = a.length;
    const dm = domain(a.concat(b, lo, hi));
    const Y = mkY(dm.lo, dm.hi);
    const xTicks = [];
    for (let j = 0; j < len; j++) {
      const d = new Date(times[j]); let label = null;
      if (all) { if (j && new Date(times[j - 1]).getUTCFullYear() !== d.getUTCFullYear() && d.getUTCFullYear() % 5 === 0) label = String(d.getUTCFullYear()); }
      else if (range <= 31) { if ((len - 1 - j) % 7 === 0) label = fs(times[j]); }
      else if (range <= 365) { if (d.getUTCDate() === 1) label = M[d.getUTCMonth()] + (d.getUTCMonth() === 0 ? ' ’' + String(d.getUTCFullYear()).slice(2) : ''); }
      else if (d.getUTCMonth() === 0 && d.getUTCDate() === 1) label = String(d.getUTCFullYear());
      const left = j / (len - 1) * 100;
      if (label && left > 3 && left < 97) xTicks.push({ label, left: pct(left) });
    }
    const hasPrior = b.length > 0;
    const legend = [{ label: all ? 'Weekly average' : 'This period', border: BLUE }];
    if (hasPrior) legend.push({ label: 'Same days last year', border: ORANGE_D }, { label: 'Median, ' + firstYear + '–' + (curYear - 1), border: INK_D }, { label: 'Middle 80% of years', border: BAND });
    return {
      len, Y, all, times, a, b, med, hasPrior,
      paths: { a: pathOf(a, len, Y), b: pathOf(b, len, Y), bDash: '6 4', c: pathOf(med, len, Y), g: '', h: '', band: bandOf(lo, hi, len, Y) },
      yTicks: yTicksOf(dm, Y), xTicks, legend, todayLeft: null
    };
  }
  // By year: every year laid over Jan–Dec.
  const years = S.years;
  const allv = [];
  years.forEach((y) => byYear[y].forEach((x) => { if (x != null) allv.push(x); }));
  const dm = domain(allv);
  const Y = mkY(dm.lo, dm.hi);
  const yPath = (y) => pathOf(byYear[y], 366, Y, FEB29);
  const showHy = hy != null && hy !== curYear && hy !== curYear - 1;
  let g = '';
  years.forEach((y) => { if (y !== curYear && y !== curYear - 1 && y !== hy) g += yPath(y); });
  const MS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const legend = [{ label: String(curYear), border: BLUE }, { label: String(curYear - 1), border: ORANGE }];
  if (showHy) legend.push({ label: String(hy), border: INK });
  legend.push({ label: 'Median', border: INK_D }, { label: 'Other years', border: GREY });
  return {
    len: 366, Y, byYear: true, hy: showHy ? hy : null,
    paths: { a: yPath(curYear), b: byYear[curYear - 1] ? yPath(curYear - 1) : '', bDash: '0', c: pathOf(p50, 366, Y), g, h: showHy ? yPath(hy) : '', band: '' },
    yTicks: yTicksOf(dm, Y),
    xTicks: MS.map((d, m) => ({ label: M[m], left: pct((d + 15) / 365 * 100) })),
    legend, todayLeft: pct(S.keyT / 365 * 100)
  };
}

function renderChart(C) {
  const p = C.paths;
  $('pA').setAttribute('d', p.a);
  $('pB').setAttribute('d', p.b);
  $('pB').setAttribute('stroke-dasharray', p.bDash);
  $('pC').setAttribute('d', p.c);
  $('pG').setAttribute('d', p.g);
  $('pH').setAttribute('d', p.h);
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
  if (!C.byYear) {
    const W = C.len;
    j = hov == null ? W - 1 : Math.round(hov * (W - 1));
    dotVal = C.a[j];
    items = [{ label: C.all ? 'Week avg' : 'Level', value: ft(C.a[j]), border: BLUE }];
    if (C.hasPrior) items.push({ label: 'Last year', value: ft(C.b[j]), border: ORANGE_D }, { label: 'Median', value: ft(C.med[j]), border: INK_D });
    if (hov != null) items.push({ label: 'vs. now', value: sg(S.cur - C.a[j]) + ' ft', border: '0 solid transparent' });
    date = (C.all ? 'Week of ' : '') + fd(C.times[j]);
  } else {
    const { curYear, byYear } = S;
    j = hov == null ? S.keyT : Math.round(hov * 365);
    dotVal = byYear[curYear][j];
    items = [{ label: String(curYear), value: ft(byYear[curYear][j]), border: BLUE }];
    if (byYear[curYear - 1]) items.push({ label: String(curYear - 1), value: ft(byYear[curYear - 1][j]), border: ORANGE });
    if (C.hy != null) items.push({ label: String(C.hy), value: ft(byYear[C.hy][j]), border: INK });
    items.push({ label: 'Median', value: ft(S.p50[j]), border: INK_D });
    date = fk(j);
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

function renderYearPicker(S, hy) {
  $('hyLabel').textContent = hy == null ? 'None' : String(hy);
  if (hy == null) { $('hyNote').textContent = 'Step through any year from ' + S.firstYear + ' to ' + S.curYear; return; }
  const yv = S.byYear[hy].filter((x) => x != null);
  $('hyNote').textContent = hy + ': low ' + Math.min(...yv).toFixed(2) + ' · high ' + Math.max(...yv).toFixed(2) + ' ft';
}

const PER = [[1, '24 hours'], [3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '30 days'], [90, '90 days'], [365, '1 year']];

function renderChanges(D, S) {
  const ds = PER.map(([p]) => p === 1 ? S.cur - S.cur24 : S.cur - D.v[S.L - p]);
  const mx = Math.max(0.05, ...ds.map(Math.abs));
  $('changes').innerHTML = PER.map(([, label], k) => {
    const d = ds[k], w = Math.abs(d) / mx * 50;
    return `<div class="change-row"><span class="lbl">${label}</span><div class="track"><div class="axis"></div>
      <div class="bar" style="left:${pct(d < 0 ? 50 - w : 50)};width:${pct(w)};background:${d >= 0 ? '#1D5FA6' : '#8A99A2'}"></div></div>
      <span class="val">${sg(d)}</span></div>`;
  }).join('');
}

function renderN(D, S, n) {
  const nn = Math.min(Math.max(1, n), S.L, 365);
  const from = D.v[S.L - nn];
  $('nLabel').textContent = nn === 1 ? '1 day' : nn % 7 === 0 ? nn + ' days (' + nn / 7 + ' wk)' : nn + ' days';
  $('nDelta').textContent = sg(S.cur - from);
  $('nFrom').textContent = 'From ' + from.toFixed(2) + ' ft on ' + fd(D.t[S.L - nn]) + ' to ' + S.cur.toFixed(2) + ' ft now';
}

function renderAhead(D, S) {
  const { t, v, N } = D;
  const { cur, todayMs, p50, firstYear, curYear } = S;
  const kDec = daysUntil(S, WINTER_FROM), kFeb = daysUntil(S, REFILL_START);

  // Each past year's next 12 weeks from today's calendar date, shifted to start
  // at today's level. The shift fades out by Dec 1, when the Locks bring every
  // year to about 20.0 ft.
  const paths = [];
  const tm = new Date(todayMs);
  for (let y = firstYear; y < curYear; y++) {
    const iy = Math.round((Date.UTC(y, tm.getUTCMonth(), tm.getUTCDate()) - t[0]) / DAY);
    if (iy < 0 || iy + 84 >= N) continue;
    const p = [];
    for (let k = 0; k <= 84; k++) p.push(v[iy + k] + (cur - v[iy]) * Math.max(0, 1 - k / Math.max(1, kDec)));
    paths.push(p);
  }
  const pm = [], pu = [], pl = [];
  for (let k = 0; k <= 84; k++) { const col = paths.map((p) => p[k]); pm.push(quantile(col, 0.5)); pu.push(quantile(col, 0.9)); pl.push(quantile(col, 0.1)); }
  const act = v.slice(N - 29);
  act[28] = cur;
  const TOT = 113;
  const adm = domain(act.concat(pu, pl));
  const AY = mkY(adm.lo, adm.hi);
  const X = (k) => ((k + 28) / (TOT - 1) * 1000).toFixed(1);
  const line = (xs, k0) => xs.map((x, j) => (j ? 'L' : 'M') + X(j + k0) + ' ' + AY(x).toFixed(1)).join('');
  let bPath = line(pu, 0);
  for (let k = 84; k >= 0; k--) bPath += 'L' + X(k) + ' ' + AY(pl[k]).toFixed(1);
  bPath += 'Z';
  const at = (k) => pct((k + 28) / (TOT - 1) * 100);

  const xt = [{ label: fs(t[N - 29]), left: '4%' }, { label: 'Today', left: at(0) }];
  for (let k = 7; k < 80; k++) { const d = new Date(todayMs + k * DAY); if (d.getUTCDate() === 1) xt.push({ label: M[d.getUTCMonth()] + ' 1', left: at(k) }); }
  xt.push({ label: fs(todayMs + 84 * DAY), left: '96%' });

  $('aheadNote').textContent = 'How the next 12 weeks went in each of ' + paths.length + ' past years, started from today’s level. Dashed line is the median; the band covers the middle 80%.';
  $('aActual').setAttribute('d', line(act, -28));
  $('aProj').setAttribute('d', line(pm, 0));
  $('aBand').setAttribute('d', bPath);
  const ticks = yTicksOf(adm, AY);
  $('aheadY').innerHTML = yLabelsHtml(ticks);
  $('aheadGrid').innerHTML = gridHtml(ticks);
  $('aheadX').innerHTML = xLabelsHtml(xt);
  $('aToday').style.left = at(0);
  $('aDec1').hidden = kDec > 84;
  $('aDec1').style.left = at(kDec);

  // Milestones, soonest first.
  const { medFullK, earliestFull, latestFull, wHi } = S;
  const pDec = kDec <= 84 ? pm[kDec] : p50[keyAt(WINTER_FROM)];
  let fullMs = Date.UTC(curYear, 0, 1) + medFullK * DAY;
  if (fullMs <= todayMs) fullMs = Date.UTC(curYear + 1, 0, 1) + medFullK * DAY;
  const kFull = Math.round((fullMs - todayMs) / DAY);
  const inDays = (k) => 'In ' + k + ' day' + (k === 1 ? '' : 's');
  const ms = [
    { k: kDec, when: 'Dec 1', title: 'Winter hold reached', sub: inDays(kDec) + ' · about ' + Math.abs((pDec - cur) * 12).toFixed(1) + ' in ' + (pDec < cur ? 'lower' : 'higher') + ' than today', level: '≈' + pDec.toFixed(2) + ' ft' },
    { k: kDec + 14, when: 'Dec–Feb', title: 'Lowest water of the year', sub: 'Storms have pushed it as high as ' + v[wHi].toFixed(2) + ' ft (' + M[new Date(t[wHi]).getUTCMonth()] + ' ' + D.yr[wHi] + ').', level: '≈' + p50[keyAt([0, 15])].toFixed(2) + ' ft' },
    { k: kFeb, when: 'Feb 15', title: 'Spring refill begins', sub: inDays(kFeb) + ' · the Locks start holding water back', level: '↑' },
    { k: kFull, when: fk(medFullK), title: 'Summer full', sub: 'Median date, ' + inDays(kFull).toLowerCase() + ' · has ranged ' + fk(earliestFull.k) + ' to ' + fk(latestFull.k), level: '≈' + S.summerFull.toFixed(2) + ' ft' }
  ].sort((a, b) => a.k - b.k);
  $('milestones').innerHTML = ms.map((m) => `<div class="ms-row"><span class="ms-when">${esc(m.when)}</span>
    <span class="ms-body"><span class="ms-title">${esc(m.title)}</span><span class="ms-sub">${esc(m.sub)}</span></span>
    <span class="ms-level">${esc(m.level)}</span></div>`).join('');
}

function renderRecords(D, S) {
  const { v, t, N } = D;
  const { todays, todaysYr, typical, todayMs, fullHits, lowHits, earliestFull, latestFull, medFullK, wHi } = S;
  let hiAll = 0, loAll = 0;
  v.forEach((x, i) => { if (x > v[hiAll]) hiAll = i; if (x < v[loAll]) loAll = i; });
  let tHi = 0, tLo = 0;
  todays.forEach((x, i) => { if (x > todays[tHi]) tHi = i; if (x < todays[tLo]) tLo = i; });
  const thisFull = fullHits.find((h) => h.y === S.curYear);
  const earliestLow = lowHits.length ? lowHits.reduce((a, b) => (b.k < a.k ? b : a)) : null;
  const records = [
    { label: 'Highest daily level', value: v[hiAll].toFixed(2) + ' ft', sub: 'All years', when: fd(t[hiAll]) },
    { label: 'Lowest daily level', value: v[loAll].toFixed(2) + ' ft', sub: 'All years', when: fd(t[loAll]) },
    { label: 'Highest on ' + fs(todayMs), value: todays[tHi].toFixed(2) + ' ft', sub: 'Today: ' + S.cur.toFixed(2) + ' ft', when: String(todaysYr[tHi]) },
    { label: 'Lowest on ' + fs(todayMs), value: todays[tLo].toFixed(2) + ' ft', sub: 'Median ' + typical.toFixed(2) + ' ft', when: String(todaysYr[tLo]) },
    { label: 'Earliest refill to ' + FULL_FT.toFixed(1) + ' ft', value: fk(earliestFull.k), sub: thisFull ? 'This year: ' + fk(thisFull.k) : 'Median ' + fk(medFullK), when: String(earliestFull.y) },
    { label: 'Latest refill to ' + FULL_FT.toFixed(1) + ' ft', value: fk(latestFull.k), sub: 'Median ' + fk(medFullK), when: String(latestFull.y) },
    { label: 'Earliest summer drop to ' + LOW_FT.toFixed(1) + ' ft', value: earliestLow ? fk(earliestLow.k) : '—', sub: lowHits.length + ' of ' + (S.curYear - S.firstYear) + ' summers reached it', when: earliestLow ? String(earliestLow.y) : '' },
    { label: 'Highest winter-hold level', value: v[wHi].toFixed(2) + ' ft', sub: 'Dec 1 – Feb 14, after a storm', when: fd(t[wHi]) }
  ];
  $('recordsSpan').textContent = fd(t[0]) + ' – ' + fd(t[N - 1]) + ' · ' + N.toLocaleString('en-US') + ' days';
  $('records').innerHTML = records.map((r) => `<div class="record">
    <span class="rec-label">${esc(r.label)}</span><span class="rec-value">${esc(r.value)}</span>
    <span class="rec-sub">${esc(r.sub)}</span><span class="rec-when">${esc(r.when)}</span></div>`).join('');
}

// Largest 3-day moves in direction dir (+1 rises, −1 drops), at least 15 days
// apart, skipping moves that end inside the [from, to] calendar window.
function renderMoves(D, id, dir, skip) {
  const { v, t, N, key } = D;
  const [ex0, ex1] = skip ? skip.map(keyAt) : [Infinity, -Infinity];
  const picks = [], used = new Array(N).fill(false);
  for (let r = 0; r < 8; r++) {
    let best = -1, bv = -Infinity;
    for (let i = 3; i < N; i++) {
      if (used[i] || (key[i] >= ex0 && key[i] <= ex1)) continue;
      const d = dir * (v[i] - v[i - 3]);
      if (d > bv) { bv = d; best = i; }
    }
    if (best < 0 || bv <= 0) break;
    picks.push(best);
    for (let i = Math.max(0, best - 15); i < Math.min(N, best + 16); i++) used[i] = true;
  }
  const color = dir > 0 ? '#1D5FA6' : '#B05410';
  $(id).innerHTML = picks.map((i) => {
    const s0 = Math.max(0, i - 7), s1 = Math.min(N - 1, i + 13);
    const seg = v.slice(s0, s1 + 1);
    const lo = Math.min(...seg), hi = Math.max(...seg);
    const sx = (j) => (j / 20 * 120).toFixed(1), sy = (x) => (36 - (x - lo) / Math.max(0.01, hi - lo) * 32).toFixed(1);
    const spark = seg.map((x, j) => (j ? 'L' : 'M') + sx(j) + ' ' + sy(x)).join('');
    let hl = '';
    for (let k = i - 3; k <= i; k++) if (k >= s0) hl += (hl ? 'L' : 'M') + sx(k - s0) + ' ' + sy(v[k]);
    // First day the lake is back within 0.03 ft of where the move started.
    let back = i;
    while (back < N - 1 && back < i + 90 && dir * (v[back] - v[i - 3]) > 0.03) back++;
    const tail = back >= N - 1 ? (dir > 0 ? 'still elevated' : 'still low')
      : back >= i + 90 ? (dir > 0 ? 'stayed up' : 'stayed down') + ' 90+ days'
      : (dir > 0 ? 'back down' : 'back up') + ' in ' + (back - i) + ' days';
    return `<div class="storm">
      <div class="storm-head"><span class="storm-date">${fd(t[i - 3])}</span><span class="storm-rise${dir > 0 ? '' : ' drop'}">${sg(v[i] - v[i - 3])} ft</span></div>
      <svg viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
        <path d="${spark}" fill="none" stroke="#8A99A2" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>
        <path d="${hl}" fill="none" stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke"></path>
      </svg>
      <span class="storm-sub">${v[i - 3].toFixed(2)} → ${v[i].toFixed(2)} ft · ${tail}</span></div>`;
  }).join('');
}

function renderStorms(D, S) {
  $('firstYear').textContent = S.firstYear;
  $('dropsFirstYear').textContent = S.firstYear;
  renderMoves(D, 'storms', 1, REFILL_RISES);
  renderMoves(D, 'drops', -1);
}

// ---------- boot ----------

function formatUpdated(last) {
  const d = new Date(last.at);
  if (!last.hasTime) return 'Updated ' + fd(last.at);
  let h = d.getUTCHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
  return 'Updated ' + fd(last.at) + ', ' + h + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' ' + ap;
}

function start(D) {
  const S = analyze(D);

  $('updated').textContent = formatUpdated(S.last);
  renderHero(D, S);
  renderTiles(D, S);
  renderChanges(D, S);
  renderAhead(D, S);
  renderRecords(D, S);
  renderStorms(D, S);

  // Range buttons, year stepper + hover
  let range = 365, hy = null, hov = null, C;
  const RANGES = [[30, '30D'], [90, '90D'], [365, '1Y'], [1826, '5Y'], ['all', 'All'], ['yr', 'By year']];
  const draw = () => {
    C = buildChart(D, S, range, hy == null ? null : S.years[hy]);
    renderChart(C);
    renderHover(D, S, C, hov);
    $('yearRow').hidden = range !== 'yr';
    renderYearPicker(S, hy == null ? null : S.years[hy]);
    $('ranges').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === String(range))));
  };
  $('ranges').innerHTML = RANGES.map(([k, label]) => `<button type="button" data-k="${k}" aria-pressed="false">${label}</button>`).join('');
  $('ranges').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const k = b.dataset.k;
    range = k === 'yr' || k === 'all' ? k : +k; hov = null; draw();
  });
  // Stepping past either end clears the highlight.
  const step = (dlt) => {
    const n = S.years.length;
    let nx = hy == null ? (dlt > 0 ? 0 : n - 1) : hy + dlt;
    if (nx < 0 || nx >= n) nx = null;
    hy = nx; draw();
  };
  $('prevYear').addEventListener('click', () => step(-1));
  $('nextYear').addEventListener('click', () => step(1));
  const plot = $('plot');
  plot.addEventListener('pointermove', (e) => {
    const r = plot.getBoundingClientRect();
    hov = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    renderHover(D, S, C, hov);
  });
  plot.addEventListener('pointerleave', () => { hov = null; renderHover(D, S, C, hov); });
  draw();

  const slider = $('ndays');
  slider.max = String(Math.min(365, S.L));
  slider.value = String(Math.min(14, S.L));
  slider.addEventListener('input', () => renderN(D, S, parseInt(slider.value, 10) || 1));
  renderN(D, S, +slider.value);

  $('loading').hidden = true;
  $('app').hidden = false;
}

fetch(DATA_URL, { cache: 'no-cache' })
  .then((r) => { if (!r.ok) throw new Error('Could not load ' + DATA_URL + ' (HTTP ' + r.status + ')'); return r.text(); })
  .then((text) => start(parseReadings(text)))
  .catch((err) => {
    console.error(err);
    $('updated').textContent = 'Data unavailable';
    $('loading').hidden = true;
    const box = $('error');
    box.textContent = 'Lake data could not be loaded: ' + err.message + (location.protocol === 'file:' ? ' — open this page through a local web server (e.g. python3 -m http.server), not as a file.' : '');
    box.hidden = false;
  });
