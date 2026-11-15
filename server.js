const express = require('express');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { loadFeed } = require('./calendar');

const app = express();
app.set('trust proxy', 1);
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const BB_KEY = process.env.BACKBOARD_API_KEY; // if set, AI calls go through Backboard.io instead of Anthropic
const BB = { provider: process.env.BACKBOARD_PROVIDER || 'openai', model: process.env.BACKBOARD_MODEL || 'gpt-4o-mini' };

async function askBackboard(prompt, images) {
  const fd = new FormData();
  fd.append('content', prompt);
  fd.append('llm_provider', BB.provider);
  fd.append('model_name', BB.model);
  fd.append('stream', 'false');
  fd.append('memory', 'off');
  images.forEach((im, i) => fd.append('files', new Blob([Buffer.from(im.data, 'base64')], { type: im.type }), 'photo' + i + '.jpg'));
  const r = await fetch('https://app.backboard.io/api/threads/messages', { method: 'POST', headers: { 'X-API-Key': BB_KEY }, body: fd });
  if (!r.ok) { const e = new Error('backboard ' + r.status + ' ' + (await r.text()).slice(0, 200)); e.status = r.status; throw e; }
  const j = await r.json();
  return j.content || '';
}
const MODELS = {
  quick: process.env.MODEL_QUICK || 'claude-haiku-5-5',
  default: process.env.MODEL_DEFAULT || 'claude-sonnet-5-5',
};
const DAILY_AI_LIMIT = Number(process.env.DAILY_AI_LIMIT || 150);
const PROD = process.env.NODE_ENV === 'production';
const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: url.includes('.render.com') ? { rejectUnauthorized: false } : false });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text UNIQUE NOT NULL, name text, pass text NOT NULL, dob text, parent_email text, created timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (token text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (path text PRIMARY KEY, col text NOT NULL, id text NOT NULL, data jsonb NOT NULL, updated timestamptz DEFAULT now());
    CREATE INDEX IF NOT EXISTS kv_col_idx ON kv (col);
    CREATE TABLE IF NOT EXISTS docs (user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL, data jsonb NOT NULL, updated timestamptz DEFAULT now(), PRIMARY KEY (user_id, name));
  `);
}

// ---------- helpers ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw) => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, stored) => { const [s, h] = stored.split(':'); const x = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); };
const ageOf = (d) => { const b = new Date(d), n = new Date(); if (isNaN(b)) return -1; let a = n.getFullYear() - b.getFullYear(); const m = n.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--; return a; };
const okEmail = (e) => typeof e === 'string' && e.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function cookie(req, name) { const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '=')); return m ? decodeURIComponent(m.slice(name.length + 1)) : ''; }
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions (token,user_id,expires) VALUES ($1,$2,now() + interval \'30 days\')', [sha(token), userId]);
  res.setHeader('Set-Cookie', `ql=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${PROD ? '; Secure' : ''}`);
}
async function auth(req, _res, next) {
  req.user = null;
  const t = cookie(req, 'ql');
  if (t) {
    try {
      const r = await pool.query('SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires>now()', [sha(t)]);
      req.user = r.rows[0] || null;
    } catch (e) { console.error('auth', e.message); }
  }
  next();
}
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'auth' }));

// ---------- middleware ----------
app.use(express.json({ limit: '5mb' }));
app.get('/healthz', (_req, res) => res.send('ok'));
app.use('/api', (req, res, next) => { // block cross-site writes
  if (req.method !== 'GET') { const o = req.headers.origin; if (!o || new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'forbidden' }); }
  next();
});
const lim = { standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited' } };
app.use('/api', rateLimit({ windowMs: 60e3, limit: 120, skip: (req) => req.path.startsWith('/kv/'), ...lim }));

// ---------- shared store: profiles, friends, leaderboard, peer checks (works across devices) ----------
// The front end talks to this like a tiny document database (see serverDb() in public/index.html).
const KV_TOP = /^(data|players|friendreqs|verifications|peerlog|messages|reports)(\/|$)/;
const okCol = (c) => typeof c === 'string' && c.length <= 200 && /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(c) && KV_TOP.test(c);
const okPath = (p) => okCol(p) && p.includes('/');
const kvLimit = rateLimit({ windowMs: 60e3, limit: 1500, ...lim });
const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
async function kvSet(path, data) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [path]);
    // the profile list is shared by everyone: merge by profile id so two sign-ups at once never overwrite each other
    if (/\/profiles$/.test(path) && data && Array.isArray(data.list)) {
      const r = await c.query('SELECT data FROM kv WHERE path=$1', [path]);
      const rem = r.rows[0] && Array.isArray(r.rows[0].data.list) ? r.rows[0].data.list : [];
      const ids = new Set(data.list.map((x) => x && x.pid));
      data = { list: data.list.concat(rem.filter((x) => x && !ids.has(x.pid))) };
    }
    const i = path.lastIndexOf('/');
    await c.query('INSERT INTO kv (path,col,id,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (path) DO UPDATE SET data=$4::jsonb, updated=now()', [path, path.slice(0, i), path.slice(i + 1), JSON.stringify(data)]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
// ---------- friend messages: safety rules (messages + reports) ----------
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const badText = (t) => typeof t !== 'string' || !t.trim() || t.length > 500
  || /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|me|co|ly|app|xyz)\b)/i.test(t)
  || /\S+@\S+\.\S+/.test(t) || /(\d[\s().-]*){8,}/.test(t)
  || /\b(snap(chat)?|insta(gram)?|discord|tiktok|whatsapp|telegram|kik|signal)\b/i.test(t);
const msgRate = new Map();
const topOf = (s) => String(s || '').split('/')[0];
async function kvRules(req, res, next) {
  const top = topOf(req.query.p || req.query.c);
  if (top === 'reports') { // reports are write-only from the app; read them via /api/admin/reports
    if (req.method !== 'PUT') return res.status(403).json({ error: 'forbidden' });
  }
  if (top === 'messages') {
    if (req.method === 'PATCH') return res.status(403).json({ error: 'forbidden' });
    if (req.method === 'GET' && req.path === '/col') { // no bulk reads: a query must be limited to one person's messages
      let w = []; try { w = req.query.w ? JSON.parse(req.query.w) : []; } catch (e) { return res.status(400).json({ error: 'invalid' }); }
      if (!w.some((f) => Array.isArray(f) && ['th', 'to', 'from'].includes(f[0]))) return res.status(403).json({ error: 'forbidden' });
    }
    if (req.method === 'GET' && req.path === '/doc') return res.status(403).json({ error: 'forbidden' });
    if (req.method === 'PUT') {
      const d = req.body && req.body.data;
      if (!d || typeof d.from !== 'string' || typeof d.to !== 'string' || typeof d.th !== 'string' || d.from === d.to || badText(d.text)) return res.status(400).json({ error: 'rejected' });
      const n = (msgRate.get(d.from) || []).filter((x) => Date.now() - x < 60e3);
      if (n.length >= 15) return res.status(429).json({ error: 'rate_limited' });
      n.push(Date.now()); msgRate.set(d.from, n); if (msgRate.size > 5000) msgRate.clear();
      try { // only accepted friends can message each other
        const r = await pool.query("SELECT 1 FROM kv WHERE path = ANY($1) AND data->>'status'='accepted'", [['friendreqs/' + d.from + '_' + d.to, 'friendreqs/' + d.to + '_' + d.from]]);
        if (!r.rowCount) return res.status(403).json({ error: 'not_friends' });
      } catch (e) { return res.status(500).json({ error: 'server' }); }
    }
  }
  next();
}
app.use('/api/kv', kvLimit, noStore, kvRules);
app.get('/api/admin/reports', async (req, res) => { // see reports: /api/admin/reports with header x-admin-key
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  const r = await pool.query("SELECT id,data,updated FROM kv WHERE col='reports' ORDER BY updated DESC LIMIT 200");
  res.json({ reports: r.rows });
});
setInterval(() => { // keep messages for 30 days and reports for 90
  pool.query("DELETE FROM kv WHERE (col='messages' AND updated < now() - interval '30 days') OR (col='reports' AND updated < now() - interval '90 days')").catch(() => {});
}, 60 * 60e3);
app.get('/api/kv/ping', async (_req, res) => { // open /api/kv/ping in a browser to check the shared store
  try { const r = await pool.query('SELECT count(*)::int AS n FROM kv'); res.json({ ok: true, rows: r.rows[0].n }); }
  catch (e) { console.error('kv ping', e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/kv/doc', async (req, res) => {
  const p = String(req.query.p || ''); if (!okPath(p)) return res.status(400).json({ error: 'invalid' });
  try { const r = await pool.query('SELECT data FROM kv WHERE path=$1', [p]); r.rows[0] ? res.json({ data: r.rows[0].data }) : res.status(404).json({ error: 'none' }); }
  catch (e) { console.error('kv get', e.message); res.status(500).json({ error: 'server' }); }
});
app.put('/api/kv/doc', async (req, res) => {
  const p = String(req.query.p || ''), d = req.body && req.body.data;
  if (!okPath(p) || !d || typeof d !== 'object' || Array.isArray(d) || JSON.stringify(d).length > 1e6) return res.status(400).json({ error: 'invalid' });
  try { await kvSet(p, d); res.json({ ok: true }); } catch (e) { console.error('kv set', e.message); res.status(500).json({ error: 'server' }); }
});
app.patch('/api/kv/doc', async (req, res) => {
  const p = String(req.query.p || ''), d = req.body && req.body.data;
  if (!okPath(p) || !d || typeof d !== 'object' || Array.isArray(d) || JSON.stringify(d).length > 1e6) return res.status(400).json({ error: 'invalid' });
  try { const r = await pool.query('UPDATE kv SET data = data || $2::jsonb, updated=now() WHERE path=$1', [p, JSON.stringify(d)]); r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'none' }); }
  catch (e) { console.error('kv update', e.message); res.status(500).json({ error: 'server' }); }
});
app.delete('/api/kv/doc', async (req, res) => {
  const p = String(req.query.p || ''); if (!okPath(p)) return res.status(400).json({ error: 'invalid' });
  try { await pool.query('DELETE FROM kv WHERE path=$1', [p]); res.json({ ok: true }); } catch (e) { console.error('kv del', e.message); res.status(500).json({ error: 'server' }); }
});
app.get('/api/kv/col', async (req, res) => {
  const c = String(req.query.c || ''); if (!okCol(c)) return res.status(400).json({ error: 'invalid' });
  let w = []; try { w = req.query.w ? JSON.parse(req.query.w) : []; } catch (e) { return res.status(400).json({ error: 'invalid' }); }
  if (!Array.isArray(w) || w.length > 4) return res.status(400).json({ error: 'invalid' });
  const params = [c]; let sql = 'SELECT id,data FROM kv WHERE col=$1';
  for (const f of w) {
    if (!Array.isArray(f) || f[1] !== '==' || !/^[A-Za-z0-9_]{1,30}$/.test(f[0]) || !['string', 'number', 'boolean'].includes(typeof f[2])) return res.status(400).json({ error: 'invalid' });
    params.push(f[0], String(f[2])); sql += ` AND data->>$${params.length - 1} = $${params.length}`;
  }
  sql += ' LIMIT ' + Math.min(Number(req.query.limit) || 2000, 2000);
  try { const r = await pool.query(sql, params); res.json({ docs: r.rows }); } catch (e) { console.error('kv col', e.message); res.status(500).json({ error: 'server' }); }
});
// ---------- calendar sync: Canvas / Google Calendar / any iCal feed ----------
// The page sends the feed link here; the server downloads it (public https hosts only) and returns events.
const calLimit = rateLimit({ windowMs: 60e3, limit: 30, ...lim });
app.get('/api/ical', calLimit, noStore, async (req, res) => {
  const url = String(req.query.url || '');
  if (!url || url.length > 2000) return res.status(400).json({ error: 'bad_url' });
  try { res.json({ events: await loadFeed(url) }); }
  catch (e) {
    if (!e.code) console.error('ical', e.message);
    res.status(e.status || 502).json({ error: e.code || 'feed_error' });
  }
});
const authLimit = rateLimit({ windowMs: 15 * 60e3, limit: 20, ...lim });
app.use('/api', auth);

// ---------- accounts ----------
app.post('/api/signup', authLimit, async (req, res) => {
  const { email, password, name, dob, parent, consent } = req.body || {};
  if (!okEmail(email) || typeof password !== 'string' || password.length < 8 || password.length > 100) return res.status(400).json({ error: 'invalid' });
  const age = ageOf(dob);
  if (age < 11 || age > 110) return res.status(400).json({ error: 'age' });
  if (age < 13 && (!okEmail(parent) || parent.toLowerCase() === email.toLowerCase() || consent !== true)) return res.status(400).json({ error: 'parent' });
  try {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO users (id,email,name,pass,dob,parent_email) VALUES ($1,$2,$3,$4,$5,$6)', [id, email.trim().toLowerCase(), String(name || 'Hero').slice(0, 16), hashPw(password), dob, age < 13 ? parent : null]);
    await startSession(res, id);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'exists' });
    console.error('signup', e.message); res.status(500).json({ error: 'server' });
  }
});
app.post('/api/login', authLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!okEmail(email) || typeof password !== 'string') return res.status(400).json({ error: 'invalid' });
  try {
    const r = await pool.query('SELECT id,pass FROM users WHERE email=$1', [email.trim().toLowerCase()]);
    if (!r.rows[0] || !checkPw(password, r.rows[0].pass)) return res.status(401).json({ error: 'bad_login' });
    await startSession(res, r.rows[0].id);
    res.json({ ok: true });
  } catch (e) { console.error('login', e.message); res.status(500).json({ error: 'server' }); }
});
app.post('/api/logout', async (req, res) => {
  const t = cookie(req, 'ql'); if (t) await pool.query('DELETE FROM sessions WHERE token=$1', [sha(t)]).catch(() => {});
  res.setHeader('Set-Cookie', 'ql=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true });
});
app.get('/api/me', needUser, (req, res) => res.json(req.user));
app.delete('/api/account', needUser, async (req, res) => { // lets a user delete all their data
  await pool.query('DELETE FROM users WHERE id=$1', [req.user.id]);
  res.setHeader('Set-Cookie', 'ql=; HttpOnly; Path=/; Max-Age=0'); res.json({ ok: true });
});

// ---------- per-user saved data (progress, profile) ----------
app.get('/api/doc/:name', needUser, async (req, res) => {
  if (!/^[a-z0-9_]{1,40}$/.test(req.params.name)) return res.status(400).json({ error: 'invalid' });
  const r = await pool.query('SELECT data FROM docs WHERE user_id=$1 AND name=$2', [req.user.id, req.params.name]);
  r.rows[0] ? res.json(r.rows[0].data) : res.status(404).json({ error: 'none' });
});
app.put('/api/doc/:name', needUser, async (req, res) => {
  if (!/^[a-z0-9_]{1,40}$/.test(req.params.name) || JSON.stringify(req.body).length > 1e6) return res.status(400).json({ error: 'invalid' });
  await pool.query('INSERT INTO docs (user_id,name,data) VALUES ($1,$2,$3) ON CONFLICT (user_id,name) DO UPDATE SET data=$3, updated=now()', [req.user.id, req.params.name, req.body]);
  res.json({ ok: true });
});

// ---------- AI (signed-in users only, capped per day) ----------
const aiCount = new Map();
const GUEST_AI_LIMIT = Number(process.env.GUEST_AI_LIMIT || 30);
app.post('/api/ai', async (req, res) => {
  const day = new Date().toISOString().slice(0, 10), key = (req.user ? req.user.id : 'ip:' + req.ip) + day;
  const used = aiCount.get(key) || 0;
  if (used >= (req.user ? DAILY_AI_LIMIT : GUEST_AI_LIMIT)) return res.status(429).json({ error: 'rate_limited' });
  const { prompt, tier, images } = req.body || {};
  if (typeof prompt !== 'string' || !prompt || prompt.length > 8000) return res.status(400).json({ error: 'bad_request' });
  const imgs = (Array.isArray(images) ? images.slice(0, 4) : []).filter((im) => im && typeof im.data === 'string' && /^image\/(jpeg|png|webp|gif)$/.test(im.type));
  aiCount.set(key, used + 1);
  if (aiCount.size > 5000) aiCount.clear();
  try {
    if (BB_KEY) return res.json({ text: await askBackboard(prompt, imgs) });
    if (!client) return res.status(503).json({ error: 'ai_not_configured' });
    const content = imgs.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } }));
    content.push({ type: 'text', text: prompt });
    const msg = await client.messages.create({ model: tier === 'quick' ? MODELS.quick : MODELS.default, max_tokens: 700, messages: [{ role: 'user', content }] });
    res.json({ text: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('') });
  } catch (e) {
    console.error('AI error', e.status || '', e.message);
    res.status(e.status === 429 ? 429 : 502).json({ error: e.status === 429 ? 'rate_limited' : 'ai_error' });
  }
});

// find index.html in public/ (normal) or next to server.js (if it was uploaded to the wrong folder)
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
console.log('Serving front end from', PUB, fs.existsSync(path.join(PUB, 'index.html')) ? '(index.html found)' : '(index.html MISSING)');
app.use(express.static(PUB, { index: 'index.html', dotfiles: 'ignore' }));
app.get('/', (_req, res) => {
  const f = path.join(PUB, 'index.html');
  fs.existsSync(f) ? res.sendFile(f) : res.status(500).send('index.html not found. It must be at public/index.html in your repo.');
});
initDb().then(() => app.listen(process.env.PORT || 3000, () => console.log('Questlog running')))
  .catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
