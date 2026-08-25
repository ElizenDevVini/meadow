const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- formatting ---------- */

function trimNum(x) {
  const r = Math.round(x * 10) / 10;
  return r % 1 === 0 ? String(r) : r.toFixed(1);
}

function fmtUsd(n) {
  if (n == null) return 'n/a';
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v >= 1e6) return sign + '$' + trimNum(v / 1e6) + 'M';
  if (v >= 1e3) return sign + '$' + trimNum(v / 1e3) + 'K';
  return sign + '$' + Math.round(v);
}

function fmtDate(s) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = String(s).split('-');
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return months[+parts[1] - 1] + ' ' + parts[0];
  return months[+parts[1] - 1] + ' ' + (+parts[2]) + ', ' + parts[0];
}

function fmtGain(g) {
  if (g == null) return 'n/a';
  const pct = Math.round(g * 1000) / 10;
  return (pct > 0 ? '+' : '') + pct + '%';
}

/* ---------- pixel charts (fillRect only, two colors) ---------- */

function setupCanvas(canvas, w, h, cell) {
  const s = Math.max(1, Math.floor(devicePixelRatio || 1));
  canvas.width = w * s;
  canvas.height = h * s;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(s * cell, s * cell);
  return { ctx, cols: Math.floor(w / cell), rows: Math.floor(h / cell) };
}

function buildPointMap(series, cols, rows, log) {
  const pts = series.filter(p => p.v != null).sort((a, b) => a.x - b.x);
  const xPad = 4, yPad = 3;
  const plotCols = Math.max(1, cols - xPad * 2 - 1);
  const plotRows = Math.max(1, rows - yPad * 2 - 1);
  if (!pts.length) return { px: [], xFor: () => xPad, yFor: () => yPad, xPad, yPad, plotCols, plotRows };

  const xmin = pts[0].x, xmax = pts[pts.length - 1].x;
  const xFor = x => xmax === xmin ? xPad : xPad + Math.round((x - xmin) / (xmax - xmin) * plotCols);

  const vmin = Math.min(...pts.map(p => p.v)), vmax = Math.max(...pts.map(p => p.v));
  const yFor = v => {
    if (vmax === vmin) return yPad + Math.floor(plotRows / 2);
    const t = log
      ? (Math.log(v) - Math.log(vmin)) / (Math.log(vmax) - Math.log(vmin))
      : (v - vmin) / (vmax - vmin);
    return yPad + plotRows - Math.round(t * plotRows);
  };

  const px = pts.map(p => ({ ...p, col: xFor(p.x), row: yFor(p.v) }));
  return { px, xFor, yFor, xPad, yPad, plotCols, plotRows };
}

function paintFrame(ctx, cols, rows, paper, ink, geom, cutoffCol, withMarkers, fill, markers) {
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, cols, rows);
  ctx.fillStyle = ink;
  const bottom = geom.yPad + geom.plotRows;
  for (let i = 1; i < geom.px.length; i++) {
    const a = geom.px[i - 1], b = geom.px[i];
    if (a.col > cutoffCol) break;
    const bCol = Math.min(b.col, cutoffCol);
    for (let c = a.col; c < bCol; c++) {
      if (fill) for (let r = a.row; r <= bottom; r++) if ((c + r) & 1) ctx.fillRect(c, r, 1, 1);
      ctx.fillRect(c, a.row, 1, 1);
    }
    if (bCol >= b.col) {
      const top = Math.min(a.row, b.row), bot = Math.max(a.row, b.row);
      for (let r = top; r <= bot; r++) ctx.fillRect(bCol, r, 1, 1);
    }
  }
  if (!markers || !withMarkers) return;
  for (const p of geom.px) {
    if (p.col > cutoffCol) continue;
    if (p.kind === 'sale') ctx.fillRect(p.col - 1, p.row - 1, 3, 3);
  }
  const lastIdx = [...geom.px].reverse().find(p => p.kind === 'index' && p.col <= cutoffCol);
  if (lastIdx) {
    ctx.fillRect(lastIdx.col - 1, lastIdx.row - 1, 3, 1);
    ctx.fillRect(lastIdx.col - 1, lastIdx.row + 1, 3, 1);
    ctx.fillRect(lastIdx.col - 1, lastIdx.row, 1, 1);
    ctx.fillRect(lastIdx.col + 1, lastIdx.row, 1, 1);
  }
}

