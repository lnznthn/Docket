// Runs apps-script/Code.gs unchanged against an in-memory fake of the Google services it uses,
// and serves it over HTTP like the /exec URL. Test-only: node test/mock-backend.js [port]
const fs = require('fs'), vm = require('vm'), http = require('http'), path = require('path');

function colNum(s) { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
const pad = n => String(n).padStart(2, '0');

class Range {
  constructor(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = this.sh.cell(this.r + i, this.c + j); row.push(v === undefined ? '' : v); } out.push(row); } return out; }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) { if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('Mock: range size ' + this.nr + 'x' + this.nc + ' does not match values ' + vals.length + 'x' + vals[0].length); vals.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); this.sh.writes++; return this; }
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormat(f) { if (f === '@' && this.r === 1 && this.nr === this.sh.max) for (let j = 0; j < this.nc; j++) this.sh.textCols.add(this.c + j); return this; }
  setFontWeight() { return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) delete this.sh.cells[(this.r + i) + ',' + (this.c + j)]; return this; }
  setDataValidation(rule) { this.sh.validation = { r: this.r, c: this.c, nr: this.nr, nc: this.nc, rule }; return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.cells = {}; this.max = 1000; this.frozen = 0; this.textCols = new Set(); this.protections = []; this.validation = null; this.writes = 0; }
  cell(r, c) { return this.cells[r + ',' + c]; }
  // A value that Sheets would turn into a formula, a date or a number is refused unless its column is plain text: this is how a lost text format shows up in a test.
  set(r, c, v) { if (r > this.max) throw new Error('Mock: row ' + r + ' beyond grid ' + this.max); if (typeof v === 'string' && /^[=+@-]/.test(v) && !this.textCols.has(c) && r > 1) throw new Error('Mock: column ' + c + ' of ' + this.name + ' is not text-formatted, so "' + v + '" would become a formula'); this.cells[r + ',' + c] = v; }
  getMaxRows() { return this.max; }
  getMaxColumns() { return this.maxCols || 30; }
  insertColumnsAfter(after, n) { this.maxCols = this.getMaxColumns() + n; }
  insertRowsAfter(after, n) { this.max += n; }
  setFrozenRows(n) { this.frozen = n; }
  protect() { const p = { desc: '', warn: false, setDescription(d) { this.desc = d; return this; }, getDescription() { return this.desc; }, setWarningOnly(w) { this.warn = w; return this; } }; this.protections.push(p); return p; }
  getProtections() { return this.protections; }
  getLastRow() { let m = 0; for (const k of Object.keys(this.cells)) { if (this.cells[k] !== '') m = Math.max(m, +k.split(',')[0]); } return m; }
  // Test helpers: rows 2..last as arrays, replacing them, and appending as a person or a Sheets connector would.
  rowsOf() { const out = []; for (let r = 2; r <= this.getLastRow(); r++) { const row = []; for (let c = 1; c <= 26; c++) row.push(this.cells[r + ',' + c] === undefined ? '' : this.cells[r + ',' + c]); out.push(row); } return out; }
  putRows(rows) { const last = this.getLastRow(); for (let r = 2; r <= last; r++) for (let c = 1; c <= 30; c++) delete this.cells[r + ',' + c]; rows.forEach((row, i) => row.forEach((v, j) => { if (v !== undefined && v !== '') this.cells[(i + 2) + ',' + (j + 1)] = v; })); }
  append(rows) { let r = Math.max(this.getLastRow(), 1); rows.forEach(row => { r++; row.forEach((v, j) => { if (v !== undefined && v !== '') this.cells[r + ',' + (j + 1)] = v; }); }); return r; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(a); if (!m) throw new Error('Mock: bad A1 ' + a);
      const c1 = colNum(m[1]), c2 = m[3] ? colNum(m[3]) : c1; const r1 = m[2] ? +m[2] : 1, r2 = m[4] ? +m[4] : (m[3] ? this.max : r1);
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    return new Range(this, a, b, c || 1, d || 1);
  }
}
class Cal {
  constructor(id, name) { this.id = id; this.name = name; this.events = []; this.n = 0; }
  getName() { return this.name; }
  createEvent(title, start, end) { const ev = new Ev(this, 'ev' + (++this.n) + '@' + (this.id || 'main'), title, start, end, false); this.events.push(ev); return ev; }
  createAllDayEvent(title, day) { const ev = new Ev(this, 'ev' + (++this.n) + '@' + (this.id || 'main'), title, day, new Date(day.getTime() + 86400000), true); this.events.push(ev); return ev; }
  getEventById(id) { return this.events.find(e => e.id === id) || null; }
  getEvents(from, to) { return this.events.filter(e => e.end > from && e.start < to).sort((a, b) => a.start - b.start); }
}
class Ev {
  constructor(cal, id, title, start, end, allDay) { this.cal = cal; this.id = id; this.title = title; this.start = start; this.end = end; this.allDay = allDay; }
  getId() { return this.id; } getTitle() { return this.title; } setTitle(t) { this.title = t; return this; }
  getStartTime() { return this.start; } getEndTime() { return this.end; } setTime(s, e) { this.start = s; this.end = e; this.allDay = false; return this; }
  getColor() { return this.color || ''; } setColor(c) { this.color = String(c); return this; }
  isRecurringEvent() { return !!this.rec; } getEventSeries() { const all = this.cal.events.filter(e => e.id === this.id); return { setTitle(t) { all.forEach(e => { e.title = t; }); return this; } }; } setAllDayDate(d) { this.start = d; this.end = new Date(d.getTime() + 86400000); this.allDay = true; return this; }
  isAllDayEvent() { return this.allDay; } getAllDayStartDate() { return this.start; }
  deleteEvent() { this.cal.events.splice(this.cal.events.indexOf(this), 1); }
}
function makeSandbox() {
  const sheets = [new Sheet('Sheet1')], props = {}, triggers = [];
  const ui = { menus: [], dialogs: [] };
  const cals = { '': new Cal('', 'Main'), 'b@example.test': new Cal('b@example.test', 'Calendar B') };
  const ss = {
    id: 'mock-sheet', getId: () => ss.id,
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = new Sheet(n); sheets.push(s); return s; },
    getSheets: () => sheets,
  };
  let locked = false;
  const sandbox = {
    sheets, props, ui, cals, triggers, ss,
    url: 'https://script.google.com/macros/s/mock-deployment/exec',
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, ProtectionType: { SHEET: 'SHEET' },
      newDataValidation: () => { const b = { list: null, requireValueInList(l) { this.list = l; return this; }, setAllowInvalid() { return this; }, build() { return { list: this.list }; } }; return b; },
      getUi: () => ({ createMenu: name => ({ name, items: [], addItem(caption, fn) { this.items.push([caption, fn]); return this; }, addToUi() { ui.menus.push({ name: this.name, items: this.items }); } }),
        showModalDialog: (out, title) => { ui.dialogs.push({ title, html: out.html }); } }) },
    HtmlService: { createHtmlOutput: html => ({ html, setWidth() { return this; }, setHeight() { return this; } }) },
    ScriptApp: { getService: () => ({ getUrl: () => sandbox.url }), getProjectTriggers: () => triggers.slice(), deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: fn => ({ timeBased() { return this; }, everyMinutes(n) { this.n = n; return this; }, create() { const t = { fn, every: this.n, getHandlerFunction: () => fn }; triggers.push(t); return t; } }) },
    CalendarApp: { getDefaultCalendar: () => cals[''], getCalendarById: id => cals[id] || null },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (locked) throw new Error('locked'); locked = true; }, releaseLock() { locked = false; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ text: s, setMimeType() { return this; } }) },
    // Formats in the machine's own time zone, which stands in for the script's time zone.
    Utilities: { getUuid: () => require('crypto').randomUUID(), formatDate: (d, tz, f) => (f === 'HH:mm' ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())) },
    Session: { getScriptTimeZone: () => 'Local' },
    Logger: { log() {} },
    JSON, Date, Math, Object, String, Number, Array, isNaN, RegExp, Error,
  };
  return sandbox;
}
function load() {
  const sb = makeSandbox();
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sb);
  vm.runInContext('setup()', sb);
  return sb;
}
module.exports = { load };

