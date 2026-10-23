// Route preview: outlined course map, key numbers and an elevation profile.
// The courses below are SAMPLE shapes generated for the preview. Replace ROUTES with the
// organisers' real GPX track (lat/lng/elevation) once the course is confirmed.

const W = 600;
const H = 420;

const ROUTES = {
  '21k': {
    label: '21 km trail run', km: 21.1, colour: '#141f45', terrain: 'Jeep track and single track',
    base: 1080, waterPoints: [3.5, 7, 10.5, 14, 17.5],
    shape: { cx: 300, cy: 215, rx: 230, ry: 165, waves: [[3, 0.16, 0.4], [5, 0.07, 1.3], [8, 0.03, 2.1]] },
    hills: [[0.18, 70, 0.07], [0.45, 115, 0.09], [0.7, 55, 0.06], [0.86, 35, 0.04]],
  },
  '5k': {
    label: '5 km run/walk', km: 5, colour: '#c4553d', terrain: 'Gravel road, gently rolling',
    base: 1080, waterPoints: [2.5],
    shape: { cx: 205, cy: 280, rx: 105, ry: 75, waves: [[2, 0.12, 0.9], [4, 0.05, 0.2]] },
    hills: [[0.35, 22, 0.12], [0.62, 14, 0.08]],
  },
};
// Both loops start and finish at the same gate.
const START_ANGLE = Math.PI * 0.82;

function build(key) {
  const R = ROUTES[key];
  const s = R.shape;
  const n = 360;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = START_ANGLE + (i / n) * Math.PI * 2;
    const r = 1 + s.waves.reduce((a, [k, amp, ph]) => a + amp * Math.sin(k * t + ph), 0);
    pts.push([s.cx + s.rx * r * Math.cos(t), s.cy + s.ry * r * Math.sin(t)]);
  }
  // Shift so every loop begins at the shared start/finish gate.
  const [gx, gy] = [118, 300];
  const [dx, dy] = [gx - pts[0][0], gy - pts[0][1]];
  const shifted = pts.map(([x, y]) => [x + dx, y + dy]);
  const cum = [0];
  for (let i = 1; i < shifted.length; i++) cum.push(cum[i - 1] + Math.hypot(shifted[i][0] - shifted[i - 1][0], shifted[i][1] - shifted[i - 1][1]));
  const total = cum[cum.length - 1];
  const kmAt = cum.map((c) => (c / total) * R.km);
  const elev = kmAt.map((k) => {
    const f = k / R.km;
    const h = R.hills.reduce((a, [c, height, w]) => a + height * Math.exp(-((f - c) ** 2) / (2 * w * w)), 0);
    return R.base + h + 6 * (R.km / 21) * Math.sin(f * 37);
  });
  let gain = 0;
  for (let i = 1; i < elev.length; i++) gain += Math.max(0, elev[i] - elev[i - 1]);
  return { ...R, key, pts: shifted, kmAt, elev, gain: Math.round(gain / 5) * 5, high: Math.round(Math.max(...elev)), low: Math.round(Math.min(...elev)), unitsPerKm: total / R.km };
}

// Scale and centre all routes together so they share one map frame and one km scale.
function fit(routes) {
  const all = Object.values(routes).flatMap((r) => r.pts);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = { l: 40, r: 60, t: 40, b: 60 };
  const k = Math.min((W - pad.l - pad.r) / (x1 - x0), (H - pad.t - pad.b) / (y1 - y0));
  const ox = pad.l + (W - pad.l - pad.r - (x1 - x0) * k) / 2;
  const oy = pad.t + (H - pad.t - pad.b - (y1 - y0) * k) / 2;
  for (const r of Object.values(routes)) {
    r.pts = r.pts.map(([x, y]) => [ox + (x - x0) * k, oy + (y - y0) * k]);
    r.unitsPerKm *= k;
  }
  return routes;
}

function at(route, km) {
  const i = Math.max(1, route.kmAt.findIndex((k) => k >= km));
  const [k0, k1] = [route.kmAt[i - 1], route.kmAt[i]];
  const f = k1 > k0 ? (km - k0) / (k1 - k0) : 0;
  const lerp = (a, b) => a + (b - a) * f;
  return { x: lerp(route.pts[i - 1][0], route.pts[i][0]), y: lerp(route.pts[i - 1][1], route.pts[i][1]), elev: Math.round(lerp(route.elev[i - 1], route.elev[i])) };
}

const pathOf = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L');

