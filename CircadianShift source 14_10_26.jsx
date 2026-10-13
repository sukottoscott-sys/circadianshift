import React, { useState, useMemo, useEffect, useRef } from "react";
import { Sun, Moon, Pill, Coffee, Plane, ChevronDown, ChevronUp, EyeOff, Utensils, Radio, Clock, AlertTriangle } from "lucide-react";

// ---------- constants ----------
const MIN = 60, DAY = 1440, HR = 3600000, MSM = 60000, DAYMS = 86400000;
const BUF = 90;                  // meal / awake buffer (min) at each end of each flight
const TRANSIT = 75, BOARD = 90;  // deplane + transit, and gate + boarding lead (min)

// ---------- helpers ----------
const mod = (x, n) => ((x % n) + n) % n;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pad = (n) => String(n).padStart(2, "0");
const parseT = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const parseUTC = (s, off) => {
  if (typeof s !== "string" || !s.includes("T")) return NaN;
  const [d, t] = s.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const v = Date.UTC(Y, M - 1, D, h, mi) - off * HR;
  return Number.isFinite(v) ? v : NaN;
};
const toLocalStr = (ms, off) => { const d = new Date(ms + off * HR); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const clockAt = (ms, off) => { const m = mod(Math.floor(ms / MSM) + Math.round(off * 60), DAY); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const dateAt = (ms, off) => new Date(ms + off * HR).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const dateClockAt = (ms, off) => `${dateAt(ms, off)} ${clockAt(ms, off)}`;
const dur = (ms) => { ms = Math.max(0, ms); const m = Math.round(ms / MSM); const h = Math.floor(m / 60); return h > 0 ? `${h}h ${pad(m % 60)}m` : `${m % 60}m`; };
const okSpan = ([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a;

// ---------- timezone lookup (fully offline: the JS engine's built-in IANA data) ----------
function zoneOffset(timeZone, atMs) {
  const d = new Date(atMs);
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {}; for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
  let hh = +p.hour; if (hh === 24) hh = 0;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute, +p.second);
  return Math.round((asUTC - d.getTime()) / MSM) / 60;
}
function zoneOffsetForDate(timeZone, ymd) {
  if (!timeZone || !ymd) return null;
  const [Y, M, D] = ymd.split("-").map(Number);
  try { return zoneOffset(timeZone, Date.UTC(Y, M - 1, D, 12, 0, 0)); } catch { return null; }
}
const ZONES = (() => {
  try { if (Intl.supportedValuesOf) return Intl.supportedValuesOf("timeZone"); } catch {}
  return ["Australia/Melbourne", "Australia/Sydney", "Pacific/Auckland", "Asia/Ho_Chi_Minh", "Asia/Singapore", "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Los_Angeles", "UTC"];
})();
const ALIAS = { "Asia/Ho_Chi_Minh": "saigon hanoi vietnam", "America/New_York": "nyc", "Europe/London": "uk britain", "Asia/Kolkata": "india mumbai delhi bangalore calcutta", "Australia/Melbourne": "victoria", "Pacific/Auckland": "nz new zealand", "Asia/Tokyo": "japan osaka kyoto" };
const zoneLabel = (z) => { const parts = z.split("/"); const city = parts[parts.length - 1].replace(/_/g, " "); const region = parts.length > 1 ? parts[0].replace(/_/g, " ") : ""; return region ? `${city} (${region})` : city; };
const fmtOff = (o) => o == null ? "" : `UTC${o >= 0 ? "+" : "-"}${Math.floor(Math.abs(o))}${Math.abs(o) % 1 ? ":" + pad(Math.round((Math.abs(o) % 1) * 60)) : ""}`;
const cityOf = (zone, off) => zone ? zoneLabel(zone).split(" (")[0] : fmtOff(off);

// ---------- persistence ----------
// Three layers: localStorage, a persistent-storage request, and the whole setup
// mirrored into the URL hash so it survives storage being wiped.
const STORE_KEY = "circadianshift.setup.v1";
const b64 = {
  enc: (o) => { try { return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); } catch { return ""; } },
  dec: (s) => { try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))); } catch { return null; } },
};
const loadSaved = () => { try { const r = localStorage.getItem(STORE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } };
const saveSetup = (v) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); return true; } catch { return false; } };
const loadHash = () => { try { const h = location.hash.replace(/^#/, ""); return h ? b64.dec(h) : null; } catch { return null; } };

const ZK = { home: ["homeZone", "homeOffset", "depart"], dest: ["destZone", "destOffset", "arrive"], stop: ["stopZone", "stopOffset", "stopArrive"], retStop: ["retStopZone", "retStopOffset", "retStopArrive"] };

const DEFAULTS = {
  homeZone: "Australia/Melbourne", destZone: "America/New_York",
  homeOffset: 10, destOffset: -4,
  depart: "2026-07-08T10:55", arrive: "2026-07-08T19:03", delayMin: 0,
  hasStop: false, stopZone: "Asia/Dubai", stopOffset: 4,
  stopArrive: "2026-07-08T17:30", stopDepart: "2026-07-09T01:30",
  roundTrip: false, retDepart: "2026-07-15T21:00", retArrive: "2026-07-17T06:35", retDelayMin: 0,
  retHasStop: false, retStopZone: "Asia/Dubai", retStopOffset: 4,
  retStopArrive: "2026-07-16T05:00", retStopDepart: "2026-07-16T09:30",
  bed: "23:00", wake: "07:00", chrono: "intermediate",
  melatonin: true, caffeine: true, preDays: null, advRate: 1.5, delRate: 1.5,
};

// ---------- model ----------
// Clip a PRC light window to the waking period (absolute UTC ms, plain intersection).
function clipAbs(w, a, b) {
  const lo = Math.max(w[0], a);
  let hi = Math.min(w[1], b);
  if (hi - lo < 60 * MSM) return null;
  if (hi - lo < 120 * MSM) hi = Math.min(b, lo + 120 * MSM);
  return [lo, hi];
}

// Direction and size of one shift. Runs once per direction on a round trip.
function computeShiftMeta(fromOff, toOff, advRate, delRate) {
  let tz = toOff - fromOff;
  if (tz > 12) tz -= 24; if (tz < -12) tz += 24;
  const advH = advRate || 1.0, delH = delRate || 1.5;
  const crossover = (24 * advH) / (delH + advH);
  let direction, total;
  if (tz === 0) { direction = "none"; total = 0; }
  else if (tz > 0) {
    const a = tz / advH, de = (24 - tz) / delH;
    if (a <= de) { direction = "advance"; total = tz * MIN; } else { direction = "delay"; total = (24 - tz) * MIN; }
  } else { direction = "delay"; total = -tz * MIN; }
  const rate = (direction === "advance" ? advH : delH) * MIN;
  const daysNeeded = total === 0 ? 0 : Math.ceil(total / rate);
  return { direction, total, rate, daysNeeded, crossover, tz };
}
const headStart = (direction, daysNeeded, explicitPre) =>
  explicitPre != null ? explicitPre : Math.min(3, Math.max(direction === "none" ? 0 : 1, Math.round(daysNeeded / 3)));

// Sleep episodes in absolute UTC. cum saturates at total, so episodes past
// adaptation are steady daily sleep at the target clock.
function buildEpisodes({ bedAnchorUTC, nEp, direction, total, rate, sleepMs, chronoAdj }) {
  const ep = [];
  for (let k = 0; k < nEp + 1; k++) {
    const cum = Math.min(k * rate, total);
    const signed = direction === "advance" ? -cum : direction === "delay" ? cum : 0;
    const bedUTC = bedAnchorUTC + k * DAYMS + signed * MSM;
    const wakeUTC = bedUTC + sleepMs;
    ep.push({ bedUTC, wakeUTC, tminUTC: wakeUTC - (120 - chronoAdj) * MSM, cum, done: total > 0 && cum >= total, direction });
  }
  return ep;
}

// Legs and ground time for one journey, optionally with one stopover. A delay on
// leg 1 eats ground time; on a direct flight it moves the arrival.
function buildLegs(fromOff, toOff, depart, arrive, delayMin, hasStop, stopOff, stopArrive, stopDepart) {
  const delayMs = (delayMin || 0) * MSM;
  const departUTC = parseUTC(depart, fromOff) + delayMs;
  let arriveUTC = parseUTC(arrive, toOff);
  let legs = [[departUTC, arriveUTC]], ground = null, missedConn = false, stopBad = false;
  if (hasStop && stopArrive && stopDepart) {
    const stopArrUTC = parseUTC(stopArrive, stopOff) + delayMs;
    const stopDepUTC = parseUTC(stopDepart, stopOff);
    // Entered out of order is a typo; out of order only because of the delay is a missed connection.
    if (!(stopArrUTC - delayMs < stopDepUTC)) stopBad = true;
    missedConn = stopArrUTC >= stopDepUTC - 30 * MSM;
    const a = Math.min(stopArrUTC, stopDepUTC - 30 * MSM);
    const l1 = [departUTC, a], l2 = [stopDepUTC, arriveUTC];
    if (!stopBad && okSpan(l1) && okSpan(l2)) { legs = [l1, l2]; ground = [a, stopDepUTC]; }
    else stopBad = true;
  } else arriveUTC += delayMs;
  if (!ground) legs = [[departUTC, arriveUTC]];
  return { departUTC, arriveUTC, legs, ground, missedConn, stopBad };
}

function buildPlan(inp) {
  const wake = parseT(inp.wake), bed = parseT(inp.bed);
  const sleepDur = mod(wake - bed, DAY) || 480;
  const chronoAdj = { early: -60, intermediate: 0, late: 60 }[inp.chrono] ?? 0;
  const sleepMs = sleepDur * MSM;
  const homeName = cityOf(inp.homeZone, inp.homeOffset), destName = cityOf(inp.destZone, inp.destOffset);
  const issues = [];

  // ---- outbound, validated ----
  const out = buildLegs(inp.homeOffset, inp.destOffset, inp.depart, inp.arrive, inp.delayMin,
    inp.hasStop, inp.stopOffset, inp.stopArrive, inp.stopDepart);
  if (!Number.isFinite(out.departUTC)) {
    issues.push({ where: "trip", msg: "Outbound departure is missing." });
    out.departUTC = Number.isFinite(out.arriveUTC) ? out.arriveUTC - 10 * HR : Date.UTC(2026, 0, 1);
    out.legs = [[out.departUTC, out.arriveUTC]]; out.ground = null; out.stopBad = false;
  }
  if (!okSpan([out.departUTC, out.arriveUTC])) {
    issues.push({ where: "trip", msg: "Outbound arrival is not after departure. Check the arrival date." });
    out.arriveUTC = out.departUTC + 10 * HR; out.legs = [[out.departUTC, out.arriveUTC]]; out.ground = null;
  } else if (out.arriveUTC - out.departUTC > 40 * HR) {
    issues.push({ where: "trip", msg: `Outbound journey works out at ${dur(out.arriveUTC - out.departUTC)}. Check the dates.` });
  }
  if (out.stopBad) issues.push({ where: "trip", msg: "Outbound stopover times are out of order, so the stopover is ignored. Check leg 1 arrival and leg 2 departure." });
  const { departUTC, arriveUTC } = out;

  // ---- return, validated. An invalid return is dropped rather than silently
  // corrupting the zone timeline (a stale return date used to do exactly that). ----
  let roundTrip = !!inp.roundTrip, ret = null;
  if (roundTrip) {
    ret = buildLegs(inp.destOffset, inp.homeOffset, inp.retDepart, inp.retArrive, inp.retDelayMin,
      inp.retHasStop, inp.retStopOffset, inp.retStopArrive, inp.retStopDepart);
    if (!(ret.departUTC > arriveUTC)) {
      issues.push({ where: "ret", msg: "Return departs before the outbound flight lands. Return leg ignored until the return departure is fixed." });
      roundTrip = false;
    } else if (!okSpan([ret.departUTC, ret.arriveUTC])) {
      issues.push({ where: "ret", msg: "Return arrival is not after return departure. Return leg ignored until the return arrival is fixed." });
      roundTrip = false;
    } else {
      if (ret.arriveUTC - ret.departUTC > 40 * HR) issues.push({ where: "ret", msg: `Return journey works out at ${dur(ret.arriveUTC - ret.departUTC)}. Check the dates.` });
      if (ret.stopBad) issues.push({ where: "ret", msg: "Return stopover times are out of order, so that stopover is ignored." });
    }
    if (!roundTrip) ret = null;
  }

  const shift1 = computeShiftMeta(inp.homeOffset, inp.destOffset, inp.advRate, inp.delRate);
  const { direction, total, rate, daysNeeded, crossover } = shift1;
  const pre = headStart(direction, daysNeeded, inp.preDays);
  const depMid = Math.floor((departUTC - (inp.delayMin || 0) * MSM + inp.homeOffset * HR) / DAYMS) * DAYMS;
  const bedAnchor1 = depMid - pre * DAYMS + bed * MSM - inp.homeOffset * HR;

  let shift2 = null, pre2 = 0, stayDays = null, tightStay = false, ep2 = [];
  if (roundTrip) {
    shift2 = computeShiftMeta(inp.destOffset, inp.homeOffset, inp.advRate, inp.delRate);
    stayDays = Math.floor((ret.departUTC - arriveUTC) / DAYMS);
    const pre2Natural = headStart(shift2.direction, shift2.daysNeeded, null);
    pre2 = Math.max(0, Math.min(pre2Natural, stayDays));
    tightStay = stayDays < pre2Natural || stayDays < daysNeeded;
    const retDepMid = Math.floor((ret.departUTC - (inp.retDelayMin || 0) * MSM + inp.destOffset * HR) / DAYMS) * DAYMS;
    const bedAnchor2 = retDepMid - pre2 * DAYMS + bed * MSM - inp.destOffset * HR;
    ep2 = buildEpisodes({ bedAnchorUTC: bedAnchor2, nEp: pre2 + shift2.daysNeeded + 2, direction: shift2.direction, total: shift2.total, rate: shift2.rate, sleepMs, chronoAdj });
  }
  const nEp1 = roundTrip
    ? Math.max(pre + daysNeeded + 1, Math.ceil((ep2[0].bedUTC - bedAnchor1) / DAYMS) + 2)
    : pre + Math.max(daysNeeded + 1, 1);
  let ep1 = buildEpisodes({ bedAnchorUTC: bedAnchor1, nEp: nEp1, direction, total, rate, sleepMs, chronoAdj });
  if (roundTrip) {
    ep1 = ep1.filter((e) => e.bedUTC < ep2[0].bedUTC);
    const lastE = ep1[ep1.length - 1];
    if (lastE && lastE.wakeUTC > ep2[0].bedUTC) {
      if (ep2[0].bedUTC - lastE.bedUTC < 45 * MSM) ep1.pop();
      else lastE.wakeUTC = ep2[0].bedUTC;
    }
  } else ep1 = ep1.slice(0, nEp1);
  const ep = ep1.concat(roundTrip ? ep2.slice(0, -1) : []);
  // the final episode of ep1 (one-way) or ep2 is a look-ahead only, used for awake spans
  const epAll = ep1.concat(ep2);

  const retDepartUTC = ret ? ret.departUTC : null, retArriveUTC = ret ? ret.arriveUTC : null;
  const legs = roundTrip ? out.legs.concat(ret.legs) : out.legs;
  const grounds = [out.ground, ret ? ret.ground : null].filter(Boolean);

  // ---- clock regimes: home until outbound landing, destination through the stay,
  // home again once the return lands. Every displayed time uses the regime in force
  // at that instant, which is what the clocks around you actually show. ----
  const regimes = [{ t: -Infinity, off: inp.homeOffset, name: homeName }, { t: arriveUTC, off: inp.destOffset, name: destName }];
  if (roundTrip) regimes.push({ t: retArriveUTC, off: inp.homeOffset, name: homeName });
  const zoneAt = (t) => { let r = regimes[0]; for (const x of regimes) if (t >= x.t) r = x; return r; };
  const sameZ = (a, b) => a.off === b.off && a.name === b.name;
  const fmtAt = (t) => clockAt(t, zoneAt(t).off);

  const days = [], events = [];
  for (let k = 0; k < ep.length; k++) {
    const e = ep[k];
    const awakeStart = k === 0 ? e.bedUTC - (DAYMS - sleepMs) : ep[k - 1].wakeUTC;
    const awakeEnd = e.bedUTC;
    const prevTmin = k === 0 ? e.tminUTC - DAYMS : ep[k - 1].tminUTC;
    const dir = e.direction, done = e.done;

    const morning = clipAbs([prevTmin, prevTmin + 4 * HR], awakeStart, awakeEnd) || [awakeStart, Math.min(awakeEnd, awakeStart + 3 * HR)];
    const evening = clipAbs([e.tminUTC - 6 * HR, e.tminUTC], awakeStart, awakeEnd) || [Math.max(awakeStart, awakeEnd - 4 * HR), awakeEnd];
    let seek = null, avoid = null;
    if (dir === "advance") { seek = morning; avoid = evening; }
    else if (dir === "delay") { seek = evening; avoid = morning; }
    const mela = inp.melatonin && dir !== "none" && !done ? e.bedUTC : null;
    const caff = inp.caffeine ? e.bedUTC - 8 * HR : null;

    events.push({ kind: "sleep", a: e.bedUTC, b: e.wakeUTC });
    if (seek) events.push({ kind: "seek", a: seek[0], b: seek[1] });
    if (avoid) events.push({ kind: "avoid", a: avoid[0], b: avoid[1] });
    const melaEv = mela != null ? { kind: "mela", t: mela } : null;
    if (melaEv) events.push(melaEv);
    if (caff != null) events.push({ kind: "caff", t: caff });

    const cardStart = awakeStart, cardEnd = e.wakeUTC;
    const cardZone = zoneAt((awakeStart + awakeEnd) / 2), endZone = zoneAt(cardEnd);
    const sfx = (t) => (sameZ(zoneAt(t), cardZone) ? null : zoneAt(t).name);
    // A range is written in one clock (the one at its start) so it never mixes zones.
    const rng = (w) => { const o = zoneAt(w[0]).off; return `${clockAt(w[0], o)}–${clockAt(w[1], o)}`; };
    const rows = [];
    for (const [a, b] of legs) {
      if (a >= cardStart && a < cardEnd) rows.push({ k: "flight", t: a, v: `${fmtAt(a)} ${zoneAt(a).name} → ${fmtAt(b)} ${zoneAt(b).name}`, z: null });
    }
    if (seek) rows.push({ k: "seek", t: seek[0], v: rng(seek), z: sfx(seek[0]) });
    if (avoid) rows.push({ k: "avoid", t: avoid[0], v: rng(avoid), z: sfx(avoid[0]) });
    if (caff != null) rows.push({ k: "caff", t: caff, v: `after ${fmtAt(caff)}`, z: sfx(caff) });
    if (mela != null) rows.push({ k: "mela", t: mela, v: `${fmtAt(mela)} at sleep onset`, z: sfx(mela) });
    rows.push({ k: "sleep", t: e.bedUTC, v: rng([e.bedUTC, e.wakeUTC]), z: sfx(e.bedUTC) });
    rows.sort((x, y) => x.t - y.t);
    const zoneChange = !sameZ(cardZone, endZone);
    const inCard = (t) => t != null && t >= cardStart && t < cardEnd;
    days.push({
      label: dateAt((awakeStart + awakeEnd) / 2, cardZone.off),
      zoneText: zoneChange ? `${cardZone.name} time → ${endZone.name} time` : `${cardZone.name} time`,
      zoneChange, done,
      isDepart: inCard(departUTC) || inCard(retDepartUTC),
      isArrive: inCard(arriveUTC) || inCard(retArriveUTC),
      planStartTag: k === 0, rows, dayNo: k + 1, _span: [cardStart, cardEnd], _zone: cardZone, _mela: melaEv,
    });
  }
  void epAll;

  // ---- forced-awake windows ----
  const holes = [];
  for (const [a, b] of legs) { holes.push([a, a + BUF * MSM]); holes.push([b - BUF * MSM, b]); }
  for (const g of grounds) { holes.push([g[0], g[0] + TRANSIT * MSM]); holes.push([g[1] - BOARD * MSM, g[1]]); }
  const sleepEvs = events.filter((e) => e.kind === "sleep");
  const otherEvs = events.filter((e) => e.kind !== "sleep");
  let frags = sleepEvs.map((e) => ({ ...e }));
  for (const h of holes) {
    const next = [];
    for (const b of frags) {
      if (h[1] <= b.a || h[0] >= b.b) { next.push(b); continue; }
      if (h[0] > b.a) next.push({ ...b, b: h[0] });
      if (h[1] < b.b) next.push({ ...b, a: h[1] });
    }
    frags = next;
  }
  const evs = otherEvs.concat(frags.filter((b) => b.b - b.a >= 45 * MSM));
  for (const h of holes) {
    evs.push({ kind: "meal", a: h[0], b: h[1] });
    for (const s of sleepEvs) {
      const a = Math.max(s.a, h[0]), b = Math.min(s.b, h[1]);
      if (b - a > 15 * MSM) evs.push({ kind: "avoid", a, b });
    }
  }
  // Cards print the sleep that actually survives the flight buffers, split if need be,
  // so they always match the timeline.
  const keptSleep = frags.filter((b) => b.b - b.a >= 45 * MSM);
  for (const d of days) {
    const [s0, s1] = d._span, cz = d._zone;
    d.rows = d.rows.filter((r) => r.k !== "sleep");
    for (const f of keptSleep) if (f.a >= s0 && f.a < s1) {
      const z = zoneAt(f.a);
      d.rows.push({ k: "sleep", t: f.a, v: `${clockAt(f.a, z.off)}–${clockAt(f.b, z.off)}`, z: sameZ(z, cz) ? null : z.name });
    }
    const first = d.rows.filter((r) => r.k === "sleep").sort((x, y) => x.t - y.t)[0];
    if (d._mela && first && first.t !== d._mela.t) {
      d._mela.t = first.t;
      const z = zoneAt(first.t);
      d.rows = d.rows.map((r) => r.k === "mela" ? { ...r, t: first.t, v: `${clockAt(first.t, z.off)} at sleep onset`, z: sameZ(z, cz) ? null : z.name } : r);
    }
    d.rows.sort((x, y) => x.t - y.t || (x.k === "mela" ? -1 : 1));
    delete d._span; delete d._zone; delete d._mela;
  }
  for (const [a, b] of legs) evs.push({ kind: "flight", a, b });
  evs.sort((x, y) => (x.a ?? x.t) - (y.a ?? y.t));

  const planStart = Math.min(...evs.map((e) => e.a ?? e.t));
  const planEnd = Math.max(...evs.map((e) => e.b ?? e.t));

  const legLabels = legs.map((_, i) => {
    if (!roundTrip && legs.length === 1) return { dep: "dep", arr: "arr" };
    const isRet = roundTrip && i >= out.legs.length;
    const li = isRet ? i - out.legs.length : i;
    const n = isRet ? ret.legs.length : out.legs.length;
    const pfx = roundTrip ? (isRet ? "Ret " : "Out ") : "";
    const sfx = n > 1 ? "L" + (li + 1) + " " : "";
    return { dep: pfx + sfx + "dep", arr: pfx + sfx + "arr" };
  });

  return {
    direction, total, daysNeeded, pre, crossover, days, events: evs, issues,
    departUTC, arriveUTC, legs, legLabels, grounds, missedConn: out.missedConn,
    roundTrip, retDepartUTC, retArriveUTC, retMissedConn: ret ? ret.missedConn : false,
    stayDays, tightStay, shift2, pre2, regimes, zoneAt, homeName, destName,
    planStart, planEnd, homeOff: inp.homeOffset, destOff: inp.destOffset,
  };
}

// ---------- timeline axis ----------
// Vertical position is time, except that a fixed-height header strip is inserted at
// every local midnight and at every clock change. Bars pass beneath the opaque strips,
// so day boundaries and zone switches are always readable.
const PXH = 26, HDR = 26, STEP = 15 * MSM;
function computeAxis(plan) {
  const heads = [], grid = [];
  const z0 = plan.zoneAt(plan.planStart);
  heads.push({ t: plan.planStart, off: z0.off, name: z0.name, kind: "start" });
  for (const r of plan.regimes.slice(1)) if (r.t > plan.planStart && r.t < plan.planEnd) heads.push({ t: r.t, off: r.off, name: r.name, kind: "change" });
  for (let t = Math.ceil(plan.planStart / STEP) * STEP; t <= plan.planEnd; t += STEP) {
    const z = plan.zoneAt(t);
    const m = mod(Math.round(t / MSM) + Math.round(z.off * 60), DAY);
    if (m === 0) { if (t > plan.planStart) heads.push({ t, off: z.off, name: z.name, kind: "day" }); }
    else if (m % 60 === 0) grid.push({ t, off: z.off, lab: m % 180 === 0 });
  }
  heads.sort((a, b) => a.t - b.t || (a.kind === "change" ? -1 : 1));
  const y = (t) => { let n = 0; for (const h of heads) { if (h.t <= t) n++; else break; } return ((t - plan.planStart) / HR) * PXH + n * HDR; };
  const headTop = (i) => ((heads[i].t - plan.planStart) / HR) * PXH + i * HDR;
  return { heads, grid, y, headTop, H: y(plan.planEnd) + 10 };
}

const META = {
  sleep: { l: "Sleep", c: "#a98bf0", I: Moon },
  seek: { l: "Seek bright light", c: "#f5b942", I: Sun },
  avoid: { l: "Avoid bright light", c: "#9aa3d4", I: EyeOff },
  meal: { l: "Stay awake: meals and cabin", c: "#e08a5a", I: Utensils },
  mela: { l: "Melatonin (0.5 mg) as sleep aid", c: "#5fb3f5", I: Pill },
  caff: { l: "Caffeine cutoff", c: "#c8a06a", I: Coffee },
  flight: { l: "In flight", c: "#5fb3f5", I: Plane },
};
const ROW = {
  flight: { l: "Flight", c: "#5fb3f5", I: Plane },
  sleep: { l: "Sleep", c: "#a98bf0", I: Moon },
  seek: { l: "Bright light", c: "#f5b942", I: Sun },
  avoid: { l: "Avoid light", c: "#9aa3d4", I: EyeOff },
  mela: { l: "Sleep aid", c: "#5fb3f5", I: Pill },
  caff: { l: "No caffeine", c: "#c8a06a", I: Coffee },
};

function statusAt(plan, now) {
  const z = plan.zoneAt(now);
  const inAir = plan.legs.some(([a, b]) => now >= a && now < b);
  const onGround = plan.grounds.some(([a, b]) => now >= a && now < b);
  const order = { meal: 0, sleep: 1, seek: 2, avoid: 3, flight: 4 };
  const cur = plan.events.filter((e) => e.a != null && e.a <= now && now < e.b).sort((x, y) => order[x.kind] - order[y.kind]);
  const primary = cur[0] || null;
  const melaDue = plan.events.find((e) => e.kind === "mela" && e.t >= now - 15 * MSM && e.t <= now + 20 * MSM) || null;
  const next = plan.events.filter((e) => (e.a ?? e.t) > now).sort((x, y) => (x.a ?? x.t) - (y.a ?? y.t))[0] || null;
  return { off: z.off, zoneName: z.name, where: inAir ? "In flight" : onGround ? "Stopover" : "", inTransit: inAir || onGround, primary, melaDue, next };
}

// ---------- UI bits ----------
const C = { ink: "#0b1026", panel: "#141a36", panel2: "#1c2444", line: "#2a3360", text: "#e8ebff", dim: "#9aa3d4", amber: "#f5b942", sky: "#5fb3f5", violet: "#a98bf0", green: "#5fd6a0" };
const inputStyle = { width: "100%", boxSizing: "border-box", background: C.ink, color: C.text, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 11px", fontSize: 14, outline: "none" };

function Field({ label, children }) {
  return (<label style={{ display: "block" }}><div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: C.dim, marginBottom: 6 }}>{label}</div>{children}</label>);
}

function ZonePicker({ value, onPick, dateYmd }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    return ZONES.filter((z) => !s || (z.toLowerCase() + " " + (ALIAS[z] || "")).includes(s)).slice(0, 60);
  }, [q]);
  const curOff = value ? zoneOffsetForDate(value, dateYmd) : null;
  return (
    <div style={{ position: "relative" }}>
      <button type="button" onClick={() => { setOpen((o) => !o); setQ(""); }} style={{ ...inputStyle, textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
        <span style={{ color: value ? C.text : C.dim }}>{value ? zoneLabel(value) : "Choose a city"}</span>
        <span style={{ color: C.dim, fontSize: 12, flexShrink: 0 }}>{fmtOff(curOff)}</span>
      </button>
      {open && (
        <div style={{ position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, right: 0, minWidth: 220, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,.5)", overflow: "hidden" }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a city, e.g. Melbourne, Tokyo" style={{ ...inputStyle, borderRadius: 0, borderWidth: "0 0 1px 0" }} />
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {results.map((z) => {
              const on = z === value;
              return (
                <button type="button" key={z} onClick={() => { onPick(z); setOpen(false); }} style={{ width: "100%", textAlign: "left", padding: "9px 11px", cursor: "pointer", border: "none", borderBottom: `1px solid ${C.line}`, background: on ? `${C.sky}22` : "transparent", color: on ? C.sky : C.text, fontSize: 13, display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{zoneLabel(z)}</span>
                  <span style={{ color: C.dim, flexShrink: 0 }}>{fmtOff(zoneOffsetForDate(z, dateYmd))}</span>
                </button>
              );
            })}
            {results.length === 0 && <div style={{ padding: 12, color: C.dim, fontSize: 12.5 }}>No match. You can still type a raw offset in the override field.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Collapsible control group whose header carries a summary of its state.
function Section({ title, summary, alert, open, onToggle, children }) {
  return (
    <div style={{ border: `1px solid ${alert ? C.amber : C.line}`, borderRadius: 12, background: C.panel }}>
      <button type="button" onClick={onToggle} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "11px 12px", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
        <span style={{ color: C.dim, display: "flex", flexShrink: 0 }}>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
        <span style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: C.dim, flexShrink: 0 }}>{title}</span>
        {!open && <span style={{ marginLeft: "auto", fontSize: 12, color: alert ? C.amber : C.text, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", paddingLeft: 8 }}>{alert ? "Check dates · " : ""}{summary}</span>}
      </button>
      {open && <div style={{ padding: "0 12px 13px", display: "grid", gap: 13 }}>{children}</div>}
    </div>
  );
}

function Chip({ icon, color, label, value, zone }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0" }}>
      <span style={{ color, display: "flex", paddingTop: 1 }}>{icon}</span>
      <span style={{ color: C.dim, fontSize: 12, width: 86, flexShrink: 0 }}>{label}</span>
      <span style={{ color: C.text, fontSize: 13, fontWeight: 600 }}>{value}{zone && <span style={{ color: C.green, fontWeight: 500, fontSize: 11, marginLeft: 6 }}>{zone}</span>}</span>
    </div>
  );
}
function DayCard({ d }) {
  const tags = [];
  if (d.planStartTag) tags.push({ t: "Plan starts", c: C.amber });
  if (d.isDepart) tags.push({ t: "Departure", c: C.sky });
  if (d.isArrive) tags.push({ t: "Arrival", c: C.violet });
  if (d.done && !d.isDepart && !d.isArrive) tags.push({ t: "Adapted", c: C.green });
  return (
    <div style={{ background: C.panel, border: `1px solid ${d.zoneChange ? C.green + "88" : C.line}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontWeight: 700, color: C.text, fontSize: 14, whiteSpace: "nowrap" }}>{d.label}<span style={{ color: C.dim, fontWeight: 400, fontSize: 11.5, marginLeft: 7 }}>Day {d.dayNo}</span></div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {tags.map((x, i) => <span key={i} style={{ fontSize: 10, fontWeight: 700, color: x.c, border: `1px solid ${x.c}55`, borderRadius: 99, padding: "2px 8px" }}>{x.t}</span>)}
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: d.zoneChange ? C.green : C.dim, margin: "3px 0 6px", display: "flex", alignItems: "center", gap: 5 }}><Clock size={11} />{d.zoneText}</div>
      {d.rows.map((r, i) => { const m = ROW[r.k]; return <Chip key={i} icon={<m.I size={15} />} color={m.c} label={m.l} value={r.v} zone={r.z} />; })}
    </div>
  );
}

const GUT = 46, LW = 52, LG = 9;
const lx = (i) => GUT + i * (LW + LG);

function Timeline({ plan, now }) {
  const box = useRef(null);
  const ax = useMemo(() => computeAxis(plan), [plan]);
  const { heads, grid, y, headTop, H } = ax;
  const offAt = (t) => plan.zoneAt(t).off;
  const jump = () => { const el = box.current; if (el) el.scrollTop = Math.max(0, y(now) - el.clientHeight / 2.5); };
  useEffect(() => { jump(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sleeps = plan.events.filter((e) => e.kind === "sleep").sort((a, b) => a.a - b.a);
  const bars = [];
  for (const e of plan.events) {
    if (e.kind === "sleep") bars.push({ lane: 0, a: e.a, b: e.b, c: C.violet, out: false, I: Moon });
    if (e.kind === "seek") bars.push({ lane: 1, a: e.a, b: e.b, c: C.amber, out: false, I: Sun });
    if (e.kind === "avoid") bars.push({ lane: 1, a: e.a, b: e.b, c: "#9aa3d4", out: true, I: EyeOff });
  }
  // caffeine: filled from waking to the cutoff, outlined from the cutoff to sleep
  for (const e of plan.events.filter((x) => x.kind === "caff")) {
    const prev = [...sleeps].reverse().find((s) => s.b <= e.t);
    const next = sleeps.find((s) => s.a >= e.t);
    if (prev) bars.push({ lane: 2, a: prev.b, b: e.t, c: "#c8a06a", out: false, I: Coffee });
    if (next) bars.push({ lane: 2, a: e.t, b: next.a, c: "#c8a06a", out: true, I: Coffee });
  }

  return (
    <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 16, overflow: "hidden" }}>
      <div style={{ position: "relative", height: 36, borderBottom: `1px solid ${C.line}` }}>
        {[["Sleep", C.violet], ["Light", C.amber], ["Caffeine", "#c8a06a"]].map(([l, c], i) => (
          <span key={l} style={{ position: "absolute", left: lx(i) - 6, width: LW + 12, top: 12, textAlign: "center", fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase", color: c }}>{l}</span>
        ))}
        <button type="button" onClick={jump} style={{ position: "absolute", right: 10, top: 6, fontSize: 11, padding: "4px 10px", borderRadius: 7, cursor: "pointer", border: `1px solid ${C.sky}`, background: `${C.sky}22`, color: C.sky }}>Now</button>
      </div>
      <div ref={box} style={{ maxHeight: "62vh", overflowY: "auto", overflowX: "hidden" }}>
        <div style={{ position: "relative", height: H }}>
          {grid.map((g, i) => (
            <div key={"g" + i}>
              <div style={{ position: "absolute", top: y(g.t), left: GUT - 6, right: 0, height: 1, background: g.lab ? "rgba(154,163,212,.16)" : "rgba(154,163,212,.07)" }} />
              {g.lab && <div style={{ position: "absolute", top: y(g.t) - 7, left: 0, width: GUT - 10, textAlign: "right", fontSize: 10, color: C.dim }}>{clockAt(g.t, g.off)}</div>}
            </div>
          ))}

          {bars.map((b, i) => {
            const top = y(b.a), h = Math.max(3, y(b.b) - y(b.a));
            return (
              <div key={"b" + i} style={{ position: "absolute", zIndex: 1, top, height: h, left: lx(b.lane), width: LW, borderRadius: 9, boxSizing: "border-box", background: b.out ? "transparent" : b.c, border: b.out ? `1.5px dashed ${b.c}` : "none", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 3, gap: 2, overflow: "hidden" }}>
                {h > 26 && <b.I size={13} color={b.out ? b.c : C.ink} />}
                {h > 42 && <span style={{ fontSize: 9.5, fontWeight: 700, color: b.out ? b.c : C.ink }}>{clockAt(b.a, offAt(b.a))}</span>}
              </div>
            );
          })}
          {plan.events.filter((e) => e.kind === "mela").map((e, i) => (
            <div key={"m" + i} style={{ position: "absolute", zIndex: 2, top: y(e.t) - 6, left: lx(0) + LW - 7, width: 14, height: 14, borderRadius: 7, background: C.sky, border: `2px solid ${C.panel2}` }} />
          ))}
          {plan.events.filter((e) => e.kind === "meal").map((e, i) => (
            <div key={"f" + i} style={{ position: "absolute", zIndex: 2, top: y(e.a), height: Math.max(3, y(e.b) - y(e.a)), left: lx(0) - 7, width: 5, borderRadius: 3, background: "#e08a5a" }} />
          ))}

          {plan.legs.map(([a, b], i) => (
            <div key={"lg" + i}>
              <div style={{ position: "absolute", zIndex: 2, top: y(a), height: Math.max(2, y(b) - y(a)), left: lx(3) + 8, width: 3, background: C.sky, borderRadius: 2 }} />
              <div style={{ position: "absolute", zIndex: 2, top: y(a) + 2, left: lx(3) + 15, fontSize: 9.5, color: C.sky, whiteSpace: "nowrap" }}>▲ {plan.legLabels[i].dep} {clockAt(a, offAt(a))}</div>
              <div style={{ position: "absolute", zIndex: 2, top: y(b) - 14, left: lx(3) + 15, fontSize: 9.5, color: C.sky, whiteSpace: "nowrap" }}>▼ {plan.legLabels[i].arr} {clockAt(b, offAt(b))}</div>
            </div>
          ))}
          {plan.grounds.map((g, i) => (
            <div key={"gr" + i} style={{ position: "absolute", zIndex: 2, top: y(g[0]), height: Math.max(2, y(g[1]) - y(g[0])), left: lx(3) + 9, width: 1, borderLeft: `1px dashed ${C.dim}` }} />
          ))}

          {heads.map((h, i) => (
            <div key={"h" + i} style={{ position: "absolute", zIndex: 3, top: headTop(i), left: 0, right: 0, height: HDR, boxSizing: "border-box", background: h.kind === "change" ? "#12332e" : C.panel, borderTop: `1px solid ${h.kind === "change" ? C.green : C.line}`, borderBottom: `1px solid ${h.kind === "change" ? C.green : C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px", gap: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: C.text, whiteSpace: "nowrap" }}>{dateAt(h.t, h.off)}{h.kind === "change" ? ` · ${clockAt(h.t, h.off)}` : ""}</span>
              <span style={{ fontSize: 10.5, color: h.kind === "change" ? C.green : C.dim, display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}><Clock size={10} />{h.kind === "change" ? `Clocks now ${h.name} time` : `${h.name} time`}</span>
            </div>
          ))}

          <div style={{ position: "absolute", zIndex: 5, top: y(now), left: 4, right: 0, height: 0, borderTop: `2px solid ${C.text}` }} />
          <div style={{ position: "absolute", zIndex: 5, top: y(now) - 5, left: GUT - 16, width: 10, height: 10, borderRadius: 5, background: C.text }} />
        </div>
      </div>
    </div>
  );
}

export default function CircadianShift() {
  // Hash wins over storage so a backup link always restores what it encodes.
  const [inp, setInp] = useState(() => ({ ...DEFAULTS, ...(loadHash() || loadSaved() || {}) }));
  const [saved, setSaved] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {} }, []);
  useEffect(() => {
    setSaved(saveSetup(inp));
    try { history.replaceState(null, "", "#" + b64.enc(inp)); } catch {}
  }, [inp]);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); }
  };
  const set = (k, v) => setInp((s) => ({ ...s, [k]: v }));
  const pickZone = (which, z) => setInp((s) => {
    const [zk, ok, dk] = ZK[which];
    const o = zoneOffsetForDate(z, String(s[dk] || s.depart).split("T")[0]);
    return { ...s, [zk]: z, ...(o != null ? { [ok]: o } : {}) };
  });
  useEffect(() => {
    setInp((s) => {
      const patch = {};
      for (const k of ["home", "dest", "stop", "retStop"]) {
        const [zk, ok, dk] = ZK[k];
        if (!s[zk] || !s[dk]) continue;
        const o = zoneOffsetForDate(s[zk], String(s[dk]).split("T")[0]);
        if (o != null && o !== s[ok]) patch[ok] = o;
      }
      return Object.keys(patch).length ? { ...s, ...patch } : s;
    });
  }, [inp.depart, inp.arrive, inp.stopArrive, inp.stopDepart, inp.retStopArrive, inp.homeZone, inp.destZone, inp.stopZone, inp.retStopZone]);
  // Ticking round trip seeds return times relative to the outbound trip when the stored
  // ones are unusable, so a stale default can never sit there unnoticed.
  const toggleRound = (on) => setInp((s) => {
    const n = { ...s, roundTrip: on };
    if (!on) return n;
    const depU = parseUTC(s.depart, s.homeOffset), arrU = parseUTC(s.arrive, s.destOffset);
    const rdU = parseUTC(s.retDepart, s.destOffset), raU = parseUTC(s.retArrive, s.homeOffset);
    if (Number.isFinite(depU) && Number.isFinite(arrU) && !(rdU > arrU && raU > rdU)) {
      const d = new Date(arrU + s.destOffset * HR + 7 * DAYMS);
      n.retDepart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T21:00`;
      const rd2 = parseUTC(n.retDepart, s.destOffset);
      n.retArrive = toLocalStr(rd2 + Math.max(arrU - depU, 2 * HR), s.homeOffset);
      n.retStopArrive = toLocalStr(rd2 + 7 * HR, s.retStopOffset);
      n.retStopDepart = toLocalStr(rd2 + 10 * HR, s.retStopOffset);
    }
    return n;
  });

  const plan = useMemo(() => buildPlan(inp), [inp]);

  const [mode, setMode] = useState("sim");
  const [simMs, setSimMs] = useState(null);
  const [liveNow, setLiveNow] = useState(Date.now());
  useEffect(() => { if (mode !== "live") return; setLiveNow(Date.now()); const id = setInterval(() => setLiveNow(Date.now()), 30000); return () => clearInterval(id); }, [mode]);

  const now = mode === "live" ? liveNow : clamp(simMs ?? plan.departUTC, plan.planStart, plan.planEnd);
  const st = statusAt(plan, now);
  const before = mode === "live" && liveNow < plan.planStart;
  const after = mode === "live" && liveNow > plan.planEnd;

  const [showNotes, setShowNotes] = useState(false);
  const [view, setView] = useState("timeline");
  const [sec, setSec] = useState({ trip: false, ret: false, sleep: false, model: false });
  const tog = (k) => setSec((s) => ({ ...s, [k]: !s[k] }));
  const [narrow, setNarrow] = useState(typeof window !== "undefined" && window.innerWidth < 760);
  useEffect(() => { const on = () => setNarrow(window.innerWidth < 760); window.addEventListener("resize", on); return () => window.removeEventListener("resize", on); }, []);

  const dirWord = (d) => ({ advance: "Advance", delay: "Delay", none: "No shift" }[d]);
  const dirText = { advance: "ADVANCE (clock earlier)", delay: "DELAY (clock later)", none: "No shift" }[plan.direction];
  const Icon = st.primary ? META[st.primary.kind].I : Clock;
  const tripAlert = plan.issues.some((x) => x.where === "trip"), retAlert = plan.issues.some((x) => x.where === "ret");
  const jumps = [["Start", plan.planStart], ["Dep", plan.departUTC], ["Arr", plan.arriveUTC]];
  if (plan.roundTrip) jumps.push(["Ret dep", plan.retDepartUTC], ["Ret arr", plan.retArriveUTC]);
  const stat = (label, value, color) => (<div><div style={{ fontSize: 11, color: C.dim, textTransform: "uppercase" }}>{label}</div><div style={{ fontSize: 15, fontWeight: 700, color: color || C.text }}>{value}</div></div>);
  const homeCity = plan.homeName, destCity = plan.destName;

  return (
    <div style={{ minHeight: "100vh", background: `radial-gradient(1200px 600px at 80% -10%, #1b2350 0%, ${C.ink} 55%)`, color: C.text, fontFamily: "ui-sans-serif, system-ui, sans-serif", padding: "26px 16px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 2 }}>
          <Sun size={20} color={C.amber} /><Moon size={20} color={C.violet} style={{ marginLeft: -6 }} />
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: 27, margin: 0, letterSpacing: -0.5 }}>CircadianShift</h1>
        </div>
        <p style={{ color: C.dim, fontSize: 12.5, marginTop: 0, marginBottom: 18 }}>Now and up next, a timezone-aware timeline, and in-flight buffers.</p>

        {plan.issues.length > 0 && (
          <div style={{ border: `1px solid ${C.amber}`, background: `${C.amber}14`, borderRadius: 12, padding: "10px 12px", marginBottom: 14, display: "grid", gap: 6 }}>
            {plan.issues.map((x, i) => <div key={i} style={{ display: "flex", gap: 8, fontSize: 12.5, color: C.amber }}><AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />{x.msg}</div>)}
          </div>
        )}

        {/* ---------- NOW panel ---------- */}
        <div style={{ background: "linear-gradient(135deg, #232c5a, #161d3c)", border: `1px solid ${C.line}`, borderRadius: 18, padding: 18, marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
            <span style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: C.dim }}>Right now</span>
            <span style={{ fontSize: 12, color: C.dim, display: "flex", alignItems: "center", gap: 6, textAlign: "right" }}>
              {st.inTransit && <Plane size={13} color={C.sky} />}{st.where ? `${st.where} · ` : ""}{clockAt(now, st.off)} {st.zoneName} time
            </span>
          </div>
          {before ? (
            <div style={{ fontSize: 18, fontWeight: 700 }}>Plan starts {dateClockAt(plan.planStart, plan.homeOff)} <span style={{ color: C.dim, fontWeight: 400, fontSize: 14 }}>· in {dur(plan.planStart - liveNow)}</span></div>
          ) : after ? (
            <div style={{ fontSize: 18, fontWeight: 700, color: C.green }}>Adapted. Plan complete.</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ color: st.primary ? META[st.primary.kind].c : C.dim, display: "flex" }}><Icon size={30} /></span>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: st.primary ? META[st.primary.kind].c : C.text }}>{st.primary ? META[st.primary.kind].l : "Free, no active cue"}</div>
                  {st.primary && <div style={{ fontSize: 12.5, color: C.dim }}>until {clockAt(st.primary.b, plan.zoneAt(st.primary.b).off)} · {dur(st.primary.b - now)} left</div>}
                </div>
              </div>
              {st.melaDue && <div style={{ marginTop: 8, fontSize: 13, color: C.sky, display: "flex", alignItems: "center", gap: 6 }}><Pill size={14} /> Melatonin (0.5 mg) now, as a sleep aid</div>}
              {st.next && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}`, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.dim }}>Up next</span>
                  <span style={{ color: META[st.next.kind].c, display: "flex" }}>{React.createElement(META[st.next.kind].I, { size: 16 })}</span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{st.next.kind === "flight" ? "Flight departs" : META[st.next.kind].l}</span>
                  <span style={{ fontSize: 12.5, color: C.dim }}>at {clockAt(st.next.a ?? st.next.t, plan.zoneAt(st.next.a ?? st.next.t).off)} · in {dur((st.next.a ?? st.next.t) - now)}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* ---------- time control ---------- */}
        <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 14, padding: 14, marginBottom: 18 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: mode === "sim" ? 12 : 0 }}>
            {[["sim", "Simulate", Clock], ["live", "Live", Radio]].map(([m, lab, Ic]) => (
              <button type="button" key={m} onClick={() => setMode(m)} style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", gap: 6, padding: "8px 0", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", border: `1px solid ${mode === m ? C.sky : C.line}`, background: mode === m ? `${C.sky}22` : C.ink, color: mode === m ? C.sky : C.dim }}>
                <Ic size={14} />{lab}
              </button>
            ))}
          </div>
          {mode === "sim" && (
            <>
              <input type="range" min={plan.planStart} max={plan.planEnd} step={300000} value={now} onChange={(e) => setSimMs(+e.target.value)} style={{ width: "100%", accentColor: C.sky }} />
              <div style={{ fontSize: 12.5, color: C.text, fontWeight: 600, margin: "6px 0 8px" }}>{dateClockAt(now, st.off)} {st.zoneName} time{st.where ? ` (${st.where.toLowerCase()})` : ""}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {jumps.map(([lab, v]) => (
                  <button type="button" key={lab} onClick={() => setSimMs(v)} style={{ fontSize: 11, padding: "4px 9px", borderRadius: 7, cursor: "pointer", border: `1px solid ${C.line}`, background: C.ink, color: C.dim }}>{lab}</button>
                ))}
              </div>
            </>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(280px, 360px) 1fr", gap: narrow ? 14 : 20, alignItems: "start" }}>
          {/* controls */}
          <div style={{ display: "grid", gap: 9 }}>
            <Section title="Trip" open={sec.trip} onToggle={() => tog("trip")} alert={tripAlert}
              summary={`${homeCity} → ${inp.hasStop ? cityOf(inp.stopZone, inp.stopOffset) + " → " : ""}${destCity} · ${dateAt(plan.departUTC, inp.homeOffset)}`}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Home city"><ZonePicker value={inp.homeZone} dateYmd={String(inp.depart).split("T")[0]} onPick={(z) => pickZone("home", z)} /></Field>
                <Field label="Destination city"><ZonePicker value={inp.destZone} dateYmd={String(inp.arrive).split("T")[0]} onPick={(z) => pickZone("dest", z)} /></Field>
              </div>
              <Field label={`Departure (${homeCity} time)`}><input type="datetime-local" style={inputStyle} value={inp.depart} onChange={(e) => set("depart", e.target.value)} /></Field>
              <Field label={`Arrival (${destCity} time)`}><input type="datetime-local" style={inputStyle} value={inp.arrive} onChange={(e) => set("arrive", e.target.value)} /></Field>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={inp.hasStop} onChange={(e) => set("hasStop", e.target.checked)} /><span style={{ color: C.sky }}>One stopover</span>
              </label>
              {inp.hasStop && (
                <>
                  <Field label="Stopover city"><ZonePicker value={inp.stopZone} dateYmd={String(inp.stopArrive || inp.depart).split("T")[0]} onPick={(z) => pickZone("stop", z)} /></Field>
                  <Field label="Leg 1 arrival (stopover time)"><input type="datetime-local" style={inputStyle} value={inp.stopArrive} onChange={(e) => set("stopArrive", e.target.value)} /></Field>
                  <Field label="Leg 2 departure (stopover time)"><input type="datetime-local" style={inputStyle} value={inp.stopDepart} onChange={(e) => set("stopDepart", e.target.value)} /></Field>
                </>
              )}
              <details>
                <summary style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: C.dim, cursor: "pointer" }}>Manual UTC override</summary>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
                  <Field label="Home UTC"><input type="number" step="0.25" style={inputStyle} value={inp.homeOffset} onChange={(e) => setInp((s) => ({ ...s, homeOffset: parseFloat(e.target.value) || 0, homeZone: null }))} /></Field>
                  <Field label="Dest UTC"><input type="number" step="0.25" style={inputStyle} value={inp.destOffset} onChange={(e) => setInp((s) => ({ ...s, destOffset: parseFloat(e.target.value) || 0, destZone: null }))} /></Field>
                </div>
              </details>
            </Section>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", padding: "0 2px" }}>
              <input type="checkbox" checked={inp.roundTrip} onChange={(e) => toggleRound(e.target.checked)} /><span style={{ color: C.violet }}>Round trip: plan the flight home too</span>
            </label>

            {inp.roundTrip && (
              <Section title="Return" open={sec.ret} onToggle={() => tog("ret")} alert={retAlert}
                summary={`${destCity} → ${inp.retHasStop ? cityOf(inp.retStopZone, inp.retStopOffset) + " → " : ""}${homeCity} · ${Number.isFinite(parseUTC(inp.retDepart, inp.destOffset)) ? dateAt(parseUTC(inp.retDepart, inp.destOffset), inp.destOffset) : "no date"}`}>
                <Field label={`Departure (${destCity} time)`}><input type="datetime-local" style={inputStyle} value={inp.retDepart} onChange={(e) => set("retDepart", e.target.value)} /></Field>
                <Field label={`Arrival (${homeCity} time)`}><input type="datetime-local" style={inputStyle} value={inp.retArrive} onChange={(e) => set("retArrive", e.target.value)} /></Field>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={inp.retHasStop} onChange={(e) => set("retHasStop", e.target.checked)} /><span style={{ color: C.sky }}>One stopover</span>
                </label>
                {inp.retHasStop && (
                  <>
                    <Field label="Stopover city"><ZonePicker value={inp.retStopZone} dateYmd={String(inp.retStopArrive || inp.retDepart).split("T")[0]} onPick={(z) => pickZone("retStop", z)} /></Field>
                    <Field label="Leg 1 arrival (stopover time)"><input type="datetime-local" style={inputStyle} value={inp.retStopArrive} onChange={(e) => set("retStopArrive", e.target.value)} /></Field>
                    <Field label="Leg 2 departure (stopover time)"><input type="datetime-local" style={inputStyle} value={inp.retStopDepart} onChange={(e) => set("retStopDepart", e.target.value)} /></Field>
                  </>
                )}
              </Section>
            )}

            <Section title="Sleep" open={sec.sleep} onToggle={() => tog("sleep")} summary={`${inp.bed}–${inp.wake} · ${inp.chrono}`}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <Field label="Bedtime"><input type="time" style={inputStyle} value={inp.bed} onChange={(e) => set("bed", e.target.value)} /></Field>
                <Field label="Wake"><input type="time" style={inputStyle} value={inp.wake} onChange={(e) => set("wake", e.target.value)} /></Field>
              </div>
              <Field label="Chronotype">
                <div style={{ display: "flex", gap: 6 }}>
                  {["early", "intermediate", "late"].map((c) => <button type="button" key={c} onClick={() => set("chrono", c)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, fontWeight: 600, textTransform: "capitalize", cursor: "pointer", border: `1px solid ${inp.chrono === c ? C.amber : C.line}`, background: inp.chrono === c ? `${C.amber}22` : C.ink, color: inp.chrono === c ? C.amber : C.dim }}>{c}</button>)}
                </div>
              </Field>
              <div style={{ display: "flex", gap: 18 }}>
                {[["melatonin", "Sleep aid", C.sky], ["caffeine", "Caffeine", "#c8a06a"]].map(([k, lab, col]) => (
                  <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}><input type="checkbox" checked={inp[k]} onChange={(e) => set(k, e.target.checked)} /><span style={{ color: col }}>{lab}</span></label>
                ))}
              </div>
            </Section>

            <Section title="Model" open={sec.model} onToggle={() => tog("model")} summary={`adv ${inp.advRate.toFixed(1)} · del ${inp.delRate.toFixed(1)} h/day`}>
              <Field label="Compliance (sets both rates)">
                <div style={{ display: "flex", gap: 6 }}>
                  {[["Home", 1.8, 1.5], ["Typical", 1.3, 1.3], ["Constrained", 1.0, 1.0]].map(([lab, a, d]) => {
                    const on = inp.advRate === a && inp.delRate === d;
                    return <button type="button" key={lab} onClick={() => setInp((s) => ({ ...s, advRate: a, delRate: d }))} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 11.5, fontWeight: 600, cursor: "pointer", border: `1px solid ${on ? C.green : C.line}`, background: on ? `${C.green}22` : C.ink, color: on ? C.green : C.dim }}>{lab}</button>;
                  })}
                </div>
              </Field>
              <Field label={`Advance rate: ${inp.advRate.toFixed(1)} h/day · crossover ${plan.crossover.toFixed(1)} h E`}>
                <input type="range" min={1.0} max={2.0} step={0.1} value={inp.advRate} onChange={(e) => set("advRate", +e.target.value)} style={{ width: "100%", accentColor: C.violet }} />
              </Field>
              <Field label={`Delay rate: ${inp.delRate.toFixed(1)} h/day`}>
                <input type="range" min={1.0} max={1.8} step={0.1} value={inp.delRate} onChange={(e) => set("delRate", +e.target.value)} style={{ width: "100%", accentColor: C.violet }} />
              </Field>
            </Section>

            {/* Delays stay outside the collapsible sections: they are the inputs you change at a gate. */}
            <div style={{ border: `1px solid ${inp.delayMin || inp.retDelayMin ? C.amber : C.line}`, borderRadius: 12, background: C.panel, padding: "10px 12px", display: "grid", gap: 10 }}>
              <Field label={`${plan.roundTrip ? "Outbound flight" : "Flight"} delay: ${inp.delayMin} min`}>
                <input type="range" min={0} max={480} step={15} value={inp.delayMin} onChange={(e) => set("delayMin", +e.target.value)} style={{ width: "100%", accentColor: C.amber }} />
              </Field>
              {plan.roundTrip && (
                <Field label={`Return flight delay: ${inp.retDelayMin} min`}>
                  <input type="range" min={0} max={480} step={15} value={inp.retDelayMin} onChange={(e) => set("retDelayMin", +e.target.value)} style={{ width: "100%", accentColor: C.amber }} />
                </Field>
              )}
            </div>

            <div style={{ border: `1px solid ${saved === false ? C.amber : C.line}`, borderRadius: 12, background: C.panel, padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: saved ? C.green : saved === false ? C.amber : C.dim, flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, color: saved === false ? C.amber : C.dim }}>{saved ? "Setup saved on this device" : saved === false ? "Could not save, use the link" : "Checking storage"}</span>
              <button type="button" onClick={copyLink} style={{ marginLeft: "auto", fontSize: 11, padding: "5px 10px", borderRadius: 7, cursor: "pointer", whiteSpace: "nowrap", border: `1px solid ${copied ? C.green : C.line}`, background: copied ? `${C.green}22` : C.ink, color: copied ? C.green : C.dim }}>{copied ? "Copied" : "Copy backup link"}</button>
            </div>
          </div>

          {/* output */}
          <div>
            <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 16, padding: 16, marginBottom: 14, display: "flex", flexWrap: "wrap", gap: 22 }}>
              {stat(plan.roundTrip ? "Outbound" : "Strategy", dirText, plan.direction === "advance" ? C.amber : plan.direction === "delay" ? C.violet : C.green)}
              {stat("Net shift", `${(plan.total / 60).toFixed(1)} h`)}
              {stat("Days", plan.daysNeeded)}
              {stat("Head start", `${plan.pre}d`)}
              {plan.roundTrip && stat("Return", `${dirWord(plan.shift2.direction)} ${(plan.shift2.total / 60).toFixed(1)} h`, plan.shift2.direction === "advance" ? C.amber : C.violet)}
              {plan.roundTrip && stat("Stay", `${plan.stayDays}d${plan.tightStay ? " · tight" : ""}`, plan.tightStay ? C.amber : C.text)}
              {plan.grounds[0] && stat("Ground", plan.missedConn ? "delay > connection" : dur(plan.grounds[0][1] - plan.grounds[0][0]), plan.missedConn ? C.amber : C.text)}
              {plan.grounds[1] && stat("Return ground", plan.retMissedConn ? "delay > connection" : dur(plan.grounds[1][1] - plan.grounds[1][0]), plan.retMissedConn ? C.amber : C.text)}
              {stat("E/W crossover", `${plan.crossover.toFixed(1)} h E`)}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {[["timeline", "Timeline"], ["cards", "Cards"]].map(([v, lab]) => (
                <button type="button" key={v} onClick={() => setView(v)} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: "pointer", border: `1px solid ${view === v ? C.sky : C.line}`, background: view === v ? `${C.sky}22` : C.ink, color: view === v ? C.sky : C.dim }}>{lab}</button>
              ))}
            </div>
            {view === "timeline" ? <Timeline plan={plan} now={now} /> : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 11 }}>
                {plan.days.map((d, i) => <DayCard key={i} d={d} />)}
              </div>
            )}

            <div style={{ marginTop: 14, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14 }}>
              <button type="button" onClick={() => setShowNotes((s) => !s)} style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", color: C.text, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                {showNotes ? <ChevronUp size={16} /> : <ChevronDown size={16} />} Notes and assumptions
              </button>
              {showNotes && (
                <div style={{ color: C.dim, fontSize: 12.5, lineHeight: 1.65, marginTop: 10 }}>
                  <p style={{ marginTop: 0 }}><b style={{ color: C.text }}>Clocks.</b> Every time is shown in the clock in force at that moment: home until the outbound flight lands, destination through the stay, home again once the return lands. The timeline inserts a header at every local midnight and a green header where the clocks change. A card that spans a landing says so, and any row in the other zone carries that city's name.</p>
                  <p><b style={{ color: C.text }}>Checks.</b> Arrivals before departures, a return that leaves before you land, or journeys over 40 hours raise a warning at the top. An invalid return leg is ignored rather than allowed to corrupt the clock timeline.</p>
                  <p><b style={{ color: C.text }}>Round trips.</b> The return is a second, independent adaptation with its own direction and head start. The head start is capped by the full days spent at the destination. Between the two, the plan is ordinary steady sleep at destination time.</p>
                  <p><b style={{ color: C.text }}>Flights and stopovers.</b> No sleep in the first or last {BUF} minutes of each flight, or during transit and boarding at a stopover. Sleep is split around every such window, fragments under 45 minutes are dropped, and where a window eats into biological night a darkness cue is added.</p>
                  <p><b style={{ color: C.text }}>Light and sleep aid.</b> Tmin sits 2 h before wake, adjusted by chronotype. Light after Tmin advances, before Tmin delays, and light windows are clipped to waking hours. Melatonin is shown as a sleep aid only, since evening melatonin phase-advances and would oppose a delay.</p>
                  <p style={{ marginBottom: 0 }}><b style={{ color: C.text }}>Rates.</b> Advance and delay rates are tunable. The E/W crossover is 24·a/(d+a): below it an eastward trip advances, above it the model delays the long way round.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
