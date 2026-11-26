// Tests apps-script/Code.gs through the in-memory fake of Google's services. Run: node test/backend.test.js
const vm = require('vm');
const { load } = require('./mock-backend.js');

let fails = 0, count = 0;
function ok(cond, msg) { count++; if (!cond) { fails++; console.log('FAIL: ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }

function post(sb, body) { sb.__e = { postData: { contents: JSON.stringify(body) } }; return JSON.parse(vm.runInContext('doPost(__e)', sb).text); }
function sync(sb, extra) { const r = post(sb, Object.assign({ key: sb.props.KEY, action: 'sync' }, extra || {})); if (!r.ok) throw new Error(r.error); return r.data; }
const tab = (sb, n) => sb.sheets.find(s => s.name === n);
const stamp = (min) => new Date(Date.now() + (min || 0) * 60000).toISOString();
const task = (id, t, more) => Object.assign({ id, t, status: 'open', tier: 'Active', dom: 'Personal', wh: 'Phone', created: stamp(-5), updated: stamp() }, more || {});
const pad = n => String(n).padStart(2, '0');
const localDay = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = localDay(new Date());

// 1 setup
{
  const sb = load();
  eq(sb.sheets.map(s => s.name).filter(n => n !== 'Sheet1'), ['Tasks', 'Routines', 'Rules', 'Inbox', 'Edits', 'Settings', 'Browse'], 'setup makes the seven tabs');
  ok(/^[0-9a-f]{32}$/.test(sb.props.KEY), 'setup makes a key');
  eq(sb.triggers.map(t => [t.fn, t.every]), [['tick', 10]], 'setup starts the ten-minute timer');
  eq(tab(sb, 'Settings').rowsOf().length, 8, 'Settings has its eight rows');
  const key = sb.props.KEY;
  tab(sb, 'Settings').getRange(4, 2).setValue('21');
  vm.runInContext('setup()', sb);
  ok(sb.props.KEY === key && sb.triggers.length === 1 && tab(sb, 'Settings').rowsOf().length === 8, 'running setup again keeps the key, one timer and the settings');
  eq(sync(sb).settings.stale, 21, 'a setting typed in the sheet is read');
  sb.ss.id = 'a-copy';
  vm.runInContext('setup()', sb);
  ok(sb.props.KEY !== key, 'a copied sheet gets a key of its own');
  ok(tab(sb, 'Tasks').protections.length === 1 && tab(sb, 'Tasks').protections[0].warn, 'Tasks carries one warning-only protection');
}

// 2 key
{
  const sb = load();
  const r = post(sb, { key: 'nope', action: 'sync' });
  ok(!r.ok && r.auth === true, 'a wrong key is refused');
  ok(post(sb, { key: sb.props.KEY, action: 'ping' }).data.version === sb.VERSION_, 'ping answers with the version');
  ok(!post(sb, { key: sb.props.KEY, action: 'nothing' }).ok, 'an unknown action is refused');
}

// 3 tasks travel between devices; the newer copy wins; rows are found by ID
{
  const sb = load();
  let d = sync(sb, { tasks: [task('Ta1', '=Item A', { buy: true, wh: 'Out', place: '-Place A', notes: '+Note A' }), task('Ta2', 'Task A')] });
  eq(d.tasks.map(t => t.t), ['=Item A', 'Task A'], 'both tasks come back, text starting with = kept as typed');
  eq(tab(sb, 'Tasks').rowsOf()[0].slice(0, 8), ['Ta1', '=Item A', 'Open', 'Active', 'Personal', 'Out', '-Place A', 'Yes'], 'the row is written in readable words');
  ok(sync(sb).tasks.length === 2, 'a second device receives them');
  d = sync(sb, { tasks: [task('Ta2', 'Task B', { updated: stamp(-60) })] });
  eq(d.tasks.find(t => t.id === 'Ta2').t, 'Task A', 'an older copy does not overwrite a newer one');
  d = sync(sb, { tasks: [task('Ta2', 'Task B', { updated: stamp(1) })] });
  eq(d.tasks.find(t => t.id === 'Ta2').t, 'Task B', 'a newer copy wins');
  const sh = tab(sb, 'Tasks'); sh.putRows(sh.rowsOf().reverse());
  sync(sb, { tasks: [task('Ta1', 'Item B', { buy: true, updated: stamp(2) })] });
  eq(sh.rowsOf().map(r => r[1]), ['Task B', 'Item B'], 'after the owner sorts the tab, the right row is still updated');
  d = sync(sb, { tasks: [{ id: '', t: 'Task Z' }, { id: 'Ta9', t: '   ' }] });
  ok(d.tasks.length === 2 && d.warn.length === 2, 'tasks without an ID or a title are skipped with a warning');
  d = sync(sb, { tasks: [task('Ta3', 'Task C', { tier: 'Urgent', dom: 'Play', wh: 'Moon', date: '21/11/2026', time: '9am', dur: 45 })] });
  const t3 = d.tasks.find(t => t.id === 'Ta3');
  eq([t3.tier, t3.dom, t3.wh, t3.date, t3.time, t3.dur], ['Active', 'Personal', 'Phone', '', '', 60], 'values outside the lists fall back to defaults');
}

// 4 waits-for loops are refused
{
  const sb = load();
  sync(sb, { tasks: [task('Ta1', 'Task A'), task('Ta2', 'Task B', { after: 'Ta1' })] });
  const d = sync(sb, { tasks: [task('Ta1', 'Task A', { after: 'Ta2', updated: stamp(1) })] });
  ok(d.tasks.find(t => t.id === 'Ta1').after === '' && /waited on itself/.test(d.warn.join(' ')), 'a link that closes a loop is removed and reported');
}

// 5 Inbox: the assistant adds tasks and chains
{
  const sb = load();
  sync(sb, { tasks: [task('Ta1', 'Task A')] });
  tab(sb, 'Inbox').append([
    [stamp(), 'Task B', 'Active', 'Admin', 'Out', 'Place A', '', '', 'Chain A', 'Task A', '', '', 'Note A', '', ''],
    [stamp(), 'Task C', '', 'Admin', 'Home', '', '', '', 'Chain A', 'Task B', '2026-12-01', '09:30', '', '', ''],
    [stamp(), 'Task D', '', '', '', '', 'yes', 'Label A', '', 'Task Z', '', '', '', '', ''],
    [stamp(), 'Task E', '', '', '', '', '', '', '', '', '', '', '', '', 'Dismissed'],
  ]);
  const d = sync(sb);
  const by = t => d.tasks.find(x => x.t === t);
  eq(d.tasks.length, 4, 'three waiting Inbox rows become tasks; a row with a Status is left alone');
  ok(by('Task B').after === 'Ta1' && by('Task C').after === by('Task B').id, 'After links a row to an open task and to a row of the same batch');
  eq([by('Task C').date, by('Task C').time, by('Task B').place, by('Task B').src], ['2026-12-01', '09:30', 'Place A', 'Claude'], 'date, time, place and source are kept');
  ok(by('Task D').guessed && by('Task D').buy && !by('Task B').guessed, 'a row without Domain or Where is marked as guessed');
  ok(/Task Z/.test(d.warn.join(' ')), 'an After that matches nothing is reported');
  eq(tab(sb, 'Inbox').rowsOf().map(r => r[14]), ['Done', 'Done', 'Done', 'Dismissed'], 'applied rows are marked Done');
  ok(sync(sb).tasks.length === 4, 'the rows are not applied twice');
  tab(sb, 'Inbox').append([[stamp(), 'Task F', '', 'Work', 'Desk']]);
  vm.runInContext('tick()', sb);
  ok(tab(sb, 'Tasks').rowsOf().some(r => r[1] === 'Task F'), 'the timer applies the Inbox without a phone');
}

// 6 Edits: changes by task ID
{
  const sb = load();
  sync(sb, { tasks: [task('Ta1', 'Task A', { guessed: true }), task('Ta2', 'Task B')] });
  tab(sb, 'Edits').append([
    ['Ta1', 'Where', 'desk', '', ''], ['Ta1', 'Due date', '2026-12-05', '', ''], ['Ta1', 'Due time', '14:00', '', ''], ['Ta1', 'Calendar block', 'Yes', '', ''],
    ['Ta2', 'Waits for', 'task a', '', ''], ['Ta2', 'Tier', 'Soon', '', ''], ['Zz9', 'Title', 'x', '', ''], ['Ta1', 'Waits for', 'Ta2', '', ''], ['Ta2', 'Status', 'Done', '', ''],
  ]);
  const d = sync(sb), t1 = d.tasks.find(t => t.id === 'Ta1'), t2 = d.tasks.find(t => t.id === 'Ta2');
  eq([t1.wh, t1.date, t1.time, t1.cal, t1.guessed], ['Desk', '2026-12-05', '14:00', true, false], 'edits change the fields, and setting Where confirms a guess');
  ok(t2.after === 'Ta1' && t2.status === 'done' && !!t2.doneAt, 'Waits for accepts a title, and Status Done stamps Done at');
  eq(tab(sb, 'Edits').rowsOf().map(r => r[3]), ['Done', 'Done', 'Done', 'Done', 'Done', 'Refused', 'Refused', 'Refused', 'Done'], 'each row is marked Done or Refused');
  ok(/Prio, Active or Archived/.test(tab(sb, 'Edits').rowsOf()[5][4]) && /wait on itself/.test(tab(sb, 'Edits').rowsOf()[7][4]), 'a refusal says why');
  ok(sb.cals[''].events.length === 1 && sb.cals[''].events[0].title === 'Task A', 'an edit that turns on the calendar block makes the event');
}

// 7 routines and rules
{
  const sb = load();
  tab(sb, 'Routines').append([['', 'Weekly routine A', '', 'Active', 'Admin', 'Desk', '', 'Fixed', 'Mon', '2026-11-23', ''], ['', 'Routine B', 'Step 1 > Step 2 > Step 3', '', 'Admin', 'Home', '', 'After', '30', '', 'No']]);
  let d = sync(sb);
  eq(d.routines.map(r => [r.id, r.cadence, r.every, r.next, r.on]), [['R1', 'Fixed', 'Mon', '2026-11-23', true], ['R2', 'After', '30', '', false]], 'routines get IDs and are read');
  d = sync(sb, { routines: [{ id: 'R1', next: '2026-11-30' }, { id: 'R7', next: '2026-11-30' }, { id: 'R2', next: 'soon' }] });
  eq(d.routines.map(r => r.next), ['2026-11-30', ''], 'the phone moves Next due; unknown routines and bad dates are ignored');
  d = sync(sb, { rules: [{ k: 'Keyword A', trait: 'Where', value: 'Phone' }, { k: 'keyword a', trait: 'Domain', value: 'Admin' }, { k: 'x', trait: 'Other', value: 'x' }] });
  eq(d.rules.map(r => [r.k, r.trait, r.value]), [['keyword a', 'Where', 'Phone'], ['keyword a', 'Domain', 'Admin']], 'corrections are saved as rules, lower-cased');
  d = sync(sb, { rules: [{ k: 'keyword a', trait: 'Where', value: 'Out' }] });
  ok(d.rules.length === 2 && d.rules[0].value === 'Out', 'a newer value for the same keyword and trait replaces the old one');
  tab(sb, 'Rules').append([['keyword b', 'Domain', 'Work', 'owner']]);
  ok(sync(sb).rules.some(r => r.k === 'keyword b' && r.value === 'Work'), 'a rule typed in the sheet reaches the phone');
  tab(sb, 'Rules').append([['Word A', 'Where', 'home', 'test', 'Word'], ['word b', 'Domain', 'Work', 'test', 'start'], ['word c', 'Where', 'Phone', 'test', 'buy'], ['word d', 'Where', 'Out', 'test', 'wrod']]);
  d = sync(sb);
  eq(d.words, [{ k: 'word a', trait: 'Where', value: 'Home', m: 'word' }, { k: 'word b', trait: 'Domain', value: 'Work', m: 'start' }, { k: 'word c', trait: 'Where', value: 'Phone', m: 'buy' }], 'rows with a Match travel as words; an unknown Match is skipped');
  ok(d.rules.length === 3 && d.rules.every(r => !/^word/.test(r.k) && !('m' in r)), 'a word is never sent as a rule');
  d = sync(sb, { rules: [{ k: 'word a', trait: 'Where', value: 'Desk' }] });
  ok(d.words[0].value === 'Home' && d.rules.some(r => r.k === 'word a' && r.value === 'Desk'), 'a correction with a word\'s keyword becomes a rule of its own and leaves the word as it was');
}

// 8 calendar blocks and events
{
  const sb = load();
  const at = (h, m) => { const x = new Date(); x.setHours(h, m, 0, 0); return x; };
  let d = sync(sb, { tasks: [task('Ta1', 'Task A', { date: today, time: '15:00', cal: true, dur: 120 }), task('Ta2', 'Task B', { date: today, time: '16:00' })] });
  const main = sb.cals[''];
  eq(main.events.map(e => [e.title, e.start.getHours(), (e.end - e.start) / 60000]), [['Task A', 15, 120]], 'a task with a calendar block gets one event of its length; a timed task without one gets none');
  ok(main.events[0].color === undefined, 'with Block colours blank, a block keeps the calendar\'s own colour');
  ok(!!d.tasks.find(t => t.id === 'Ta1').eventId, 'the event ID comes back to the phone');
  sync(sb, { tasks: [task('Ta1', 'Task C', { date: today, time: '16:30', cal: true, dur: 60, updated: stamp(1) })] });
  eq([main.events.length, main.events[0].title, main.events[0].start.getHours(), main.events[0].start.getMinutes()], [1, 'Task C', 16, 30], 'changing the task moves and renames its event');
  main.events[0].setTime(at(9, 0), at(11, 0));
  d = sync(sb);
  eq([d.tasks.find(t => t.id === 'Ta1').time, d.tasks.find(t => t.id === 'Ta1').dur], ['09:00', 120], 'moving the event in the calendar moves the task');
  main.createEvent('Event A', at(13, 0), at(14, 0)); main.createAllDayEvent('Event B', at(0, 0));
  sb.cals['b@example.test'].createEvent('Event C', at(10, 0), at(10, 15));
  d = sync(sb);
  eq(d.events.map(e => [e.t, e.time]), [['Event B', ''], ['Event A', '13:00']], 'events of the main calendar are listed without the task\'s own block');
  const den = d.events.find(e => e.t === 'Event A'), denEv = main.events.find(e => e.id === den.id);
  ok(den.calId === '' && den.rec === false, 'each event names its calendar and says whether it repeats');
  denEv.setColor('11');
  eq(sync(sb).events.map(e => [e.t, e.color]), [['Event B', ''], ['Event A', '11']], 'each event returns its colour ID, empty for the calendar default');
  denEv.setColor('');
  sync(sb, { events: [{ id: den.id, calId: '', t: 'Event A, moved', time: '15:30' }] });
  eq([denEv.title, denEv.start.getHours(), denEv.start.getMinutes(), (denEv.end - denEv.start) / 60000], ['Event A, moved', 15, 30, 60], 'an event changed in the app is renamed and moved, keeping its length');
  sync(sb, { events: [{ id: den.id, calId: '', end: '17:00' }] });
  eq([denEv.title, denEv.start.getHours(), (denEv.end - denEv.start) / 60000], ['Event A, moved', 15, 90], 'sending only a new end changes the length and nothing else');
  denEv.rec = true;
  d = sync(sb, { events: [{ id: den.id, calId: '', t: 'Event A, renamed' }] });
  ok(denEv.title === 'Event A, moved' && /repeats/.test(d.warn.join(' ')), 'a repeating event is left alone and reported');
  denEv.rec = false;
  d = sync(sb, { events: [{ id: den.id, calId: 'b@example.test', t: 'Event A, renamed' }] });
  ok(denEv.title === 'Event A, moved' && /not found on a calendar shown/.test(d.warn.join(' ')), 'a calendar that Settings does not show cannot be changed');
  denEv.setTitle('Event A'); denEv.setTime(at(13, 0), at(14, 0));
  d = sync(sb);
  // a repeating event: two occurrences that share one ID
  const day2 = (h, m) => new Date(at(h, m).getTime() + 86400000);
  const o1 = main.createEvent('Event C', at(16, 0), at(16, 30)), o2 = main.createEvent('Event C', day2(16, 0), day2(16, 30));
  o1.id = o2.id = 'series1@mock'; o1.rec = o2.rec = true;
  const tomorrowYmd = (() => { const x = day2(0, 0); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); })();
  d = sync(sb, { events: [{ id: 'series1@mock', calId: '', scope: 'one', od: tomorrowYmd, ot: '16:00', t: 'Event C (moved)', time: '17:00' }] });
  eq([o1.title, o1.start.getHours(), o2.title, o2.start.getHours(), (o2.end - o2.start) / 60000], ['Event C', 16, 'Event C (moved)', 17, 30], 'changing one occurrence of a repeating event leaves the others alone');
  d = sync(sb, { events: [{ id: 'series1@mock', calId: '', scope: 'all', od: today, ot: '16:00', t: 'Event C, daily' }] });
  eq([o1.title, o2.title], ['Event C, daily', 'Event C, daily'], 'renaming all occurrences renames the series');
  d = sync(sb, { events: [{ id: 'series1@mock', calId: '', scope: 'all', od: today, ot: '16:00', time: '15:00' }] });
  ok(o1.start.getHours() === 16 && /Google Calendar API service/.test(d.warn.join(' ')), 'moving all occurrences without the Calendar API service is refused with the step that enables it');
  main.events.splice(main.events.indexOf(o1), 1); main.events.splice(main.events.indexOf(o2), 1);
  d = sync(sb);
  tab(sb, 'Settings').getRange(2, 2).setValue(', b@example.test, missing@example.test');
  d = sync(sb);
  ok(d.events.length === 1 && d.events[0].t === 'Event C' && d.events[0].cal === 'Calendar B' && /missing@example.test/.test(d.warn.join(' ')), 'Calendars to show picks the calendars; one that is not found is reported');
  main.events.find(e => e.title === 'Task C').deleteEvent();
  d = sync(sb);
  const t1 = d.tasks.find(t => t.id === 'Ta1');
  eq([t1.cal, t1.date, t1.time, t1.eventId], [false, '', '', ''], 'deleting the event in the calendar unschedules the task');
  sync(sb, { tasks: [task('Ta3', 'Task D', { date: today, time: '18:00', cal: true }), task('Ta4', 'Task E', { date: today, time: '19:00', cal: true })] });
  eq(main.events.filter(e => /Task [DE]/.test(e.title)).length, 2, 'two more blocks are made');
  sync(sb, { tasks: [task('Ta3', 'Task D', { status: 'dropped', date: today, time: '18:00', cal: true, updated: stamp(1) }), task('Ta4', 'Task E', { status: 'done', date: today, time: '19:00', cal: true, updated: stamp(1) })] });
  eq(main.events.filter(e => /Task [DE]/.test(e.title)).map(e => e.title), ['Task E'], 'a dropped task loses its event; a finished task keeps it as a record');
  sync(sb, { tasks: [task('Ta5', 'Task F', { date: today, time: '20:00', cal: true })] });
  sync(sb, { tasks: [task('Ta5', 'Task F', { date: today, time: '20:00', cal: false, updated: stamp(1) })] });
  ok(!main.events.some(e => e.title === 'Task F'), 'turning the block off removes the event');
}

// 9 history window and Browse
{
  const sb = load();
  const old = new Date(Date.now() - 120 * 86400000).toISOString();
  const d = sync(sb, { tasks: [task('Ta1', 'Task A', { status: 'done', doneAt: old, updated: old }), task('Ta2', 'Task B', { status: 'done' }), task('Ta3', 'Task C'), task('Ta4', 'Task D', { after: 'Ta3', date: today })] });
  eq(d.tasks.map(t => t.t), ['Task B', 'Task C', 'Task D'], 'finished tasks older than the history window stay in the sheet only');
  eq(tab(sb, 'Tasks').rowsOf().length, 4, 'the sheet keeps every task');
  eq(tab(sb, 'Browse').rowsOf().map(r => [r[1], r[2], r[11], r[12]]), [['Task C', 'Active', '', 'Yes'], ['Task D', 'Prio', 'Task C', 'Waiting']], 'Browse lists open tasks with the shown tier and what each waits for');
}

// 10 block colours, edits to a finished task's block, and Inbox rows that ask for a block
{
  const sb = load();
  const main = sb.cals[''];
  const evOf = (id) => main.getEventById(sync(sb).tasks.find(t => t.id === id).eventId);
  const st = tab(sb, 'Settings');
  st.getRange(st.rowsOf().findIndex(r => r[0] === 'Block colours') + 2, 2).setValue('Out=1, Work=2, Home=3, Admin=5, Personal=8');
  sync(sb, { tasks: [
    task('Tc1', 'Task A', { dom: 'Work', wh: 'Phone', date: today, time: '09:00', cal: true }),
    task('Tc2', 'Task B', { dom: 'Admin', wh: 'Out', date: today, time: '10:00', cal: true }),
    task('Tc3', 'Task C', { dom: 'Admin', wh: 'Home', date: today, time: '11:00', cal: true }),
    task('Tc4', 'Task D', { dom: 'Admin', wh: 'Desk', date: today, time: '12:00', cal: true }),
    task('Tc5', 'Task E', { dom: 'Personal', wh: 'Phone', date: today, time: '13:00', cal: true }),
    task('Tc6', 'Task F', { dom: 'Personal', wh: 'Home', date: today, time: '14:00', cal: true }),
  ] });
  eq(['Tc1', 'Tc2', 'Tc3', 'Tc4', 'Tc5', 'Tc6'].map(id => evOf(id).getColor()), ['2', '1', '3', '5', '8', '3'], 'a new block takes the colour of the first name in Block colours that fits it');
  sync(sb, { tasks: [task('Tc7', 'Task G', { dom: 'Work', wh: 'Out', date: today, time: '15:00', cal: true })] });
  eq(evOf('Tc7').getColor(), '1', 'a Work task that is Out takes Out\'s colour, the earlier name');
  sync(sb, { tasks: [task('Tc5', 'Task E', { dom: 'Work', wh: 'Phone', date: today, time: '13:00', cal: true, updated: stamp(1) })] });
  eq(evOf('Tc5').getColor(), '2', 'changing a trait recolours the block');
  evOf('Tc6').setColor('11');
  sync(sb, { tasks: [task('Tc6', 'Task F', { dom: 'Admin', wh: 'Home', date: today, time: '14:30', cal: true, updated: stamp(2) })] });
  eq([evOf('Tc6').getColor(), evOf('Tc6').start.getMinutes()], ['11', 30], 'a colour picked by hand in Google Calendar is kept when the task changes');
  evOf('Tc4').color = '';
  sync(sb);
  eq(evOf('Tc4').getColor(), '5', 'a block left without a colour gets one at the next sync');

  // a finished task keeps its block, and an edit to it still moves the block
  sync(sb, { tasks: [task('Tc3', 'Task C', { status: 'done', dom: 'Admin', wh: 'Home', date: today, time: '11:00', cal: true, updated: stamp(3) })] });
  tab(sb, 'Edits').append([['Tc3', 'Due time', '08:15'], ['Tc3', 'Title', 'Task C (done early)']]);
  sync(sb);
  const done = main.events.find(e => /Task C/.test(e.title));
  eq([done.title, done.start.getHours(), done.start.getMinutes()], ['Task C (done early)', 8, 15], 'an edit to a finished task reaches its block');

  // Inbox: Calendar block and Block length, and the new task's ID written back
  tab(sb, 'Inbox').append([
    [stamp(), 'Task H', '', 'Admin', 'Out', 'Place A', '', '', 'Chain A', '', today, '15:00', '', '', '', '', 'Yes', '30'],
    [stamp(), 'Task I', '', 'Admin', 'Out', 'Place A', '', '', 'Chain A', 'Task H', today, '17:00', '', '', '', '', 'yes', ''],
    [stamp(), 'Task J', '', 'Personal', 'Home', '', '', '', '', '', today, '', '', '', '', '', 'Yes', '60'],
    [stamp(), 'Task K', '', 'Personal', 'Phone', '', '', '', '', '', today, '18:00', '', '', ''],
  ]);
  const d = sync(sb);
  const by = t => d.tasks.find(x => x.t === t);
  const rows = tab(sb, 'Inbox').rowsOf();
  eq(rows.map(r => [r[14], r[15]]), ['Task H', 'Task I', 'Task J', 'Task K'].map(t => ['Done', by(t).id]), 'each applied Inbox row gets the new task\'s ID');
  eq([by('Task H').cal, by('Task H').dur, by('Task I').cal, by('Task I').dur, by('Task J').cal, by('Task K').cal],
    [true, 30, true, 60, false, false], 'an Inbox row can switch the block on with a length; a block needs a time');
  const drop = main.getEventById(by('Task H').eventId);
  eq([drop.start.getHours(), (drop.end - drop.start) / 60000, drop.getColor()], [15, 30, '1'], 'the Inbox block is made in the same sync, with its colour');
  eq(tab(sb, 'Inbox').getRange(1, 16, 1, 3).getValues()[0], ['Task ID', 'Calendar block', 'Block length'], 'the Inbox header names the three new columns');
}

// 11 an Inbox tab made by an older version gains the new columns by itself
{
  const sb = load();
  const inbox = tab(sb, 'Inbox');
  delete inbox.cells['1,16']; delete inbox.cells['1,17']; delete inbox.cells['1,18'];
  inbox.append([[stamp(), 'Task A', '', 'Admin', 'Home', '', '', '', '', '', '', '', '', '', '']]);
  const d = sync(sb);
  ok(d.tasks.some(t => t.t === 'Task A'), 'a 15-column Inbox row still becomes a task');
  eq(inbox.getRange(1, 16).getValue(), 'Task ID', 'the header is upgraded without running setup');
}

console.log(fails ? fails + ' of ' + count + ' checks failed' : 'all ' + count + ' back-end checks pass');
process.exit(fails ? 1 : 0);