function mapSVG(route, other) {
  const contours = [0.25, 0.45, 0.65, 0.85, 1.05].map((k, i) => {
    const pts = [];
    for (let j = 0; j <= 120; j++) {
      const t = (j / 120) * Math.PI * 2;
      const r = k * (1 + 0.12 * Math.sin(3 * t + i) + 0.05 * Math.sin(5 * t + 2 * i));
      pts.push([360 + 230 * r * Math.cos(t), 170 + 150 * r * Math.sin(t)]);
    }
    return `<path d="${pathOf(pts)}Z" />`;
  }).join('');
  const kmMarks = [];
  const step = route.km > 10 ? 5 : 1;
  for (let k = step; k < route.km - 0.5; k += step) {
    const p = at(route, k);
    kmMarks.push(`<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><circle r="11" fill="#fff" stroke="${route.colour}" stroke-width="1.5"/><text text-anchor="middle" dy="3.5" class="rt-km">${k}</text></g>`);
  }
  const wps = route.waterPoints.map((k, i) => {
    const p = at(route, k);
    return `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><title>Water point ${i + 1} · ${k} km</title><path d="M0 -9 C 4 -3 6 0 6 3 A 6 6 0 0 1 -6 3 C -6 0 -4 -3 0 -9Z" fill="#3d7fb8" stroke="#fff" stroke-width="1.5"/></g>`;
  }).join('');
  const start = route.pts[0];
  const scale = route.unitsPerKm;
  return `<svg viewBox="0 0 ${W} ${H}" class="rt-map" role="img" aria-label="Sample outline of the ${route.label} course: a loop starting and finishing at the reserve gate, with ${route.waterPoints.length} water point${route.waterPoints.length > 1 ? 's' : ''}.">
    <rect width="${W}" height="${H}" rx="14" fill="#f3efe7"/>
    <g fill="none" stroke="#e3dccf" stroke-width="1">${contours}</g>
    <path d="M -10 380 C 120 350, 200 400, 330 370 S 520 330, 620 360" fill="none" stroke="#cfdbe6" stroke-width="5" stroke-linecap="round"/>
    ${other ? `<path d="${pathOf(other.pts)}" fill="none" stroke="#b9b2a6" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round"/>` : ''}
    <path d="${pathOf(route.pts)}" fill="none" stroke="#fff" stroke-width="8" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${pathOf(route.pts)}" fill="none" stroke="${route.colour}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${kmMarks.join('')}${wps}
    <g transform="translate(${start[0].toFixed(1)} ${start[1].toFixed(1)})"><circle r="9" fill="${route.colour}" stroke="#fff" stroke-width="3"/><text x="14" y="-12" class="rt-tag">Start / finish</text></g>
    <circle class="rt-dot" r="7" fill="#fff" stroke="${route.colour}" stroke-width="3" cx="${start[0]}" cy="${start[1]}" opacity="0"/>
    <g transform="translate(${W - 34} 34)" class="rt-north"><path d="M0 -14 L6 6 L0 2 L-6 6Z" fill="#646b7e"/><text text-anchor="middle" y="20">N</text></g>
    <g transform="translate(24 ${H - 26})"><path d="M0 0 H${scale.toFixed(1)}" stroke="#646b7e" stroke-width="2"/><path d="M0 -4 V4 M${scale.toFixed(1)} -4 V4" stroke="#646b7e" stroke-width="2"/><text x="${(scale / 2).toFixed(1)}" y="-8" text-anchor="middle" class="rt-scale">1 km</text></g>
  </svg>`;
}

const PL = 52;
const PR = 16;

function profileSVG(route, w) {
  const h = 200, pl = PL, pr = PR, pt = 16, pb = 34;
  const lo = Math.floor((route.low - 20) / 50) * 50;
  const hi = Math.ceil((route.high + 20) / 50) * 50;
  const x = (k) => pl + (k / route.km) * (w - pl - pr);
  const y = (e) => pt + (1 - (e - lo) / (hi - lo)) * (h - pt - pb);
  const line = route.kmAt.map((k, i) => `${i ? 'L' : 'M'}${x(k).toFixed(1)} ${y(route.elev[i]).toFixed(1)}`).join('');
  const area = `${line}L${x(route.km)} ${y(lo)}L${x(0)} ${y(lo)}Z`;
  const yTicks = [];
  for (let e = lo; e <= hi; e += 50) yTicks.push(`<line x1="${pl}" x2="${w - pr}" y1="${y(e)}" y2="${y(e)}" class="rt-grid"/><text x="${pl - 10}" y="${y(e) + 4}" text-anchor="end" class="rt-axis">${e} m</text>`);
  const step = route.km > 10 ? 5 : 1;
  const xTicks = [];
  for (let k = 0; k <= route.km; k += step) xTicks.push(`<text x="${x(k)}" y="${h - 10}" text-anchor="middle" class="rt-axis">${k} km</text>`);
  const wps = route.waterPoints.map((k) => `<line x1="${x(k)}" x2="${x(k)}" y1="${y(at(route, k).elev) + 4}" y2="${y(lo)}" stroke="#3d7fb8" stroke-width="1.5" stroke-dasharray="3 3"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="rt-profile" role="img" aria-label="Elevation profile: ${route.low} m to ${route.high} m, about ${route.gain} m of climbing over ${route.km} km.">
    <defs><linearGradient id="rt-fill-${route.key}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${route.colour}" stop-opacity=".22"/><stop offset="1" stop-color="${route.colour}" stop-opacity=".02"/></linearGradient></defs>
    ${yTicks.join('')}${xTicks.join('')}
    <path d="${area}" fill="url(#rt-fill-${route.key})"/>
    ${wps}
    <path d="${line}" fill="none" stroke="${route.colour}" stroke-width="2" stroke-linejoin="round"/>
    <line class="rt-cross" y1="${pt}" y2="${y(lo)}" x1="0" x2="0" stroke="#646b7e" stroke-width="1" opacity="0"/>
    <rect x="${pl}" y="0" width="${w - pl - pr}" height="${h}" fill="transparent" class="rt-hit"/>
  </svg>`;
}

export function routeExplorer(el, { initial = '21k' } = {}) {
  const routes = fit({ '21k': build('21k'), '5k': build('5k') });
  const draw = (key) => {
    const r = routes[key];
    const other = routes[key === '21k' ? '5k' : '21k'];
    el.innerHTML = `
      <div class="rt-tabs" role="tablist" aria-label="Distance">
        ${Object.values(routes).map((x) => `<button role="tab" aria-selected="${x.key === key}" data-k="${x.key}"><strong>${x.km} km</strong> <span>${x.key === '21k' ? 'Trail run' : 'Run / walk'}</span></button>`).join('')}
      </div>
      <div class="rt-body">
        <figure class="rt-figure">${mapSVG(r, key === '21k' ? other : null)}</figure>
        <div class="rt-side">
          <dl class="rt-stats">
            <div><dt>Distance</dt><dd>${r.km} km</dd></div>
            <div><dt>Elevation gain</dt><dd>${r.gain} m</dd></div>
            <div><dt>Highest point</dt><dd>${r.high.toLocaleString('en-ZA')} m</dd></div>
            <div><dt>Water points</dt><dd>${r.waterPoints.length}</dd></div>
          </dl>
          <p class="rt-terrain"><span class="label muted">Terrain</span><br>${r.terrain}. Start and finish at the reserve gate.</p>
          <p class="rt-legend small muted"><span><i class="sw" style="background:${r.colour}"></i>${r.label}</span>${key === '21k' ? '<span><i class="sw dash"></i>5 km loop</span>' : ''}<span><i class="sw drop"></i>Water point</span></p>
        </div>
      </div>
      <div class="rt-chart">
        <div class="rt-chart-head"><span class="label muted">Elevation profile</span><span class="small muted">Hover or tap to explore</span></div>
        <div class="rt-chart-box"><div class="rt-tip" hidden></div></div>
      </div>
      <p class="small muted rt-note"><span class="sample">Sample route</span> Course shape and elevation are illustrative. The official route map will be published once the organisers confirm the course.</p>`;
    el.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => draw(b.dataset.k)));
    drawChart(el, r);
  };
  draw(initial);
  let lastW = 0;
  const onResize = () => {
    if (!el.isConnected) { window.removeEventListener('resize', onResize); return; }
    const box = el.querySelector('.rt-chart-box');
    if (box && Math.abs(box.clientWidth - lastW) > 4) { lastW = box.clientWidth; drawChart(el, routes[el.querySelector('[aria-selected=true]').dataset.k]); }
  };
  window.addEventListener('resize', onResize);
}

function drawChart(el, r) {
  const box = el.querySelector('.rt-chart-box');
  const w = Math.max(280, box.clientWidth);
  box.querySelector('svg')?.remove();
  box.insertAdjacentHTML('afterbegin', profileSVG(r, w));
  const hit = box.querySelector('.rt-hit');
  const cross = box.querySelector('.rt-cross');
  const dot = el.querySelector('.rt-dot');
  const tip = box.querySelector('.rt-tip');
  const plot = w - PL - PR;
  const move = (ev) => {
    const px = ev.clientX - box.getBoundingClientRect().left;
    const k = Math.min(r.km, Math.max(0, ((px - PL) / plot) * r.km));
    const p = at(r, k);
    const xx = PL + (k / r.km) * plot;
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.setAttribute('opacity', 1);
    dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); dot.setAttribute('opacity', 1);
    tip.hidden = false;
    tip.style.left = `${Math.min(w - 60, Math.max(60, xx))}px`;
    tip.innerHTML = `<strong>${k.toFixed(1)} km</strong> · ${p.elev.toLocaleString('en-ZA')} m`;
  };
  const leave = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.hidden = true; };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}
