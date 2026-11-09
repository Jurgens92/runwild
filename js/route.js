// Route preview: course map, key numbers and an elevation profile, drawn from the GPS track
// recorded on the reserve (js/route-data.js). The 20 km course is the whole recorded loop; the
// 11 km course runs from the start to the Lookout and back the same way.
import { TRACK, LOOKOUT_INDEX, WAYPOINTS } from './route-data.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => 
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TBC = '<span class="tbc">To be confirmed</span>';

// Start, finish and route as published by the organisers. Until they confirm them, each shows "To be confirmed".
export function routeFacts(ev = {}, mode = 'list') {
  const ok = !!ev.routeConfirmed;
  const rows = [
    ['Start', ok && ev.startLocation ? esc(ev.startLocation) : TBC],
    ['Finish', ok && ev.finishLocation ? esc(ev.finishLocation) : TBC],
    ['Route', ok && ev.routeDescription ? esc(ev.routeDescription) : TBC],
  ];
  if (mode === 'rows') return rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  return `<dl class="rt-where">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}

const W = 600;
const H = 440;

// Keys stay '21k' and '5k' so saved entries keep working; the labels are what visitors see.
const ROUTES = {
  '21k': {
    name: '20 km', label: '20 km trail run', tab: 'Trail run', colour: '#131b41', terrain: 'Gravel and jeep tracks through the reserve',
    describe: 'a loop from the start past Impala and Rhino to the Lookout, back to Rhino, then on past Zebra, the air strip and Eland to Impala and back to the finish',
  },
  '5k': {
    name: '11 km', label: '11 km run/walk', tab: 'Run / walk', colour: '#74685b', terrain: 'Gravel and jeep tracks, out and back',
    describe: 'out past Impala and Rhino to the Lookout, then back the same way to the finish',
  },
};

// The water points are at the named waypoints. Each pass is found from the track itself.
const R_EARTH = 6371008.8;
const LAT0 = TRACK.reduce((a, p) => a + p[0], 0) / TRACK.length;
// Local flat projection in metres (east, north) – accurate to well under a metre over a few kilometres.
const proj = ([lat, lng]) => [lng * (Math.PI / 180) * R_EARTH * Math.cos(LAT0 * Math.PI / 180), lat * (Math.PI / 180) * R_EARTH];

function build(key) {
  const R = ROUTES[key];
  const raw = key === '21k' ? TRACK : [...TRACK.slice(0, LOOKOUT_INDEX + 1), ...TRACK.slice(0, LOOKOUT_INDEX).reverse()];
  const xy = raw.map(proj);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const kmAt = cum.map((m) => m / 1000);
  const km = Math.round(kmAt[kmAt.length - 1] * 10) / 10;
  // GPS heights are noisy: smooth lightly for the profile and count only climbs of more than 3 m.
  const elev = raw.map((_, i) => {
    const w = raw.slice(Math.max(0, i - 2), i + 3);
    return w.reduce((a, p) => a + p[2], 0) / w.length;
  });
  let gain = 0;
  let ref = elev[0];
  for (const e of elev) { if (e > ref + 3) { gain += e - ref; ref = e; } else if (e < ref - 3) ref = e; }
  // Every time the course passes a water point (within 60 m), at least 1 km after the last pass.
  const waterPoints = [];
  for (const w of WAYPOINTS) {
    const [wx, wy] = proj([w.lat, w.lng]);
    const d = xy.map(([x, y]) => Math.hypot(x - wx, y - wy));
    let last = -Infinity;
    for (let i = 0; i < d.length; i++) {
      const near = d[i] < 60 && d.slice(Math.max(0, i - 6), i + 7).every((v) => v >= d[i]);
      if (near && kmAt[i] - last > 1) { waterPoints.push({ name: w.name, km: Math.round(kmAt[i] * 10) / 10 }); last = kmAt[i]; }
    }
  }
  waterPoints.sort((a, b) => a.km - b.km);
  const stations = [...new Set(waterPoints.map((w) => w.name))];
  return { ...R, key, xy, kmAt, km, elev, waterPoints, stations, gain: Math.round(gain / 5) * 5, high: Math.round(Math.max(...elev)), low: Math.round(Math.min(...elev)) };
}

// One map frame for both courses (north up), so switching distance keeps the same scale.
function fit(routes) {
  const all = Object.values(routes).flatMap((r) => r.xy);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = { l: 56, r: 56, t: 36, b: 56 };
  const k = Math.min((W - pad.l - pad.r) / (x1 - x0), (H - pad.t - pad.b) / (y1 - y0));
  const ox = pad.l + (W - pad.l - pad.r - (x1 - x0) * k) / 2;
  const oy = pad.t + (H - pad.t - pad.b - (y1 - y0) * k) / 2;
  const toSvg = ([x, y]) => [ox + (x - x0) * k, oy + (y1 - y) * k];
  for (const r of Object.values(routes)) {
    r.pts = r.xy.map(toSvg);
    r.unitsPerKm = k * 1000;
  }
  const marks = WAYPOINTS.map((w) => ({ ...w, p: toSvg(proj([w.lat, w.lng])) }));
  return { routes, marks };
}

function at(route, km) {
  const i = Math.max(1, route.kmAt.findIndex((k) => k >= km));
  const [k0, k1] = [route.kmAt[i - 1], route.kmAt[i]];
  const f = k1 > k0 ? (km - k0) / (k1 - k0) : 0;
  const lerp = (a, b) => a + (b - a) * f;
  return { x: lerp(route.pts[i - 1][0], route.pts[i][0]), y: lerp(route.pts[i - 1][1], route.pts[i][1]), elev: Math.round(lerp(route.elev[i - 1], route.elev[i])) };
}

const pathOf = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L');

// Where each waypoint label sits relative to its marker, chosen so labels clear the course.
const LABEL_POS = { Impala: 'below', Rhino: 'left', 'Lookout Point': 'below', Zebra: 'left', 'Air Strip': 'above', Eland: 'left' };

function mapSVG(route, other, marks) {
  const kmMarks = [];
  for (let k = 5; k < route.km - 0.5; k += 5) {
    if (route.waterPoints.some((w) => Math.abs(w.km - k) < 0.4)) continue; // the water point label is there already
    const p = at(route, k);
    kmMarks.push(`<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><circle r="11" fill="#fff" stroke="${route.colour}" stroke-width="1.5"/><text text-anchor="middle" dy="3.5" class="rt-km">${k}</text></g>`);
  }
  // Small chevrons show the direction of travel.
  const arrows = [];
  for (let k = 1.25; k < route.km - 0.5; k += 2.5) {
    if (route.waterPoints.some((w) => Math.abs(w.km - k) < 0.3)) continue;
    const a = at(route, k);
    const b = at(route, k + 0.08);
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    arrows.push(`<path d="M-5 -5.5 L5 0 L-5 5.5 Z" transform="translate(${a.x.toFixed(1)} ${a.y.toFixed(1)}) rotate(${ang.toFixed(0)})" fill="${route.colour}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`);
  }
  // Water points sit at the named waypoints; the drop marks a point on this course, a grey dot one that is not.
  const places = marks.map((m) => {
    const pos = LABEL_POS[m.name] || 'right';
    const [tx, ty, anchor] = { left: [-12, 4, 'end'], right: [12, 4, 'start'], above: [0, -14, 'middle'], below: [0, 20, 'middle'] }[pos];
    const kms = route.waterPoints.filter((w) => w.name === m.name).map((w) => w.km + ' km');
    const on = kms.length > 0;
    const mark = on
      ? '<path d="M0 -10 C 4.5 -3.5 6.5 0 6.5 3.5 A 6.5 6.5 0 0 1 -6.5 3.5 C -6.5 0 -4.5 -3.5 0 -10Z" fill="#0066b2" stroke="#fff" stroke-width="1.5"/>'
      : '<circle r="4" fill="#fff" stroke="#b9b2a6" stroke-width="2"/>';
    return `<g transform="translate(${m.p[0].toFixed(1)} ${m.p[1].toFixed(1)})" class="rt-place${on ? '' : ' off'}"><title>${m.name} water point${on ? ' · ' + kms.join(' and ') : ' (20 km only)'}</title>${mark}<text x="${tx}" y="${ty}" text-anchor="${anchor}">${m.name}</text></g>`;
  }).join('');
  const start = route.pts[0];
  const scale = route.unitsPerKm;
  return `<svg viewBox="0 0 ${W} ${H}" class="rt-map" role="img" aria-label="Map of the ${route.label} course: ${route.describe}, with water points at ${route.stations.join(', ')}.">
    <rect width="${W}" height="${H}" rx="14" fill="#f1eeea"/>
    ${other ? `<path d="${pathOf(other.pts)}" fill="none" stroke="#b9b2a6" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round"/>` : ''}
    <path d="${pathOf(route.pts)}" fill="none" stroke="#fff" stroke-width="8" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${pathOf(route.pts)}" fill="none" stroke="${route.colour}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${arrows.join('')}${kmMarks.join('')}${places}
    <g transform="translate(${start[0].toFixed(1)} ${start[1].toFixed(1)})"><circle r="9" fill="${route.colour}" stroke="#fff" stroke-width="3"/><text x="-14" y="-12" text-anchor="end" class="rt-tag">Start / finish</text></g>
    <circle class="rt-dot" r="7" fill="#fff" stroke="${route.colour}" stroke-width="3" cx="${start[0]}" cy="${start[1]}" opacity="0"/>
    <g transform="translate(${W - 34} 34)" class="rt-north"><path d="M0 -14 L6 6 L0 2 L-6 6Z" fill="#74685b"/><text text-anchor="middle" y="20">N</text></g>
    <g transform="translate(24 ${H - 26})"><path d="M0 0 H${scale.toFixed(1)}" stroke="#74685b" stroke-width="2"/><path d="M0 -4 V4 M${scale.toFixed(1)} -4 V4" stroke="#74685b" stroke-width="2"/><text x="${(scale / 2).toFixed(1)}" y="-8" text-anchor="middle" class="rt-scale">1 km</text></g>
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
  const wps = route.waterPoints.map(({ km: k }) => `<line x1="${x(k)}" x2="${x(k)}" y1="${y(at(route, k).elev) + 4}" y2="${y(lo)}" stroke="#0066b2" stroke-width="1.5" stroke-dasharray="3 3"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="rt-profile" role="img" aria-label="Elevation profile: ${route.low} m to ${route.high} m, about ${route.gain} m of climbing over ${route.km} km.">
    <defs><linearGradient id="rt-fill-${route.key}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${route.colour}" stop-opacity=".22"/><stop offset="1" stop-color="${route.colour}" stop-opacity=".02"/></linearGradient></defs>
    ${yTicks.join('')}${xTicks.join('')}
    <path d="${area}" fill="url(#rt-fill-${route.key})"/>
    ${wps}
    <path d="${line}" fill="none" stroke="${route.colour}" stroke-width="2" stroke-linejoin="round"/>
    <line class="rt-cross" y1="${pt}" y2="${y(lo)}" x1="0" x2="0" stroke="#74685b" stroke-width="1" opacity="0"/>
    <rect x="${pl}" y="0" width="${w - pl - pr}" height="${h}" fill="transparent" class="rt-hit"/>
  </svg>`;
}

