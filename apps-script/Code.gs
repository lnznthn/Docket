/**
 * Docket back end. Paste this file into the Apps Script project bound to the Docket spreadsheet
 * (Extensions > Apps Script), run setup() once, then deploy it as a web app
 * (Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone).
 * The app talks to the /exec URL with the key that setup() makes; without the key every request is refused.
 * Nothing personal lives in this file: the spreadsheet, the key, the calendars and every task stay in the owner's Google account.
 * ARCHITECTURE.md in the repository describes the tabs, the requests and the rules this file enforces.
 */

var VERSION_ = '1.5.0';

var TASK_HEAD_ = ['ID', 'Title', 'Status', 'Tier', 'Domain', 'Where', 'Place', 'Buy', 'Label', 'Chain', 'Waits for', 'Due date', 'Due time',
  'Calendar block', 'Block length', 'Event ID', 'Reminder ID', 'Notes', 'Unconfirmed traits', 'Source', 'Routine', 'Created', 'Updated', 'Done at'];
// The same order as TASK_HEAD_: the name each column has in a request or a reply.
var TASK_KEYS_ = ['id', 't', 'status', 'tier', 'dom', 'wh', 'place', 'buy', 'label', 'chain', 'after', 'date', 'time',
  'cal', 'dur', 'eventId', 'remId', 'notes', 'guessed', 'src', 'routine', 'created', 'updated', 'doneAt'];
var ROUTINE_HEAD_ = ['ID', 'Title', 'Steps', 'Tier', 'Domain', 'Where', 'Place', 'Cadence', 'Every', 'Next due', 'On'];
var RULE_HEAD_ = ['Keyword', 'Trait', 'Value', 'Origin', 'Match'];
var INBOX_HEAD_ = ['Added', 'Title', 'Tier', 'Domain', 'Where', 'Place', 'Buy', 'Label', 'Chain', 'After', 'Due date', 'Due time', 'Notes', 'Unconfirmed traits', 'Status',
  'Task ID', 'Calendar block', 'Block length'];
var EDIT_HEAD_ = ['Task ID', 'Field', 'New value', 'Status', 'Note'];
var SET_HEAD_ = ['Setting', 'Value', 'What it does'];
var BROWSE_HEAD_ = ['ID', 'Title', 'Shown tier', 'Tier', 'Domain', 'Where', 'Mode', 'Place', 'Buy', 'Label', 'Chain', 'Waits for', 'Actionable',
  'Due date', 'Due time', 'Calendar block', 'Notes', 'Unconfirmed traits', 'Source', 'Created', 'Updated'];

var TIERS_ = ['Prio', 'Active', 'Archived'];
var DOMAINS_ = ['Work', 'Personal', 'Admin'];
var WHERES_ = ['Phone', 'Desk', 'Home', 'Out'];
var STATUSES_ = ['Open', 'Done', 'Dropped'];
var RULE_TRAITS_ = ['Domain', 'Where', 'Buy'];
// Rules tab, Match column: blank matches the keyword anywhere in a title; these make the row one of the guesser's words.
var MATCHES_ = ['word', 'start', 'buy'];
// Edits tab: the Field names the owner or the assistant may write, and the task key each one changes.
var EDIT_FIELDS_ = { 'Title': 't', 'Status': 'status', 'Tier': 'tier', 'Domain': 'dom', 'Where': 'wh', 'Place': 'place', 'Buy': 'buy', 'Label': 'label',
  'Chain': 'chain', 'Waits for': 'after', 'Due date': 'date', 'Due time': 'time', 'Calendar block': 'cal', 'Block length': 'dur', 'Notes': 'notes',
  'Unconfirmed traits': 'guessed', 'Reminder ID': 'remId' };
var SETTINGS_ = [
  ['Calendars to show', '', 'Calendar IDs whose events appear on Today, separated by commas. Blank means your main calendar.'],
  ['Block calendar', '', 'Calendar ID that receives a task\'s calendar block. Blank means your main calendar.'],
  ['Stale after (days)', '14', 'An Active task with no date for this long is proposed for Archived at check-in.'],
  ['Prio window (days)', '2', 'A task due within this many days is shown as Prio.'],
  ['Done history (days)', '90', 'Finished and dropped tasks newer than this stay on the phone.'],
  ['Reminders list', 'Reminders', 'Apple Reminders list that timed tasks are mirrored to.'],
  ['Buy list', 'Buy', 'Apple Reminders list that Buy items are mirrored to.'],
  ['Block colours', '', 'Google Calendar colour IDs (1 to 11) for calendar blocks and the app\'s row bars: Where or Domain names with an ID, such as Out=1, Work=2. The first name that fits a task wins. Blank means no colours.']
];
var PROTECT_NOTE_ = 'Used by the app. Sort and filter in the Browse tab; add tasks in the Inbox tab and change them in the Edits tab.';

