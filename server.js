const express = require('express');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8443;

const db = new Database(path.join(__dirname, 'books.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---- スキーマ: 本棚 (shelves) → 段 (rows) → 本 (books) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS shelves (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS rows (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    shelf_id INTEGER NOT NULL REFERENCES shelves(id),
    name     TEXT DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
  );
`);
if (!db.prepare('SELECT COUNT(*) AS c FROM shelves').get().c) {
  const s = db.prepare("INSERT INTO shelves (name, position) VALUES ('本棚 1', 0)").run();
  db.prepare('INSERT INTO rows (shelf_id, position) VALUES (?, 0)').run(s.lastInsertRowid);
}

// v2 (books.shelf_id) → v3 (books.row_id) 移行: 旧棚1つ = 新棚の1段目
const bookCols = db.prepare('PRAGMA table_info(books)').all();
if (bookCols.length && bookCols.some((c) => c.name === 'shelf_id') && !bookCols.some((c) => c.name === 'row_id')) {
  db.transaction(() => {
    for (const s of db.prepare('SELECT id FROM shelves').all()) {
      if (!db.prepare('SELECT COUNT(*) AS c FROM rows WHERE shelf_id = ?').get(s.id).c) {
        db.prepare('INSERT INTO rows (shelf_id, position) VALUES (?, 0)').run(s.id);
      }
    }
    db.exec(`
      CREATE TABLE books_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        isbn      TEXT UNIQUE,
        title     TEXT NOT NULL,
        author    TEXT DEFAULT '',
        publisher TEXT DEFAULT '',
        pubdate   TEXT DEFAULT '',
        cover     TEXT DEFAULT '',
        row_id    INTEGER NOT NULL REFERENCES rows(id),
        position  INTEGER NOT NULL DEFAULT 0,
        added_at  TEXT DEFAULT (datetime('now', 'localtime'))
      );
      INSERT INTO books_new (id, isbn, title, author, publisher, pubdate, cover, row_id, position, added_at)
        SELECT b.id, b.isbn, b.title, b.author, b.publisher, b.pubdate, b.cover,
               (SELECT r.id FROM rows r WHERE r.shelf_id = b.shelf_id ORDER BY r.position, r.id LIMIT 1),
               b.position, b.added_at
        FROM books b;
      DROP TABLE books;
      ALTER TABLE books_new RENAME TO books;
    `);
  })();
}
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    isbn      TEXT UNIQUE,
    title     TEXT NOT NULL,
    author    TEXT DEFAULT '',
    publisher TEXT DEFAULT '',
    pubdate   TEXT DEFAULT '',
    cover     TEXT DEFAULT '',
    row_id    INTEGER NOT NULL REFERENCES rows(id),
    position  INTEGER NOT NULL DEFAULT 0,
    added_at  TEXT DEFAULT (datetime('now', 'localtime'))
  )
`);

{
  const cols = db.prepare('PRAGMA table_info(books)').all().map((c) => c.name);
  if (!cols.includes('memo')) db.exec("ALTER TABLE books ADD COLUMN memo TEXT DEFAULT ''");
  if (!cols.includes('rating')) db.exec('ALTER TABLE books ADD COLUMN rating INTEGER DEFAULT 0'); // 0=未評価, 1-5
  if (!cols.includes('status')) db.exec("ALTER TABLE books ADD COLUMN status TEXT DEFAULT 'unread'"); // unread | reading | read
  if (!cols.includes('pages')) db.exec('ALTER TABLE books ADD COLUMN pages INTEGER');
  if (!cols.includes('height_cm')) db.exec('ALTER TABLE books ADD COLUMN height_cm REAL'); // NDL の「大きさ」(cm丸め) or 実測
  if (!cols.includes('thickness_cm')) db.exec('ALTER TABLE books ADD COLUMN thickness_cm REAL'); // 実測の厚み (NULL ならページ数から概算)
  const rcols = db.prepare('PRAGMA table_info(rows)').all().map((c) => c.name);
  if (!rcols.includes('height_cm')) db.exec('ALTER TABLE rows ADD COLUMN height_cm REAL'); // 段の内寸
  if (!rcols.includes('width_cm')) db.exec('ALTER TABLE rows ADD COLUMN width_cm REAL');
}

