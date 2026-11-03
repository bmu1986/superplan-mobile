// Dropbox transport and the sync round, ported from the desktop (src/main/dropbox.js, src/main/remote.js).
// Cloud layout is identical: <app folder>/superplan.db.gz and <app folder>/files/<sha256>.
// Differences on the phone: attachments are downloaded only when opened (saves space and traffic),
// and the database upload is conditional on the Dropbox revision, so a computer that uploaded in
// the meantime is merged instead of overwritten.
(function (root) {
  const { Store, Blobs, IDB } = root.SP;
  const DB = 'superplan.db.gz';

  // ---------- gzip via the browser's own streams ----------
  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  const isGzip = (b) => b && b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
  const gunzip = (b) => (isGzip(b) ? pipe(b, new DecompressionStream('gzip')) : Promise.resolve(b));
  const gzip = (b) => pipe(b, new CompressionStream('gzip'));

  // ---------- OAuth PKCE (no redirect: Dropbox shows a code, the user pastes it) ----------
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function startAuth(appKey) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const url = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
      client_id: appKey, response_type: 'code', code_challenge: challenge,
      code_challenge_method: 'S256', token_access_type: 'offline',
    });
    return { url, verifier };
  }
  async function finishAuth(appKey, code, verifier) {
    let res;
    try {
      res = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', client_id: appKey, code_verifier: verifier }).toString(),
      });
    } catch (e) { throw new Error(`Нет связи с Dropbox: ${e.message}`); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.refresh_token) throw new Error(`Dropbox не принял код: ${j.error_description || j.error || res.status}`);
    return { refreshToken: j.refresh_token };
  }

  function explain(text) {
    const t = String(text || '');
    if (t.includes('missing_scope') || t.includes('required scope')) return 'У приложения Dropbox не хватает прав: на dropbox.com/developers/apps → ваше приложение → Permissions отметьте files.content.read и files.content.write, нажмите Submit и войдите заново.';
    if (t.includes('expired_access_token') || t.includes('invalid_access_token')) return 'Вход устарел — войдите в Dropbox заново в настройках.';
    return t.slice(0, 300);
  }

  class Dropbox {
    constructor({ appKey, refreshToken }) { this.appKey = appKey; this.refreshToken = refreshToken; this.token = null; this.tokenAt = 0; }

    async call(url, opts) {
      try { return await fetch(url, opts); } catch (e) {
        throw new Error(navigator.onLine === false ? 'Нет интернета.' : `Нет связи с Dropbox: ${e.message}`);
      }
    }
    async accessToken() {
      if (this.token && Date.now() - this.tokenAt < 3 * 3600 * 1000) return this.token;
      const res = await this.call('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.appKey }).toString(),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.access_token) { const e = new Error('Вход в Dropbox устарел. Откройте Настройки и войдите снова.'); e.auth = true; throw e; }
      this.token = j.access_token; this.tokenAt = Date.now();
      return this.token;
    }
    async api(endpoint, body) {
      const res = await this.call(`https://api.dropboxapi.com/2/${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 409) { const t = await res.text(); if (t.includes('not_found')) return null; throw new Error(`Dropbox: ${explain(t)}`); }
      if (!res.ok) throw new Error(`Dropbox: ошибка ${res.status}. ${explain(await res.text())}`);
      return res.json();
    }
    async get(name) {
      const res = await this.call('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Dropbox-API-Arg': JSON.stringify({ path: `/${name}` }) },
      });
      if (res.status === 409) { const t = await res.text(); if (t.includes('not_found')) return null; throw new Error(`Dropbox: ${explain(t)}`); }
      if (!res.ok) throw new Error(`Dropbox: ошибка скачивания ${res.status}. ${explain(await res.text())}`);
      let rev = null;
      try { rev = JSON.parse(res.headers.get('dropbox-api-result') || '{}').rev || null; } catch { /* ignore */ }
      return { data: new Uint8Array(await res.arrayBuffer()), version: rev };
    }
    // ifRev: upload only if the file is still at that revision (null = must not exist yet). Returns null on conflict.
    async put(name, data, ifRev) {
      const mode = ifRev === undefined ? 'overwrite' : ifRev === null ? 'add' : { '.tag': 'update', update: ifRev };
      const res = await this.call('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ path: `/${name}`, mode, mute: true, autorename: false }),
        },
        body: data,
      });
      if (!res.ok) {
        const t = await res.text();
        if (res.status === 409 && t.includes('conflict')) return null;
        if (t.includes('insufficient_space')) throw new Error('В Dropbox закончилось место.');
        throw new Error(`Dropbox: ошибка загрузки ${res.status}. ${explain(t)}`);
      }
      const j = await res.json().catch(() => ({}));
      return { version: j.rev || null };
    }
    async stat(name) {
      const j = await this.api('files/get_metadata', { path: `/${name}` });
      return j ? { version: j.rev || null } : null;
    }
    async list(dir) {
      const out = [];
      let j = await this.api('files/list_folder', { path: `/${dir}`, limit: 2000 });
      while (j) {
        for (const e of j.entries || []) if (e['.tag'] === 'file') out.push({ name: e.name });
        if (!j.has_more) break;
        j = await this.api('files/list_folder/continue', { cursor: j.cursor });
      }
      return out;
    }
    async account() {
      const res = await this.call('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${await this.accessToken()}` } });
      if (!res.ok) throw new Error(`Dropbox: ${res.status}. ${explain(await res.text())}`);
      const j = await res.json();
      return j.email || j.name?.display_name || '';
    }
  }

  async function mergeBuffer(store, buf) {
    const raw = await gunzip(buf);
    if (!raw || !raw.length) return 0;
    const other = await Store.openBuffer(raw);
    try { return store.mergeFrom(other); } finally { other.db.close(); }
  }

  // Attachments added on this device that the cloud does not have yet (kept apart from sync state,
  // so a file added while a sync is running is never forgotten).
  const Pending = {
    async all() { return new Set((await IDB.get('kv', 'pending')) || []); },
    async add(h) { const s = await this.all(); s.add(h); await IDB.set('kv', 'pending', [...s]); },
    async remove(hs) { const s = await this.all(); for (const h of hs) s.delete(h); await IDB.set('kv', 'pending', [...s]); },
  };

  // One sync round. state = { lastVersion }
  async function sync(store, dbx, state = {}, onProgress = () => {}) {
    state = { ...state };
    delete state.pending;
    const seqAtStart = store.changeSeq();
    const dirty = store.isDirty();
    const pending = await Pending.all();
    const res = { taken: 0, at: Date.now(), up: 0, skipped: false };

    const st = await dbx.stat(DB);
    const remoteChanged = st ? st.version !== state.lastVersion : false;
    if (!dirty && !remoteChanged && !pending.size && st) { res.skipped = true; return { ...res, state }; }

    let readVersion = st ? st.version : null;
    if (remoteChanged) {
      onProgress('Скачиваю изменения…');
      const got = await dbx.get(DB);
      if (got) { res.taken += await mergeBuffer(store, got.data); readVersion = got.version || readVersion; }
    }
    if (await store.externalize()) for (const h of store.referencedHashes()) if (await Blobs.has(h)) { pending.add(h); await Pending.add(h); }

    const needUpload = dirty || !st || pending.size > 0;
    if (needUpload) {
      // attachments made on the phone go up first, so the database never points to a missing file
      const refs = store.referencedHashes();
      const up = [...pending].filter((h) => refs.has(h));
      if (up.length) {
        const there = new Set((await dbx.list('files')).map((f) => f.name));
        for (let i = 0; i < up.length; i++) {
          if (!there.has(up[i])) {
            onProgress(`Загружаю вложения: ${i + 1} из ${up.length}`);
            const bytes = await Blobs.read(up[i]);
            if (bytes) { await dbx.put(`files/${up[i]}`, bytes); res.up++; }
          }
        }
      }
      await Pending.remove(pending); // uploaded, or no longer used by any task
      onProgress('Загружаю базу…');
      for (let round = 0; ; round++) {
        store.purge({ vacuum: 'force' });
        const packed = await gzip(store.exportBuffer());
        const put = await dbx.put(DB, packed, round < 3 ? readVersion : undefined);
        if (put) { state.lastVersion = put.version; break; }
        // someone else uploaded in between: merge theirs, then try again
        const got = await dbx.get(DB);
        if (got) { res.taken += await mergeBuffer(store, got.data); readVersion = got.version; }
      }
    } else {
      state.lastVersion = readVersion;
    }
    store.markSynced(seqAtStart);
    await store.saveNow();
    return { ...res, state };
  }

  // Attachment bytes: local copy if present, otherwise downloaded from Dropbox and kept.
  async function attachmentBytes(dbx, hash) {
    let b = await Blobs.read(hash);
    if (b) return b;
    if (!dbx) throw new Error('Файл есть только на компьютере. Подключите Dropbox, чтобы открыть его.');
    const got = await dbx.get(`files/${hash}`);
    if (!got) throw new Error('Этого файла ещё нет в Dropbox. Синхронизируйте компьютер, где его добавили.');
    await Blobs.putVerified(hash, got.data);
    return got.data;
  }

  root.SP = Object.assign(root.SP || {}, { Dropbox, startAuth, finishAuth, sync, attachmentBytes, Pending, gzip, gunzip, DBNAME: DB, IDB });
})(window);