function drawPixelChart(canvas, opts) {
  const { series, w, h, cell = 2, fill = true, markers = true, log = true } = opts;
  const cs = getComputedStyle(document.documentElement);
  const paper = cs.getPropertyValue('--paper').trim();
  const ink = cs.getPropertyValue('--ink').trim();
  const { ctx, cols, rows } = setupCanvas(canvas, w, h, cell);
  const geom = buildPointMap(series, cols, rows, log);

  const paint = (cutoffCol, withMarkers) => paintFrame(ctx, cols, rows, paper, ink, geom, cutoffCol, withMarkers, fill, markers);

  if (REDUCE || geom.px.length < 2) {
    paint(cols, true);
  } else {
    let frame = 0;
    const total = 12;
    const step = () => {
      frame++;
      paint(geom.xPad + Math.round(frame / total * geom.plotCols), frame === total);
      if (frame < total) setTimeout(step, 60);
    };
    step();
  }

  return {
    points: geom.px.map(p => ({ x: p.x, v: p.v, kind: p.kind, px: p.col * cell, py: p.row * cell })),
    xFor: x => geom.xFor(x) * cell,
    yFor: v => geom.yFor(v) * cell,
  };
}

function drawSpark(canvas, values) {
  const series = values.map((v, i) => ({ x: i, v, kind: 'index' })).filter(p => p.v != null);
  drawPixelChart(canvas, { series, w: 96, h: 24, cell: 1, fill: false, markers: false });
}

function drawIndexChart(canvas, bins, values, w, h) {
  const series = bins.map((x, i) => ({ x, v: values[i], kind: 'index' })).filter(p => p.v != null);
  return drawPixelChart(canvas, { series, w, h, cell: 2, fill: true, markers: false, log: true });
}

/* ---------- axis ticks ----------
   Nice round numbers for a log y-axis and evenly spaced years for x. */