const app = express();
app.use(express.json({ limit: '25mb' })); // 棚写真の base64 を受けるため
app.use(express.static(path.join(__dirname, 'public')));

// ---- 書誌情報の取得 ----

function normalizeIsbn(raw) {
  const s = String(raw).replace(/[^0-9Xx]/g, '').toUpperCase();
  if (s.length === 13) return s;
  if (s.length === 10) {
    const body = '978' + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += (i % 2 ? 3 : 1) * Number(body[i]);
    return body + ((10 - (sum % 10)) % 10);
  }
  return null;
}

// openBD の著者表記 "宮沢,賢治,1896-1933 訳者,名//訳" を読みやすく整形
function cleanAuthor(s) {
  return String(s || '')
    .split(/\s+/)
    .map((part) =>
      part
        .replace(/\/\/.*$/, '')
        .replace(/,\d{4}-(\d{4})?$/, '')
        .replace(/,/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('、');
}

async function lookupOpenBD(isbn) {
  const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn}`);
  if (!res.ok) return null;
  const [item] = await res.json();
  if (!item) return null;
  const s = item.summary;
  return {
    isbn,
    title: s.title || '',
    author: cleanAuthor(s.author),
    publisher: s.publisher || '',
    pubdate: s.pubdate || '',
    cover: s.cover || '',
    source: 'openBD',
  };
}

async function lookupGoogleBooks(isbn) {
  const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
  if (!res.ok) return null;
  const data = await res.json();
  const v = data.items?.[0]?.volumeInfo;
  if (!v) return null;
  return {
    isbn,
    title: v.title || '',
    author: (v.authors || []).join('、'),
    publisher: v.publisher || '',
    pubdate: (v.publishedDate || '').replace(/-/g, ''),
    cover: v.imageLinks?.thumbnail?.replace(/^http:/, 'https:') || '',
    source: 'Google Books',
  };
}

// 国立国会図書館のサムネイル。直リンクは 403 なので /api/cover/ndl/:isbn でプロキシ配信する
const NDL_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://ndlsearch.ndl.go.jp/' };
async function ndlCover(isbn) {
  try {
    const res = await fetch(`https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`, { headers: NDL_HEADERS });
    if (res.ok && res.headers.get('content-type')?.startsWith('image/')) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 1000) return `/api/cover/ndl/${isbn}`;
    }
  } catch {}
  return '';
}

// Google の「表紙なし」プレースホルダ画像の SHA-1 (2026-07 時点で確認した2種)
const GOOGLE_PLACEHOLDER_HASHES = new Set([
  'ba8cd5043eedf32e39a4f328a4ec22f8a7dbbaba',
  'cc7313f0f2ac7aa7bc990e3b8bbc9fddd0a19f70',
]);

// Google Books の表紙直リンク (API クォータ非消費)。本物の画像か確認して URL を返す
async function googleCover(isbn) {
  const url = `https://books.google.com/books/content?vid=ISBN:${isbn}&printsec=frontcover&img=1&zoom=1`;
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.ok && res.headers.get('content-type')?.startsWith('image/') && buf.byteLength > 2000) {
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      if (!GOOGLE_PLACEHOLDER_HASHES.has(hash)) return url;
    }
  } catch {}
  return '';
}

async function fallbackCover(isbn) {
  return (await ndlCover(isbn)) || (await googleCover(isbn));
}