if (require.main === module) {
  const port = +process.argv[2] || 8766;
  let sb = load();
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  const tab = n => sb.sheets.find(s => s.name === n);
  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url.startsWith('/_reset')) { sb = load(); res.writeHead(200, cors); return res.end(sb.props.KEY); }
    if (req.url.startsWith('/_dump')) {
      const dump = {}; sb.sheets.forEach(s => { dump[s.name] = [0].concat(s.rowsOf()).map((r, i) => (i ? r : null)).filter(Boolean); });
      dump._events = Object.keys(sb.cals).reduce((a, k) => a.concat(sb.cals[k].events.map(e => ({ cal: k, id: e.id, title: e.title, start: e.start.toISOString(), end: e.end.toISOString(), rec: !!e.rec }))), []);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify(dump));
    }
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      // Test-only: { tab, rows } appends rows the way the owner or a Sheets connector does. { tab, rows, replace: true } replaces rows 2 onward.
      if (req.url.startsWith('/_rows')) {
        const p = JSON.parse(body || '{}'), sh = tab(p.tab);
        if (p.replace) sh.putRows(p.rows); else sh.append(p.rows);
        res.writeHead(200, cors); return res.end(String(sh.getLastRow()));
      }
      // Test-only calendar: { add: { cal, title, start, end, allDay } } | { move: { id, start, end } } | { remove: id }
      if (req.url.startsWith('/_cal')) {
        const p = JSON.parse(body || '{}'); let out = '';
        const find = id => Object.keys(sb.cals).map(k => sb.cals[k].getEventById(id)).find(Boolean);
        if (p.add) { const c = sb.cals[p.add.cal || '']; const ev = p.add.allDay ? c.createAllDayEvent(p.add.title, new Date(p.add.start)) : c.createEvent(p.add.title, new Date(p.add.start), new Date(p.add.end)); if (p.add.series) { ev.id = p.add.series; ev.rec = true; } out = ev.getId(); }
        if (p.move) { find(p.move.id).setTime(new Date(p.move.start), new Date(p.move.end)); }
        if (p.remove) { const e = find(p.remove); if (e) e.deleteEvent(); }
        res.writeHead(200, cors); return res.end(out);
      }
      if (req.url.startsWith('/_tick')) { vm.runInContext('tick()', sb); res.writeHead(200, cors); return res.end('ok'); }
      // Test-only: makes the script report another version until /_reset, to try the app's version guard.
      if (req.url.startsWith('/_ver')) { sb.VERSION_ = body.trim().replace(/"/g, ''); res.writeHead(200, cors); return res.end(sb.VERSION_); }
      let out;
      if (req.method === 'POST') { sb.__e = { postData: { contents: body } }; out = vm.runInContext('doPost(__e)', sb).text; }
      else out = vm.runInContext('doGet()', sb).text;
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(out);
    });
  }).listen(port, () => console.log('mock backend on ' + port));
}