function s_(v) { return String(v == null ? '' : v).trim(); }
function yes_(v) { return /^(yes|y|true|1)$/i.test(s_(v)); }
function flag_(b) { return b ? 'Yes' : ''; }
function pick_(v, list, fallback) {
  var x = s_(v).toLowerCase();
  for (var i = 0; i < list.length; i++) { if (list[i].toLowerCase() === x) return list[i]; }
  return fallback;
}
function now_() { return new Date().toISOString(); }
function newId_() { return 'T' + new Date().getTime().toString(36) + Math.floor(Math.random() * 46656).toString(36); }
function tz_() { return Session.getScriptTimeZone(); }
function ymd_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }
function hm_(d) { return Utilities.formatDate(d, tz_(), 'HH:mm'); }
function dateOk_(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; }
function timeOk_(v) { var m = /^(\d{1,2}):(\d{2})/.exec(v); return m && +m[1] < 24 && +m[2] < 60 ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''; }
// A cell that Sheets turned into a date or a time (when a column lost its text format) still reads as the text the app expects.
function cellDate_(v) { return v instanceof Date ? ymd_(v) : dateOk_(s_(v)); }
function cellTime_(v) { return v instanceof Date ? hm_(v) : timeOk_(s_(v)); }

/* ---------- setup ---------- */

function ensureSheet_(ss, name, head, widths) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // Every column is plain text, so an ID, a date such as 2026-11-21, a time such as 09:30 or a note starting with = stays as typed.
  sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
  return sh;
}
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('The "' + name + '" tab is missing. Run setup() again.');
  return sh;
}
function ensureRows_(sh, lastNeeded) { if (lastNeeded > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), lastNeeded - sh.getMaxRows() + 200); }
function protect_(sh) {
  var has = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).some(function (p) { return p.getDescription() === PROTECT_NOTE_; });
  if (!has) sh.protect().setDescription(PROTECT_NOTE_).setWarningOnly(true);
}

/** Creates or upgrades the tabs, makes the connection key, and starts the ten-minute timer. Safe to run again; it never deletes data. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  protect_(ensureSheet_(ss, 'Tasks', TASK_HEAD_));
  ensureSheet_(ss, 'Routines', ROUTINE_HEAD_);
  ensureSheet_(ss, 'Rules', RULE_HEAD_);
  ensureSheet_(ss, 'Inbox', INBOX_HEAD_);
  var ed = ensureSheet_(ss, 'Edits', EDIT_HEAD_);
  ed.getRange(2, 2, ed.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(EDIT_FIELDS_), true).setAllowInvalid(true).build());
  var st = ensureSheet_(ss, 'Settings', SET_HEAD_);
  var have = {};
  var last = st.getLastRow();
  if (last > 1) st.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { have[s_(r[0])] = true; });
  SETTINGS_.forEach(function (row) { if (!have[row[0]]) { last = Math.max(last, 1) + 1; st.getRange(last, 1, 1, 3).setValues([row]); } });
  ensureSheet_(ss, 'Browse', BROWSE_HEAD_);
  // A copied spreadsheet brings its script properties along; a copy must not answer to the original's key.
  var id = ss.getId();
  if (props.getProperty('SHEET_ID') && props.getProperty('SHEET_ID') !== id) { props.deleteProperty('KEY'); Logger.log('This sheet is a copy: a new key was made.'); }
  props.setProperty('SHEET_ID', id);
  if (!props.getProperty('KEY')) props.setProperty('KEY', Utilities.getUuid().replace(/-/g, ''));
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('tick').timeBased().everyMinutes(10).create();
  } catch (err) { Logger.log('The ten-minute timer was not started: ' + err); }
  locked_(function () { fillRoutineIds_(); writeBrowse_(readTasks_().list); });
  Logger.log('Docket is set up. Version ' + VERSION_ + '.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Docket').addItem('Set up or upgrade this sheet', 'setupFromMenu').addItem('Show connection code', 'showCode').addToUi();
}
function setupFromMenu() {
  setup();
  dialog_('Docket is set up', '<p>Next:</p><ol><li>Deploy &gt; New deployment &gt; Web app. Execute as: Me. Who has access: Anyone. '
    + 'After pasting a newer Code.gs, use Deploy &gt; Manage deployments &gt; edit &gt; New version instead.</li>'
    + '<li>Docket &gt; Show connection code, then paste the code into the app\'s Settings.</li></ol>');
}
function showCode() {
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key) { dialog_('Run setup first', '<p>Use Docket &gt; Set up or upgrade this sheet.</p>'); return; }
  // The address comes from the deployment itself. ScriptApp.getService().getUrl() can name a different deployment
  // that answers nobody, so it is never used to build the code.
  Logger.log('Key: ' + key);
  dialog_('Connection code', '<p>The code has two parts joined by <b>#</b>.</p>' +
    '<ol><li>In Extensions &gt; Apps Script choose Deploy &gt; Manage deployments and copy the <b>Web app URL</b>. It ends in /exec. ' +
    'No deployment yet? Deploy &gt; New deployment &gt; Web app, Execute as Me, Who has access Anyone.</li>' +
    '<li>Add <b>#</b> and this key right after it:</li></ol>' +
    '<textarea readonly style="width:100%;height:44px" onfocus="this.select()">#' + key + '</textarea>' +
    '<p>Paste the result into the app: the status button, then Save and sync.</p>');
}
function dialog_(title, html) {
  try { SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput('<div style="font:14px Arial">' + html + '</div>').setWidth(460).setHeight(300), title); }
  catch (err) { Logger.log(title + ': ' + html.replace(/<[^>]+>/g, ' ')); }
}

/* ---------- requests ---------- */