// NDL SRU からページ数と高さ(cm) を取得: dcterms:extent "563p ; 15cm"
async function ndlDimensions(isbn) {
  try {
    const res = await fetch(
      `https://ndlsearch.ndl.go.jp/api/sru?operation=searchRetrieve&query=isbn%3D${isbn}&recordSchema=dcndl&maximumRecords=1`,
      { headers: NDL_HEADERS, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) return null;
    const xml = await res.text();
    // dcterms:extent (レコード部はXMLエスケープ済) 例: "563p ; 15cm", "422, 27p ; 16cm"
    const exts = xml.match(/(?:extent&gt;|<dcterms:extent>)(.*?)(?:&lt;|<\/dcterms:extent>)/g) || [];
    let pages = null;
    let height = null;
    for (const e of exts) {
      const hm = e.match(/(\d+(?:\.\d+)?)\s*cm/);
      if (hm && !height) height = Number(hm[1]);
      for (const pm of e.matchAll(/(\d+)\s*p/g)) {
        const n = Number(pm[1]);
        if (!pages || n > pages) pages = n; // 複数の頁表記は最大値を採用
      }
    }
    if (pages || height) return { pages, height_cm: height };
  } catch {}
  return null;
}

// ---- ヘルパ ----

function defaultRowId() {
  return db
    .prepare(
      `SELECT r.id FROM rows r JOIN shelves s ON s.id = r.shelf_id
       ORDER BY s.position, s.id, r.position, r.id LIMIT 1`
    )
    .get().id;
}
function nextBookPosition(rowId) {
  return db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM books WHERE row_id = ?').get(rowId).p;
}

const insertBook = db.prepare(
  `INSERT INTO books (isbn, title, author, publisher, pubdate, cover, row_id, position, pages, height_cm)
   VALUES (@isbn, @title, @author, @publisher, @pubdate, @cover, @row_id, @position, @pages, @height_cm)
   RETURNING *`
);

// ---- 本 ----

// ISBN あり: 書誌情報を引いて登録 / ISBN なし: title(+author) だけで登録
app.post('/api/books', async (req, res) => {
  const rowId = req.body.row_id || defaultRowId();

  if (!req.body.isbn) {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'タイトルを入力してください' });
    const row = insertBook.get({
      isbn: null,
      title,
      author: String(req.body.author || '').trim(),
      publisher: '',
      pubdate: '',
      cover: '',
      row_id: rowId,
      position: nextBookPosition(rowId),
      pages: null,
      height_cm: null,
    });
    return res.status(201).json({ book: row, source: 'manual' });
  }

  const isbn = normalizeIsbn(req.body.isbn);
  if (!isbn) return res.status(400).json({ error: 'ISBNの形式が不正です' });

  const existing = db.prepare('SELECT * FROM books WHERE isbn = ?').get(isbn);
  if (existing) return res.status(200).json({ book: existing, duplicate: true });

  let info = null;
  try {
    info = await lookupOpenBD(isbn);
    if (!info || !info.title) {
      info = (await lookupGoogleBooks(isbn).catch(() => null)) || info;
    }
    if (info?.title && !info.cover) {
      info.cover = await fallbackCover(isbn);
    }
  } catch (e) {
    console.error('lookup failed:', e.message);
  }
  if (!info || !info.title) {
    return res.status(404).json({ error: '書誌情報が見つかりませんでした', isbn });
  }

  const dims = (await ndlDimensions(isbn).catch(() => null)) || {};
  const { source, ...fields } = info;
  const row = insertBook.get({
    ...fields,
    row_id: rowId,
    position: nextBookPosition(rowId),
    pages: dims.pages ?? null,
    height_cm: dims.height_cm ?? null,
  });
  res.status(201).json({ book: row, source: info.source });
});

