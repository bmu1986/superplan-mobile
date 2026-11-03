// SuperPlan for iPhone / iPad (installable web app). Same data and rules as the desktop app.
(function () {
  const { Store, Blobs, IDB, Dropbox, startAuth, finishAuth, sync, attachmentBytes, Pending } = window.SP;
  const I = window.Icons;
  const VERSION = '0.2.0';

  // ---------- tiny DOM helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el[k] = v;
      else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk.startsWith('--') ? sk : sk.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), sv);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }

  // ---------- dates ----------
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const sod = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const eod = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  const sameDay = (a, b) => a && b && new Date(a).toDateString() === new Date(b).toDateString();
  const fmtTime = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  function fmtDay(ts) {
    const d = new Date(ts);
    const diff = Math.round((sod(d) - sod(new Date())) / DAY);
    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Завтра';
    if (diff === -1) return 'Вчера';
    return `${d.getDate()} ${MON_SHORT[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}, ${WD[d.getDay()]}`;
  }
  const fmtDue = (t) => (t.due_at ? fmtDay(t.due_at) + (t.due_has_time ? `, ${fmtTime(t.due_at)}` : '') : '');
  const toDateInput = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const toDTInput = (ts) => `${toDateInput(ts)}T${fmtTime(ts)}`;
  function relTime(ts) {
    if (!ts) return 'ещё не было';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'только что';
    if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
    if (sameDay(ts, Date.now())) return `сегодня в ${fmtTime(ts)}`;
    return `${fmtDay(ts)} ${fmtTime(ts)}`;
  }

  // ---------- state ----------
  let store = null;
  let dbx = null;
  const state = {
    snap: { folders: [], tags: [], tasks: [], taskTags: [], settings: {} },
    view: { type: 'today' },
    selectedId: null,
    search: null, // null = closed, string = open
    searchHits: null,
    showDone: false,
    justDone: null,
    sync: { running: false, msg: '' },
  };
  let cfg = { theme: 'auto', showDone: false, offlineFiles: true };
  let localBlobs = new Set(); // attachment hashes stored on this device
  const offline = { running: false, done: 0, total: 0, failed: 0 };
  const saveCfg = () => IDB.set('kv', 'cfg', cfg);

  const wideMQ = matchMedia('(min-width: 768px)');
  const threeMQ = matchMedia('(min-width: 1080px)');
  const isWide = () => wideMQ.matches;

  // ---------- data helpers (same rules as desktop) ----------
  const isNote = (t) => !!t && t.kind === 'note';
  const prio = (t) => (t.priority ?? 1);
  const folderById = (id) => state.snap.folders.find((f) => f.id === id);
  const tagById = (id) => state.snap.tags.find((t) => t.id === id);
  const taskById = (id) => state.snap.tasks.find((t) => t.id === id);
  const childrenOf = (pid) => state.snap.folders.filter((f) => (f.parent_id || null) === (pid || null));
  const PROJECT_COLORS = ['#2ab0c5', '#f5c518', '#6cc644', '#e8743b', '#9b59b6', '#3498db', '#e84393'];
  const SUBFOLDER_COLOR = '#f0a020';
  function projectColor(f) {
    if (f.icon_color) return f.icon_color;
    const i = childrenOf(null).findIndex((r) => r.id === f.id);
    return PROJECT_COLORS[(i < 0 ? 0 : i) % PROJECT_COLORS.length];
  }
  function folderIcon(f, n = 22) {
    const isRoot = !f.parent_id;
    if (f.icon && I.glyphs && I.glyphs[f.icon]) return isRoot ? I.glyphTile(f.icon, projectColor(f), n) : I.glyph(f.icon, f.icon_color || SUBFOLDER_COLOR, n - 1);
    return isRoot ? I.folderFilled(projectColor(f), n) : I.folder(f.icon_color || SUBFOLDER_COLOR, n - 1);
  }
  function folderPath(id) {
    const parts = [];
    let f = folderById(id);
    for (let i = 0; f && i < 20; i++) { parts.unshift(f.name); f = folderById(f.parent_id); }
    return parts.join(' / ');
  }
  function isToday(t) {
    if (isNote(t)) return false;
    const end = eod(new Date()).getTime();
    return (t.due_at && t.due_at <= end) || (t.remind_at && t.remind_at <= end);
  }
  const parseChecklist = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  function sortForPriority(folderId, p, excludeId) {
    const list = state.snap.tasks.filter((t) => !t.done && t.folder_id === folderId && t.id !== excludeId).sort((a, b) => a.sort - b.sort);
    if (!list.length) return 0;
    if (p === 2) return list[0].sort - 1;
    if (p === 0) return list[list.length - 1].sort + 1;
    let idx = -1;
    list.forEach((t, i) => { if (prio(t) === 2) idx = i; });
    if (idx < 0) return list[0].sort - 1;
    const a = list[idx].sort; const b = list[idx + 1]?.sort;
    return b === undefined ? a + 1 : (a + b) / 2;
  }

  function upsert(table, row) { const id = store.upsert(table, row); reload(); return id; }

  function visibleTasks() {
    const v = state.view;
    let list = state.snap.tasks;
    const q = (state.search || '').trim().toLowerCase();
    if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || (state.searchHits && state.searchHits[t.id]));
    else if (v.type === 'today') list = list.filter((t) => !isNote(t) && (t.done ? sameDay(t.done_at, Date.now()) : isToday(t)));
    else if (v.type === 'folder') list = list.filter((t) => t.folder_id === v.id);
    else if (v.type === 'tag') { const ids = new Set(state.snap.taskTags.filter((x) => x.tag_id === v.id).map((x) => x.task_id)); list = list.filter((t) => ids.has(t.id)); }
    else if (v.type === 'all') list = list.filter((t) => !isNote(t));
    else if (v.type === 'notes') list = list.filter(isNote);
    else if (v.type === 'fav') list = list.filter((t) => t.fav);
    if (!state.showDone) list = list.filter((t) => !t.done || t.id === state.justDone);
    const byDate = v.type === 'today' && !q;
    const rest = list.filter((t) => !isNote(t));
    const notes = list.filter(isNote).sort(v.type === 'notes' || q ? (a, b) => (b.updated_at || 0) - (a.updated_at || 0) : (a, b) => a.sort - b.sort);
    const undone = rest.filter((t) => !t.done || t.id === state.justDone);
    const done = rest.filter((t) => t.done && t.id !== state.justDone).sort((a, b) => (b.done_at || 0) - (a.done_at || 0));
    if (byDate) undone.sort((a, b) => prio(b) - prio(a) || (a.due_at || 0) - (b.due_at || 0) || a.sort - b.sort);
    return { undone, notes, done };
  }

  function viewTitle() {
    if (state.search != null) return 'Поиск';
    const v = state.view;
    const d = new Date();
    if (v.type === 'today') return 'Сегодня';
    if (v.type === 'folder') return folderById(v.id)?.name || '—';
    if (v.type === 'tag') return tagById(v.id)?.name || 'Метка';
    if (v.type === 'all') return 'Все задачи';
    if (v.type === 'notes') return 'Заметки';
    if (v.type === 'fav') return 'Избранное';
    if (v.type === 'projects') return 'Проекты';
    if (v.type === 'settings') return 'Настройки';
    return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  }

  // ---------- theme ----------
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const dark = cfg.theme === 'dark' || (cfg.theme !== 'light' && darkMQ.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? '#16181c' : '#f6f7f9';
  }
  darkMQ.addEventListener('change', applyTheme);

  // ---------- toast ----------
  let toastTimer = null;
  function toast(text, actionText, action, ms = 3500) {
    const el = $('#toast');
    el.innerHTML = '';
    el.append(h('span', {}, text));
    if (actionText) el.append(h('button', { onclick: () => { el.classList.remove('show'); action(); } }, actionText));
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ---------- sheets (bottom on phone, centred card on iPad) ----------
  function sheet(title, body, { onClose, full = false } = {}) {
    const wrap = h('div', { class: 'sheet-wrap' });
    const close = () => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 250); onClose && onClose(); };
    const card = h('div', { class: 'sheet' + (full ? ' full' : '') },
      h('div', { class: 'sheet-head' }, h('span', { class: 'grip' }), h('b', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', html: I.close(18), onclick: close })),
      h('div', { class: 'sheet-body' }, body));
    wrap.append(h('div', { class: 'scrim', onclick: close }), card);
    $('#sheets').append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    return { close, card };
  }
  // list of choices; resolves with the chosen value (undefined if dismissed)
  function choose(title, items) {
    return new Promise((res) => {
      let done = false;
      const body = h('div', { class: 'menu' }, items.map((it) => it.sep ? h('div', { class: 'menu-sep' }) : h('button', {
        class: 'menu-item' + (it.danger ? ' danger' : '') + (it.on ? ' on' : ''),
        onclick: () => { done = true; s.close(); res(it.value); },
      }, it.icon ? h('span', { class: 'mi-ic', html: it.icon }) : null, h('span', { class: 'mi-label' }, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null, it.on ? h('span', { class: 'mi-check', html: I.check(14) }) : null)));
      const s = sheet(title, body, { onClose: () => { if (!done) res(undefined); } });
    });
  }
  function prompt(title, value = '', { placeholder = '', ok = 'Готово' } = {}) {
    return new Promise((res) => {
      let done = false;
      const inp = h('input', { class: 'field', value, placeholder, enterkeyhint: 'done' });
      const submit = () => { done = true; s.close(); res(inp.value.trim()); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      const s = sheet(title, h('div', { class: 'form' }, inp, h('button', { class: 'btn primary', onclick: submit }, ok)), { onClose: () => { if (!done) res(null); } });
      setTimeout(() => inp.focus(), 60);
    });
  }
  function confirmDlg(title, text, okText = 'Удалить') {
    return choose(title, [{ label: okText, value: true, danger: true }, { label: 'Отмена', value: false }]).then((v) => v === true);
  }

  // ---------- render ----------
  function render() {
    document.body.classList.toggle('wide', isWide());
    document.body.classList.toggle('three', threeMQ.matches);
    renderSide();
    renderTabs();
    renderBar();
    renderList();
    renderDetail();
  }

  function navItem({ icon, label, count, active, onclick, depth = 0, chev, onchev, cls = '' }) {
    const row = h('div', { class: `nav ${cls}${active ? ' active' : ''}`, style: { paddingLeft: `${12 + depth * 18}px` }, onclick },
      chev ? h('button', { class: 'chev ' + chev, html: I.chevRight(14), onclick: (e) => { e.stopPropagation(); onchev(); } }) : h('span', { class: 'chev-sp' }),
      h('span', { class: 'nav-ic', html: icon }), h('span', { class: 'nav-label' }, label), count ? h('span', { class: 'count' }, count) : null);
    return row;
  }

  function navList({ forSide }) {
    const out = [];
    const v = state.view;
    const act = (type, id) => state.search == null && v.type === type && (id === undefined || v.id === id);
    const tasks = state.snap.tasks;
    if (forSide) {
      const now = new Date();
      out.push(navItem({ icon: I.today(22), label: `Сегодня, ${now.getDate()} ${MON_SHORT[now.getMonth()]}, ${WD[now.getDay()]}`, count: tasks.filter((t) => !t.done && isToday(t)).length || null, active: act('today'), onclick: () => setView({ type: 'today' }) }));
      out.push(navItem({ icon: I.inbox(22), label: 'Все задачи', count: tasks.filter((t) => !t.done && !isNote(t)).length || null, active: act('all'), onclick: () => setView({ type: 'all' }) }));
      out.push(navItem({ icon: I.bookmark(21, '#e5484d'), label: 'Избранное', count: tasks.filter((t) => t.fav && !t.done).length || null, active: act('fav'), onclick: () => setView({ type: 'fav' }) }));
    }
    out.push(navItem({ icon: I.noteBig(22), label: 'Заметки', count: tasks.filter(isNote).length || null, active: act('notes'), onclick: () => setView({ type: 'notes' }) }));
    out.push(h('div', { class: 'sec' }, h('span', {}, 'Мои проекты'), h('button', { class: 'sec-add', html: I.plus(18), 'aria-label': 'Новый проект', onclick: () => newFolder(null) })));
    const collapsed = new Set(cfg.collapsed || []);
    const walk = (pid, depth) => {
      for (const f of childrenOf(pid)) {
        const kids = childrenOf(f.id);
        const count = tasks.filter((t) => t.folder_id === f.id && !t.done && !isNote(t)).length;
        out.push(navItem({
          icon: folderIcon(f), label: f.name, count: count || null, depth, active: act('folder', f.id),
          chev: kids.length ? (collapsed.has(f.id) ? 'closed' : 'open') : null,
          onchev: () => { collapsed.has(f.id) ? collapsed.delete(f.id) : collapsed.add(f.id); cfg.collapsed = [...collapsed]; saveCfg(); render(); },
          onclick: () => setView({ type: 'folder', id: f.id, from: isWide() ? null : 'projects' }),
        }));
        if (kids.length && !collapsed.has(f.id)) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    if (!state.snap.folders.length) out.push(h('div', { class: 'empty small' }, 'Проектов пока нет. Подключите Dropbox в настройках, чтобы увидеть проекты с компьютера.'));
    if (state.snap.tags.length) {
      out.push(h('div', { class: 'sec' }, h('span', {}, 'Метки')));
      for (const t of state.snap.tags) out.push(navItem({ icon: I.tag(t.color, 20), label: t.name, active: act('tag', t.id), onclick: () => setView({ type: 'tag', id: t.id, from: isWide() ? null : 'projects' }) }));
    }
    return out;
  }

  function renderSide() {
    const el = $('#side');
    if (!isWide()) { el.innerHTML = ''; return; }
    const scroll = el.querySelector('.side-scroll')?.scrollTop || 0;
    el.innerHTML = '';
    const box = h('div', { class: 'side-scroll' }, h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'SuperPlan'), navList({ forSide: true }));
    el.append(box, h('div', { class: 'side-foot' },
      navItem({ icon: I.gear(21), label: 'Настройки', active: state.view.type === 'settings', onclick: () => setView({ type: 'settings' }) }),
      syncButton()));
    box.scrollTop = scroll;
  }

  function renderTabs() {
    const el = $('#tabs');
    el.innerHTML = '';
    if (isWide()) return;
    const v = state.view.type;
    const tab = (id, icon, label, active) => h('button', { class: 'tab' + (active ? ' active' : ''), onclick: () => { state.search = null; setView({ type: id }); } }, h('span', { html: icon }), h('small', {}, label));
    const todayN = state.snap.tasks.filter((t) => !t.done && isToday(t)).length;
    const t1 = tab('today', I.today(24), 'Сегодня', v === 'today');
    if (todayN) t1.append(h('i', { class: 'badge' }, todayN));
    el.append(t1,
      tab('all', I.inbox(24), 'Все', v === 'all'),
      tab('fav', I.bookmark(23, 'currentColor'), 'Избранное', v === 'fav'),
      tab('projects', I.folder('currentColor', 24), 'Проекты', ['projects', 'folder', 'notes', 'tag'].includes(v)),
      tab('settings', I.gear(24), 'Настройки', v === 'settings'));
  }

  function syncButton() {
    const connected = !!cfg.refreshToken;
    const b = h('button', {
      class: 'sync-btn' + (state.sync.running ? ' running' : '') + (cfg.lastError ? ' err' : ''),
      'aria-label': 'Синхронизировать',
      html: I.sync(20),
      onclick: () => (connected ? syncNow({ manual: true }) : setView({ type: 'settings' })),
    });
    b.title = connected ? (cfg.lastError ? `Ошибка: ${cfg.lastError}` : `Синхронизация: ${relTime(cfg.lastSync)}`) : 'Dropbox не подключён';
    return b;
  }

  function renderBar() {
    const el = $('#bar');
    el.innerHTML = '';
    const v = state.view;
    if (state.search != null) {
      const inp = h('input', { class: 'search', type: 'search', placeholder: 'Название, описание, вложения', value: state.search, enterkeyhint: 'search' });
      inp.oninput = () => { state.search = inp.value; state.searchHits = inp.value.trim() ? store.search(inp.value) : null; renderList(); };
      el.append(h('div', { class: 'bar-row' }, inp, h('button', { class: 'txt-btn', onclick: () => { state.search = null; state.searchHits = null; render(); } }, 'Отмена')));
      setTimeout(() => { if (document.activeElement !== inp && !inp.dataset.f) { inp.dataset.f = 1; inp.focus(); } }, 30);
      return;
    }
    const back = !isWide() && v.from ? h('button', { class: 'back', onclick: () => setView({ type: v.from }) }, h('span', { html: I.chevLeft(20) }), 'Проекты') : null;
    const actions = h('div', { class: 'bar-actions' });
    if (!['settings', 'projects'].includes(v.type)) {
      actions.append(h('button', { class: 'icon-btn', 'aria-label': 'Поиск', html: I.search(21), onclick: () => { state.search = ''; render(); } }));
      actions.append(h('button', { class: 'icon-btn' + (state.showDone ? ' on' : ''), 'aria-label': 'Выполненные', title: 'Показывать выполненные', html: I.check(19), onclick: () => { state.showDone = !state.showDone; cfg.showDone = state.showDone; saveCfg(); renderList(); renderBar(); } }));
    }
    if (v.type === 'folder') actions.append(h('button', { class: 'icon-btn', 'aria-label': 'Проект', html: '<b class="dots">•••</b>', onclick: () => folderMenu(folderById(v.id)) }));
    if (!isWide()) actions.append(syncButton());
    let sub = '';
    if (v.type === 'today') { const d = new Date(); sub = `${WD_FULL[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`; }
    if (v.type === 'folder') { const p = folderPath(v.id); sub = p.includes(' / ') ? p.slice(0, p.lastIndexOf(' / ')) : ''; }
    el.append(...[h('div', { class: 'bar-row' }, back || h('span'), actions),
      h('h1', {}, v.type === 'folder' ? h('span', { class: 'h1-ic', html: folderIcon(folderById(v.id) || {}, 28) }) : null, viewTitle()),
      sub ? h('div', { class: 'sub' }, sub) : null].filter(Boolean));
  }

  // ---------- list ----------
  function taskRow(t) {
    const note = isNote(t);
    const p = prio(t);
    const cb = note ? h('span', { class: 'note-ic', html: I.note(20) }) : h('button', {
      class: `cb${t.done ? ' on' : ''} p${p}`, 'aria-label': t.done ? 'Вернуть' : 'Выполнить', html: t.done ? I.check(13) : '',
      onclick: (e) => { e.stopPropagation(); toggleDone(t); },
    });
    const meta = h('div', { class: 'meta' });
    const now = Date.now();
    if (t.due_at && !note) {
      const cls = !t.done && t.due_at < (t.due_has_time ? now : sod(new Date()).getTime()) ? 'over' : sameDay(t.due_at, now) ? 'today' : '';
      meta.append(h('span', { class: `chip due ${cls}`, html: I.calendar(13) + esc(fmtDue(t)) }));
    }
    if (t.remind_at && !t.done) meta.append(h('span', { class: 'chip bell' + (t.remind_at <= now ? ' ring' : ''), html: I.bell(13) + esc(sameDay(t.remind_at, now) ? fmtTime(t.remind_at) : `${fmtDay(t.remind_at)}, ${fmtTime(t.remind_at)}`) }));
    if (t.repeat) meta.append(h('span', { class: 'chip', html: I.repeat(13) }));
    const cl = parseChecklist(t.checklist);
    if (cl.length) meta.append(h('span', { class: 'chip' + (cl.every((x) => x.done) ? ' ok' : ''), html: I.checklist(13) + `${cl.filter((x) => x.done).length}/${cl.length}` }));
    if (t.att_count) meta.append(h('span', { class: 'chip', html: I.clip(13) + t.att_count }));
    if (t.has_notes && !note) meta.append(h('span', { class: 'chip', html: I.list ? I.list(13) : '≡' }));
    if (state.view.type !== 'folder' || state.search != null) { const f = folderById(t.folder_id); if (f) meta.append(h('span', { class: 'chip folder' }, f.name)); }
    for (const tt of state.snap.taskTags.filter((x) => x.task_id === t.id)) { const tg = tagById(tt.tag_id); if (tg) meta.append(h('span', { class: 'chip tagc', style: { background: tg.color } }, tg.name)); }
    const hit = state.searchHits && state.searchHits[t.id];
    const title = h('div', { class: 'title' }, p === 2 && !note ? h('b', { class: 'pmark' }, '!') : null, p === 0 && !note ? h('span', { class: 'pmark low' }, '↓') : null, t.title);
    const row = h('div', { class: `row${t.done ? ' done' : ''}${note ? ' is-note' : ''} p${p}${state.selectedId === t.id ? ' sel' : ''}`, 'data-id': t.id, onclick: () => openTask(t.id) },
      cb,
      h('div', { class: 'rmain' }, title, meta.childNodes.length ? meta : null, hit ? h('div', { class: 'hit' }, hit.kind === 'att' ? `Вложение: ${hit.name}` : hit.snippet) : null),
      t.fav ? h('span', { class: 'fav', html: I.bookmark(18, '#e5484d') }) : null);
    if (t.color) row.style.setProperty('--row-tint', t.color);
    return row;
  }

  function dueReminders() {
    const now = Date.now();
    return state.snap.tasks.filter((t) => !t.done && !isNote(t) && t.remind_at && t.remind_at <= now).sort((a, b) => a.remind_at - b.remind_at);
  }

  function renderList() {
    const el = $('#list');
    const v = state.view;
    el.innerHTML = '';
    $('#fab').style.display = ['settings', 'projects'].includes(v.type) && state.search == null ? 'none' : '';
    if (v.type === 'settings' && state.search == null) { el.append(settingsPage()); return; }
    if (v.type === 'projects' && state.search == null) { el.append(h('div', { class: 'navs' }, navList({ forSide: false }))); return; }
    if (state.search != null && !state.search.trim()) { el.append(h('div', { class: 'empty' }, 'Ищу по названиям, описаниям и именам вложений.')); return; }

    if (v.type === 'today' && state.search == null) {
      const due = dueReminders();
      if (due.length) {
        const box = h('div', { class: 'remind-box' }, h('div', { class: 'rb-head', html: `${I.bell(17)} Пора напомнить` }));
        for (const t of due) {
          box.append(h('div', { class: 'rb-row' },
            h('div', { class: 'rb-title', onclick: () => openTask(t.id) }, t.title, h('small', {}, `${fmtDay(t.remind_at)}, ${fmtTime(t.remind_at)}`)),
            h('button', { class: 'btn small', onclick: () => snoozeMenu(t) }, 'Отложить'),
            h('button', { class: 'btn small primary', onclick: () => toggleDone(t) }, 'Готово')));
        }
        el.append(box);
      }
    }
    const { undone, notes, done } = visibleTasks();
    if (!undone.length && !notes.length && !done.length) {
      const msg = state.search != null ? 'Ничего не нашлось.' : v.type === 'today' ? 'На сегодня всё сделано.' : v.type === 'notes' ? 'Заметок пока нет.' : v.type === 'fav' ? 'Здесь появятся задачи, отмеченные закладкой.' : 'Задач нет.';
      el.append(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: v.type === 'today' ? I.check(30) : I.inbox(30) }), msg));
    }
    if (v.type === 'today' && state.search == null) {
      const over = undone.filter((t) => t.due_at && t.due_at < sod(new Date()).getTime());
      const rest = undone.filter((t) => !over.includes(t));
      if (over.length) { el.append(h('div', { class: 'group' }, 'Просрочено')); over.forEach((t) => el.append(taskRow(t))); if (rest.length) el.append(h('div', { class: 'group' }, 'Сегодня')); }
      rest.forEach((t) => el.append(taskRow(t)));
    } else undone.forEach((t) => el.append(taskRow(t)));
    if (notes.length) { if (undone.length) el.append(h('div', { class: 'group' }, 'Заметки')); notes.forEach((t) => el.append(taskRow(t))); }
    if (done.length) { el.append(h('div', { class: 'group' }, 'Выполнено')); done.forEach((t) => el.append(taskRow(t))); }
    el.append(h('div', { class: 'list-end' }));
  }

  // ---------- actions ----------
  function setView(v) {
    state.view = v;
    if (state.search != null && v.type !== state.view.type) state.search = null;
    if (!threeMQ.matches) closeDetail(false);
    cfg.view = v.type === 'folder' || v.type === 'tag' || v.type === 'notes' ? v : { type: v.type };
    saveCfg();
    $('#scroll').scrollTop = 0;
    render();
  }

  function toggleDone(t) {
    if (isNote(t)) return;
    if (!t.done && t.repeat) {
      const next = Repeat.advance(t.repeat, t);
      if (next) {
        const prev = { id: t.id, due_at: t.due_at || null, remind_at: t.remind_at || null, checklist: t.checklist || null };
        const cl = parseChecklist(t.checklist);
        upsert('tasks', { id: t.id, due_at: next.due_at, remind_at: next.remind_at, done: 0, done_at: null, ...(cl.some((x) => x.done) ? { checklist: JSON.stringify(cl.map((x) => ({ ...x, done: false }))) } : {}) });
        const nx = next.due_at || next.remind_at;
        toast(nx ? `Выполнено. Следующий раз: ${fmtDay(nx)}${next.remind_at ? `, напомню в ${fmtTime(next.remind_at)}` : ''}` : 'Выполнено', 'Отменить', () => upsert('tasks', prev));
        return;
      }
    }
    const done = t.done ? 0 : 1;
    const prevRemind = t.remind_at || null;
    upsert('tasks', { id: t.id, done, done_at: done ? Date.now() : null, ...(done ? { remind_at: null } : {}) });
    if (done) {
      state.justDone = t.id;
      renderList();
      setTimeout(() => { if (state.justDone === t.id) { state.justDone = null; renderList(); } }, 1100);
      toast('Задача выполнена', 'Отменить', () => upsert('tasks', { id: t.id, done: 0, done_at: null, remind_at: prevRemind }));
    }
  }

  async function snoozeMenu(t) {
    const d = new Date();
    const tomorrow9 = sod(new Date(Date.now() + DAY)); tomorrow9.setHours(9, 0, 0, 0);
    const v = await choose(`Отложить «${t.title}»`, [
      { label: 'На 10 минут', value: 10 * 60000 }, { label: 'На 30 минут', value: 30 * 60000 },
      { label: 'На 1 час', value: 3600000 }, { label: 'На 3 часа', value: 3 * 3600000 },
      { label: 'Завтра в 9:00', value: 'tomorrow', hint: fmtDay(tomorrow9.getTime()) },
      { sep: true },
      { label: 'Убрать напоминание', value: 'off', danger: true },
    ]);
    if (v === undefined) return;
    if (v === 'off') {
      upsert('tasks', { id: t.id, remind_at: null, ...(t.repeat ? { repeat: Repeat.rememberReminder(t.repeat, t) } : {}) });
      return;
    }
    const at = v === 'tomorrow' ? tomorrow9.getTime() : d.getTime() + v;
    upsert('tasks', { id: t.id, remind_at: at });
    toast(`Напомню ${fmtDay(at).toLowerCase()} в ${fmtTime(at)}`);
  }

  function defaultFolder() {
    if (state.view.type === 'folder' && folderById(state.view.id)) return state.view.id;
    if (cfg.lastFolder && folderById(cfg.lastFolder)) return cfg.lastFolder;
    return childrenOf(null)[0]?.id || null;
  }

  function quickAdd() {
    let folderId = defaultFolder();
    const v = state.view;
    let when = v.type === 'today' ? 'today' : null;
    let pr = 1;
    let fav = v.type === 'fav' ? 1 : 0;
    const asNote = v.type === 'notes';
    const inp = h('textarea', { class: 'field qa-title', rows: 1, placeholder: asNote ? 'Новая заметка' : 'Что нужно сделать?', enterkeyhint: 'done' });
    inp.oninput = () => { inp.style.height = 'auto'; inp.style.height = `${inp.scrollHeight}px`; };
    const chips = h('div', { class: 'qa-chips' });
    const drawChips = () => {
      chips.innerHTML = '';
      if (!asNote) {
        for (const [id, label] of [['today', 'Сегодня'], ['tomorrow', 'Завтра'], [null, 'Без срока']]) chips.append(h('button', { class: 'pill' + (when === id ? ' on' : ''), onclick: () => { when = id; drawChips(); } }, label));
        chips.append(h('button', { class: 'pill' + (pr === 2 ? ' on red' : ''), onclick: () => { pr = pr === 2 ? 1 : 2; drawChips(); } }, '! Важно'));
      }
      chips.append(h('button', { class: 'pill' + (fav ? ' on red' : ''), html: I.bookmark(14, fav ? '#fff' : '#e5484d') + ' Избранное', onclick: () => { fav = fav ? 0 : 1; drawChips(); } }));
    };
    drawChips();
    const fsel = folderSelect(folderId, (id) => { folderId = id; });
    const submit = () => {
      const title = inp.value.trim();
      if (!title) { inp.focus(); return; }
      if (!folderId || !folderById(folderId)) folderId = store.upsert('folders', { name: 'Входящие', parent_id: null, sort: 0 }), reload();
      const row = { folder_id: folderId, title, created_at: Date.now(), priority: asNote ? 1 : pr, sort: sortForPriority(folderId, asNote ? 1 : pr, null), fav };
      if (asNote) row.kind = 'note';
      if (when) { const d = when === 'today' ? new Date() : new Date(Date.now() + DAY); d.setHours(12, 0, 0, 0); row.due_at = d.getTime(); row.due_has_time = 0; }
      const id = upsert('tasks', row);
      if (v.type === 'tag') { store.setTaskTags(id, [v.id]); reload(); }
      cfg.lastFolder = folderId; saveCfg();
      inp.value = ''; inp.style.height = 'auto';
      toast(asNote ? 'Заметка добавлена' : `Добавлено в «${folderById(folderId)?.name || ''}»`, 'Открыть', () => { s.close(); openTask(id); });
      inp.focus();
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
    const s = sheet(asNote ? 'Новая заметка' : 'Новая задача', h('div', { class: 'form' }, inp, chips, h('label', { class: 'lbl' }, 'Проект'), fsel, h('button', { class: 'btn primary', onclick: submit }, 'Добавить')));
    setTimeout(() => inp.focus(), 80);
  }

  function folderSelect(value, onchange) {
    const sel = h('select', { class: 'field' });
    const walk = (pid, depth) => { for (const f of childrenOf(pid)) { sel.append(h('option', { value: f.id, selected: f.id === value }, `${'    '.repeat(depth)}${depth ? '└ ' : ''}${f.name}`)); walk(f.id, depth + 1); } };
    walk(null, 0);
    if (!state.snap.folders.length) sel.append(h('option', { value: '' }, 'Входящие (будет создан)'));
    sel.onchange = () => onchange(sel.value);
    return sel;
  }

  async function newFolder(parentId) {
    const name = await prompt(parentId ? 'Новая папка' : 'Новый проект', '', { placeholder: 'Название' });
    if (!name) return;
    const sibs = childrenOf(parentId);
    const id = upsert('folders', { name, parent_id: parentId || null, sort: sibs.length ? Math.max(...sibs.map((f) => f.sort || 0)) + 1 : 1 });
    setView({ type: 'folder', id, from: isWide() ? null : 'projects' });
  }

  async function folderMenu(f) {
    if (!f) return;
    const v = await choose(f.name, [
      { label: 'Переименовать', value: 'rename' },
      { label: 'Новая папка внутри', value: 'sub' },
      { sep: true },
      { label: 'Удалить проект со всеми задачами', value: 'del', danger: true },
    ]);
    if (v === 'rename') { const n = await prompt('Название', f.name); if (n) upsert('folders', { id: f.id, name: n }); }
    if (v === 'sub') newFolder(f.id);
    if (v === 'del' && await confirmDlg(`Удалить «${f.name}»?`, '', 'Удалить вместе с задачами')) {
      store.deleteFolder(f.id); reload(); setView({ type: isWide() ? 'all' : 'projects' });
    }
  }

  // ---------- task detail ----------
  function openTask(id) {
    state.selectedId = id;
    renderDetail();
    renderList();
    const d = $('#detail');
    d.classList.add('open');
    d.setAttribute('aria-hidden', 'false');
    d.scrollTop = 0;
    if (!threeMQ.matches) history.pushState({ detail: id }, '');
  }
  function closeDetail(viaHistory = true) {
    const d = $('#detail');
    if (!state.selectedId && !d.classList.contains('open')) return;
    d.classList.remove('open');
    d.setAttribute('aria-hidden', 'true');
    const wasOpen = state.selectedId;
    state.selectedId = null;
    setTimeout(() => { if (!state.selectedId) renderDetail(); }, 260);
    renderList();
    if (viaHistory && wasOpen && history.state && history.state.detail) history.back();
  }
  window.addEventListener('popstate', () => { if (state.selectedId && !threeMQ.matches) closeDetail(false); });

  let notesTimer = null;
  let titleTimer = null;
  function renderDetail() {
    const el = $('#detail');
    const t = state.selectedId ? store.taskDetail(state.selectedId) : null;
    if (!t || t.deleted) {
      el.innerHTML = '';
      if (threeMQ.matches) el.append(h('div', { class: 'detail-empty' }, h('div', { class: 'empty-ic', html: I.list ? I.list(34) : '' }), 'Выберите задачу'));
      return;
    }
    // keep focus/scroll while re-rendering after a sync
    const active = document.activeElement;
    if (active && el.contains(active) && (active.matches('.d-title, .notes[contenteditable="true"], .cl-text, .cl-add'))) return;
    const scroll = el.querySelector('.d-scroll')?.scrollTop || 0;
    el.innerHTML = '';
    const note = isNote(t);
    const p = prio(t);

    const head = h('div', { class: 'd-head' },
      h('button', { class: 'back', onclick: () => closeDetail() }, h('span', { html: I.chevLeft(20) }), threeMQ.matches ? '' : 'Назад'),
      h('div', { class: 'bar-actions' },
        h('button', { class: 'icon-btn' + (t.fav ? ' fav-on' : ''), 'aria-label': 'Избранное', html: I.bookmark(21, t.fav ? '#e5484d' : 'currentColor'), onclick: () => upsert('tasks', { id: t.id, fav: t.fav ? 0 : 1 }) }),
        h('button', { class: 'icon-btn', 'aria-label': 'Ещё', html: '<b class="dots">•••</b>', onclick: () => taskMenu(t) })));

    const title = h('textarea', { class: 'd-title' + (t.done ? ' done' : ''), rows: 1, enterkeyhint: 'done' });
    title.value = t.title;
    const fit = () => { title.style.height = 'auto'; title.style.height = `${title.scrollHeight}px`; };
    title.oninput = () => { fit(); clearTimeout(titleTimer); titleTimer = setTimeout(() => { if (title.value.trim()) { store.upsert('tasks', { id: t.id, title: title.value.trim() }); reloadQuiet(); } }, 500); };
    title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } };
    title.onblur = () => { clearTimeout(titleTimer); if (title.value.trim() && title.value.trim() !== t.title) upsert('tasks', { id: t.id, title: title.value.trim() }); };
    setTimeout(fit, 0);

    const top = h('div', { class: 'd-top' },
      note ? h('span', { class: 'note-ic big', html: I.note(24) }) : h('button', { class: `cb big${t.done ? ' on' : ''} p${p}`, html: t.done ? I.check(16) : '', onclick: () => { toggleDone(taskById(t.id) || t); } }),
      title);

    const rows = h('div', { class: 'd-rows' });
    const prop = (icon, label, value, onclick, { clear, cls = '' } = {}) => rows.append(h('div', { class: `prop ${cls}`, onclick },
      h('span', { class: 'prop-ic', html: icon }), h('span', { class: 'prop-label' }, label),
      h('span', { class: 'prop-val' + (value ? '' : ' muted') }, value || 'Нет'),
      clear && value ? h('button', { class: 'prop-clear', html: I.close(14), 'aria-label': 'Убрать', onclick: (e) => { e.stopPropagation(); clear(); } }) : h('span', { class: 'prop-chev', html: I.chevRight(16) })));

    prop(folderIcon(folderById(t.folder_id) || {}, 20), 'Проект', folderPath(t.folder_id), () => pickFolder(t));
    if (!note) {
      prop(I.calendar(20), 'Срок', fmtDue(t), () => editDue(t), { clear: () => upsert('tasks', { id: t.id, due_at: null, due_has_time: 0 }), cls: t.due_at && !t.done && t.due_at < sod(new Date()).getTime() ? 'over' : '' });
      prop(I.bell(20), 'Напоминание', t.remind_at ? `${fmtDay(t.remind_at)}, ${fmtTime(t.remind_at)}` : '', () => editRemind(t), { clear: () => upsert('tasks', { id: t.id, remind_at: null }), cls: t.remind_at && t.remind_at <= Date.now() && !t.done ? 'ring' : '' });
      prop(I.repeat(20), 'Повтор', t.repeat ? Repeat.describe(t.repeat) : '', () => editRepeat(t), { clear: () => upsert('tasks', { id: t.id, repeat: null }) });
      const seg = h('div', { class: 'seg' }, [[2, '! Высокая'], [1, 'Обычная'], [0, '↓ Низкая']].map(([v, l]) => h('button', {
        class: `p${v}` + (p === v ? ' on' : ''), onclick: () => { if (p !== v) upsert('tasks', { id: t.id, priority: v, ...(t.done ? {} : { sort: sortForPriority(t.folder_id, v, t.id) }) }); },
      }, l)));
      rows.append(h('div', { class: 'prop seg-row' }, h('span', { class: 'prop-ic', html: '<b class="pm">!</b>' }), seg));
    }
    if (state.snap.tags.length) {
      const tagBox = h('div', { class: 'tags' });
      const on = new Set(t.tagIds);
      for (const tg of state.snap.tags) tagBox.append(h('button', { class: 'tagpill' + (on.has(tg.id) ? ' on' : ''), style: { '--tc': tg.color }, onclick: () => { on.has(tg.id) ? on.delete(tg.id) : on.add(tg.id); store.setTaskTags(t.id, [...on]); reload(); } }, tg.name));
      rows.append(h('div', { class: 'prop tags-row' }, h('span', { class: 'prop-ic', html: I.tag('#999', 19) }), tagBox));
    }

    const body = h('div', { class: 'd-scroll' }, top, rows, checklistEl(t), notesEl(t), attachmentsEl(t),
      h('div', { class: 'd-foot' }, `Создано ${t.created_at ? `${fmtDay(t.created_at).toLowerCase()} ${fmtTime(t.created_at)}` : '—'} · изменено ${relTime(t.updated_at)}`));
    el.append(head, body);
    body.scrollTop = scroll;
  }

  async function taskMenu(t) {
    const note = isNote(t);
    const v = await choose(t.title, [
      { label: note ? 'Превратить в задачу' : 'Превратить в заметку', value: 'kind' },
      { label: 'Дублировать', value: 'dup' },
      { label: 'Поделиться текстом', value: 'share' },
      { sep: true },
      { label: 'Удалить', value: 'del', danger: true },
    ]);
    if (v === 'kind') {
      if (note) upsert('tasks', { id: t.id, kind: null, sort: sortForPriority(t.folder_id, 1, t.id) });
      else upsert('tasks', { id: t.id, kind: 'note', due_at: null, due_has_time: 0, remind_at: null, repeat: null, priority: 1, done: 0, done_at: null });
    }
    if (v === 'dup') {
      const id = upsert('tasks', { folder_id: t.folder_id, title: `${t.title} (копия)`, notes: t.notes, due_at: t.due_at, due_has_time: t.due_has_time, color: t.color, priority: t.priority ?? 1, checklist: t.checklist, repeat: t.repeat, kind: t.kind || null, sort: (t.sort || 0) + 0.001, created_at: Date.now() });
      openTask(id);
    }
    if (v === 'share') {
      const text = [t.title, plain(t.notes), parseChecklist(t.checklist).map((x) => `${x.done ? '☑' : '☐'} ${x.text}`).join('\n')].filter(Boolean).join('\n\n');
      try { await navigator.share({ text }); } catch { /* cancelled */ }
    }
    if (v === 'del') {
      store.softDelete('tasks', t.id);
      closeDetail();
      reload();
      toast('Задача удалена', 'Вернуть', () => { store.db.run('UPDATE tasks SET deleted = 0, updated_at = ? WHERE id = ?', [Date.now(), t.id]); store.db.run('UPDATE attachments SET deleted = 0, updated_at = ? WHERE task_id = ? AND hash IS NOT NULL', [Date.now(), t.id]); store.changed(); reload(); }, 5000);
    }
  }
  const plain = (html) => String(html || '').replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

  async function pickFolder(t) {
    const items = [];
    const walk = (pid, depth) => { for (const f of childrenOf(pid)) { items.push({ label: `${' '.repeat(depth)}${f.name}`, value: f.id, icon: folderIcon(f, 20), on: f.id === t.folder_id }); walk(f.id, depth + 1); } };
    walk(null, 0);
    const id = await choose('Переместить в', items);
    if (id && id !== t.folder_id) upsert('tasks', { id: t.id, folder_id: id, sort: sortForPriority(id, prio(t), t.id) });
  }

  function editDue(t) {
    const base = t.due_at ? new Date(t.due_at) : new Date();
    const date = h('input', { class: 'field', type: 'date', value: toDateInput(base) });
    const time = h('input', { class: 'field', type: 'time', value: t.due_at && t.due_has_time ? fmtTime(t.due_at) : '' });
    const save = (d, withTime) => {
      const at = new Date(d);
      let has = 0;
      if (withTime && time.value) { const [hh, mm] = time.value.split(':').map(Number); at.setHours(hh, mm, 0, 0); has = 1; } else at.setHours(12, 0, 0, 0);
      upsert('tasks', { id: t.id, due_at: at.getTime(), due_has_time: has });
      s.close();
    };
    const quick = (label, days) => h('button', { class: 'pill', onclick: () => { const d = sod(new Date(Date.now() + days * DAY)); date.value = toDateInput(d); save(d, !!time.value); } }, label);
    const nextMon = (8 - (new Date().getDay() || 7)) % 7 || 7;
    const s = sheet('Срок', h('div', { class: 'form' },
      h('div', { class: 'qa-chips' }, quick('Сегодня', 0), quick('Завтра', 1), quick('В понедельник', nextMon), quick('Через неделю', 7)),
      h('label', { class: 'lbl' }, 'Дата'), date, h('label', { class: 'lbl' }, 'Время (необязательно)'), time,
      h('button', { class: 'btn primary', onclick: () => { if (date.value) save(new Date(`${date.value}T00:00`), true); } }, 'Сохранить')));
  }

  function editRemind(t) {
    const def = t.remind_at || (() => { const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); return d.getTime(); })();
    const dt = h('input', { class: 'field', type: 'datetime-local', value: toDTInput(def) });
    const set = (at) => { upsert('tasks', { id: t.id, remind_at: at }); s.close(); toast(`Напомню ${fmtDay(at).toLowerCase()} в ${fmtTime(at)}`); };
    const tomorrow9 = sod(new Date(Date.now() + DAY)); tomorrow9.setHours(9, 0, 0, 0);
    const quick = [h('button', { class: 'pill', onclick: () => set(Date.now() + 3600000) }, 'Через час'), h('button', { class: 'pill', onclick: () => set(Date.now() + 3 * 3600000) }, 'Через 3 часа')];
    if (new Date().getHours() < 18) { const e = new Date(); e.setHours(19, 0, 0, 0); quick.push(h('button', { class: 'pill', onclick: () => set(e.getTime()) }, 'Сегодня в 19:00')); }
    quick.push(h('button', { class: 'pill', onclick: () => set(tomorrow9.getTime()) }, 'Завтра в 9:00'));
    if (t.due_at && t.due_has_time) quick.push(h('button', { class: 'pill', onclick: () => set(t.due_at - 15 * 60000) }, 'За 15 мин до срока'));
    const s = sheet('Напоминание', h('div', { class: 'form' },
      h('div', { class: 'qa-chips' }, quick),
      dt,
      h('p', { class: 'hint' }, 'На iPhone напоминание видно в приложении (раздел «Сегодня»). Звуком и окном напомнит компьютер.'),
      h('button', { class: 'btn primary', onclick: () => { if (dt.value) set(new Date(dt.value).getTime()); } }, 'Сохранить')));
  }

  async function editRepeat(t) {
    const anchor = t.due_at || t.remind_at || Date.now();
    const a = new Date(anchor);
    const wd = ((a.getDay() + 6) % 7) + 1;
    const start = sod(anchor).getTime();
    const cur = Repeat.parse(t.repeat);
    const opts = [
      { label: 'Каждый день', value: { type: 'daily', every: 1, unit: 'day', start } },
      { label: 'По будням', value: { type: 'weekly', every: 1, days: [1, 2, 3, 4, 5], start } },
      { label: `Каждую неделю, ${Repeat.WD_SHORT[wd]}`, value: { type: 'weekly', every: 1, days: [wd], start } },
      { label: `Каждый месяц, ${a.getDate()} числа`, value: { type: 'monthly', every: 1, mode: 'date', day: a.getDate(), start } },
      { label: `Каждый год, ${a.getDate()} ${MONTHS_GEN[a.getMonth()]}`, value: { type: 'yearly', month: a.getMonth(), mode: 'date', day: a.getDate(), start } },
    ];
    const items = opts.map((o) => ({ ...o, on: cur && Repeat.describe(o.value) === Repeat.describe(cur) }));
    if (cur && !items.some((x) => x.on)) items.unshift({ label: Repeat.describe(cur), value: '__keep', on: true, hint: 'настроено на компьютере' });
    items.push({ sep: true }, { label: 'Не повторять', value: null, danger: !!cur });
    const v = await choose('Повтор', items);
    if (v === undefined || v === '__keep') return;
    if (v && cur) { if (cur.until) v.until = cur.until; if (cur.remindOffset != null) v.remindOffset = cur.remindOffset; if (cur.remindTime != null) v.remindTime = cur.remindTime; }
    const patch = { id: t.id, repeat: v ? JSON.stringify(v) : null };
    if (v && !t.due_at && !t.remind_at) { const d = new Date(); d.setHours(12, 0, 0, 0); patch.due_at = d.getTime(); patch.due_has_time = 0; }
    upsert('tasks', patch);
  }

  // ---------- checklist ----------
  let clTimer = null;
  function checklistEl(t) {
    const items = parseChecklist(t.checklist);
    const box = h('div', { class: 'block checklist' });
    const save = (now) => { clearTimeout(clTimer); const go = () => { store.upsert('tasks', { id: t.id, checklist: items.length ? JSON.stringify(items) : null }); reloadQuiet(); }; if (now) go(); else clTimer = setTimeout(go, 500); };
    const head = h('div', { class: 'block-head' });
    const upd = () => { const d = items.filter((x) => x.done).length; head.innerHTML = `${I.checklist(17)} Чек-лист${items.length ? ` <small>${d} из ${items.length}</small>` : ''}`; };
    const list = h('div', {});
    const row = (it) => {
      const cb = h('button', { class: 'cb small' + (it.done ? ' on' : ''), html: it.done ? I.check(10) : '' });
      const inp = h('input', { class: 'cl-text' + (it.done ? ' done' : ''), value: it.text, enterkeyhint: 'next' });
      const del = h('button', { class: 'cl-del', html: I.close(14), 'aria-label': 'Удалить пункт' });
      const r = h('div', { class: 'cl-item' }, cb, inp, del);
      cb.onclick = () => { it.done = !it.done; cb.classList.toggle('on', it.done); cb.innerHTML = it.done ? I.check(10) : ''; inp.classList.toggle('done', it.done); upd(); save(true); };
      inp.oninput = () => { it.text = inp.value; save(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add.focus(); } };
      inp.onblur = () => save(true);
      del.onclick = () => { items.splice(items.indexOf(it), 1); r.remove(); upd(); save(true); };
      return r;
    };
    items.forEach((it) => list.append(row(it)));
    const add = h('input', { class: 'cl-add', placeholder: '+ Добавить пункт', enterkeyhint: 'done' });
    add.onkeydown = (e) => {
      if (e.key === 'Enter' && add.value.trim()) { e.preventDefault(); const it = { text: add.value.trim(), done: false }; items.push(it); list.append(row(it)); add.value = ''; upd(); save(true); }
    };
    upd();
    box.append(head, list, add);
    return box;
  }

  // ---------- notes (description) ----------
  function notesEl(t) {
    const box = h('div', { class: 'block' }, h('div', { class: 'block-head', html: `${I.list ? I.list(17) : ''} Описание` }));
    const ed = h('div', { class: 'notes', html: t.notes && t.notes !== '<p><br></p>' ? t.notes : '', 'data-ph': 'Нажмите, чтобы добавить описание' });
    ed.contentEditable = 'false';
    const save = () => { clearTimeout(notesTimer); const html = ed.innerHTML.trim(); store.upsert('tasks', { id: t.id, notes: html === '<br>' ? '' : html }); reloadQuiet(); };
    ed.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a && ed.contentEditable !== 'true') { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
      if (ed.contentEditable !== 'true') { ed.contentEditable = 'true'; ed.focus(); }
    });
    ed.oninput = () => { clearTimeout(notesTimer); notesTimer = setTimeout(save, 700); };
    ed.onblur = () => { ed.contentEditable = 'false'; save(); };
    box.append(ed);
    return box;
  }

  // ---------- attachments ----------
  const fmtSize = (n) => (!n ? '' : n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1)} МБ`);
  function attachmentsEl(t) {
    const box = h('div', { class: 'block' });
    const add = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    add.onchange = async () => {
      for (const f of add.files) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const hash = await Blobs.put(bytes);
        store.upsert('attachments', { task_id: t.id, kind: 'file', name: f.name || 'Фото.jpg', mime: f.type || 'application/octet-stream', size: bytes.length, hash, created_at: Date.now() });
        await Pending.add(hash);
        localBlobs.add(hash);
      }
      reload();
      toast(add.files.length > 1 ? `Добавлено файлов: ${add.files.length}` : 'Файл добавлен');
    };
    box.append(h('div', { class: 'block-head' }, h('span', { html: `${I.clip(17)} Вложения` }),
      h('button', { class: 'txt-btn', onclick: () => addLink(t) }, '+ Ссылка'),
      h('button', { class: 'txt-btn', onclick: () => add.click() }, '+ Файл или фото')), add);
    for (const a of t.attachments) {
      const isLink = a.kind === 'link';
      const local = !isLink && !a.hash && a.target;
      const icon = isLink ? I.link(20) : /^image\//.test(a.mime || '') ? I.image(20) : I.file(20);
      box.append(h('div', { class: 'att', onclick: () => openAttachment(a) },
        h('span', { class: 'att-ic', html: icon }),
        h('div', { class: 'att-main' }, h('div', { class: 'att-name' }, a.name || a.target || 'Файл'), h('small', {}, isLink ? (a.target || '').replace(/^https?:\/\//, '').slice(0, 60) : local ? 'Ссылка на файл на компьютере' : `${fmtSize(a.size)}${a.hash ? (localBlobs.has(a.hash) ? ' · на телефоне ✓' : ' · в облаке') : ''}`)),
        h('button', { class: 'cl-del', html: I.trash ? I.trash(16) : I.close(14), 'aria-label': 'Удалить', onclick: async (e) => { e.stopPropagation(); if (await confirmDlg(`Удалить «${a.name || 'вложение'}»?`)) { store.softDelete('attachments', a.id); reload(); } } })));
    }
    if (!t.attachments.length) box.append(h('div', { class: 'muted small pad' }, 'Нет вложений'));
    return box;
  }

  async function addLink(t) {
    let url = await prompt('Ссылка', '', { placeholder: 'https://…' });
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    store.upsert('attachments', { task_id: t.id, kind: 'link', name: url, target: url, created_at: Date.now() });
    reload();
  }

  async function openAttachment(a) {
    if (a.kind === 'link') { window.open(a.target, '_blank', 'noopener'); return; }
    if (!a.hash) { toast('Этот файл лежит на компьютере и в облако не загружался.'); return; }
    let bytes;
    try {
      toast('Открываю…', null, null, 15000);
      bytes = await attachmentBytes(dbx, a.hash);
      localBlobs.add(a.hash);
      $('#toast').classList.remove('show');
    } catch (e) { toast(e.message, null, null, 5000); return; }
    const mime = a.mime || 'application/octet-stream';
    const file = new File([bytes], a.name || 'file', { type: mime });
    const url = URL.createObjectURL(file);
    if (/^image\//.test(mime)) {
      const img = h('img', { src: url, alt: a.name || '' });
      const share = h('button', { class: 'btn', onclick: () => navigator.share?.({ files: [file] }).catch(() => {}) }, 'Поделиться / Сохранить');
      sheet(a.name || 'Изображение', h('div', { class: 'viewer' }, img, navigator.canShare && navigator.canShare({ files: [file] }) ? share : null), { full: true, onClose: () => URL.revokeObjectURL(url) });
      return;
    }
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const link = h('a', { href: url, download: a.name || 'file', target: '_blank' });
    document.body.append(link); link.click(); link.remove();
  }

  // ---------- settings ----------
  function settingsPage() {
    const page = h('div', { class: 'settings' });
    const group = (title, ...kids) => h('div', { class: 'sgroup' }, title ? h('div', { class: 'sg-title' }, title) : null, h('div', { class: 'sg-card' }, kids));

    if (cfg.refreshToken) {
      page.append(group('Синхронизация через Dropbox',
        h('div', { class: 'srow' }, h('span', {}, 'Аккаунт'), h('b', {}, cfg.account || 'подключён')),
        h('div', { class: 'srow' }, h('span', {}, 'Последняя синхронизация'), h('b', {}, state.sync.running ? (state.sync.msg || 'идёт…') : relTime(cfg.lastSync))),
        cfg.lastError ? h('div', { class: 'srow err' }, cfg.lastError) : null,
        h('button', { class: 'srow btn-row', onclick: () => syncNow({ manual: true }) }, 'Синхронизировать сейчас'),
        h('button', { class: 'srow btn-row danger', onclick: async () => { if (await confirmDlg('Отключить Dropbox?', '', 'Отключить')) { delete cfg.refreshToken; delete cfg.account; delete cfg.syncState; delete cfg.lastError; dbx = null; saveCfg(); render(); } } }, 'Отключить Dropbox')));
    } else {
      const key = h('input', { class: 'field', placeholder: 'App key', value: cfg.appKey || '', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      const code = h('input', { class: 'field', placeholder: 'Код из Dropbox', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      const err = h('div', { class: 'err small' });
      // A real link (not window.open after an await): iOS only opens new pages straight from a tap.
      const openBtn = h('a', { class: 'btn link-btn disabled', target: '_blank', rel: 'noopener', href: '#' }, '1. Открыть Dropbox и разрешить доступ');
      let prepSeq = 0;
      const prep = async () => {
        const k = key.value.trim();
        const seq = ++prepSeq;
        if (!k) { openBtn.classList.add('disabled'); openBtn.href = '#'; return; }
        const { url, verifier } = await startAuth(k);
        if (seq !== prepSeq) return;
        openBtn.href = url; openBtn.classList.remove('disabled');
        openBtn.dataset.verifier = verifier;
      };
      key.oninput = prep;
      prep();
      openBtn.onclick = (e) => {
        if (openBtn.classList.contains('disabled')) { e.preventDefault(); err.textContent = 'Вставьте App key.'; return; }
        cfg.appKey = key.value.trim(); cfg.verifier = openBtn.dataset.verifier; saveCfg();
      };
      const connect = h('button', { class: 'btn primary', onclick: async () => {
        err.textContent = '';
        if (!cfg.verifier) { err.textContent = 'Сначала нажмите «Открыть Dropbox».'; return; }
        if (!code.value.trim()) { err.textContent = 'Вставьте код, который показал Dropbox.'; return; }
        connect.disabled = true; connect.textContent = 'Подключаю…';
        try {
          const { refreshToken } = await finishAuth(cfg.appKey, code.value, cfg.verifier);
          dbx = new Dropbox({ appKey: cfg.appKey, refreshToken });
          cfg.account = await dbx.account().catch(() => '');
          cfg.refreshToken = refreshToken; delete cfg.verifier; cfg.syncState = {};
          await saveCfg();
          render();
          syncNow({ manual: true });
        } catch (e) { err.textContent = e.message; connect.disabled = false; connect.textContent = '2. Подключить'; }
      } }, '2. Подключить');
      page.append(group('Синхронизация через Dropbox',
        h('div', { class: 'spad' },
          h('p', { class: 'hint' }, 'Используйте тот же App key, что и на компьютере: SuperPlan → Настройки → Синхронизация → Dropbox. Задачи с компьютера появятся здесь, а изменения с телефона попадут на компьютер.'),
          key, openBtn, h('p', { class: 'hint' }, 'Dropbox покажет код. Скопируйте его, вернитесь сюда и вставьте:'), code, connect, err)));
    }

    const themeSeg = h('div', { class: 'seg' }, [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, l]) => h('button', { class: cfg.theme === v ? 'on' : '', onclick: () => { cfg.theme = v; saveCfg(); applyTheme(); renderList(); } }, l)));
    {
      const refs = store.all('SELECT hash, MAX(size) AS size FROM attachments WHERE deleted = 0 AND hash IS NOT NULL GROUP BY hash');
      const have = refs.filter((r) => localBlobs.has(r.hash));
      const bytes = have.reduce((n, r) => n + (r.size || 0), 0);
      const all = refs.reduce((n, r) => n + (r.size || 0), 0);
      const sw = h('button', { class: 'switch' + (cfg.offlineFiles ? ' on' : ''), 'aria-label': 'Хранить вложения на телефоне', onclick: () => { cfg.offlineFiles = !cfg.offlineFiles; saveCfg(); renderList(); if (cfg.offlineFiles) prefetchAttachments(); } }, h('i'));
      const status = offline.running ? `Скачиваю: ${offline.done} из ${offline.total}…` : `На телефоне ${have.length} из ${refs.length}${refs.length ? ` · ${fmtSize(bytes) || '0 КБ'} из ${fmtSize(all) || '0 КБ'}` : ''}`;
      page.append(group('Вложения без интернета',
        h('div', { class: 'srow' }, h('span', {}, 'Хранить все вложения на телефоне'), sw),
        h('div', { class: 'srow' }, h('span', {}, 'Скачано'), h('b', {}, status)),
        offline.failed && !offline.running ? h('div', { class: 'srow err' }, `Не удалось скачать: ${offline.failed}. Возможно, компьютер ещё не загрузил эти файлы в Dropbox.`) : null,
        cfg.refreshToken && have.length < refs.length && !offline.running ? h('button', { class: 'srow btn-row', onclick: () => prefetchAttachments(true) }, 'Скачать недостающие сейчас') : null,
        h('div', { class: 'spad' }, h('p', { class: 'hint' }, 'Когда есть интернет, SuperPlan сам скачивает новые вложения после каждой синхронизации. Потом они открываются и без сети.'))));
    }
    page.append(group('Оформление', h('div', { class: 'spad' }, themeSeg)));

    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!standalone) {
      page.append(group('Установка', h('div', { class: 'spad' }, h('p', { class: 'hint' }, 'Чтобы SuperPlan открывался как приложение: в Safari нажмите «Поделиться» ', h('span', { class: 'share-ic', html: '<svg width="14" height="16" viewBox="0 0 14 18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 1v11M3.5 4.5L7 1l3.5 3.5"/><path d="M4.5 7H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1H9.5"/></svg>' }), ' → «На экран Домой».'))));
    }
    const n = state.snap.tasks.length;
    page.append(group('О программе',
      h('div', { class: 'srow' }, h('span', {}, 'Версия'), h('b', {}, `SuperPlan Mobile ${VERSION}`)),
      h('div', { class: 'srow' }, h('span', {}, 'Задач и заметок'), h('b', {}, String(n))),
      h('button', { class: 'srow btn-row danger', onclick: resetLocal }, 'Стереть данные на этом устройстве')));
    return page;
  }

  async function resetLocal() {
    if (!(await confirmDlg('Стереть данные на этом устройстве?', '', 'Стереть'))) return;
    if (cfg.refreshToken && store.isDirty() && !(await confirmDlg('Есть изменения, которые ещё не ушли в Dropbox. Всё равно стереть?', '', 'Стереть'))) return;
    await IDB.del('kv', 'db');
    await IDB.del('kv', 'cfg');
    for (const k of await IDB.keys('blobs')) await IDB.del('blobs', k);
    location.reload();
  }

  // ---------- sync ----------
  let syncTimer = null;
  async function syncNow({ manual = false } = {}) {
    if (!cfg.refreshToken) return;
    if (state.sync.running) { state.sync.again = true; return; }
    if (!navigator.onLine && !manual) return;
    if (!dbx) dbx = new Dropbox({ appKey: cfg.appKey, refreshToken: cfg.refreshToken });
    state.sync = { running: true, msg: 'Синхронизация…' };
    renderSyncState();
    try {
      const res = await sync(store, dbx, cfg.syncState || {}, (msg) => { state.sync.msg = msg; renderSyncState(); });
      cfg.syncState = res.state;
      cfg.lastSync = Date.now();
      delete cfg.lastError;
      if (manual) toast(res.skipped ? 'Всё уже синхронизировано' : res.taken ? `Синхронизировано: получено изменений ${res.taken}` : 'Синхронизировано');
      gcBlobs().then(() => prefetchAttachments());
    } catch (e) {
      cfg.lastError = e.message;
      if (manual) toast(e.message, null, null, 6000);
    }
    const again = state.sync.again;
    state.sync = { running: false };
    await saveCfg();
    reload();
    if (again) syncNow();
  }
  function renderSyncState() {
    for (const b of document.querySelectorAll('.sync-btn')) b.classList.toggle('running', state.sync.running);
    if (state.view.type === 'settings') renderList();
  }
  function scheduleSync(ms = 4000) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), ms); }

  async function refreshLocalBlobs() { try { localBlobs = new Set(await Blobs.list()); } catch { /* ignore */ } }

  // Keep a copy of every attachment on the device, so it opens without internet.
  async function prefetchAttachments(manual = false) {
    if (offline.running || !cfg.refreshToken || (!cfg.offlineFiles && !manual)) return;
    if (!dbx) dbx = new Dropbox({ appKey: cfg.appKey, refreshToken: cfg.refreshToken });
    await refreshLocalBlobs();
    const need = [...store.referencedHashes()].filter((h) => !localBlobs.has(h));
    if (!need.length) { if (manual) toast('Все вложения уже на телефоне'); return; }
    Object.assign(offline, { running: true, done: 0, total: need.length, failed: 0 });
    if (state.view.type === 'settings') renderList();
    for (const hash of need) {
      if (!navigator.onLine) break;
      try { await attachmentBytes(dbx, hash); localBlobs.add(hash); } catch { offline.failed++; }
      offline.done++;
      if (state.view.type === 'settings') renderList();
    }
    offline.running = false;
    await refreshLocalBlobs();
    if (manual) toast(offline.failed ? `Скачано ${offline.done - offline.failed}, не удалось: ${offline.failed}` : `Скачано вложений: ${offline.done}`);
    if (state.view.type === 'settings') renderList();
    if (state.selectedId) renderDetail();
  }

  async function gcBlobs() {
    if (cfg.lastBlobGc && Date.now() - cfg.lastBlobGc < DAY) return;
    cfg.lastBlobGc = Date.now();
    const keep = store.referencedHashes();
    const pending = await Pending.all();
    for (const h of await Blobs.list()) if (!keep.has(h) && !pending.has(h)) await Blobs.del(h);
    await refreshLocalBlobs();
  }

  // ---------- reload ----------
  function reload() {
    state.snap = store.snapshot();
    if (state.view.type === 'folder' && !folderById(state.view.id)) state.view = { type: isWide() ? 'all' : 'projects' };
    if (state.search && state.search.trim()) state.searchHits = store.search(state.search);
    render();
  }
  // re-read data without rebuilding the open card (typing in title/notes/checklist)
  function reloadQuiet() {
    state.snap = store.snapshot();
    renderList(); renderSide(); renderTabs();
  }

  // ---------- start ----------
  async function start() {
    cfg = { ...cfg, ...((await IDB.get('kv', 'cfg')) || {}) };
    state.showDone = !!cfg.showDone;
    applyTheme();
    try { navigator.storage?.persist?.(); } catch { /* ignore */ }
    store = await Store.open();
    await refreshLocalBlobs();
    store.onChange((local) => { if (local) scheduleSync(); });
    if (cfg.view && cfg.view.type) state.view = cfg.view;
    state.snap = store.snapshot();
    if ((state.view.type === 'folder' && !folderById(state.view.id)) || (state.view.type === 'projects' && isWide())) state.view = { type: 'today' };
    $('#fab').innerHTML = I.plus(28);
    $('#fab').onclick = quickAdd;
    render();
    $('#app').classList.add('ready');
    wideMQ.addEventListener('change', render);
    threeMQ.addEventListener('change', render);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { reload(); syncNow(); } else store.saveNow(); });
    window.addEventListener('pagehide', () => store.saveNow());
    window.addEventListener('online', () => syncNow());
    setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 90 * 1000);
    // reminders become due while the app is open
    let lastDue = dueReminders().length;
    setInterval(() => {
      const n = dueReminders().length;
      if (n > lastDue) { const t = dueReminders().slice(-1)[0]; toast(`⏰ ${t.title}`, 'Открыть', () => openTask(t.id), 8000); renderList(); renderTabs(); }
      lastDue = n;
    }, 20 * 1000);
    if (cfg.refreshToken) syncNow();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  start().catch((e) => {
    document.body.innerHTML = `<div class="fatal"><b>SuperPlan не запустился</b><p>${esc(e.message)}</p><button onclick="location.reload()">Перезапустить</button></div>`;
  });
  window.__sp = { state, get store() { return store; }, syncNow, cfg: () => cfg };
})();