function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function out_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out_({ ok: true, data: { app: 'Docket', version: VERSION_ } }); }
function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request' }); }
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || body.key !== key) return out_({ ok: false, error: 'Wrong key', auth: true });
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return out_({ ok: false, error: 'The sheet is busy, try again' }); }
  try {
    switch (body.action) {
      case 'ping': return out_({ ok: true, data: { version: VERSION_ } });
      case 'sync': return out_({ ok: true, data: sync_(body) });
      default: return out_({ ok: false, error: 'Unknown action' });
    }
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}
/** Runs every ten minutes: applies what the assistant or the owner typed into Inbox and Edits, so Tasks is current even when no phone syncs. */
function tick() {
  locked_(function () {
    var warn = [], state = readTasks_(), touched = {};
    applyInbox_(state, touched, warn);
    applyEdits_(state, touched, warn);
    if (Object.keys(touched).length) { calendar_(state, touched, warn); writeTasks_(state, touched); writeBrowse_(state.list); }
  });
}

/* ---------- tasks ---------- */

function taskOf_(v, row) {
  return { id: s_(v[0]), t: s_(v[1]), status: pick_(v[2], STATUSES_, 'Open').toLowerCase(), tier: pick_(v[3], TIERS_, 'Active'), dom: pick_(v[4], DOMAINS_, 'Personal'),
    wh: pick_(v[5], WHERES_, 'Phone'), place: s_(v[6]), buy: yes_(v[7]), label: s_(v[8]), chain: s_(v[9]), after: s_(v[10]), date: cellDate_(v[11]), time: cellTime_(v[12]),
    cal: yes_(v[13]), dur: Number(v[14]) || 60, eventId: s_(v[15]), remId: s_(v[16]), notes: String(v[17] == null ? '' : v[17]), guessed: yes_(v[18]), src: s_(v[19]),
    routine: s_(v[20]), created: s_(v[21]), updated: s_(v[22]), doneAt: s_(v[23]), _row: row };
}
function rowOf_(t) {
  return [t.id, t.t, t.status === 'done' ? 'Done' : t.status === 'dropped' ? 'Dropped' : 'Open', t.tier, t.dom, t.wh, t.place, flag_(t.buy), t.label, t.chain, t.after, t.date, t.time,
    flag_(t.cal), t.cal ? String(t.dur || 60) : '', t.eventId, t.remId, t.notes, flag_(t.guessed), t.src, t.routine, t.created, t.updated, t.doneAt];
}
/** Every task in the tab, by ID. A second row with an ID already seen is ignored and reported. */
function readTasks_() {
  var sh = sheet_('Tasks'), last = sh.getLastRow(), list = [], byId = {}, dup = [];
  if (last > 1) {
    sh.getRange(2, 1, last - 1, TASK_HEAD_.length).getValues().forEach(function (v, i) {
      var t = taskOf_(v, i + 2);
      if (!t.id) return;
      if (byId[t.id]) { dup.push(t.id); return; }
      byId[t.id] = t; list.push(t);
    });
  }
  return { sh: sh, list: list, byId: byId, last: Math.max(last, 1), dup: dup };
}
/** Writes the touched tasks back: changed rows in place, new rows appended. Rows are found by ID, so sorting the tab is harmless. */
function writeTasks_(state, touched) {
  var fresh = [];
  Object.keys(touched).forEach(function (id) {
    var t = state.byId[id];
    if (!t) return;
    if (t._row) state.sh.getRange(t._row, 1, 1, TASK_HEAD_.length).setValues([rowOf_(t)]);
    else fresh.push(t);
  });
  if (fresh.length) {
    ensureRows_(state.sh, state.last + fresh.length);
    state.sh.getRange(state.last + 1, 1, fresh.length, TASK_HEAD_.length).setValues(fresh.map(rowOf_));
    fresh.forEach(function (t, i) { t._row = state.last + 1 + i; });
    state.last += fresh.length;
  }
}
function text_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max); }
/** A task from a request, with every field checked. Returns null when it has no usable ID or title. */
function cleanTask_(x) {
  if (!x || !/^[A-Za-z0-9_-]{3,40}$/.test(s_(x.id)) || !s_(x.t)) return null;
  var status = pick_(x.status, STATUSES_, 'Open').toLowerCase();
  var date = dateOk_(s_(x.date)), time = date ? timeOk_(s_(x.time)) : '';
  return { id: s_(x.id), t: text_(x.t, 300).trim(), status: status, tier: pick_(x.tier, TIERS_, 'Active'), dom: pick_(x.dom, DOMAINS_, 'Personal'), wh: pick_(x.wh, WHERES_, 'Phone'),
    place: text_(x.place, 120).trim(), buy: !!x.buy, label: text_(x.label, 60).trim(), chain: text_(x.chain, 80).trim(), after: /^[A-Za-z0-9_-]{3,40}$/.test(s_(x.after)) ? s_(x.after) : '',
    date: date, time: time, cal: !!x.cal && !!date && !!time, dur: [30, 60, 120].indexOf(Number(x.dur)) >= 0 ? Number(x.dur) : 60, eventId: text_(x.eventId, 200).trim(),
    remId: text_(x.remId, 200).trim(), notes: text_(x.notes, 4000), guessed: !!x.guessed, src: text_(x.src, 20).trim() || 'app', routine: text_(x.routine, 40).trim(),
    created: text_(x.created, 30).trim() || now_(), updated: text_(x.updated, 30).trim() || now_(), doneAt: status === 'open' ? '' : (text_(x.doneAt, 30).trim() || now_()) };
}
/** True when making `id` wait for `after` would close a loop. */
function loops_(byId, id, after) {
  var seen = {}, cur = after;
  while (cur && !seen[cur]) { if (cur === id) return true; seen[cur] = true; cur = byId[cur] ? byId[cur].after : ''; }
  return false;
}
/** Tasks from a phone: the newer copy of each task wins, by its Updated stamp. */
function upsert_(state, incoming, touched, warn) {
  (incoming || []).forEach(function (x) {
    var t = cleanTask_(x);
    if (!t) { warn.push('A task without an ID or a title was skipped.'); return; }
    var have = state.byId[t.id];
    if (have && have.updated > t.updated) return;
    if (t.after && (t.after === t.id || loops_(state.byId, t.id, t.after))) { t.after = ''; warn.push('"' + t.t + '" would have waited on itself, so its waits-for link was removed.'); }
    if (have) { t._row = have._row; t.eventId = t.eventId || have.eventId; t.created = have.created || t.created; state.list[state.list.indexOf(have)] = t; }
    else state.list.push(t);
    state.byId[t.id] = t;
    touched[t.id] = true;
  });
}