// メモ・タイトル・著者・評価・読了ステータスの編集
const STATUSES = ['unread', 'reading', 'read'];
app.patch('/api/books/:id', (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.status(404).end();
  const title = req.body.title !== undefined ? String(req.body.title).trim() : book.title;
  if (!title) return res.status(400).json({ error: 'タイトルは空にできません' });
  const author = req.body.author !== undefined ? String(req.body.author).trim() : book.author;
  const memo = req.body.memo !== undefined ? String(req.body.memo) : book.memo;
  let rating = book.rating;
  if (req.body.rating !== undefined) {
    rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      return res.status(400).json({ error: '評価は0〜5で指定してください' });
    }
  }
  let status = book.status;
  if (req.body.status !== undefined) {
    status = String(req.body.status);
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status は unread / reading / read のいずれかです' });
    }
  }
  // 実測寸法 (cm)。空文字/null でクリア
  const dim = (v, cur, max) => {
    if (v === undefined) return cur;
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= max ? n : cur;
  };
  const heightCm = dim(req.body.height_cm, book.height_cm, 100);
  const thicknessCm = dim(req.body.thickness_cm, book.thickness_cm, 30);
  const row = db
    .prepare(
      'UPDATE books SET title = ?, author = ?, memo = ?, rating = ?, status = ?, height_cm = ?, thickness_cm = ? WHERE id = ? RETURNING *'
    )
    .get(title, author, memo, rating, status, heightCm, thicknessCm, req.params.id);
  res.json({ book: row });
});

app.delete('/api/books/:id', (req, res) => {
  const r = db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  res.status(r.changes ? 204 : 404).end();
});

// ---- 本棚 ----

// 本棚一覧 (段と本をネストして返す)
app.get('/api/shelves', (req, res) => {
  const shelves = db.prepare('SELECT * FROM shelves ORDER BY position, id').all();
  const rowsOf = db.prepare('SELECT * FROM rows WHERE shelf_id = ? ORDER BY position, id');
  const booksOf = db.prepare('SELECT * FROM books WHERE row_id = ? ORDER BY position, id');
  res.json(
    shelves.map((s) => ({
      ...s,
      rows: rowsOf.all(s.id).map((r) => ({ ...r, books: booksOf.all(r.id) })),
    }))
  );
});

app.post('/api/shelves', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '本棚の名前を入力してください' });
  const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM shelves').get().p;
  const shelf = db.prepare('INSERT INTO shelves (name, position) VALUES (?, ?) RETURNING *').get(name, pos);
  const nRows = Math.min(Math.max(Number(req.body.rows) || 1, 1), 10);
  for (let i = 0; i < nRows; i++) {
    db.prepare('INSERT INTO rows (shelf_id, position) VALUES (?, ?)').run(shelf.id, i);
  }
  res.status(201).json(shelf);
});

// 本棚の並び順 (":id" ルートより先に定義)
app.put('/api/shelves/order', (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids が必要です' });
  const upd = db.prepare('UPDATE shelves SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
  res.status(204).end();
});

app.patch('/api/shelves/:id', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '本棚の名前を入力してください' });
  const r = db.prepare('UPDATE shelves SET name = ? WHERE id = ?').run(name, req.params.id);
  res.status(r.changes ? 204 : 404).end();
});

// 本棚を削除 (中の本は先頭の本棚の1段目末尾へ)
app.delete('/api/shelves/:id', (req, res) => {
  const id = Number(req.params.id);
  if (db.prepare('SELECT COUNT(*) AS c FROM shelves').get().c <= 1) {
    return res.status(400).json({ error: '最後の本棚は削除できません' });
  }
  const dest = db
    .prepare(
      `SELECT r.id FROM rows r JOIN shelves s ON s.id = r.shelf_id
       WHERE s.id != ? ORDER BY s.position, s.id, r.position, r.id LIMIT 1`
    )
    .get(id);
  db.transaction(() => {
    let pos = nextBookPosition(dest.id);
    const books = db
      .prepare(
        `SELECT b.id FROM books b JOIN rows r ON r.id = b.row_id
         WHERE r.shelf_id = ? ORDER BY r.position, r.id, b.position, b.id`
      )
      .all(id);
    for (const b of books) {
      db.prepare('UPDATE books SET row_id = ?, position = ? WHERE id = ?').run(dest.id, pos++, b.id);
    }
    db.prepare('DELETE FROM rows WHERE shelf_id = ?').run(id);
    db.prepare('DELETE FROM shelves WHERE id = ?').run(id);
  })();
  res.status(204).end();
});

