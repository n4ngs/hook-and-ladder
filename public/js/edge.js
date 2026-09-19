'use strict';
/* Hook & Ladder — Edge Finder.
   The sharp books' price, with the bookmaker's cut removed, is the fair price. Every other book's current price is
   scored against it: edge = expected return per $1 = P(win) × decimal odds + P(push) − 1.

   Fair source, per game and market: Pinnacle if it has both sides (and a fresh price), else Circa, else the
   market consensus. When a book hangs a different number than the sharp line (+7.5 vs +7), the fair chance is
   re-estimated with a margin model: a normal curve around the market's expected margin (SIGMA points; 14 for
   totals), bent by how often each exact margin/total actually happened last season (S.keys), so crossing 3, 7,
   10 or 14 is worth more than crossing 11. The curve's centre is fitted so it reproduces the sharp no-vig price at
   the sharp number exactly; it's only used to move between numbers. Those rows are labeled "est.".
   Without S.keys the curve is a plain normal and the UI says "approx.".

   Guards: pre-game only, visible books only, prices older than 15 min ignored (isOld), line gaps over 3 points
   skipped, moneylines longer than +500 skipped, edges over 12% treated as a stale or bad feed and dropped. Stake: quarter-Kelly with 1 unit = 1% of
   bankroll (units of S.unit dollars), capped at 2 units. A suggestion, not advice. */

const EDGE_MIN = 0.01;          // show from +1%
const EDGE_ALERT = 0.02;        // alert from +2%
const EDGE_MAX = 0.12;          // above this it's almost always a stale or broken price
const EDGE_MAX_GAP = 3;         // points between a book's line and the sharp line we'll model across
const EDGE_ML_LONG = 500;       // skip moneylines longer than +500: proportional vig removal flatters longshots
const EDGE_TOTAL_SD = 14;       // spread of final totals around the market total, points (approx.)
const EDGE_SRC = ['pin', 'circa', 'cons'];

// ------------------------------------------------------------ key-number shape from last season
let edgeLumpSrc = null, edgeLumpM = null, edgeLumpT = null;
// How much more (or less) often each exact value happened than its neighbours: 7 ≈ 1.9, 8 ≈ 0.5.
function edgeLumpOf(hist, min) {
  const out = new Map();
  if (!hist) return out;
  const c = (v) => Number(hist[v]) || 0;
  for (let v = min; v <= 130; v++) {
    let sum = 0, n = 0;
    for (let d = -3; d <= 3; d++) { const x = v + d; if (x >= min) { sum += c(x); n++; } }
    if (sum < 25 || !n) continue; // too thin to trust; stays at 1
    out.set(v, clamp(c(v) / (sum / n), 0.25, 4));
  }
  return out;
}
function edgeLumps() {
  if (edgeLumpSrc !== S.keys) {
    edgeLumpSrc = S.keys;
    edgeLumpM = S.keys?.n ? edgeLumpOf(S.keys.margin, 1) : new Map();
    edgeLumpT = S.keys?.n ? edgeLumpOf(S.keys.total, 0) : new Map();
  }
  return { m: edgeLumpM, t: edgeLumpT };
}
const edgeModeled = () => !!S.keys?.n;

// Probability of each integer outcome: margins (no ties in college football) or totals.
function edgePmf(kind, mu) {
  const L = edgeLumps()[kind === 's' ? 'm' : 't'];
  const sd = kind === 's' ? SIGMA : EDGE_TOTAL_SD;
  const lo = kind === 's' ? Math.floor(mu - 5 * sd) : Math.max(0, Math.floor(mu - 5 * sd));
  const hi = Math.ceil(mu + 5 * sd);
  const pts = [];
  let z = 0;
  for (let v = lo; v <= hi; v++) {
    if (kind === 's' && v === 0) continue;
    const w = Math.exp(-0.5 * ((v - mu) / sd) ** 2) * (L.get(Math.abs(v)) ?? 1);
    pts.push([v, w]); z += w;
  }
  return pts.map(([v, w]) => [v, w / z]);
}
// Win / push chances for "outcome + line > 0" (spread, home side) or "total > line" (over).
function edgeWP(pmf, kind, line) {
  let w = 0, p = 0;
  for (const [v, q] of pmf) {
    const x = kind === 's' ? v + line : v - line;
    if (x > 0) w += q; else if (x === 0) p += q;
  }
  return { w, p };
}
// Fit the curve's centre so it reproduces the sharp no-vig chance at the sharp number.
function edgeFit(kind, line, pNoVig) {
  let lo = kind === 's' ? -90 : 0, hi = kind === 's' ? 90 : 160;
  for (let i = 0; i < 36; i++) {
    const mid = (lo + hi) / 2;
    const { w, p } = edgeWP(edgePmf(kind, mid), kind, line);
    if (w / (1 - p || 1) < pNoVig) lo = mid; else hi = mid;
  }
  return edgePmf(kind, (lo + hi) / 2);
}