/* ---------- Inbox and Edits: how the assistant and the owner write without the app ---------- */

function applyInbox_(state, touched, warn) {
  var sh = sheet_('Inbox'), last = sh.getLastRow();
  if (last < 2) return;
  // A sheet set up before 1.3.0 gets the Task ID, Calendar block and Block length columns here, so pasting a newer Code.gs is enough.
  if (sh.getMaxColumns() < INBOX_HEAD_.length) sh.insertColumnsAfter(sh.getMaxColumns(), INBOX_HEAD_.length - sh.getMaxColumns());
  if (s_(sh.getRange(1, 16).getValue()) !== 'Task ID') {
    sh.getRange(1, 1, 1, INBOX_HEAD_.length).setValues([INBOX_HEAD_]).setFontWeight('bold');
    sh.getRange(1, 16, sh.getMaxRows(), 3).setNumberFormat('@');
  }
  var rows = sh.getRange(2, 1, last - 1, INBOX_HEAD_.length).getValues(), made = {}, pending = [];
  rows.forEach(function (v, i) {
    if (!s_(v[1]) || s_(v[14])) return;
    var date = cellDate_(v[10]), stamp = now_(), mins = Number(s_(v[17]));
    var t = { id: newId_(), t: text_(v[1], 300).trim(), status: 'open', tier: pick_(v[2], TIERS_, 'Active'), dom: pick_(v[3], DOMAINS_, 'Personal'), wh: pick_(v[4], WHERES_, 'Phone'),
      place: text_(v[5], 120).trim(), buy: yes_(v[6]), label: text_(v[7], 60).trim(), chain: text_(v[8], 80).trim(), after: '', date: date, time: date ? cellTime_(v[11]) : '',
      cal: false, dur: [30, 60, 120].indexOf(mins) >= 0 ? mins : 60, eventId: '', remId: '', notes: text_(v[12], 4000), guessed: yes_(v[13]) || !s_(v[3]) || !s_(v[4]), src: s_(v[3]) && s_(v[4]) ? 'Claude' : 'Inbox:' + (s_(v[3]) ? '' : 'd') + (s_(v[4]) ? '' : 'w'), routine: '', created: stamp, updated: stamp, doneAt: '' };
    t.cal = yes_(v[16]) && !!t.date && !!t.time;   // a block needs a day and a time
    while (state.byId[t.id]) t.id = newId_();
    state.byId[t.id] = t; state.list.push(t); touched[t.id] = true;
    made[t.t.toLowerCase()] = t.id;
    pending.push({ t: t, after: s_(v[9]), row: i + 2 });
  });
  // "After" names the step this one waits for: a row of the same batch first, then an open task, by title or by ID.
  pending.forEach(function (p) {
    if (p.after) {
      var key = p.after.toLowerCase(), hit = made[key] || (state.byId[p.after] ? p.after : '');
      if (!hit) state.list.some(function (o) { if (o.status === 'open' && o.t.toLowerCase() === key) { hit = o.id; return true; } return false; });
      if (hit && hit !== p.t.id && !loops_(state.byId, p.t.id, hit)) p.t.after = hit;
      else warn.push('Inbox: "' + p.t.t + '" names "' + p.after + '" to wait for, which was not found.');
    }
    sh.getRange(p.row, 15, 1, 2).setValues([['Done', p.t.id]]);   // the new task's ID, so the next step can address it through Edits
  });
}
function applyEdits_(state, touched, warn) {
  var sh = sheet_('Edits'), last = sh.getLastRow();
  if (last < 2) return;
  sh.getRange(2, 1, last - 1, EDIT_HEAD_.length).getValues().forEach(function (v, i) {
    if ((!s_(v[0]) && !s_(v[1])) || s_(v[3])) return;
    var refuse = function (why) { sh.getRange(i + 2, 4, 1, 2).setValues([['Refused', why]]); };
    var t = state.byId[s_(v[0])], key = EDIT_FIELDS_[pick_(v[1], Object.keys(EDIT_FIELDS_), '')], val = String(v[2] == null ? '' : v[2]);
    if (!t) return refuse('No task has this ID.');
    if (!key) return refuse('Field must be one of: ' + Object.keys(EDIT_FIELDS_).join(', ') + '.');
    var x = s_(val), next;
    switch (key) {
      case 't': if (!x) return refuse('A title cannot be blank.'); next = text_(x, 300); break;
      case 'status': next = pick_(x, STATUSES_, ''); if (!next) return refuse('Status must be Open, Done or Dropped.'); next = next.toLowerCase(); break;
      case 'tier': next = pick_(x, TIERS_, ''); if (!next) return refuse('Tier must be Prio, Active or Archived.'); break;
      case 'dom': next = pick_(x, DOMAINS_, ''); if (!next) return refuse('Domain must be Work, Personal or Admin.'); break;
      case 'wh': next = pick_(x, WHERES_, ''); if (!next) return refuse('Where must be Phone, Desk, Home or Out.'); break;
      case 'buy': case 'cal': case 'guessed': next = yes_(x); break;
      case 'date': next = v[2] instanceof Date ? ymd_(v[2]) : dateOk_(x); if (x && !next) return refuse('A date is written YYYY-MM-DD.'); break;
      case 'time': next = v[2] instanceof Date ? hm_(v[2]) : timeOk_(x); if (x && !next) return refuse('A time is written HH:MM.'); break;
      case 'dur': next = Number(x); if ([30, 60, 120].indexOf(next) < 0) return refuse('Block length is 30, 60 or 120 minutes.'); break;
      case 'after':
        next = '';
        if (x) {
          next = state.byId[x] ? x : '';
          if (!next) state.list.some(function (o) { if (o.status === 'open' && o.t.toLowerCase() === x.toLowerCase()) { next = o.id; return true; } return false; });
          if (!next) return refuse('No open task has this ID or title.');
          if (next === t.id || loops_(state.byId, t.id, next)) return refuse('That would make the task wait on itself.');
        }
        break;
      case 'notes': next = text_(val, 4000); break;
      default: next = text_(x, 200);
    }
    t[key] = next;
    if (key === 'status') t.doneAt = next === 'open' ? '' : now_();
    if (key === 'date' && !next) { t.time = ''; t.cal = false; }
    if ((key === 'time' || key === 'cal') && !(t.date && t.time)) t.cal = false;
    if (key === 'dom' || key === 'wh') t.guessed = false;
    t.updated = now_();
    touched[t.id] = true;
    sh.getRange(i + 2, 4, 1, 2).setValues([['Done', '']]);
  });
}