// ---- 段 ----

app.post('/api/shelves/:id/rows', (req, res) => {
  const shelfId = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM shelves WHERE id = ?').get(shelfId)) return res.status(404).end();
  const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM rows WHERE shelf_id = ?').get(shelfId).p;
  const row = db
    .prepare('INSERT INTO rows (shelf_id, name, position) VALUES (?, ?, ?) RETURNING *')
    .get(shelfId, String(req.body.name || '').trim(), pos);
  res.status(201).json(row);
});

// 段の並び順 (同一本棚内)
app.put('/api/shelves/:id/rows/order', (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids が必要です' });
  const upd = db.prepare('UPDATE rows SET position = ? WHERE id = ? AND shelf_id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id, req.params.id)))();
  res.status(204).end();
});

// 段の名前・内寸 (高さ/幅 cm) の編集
app.patch('/api/rows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM rows WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const name = req.body.name !== undefined ? String(req.body.name).trim() : row.name;
  const dim = (v, cur) => {
    if (v === undefined) return cur;
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 300 ? n : cur;
  };
  db.prepare('UPDATE rows SET name = ?, height_cm = ?, width_cm = ? WHERE id = ?').run(
    name,
    dim(req.body.height_cm, row.height_cm),
    dim(req.body.width_cm, row.width_cm),
    req.params.id
  );
  res.status(204).end();
});

// 段を削除 (中の本は同じ本棚の直前の段末尾へ)
app.delete('/api/rows/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM rows WHERE id = ?').get(id);
  if (!row) return res.status(404).end();
  if (db.prepare('SELECT COUNT(*) AS c FROM rows WHERE shelf_id = ?').get(row.shelf_id).c <= 1) {
    return res.status(400).json({ error: '最後の段は削除できません' });
  }
  const dest = db
    .prepare('SELECT id FROM rows WHERE shelf_id = ? AND id != ? ORDER BY position, id LIMIT 1')
    .get(row.shelf_id, id);
  db.transaction(() => {
    let pos = nextBookPosition(dest.id);
    for (const b of db.prepare('SELECT id FROM books WHERE row_id = ? ORDER BY position, id').all(id)) {
      db.prepare('UPDATE books SET row_id = ?, position = ? WHERE id = ?').run(dest.id, pos++, b.id);
    }
    db.prepare('DELETE FROM rows WHERE id = ?').run(id);
  })();
  res.status(204).end();
});