function niceRound(v) {
  const exp = Math.floor(Math.log10(v));
  const base = v / Math.pow(10, exp);
  const nice = base < 1.5 ? 1 : base < 3.5 ? 2 : base < 7.5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

function niceTicks(vmin, vmax, count) {
  if (!(vmin > 0) || !(vmax > vmin)) return [vmin, vmax].filter(v => v > 0);
  const ticks = [];
  for (let i = 0; i < count; i++) ticks.push(niceRound(vmin * Math.pow(vmax / vmin, i / (count - 1))));
  return [...new Set(ticks)];
}

function yearTicks(xmin, xmax, count) {
  const span = xmax - xmin;
  if (span <= 0) return [Math.round(xmin)];
  const ticks = [];
  for (let i = 0; i < count; i++) ticks.push(Math.round(xmin + span * i / (count - 1)));
  return [...new Set(ticks)];
}

/* ---------- shared chrome: nav toggle + reveal ---------- */

function initNav() {
  const nav = document.getElementById('nav');
  const menu = document.getElementById('menu');
  if (!nav || !menu) return;
  menu.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  document.getElementById('links').addEventListener('click', e => {
    if (e.target.tagName === 'A') nav.classList.remove('open');
  });
}

function initReveal() {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
  document.querySelectorAll('[data-reveal]').forEach(el => {
    // Above-the-fold content shows at once; the observer only handles what scrolls in later.
    if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in');
    else io.observe(el);
  });
}

/* ---------- attribution footer, shared by both pages ---------- */

function renderAttribution(root, attr) {
  root.innerHTML = `
    <p class="attribution">Records: <a href="${attr.records_url}" target="_blank" rel="noopener">${attr.records}</a>. Images: ${attr.images}. Prices: ${attr.prices}.</p>
    <p class="footnote">indexed est. = last sale × index ratio, not an appraisal</p>
  `;
}

/* ---------- entry ---------- */

async function fetchCatalog() {
  const res = await fetch('data/catalog.json');
  if (!res.ok) throw new Error('catalog fetch failed: ' + res.status);
  return res.json();
}

initNav();
initReveal();

const page = document.body.dataset.page;
fetchCatalog()
  .then(data => {
    if (page === 'catalog') renderCatalogPage(data);
    if (page === 'work') renderWorkPage(data);
  })
  .catch(err => {
    console.error('could not load the catalog', err);
  });

/* ---------- catalog page ---------- */

function plateHtml(artist) {
  return `<div class="plate" role="img" aria-label="${artist}, no image available"><span>${artist}</span></div>`;
}

function cardHtml(work, i) {
  const thumb = work.img
    ? `<img src="${work.img.thumb}" alt="${work.title}, by ${work.artist}">`
    : plateHtml(work.artist);
  const est = work.est_now != null
    ? `<p class="est">indexed est. ${fmtUsd(work.est_now)}<sup>†</sup></p>`
    : '';
  return `
    <a class="card" data-reveal style="--d:${(i % 6) * 0.05}s" href="work.html?id=${work.id}">
      <div class="thumb">${thumb}</div>
      <h3 class="title">${work.title}</h3>
      <p class="meta">${work.artist}, ${work.year_text}</p>
      <canvas class="spark" width="96" height="24" data-spark="${work.id}"></canvas>
      <p class="last">last sale ${fmtUsd(work.last.price_usd)}, ${work.last.year}, ${work.last.channel}</p>
      ${est}
    </a>
  `;
}

function renderGrid(grid, works) {
  grid.innerHTML = works.map(cardHtml).join('');
  for (const canvas of grid.querySelectorAll('canvas[data-spark]')) {
    const work = works.find(w => w.id === canvas.dataset.spark);
    if (work) drawSpark(canvas, work.spark);
  }
  initReveal();
}

function buildArtistOptions(select, works) {
  const artists = [...new Set(works.map(w => w.artist))].sort();
  select.innerHTML = '<option value="">all artists</option>' + artists.map(a => `<option value="${a}">${a}</option>`).join('');
}

function sortWorks(works, key) {
  const by = {
    last: w => w.last?.price_usd,
    est: w => w.est_now,
    gain: w => w.gain,
  }[key] || (w => w.last?.price_usd);
  return works.slice().sort((a, b) => (by(b) ?? -Infinity) - (by(a) ?? -Infinity));
}

function renderExcluded(list, pairs) {
  if (!pairs.length) { list.closest('details').style.display = 'none'; return; }
  list.innerHTML = pairs.map(p => `<li>${p.title}: ${p.from} &rarr; ${p.to}, ${p.reason}</li>`).join('');
}

function renderMarketPanel(index) {
  const canvas = document.getElementById('indexChart');
  const w = canvas.parentElement.clientWidth;
  drawIndexChart(canvas, index.bins, index.values, w, 160);
  document.getElementById('indexCaption').textContent =
    `${index.pairs_used} repeat-sale pairs, ${index.bin_years}-year bins, nominal USD, base 100 = ${index.base_year}, experimental`;
  document.getElementById('indexMethod').textContent = index.estimates_note ? `${index.method}. ${index.estimates_note}` : index.method;
  renderExcluded(document.getElementById('excludedList'), index.pairs_excluded);
}

function renderCatalogPage(data) {
  renderMarketPanel(data.index);

  const grid = document.getElementById('grid');
  const artistSelect = document.getElementById('artistFilter');
  const sortSelect = document.getElementById('sortBy');
  buildArtistOptions(artistSelect, data.works);

  const apply = () => {
    let works = data.works;
    if (artistSelect.value) works = works.filter(w => w.artist === artistSelect.value);
    renderGrid(grid, sortWorks(works, sortSelect.value));
  };
  artistSelect.addEventListener('change', apply);
  sortSelect.addEventListener('change', apply);
  apply();

  renderAttribution(document.getElementById('artFooter'), data.attribution);
}

/* ---------- work detail page ---------- */

function findWork(data, id) {
  return data.works.find(w => w.id === id);
}

function renderNotFound(root) {
  root.innerHTML = `
    <div class="panel notfound" data-reveal>
      <div class="titlebar" aria-hidden="true"><span></span><span>error</span></div>
      <div class="panel-body">
        <p>no such work</p>
        <a class="btn btn-outline" href="./">back to catalog</a>
      </div>
    </div>
  `;
  document.title = 'Not found · Meadow Art';
  initReveal();
}

function workMediaHtml(work) {
  return work.img
    ? `<img src="${work.img.full}" alt="${work.title}, by ${work.artist}">`
    : plateHtml(work.artist);
}

function lifetimeText(work) {
  if (!work.artist_died) return '';
  return `, d. ${work.artist_died}`;
}

function estNowHtml(work) {
  return work.est_now != null ? fmtUsd(work.est_now) : 'no indexed estimate';
}

function estReasonHtml(work, index) {
  if (work.est_now != null) return '';
  if (index.estimates_enabled === false) return `<p class="meta">${index.estimates_note}</p>`;
  return `<p class="meta">last sale is in the latest bin, or not a market comparable</p>`;
}

function renderSalesTable(work) {
  const rows = work.sales.map(s => {
    const price = fmtUsd(s.price_usd) + (s.approx ? ' (approx.)' : '');
    const note = s.note ? `<br><span class="note">${s.note}</span>` : '';
    const indexNote = !s.index && s.index_note ? `<br><span class="note">${s.index_note}</span>` : '';
    return `
      <tr>
        <td>${fmtDate(s.date)}</td>
        <td>${price}${note}</td>
        <td>${s.channel}${indexNote}</td>
        <td><a href="${s.source}" target="_blank" rel="noopener">source</a></td>
      </tr>
    `;
  }).join('');
  return `
    <table class="sales">
      <thead><tr><th>date</th><th>price</th><th>channel</th><th>source</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function placeTicks(wrap, canvas, geom, series, log) {
  const vals = series.filter(p => p.v != null).map(p => p.v);
  const xs = series.map(p => p.x);
  const yTicks = log ? niceTicks(Math.min(...vals), Math.max(...vals), 4) : [];
  const xTicks = yearTicks(Math.min(...xs), Math.max(...xs), 4);
  const html = [
    ...yTicks.map(v => `<span class="tick tick-y" style="top:${canvas.offsetTop + geom.yFor(v)}px">${fmtUsd(v)}</span>`),
    ...xTicks.map(x => `<span class="tick tick-x" style="left:${canvas.offsetLeft + geom.xFor(x)}px">${Math.round(x)}</span>`),
  ].join('');
  wrap.querySelectorAll('.tick').forEach(t => t.remove());
  wrap.insertAdjacentHTML('beforeend', html);
}

function renderWorkChart(work) {
  const wrap = document.getElementById('chartWrap');
  const canvas = document.getElementById('workChart');
  const w = wrap.clientWidth - 52;
  const geom = drawPixelChart(canvas, { series: work.series, w, h: 240, cell: 2, fill: true, markers: true, log: true });
  placeTicks(wrap, canvas, geom, work.series, true);
}

function renderWorkPage(data) {
  const id = new URLSearchParams(location.search).get('id');
  const work = id ? findWork(data, id) : null;
  const root = document.getElementById('workRoot');
  if (!work) { renderNotFound(root); return; }

  document.title = `${work.title} · Meadow Art`;
  document.getElementById('workArtist').textContent = work.artist;
  document.getElementById('workTitle').textContent = work.title;
  document.getElementById('workMeta').textContent = `${work.year_text}, ${work.medium}${lifetimeText(work)}`;
  document.getElementById('workMedia').innerHTML = workMediaHtml(work);
  document.getElementById('lastSale').textContent = `${fmtUsd(work.last.price_usd)} · ${work.last.year} · ${work.last.channel}`;
  document.getElementById('estNow').textContent = estNowHtml(work);
  document.getElementById('estNow').classList.toggle('muted', work.est_now == null);
  document.getElementById('estReason').innerHTML = estReasonHtml(work, data.index);
  document.getElementById('salesTable').innerHTML = renderSalesTable(work);
  document.getElementById('wikiLink').href = work.wikipedia_url;

  renderWorkChart(work);
  renderAttribution(document.getElementById('artFooter'), data.attribution);
  initReveal();
}