/* ---------- routines, rules, settings ---------- */

function fillRoutineIds_() {
  var sh = sheet_('Routines'), last = sh.getLastRow();
  if (last < 2) return;
  var rows = sh.getRange(2, 1, last - 1, 2).getValues(), used = {}, n = 0;
  rows.forEach(function (r) { var m = /^R(\d+)$/.exec(s_(r[0])); if (m) { used[s_(r[0])] = true; n = Math.max(n, +m[1]); } });
  rows.forEach(function (r, i) { if (s_(r[1]) && !s_(r[0])) { n++; sh.getRange(i + 2, 1).setValue('R' + n); } });
}
function readRoutines_() {
  fillRoutineIds_();
  var sh = sheet_('Routines'), last = sh.getLastRow(), out = [];
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, ROUTINE_HEAD_.length).getValues().forEach(function (v, i) {
    if (!s_(v[0]) || !s_(v[1])) return;
    out.push({ id: s_(v[0]), t: s_(v[1]), steps: String(v[2] == null ? '' : v[2]), tier: pick_(v[3], TIERS_, 'Active'), dom: pick_(v[4], DOMAINS_, 'Admin'), wh: pick_(v[5], WHERES_, 'Home'),
      place: s_(v[6]), cadence: /^a/i.test(s_(v[7])) ? 'After' : 'Fixed', every: s_(v[8]), next: cellDate_(v[9]), on: !/^(no|n|off|false|0)$/i.test(s_(v[10])), _row: i + 2 });
  });
  return out;
}
/** The phone moves a routine's Next due when the owner accepts or skips it, or finishes the task it made. */
function saveRoutines_(list, changes) {
  var sh = sheet_('Routines'), byId = {};
  list.forEach(function (r) { byId[r.id] = r; });
  (changes || []).forEach(function (c) {
    var r = byId[s_(c && c.id)], next = dateOk_(s_(c && c.next));
    if (!r || !next) return;
    r.next = next;
    sh.getRange(r._row, 10).setValue(next);
  });
}
function readRules_() {
  // Rows with a Match are the guesser's words and travel apart (`words`), so a page that predates them never reads them as rules.
  var sh = sheet_('Rules'), last = sh.getLastRow(), out = { rules: [], words: [] };
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, RULE_HEAD_.length).getValues().forEach(function (v, i) {
    var trait = pick_(v[1], RULE_TRAITS_, ''), k = s_(v[0]).toLowerCase(), val = s_(v[2]), m = pick_(v[4], MATCHES_, '');
    if (!k || !trait || (s_(v[4]) && !m)) return;   // an unknown Match is skipped, never read as a rule
    if (trait === 'Domain') val = pick_(val, DOMAINS_, '');
    if (trait === 'Where') val = pick_(val, WHERES_, '');
    if (trait === 'Buy') val = yes_(val) ? 'Yes' : 'No';
    if (!val) return;
    if (m) out.words.push({ k: k, trait: trait, value: val, m: m });
    else out.rules.push({ k: k, trait: trait, value: val, _row: i + 2 });
  });
  return out;
}
/** A correction made on a phone becomes a rule, so the same title is guessed right next time. The newest value for a keyword and trait wins. */
function saveRules_(have, fresh) {
  var sh = sheet_('Rules'), last = Math.max(sh.getLastRow(), 1);
  (fresh || []).forEach(function (x) {
    var k = text_(x && x.k, 120).trim().toLowerCase(), trait = pick_(x && x.trait, RULE_TRAITS_, ''), val = s_(x && x.value);
    if (!k || !trait) return;
    val = trait === 'Domain' ? pick_(val, DOMAINS_, '') : trait === 'Where' ? pick_(val, WHERES_, '') : (yes_(val) ? 'Yes' : 'No');
    if (!val) return;
    var hit = null;
    have.forEach(function (r) { if (r.k === k && r.trait === trait) hit = r; });
    if (hit) { if (hit.value !== val) { hit.value = val; sh.getRange(hit._row, 3).setValue(val); } return; }
    last++;
    ensureRows_(sh, last);
    sh.getRange(last, 1, 1, 4).setValues([[k, trait, val, 'correction']]);
    have.push({ k: k, trait: trait, value: val, _row: last });
  });
}
function readSettings_() {
  var sh = sheet_('Settings'), last = sh.getLastRow(), map = {};
  if (last > 1) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (v) { map[s_(v[0])] = s_(v[1]); });
  var n = function (name, d) { var x = Number(map[name]); return x > 0 ? Math.round(x) : d; };
  return { calShow: map['Calendars to show'] || '', calBlock: map['Block calendar'] || '', stale: n('Stale after (days)', 14), prio: n('Prio window (days)', 2),
    history: n('Done history (days)', 90), remList: map['Reminders list'] || 'Reminders', buyList: map['Buy list'] || 'Buy', colors: colors_(map['Block colours']) };
}
// "Out=1, Work=2" becomes [['Out', '1'], ['Work', '2']]: Where or Domain names, each with a Google Calendar colour ID. Anything else is skipped.
function colors_(v) {
  var out = [];
  s_(v).split(',').forEach(function (p) {
    var m = /^\s*([A-Za-z]+)\s*=\s*(\d{1,2})\s*$/.exec(p), name = m ? pick_(m[1], WHERES_.concat(DOMAINS_), '') : '';
    if (name && +m[2] >= 1 && +m[2] <= 11) out.push([name, String(+m[2])]);
  });
  return out;
}