// ドラッグ後の確定: この段の本を ids の順にする (段をまたぐ移動も含む)
app.put('/api/rows/:id/books', (req, res) => {
  const rowId = Number(req.params.id);
  const ids = req.body.ids;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids が必要です' });
  const upd = db.prepare('UPDATE books SET row_id = ?, position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(rowId, i, id)))();
  res.status(204).end();
});

// NDL サムネイルのプロキシ (1日キャッシュ)
app.get('/api/cover/ndl/:isbn', async (req, res) => {
  const isbn = String(req.params.isbn).replace(/\D/g, '');
  if (!isbn) return res.status(400).end();
  try {
    const r = await fetch(`https://ndlsearch.ndl.go.jp/thumbnail/${isbn}.jpg`, { headers: NDL_HEADERS });
    if (!r.ok || !r.headers.get('content-type')?.startsWith('image/')) return res.status(404).end();
    res.set('Content-Type', r.headers.get('content-type'));
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// 表紙の再解決 (プレースホルダ画像や取りこぼしの修復用)
app.post('/api/repair-covers', async (req, res) => {
  const books = db.prepare('SELECT id, isbn, title, cover FROM books WHERE isbn IS NOT NULL').all();
  const results = [];
  for (const b of books) {
    let cover = '';
    try {
      const openbd = await lookupOpenBD(b.isbn);
      cover = openbd?.cover || (await fallbackCover(b.isbn));
    } catch {}
    if (cover !== b.cover) {
      db.prepare('UPDATE books SET cover = ? WHERE id = ?').run(cover, b.id);
      results.push({ id: b.id, title: b.title, cover });
    }
  }
  res.json({ checked: books.length, updated: results });
});

// 寸法の再取得 (既存の ISBN 本の pages / height_cm を NDL から補完)
app.post('/api/repair-dimensions', async (req, res) => {
  const books = db
    .prepare('SELECT id, isbn, title FROM books WHERE isbn IS NOT NULL AND (height_cm IS NULL OR pages IS NULL)')
    .all();
  const results = [];
  for (const b of books) {
    const dims = await ndlDimensions(b.isbn);
    if (dims) {
      db.prepare('UPDATE books SET pages = COALESCE(?, pages), height_cm = COALESCE(?, height_cm) WHERE id = ?')
        .run(dims.pages, dims.height_cm, b.id);
      results.push({ id: b.id, title: b.title, ...dims });
    }
  }
  res.json({ checked: books.length, updated: results });
});

// ---- 棚写真の解析 (Claude Vision) ----

const SHELF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      description: '本棚の段。上の段から順に。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['books'],
        properties: {
          books: {
            type: 'array',
            description: 'その段の本。左から順に。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'author'],
              properties: {
                title: { type: 'string', description: '背表紙から読み取ったタイトル' },
                author: { type: 'string', description: '著者名。読み取れなければ空文字' },
              },
            },
          },
        },
      },
    },
  },
};

app.post('/api/analyze-shelf', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY が未設定です。~/bookshelf/.env に ANTHROPIC_API_KEY=sk-ant-... を書いて再起動してください。',
    });
  }
  const m = String(req.body.image || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/s);
  if (!m) return res.status(400).json({ error: '画像データが不正です' });
  const [, mediaType, data] = m;

  let parsed;
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: SHELF_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            {
              type: 'text',
              text:
                'これは家の本棚の写真です。段の構成と、各段に並んでいる本の背表紙を読み取ってください。' +
                '段は上から順、本は各段の左から順に。タイトルは背表紙の表記のまま。' +
                '著者名が読み取れる場合のみ author に入れ、読めなければ空文字にしてください。' +
                '判読できない本は無理に推測せず省いて構いません。本以外の物 (小物・ファイルボックスなど) は含めないでください。',
            },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal') {
      return res.status(502).json({ error: '解析が拒否されました。別の写真で試してください。' });
    }
    const text = response.content.find((b) => b.type === 'text')?.text || '';
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('analyze failed:', e.message);
    return res.status(502).json({ error: '解析に失敗しました: ' + e.message });
  }

  const rows = (parsed.rows || []).filter((r) => r.books?.length);
  if (!rows.length) return res.status(422).json({ error: '本棚を読み取れませんでした。明るい場所で正面から撮ってみてください。' });

  // 新しい本棚として登録
  const name = String(req.body.name || '').trim() || `写真の本棚 ${db.prepare('SELECT COUNT(*) AS c FROM shelves').get().c + 1}`;
  const result = db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM shelves').get().p;
    const shelf = db.prepare('INSERT INTO shelves (name, position) VALUES (?, ?) RETURNING *').get(name, pos);
    let count = 0;
    rows.forEach((r, i) => {
      const row = db
        .prepare('INSERT INTO rows (shelf_id, position) VALUES (?, ?) RETURNING id')
        .get(shelf.id, i);
      r.books.forEach((b, j) => {
        const title = String(b.title || '').trim();
        if (!title) return;
        insertBook.get({
          isbn: null,
          title,
          author: String(b.author || '').trim(),
          publisher: '',
          pubdate: '',
          cover: '',
          row_id: row.id,
          position: j,
          pages: null,
          height_cm: null,
        });
        count++;
      });
    });
    return { shelf, count, rows: rows.length };
  })();

  res.status(201).json(result);
});

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
  },
  app
);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`bookshelf: https://localhost:${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