// ------------------------------------------------------------ the scoring
const edgeSrcOf = (g, mkt) => (mkt === 'h1s' ? g.h1 : g.books) || {};
// The fair price for one market: the first fresh sharp source with both sides priced.
function edgeFair(g, mkt) {
  const src = edgeSrcOf(g, mkt);
  const [a, b] = mkt === 't' ? ['over', 'under'] : ['home', 'away'];
  for (const k of EDGE_SRC) {
    const L = src[k];
    if (!L || isOld(L)) continue;
    const pa = sideOf(L, mkt, a), pb = sideOf(L, mkt, b);
    if (!pa || !pb || pa.odds == null || pb.odds == null) continue;
    if (mkt !== 'ml' && pa.line == null) continue;
    const nv = noVig(pa.odds, pb.odds);
    if (!nv) continue;
    return { book: k, line: pa.line, p: nv.a, sideA: a };
  }
  return null;
}

function edgeScoreGame(g) {
  const out = [];
  if (!g || !isPre(g) || g.state === 'off') return out;
  const books = visibleBooks().map((b) => b.key);
  for (const mkt of ['s', 't', 'ml', 'h1s']) {
    const F = edgeFair(g, mkt);
    if (!F) continue;
    const kind = mkt === 't' ? 't' : 's';
    let pmf = null;
    for (const side of mkt === 't' ? ['over', 'under'] : ['home', 'away']) {
      const pSide = side === F.sideA ? F.p : 1 - F.p;
      // the sharp line from this side's point of view
      const sLine = mkt === 'ml' ? null : mkt === 't' ? F.line : side === 'home' ? F.line : -F.line;
      for (const k of books) {
        if (k === F.book) continue;
        const L = edgeSrcOf(g, mkt)[k];
        if (!L || isOld(L)) continue;
        const px = sideOf(L, mkt, side);
        if (!px || px.odds == null || Math.abs(px.odds) < 100) continue;
        if (mkt === 'ml' && (px.odds > EDGE_ML_LONG || pSide < 100 / (100 + EDGE_ML_LONG))) continue;
        const d = dec(px.odds);
        let w = pSide, push = 0, est = false;
        if (mkt !== 'ml') {
          if (px.line == null) continue;
          if (px.line !== sLine) {
            if (mkt === 'h1s' || Math.abs(px.line - sLine) > EDGE_MAX_GAP) continue; // no first-half margin data
            pmf = pmf || edgeFit(kind, F.line, F.p); // fitted from the home / over side
            // turn this side's line into the home / over frame
            const r = kind === 't' ? edgeWP(pmf, 't', px.line) : side === 'home' ? edgeWP(pmf, 's', px.line) : edgeWP(pmf, 's', -px.line);
            if (kind === 't' && side === 'under') { push = r.p; w = 1 - r.w - r.p; }
            else if (kind === 's' && side === 'away') {
              // away covers when home margin < away line
              push = r.p; w = 1 - r.w - r.p;
            } else { push = r.p; w = r.w; }
            est = true;
          } else if (Number.isInteger(px.line) && mkt !== 'h1s') {
            // same whole number as the sharp book: the no-vig chance excludes pushes; put them back
            pmf = pmf || edgeFit(kind, F.line, F.p);
            const r = edgeWP(pmf, kind, kind === 's' && side === 'away' ? -px.line : px.line);
            push = r.p; w = pSide * (1 - push);
          }
        }
        const ev = w * d + push - 1;
        if (ev < EDGE_MIN || ev > EDGE_MAX) continue;
        const pFair = w / (1 - push || 1);
        const b = d - 1;
        const units = Math.min(2, Math.round(((0.25 * ev) / b) * 100 * 10) / 10);
        out.push({ g, gid: g.id, mkt, side, book: k, line: px.line, odds: px.odds, ev, p: pFair, push, fairAm: probToAm(pFair), src: F.book, srcLine: sLine, est, units });
      }
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

// Memo: games are replaced on every update, so key on the object and on everything else the score reads.
const edgeMemo = new WeakMap();
const edgeVer = () => `${S.lastMsg}|${[...S.hidden].sort().join(',')}|${S.keys ? 1 : 0}|${S.books.length}|${Math.floor(serverNow() / 60e3)}`;
function edgesFor(g) {
  if (!g) return [];
  const v = edgeVer();
  const m = edgeMemo.get(g);
  if (m && m.v === v) return m.list;
  const list = edgeScoreGame(g);
  edgeMemo.set(g, { v, list });
  return list;
}
function edgeAll() {
  return allGames().filter(isPre).flatMap(edgesFor).sort((a, b) => b.ev - a.ev);
}

// ------------------------------------------------------------ words
const edgePctTxt = (ev) => `+${(ev * 100).toFixed(1)}%`;
function edgePick(e) {
  const g = e.g;
  if (e.mkt === 't') return `${e.side === 'over' ? 'Over' : 'Under'} ${fmtTot(e.line)}`;
  const t = g[e.side].abbr;
  if (e.mkt === 'ml') return `${t} ML`;
  if (e.mkt === 'h1s') return `${t} 1H ${fmtPts(e.line)}`;
  return `${t} ${fmtPts(e.line)}`;
}
const edgeLineTxt = (e, v) => (e.mkt === 't' ? fmtTot(v) : fmtPts(v));
function edgeKick(g) {
  if (g.tbd) return 'Time TBA';
  const ms = Date.parse(g.start) - serverNow();
  if (ms <= 0) return 'Kicking off';
  const m = Math.round(ms / 60e3);
  if (m < 60) return `in ${m} min`;
  if (m < 24 * 60) return `in ${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${dayLabel(g.start)} ${timeLabel(g.start)}`;
}
function edgeFairTxt(e) {
  const src = bookName(e.src);
  if (!e.est) return `Fair ${fmtOdds(e.fairAm)} (${src})`;
  return `Fair ${fmtOdds(e.fairAm)} ${edgeModeled() ? 'est.' : 'approx.'} from ${src} ${edgeLineTxt(e, e.srcLine)}`;
}
const edgeTier = (ev) => (ev >= 0.04 ? 3 : ev >= 0.02 ? 2 : 1);
function edgeLabel(e) {
  return `${bookFull(e.book)}: ${edgePick(e)} at ${fmtOdds(e.odds)}. ${(e.ev * 100).toFixed(1)} percent edge. ${edgeFairTxt(e).replace(MINUS, 'minus ')}. ${e.g.away.short} at ${e.g.home.short}, ${edgeKick(e.g)}. Log this bet.`;
}

function edgeRow(e, full) {
  const g = e.g;
  const t = e.mkt === 't' ? g.home : g[e.side];
  const stake = `${trim(Math.max(0.1, e.units))}u${S.unit ? ` · ${fmtMoney(Math.round(Math.max(0.1, e.units) * S.unit))}` : ''}`;
  return `<button type="button" class="edge-row" data-edge-pick="${esc(`${e.gid}|${e.mkt}|${e.side}|${e.book}`)}" aria-label="${esc(edgeLabel(e))}">
    ${logo(t, 'logo edge-logo')}
    <span class="edge-mid"><span class="edge-t"><b>${esc(edgePick(e))}</b> <span class="num">${esc(fmtOdds(e.odds))}</span> <span class="edge-bk">${esc(bookName(e.book))}</span></span>
      <span class="edge-s">${esc(edgeFairTxt(e))}</span><span class="edge-s">${esc(g.away.abbr)} @ ${esc(g.home.abbr)} · ${esc(edgeKick(g))}</span></span>
    <span class="edge-v"><span class="edge-p num t${edgeTier(e.ev)}">${esc(edgePctTxt(e.ev))}</span><span class="edge-k">${full ? `<span class="num">${esc(stake)}</span> sugg.` : 'edge'}</span></span>
  </button>`;
}

// ------------------------------------------------------------ Live tab: top edges
const EDGE_EXPLAIN = 'Edge = how much better this price is than the sharp fair price, with the vig removed.';
function edgeLive() {
  const view = $('#view-live');
  if (!view) return;
  let sec = $('#edgeTop');
  if (!sec) {
    sec = document.createElement('section');
    sec.id = 'edgeTop';
    sec.className = 'edge-top';
    sec.setAttribute('aria-label', 'Top edges');
    const hero = $('#hero');
    if (hero?.parentNode) hero.parentNode.insertBefore(sec, hero.nextSibling); else view.appendChild(sec);
  }
  edgeDeepLink();
  const all = edgeAll();
  // one row per game, market and side: the best book for it
  const seen = new Set();
  const top = all.filter((e) => { const k = `${e.gid}|${e.mkt}|${e.side}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
  sec.hidden = !top.length;
  if (!top.length) { if (sec.innerHTML) sec.innerHTML = ''; return; }
  const html = `<div class="edge-h"><h2>Top edges</h2><button type="button" class="edge-all" data-edge-all aria-label="See all ${all.length} edges">See all ${all.length}${ICON.chev}</button></div>
    <p class="edge-why">${esc(EDGE_EXPLAIN)}</p>
    <div class="card edge-list">${top.map((e) => edgeRow(e, false)).join('')}</div>`;
  if (sec.dataset.html !== html) { sec.innerHTML = html; sec.dataset.html = html; }
}

// ------------------------------------------------------------ the full list (sheet)
const EDGE_CHIPS = [['all', 'All'], ['s', 'Spread'], ['t', 'Total'], ['ml', 'Money']];
let edgeMkt = 'all', edgeLastPaint = 0, edgeTimer = 0, edgeLastHTML = '';
const edgeInChip = (e, f) => f === 'all' || (f === 's' ? e.mkt === 's' || e.mkt === 'h1s' : e.mkt === f);
function edgeSheetHTML() {
  const all = edgeAll();
  const list = all.filter((e) => edgeInChip(e, edgeMkt));
  const chips = EDGE_CHIPS.map(([k, l]) => `<button type="button" class="chip" data-edge-mkt="${k}" aria-pressed="${edgeMkt === k}">${esc(l)}<small class="num">${all.filter((e) => edgeInChip(e, k)).length}</small></button>`).join('');
  return `<h2 id="dlgTitle">Edges</h2>
    <p class="lede">${esc(EDGE_EXPLAIN)} Pre-game prices checked in the last 15 minutes, best first.</p>
    <div class="chips edge-chips" role="group" aria-label="Market">${chips}</div>
    ${list.length ? `<div class="card edge-list">${list.map((e) => edgeRow(e, true)).join('')}</div>`
      : `<p class="edge-none">${all.length ? 'No edges of 1% or more in this market right now.' : 'No edges of 1% or more right now. They show up here the moment a book lags the sharp price.'}</p>`}
    <p class="note">Fair price: Pinnacle with the vig removed, else Circa, else the market consensus. When a book's number differs from the sharp number, the fair chance is ${edgeModeled() ? 'est. from how often each margin happened last season, so the hook across 3, 7, 10 or 14 counts extra' : 'approx. from a normal curve of final margins'}. <b>Sugg.</b> stake is quarter-Kelly with 1 unit (${esc(fmtMoney(S.unit))}) = 1% of bankroll, capped at 2 units. A suggestion, not advice.</p>`;
}
function edgePaintSheet() {
  if (S.sheet?.kind !== 'edges') return;
  edgeLastPaint = Date.now();
  const html = edgeSheetHTML();
  if (html === edgeLastHTML && $('#dlgBody .edge-chips')) return;
  edgeLastHTML = html;
  const box = $('#dlgIn'), top = box ? box.scrollTop : 0;
  const focused = document.activeElement?.closest?.('#dlgBody [data-edge-mkt], #dlgBody [data-edge-pick]');
  const fKey = focused ? (focused.dataset.edgeMkt ? `[data-edge-mkt="${focused.dataset.edgeMkt}"]` : `[data-edge-pick="${CSS.escape(focused.dataset.edgePick)}"]`) : null;
  $('#dlgBody').innerHTML = html;
  if (box) box.scrollTop = top;
  if (fKey) $(`#dlgBody ${fKey}`)?.focus({ preventScroll: true });
}
function edgeOpen() {
  S.sheet = { kind: 'edges' };
  edgeLastHTML = edgeSheetHTML();
  $('#dlgBody').innerHTML = edgeLastHTML;
  showSheet('edges', true);
  const box = $('#dlgIn');
  if (box) box.scrollTop = 0;
  edgeLastPaint = Date.now();
}
// Called by refreshSheet() on every live update while this sheet is open; repaints at most every 1.5 s.
function edgeRefresh() {
  if (S.sheet?.kind !== 'edges') return;
  const wait = 1500 - (Date.now() - edgeLastPaint);
  if (wait > 0) {
    if (!edgeTimer) edgeTimer = setTimeout(() => { edgeTimer = 0; edgeRefresh(); }, wait);
    return;
  }
  edgePaintSheet();
}

// Deep link: #edges opens the list once the week has loaded.
let edgeWantLink = location.hash === '#edges';
window.addEventListener('hashchange', () => { if (location.hash === '#edges') { edgeWantLink = true; edgeDeepLink(); } });
function edgeDeepLink() {
  if (!edgeWantLink || !S.books.length || !allGames().length) return;
  edgeWantLink = false;
  setTimeout(edgeOpen, 0);
}
document.addEventListener('close', (ev) => {
  if (ev.target?.id === 'dlg' && location.hash === '#edges') history.replaceState(null, '', `#${S.tab}`);
}, true);

// ------------------------------------------------------------ board: price badges and the Edges filter
function edgeBadge(g, mkt, side, book) {
  if (!g || !isPre(g) || book === 'cons' || book === 'open') return '';
  const e = edgesFor(g).find((x) => x.mkt === mkt && x.side === side && x.book === book);
  if (!e) return '';
  return `<span class="edge-b t${edgeTier(e.ev)}" aria-hidden="true"><i>${esc(edgePctTxt(e.ev))} edge${e.est ? ' est.' : ''}</i></span>`;
}
function edgeGame(g) { return isPre(g) && edgesFor(g).length > 0; }

// ------------------------------------------------------------ alerts
const edgeAlerted = new Map(); // key -> time alerted
document.addEventListener('hl:game', (ev) => {
  const { prev, g } = ev.detail || {};
  if (S.alerts !== 'all' || !prev || !g || !isPre(g)) return;
  const before = new Set(edgeScoreGame(prev).filter((e) => e.ev >= EDGE_ALERT).map((e) => `${e.gid}|${e.mkt}|${e.side}|${e.book}`));
  const now = Date.now();
  for (const [k, t] of edgeAlerted) if (now - t > 30 * 60e3) edgeAlerted.delete(k);
  const fresh = edgesFor(g).filter((e) => {
    const k = `${e.gid}|${e.mkt}|${e.side}|${e.book}`;
    return e.ev >= EDGE_ALERT && !before.has(k) && !edgeAlerted.has(k);
  });
  if (!fresh.length) return;
  for (const e of fresh) edgeAlerted.set(`${e.gid}|${e.mkt}|${e.side}|${e.book}`, now);
  const e = fresh[0];
  const title = `${bookName(e.book)} ${edgePick(e)} ${fmtOdds(e.odds)}`;
  const line = `${edgeFairTxt(e)} · ${g.away.abbr} @ ${g.home.abbr} · ${edgeKick(g)}`;
  toast({ logoUrl: (e.mkt === 't' ? g.home : g[e.side]).logo, kicker: `New edge · ${edgePctTxt(e.ev)}`, title, line, open: g.id });
  notify(`New edge ${edgePctTxt(e.ev)}: ${title}`, line, `edge-${e.gid}-${e.mkt}-${e.side}-${e.book}`);
});

// ------------------------------------------------------------ clicks (data-edge-* only)
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-edge-pick], [data-edge-all], [data-edge-mkt]');
  if (!t) return;
  const d = t.dataset;
  if (d.edgePick) {
    ev.preventDefault();
    const [gid, mkt, side, book] = d.edgePick.split('|');
    if (location.hash === '#edges') history.replaceState(null, '', `#${S.tab}`);
    openSlip({ gid, mkt, side, book });
    return;
  }
  if (d.edgeAll !== undefined) { ev.preventDefault(); edgeOpen(); return; }
  if (d.edgeMkt) { edgeMkt = d.edgeMkt; edgePaintSheet(); }
});