/* ---------- calendar ---------- */

function calById_(id) { return id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar(); }
// A block's Google Calendar colour ID: the first name in the Settings row Block colours that is the task's Where or Domain; '' for none.
// The app's row bars use the same rule (colorOf in index.html).
function blockColor_(t, colors) {
  for (var i = 0; i < colors.length; i++) if (colors[i][0] === t.wh || colors[i][0] === t.dom) return colors[i][1];
  return '';
}
function startOf_(t) { var d = t.date.split('-'), h = t.time.split(':'); return new Date(+d[0], +d[1] - 1, +d[2], +h[0], +h[1], 0); }
/**
 * Keeps calendar blocks and tasks in step. A task with Calendar block on, a date and a time owns one event.
 * A task changed in this request is written to its event; otherwise an event moved or deleted in Google Calendar is read back into the task.
 * A finished task keeps its event as a record; a dropped one loses it.
 */
function calendar_(state, touched, warn) {
  var set = readSettings_(), cal = null, tried = false, hues = {};
  set.colors.forEach(function (c) { hues[c[1]] = true; });
  var colorOf = function (t) { return blockColor_(t, set.colors); };
  var theCal = function () { if (!tried) { tried = true; try { cal = calById_(set.calBlock); } catch (err) { cal = null; } if (!cal) warn.push('The block calendar was not found, so calendar blocks were not updated.'); } return cal; };
  state.list.forEach(function (t) {
    var want = t.status === 'open' && t.cal && !!t.date && !!t.time;
    if (!want && !t.eventId) return;
    var done = t.status === 'done';
    if (done && !touched[t.id]) return;
    try {
      var c = theCal();
      if (!c) return;
      var ev = t.eventId ? c.getEventById(t.eventId) : null;
      // A finished task keeps its event as a record, and an edit to its title, day or time still reaches that event.
      if (done) {
        if (ev && t.date && t.time) {
          var ds = startOf_(t), de = new Date(ds.getTime() + (t.dur || 60) * 60000);
          if (ev.getStartTime().getTime() !== ds.getTime() || ev.getEndTime().getTime() !== de.getTime()) ev.setTime(ds, de);
          if (ev.getTitle() !== t.t) ev.setTitle(t.t);
        }
        return;
      }
      var touch = function () { t.updated = now_(); touched[t.id] = true; };
      if (!want) { if (ev) ev.deleteEvent(); t.eventId = ''; touch(); return; }
      var start = startOf_(t), end = new Date(start.getTime() + (t.dur || 60) * 60000);
      if (!ev) {
        if (t.eventId && !touched[t.id]) { t.eventId = ''; t.cal = false; t.date = ''; t.time = ''; touch(); return; }   // deleted in Google Calendar
        var made = c.createEvent(t.t, start, end, { description: 'From Docket' });
        if (colorOf(t)) made.setColor(colorOf(t));
        t.eventId = made.getId(); touch(); return;
      }
      if (touched[t.id]) {
        if (ev.getStartTime().getTime() !== start.getTime() || ev.getEndTime().getTime() !== end.getTime()) ev.setTime(start, end);
        if (ev.getTitle() !== t.t) ev.setTitle(t.t);
        // Traits may have changed. A colour outside the listed IDs was picked by hand in Google Calendar and is kept.
        var hue = ev.getColor(), fit = colorOf(t);
        if (fit && hue !== fit && (!hue || hues[hue])) ev.setColor(fit);
        return;
      }
      if (!ev.getColor() && colorOf(t)) ev.setColor(colorOf(t));   // a block that never got a colour; one picked by hand in Google Calendar is kept
      if (ev.getStartTime().getTime() !== start.getTime() || ev.getEndTime().getTime() !== end.getTime()) {
        var mins = Math.round((ev.getEndTime().getTime() - ev.getStartTime().getTime()) / 60000);
        t.date = ymd_(ev.getStartTime()); t.time = hm_(ev.getStartTime()); t.dur = [30, 60, 120].indexOf(mins) >= 0 ? mins : t.dur; touch();   // moved in Google Calendar
      }
    } catch (err) { warn.push('Calendar block for "' + t.t + '": ' + (err && err.message ? err.message : err)); }
  });
}
/**
 * Changes the owner made to a calendar event in the app: its title, its day and its times. Only the fields that were sent change,
 * and a new start keeps the event's length. Only calendars named in Settings can be changed.
 *
 * A repeating event is changed in one of two ways. scope "one" changes the single occurrence that started on x.od at x.ot.
 * scope "all" renames the whole series, and moves the times of every occurrence when the Google Calendar API advanced service
 * is added to this script (Services in the editor); the day of a whole series is changed in Google Calendar.
 */
