import express from 'express';
import cors from 'cors';
import multer from 'multer';
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const BOOKS_DIR = join(DATA_DIR, 'books');
const DB_PATH = join(DATA_DIR, 'speeedy.db');
const PORT = parseInt(process.env.PORT || '3000', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

if (!AUTH_TOKEN) {
  console.warn('WARNING: AUTH_TOKEN env var is empty — server runs without auth (open to anyone with network access).');
}

mkdirSync(BOOKS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT,
    uploaded_at INTEGER NOT NULL,
    last_read_at INTEGER,
    position_word INTEGER DEFAULT 0,
    position_total INTEGER DEFAULT 0,
    position_chapter TEXT,
    wpm INTEGER,
    metadata_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_books_last_read ON books(last_read_at DESC);
`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: ['text/plain', 'application/octet-stream'], limit: '2mb' }));

// Auth middleware (skipped when no AUTH_TOKEN is configured)
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!AUTH_TOKEN) return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Upload an EPUB (or other supported file)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

app.post('/api/books', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const buf = req.file.buffer;
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 24);

  const existing = db.prepare('SELECT id FROM books WHERE id = ?').get(hash);
  if (existing) {
    return res.json({ id: hash, existed: true });
  }

  const filePath = join(BOOKS_DIR, hash);
  writeFileSync(filePath, buf);

  const title = req.body.title || req.file.originalname || 'Untitled';
  const metaJson = req.body.metadata || null;

  db.prepare(`
    INSERT INTO books (id, title, filename, size, mime_type, uploaded_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(hash, title, req.file.originalname, buf.length, req.file.mimetype, Date.now(), metaJson);

  res.json({ id: hash, existed: false });
});

// List books with progress
app.get('/api/books', (req, res) => {
  const rows = db.prepare(`
    SELECT id, title, filename, size, mime_type, uploaded_at, last_read_at,
           position_word, position_total, position_chapter, wpm, metadata_json
    FROM books
    ORDER BY COALESCE(last_read_at, uploaded_at) DESC
  `).all();
  res.json({ books: rows.map(r => ({
    ...r,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
    metadata_json: undefined,
    progress: r.position_total > 0 ? r.position_word / r.position_total : 0
  })) });
});

// Get single book metadata
app.get('/api/books/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    ...row,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    metadata_json: undefined,
    progress: row.position_total > 0 ? row.position_word / row.position_total : 0
  });
});

// Download EPUB content
app.get('/api/books/:id/file', (req, res) => {
  const row = db.prepare('SELECT filename, mime_type FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const filePath = join(BOOKS_DIR, req.params.id);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'file missing' });
  res.set('Content-Type', row.mime_type || 'application/octet-stream');

  // Sanitize filename for the Content-Disposition header: Node's HTTP layer
  // rejects non-ASCII bytes (e.g. typographic quotes in book filenames).
  const safeName = String(row.filename || 'book').replace(/[^\x20-\x7E]/g, '_');
  const encodedName = encodeURIComponent(row.filename || 'book');
  res.set('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);

  res.send(readFileSync(filePath));
});

function applyPositionUpdate(id, body) {
  const row = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
  if (!row) return false;

  const { position_word, position_total, position_chapter, wpm, title, metadata } = body || {};
  const updates = [];
  const values = [];

  if (Number.isFinite(position_word)) { updates.push('position_word = ?'); values.push(position_word); }
  if (Number.isFinite(position_total)) { updates.push('position_total = ?'); values.push(position_total); }
  if (typeof position_chapter === 'string') { updates.push('position_chapter = ?'); values.push(position_chapter); }
  if (Number.isFinite(wpm)) { updates.push('wpm = ?'); values.push(wpm); }
  if (typeof title === 'string' && title.trim()) { updates.push('title = ?'); values.push(title.trim()); }
  if (metadata !== undefined) { updates.push('metadata_json = ?'); values.push(metadata == null ? null : JSON.stringify(metadata)); }

  updates.push('last_read_at = ?');
  values.push(Date.now());
  values.push(id);

  db.prepare(`UPDATE books SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

// Beacon endpoint: POST so navigator.sendBeacon works on unload. Body is JSON.
app.post('/api/books/:id/beacon', (req, res) => {
  // Beacon may send Content-Type: text/plain; manually parse if needed.
  let body = req.body;
  if ((!body || Object.keys(body).length === 0) && typeof req.body === 'string') {
    try { body = JSON.parse(req.body); } catch { body = {}; }
  }
  const ok = applyPositionUpdate(req.params.id, body);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// Update reading position
app.patch('/api/books/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const { position_word, position_total, position_chapter, wpm, title, metadata } = req.body || {};
  const updates = [];
  const values = [];

  if (Number.isFinite(position_word)) { updates.push('position_word = ?'); values.push(position_word); }
  if (Number.isFinite(position_total)) { updates.push('position_total = ?'); values.push(position_total); }
  if (typeof position_chapter === 'string') { updates.push('position_chapter = ?'); values.push(position_chapter); }
  if (Number.isFinite(wpm)) { updates.push('wpm = ?'); values.push(wpm); }
  if (typeof title === 'string' && title.trim()) { updates.push('title = ?'); values.push(title.trim()); }
  if (metadata !== undefined) { updates.push('metadata_json = ?'); values.push(metadata == null ? null : JSON.stringify(metadata)); }

  updates.push('last_read_at = ?');
  values.push(Date.now());

  values.push(req.params.id);

  db.prepare(`UPDATE books SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// Delete a book
app.delete('/api/books/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM books WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const filePath = join(BOOKS_DIR, req.params.id);
  if (existsSync(filePath)) unlinkSync(filePath);
  db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Speeedy backend listening on :${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
