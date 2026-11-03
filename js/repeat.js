// Recurring tasks: rule format, next date, short Russian description.
// Rule (stored as JSON in tasks.repeat):
//   { type: 'daily',   every: N, unit: 'day'|'week'|'month'|'year', start }
//   { type: 'weekly',  every: N, days: [1..7] (1 = пн), start }
//   { type: 'monthly', every: N, mode: 'date'|'nth', day: 1..31, nth: 1..5 (5 = последний), wd: 1..7, start }
//   { type: 'yearly',  month: 0..11, mode, day, nth, wd, start }
//   until: timestamp (last allowed day) or null. start: the day the rule counts from.
(function (root) {
  const DAY = 86400000;
  const sod = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d; };
  const wd1 = (d) => ((d.getDay() + 6) % 7) + 1; // 1 = Monday … 7 = Sunday
  const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
  const dayDiff = (a, b) => Math.round((sod(b) - sod(a)) / DAY);
  const monthDiff = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  const monday = (d) => { const x = sod(d); x.setDate(x.getDate() - (wd1(x) - 1)); return x; };

  const WD_SHORT = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
  const WD_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
  const NTH = ['', 'первый', 'второй', 'третий', 'четвёртый', 'последний'];
  const NTH_F = ['', 'первую', 'вторую', 'третью', 'четвёртую', 'последнюю'];
  const NTH_N = ['', 'первое', 'второе', 'третье', 'четвёртое', 'последнее'];
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function parse(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;
    try { const r = JSON.parse(v); return r && r.type ? r : null; } catch { return null; }
  }

  function nthMatch(d, nth, wd) {
    if (wd1(d) !== wd) return false;
    if (nth === 5) return d.getDate() + 7 > daysIn(d.getFullYear(), d.getMonth());
    return Math.ceil(d.getDate() / 7) === nth;
  }
  function dateMatch(d, day) { return d.getDate() === Math.min(day, daysIn(d.getFullYear(), d.getMonth())); }

  function matches(r, d) {
    const start = sod(r.start || Date.now());
    if (d < start) return false;
    const every = Math.max(1, Number(r.every) || 1);
    switch (r.type) {
      case 'daily': {
        const unit = r.unit || 'day';
        if (unit === 'day') return dayDiff(start, d) % every === 0;
        if (unit === 'week') return dayDiff(start, d) % (7 * every) === 0;
        if (unit === 'month') return monthDiff(start, d) % every === 0 && dateMatch(d, start.getDate());
        return d.getMonth() === start.getMonth() && (d.getFullYear() - start.getFullYear()) % every === 0 && dateMatch(d, start.getDate());
      }
      case 'weekly': {
        const days = r.days && r.days.length ? r.days : [wd1(start)];
        if (!days.includes(wd1(d))) return false;
        return (dayDiff(monday(start), monday(d)) / 7) % every === 0;
      }
      case 'monthly':
        if (monthDiff(start, d) % every !== 0) return false;
        return r.mode === 'nth' ? nthMatch(d, r.nth || 1, r.wd || 1) : dateMatch(d, r.day || start.getDate());
      case 'yearly':
        if (d.getMonth() !== (r.month ?? start.getMonth())) return false;
        return r.mode === 'nth' ? nthMatch(d, r.nth || 1, r.wd || 1) : dateMatch(d, r.day || start.getDate());
      default: return false;
    }
  }

  // First matching day strictly after `after` (or on it when inclusive). Returns a Date at 00:00 or null.
  function nextDay(rule, after, inclusive = false) {
    const r = parse(rule);
    if (!r) return null;
    const d = sod(after);
    if (!inclusive) d.setDate(d.getDate() + 1);
    const until = r.until ? sod(r.until) : null;
    for (let i = 0; i < 366 * 12; i++) {
      if (until && d > until) return null;
      if (matches(r, d)) return d;
      d.setDate(d.getDate() + 1);
    }
    return null;
  }

  // What happens when a recurring task is completed: the new due date (keeps the time of day),
  // and the reminder moved by the same distance. null = the series is over.
  function advance(rule, task, now = Date.now()) {
    const r = parse(rule);
    if (!r) return null;
    const anchor = task.due_at || task.remind_at || now;
    const base = Math.max(sod(anchor).getTime(), sod(now).getTime() - DAY);
    const day = nextDay(r, base);
    if (!day) return null;
    const at = (src) => { const x = new Date(day); const s0 = new Date(src); x.setHours(s0.getHours(), s0.getMinutes(), 0, 0); return x.getTime(); };
    if (task.due_at) {
      const due_at = task.due_has_time ? at(task.due_at) : new Date(day).getTime();
      let remind_at = null;
      if (task.remind_at) remind_at = task.remind_at + (due_at - task.due_at);
      else if (r.remindOffset != null) remind_at = due_at + Number(r.remindOffset);
      return { due_at, remind_at };
    }
    // only a reminder, no due date: keep it that way, move the reminder to the next day at the same time
    let remind_at = null;
    if (task.remind_at) remind_at = at(task.remind_at);
    else if (r.remindTime != null) remind_at = new Date(day).getTime() + Number(r.remindTime);
    return { due_at: null, remind_at };
  }
  // A reminder of a repeating task was dismissed: remember its time inside the rule so the next occurrence gets one again.
  function rememberReminder(rule, task) {
    const r = parse(rule);
    if (!r || !task.remind_at) return rule;
    const out = { ...r };
    if (task.due_at) { out.remindOffset = task.remind_at - task.due_at; delete out.remindTime; } else { out.remindTime = task.remind_at - sod(task.remind_at).getTime(); delete out.remindOffset; }
    return JSON.stringify(out);
  }

  const plural = (n, one, few, many) => {
    const a = n % 10; const b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  };
  const fmtDate = (t) => sod(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  function describe(rule) {
    const r = parse(rule);
    if (!r) return '';
    const n = Math.max(1, Number(r.every) || 1);
    const start = sod(r.start || Date.now());
    let s = '';
    const onDay = (x) => {
      if (x.mode !== 'nth') return `${x.day || start.getDate()} числа`;
      const wd = x.wd || 1;
      const ord = ([3, 5, 6].includes(wd) ? NTH_F : wd === 7 ? NTH_N : NTH)[x.nth || 1];
      return `${/^втор/.test(ord) ? 'во' : 'в'} ${ord} ${WD_ACC[wd]}`;
    };
    switch (r.type) {
      case 'daily': {
        const u = r.unit || 'day';
        const words = { day: ['день', 'дня', 'дней'], week: ['неделю', 'недели', 'недель'], month: ['месяц', 'месяца', 'месяцев'], year: ['год', 'года', 'лет'] }[u];
        if (n === 1) s = { day: 'Каждый день', week: 'Каждую неделю', month: 'Каждый месяц', year: 'Каждый год' }[u];
        else s = `${u === 'week' ? plural(n, 'Каждую', 'Каждые', 'Каждые') : plural(n, 'Каждый', 'Каждые', 'Каждые')} ${n} ${plural(n, words[0], words[1], words[2])}`;
        break;
      }
      case 'weekly': {
        const days = (r.days && r.days.length ? r.days : [((start.getDay() + 6) % 7) + 1]).slice().sort();
        const list = days.length === 7 ? 'все дни' : days.length === 5 && days.join() === '1,2,3,4,5' ? 'по будням' : days.map((d) => WD_SHORT[d]).join(', ');
        s = `${n === 1 ? 'Каждую неделю' : `Каждые ${n} ${plural(n, 'неделю', 'недели', 'недель')}`}: ${list}`;
        break;
      }
      case 'monthly':
        s = `${n === 1 ? 'Каждый месяц' : `Каждые ${n} ${plural(n, 'месяц', 'месяца', 'месяцев')}`}, ${onDay(r)}`;
        break;
      case 'yearly': {
        const m = r.month ?? start.getMonth();
        s = r.mode === 'nth' ? `Каждый год, ${onDay(r)} ${MONTHS_GEN[m]}` : `Каждый год, ${r.day || start.getDate()} ${MONTHS_GEN[m]}`;
        break;
      }
      default: return '';
    }
    if (r.until) s += `, до ${fmtDate(r.until)}`;
    return s;
  }

  const api = { parse, matches, nextDay, advance, rememberReminder, describe, WD_SHORT, WD_ACC, NTH, MONTHS, sod };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Repeat = api;
})(typeof window !== 'undefined' ? window : globalThis);