function occurrence_(c, id, date, time) {
  var p = date.split('-'), from = new Date(+p[0], +p[1] - 1, +p[2]), hit = null;
  c.getEvents(from, new Date(from.getTime() + 86400000)).some(function (e) {
    if (e.getId() !== id) return false;
    if (!time || e.isAllDayEvent() || hm_(e.getStartTime()) === time) { hit = e; return true; }
    return false;
  });
  return hit;
}
function addDaysYmd_(ymd, n) { var p = ymd.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)); return d.toISOString().slice(0, 10); }
function seriesEdit_(calId, ev, x, title, has, warn) {
  var name = ev.getTitle();
  if (has('t') && title && title !== name) ev.getEventSeries().setTitle(title);
  if (has('date')) warn.push('"' + name + '": the day of every occurrence is changed in Google Calendar.');
  if ((!has('time') && !has('end')) || ev.isAllDayEvent()) return;
  if (typeof Calendar === 'undefined' || !Calendar.Events) {
    warn.push('"' + name + '": moving every occurrence needs the Google Calendar API service. In the script editor choose Services, add Google Calendar API, then publish a new version.');
    return;
  }
  var apiCal = calId || 'primary', apiId = ev.getId().split('@')[0], res = Calendar.Events.get(apiCal, apiId);
  if (!res || !res.start || !res.start.dateTime) return;
  var tz = res.start.timeZone || tz_(), s0 = new Date(res.start.dateTime), e0 = new Date(res.end.dateTime);
  var day = Utilities.formatDate(s0, tz, 'yyyy-MM-dd'), mins = Math.round((e0.getTime() - s0.getTime()) / 60000);
  var time = has('time') ? timeOk_(s_(x.time)) : Utilities.formatDate(s0, tz, 'HH:mm'), end = has('end') ? timeOk_(s_(x.end)) : '';
  if (!time) return;
  var m = function (hm) { var q = hm.split(':'); return (+q[0]) * 60 + (+q[1]); }, two = function (n) { return ('0' + n).slice(-2); };
  var endTotal = end && end > time ? m(end) : m(time) + mins, endDay = addDaysYmd_(day, Math.floor(endTotal / 1440)), endMin = endTotal % 1440;
  Calendar.Events.patch({
    start: { dateTime: day + 'T' + time + ':00', timeZone: tz },
    end: { dateTime: endDay + 'T' + two(Math.floor(endMin / 60)) + ':' + two(endMin % 60) + ':00', timeZone: tz }
  }, apiCal, apiId);
}
function applyEvents_(edits, warn) {
  if (!edits || !edits.length) return;
  var set = readSettings_(), allowed = set.calShow ? set.calShow.split(',').map(s_).filter(function (x) { return x; }) : [''];
  edits.slice(0, 50).forEach(function (x) {
    var name = s_(x && x.t) || 'An event';
    try {
      var calId = s_(x.calId), id = s_(x.id), od = dateOk_(s_(x.od)), ot = timeOk_(s_(x.ot)), has = function (k) { return x[k] != null; };
      var c = allowed.indexOf(calId) >= 0 ? calById_(calId) : null;
      var ev = c ? ((od && occurrence_(c, id, od, ot)) || c.getEventById(id)) : null;
      if (!ev) { warn.push('"' + name + '" was not found on a calendar shown in Docket, so it was not changed.'); return; }
      var title = text_(x.t, 300).trim();
      if (ev.isRecurringEvent()) {
        if (!od) { warn.push('"' + ev.getTitle() + '" repeats; update the app to change it from here.'); return; }
        if (s_(x.scope) === 'all') { seriesEdit_(calId, ev, x, title, has, warn); return; }
      }
      if (has('t') && title && title !== ev.getTitle()) ev.setTitle(title);
      if (!has('date') && !has('time') && !has('end')) return;
      var all = ev.isAllDayEvent();
      var date = has('date') ? dateOk_(s_(x.date)) : ymd_(all ? ev.getAllDayStartDate() : ev.getStartTime());
      var time = has('time') ? timeOk_(s_(x.time)) : (all ? '' : hm_(ev.getStartTime()));
      if (!date) return;
      if (!time) { var p = date.split('-'); ev.setAllDayDate(new Date(+p[0], +p[1] - 1, +p[2])); return; }
      var a = startOf_({ date: date, time: time }), mins = all ? 60 : Math.round((ev.getEndTime().getTime() - ev.getStartTime().getTime()) / 60000);
      var b = new Date(a.getTime() + mins * 60000), end = has('end') ? timeOk_(s_(x.end)) : '';
      if (end && end > time) b = startOf_({ date: date, time: end });
      ev.setTime(a, b);
    } catch (err) { warn.push('Event "' + name + '": ' + (err && err.message ? err.message : err)); }
  });
}
/** Events of the next seven days from the calendars in Settings, without the ones that are a task's own block. */
function events_(state, warn) {
  var set = readSettings_(), out = [], own = {};
  state.list.forEach(function (t) { if (t.eventId) own[t.eventId] = true; });
  var from = new Date(); from.setHours(0, 0, 0, 0);
  var to = new Date(from.getTime() + 7 * 86400000);
  var ids = set.calShow ? set.calShow.split(',').map(s_).filter(function (x) { return x; }) : [''];
  ids.forEach(function (id) {
    try {
      var c = calById_(id);
      if (!c) { warn.push('Calendar "' + id + '" was not found.'); return; }
      c.getEvents(from, to).forEach(function (ev) {
        if (own[ev.getId()]) return;
        var all = ev.isAllDayEvent();
        out.push({ id: ev.getId(), calId: id, t: ev.getTitle(), date: ymd_(all ? ev.getAllDayStartDate() : ev.getStartTime()), time: all ? '' : hm_(ev.getStartTime()), end: all ? '' : hm_(ev.getEndTime()), cal: c.getName(), rec: !!ev.isRecurringEvent(), color: ev.getColor() || '' });
      });
    } catch (err) { warn.push('Calendar "' + (id || 'main') + '": ' + (err && err.message ? err.message : err)); }
  });
  out.sort(function (a, b) { return (a.date + ' ' + (a.time || '00:00')) < (b.date + ' ' + (b.time || '00:00')) ? -1 : 1; });
  return out;
}

