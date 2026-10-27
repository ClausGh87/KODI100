/* Pure calculation and export helpers (browser + Node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KRLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const R_NM = 3440.065;
  const rad = (x) => (x * Math.PI) / 180;
  const deg = (x) => (x * 180) / Math.PI;

  function distNm(a, b) {
    const p1 = rad(a.lat), p2 = rad(b.lat), dp = p2 - p1, dl = rad(b.lon - a.lon);
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  /* A trip always starts and ends at AYGA. Trips served from AYMD / AYNZ route via that gateway. */
  function routeNodes(trip, data) {
    const by = data.byIcao, A = data.BASE, stops = trip.stops.map((i) => by[i]);
    if (trip.hub === 'AYGA') return [A, ...stops, A];
    const h = by[trip.hub];
    return [A, h, ...stops, h, A];
  }
  function hubIdx(trip, nodes) {
    return trip.hub === 'AYGA' ? { out: 0, back: nodes.length - 1 } : { out: 1, back: nodes.length - 2 };
  }

  function legsOf(trip, data, settings) {
    const pts = routeNodes(trip, data);
    const gs = (settings && settings.gs) || 140;
    const legs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], nm = distNm(a, b);
      legs.push({ n: i + 1, from: a, to: b, nm, brg: bearing(a, b), eteMin: (nm / gs) * 60 });
    }
    return legs;
  }

  function tripStats(trip, data, settings) {
    const legs = legsOf(trip, data, settings);
    const nm = legs.reduce((s, l) => s + l.nm, 0);
    const fly = legs.reduce((s, l) => s + l.eteMin, 0);
    const turn = (settings && settings.turn != null ? settings.turn : 20) * (legs.length - 1);
    return { legs, nm, flyMin: fly, groundMin: turn, blockMin: fly + turn, maxElev: Math.max(...routeNodes(trip, data).map((p) => p.elev)) };
  }

  /* ---------- Payload flows ----------
     Rule: every shipment has a gateway (AYGA / AYMD / AYNZ) at one end. Goods and passengers
     move gateway -> strip or strip -> gateway, never strip -> strip. */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const IN = ['Rice', 'Corrugated iron', 'Medical supplies', 'Mail & parcels', 'Hand tools', 'Seed', 'Solar panels & batteries', 'School supplies', 'Frozen fish', 'Cement bags', 'Store goods', 'Fuel drums'];
  const OUT = ['Coffee bags', 'Fresh vegetables', 'Vanilla', 'Cocoa', 'Outgoing mail', 'Equipment for repair', 'Bananas', 'Empty drums'];
  const TRUNK_OUT = ['Consolidated freight', 'Mail & parcels', 'Spare parts'];
  const TRUNK_BACK = ['Produce consignment', 'Returned empties', 'Mail & parcels'];
  const MAX_PAX = 8;

  function payloadCap(dep, arr) {
    const e = Math.max(dep.elev, arr.elev);
    if (e > 6000) return 520;
    if (e > 5000) return 600;
    return 700;
  }

  function manifest(trip, nodes, roll, settings) {
    const paxKg = (settings && settings.paxKg) || 85;
    const rnd = mulberry32(hashStr(trip.id + ':' + roll));
    const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const pick = (p) => p[Math.floor(rnd() * p.length)];
    const n = nodes.length, h = hubIdx(trip, nodes);
    const sh = [];
    if (trip.hub !== 'AYGA') {
      sh.push({ from: 0, to: h.out, kind: 'trunk', pax: ri(0, 3), cargo: ri(10, 60) * 5, item: pick(TRUNK_OUT) });
      sh.push({ from: h.back, to: n - 1, kind: 'trunk', pax: ri(0, 3), cargo: ri(10, 60) * 5, item: pick(TRUNK_BACK) });
    }
    for (let i = h.out + 1; i < h.back; i++) {
      sh.push({ from: h.out, to: i, kind: 'in', pax: ri(0, 2), cargo: ri(4, 24) * 5, item: pick(IN) });
      sh.push({ from: i, to: h.back, kind: 'out', pax: ri(0, 2), cargo: ri(0, 18) * 5, item: pick(OUT) });
    }
    const caps = nodes.slice(0, -1).map((a, k) => payloadCap(a, nodes[k + 1]));
    const onLeg = (k) => sh.filter((s) => s.from <= k && s.to >= k + 1);
    const sum = (arr) => ({ pax: arr.reduce((a, s) => a + s.pax, 0), cargo: arr.reduce((a, s) => a + s.cargo, 0) });
    const stripSh = sh.filter((s) => s.kind !== 'trunk');
    const stripOf = (s) => (s.kind === 'in' ? s.to : s.from);
    const soleContent = (s) => !stripSh.some((x) => x !== s && stripOf(x) === stripOf(s) && (x.pax > 0 || x.cargo > 0));
    function fit() {
      for (let it = 0; it < 1000; it++) {
        let bad = -1;
        for (let k = 0; k < caps.length; k++) {
          const t = sum(onLeg(k));
          if (t.pax * paxKg + t.cargo > caps[k] || t.pax > MAX_PAX) { bad = k; break; }
        }
        if (bad < 0) return;
        const on = onLeg(bad), t = sum(on);
        const paxFirst = t.pax > MAX_PAX;
        const byPax = on.filter((s) => s.pax > 0).sort((a, b) => b.pax - a.pax);
        const byCargo = on.filter((s) => s.cargo > 0).sort((a, b) => b.cargo - a.cargo);
        const okPax = (s) => !(s.kind !== 'trunk' && s.pax === 1 && s.cargo === 0 && soleContent(s));
        const okCargo = (s) => !(s.kind !== 'trunk' && s.cargo <= 10 && s.pax === 0 && soleContent(s));
        let c;
        if (!paxFirst && (c = byCargo.find(okCargo))) c.cargo = Math.max(0, c.cargo - 10);
        else if ((c = byPax.find(okPax))) c.pax--;
        else if ((c = byCargo.find(okCargo))) c.cargo = Math.max(0, c.cargo - 10);
        else if ((c = byCargo[0])) c.cargo = Math.max(5, c.cargo - 5);
        else return;
      }
    }
    fit();
    for (let i = h.out + 1; i < h.back; i++) {
      const mine = stripSh.filter((s) => s.from === i || s.to === i);
      if (!mine.some((s) => s.pax > 0 || s.cargo > 0)) mine.find((s) => s.kind === 'in').cargo = 30;
    }
    if (!stripSh.some((s) => s.pax > 0)) stripSh.find((s) => s.kind === 'in').pax = 1;
    fit();

    const shipments = sh.filter((s) => s.pax > 0 || s.cargo > 0).map((s) => ({ ...s, fromIcao: nodes[s.from].icao, toIcao: nodes[s.to].icao, fromName: nodes[s.from].name, toName: nodes[s.to].name }));
    const legs = caps.map((cap, k) => {
      const on = onLeg(k).filter((s) => s.pax > 0 || s.cargo > 0), t = sum(on);
      return { pax: t.pax, paxKg: t.pax * paxKg, cargo: t.cargo, total: t.pax * paxKg + t.cargo, cap,
        items: on.filter((s) => s.cargo > 0).map((s) => ({ name: s.item, kg: s.cargo, route: nodes[s.from].icao + '→' + nodes[s.to].icao })) };
    });
    return { shipments, legs };
  }

  /* ---------- MSFS .PLN ---------- */
  function toLLA(lat, lon, elevFt) {
    const f = (v, pos, neg) => {
      const hh = v >= 0 ? pos : neg; v = Math.abs(v);
      let d = Math.floor(v), mFull = (v - d) * 60, m = Math.floor(mFull), s = Math.round((mFull - m) * 60 * 100) / 100;
      if (s >= 60) { s -= 60; m += 1; }
      if (m >= 60) { m -= 60; d += 1; }
      return `${hh}${d}° ${m}' ${s.toFixed(2)}"`;
    };
    const e = Math.round(elevFt * 100) / 100, sign = e < 0 ? '-' : '+';
    return `${f(lat, 'N', 'S')},${f(lon, 'E', 'W')},${sign}${String(Math.abs(e).toFixed(2)).padStart(9, '0')}`;
  }
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function buildPln(pts, opts) {
    const o = Object.assign({ title: '', alt: 10500, type: 'VFR' }, opts);
    const a = pts[0], z = pts[pts.length - 1];
    const wps = pts.map((p) =>
      `    <ATCWaypoint id="${xmlEsc(p.icao)}">\n      <ATCWaypointType>Airport</ATCWaypointType>\n      <WorldPosition>${toLLA(p.lat, p.lon, p.elev)}</WorldPosition>\n      <ICAO>\n        <ICAOIdent>${xmlEsc(p.icao)}</ICAOIdent>\n      </ICAO>\n    </ATCWaypoint>`
    ).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
  <Descr>AceXML Document</Descr>
  <FlightPlan.FlightPlan>
    <Title>${xmlEsc(o.title || pts.map((p) => p.icao).join(' - '))}</Title>
    <FPType>${o.type}</FPType>
    <CruisingAlt>${Number(o.alt).toFixed(3)}</CruisingAlt>
    <DepartureID>${xmlEsc(a.icao)}</DepartureID>
    <DepartureLLA>${toLLA(a.lat, a.lon, a.elev)}</DepartureLLA>
    <DestinationID>${xmlEsc(z.icao)}</DestinationID>
    <DestinationLLA>${toLLA(z.lat, z.lon, z.elev)}</DestinationLLA>
    <Descr>${xmlEsc(pts.map((p) => p.icao).join(', '))}</Descr>
    <DepartureName>${xmlEsc(a.name)}</DepartureName>
    <DestinationName>${xmlEsc(z.name)}</DestinationName>
    <AppVersion>
      <AppVersionMajor>11</AppVersionMajor>
      <AppVersionBuild>282174</AppVersionBuild>
    </AppVersion>
${wps}
  </FlightPlan.FlightPlan>
</SimBase.Document>
`;
  }

  const fmtMin = (m) => { m = Math.round(m); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };

  return { distNm, bearing, routeNodes, hubIdx, legsOf, tripStats, manifest, payloadCap, toLLA, buildPln, fmtMin, mulberry32, hashStr, MAX_PAX };
});
