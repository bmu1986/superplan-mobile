// Browser port of the desktop Store (src/main/db.js): the same SQLite schema and the same
// row-level "newest updated_at wins" merge, so the phone and the computers share one database file.
// The working copy lives in IndexedDB; attachments are content-addressed blobs (sha256) in IndexedDB too.
(function (root) {
  const SCHEMA_VERSION = 1;
  const SYNC_TABLES = ['folders', 'tags', 'tasks', 'task_tags', 'attachments', 'settings'];
  const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, sort REAL DEFAULT 0,
  expanded INTEGER DEFAULT 1, icon_color TEXT, icon TEXT,
  updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort REAL DEFAULT 0,
  updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, folder_id TEXT, title TEXT NOT NULL, done INTEGER DEFAULT 0,
  done_at INTEGER, due_at INTEGER, due_has_time INTEGER DEFAULT 0, remind_at INTEGER,
  color TEXT, notes TEXT DEFAULT '', sort REAL DEFAULT 0, created_at INTEGER, repeat TEXT, priority INTEGER DEFAULT 1, checklist TEXT, kind TEXT, fav INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_tags (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, tag_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT,
  target TEXT, os TEXT, mime TEXT, size INTEGER, data BLOB, hash TEXT, created_at INTEGER,
  updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL, deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_folder ON tasks(folder_id);
CREATE INDEX IF NOT EXISTS idx_tt_task ON task_tags(task_id);
CREATE INDEX IF NOT EXISTS idx_att_task ON attachments(task_id);
`;

  // ---------- IndexedDB key/value ----------
  const IDB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('superplan', 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('blobs'); };
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async op(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('IndexedDB aborted'));
      });
    },
    get(store, k) { return this.op(store, 'readonly', (s) => s.get(k)); },
    set(store, k, v) { return this.op(store, 'readwrite', (s) => s.put(v, k)); },
    del(store, k) { return this.op(store, 'readwrite', (s) => s.delete(k)); },
    keys(store) { return this.op(store, 'readonly', (s) => s.getAllKeys()); },
  };

  // ---------- attachments (content addressed) ----------
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const Blobs = {
    async sha256(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); },
    async has(h) { return !!(await IDB.get('blobs', h)); },
    async read(h) { return IDB.get('blobs', h); }, // Uint8Array or undefined
    async put(bytes) { const h = await this.sha256(bytes); await IDB.set('blobs', h, new Uint8Array(bytes)); return h; },
    async putVerified(h, bytes) { if ((await this.sha256(bytes)) !== h) throw new Error('файл вложения повреждён при скачивании'); await IDB.set('blobs', h, new Uint8Array(bytes)); },
    async list() { return IDB.keys('blobs'); },
    async del(h) { return IDB.del('blobs', h); },
  };

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }));
  const now = () => Date.now();
  let SQL = null;
  async function sql() {
    if (!SQL) SQL = await initSqlJs({ locateFile: (f) => `vendor/${f}` });
    return SQL;
  }

  class Store {
    constructor() { this.db = null; this.saveTimer = null; this.listeners = new Set(); this.persist = false; }

    static async open() {
      const S = await sql();
      const s = new Store();
      s.persist = true;
      const bytes = await IDB.get('kv', 'db');
      s.db = bytes ? new S.Database(bytes) : new S.Database();
      s.db.run(SCHEMA);
      s.migrate();
      try { s.purge({ vacuum: false }); } catch { /* never block start-up */ }
      await s.saveNow();
      return s;
    }

    static async openBuffer(buf) {
      const S = await sql();
      const s = new Store();
      s.db = new S.Database(buf);
      s.db.run(SCHEMA);
      s.addColumns();
      return s;
    }

    // Replace the whole local database (first connection to a cloud that already has data).
    async replaceWith(buf) {
      const S = await sql();
      const old = this.db;
      this.db = new S.Database(buf);
      this.db.run(SCHEMA);
      this.migrate(true);
      old.close();
      this.changed(false);
    }

    addColumns() {
      if (!this.all('PRAGMA table_info(folders)').some((c) => c.name === 'icon')) this.db.run('ALTER TABLE folders ADD COLUMN icon TEXT');
      const tcols = this.all('PRAGMA table_info(tasks)').map((c) => c.name);
      if (!tcols.includes('repeat')) this.db.run('ALTER TABLE tasks ADD COLUMN repeat TEXT');
      if (!tcols.includes('priority')) this.db.run('ALTER TABLE tasks ADD COLUMN priority INTEGER DEFAULT 1');
      if (!tcols.includes('checklist')) this.db.run('ALTER TABLE tasks ADD COLUMN checklist TEXT');
      if (!tcols.includes('kind')) this.db.run('ALTER TABLE tasks ADD COLUMN kind TEXT');
      if (!tcols.includes('fav')) this.db.run('ALTER TABLE tasks ADD COLUMN fav INTEGER DEFAULT 0');
      if (!this.all('PRAGMA table_info(attachments)').some((c) => c.name === 'hash')) this.db.run('ALTER TABLE attachments ADD COLUMN hash TEXT');
    }

    migrate(newDevice = false) {
      if (!this.get("SELECT value FROM meta WHERE key = 'schema'")) this.db.run('INSERT OR REPLACE INTO meta VALUES (?, ?)', ['schema', String(SCHEMA_VERSION)]);
      this.addColumns();
      if (newDevice || !this.get("SELECT value FROM meta WHERE key = 'device'")) this.db.run('INSERT OR REPLACE INTO meta VALUES (?, ?)', ['device', uid()]);
      if (newDevice) { this.meta('change_seq', 0); this.meta('synced_seq', 0); }
    }

    meta(key, value) {
      if (value === undefined) { const r = this.get('SELECT value FROM meta WHERE key = ?', [key]); return r ? r.value : null; }
      this.db.run('INSERT OR REPLACE INTO meta VALUES (?, ?)', [key, String(value)]);
      return value;
    }
    changeSeq() { return Number(this.meta('change_seq') || 0); }
    isDirty() { return this.changeSeq() > Number(this.meta('synced_seq') || 0); }
    markSynced(seq) { this.meta('synced_seq', seq); this.scheduleSave(); }
    isEmpty() { return !this.get('SELECT 1 AS x FROM tasks LIMIT 1') && !this.get('SELECT 1 AS x FROM folders LIMIT 1'); }

    all(q, params = []) {
      const st = this.db.prepare(q);
      st.bind(params);
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      st.free();
      return rows;
    }
    get(q, params = []) { return this.all(q, params)[0]; }
    run(q, params = []) { this.db.run(q, params); this.changed(); }

    changed(local = true) {
      if (local) this.meta('change_seq', this.changeSeq() + 1);
      this.scheduleSave();
      for (const l of this.listeners) l(local);
    }
    onChange(fn) { this.listeners.add(fn); }

    scheduleSave() {
      if (!this.persist) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.saveNow(), 300);
    }
    async saveNow() {
      if (!this.persist) return;
      clearTimeout(this.saveTimer);
      await IDB.set('kv', 'db', this.db.export());
    }
    exportBuffer() { return this.db.export(); }

    upsert(table, row) {
      const r = { ...row, updated_at: now() };
      if (!r.id) r.id = uid();
      const cols = Object.keys(r);
      const existing = this.get(`SELECT id FROM ${table} WHERE id = ?`, [r.id]);
      if (existing) {
        const sets = cols.filter((c) => c !== 'id').map((c) => `${c} = ?`).join(', ');
        this.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...cols.filter((c) => c !== 'id').map((c) => r[c]), r.id]);
      } else {
        this.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => r[c]));
      }
      return r.id;
    }

    softDelete(table, id) {
      const t = now();
      if (table === 'attachments') this.db.run('UPDATE attachments SET deleted = 1, data = NULL, updated_at = ? WHERE id = ?', [t, id]);
      else this.db.run(`UPDATE ${table} SET deleted = 1, updated_at = ? WHERE id = ?`, [t, id]);
      if (table === 'tasks') this.dropTaskChildren([id], t);
      this.changed();
    }

    dropTaskChildren(taskIds, t = now()) {
      for (const id of taskIds) {
        this.db.run('UPDATE attachments SET deleted = 1, data = NULL, updated_at = ? WHERE task_id = ? AND deleted = 0', [t, id]);
        this.db.run('UPDATE task_tags SET deleted = 1, updated_at = ? WHERE task_id = ? AND deleted = 0', [t, id]);
      }
    }

    purge({ vacuum = true } = {}) {
      const t = now();
      this.db.run('UPDATE attachments SET deleted = 1, data = NULL, updated_at = ? WHERE deleted = 0 AND task_id IN (SELECT id FROM tasks WHERE deleted = 1)', [t]);
      this.db.run('UPDATE task_tags SET deleted = 1, updated_at = ? WHERE deleted = 0 AND task_id IN (SELECT id FROM tasks WHERE deleted = 1)', [t]);
      this.db.run('UPDATE attachments SET data = NULL WHERE deleted = 1 AND data IS NOT NULL');
      const free = this.get('PRAGMA freelist_count').freelist_count * this.get('PRAGMA page_size').page_size;
      const compact = vacuum === 'force' ? free > 0 : vacuum && free > 64 * 1024;
      if (compact) this.db.run('VACUUM');
      return { compacted: compact };
    }

    // Old databases kept attachment bytes inside; the phone moves them into the blob store like the desktop does.
    async externalize() {
      const rows = this.all('SELECT id, data FROM attachments WHERE data IS NOT NULL AND deleted = 0');
      const t = now();
      for (const r of rows) {
        const hash = await Blobs.put(r.data);
        this.db.run('UPDATE attachments SET hash = ?, data = NULL, updated_at = ? WHERE id = ?', [hash, t, r.id]);
      }
      if (rows.length) this.changed(false);
      return rows.length;
    }

    referencedHashes() {
      return new Set(this.all('SELECT DISTINCT hash FROM attachments WHERE deleted = 0 AND hash IS NOT NULL').map((r) => r.hash));
    }

    getSettings() {
      const out = {};
      for (const r of this.all('SELECT id, value FROM settings WHERE deleted = 0')) {
        try { out[r.id] = JSON.parse(r.value); } catch { /* ignore */ }
      }
      return out;
    }
    setSetting(key, value) { this.upsert('settings', { id: key, value: JSON.stringify(value) }); }

    snapshot() {
      return {
        folders: this.all('SELECT * FROM folders WHERE deleted = 0 ORDER BY sort, name'),
        tags: this.all('SELECT * FROM tags WHERE deleted = 0 ORDER BY sort, name'),
        tasks: this.all(`SELECT id, folder_id, title, done, done_at, due_at, due_has_time, remind_at, color, repeat, priority, checklist, kind, fav,
                         sort, created_at, updated_at,
                         (SELECT COUNT(*) FROM attachments a WHERE a.task_id = tasks.id AND a.deleted = 0) AS att_count,
                         (length(notes) > 0 AND notes <> '<p><br></p>') AS has_notes
                         FROM tasks WHERE deleted = 0 ORDER BY sort, created_at`),
        taskTags: this.all('SELECT task_id, tag_id FROM task_tags WHERE deleted = 0'),
        settings: this.getSettings(),
      };
    }

    taskDetail(id) {
      const task = this.get('SELECT * FROM tasks WHERE id = ?', [id]);
      if (!task) return null;
      task.attachments = this.all('SELECT id, kind, name, target, os, mime, size, hash, created_at FROM attachments WHERE task_id = ? AND deleted = 0 ORDER BY created_at', [id]);
      task.tagIds = this.all('SELECT tag_id FROM task_tags WHERE task_id = ? AND deleted = 0', [id]).map((r) => r.tag_id);
      return task;
    }

    setTaskTags(taskId, tagIds) {
      const t = now();
      const current = this.all('SELECT id, tag_id, deleted FROM task_tags WHERE task_id = ?', [taskId]);
      const want = new Set(tagIds);
      for (const r of current) {
        const shouldDelete = want.has(r.tag_id) ? 0 : 1;
        if (r.deleted !== shouldDelete) this.db.run('UPDATE task_tags SET deleted = ?, updated_at = ? WHERE id = ?', [shouldDelete, t, r.id]);
        want.delete(r.tag_id);
      }
      for (const tagId of want) this.db.run('INSERT INTO task_tags (id, task_id, tag_id, updated_at) VALUES (?,?,?,?)', [`${taskId}:${tagId}`, taskId, tagId, t]);
      this.changed();
    }

    deleteFolder(id) {
      const ids = [id];
      for (let i = 0; i < ids.length; i++) for (const c of this.all('SELECT id FROM folders WHERE parent_id = ? AND deleted = 0', [ids[i]])) ids.push(c.id);
      const t = now();
      for (const f of ids) {
        this.db.run('UPDATE folders SET deleted = 1, updated_at = ? WHERE id = ?', [t, f]);
        const tasks = this.all('SELECT id FROM tasks WHERE folder_id = ? AND deleted = 0', [f]).map((r) => r.id);
        this.db.run('UPDATE tasks SET deleted = 1, updated_at = ? WHERE folder_id = ? AND deleted = 0', [t, f]);
        this.dropTaskChildren(tasks, t);
      }
      this.changed();
    }

    search(q) {
      const needle = String(q || '').trim().toLowerCase();
      const out = {};
      if (!needle) return out;
      const plain = (html) => String(html || '').replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, ' ').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      for (const a of this.all('SELECT a.task_id, a.name, a.target FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.deleted = 0 AND t.deleted = 0')) {
        if (out[a.task_id]) continue;
        if (String(a.name || '').toLowerCase().includes(needle) || (a.target && String(a.target).toLowerCase().includes(needle))) out[a.task_id] = { kind: 'att', name: a.name };
      }
      for (const t of this.all("SELECT id, notes FROM tasks WHERE deleted = 0 AND notes IS NOT NULL AND notes <> ''")) {
        if (out[t.id]) continue;
        const text = plain(t.notes);
        const i = text.toLowerCase().indexOf(needle);
        if (i >= 0) out[t.id] = { kind: 'notes', snippet: (i > 30 ? '…' : '') + text.slice(Math.max(0, i - 30), i + needle.length + 40).replace(/\s+/g, ' ').trim() };
      }
      return out;
    }

    // Same rule as the desktop: take every row that is newer there (or missing here).
    mergeFrom(other) {
      let taken = 0;
      for (const table of SYNC_TABLES) {
        const cols = this.all(`PRAGMA table_info(${table})`).map((c) => c.name);
        const otherCols = new Set(other.all(`PRAGMA table_info(${table})`).map((c) => c.name));
        const useCols = cols.filter((c) => otherCols.has(c));
        const mine = new Map(this.all(`SELECT id, updated_at FROM ${table}`).map((r) => [r.id, r.updated_at]));
        const st = other.db.prepare(`SELECT ${useCols.join(',')} FROM ${table}`);
        while (st.step()) {
          const r = st.getAsObject();
          const local = mine.get(r.id);
          if (local === undefined || r.updated_at > local) {
            this.db.run(`INSERT OR REPLACE INTO ${table} (${useCols.join(',')}) VALUES (${useCols.map(() => '?').join(',')})`, useCols.map((c) => r[c]));
            taken++;
          }
        }
        st.free();
      }
      if (taken) this.changed(false);
      return taken;
    }
  }

  root.SP = Object.assign(root.SP || {}, { Store, Blobs, IDB, uid });
})(window);
