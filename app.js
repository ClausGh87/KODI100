(function () {
  'use strict';
  const D = window.KR_DATA, L = window.KRLib;
  D.byIcao = Object.fromEntries([...D.GATEWAYS, ...D.STRIPS].map((s) => [s.icao, s]));
  const HUB_COLORS = { AYGA: '#f2a900', AYMD: '#4a90e2', AYNZ: '#4caf50' };
  const DEFAULTS = { gs: 140, turn: 20, paxKg: 85, layer: 'topo' };
  const DEFAULT_USER = 'Claus', DEFAULT_PASS = 'kodi100pw';

  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const sess = {
    get() { try { return sessionStorage.getItem('kr.session'); } catch (e) { return null; } },
    set(v) { try { v ? sessionStorage.setItem('kr.session', v) : sessionStorage.removeItem('kr.session'); } catch (e) { /* ignore */ } },
  };

  let user = null, profile = null, maps = [];
  function loadProfile() {
    const p = store.get('kr.data.' + user, null) || {};
    profile = { settings: Object.assign({}, DEFAULTS, p.settings || {}), alts: p.alts || {} };
  }
  const save = () => store.set('kr.data.' + user, profile);
  const S = () => profile.settings;
  /* Loads are re-shuffled automatically once per day. */
  const shuffleKey = () => new Date().toLocaleDateString('en-CA');

  const tripById = (id) => D.TRIPS.find((t) => t.id === id);
  const tripAlt = (t) => profile.alts[t.id] || t.alt;
  const stats = (t) => L.tripStats(t, D, S());
  const nodesOf = (t) => L.routeNodes(t, D);
  const chain = (t) => nodesOf(t).map((p) => p.icao);
  const hubOf = (t) => D.byIcao[t.hub];
  const fileSafe = (s) => s.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const isGw = (icao) => D.GATEWAYS.some((g) => g.icao === icao);
  const tripOfStrip = (icao) => D.TRIPS.find((t) => t.stops.includes(icao));
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  const pt = (p) => `${Math.abs(p.lat).toFixed(4)}°${p.lat < 0 ? 'S' : 'N'} ${Math.abs(p.lon).toFixed(4)}°${p.lon < 0 ? 'W' : 'E'}`;
  const rwyText = (p) => (p.rwys && p.rwys.length ? p.rwys.map((r) => `${r.id} · ${r.len.toLocaleString('en-US')} ft`).join('; ') : 'n/a');

  /* ---------------- Maps ---------------- */
  function killMaps() { maps.forEach((m) => { try { m.remove(); } catch (e) { /* ignore */ } }); maps = []; }
  function newMap(el) {
    const map = window.L.map(el);
    const topo = window.L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: 'Map: © OpenStreetMap contributors, SRTM | Style: © OpenTopoMap (CC-BY-SA)' });
    const sat = window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18, attribution: 'Tiles © Esri — Maxar, Earthstar Geographics, GIS User Community' });
    const osm = window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
    ({ topo, sat, osm }[S().layer] || topo).addTo(map);
    window.L.control.layers({ 'Terrain': topo, 'Satellite': sat, 'Streets': osm }, null, { collapsed: true }).addTo(map);
    window.L.control.scale({ imperial: false, nautic: true }).addTo(map);
    map.on('baselayerchange', (e) => { S().layer = e.layer === sat ? 'sat' : e.layer === osm ? 'osm' : 'topo'; save(); });
    maps.push(map); return map;
  }
  function icon(label, color, kind) {
    return window.L.divIcon({ className: '', html: `<div class="mk ${kind || ''}" style="--c:${color}">${label}</div>`, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
  }
  function popupHtml(p) {
    const t = !isGw(p.icao) && tripOfStrip(p.icao);
    return `<b class="mono">${esc(p.icao)}</b> ${esc(p.name)}<br>${pt(p)}<br>${p.elev} ft · RWY ${esc(rwyText(p))}${t ? `<br><a href="#/trip/${t.id}">${t.id}</a>` : ''}`;
  }
  function gwMarker(map, p) {
    const base = p.icao === 'AYGA';
    window.L.marker([p.lat, p.lon], { icon: icon(base ? '★' : 'G', HUB_COLORS[p.icao], base ? 'base' : 'gw'), zIndexOffset: 500 })
      .addTo(map).bindPopup(popupHtml(p)).bindTooltip(`${p.icao} ${p.name}`);
  }
  function drawTrip(map, t) {
    const nodes = nodesOf(t), ll = nodes.map((p) => [p.lat, p.lon]), col = HUB_COLORS[t.hub];
    window.L.polyline(ll, { color: col, weight: 3.5, opacity: 0.9 }).addTo(map);
    L.legsOf(t, D, S()).forEach((l) => {
      const mid = [(l.from.lat + l.to.lat) / 2, (l.from.lon + l.to.lon) / 2];
      window.L.marker(mid, { interactive: false, icon: window.L.divIcon({ className: '', html: `<div class="arw" style="transform:rotate(${l.brg.toFixed(0)}deg)">▲</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(map);
    });
    gwMarker(map, D.BASE); if (t.hub !== 'AYGA') gwMarker(map, hubOf(t));
    t.stops.forEach((ic, i) => {
      const p = D.byIcao[ic];
      window.L.marker([p.lat, p.lon], { icon: icon(i + 1, col) }).addTo(map).bindPopup(popupHtml(p)).bindTooltip(`${i + 1} · ${p.icao} ${p.name}`);
    });
    map.fitBounds(window.L.latLngBounds(ll), { padding: [36, 36] });
  }

  /* ---------------- Airport schematic (to scale, not a chart) ---------------- */
  function rwySvg(p) {
    const r = p.rwys && p.rwys[0];
    if (!r) return '<p class="hint">No runway data.</p>';
    const ids = r.id.split('-'), hdg = (parseInt(ids[0], 10) || 0) * 10, k = 0.05, len = Math.min(r.len * k, 112);
    const ux = Math.sin((hdg * Math.PI) / 180), uy = -Math.cos((hdg * Math.PI) / 180), cx = 130, cy = 70;
    const x1 = cx - (ux * len) / 2, y1 = cy - (uy * len) / 2, x2 = cx + (ux * len) / 2, y2 = cy + (uy * len) / 2;
    const lab = (x, y, t) => `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${esc(t)}</text>`;
    return `<svg class="rwy" viewBox="0 0 260 140" role="img" aria-label="Runway schematic ${esc(p.icao)}">
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="rw"/>
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="cl"/>
      ${lab(x1 - ux * 16, y1 - uy * 16, ids[0])}${lab(x2 + ux * 16, y2 + uy * 16, ids[1] || '')}
      <g transform="translate(24,26)"><path d="M0 12 L6 -8 L12 12 L6 7Z" class="na"/><text x="6" y="-12" text-anchor="middle">N</text></g>
      <text x="236" y="130" text-anchor="end" class="sm">${r.len.toLocaleString('en-US')} ft · ${p.elev} ft elev</text></svg>`;
  }
  function airportDetail(p) {
    const links = [
      `<a target="_blank" rel="noopener" href="https://ourairports.com/airports/${p.icao}/">OurAirports</a>`,
      `<a target="_blank" rel="noopener" href="https://skyvector.com/?ll=${p.lat.toFixed(5)},${p.lon.toFixed(5)}&zoom=3">SkyVector</a>`,
    ];
    if (isGw(p.icao)) links.push(`<a target="_blank" rel="noopener" href="https://vatpac.org/aip/${p.icao.toLowerCase()}">VATPAC AIP</a>`);
    const surf = p.rwys && p.rwys[0] && p.rwys[0].surf;
    return `<div class="apb">${rwySvg(p)}<div>
      <p><b class="mono">${p.icao}</b> ${esc(p.name)}<br>${pt(p)}<br>${p.elev} ft · RWY ${esc(rwyText(p))}${surf ? '<br>' + esc(surf) : ''}</p>
      <p class="links">${links.join(' · ')}</p>
      <p class="hint">Schematic only, not for navigation · ${esc(p.src || '')}</p></div></div>`;
  }

  /* ---------------- Views ---------------- */
  const view = $('#view');
  const nav = (a) => $$('#nav a').forEach((x) => x.classList.toggle('on', x.dataset.r === a));

  function renderRoster() {
    nav('roster'); killMaps();
    view.innerHTML = `<h1>Roster</h1><div class="cards">${D.TRIPS.map((t) => {
      const s = stats(t), m = L.manifest(t, nodesOf(t), shuffleKey(), S());
      const pax = m.shipments.reduce((a, x) => a + x.pax, 0), cg = m.shipments.reduce((a, x) => a + x.cargo, 0);
      return `<a class="card" href="#/trip/${t.id}" style="--c:${HUB_COLORS[t.hub]}">
        <div class="ch"><b class="mono">${t.id}</b>${t.hub !== 'AYGA' ? `<span class="pk">via ${esc(hubOf(t).name)}</span>` : ''}</div>
        <div class="route">${chain(t).map((c) => `<code>${c}</code>`).join('<i>›</i>')}</div>
        <div class="names">${t.stops.map((i) => esc(D.byIcao[i].name)).join(' · ')}</div>
        <div class="meta"><span>${Math.round(s.nm)} NM</span><span>${L.fmtMin(s.flyMin)} flight</span><span>${L.fmtMin(s.blockMin)} block</span><span>${pax} pax · ${cg} kg</span></div>
      </a>`;
    }).join('')}</div>`;
  }

  function renderTrip(id) {
    nav('roster'); killMaps();
    const t = tripById(id);
    if (!t) { view.innerHTML = '<p>Trip not found. <a href="#/roster">Back</a></p>'; return; }
    const nodes = nodesOf(t), s = stats(t), mf = L.manifest(t, nodes, shuffleKey(), S()), alt = tripAlt(t);
    view.innerHTML = `
      <a class="back" href="#/roster">← Roster</a>
      <div class="th" style="--c:${HUB_COLORS[t.hub]}"><h1><span class="mono">${t.id}</span></h1>
        <div class="route big">${chain(t).map((c) => `<code>${c}</code>`).join('<i>›</i>')}</div></div>
      <div id="tmap" class="map"></div>
      <div class="chips">
        <span><b>${Math.round(s.nm)}</b> NM</span><span><b>${L.fmtMin(s.flyMin)}</b> flight</span>
        <span><b>${L.fmtMin(s.blockMin)}</b> block</span><span>max <b>${s.maxElev}</b> ft</span>
      </div>
      <div class="tw"><table class="legs">
        <thead><tr><th>#</th><th>Leg</th><th>Trk</th><th>NM</th><th>ETE</th><th>Pax</th><th>Cargo on board</th><th>kg / limit</th><th></th></tr></thead>
        <tbody>${s.legs.map((l, i) => {
          const m = mf.legs[i], rw = l.to.rwys && l.to.rwys[0];
          return `<tr>
          <td>${l.n}</td>
          <td><span class="mono">${l.from.icao}</span> → <button class="ap-toggle mono" data-ap="${i}" title="Airport info &amp; charts">${l.to.icao} ▾</button><br><small>${esc(l.to.name)} · ${l.to.elev} ft${rw ? ' · ' + esc(rw.id) + ' · ' + rw.len.toLocaleString('en-US') + ' ft' : ''}</small></td>
          <td>${String(Math.round(l.brg)).padStart(3, '0')}°</td><td>${l.nm.toFixed(0)}</td><td>${L.fmtMin(l.eteMin)}</td>
          <td>${m.pax || '–'}</td>
          <td>${m.items.length ? m.items.map((x) => `${esc(x.name)} ${x.kg} kg <small>${x.route}</small>`).join('<br>') : '–'}</td>
          <td>${m.total} / ${m.cap}</td>
          <td class="ex"><button data-pln="${i}" title="Leg as .PLN">.PLN</button></td></tr>
          <tr class="dt" data-dt="${i}" hidden><td colspan="9">${airportDetail(l.to)}</td></tr>`;
        }).join('')}</tbody></table></div>
      <div class="row dl">
        <label>Cruise altitude (ft) <input id="alt" type="number" step="500" min="2000" max="25000" value="${alt}"></label>
        <button id="plnAll" class="pri">⬇ Whole trip as .PLN</button>
      </div>`;

    const map = newMap($('#tmap')); drawTrip(map, t); setTimeout(() => map.invalidateSize(), 60);
    const curAlt = () => Math.max(1000, Number($('#alt').value) || alt);
    $('#alt').addEventListener('change', () => { profile.alts[t.id] = curAlt(); save(); toast('Saved'); });
    $('#plnAll').onclick = () => download(fileSafe(`${t.id}_${chain(t).join('-')}.pln`), L.buildPln(nodes, { title: `${t.id} ${chain(t).join('-')}`, alt: curAlt() }), 'application/xml');
    $$('[data-pln]').forEach((b) => b.onclick = () => {
      const l = s.legs[Number(b.dataset.pln)];
      download(fileSafe(`${t.id}_leg${l.n}_${l.from.icao}-${l.to.icao}.pln`), L.buildPln([l.from, l.to], { title: `${t.id} leg ${l.n} ${l.from.icao}-${l.to.icao}`, alt: curAlt() }), 'application/xml');
    });
    $$('[data-ap]').forEach((b) => b.onclick = () => { const r = $(`[data-dt="${b.dataset.ap}"]`); r.hidden = !r.hidden; });
  }

  function renderMap() {
    nav('map'); killMaps();
    view.innerHTML = `<h1>Airports</h1>
      <div class="chips" id="flt">${['AYGA', 'AYMD', 'AYNZ'].map((g) => `<label class="pkf" style="--c:${HUB_COLORS[g]}"><input type="checkbox" data-g="${g}" checked> ${g}</label>`).join('')}
        <label class="pkf"><input type="checkbox" id="rts"> Routes</label></div>
      <div id="amap" class="map tall"></div>
      <div class="tw"><table><thead><tr><th>ICAO</th><th>Name</th><th>Trip</th><th>Position</th><th>ft</th><th>RWY</th></tr></thead><tbody>
      ${D.GATEWAYS.map((p) => `<tr><td class="mono">${p.icao}</td><td>${esc(p.name)}</td><td></td><td>${pt(p)}</td><td>${p.elev}</td><td><small>${esc(rwyText(p))}</small></td></tr>`).join('')}
      ${D.STRIPS.map((p) => { const t = tripOfStrip(p.icao); return `<tr><td class="mono">${p.icao}</td><td>${esc(p.name)}</td><td><a href="#/trip/${t.id}">${t.id}</a></td><td>${pt(p)}</td><td>${p.elev}</td><td><small>${esc(rwyText(p))}</small></td></tr>`; }).join('')}
      </tbody></table></div>
      <h2>Charts &amp; references</h2>
      <div class="panel refs"><ul>
        <li><a target="_blank" rel="noopener" href="https://ourairports.com/countries/PG/">OurAirports – Papua New Guinea</a></li>
        <li><a target="_blank" rel="noopener" href="https://skyvector.com/">SkyVector</a></li>
        <li><a target="_blank" rel="noopener" href="https://vatpac.org/aip">VATPAC AIP</a> (AYGA, AYMD, AYNZ)</li>
        <li><a target="_blank" rel="noopener" href="https://maps.lib.utexas.edu/maps/papua_new_guinea.html">UT Austin map library</a> (ONC / TPC)</li>
        <li><a target="_blank" rel="noopener" href="https://forums.flightsimulator.com/t/papua-new-guinea-bush-flying-charts/484274">MSFS forum: PNG bush flying charts</a></li>
      </ul></div>`;
    const map = newMap($('#amap')), layers = {};
    D.STRIPS.forEach((p) => {
      const t = tripOfStrip(p.icao);
      const m = window.L.marker([p.lat, p.lon], { icon: icon('', HUB_COLORS[t.hub]) }).bindPopup(popupHtml(p)).bindTooltip(`${p.icao} ${p.name} (${t.id})`);
      (layers[t.hub] = layers[t.hub] || window.L.layerGroup()).addLayer(m);
    });
    Object.values(layers).forEach((g) => g.addTo(map));
    D.GATEWAYS.forEach((g) => gwMarker(map, g));
    const routes = window.L.layerGroup();
    D.TRIPS.forEach((t) => window.L.polyline(nodesOf(t).map((p) => [p.lat, p.lon]), { color: HUB_COLORS[t.hub], weight: 2, opacity: 0.75, dashArray: '4 4' }).bindTooltip(t.id).addTo(routes));
    $$('#flt [data-g]').forEach((c) => c.onchange = () => { const g = layers[c.dataset.g]; if (g) c.checked ? g.addTo(map) : map.removeLayer(g); });
    $('#rts').onchange = (e) => e.target.checked ? routes.addTo(map) : map.removeLayer(routes);
    map.fitBounds(window.L.latLngBounds([...D.STRIPS, ...D.GATEWAYS].map((p) => [p.lat, p.lon])), { padding: [30, 30] });
    setTimeout(() => map.invalidateSize(), 60);
  }

  function renderSettings() {
    nav('set'); killMaps();
    const s = S();
    view.innerHTML = `<h1>Settings</h1>
      <div class="panel form">
        <label>Planning groundspeed (kt) <input id="s_gs" type="number" min="80" max="200" value="${s.gs}"></label>
        <label>Ground time per stop (min) <input id="s_turn" type="number" min="0" max="120" value="${s.turn}"></label>
        <label>Weight per passenger incl. baggage (kg) <input id="s_pax" type="number" min="60" max="120" value="${s.paxKg}"></label>
        <div class="row"><button id="s_save" class="pri">Save</button><button id="s_rst" class="danger">Reset</button></div>
      </div>`;
    $('#s_save').onclick = () => {
      Object.assign(profile.settings, { gs: Math.min(200, Math.max(80, Number($('#s_gs').value) || 140)), turn: Math.max(0, Number($('#s_turn').value) || 0), paxKg: Math.min(120, Math.max(60, Number($('#s_pax').value) || 85)) });
      save(); toast('Saved');
    };
    $('#s_rst').onclick = () => { if (confirm('Reset settings and altitudes?')) { profile = { settings: Object.assign({}, DEFAULTS), alts: {} }; save(); renderSettings(); } };
  }

  /* ---------------- Router / shell ---------------- */
  function route() {
    if (!user) return;
    const [r, a] = (location.hash.replace(/^#\/?/, '') || 'roster').split('/');
    ({ roster: renderRoster, trip: () => renderTrip(a), map: renderMap, set: renderSettings }[r] || renderRoster)();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  function showApp() { $('#login').hidden = true; $('#app').hidden = false; $('#who').textContent = user; loadProfile(); route(); }
  function showLogin() {
    $('#app').hidden = true; $('#login').hidden = false; killMaps();
    $('#lg_name').value = DEFAULT_USER; $('#lg_pin').value = DEFAULT_PASS;
    $('#lg_form').onsubmit = (e) => {
      e.preventDefault();
      user = $('#lg_name').value.trim().slice(0, 24) || DEFAULT_USER;
      sess.set(user); showApp();
    };
  }
  $('#logout').onclick = () => { sess.set(null); user = null; location.hash = ''; showLogin(); };

  (function init() {
    const s = sess.get();
    if (s) { user = s; showApp(); } else showLogin();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