/* ---------- Browse: a copy the owner may sort and filter ---------- */

function writeBrowse_(list) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('Browse') || ensureSheet_(ss, 'Browse', BROWSE_HEAD_);
  var byId = {}, set = readSettings_();
  list.forEach(function (t) { byId[t.id] = t; });
  var limit = ymd_(new Date(new Date().getTime() + set.prio * 86400000));
  var waits = function (t) { var seen = {}, cur = byId[t.after]; while (cur && !seen[cur.id]) { if (cur.status === 'open') return cur; seen[cur.id] = true; cur = byId[cur.after]; } return null; };
  var rows = list.filter(function (t) { return t.status === 'open'; }).map(function (t) {
    var w = waits(t), shown = t.date && t.date <= limit ? 'Prio' : t.tier;
    return [t.id, t.t, shown, t.tier, t.dom, t.wh, t.wh === 'Phone' || t.wh === 'Desk' ? 'Online' : 'Physical', t.place, flag_(t.buy), t.label, t.chain, w ? w.t : '', w ? 'Waiting' : 'Yes',
      t.date, t.time, flag_(t.cal), t.notes, flag_(t.guessed), t.src, t.created, t.updated];
  });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, BROWSE_HEAD_.length).clearContent();
  if (rows.length) { ensureRows_(sh, rows.length + 1); sh.getRange(2, 1, rows.length, BROWSE_HEAD_.length).setValues(rows); }
}

/* ---------- sync ---------- */

/**
 * One request does everything: it applies Inbox and Edits, takes the phone's changed tasks (the newer copy of a task wins),
 * moves routines, saves new rules, reconciles calendar blocks, and answers with the whole current state.
 */
function sync_(body) {
  var warn = [], state = readTasks_(), touched = {};
  state.dup.forEach(function (id) { warn.push('Task ID ' + id + ' appears on more than one row; the first row is used.'); });
  applyInbox_(state, touched, warn);
  applyEdits_(state, touched, warn);
  upsert_(state, body.tasks, touched, warn);
  var routines = readRoutines_();
  saveRoutines_(routines, body.routines);
  var rules = readRules_();
  saveRules_(rules.rules, body.rules);
  calendar_(state, touched, warn);
  applyEvents_(body.events, warn);
  if (Object.keys(touched).length) { writeTasks_(state, touched); writeBrowse_(state.list); }
  var set = readSettings_();
  var cut = new Date(new Date().getTime() - set.history * 86400000).toISOString();
  var strip = function (o) { var c = {}; Object.keys(o).forEach(function (k) { if (k.charAt(0) !== '_') c[k] = o[k]; }); return c; };
  return {
    version: VERSION_, now: now_(), today: ymd_(new Date()),
    tasks: state.list.filter(function (t) { return t.status === 'open' || (t.doneAt || t.updated) >= cut; }).map(strip),
    routines: routines.map(strip), rules: rules.rules.map(strip), words: rules.words, settings: set, events: events_(state, warn), warn: warn
  };
}
