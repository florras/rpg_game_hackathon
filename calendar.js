// Calendar sync: reads iCal (.ics) feeds such as a Canvas "Calendar Feed" link or a
// Google Calendar "Secret address in iCal format", and turns them into simple events.
// The browser can't fetch these links itself (CORS), so the server does it safely.
const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const DAY = 864e5;
const cache = new Map(); // url -> { at, events }

function fail(code, status) { const e = new Error(code); e.code = code; e.status = status || 400; return e; }

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')) return true;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? privateIp(m[1]) : false;
}

// Only public https hosts: blocks the server from being used to reach internal addresses.
async function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim().replace(/^webcal:\/\//i, 'https://')); } catch (e) { throw fail('bad_url'); }
  if (u.protocol !== 'https:') throw fail('https_only');
  if (u.username || u.password || (u.port && u.port !== '443') || net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw fail('bad_url');
  let addrs = [];
  try { addrs = await dns.lookup(u.hostname, { all: true }); } catch (e) { throw fail('not_found'); }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw fail('blocked_host');
  return u;
}

async function download(raw) {
  let u = await safeUrl(raw);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Questlog calendar sync', Accept: 'text/calendar,text/plain;q=0.9,*/*;q=0.5' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = await safeUrl(new URL(r.headers.get('location'), u)); continue; }
      if (!r.ok) throw fail('feed_' + r.status, 502);
      const reader = r.body.getReader(); const parts = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) { ctl.abort(); throw fail('too_big', 502); }
        parts.push(value);
      }
      return Buffer.concat(parts.map((p) => Buffer.from(p))).toString('utf8');
    }
    throw fail('too_many_redirects', 502);
  } catch (e) {
    if (e.code) throw e;
    throw fail(e.name === 'AbortError' ? 'timeout' : 'feed_error', 502);
  } finally { clearTimeout(timer); }
}

// ---------- iCal parsing ----------
const unesc = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
function parseLine(line) {
  let q = false, i = 0;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
  const head = line.slice(0, i).split(';'), params = {};
  head.slice(1).forEach((p) => { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); });
  return { name: head[0].toUpperCase(), params, value: line.slice(i + 1) };
}
function parseDate(value, params) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || (params && params.VALUE === 'DATE')) {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return { allDay: true, wall: Date.UTC(+m[1], +m[2] - 1, +m[3]), utc: false, tz: '' };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  return { allDay: false, wall: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)), utc: !!m[7], tz: (params && params.TZID) || '' };
}
// Time zone helpers (built-in Intl, no extra packages)
const fmts = new Map();
function fmtFor(tz) {
  if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return fmts.get(tz);
}
function validTz(tz) { if (!tz) return false; try { fmtFor(tz); return true; } catch (e) { return false; } }
function utcToWall(ms, tz) {
  const p = {}; fmtFor(tz).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}
function wallToUtc(wall, tz) {
  let guess = wall;
  for (let i = 0; i < 3; i++) { const off = utcToWall(guess, tz) - guess; const next = wall - off; if (next === guess) break; guess = next; }
  return guess;
}
const pad = (n) => String(n).padStart(2, '0');
function wallStr(ms, dateOnly) {
  const d = new Date(ms), s = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  return dateOnly ? s : s + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
}
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Expands simple repeating events (daily, weekly, monthly, yearly) inside the window.
function expand(ev, winEnd) {
  const base = ev.start.wall;
  if (!ev.rrule) return [base];
  const R = {};
  ev.rrule.split(';').forEach((p) => { const [k, v] = p.split('='); if (k && v) R[k.toUpperCase()] = v; });
  const freq = R.FREQ, step = Math.max(1, parseInt(R.INTERVAL, 10) || 1), count = R.COUNT ? parseInt(R.COUNT, 10) : Infinity;
  let until = Infinity;
  if (R.UNTIL) { const u = parseDate(R.UNTIL, {}); if (u) until = u.utc && ev.tz ? utcToWall(u.wall, ev.tz) : u.allDay ? u.wall + DAY - 1 : u.wall; }
  const out = []; let n = 0;
  const add = (ms) => { if (ms < base) return true; if (ms > until || n >= count || ms > winEnd) return false; n++; out.push(ms); return true; };
  const b = new Date(base);
  if (freq === 'WEEKLY' && R.BYDAY) {
    const days = R.BYDAY.split(',').map((x) => WD.indexOf(x.replace(/^[+-]?\d+/, ''))).filter((x) => x >= 0).sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
    const weekStart = base - ((b.getUTCDay() + 6) % 7) * DAY;
    outer: for (let w = 0; w < 3000; w += step) {
      for (const d of days) if (!add(weekStart + w * 7 * DAY + ((d + 6) % 7) * DAY)) break outer;
    }
  } else if (freq === 'DAILY' || freq === 'WEEKLY') {
    const inc = (freq === 'DAILY' ? 1 : 7) * step * DAY;
    for (let ms = base, i = 0; i < 40000; ms += inc, i++) if (!add(ms)) break;
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const nth = freq === 'MONTHLY' && R.BYDAY && R.BYDAY.match(/^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/);
    for (let k = 0; k < 2000; k += step) {
      const y = b.getUTCFullYear() + (freq === 'YEARLY' ? k : 0), mo = b.getUTCMonth() + (freq === 'MONTHLY' ? k : 0);
      let day = b.getUTCDate();
      if (nth) {
        const ord = parseInt(nth[1] || '1', 10), wd = WD.indexOf(nth[2]), last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        if (ord > 0) day = 1 + ((wd - new Date(Date.UTC(y, mo, 1)).getUTCDay() + 7) % 7) + (ord - 1) * 7;
        else day = last - ((new Date(Date.UTC(y, mo, last)).getUTCDay() - wd + 7) % 7) + (ord + 1) * 7;
        if (day < 1 || day > last) continue;
      }
      const t = Date.UTC(y, mo, day, b.getUTCHours(), b.getUTCMinutes(), b.getUTCSeconds());
      if (new Date(t).getUTCDate() !== day) continue; // e.g. the 31st in a short month
      if (!add(t)) break;
    }
  } else return [base];
  return out;
}

function parseIcs(text, now = Date.now()) {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw fail('not_calendar', 422);
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const evs = []; let cur = null, depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = { ex: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (/^BEGIN:/i.test(line)) { depth++; continue; } // skip nested VALARM etc.
    if (/^END:VEVENT$/i.test(line)) { evs.push(cur); cur = null; continue; }
    if (/^END:/i.test(line)) { depth--; continue; }
    if (depth > 0) continue;
    const { name, params, value } = parseLine(line);
    if (name === 'SUMMARY') cur.title = unesc(value);
    else if (name === 'UID') cur.uid = value.trim();
    else if (name === 'URL') cur.url = value.trim();
    else if (name === 'LOCATION') cur.loc = unesc(value);
    else if (name === 'STATUS') cur.status = value.trim().toUpperCase();
    else if (name === 'DTSTART') cur.start = parseDate(value, params);
    else if (name === 'DTEND') cur.end = parseDate(value, params);
    else if (name === 'RRULE') cur.rrule = value.trim();
    else if (name === 'EXDATE') value.split(',').forEach((v) => { const d = parseDate(v, params); if (d) cur.ex.push(d); });
    else if (name === 'RECURRENCE-ID') cur.rid = parseDate(value, params);
  }
  const winStart = now - 60 * DAY, winEnd = now + 240 * DAY;
  // single-instance changes to a repeating event replace that instance
  const overridden = new Map();
  evs.forEach((e) => { if (e.rid && e.uid) { if (!overridden.has(e.uid)) overridden.set(e.uid, []); overridden.get(e.uid).push(e.rid); } });
  const out = [];
  for (const e of evs) {
    if (!e.start || e.status === 'CANCELLED') continue;
    e.tz = validTz(e.start.tz) ? e.start.tz : '';
    const toWall = (d) => (d.utc && e.tz ? utcToWall(d.wall, e.tz) : d.wall);
    const skip = new Set(e.ex.map(toWall));
    if (!e.rid && overridden.has(e.uid)) overridden.get(e.uid).forEach((d) => skip.add(toWall(d)));
    const dur = e.end ? Math.max(0, e.end.wall - e.start.wall) : (e.start.allDay ? DAY : 0);
    const title = (e.title || 'Untitled').slice(0, 200);
    const url = /^https:\/\//i.test(e.url || '') ? e.url.slice(0, 500) : '';
    const kind = /assignment/i.test((e.uid || '') + ' ' + url) ? 'assignment' : 'event';
    for (const w of expand(e, winEnd + DAY)) {
      if (skip.has(w)) continue;
      let iso, endIso, real;
      if (e.start.allDay) { iso = wallStr(w, true); endIso = wallStr(w + Math.max(dur, DAY), true); real = w; }
      else if (e.start.utc) { real = w; iso = new Date(w).toISOString(); endIso = new Date(w + dur).toISOString(); }
      else if (e.tz) { real = wallToUtc(w, e.tz); iso = new Date(real).toISOString(); endIso = new Date(wallToUtc(w + dur, e.tz)).toISOString(); }
      else { real = w; iso = wallStr(w); endIso = wallStr(w + dur); } // floating time: shown as local time
      if (real + Math.max(dur, 1) < winStart || real > winEnd) continue;
      out.push({ id: (e.uid || title).slice(0, 200) + '@' + iso, title, start: iso, end: endIso, allDay: e.start.allDay, url, loc: (e.loc || '').slice(0, 200), kind, _t: real });
      if (out.length > 5000) break;
    }
  }
  out.sort((a, b) => a._t - b._t);
  return out.slice(0, 2000).map(({ _t, ...x }) => x);
}

async function loadFeed(url) {
  const key = String(url).trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.events;
  const events = parseIcs(await download(key));
  cache.set(key, { at: Date.now(), events });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return events;
}

module.exports = { loadFeed, parseIcs, privateIp, safeUrl };