export function routeExplorer(el, { initial = '21k', event = {} } = {}) {
  const { routes, marks } = fit({ '21k': build('21k'), '5k': build('5k') });
  const draw = (key) => {
    const r = routes[key];
    const other = routes[key === '21k' ? '5k' : '21k'];
    el.innerHTML = `
      <div class="rt-tabs" role="tablist" aria-label="Distance">
        ${Object.values(routes).map((x) => `<button role="tab" aria-selected="${x.key === key}" data-k="${x.key}"><strong>${x.name}</strong> <span>${x.tab}</span></button>`).join('')}
      </div>
      <div class="rt-body">
        <figure class="rt-figure">${mapSVG(r, key === '5k' ? other : null, marks)}</figure>
        <div class="rt-side">
          <dl class="rt-stats">
            <div><dt>Distance (GPS)</dt><dd>${r.km} km</dd></div>
            <div><dt>Elevation gain</dt><dd>${r.gain} m</dd></div>
            <div><dt>Highest point</dt><dd>${r.high.toLocaleString('en-ZA')} m</dd></div>
            <div><dt>Water points</dt><dd>${r.stations.length}</dd></div>
          </dl>
          ${routeFacts(event)}
          <p class="rt-terrain"><span class="label muted">Terrain</span><br>${r.terrain}</p>
          <p class="rt-terrain"><span class="label muted">Water points</span><br>${r.waterPoints.map((w) => `${w.name} <span class="muted">${w.km} km</span>`).join(' · ')}</p>
          <p class="rt-legend small muted"><span><i class="sw" style="background:${r.colour}"></i>${r.label}</span>${key === '5k' ? '<span><i class="sw dash"></i>Rest of the 20 km loop</span>' : ''}<span><i class="sw drop"></i>Water point</span></p>
        </div>
      </div>
      <div class="rt-chart">
        <div class="rt-chart-head"><span class="label muted">Elevation profile</span><span class="small muted">Hover or tap to explore</span></div>
        <div class="rt-chart-box"><div class="rt-tip" hidden></div></div>
      </div>
      <p class="small muted rt-note">Course recorded on the reserve with a GPS. Distances and heights come from that recording, so expect your own watch to differ a little. Arrows show the direction of travel.</p>`;
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
    const wp = r.waterPoints.find((w) => Math.abs(w.km - k) < 0.15);
    tip.innerHTML = `<strong>${k.toFixed(1)} km</strong> · ${p.elev.toLocaleString('en-ZA')} m${wp ? ` · ${wp.name} water point` : ''}`;
  };
  const leave = () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.hidden = true; };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}
