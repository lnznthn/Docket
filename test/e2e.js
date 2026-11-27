// Drives the real app in Chrome against the mock back end. Run: node test/e2e.js
// It starts a static server for the repository and the mock back end by itself, and writes screenshots to test/shots/.
const { spawn } = require('child_process'), path = require('path'), fs = require('fs'), http = require('http');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); }

const ROOT = path.join(__dirname, '..'), APP_PORT = +process.env.APP_PORT || 8765, API_PORT = +process.env.API_PORT || 8766;
const APP = 'http://localhost:' + APP_PORT + '/index.html', API = 'http://localhost:' + API_PORT;
const SHOTS = path.join(__dirname, 'shots');
let fails = 0, count = 0;
const ok = (cond, msg) => { count++; if (!cond) { fails++; console.log('FAIL: ' + msg); } };
const req = (url, body) => new Promise((res, rej) => { const r = http.request(url, { method: body == null ? 'GET' : 'POST' }, (x) => { let d = ''; x.on('data', (c) => d += c); x.on('end', () => res(d)); }); r.on('error', rej); if (body != null) r.write(typeof body === 'string' ? body : JSON.stringify(body)); r.end(); });
const dump = async () => JSON.parse(await req(API + '/_dump'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const today = (() => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); })();

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const web = spawn('python3', ['-m', 'http.server', String(APP_PORT)], { cwd: ROOT, stdio: 'ignore' });
  const api = spawn('node', [path.join(__dirname, 'mock-backend.js'), String(API_PORT)], { stdio: 'ignore' });
  const stop = () => { web.kill(); api.kill(); };
  process.on('exit', stop);
  await sleep(1200);
  const key = await req(API + '/_reset');
  // The guesser's words and the block colours live in the sheet. Placeholders, put in as the owner or an assistant would.
  await req(API + '/_rows', { tab: 'Rules', rows: [['alpha', 'Domain', 'Admin', 'test', 'word'], ['alpha', 'Where', 'Home', 'test', 'word'], ['bravo', 'Domain', 'Admin', 'test', 'word'],
    ['bravo', 'Where', 'Out', 'test', 'word'], ['charlie', 'Where', 'Home', 'test', 'word'], ['delta', 'Where', 'Phone', 'test', 'start'], ['echo', 'Where', 'Phone', 'test', 'buy']] });
  await req(API + '/_rows', { tab: 'Settings', rows: [['Block colours', 'Out=1, Work=2']] });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [];
  const device = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text())) errors.push(m.text()); });
    await page.goto(APP);
    return { ctx, page };
  };
  const vis = (page, sel) => page.locator(sel + ':visible');
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const add = async (page, text) => { await vis(page, '[data-a="addopen"]').first().click(); await page.fill('#draft', text); };
  const synced = async (page) => { await page.waitForFunction(() => { const e = [...document.querySelectorAll('.stat')].find((x) => x.offsetParent); return e && e.textContent === 'Synced'; }, null, { timeout: 15000 }); };
  const connect = async (page) => { await vis(page, '.stat').first().click(); await page.fill('#code', API + '#' + key); await page.click('[data-a="connect"]'); await synced(page); await page.click('.sheet [data-a="setclose"]'); };
  const row = (page, title) => page.locator('.row', { hasText: title }).first();
  const tab = (page, k) => vis(page, '.tabs [data-a="tab"][data-v="' + k + '"]').click();
  const texts = (page, sel) => page.locator(sel).allTextContents();

  // ---- phone, not connected yet
  const A = await device(390, 844), p = A.page;
  ok((await p.locator('.empty').textContent()).includes('Nothing here yet'), 'a new device opens on an empty Today with a hint');
  ok((await vis(p, '.stat').first().textContent()) === 'Not connected', 'the status says the device is not connected');
  await add(p, 'buy Item A');
  ok((await texts(p, '#guess .gchip')).join('|') === 'Buy item|Personal|Shop', 'typing shows the guessed kind, Domain and Where');
  await p.click('#guess [data-a="cwh"]');
  ok((await texts(p, '#guess .gchip'))[2] === 'Order online' && (await p.evaluate(() => document.activeElement.id)) === 'draft', 'tapping a chip changes it and keeps the cursor in the field');
  await p.click('#guess [data-a="cwh"]');
  await p.keyboard.press('Enter');
  ok((await p.locator('.toast span').textContent()).startsWith('Added Item A to Buy: Personal · Shop'), 'adding confirms with a message');
  ok(await p.locator('.sheet').count() === 0 && (await p.locator('.hdr h1').textContent()) === 'Today', 'adding closes the panel and stays on the same tab');
  await tab(p, 'buy');
  ok((await texts(p, '.sec .sh h2')).join('|') === 'Shop not set' && await row(p, 'Item A').count() === 1, 'the Buy item is on the Buy tab under Shop not set');

  // ---- connect: what was added before connecting goes up
  await connect(p);
  let d = await dump();
  ok(d.Tasks.length === 1 && d.Tasks[0][1] === 'Item A' && d.Tasks[0][7] === 'Yes', 'connecting sends the task made before the connection');
  // the words arrive with the sync: whole words with an ending, words that count only at the start, and buy words for a Buy item's Where
  await add(p, 'Task Y charlies');
  ok((await texts(p, '#guess .gchip')).join('|') === 'Task|Personal|Home', 'a word from the sheet is found with an ending');
  await p.fill('#draft', 'delta task'); const atStart = (await texts(p, '#guess .gchip'))[2];
  await p.fill('#draft', 'task delta'); const later = (await texts(p, '#guess .gchip'))[2];
  ok(atStart === 'Phone' && later === 'Phone ?', 'a start word counts only as the first word');
  await p.fill('#draft', 'buy item echo'); const online = (await texts(p, '#guess .gchip'))[2];
  await p.fill('#draft', 'task echo');
  ok(online === 'Order online' && (await texts(p, '#guess .gchip'))[2] === 'Phone ?', 'a buy word makes a Buy item an online order and nothing else');
  await p.click('[data-a="addcancel"]');

  // ---- capture, details, scheduling
  await add(p, 'Task A'); await p.keyboard.press('Enter');
  await add(p, 'task B alpha'); await p.keyboard.press('Enter');
  await add(p, 'Task C'); await p.keyboard.press('Enter');
  await tab(p, 'view');
  ok(await row(p, 'Task A').locator('.m1').textContent() === 'Phone ?', 'a guessed task shows its Where with a question mark');
  ok((await row(p, 'Task B alpha').locator('.m1').textContent()) === 'Home ?' && (await row(p, 'Task B alpha').locator('.m2').textContent()).includes('Admin'), 'a chore is guessed as Admin at Home');
  await row(p, 'Task A').locator('[data-a="open"]').click();
  ok(await p.locator('#detail').isVisible() && await p.locator('#dTitle').inputValue() === 'Task A', 'tapping a row opens its details');
  await shot(p, 'p_detail');
  const whY = (await p.locator('.trait[data-v="wh"]').boundingBox()).y;
  await p.click('.trait[data-v="wh"]');
  ok(Math.abs((await p.locator('.trait[data-v="wh"]').boundingBox()).y - whY) < 1, 'opening a picker does not move the trait row');
  await p.click('#detail .segs [data-v="Out"]');
  await p.fill('#dPlace', 'Place A');
  await p.click('.day[data-v="' + today + '"]');
  await p.fill('#dTime', '15:30');
  await p.locator('#dTime').blur();
  await p.click('.calb');
  await p.click('#detail .segs [data-v="120"]');
  await p.fill('#dNotes', 'Note A');
  ok(await p.locator('#dNotes').inputValue() === 'Note A' && (await p.evaluate(() => document.activeElement.id)) === 'dNotes', 'typing notes keeps the field and the cursor');
  await shot(p, 'p_detail_full');
  await p.click('#detail .foot [data-a="close"]');
  await tab(p, 'today');
  ok((await texts(p, '.sec .sh h2'))[0] === 'Timeline' && (await row(p, 'Task A').locator('.when').textContent()) === '3:30 PM', 'a task timed today moves to the Timeline');
  await synced(p);
  d = await dump();
  const ta = d.Tasks.find((r) => r[1] === 'Task A');
  ok(ta[5] === 'Out' && ta[6] === 'Place A' && ta[11] === today && ta[12] === '15:30' && ta[13] === 'Yes' && ta[14] === '120' && ta[17] === 'Note A' && ta[18] === '', 'the sheet holds the place, date, time, block, length and notes, and the guess is confirmed');
  ok(d._events.length === 1 && d._events[0].title === 'Task A' && (new Date(d._events[0].end) - new Date(d._events[0].start)) === 7200000, 'the calendar block exists and is two hours long');
  ok(d.Rules.some((r) => r[0] === 'task a' && r[1] === 'Where' && r[2] === 'Out'), 'the correction is saved as a rule');

  // ---- chains
  await tab(p, 'view');
  await row(p, 'Task B alpha').locator('[data-a="open"]').click();
  await p.click('.trait[data-v="after"]');
  await p.fill('#aq', 'task a');
  ok((await texts(p, '#alist button')).join('|') === 'Nothing|Task A', 'the waits-for list filters as he types');
  await p.click('#alist button >> text=Task A');
  await p.click('#detail .foot [data-a="close"]');
  ok(await p.locator('.row:not(.wait)', { hasText: 'Task B alpha' }).count() === 0, 'a task that waits is no longer listed as actionable');
  await tab(p, 'today');
  ok((await row(p, 'Task A').locator('.more').textContent()) === '+1', 'the step it waits for shows +1');
  await row(p, 'Task A').locator('.more').click();
  ok(await p.locator('.row.wait', { hasText: 'Task B alpha' }).count() === 1 && await p.locator('.row.wait [data-a="flip"]').count() === 0, 'the waiting step shows greyed and cannot be ticked');
  await shot(p, 'p_today');
  await row(p, 'Task A').locator('[data-a="flip"]').click();
  ok((await p.locator('.toast span').textContent()) === 'Done: Task A. Next: Task B alpha', 'ticking names the step it unlocked');
  await p.click('.toast [data-a="toast"]');
  ok(await row(p, 'Task A').count() === 1 && await p.locator('.toast').count() === 0, 'Undo brings the task back');

  // ---- a second device, and changes travelling both ways
  const B = await device(390, 844), q = B.page;
  await connect(q);
  await tab(q, 'view');
  ok(await row(q, 'Task C').count() === 1 && await row(q, 'Task A').count() === 1, 'a second device receives the tasks');
  await row(q, 'Task C').locator('[data-a="flip"]').click();
  await synced(q);
  await vis(p, '.stat').first().click(); await p.click('[data-a="syncnow"]'); await synced(p); await p.click('.sheet [data-a="setclose"]');
  await tab(p, 'all');
  ok((await p.locator('.sec', { hasText: 'Done' }).locator('.row', { hasText: 'Task C' }).count()) === 1, 'a task finished on one device shows as done on the other');

  // ---- the assistant writes to the Inbox; guesses are reviewed
  await req(API + '/_rows', { tab: 'Inbox', rows: [['', 'Task D bravo', '', '', '', '', '', '', '', '', '', '', '', '', ''], ['', 'Task E', 'Prio', 'Work', 'Desk', '', '', '', '', '', '', '', 'Note B', '', ''],
    ['', 'Task F charlie', '', '', '', '', '', '', '', '', '', '', '', '', ''], ['', 'Task G', 'Active', 'Personal', 'Phone', '', '', '', '', '', '', '', '', '', '']] });
  await req(API + '/_rows', { tab: 'Routines', rows: [['', 'Weekly routine A', '', 'Active', 'Admin', 'Desk', '', 'Fixed', 'Mon', '', '']] });
  const at = (h) => { const x = new Date(); x.setHours(h, 0, 0, 0); return x.toISOString(); };
  await req(API + '/_cal', { add: { title: 'Event A', start: at(9), end: at(10) } });
  await vis(p, '.stat').first().click(); await p.click('[data-a="syncnow"]'); await synced(p); await p.click('.sheet [data-a="setclose"]');
  await tab(p, 'today');
  await shot(p, 'p_today_full');
  ok((await row(p, 'Event A').locator('.when').textContent()) === '9:00 AM' && await row(p, 'Event A').locator('[data-a="flip"]').count() === 0, 'a calendar event shows on the Timeline without a checkbox');
  ok((await p.locator('.sec', { hasText: 'Prio' }).locator('.row', { hasText: 'Task E' }).count()) === 1, 'a Prio task from the Inbox shows under Prio');
  await row(p, 'Event A').locator('[data-a="ev"]').click();
  ok((await p.locator('#eTime').inputValue()) === '09:00' && (await p.locator('#eEnd').inputValue()) === '10:00' && (await p.locator('#detail .note').textContent()).includes('Calendar: Main'), 'tapping a calendar event shows its day, times and calendar');
  await p.fill('#eTitle', 'Event A, moved');
  await p.fill('#eTime', '11:00'); await p.locator('#eTime').blur();
  ok((await p.locator('#eEnd').inputValue()) === '12:00', 'moving an event\'s start keeps its length');
  await p.click('#detail .foot [data-a="close"]');
  await synced(p);
  d = await dump();
  const evA = d._events.find((e) => e.title === 'Event A, moved');
  ok(!!evA && new Date(evA.start).getHours() === 11 && (new Date(evA.end) - new Date(evA.start)) === 3600000, 'the renamed and moved event reaches the calendar');
  ok((await row(p, 'Event A, moved').locator('.when').textContent()) === '11:00 AM', 'the Timeline shows the event at its new time');
  // a repeating event: two occurrences with one ID
  const dayAt = (off, hh) => { const x = new Date(); x.setDate(x.getDate() + off); x.setHours(hh, 0, 0, 0); return x.toISOString(); };
  await req(API + '/_cal', { add: { title: 'Event C', start: dayAt(0, 18), end: dayAt(0, 19), series: 'series9@mock' } });
  await req(API + '/_cal', { add: { title: 'Event C', start: dayAt(1, 18), end: dayAt(1, 19), series: 'series9@mock' } });
  await vis(p, '.stat').first().click(); await p.click('[data-a="syncnow"]'); await synced(p); await p.click('.sheet [data-a="setclose"]');
  await row(p, 'Event C').locator('[data-a="ev"]').click();
  ok(await p.locator('#detail [data-a="evscope"]').count() === 2 && await p.locator('#eDate').isEnabled(), 'a repeating event opens with a choice of this event or all events');
  await p.fill('#eTime', '19:00'); await p.locator('#eTime').blur();
  await p.click('#detail .foot [data-a="close"]'); await synced(p);
  d = await dump();
  let occ = d._events.filter((e) => e.id === 'series9@mock').sort((a, b) => (a.start < b.start ? -1 : 1));
  ok(new Date(occ[0].start).getHours() === 19 && new Date(occ[1].start).getHours() === 18, 'moving this event leaves the other occurrence where it was');
  await row(p, 'Event C').locator('[data-a="ev"]').click();
  await p.click('#detail [data-a="evscope"][data-v="all"]');
  ok(await p.locator('#eDate').isDisabled(), 'with All events chosen, the day is not offered');
  await p.fill('#eTitle', 'Event C, daily');
  await p.click('#detail .foot [data-a="close"]'); await synced(p);
  d = await dump();
  occ = d._events.filter((e) => e.id === 'series9@mock');
  ok(occ.length === 2 && occ.every((e) => e.title === 'Event C, daily'), 'renaming all events renames every occurrence');
  await p.click('[data-a="range"][data-v="week"]');
  ok((await texts(p, '.sec .sh h2'))[0].startsWith('Today · ') && await row(p, 'Event A').count() === 1 && await row(p, 'Task A').count() === 1, 'the Week range lists each day with its events and tasks in one sequence');
  await shot(p, 'p_week');
  await p.click('[data-a="range"][data-v="tomorrow"]');
  ok((await texts(p, '.sec .sh h2')).join('|').startsWith('Tomorrow · ') && await row(p, 'Event C, daily').count() === 1 && await row(p, 'Event A, moved').count() === 0, 'Tomorrow lists only that day, including its occurrence of the repeating event');
  await p.click('[data-a="range"][data-v="today"]');
  ok((await p.locator('.sug b').textContent()) === 'Weekly routine A', 'a routine that is due shows as a suggestion');
  await p.click('.sug [data-a="racc"]');
  ok(await p.locator('.sug').count() === 0 && (await p.locator('.sec', { hasText: 'Anytime today' }).locator('.row', { hasText: 'Weekly routine A' }).count()) === 1, 'accepting it makes the task for today');
  await p.locator('.row', { hasText: 'guessed traits' }).locator('[data-a="link"]').click();
  ok((await p.locator('.hdr .sub').textContent()).includes('Guessed'), 'the review link opens View filtered to guessed tasks');
  await shot(p, 'p_guessed');
  ok((await row(p, 'Task D bravo').locator('.m1').textContent()) === 'Out ?' && (await row(p, 'Task D bravo').locator('.m2').textContent()).includes('Admin'), 'a task that arrived without traits gets them guessed on the device');
  const before = await p.locator('.okb').count();
  await row(p, 'Task D bravo').locator('.okb').click();
  ok(before === 3 && await p.locator('.okb').count() === 2, 'OK on a row confirms that one guess');
  ok(await p.locator('.row.wait', { hasText: 'Task B alpha' }).locator('.okb').count() === 1, 'a guessed step that still waits is listed for review too');
  await p.locator('.row', { hasText: 'look right' }).locator('[data-a="link"]').click();
  ok(await p.locator('.okb').count() === 0 && (await texts(p, '.gss')).length === 0, 'the top row confirms the rest and clears the filter');
  await synced(p);
  d = await dump();
  ok(/^\d{4}-\d{2}-\d{2}$/.test(d.Routines[0][9]) && d.Routines[0][9] > today, 'the routine\'s next date moved forward in the sheet');
  ok(d.Tasks.find((r) => r[1] === 'Task F charlie')[5] === 'Home' && d.Tasks.every((r) => !/^Inbox/.test(r[19])), 'the guessed traits are written back to the sheet');
  ok(d.Tasks.filter((r) => r[2] === 'Open').every((r) => r[18] === '') && d.Inbox.every((r) => r[14] === 'Done'), 'no guesses are left in the sheet and the Inbox rows are marked Done');

  // ---- filters and Where grouping
  await tab(p, 'view');
  await p.click('.fbtn'); await p.click('.chip >> text=Heading out');
  ok((await texts(p, '.sec .sh h2')).join('|') === 'Out · physical|Phone · online' && await p.locator('.fpanel').count() === 1, 'Heading out shows Out first, then Phone, and the panel stays open');
  ok((await row(p, 'Task A').locator('.m1').textContent()) === 'Place A', 'an errand shows its place in the right-hand slot');
  ok(await p.locator('.row', { hasText: 'Shop not set · 1 to buy' }).count() === 1, 'the Out group rolls up the Buy items of each shop');
  await shot(p, 'p_heading_out');
  await p.emulateMedia({ colorScheme: 'dark' }); await shot(p, 'p_dark_filters'); await p.emulateMedia({ colorScheme: 'light' });
  await p.click('.chip[data-v="all"]'); await p.click('.chip[data-k="wh"][data-v="Home"]'); await p.click('.chip[data-k="mode"][data-v="Online"]');
  ok((await p.locator('.empty span').textContent()) === 'No open task matches these filters.', 'a filter that matches nothing says so');
  await p.click('[data-a="clearf"]');
  ok(await p.locator('.empty').count() === 0 && await p.locator('.fpanel').count() === 1, 'Clear filters restores the list and leaves the panel open');
  await p.click('.fbtn');
  ok(await p.locator('.fpanel').count() === 0, 'the Filter button closes the panel');

  // ---- selecting several tasks and changing them at once
  await p.click('.selb');
  ok(await p.locator('.bulk').isVisible() && await p.locator('.tabs').isHidden() && await p.locator('.bulk select[data-k="tier"]').isDisabled(), 'Select swaps the tab bar for an action bar that waits for a selection');
  await row(p, 'Task F charlie').locator('.lead').click();
  await row(p, 'Task G').locator('.body').click();
  ok((await p.locator('.hdr h1').textContent()) === '2 selected' && await p.locator('.row.picked').count() === 2 && await p.locator('#detail').count() === 0, 'ticking the box or the row selects it without opening details');
  await p.selectOption('.bulk select[data-k="tier"]', 'Archived');
  const arch = p.locator('.sec', { hasText: 'Archived' });
  ok(await arch.locator('.row', { hasText: 'Task F charlie' }).count() === 1 && await arch.locator('.row', { hasText: 'Task G' }).count() === 1 && (await p.locator('.toast span').textContent()) === 'Tier: Archived · 2 tasks', 'one choice changes the tier of every selected task');
  await shot(p, 'p_select');
  await p.click('.toast [data-a="toast"]');
  ok(await p.locator('.sec', { hasText: 'Archived' }).count() === 0 && await p.locator('.row.picked').count() === 2, 'Undo puts every task back and keeps the selection');
  await p.click('.bulk [data-k="done"]');
  ok(await row(p, 'Task F charlie').count() === 0 && (await p.locator('.toast span').textContent()) === 'Done · 2 tasks', 'Done finishes all of them');
  await p.click('.toast [data-a="toast"]');
  ok(await row(p, 'Task F charlie').count() === 1 && await row(p, 'Task G').count() === 1, 'and Undo reopens them');
  await p.locator('.selall').first().click();
  ok(await p.locator('.row.picked').count() >= 2 && (await p.locator('.selall').first().textContent()) === 'None', 'a section can be selected whole');
  await p.click('.bulk [data-a="selmode"]');
  ok(await p.locator('.bulk').count() === 0 && await p.locator('.tabs').isVisible() && await p.locator('.box').count() === 0, 'Close leaves Select mode');

  // ---- offline: changes wait, then go up
  await A.ctx.setOffline(true);
  await add(p, 'Task H'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => { const e = [...document.querySelectorAll('.stat')].find((x) => x.offsetParent); return e && /waiting/.test(e.textContent); }, null, { timeout: 15000 });
  ok(true, 'offline, the status shows changes waiting');
  await p.reload().catch(() => {});
  await A.ctx.setOffline(false);
  await p.goto(APP);
  await synced(p);
  d = await dump();
  ok(d.Tasks.some((r) => r[1] === 'Task H'), 'a task added offline reaches the sheet after a reload and a reconnect');

  // ---- a wrong key and an older script are reported
  await vis(p, '.stat').first().click(); await p.fill('#code', API + '#wrong'); await p.click('[data-a="connect"]');
  await p.waitForSelector('.set p >> text=The key was refused');
  ok(true, 'a wrong key is reported in Settings');
  await p.fill('#code', API + '#' + key); await p.click('[data-a="connect"]'); await synced(p);
  await req(API + '/_ver', '0.9.0'); await p.click('[data-a="syncnow"]'); await p.waitForSelector('.warnbox');
  ok((await p.locator('.warnbox').textContent()).includes('this app needs 1.x'), 'an older sheet script is reported');
  await p.click('.sheet [data-a="setclose"]');

  // ---- desktop
  const C = await device(1280, 900), w = C.page;
  await vis(w, '.side .stat').click(); await w.fill('#code', API + '#' + key); await w.click('[data-a="connect"]');
  await w.waitForFunction(() => document.querySelectorAll('.row').length > 3);
  await w.click('.sheet [data-a="setclose"]');
  ok((await texts(w, '.coltitle')).join('|') === 'Today\'s plan|View' && await w.locator('.tabs').isHidden(), 'the desktop shows Today\'s plan and View side by side with a side bar');
  const left = await texts(w, '.cols .col:first-child .row:not(.wait) .ttl'), right = await texts(w, '.cols .col.wide .row:not(.wait) .ttl');
  ok(left.filter((t) => right.indexOf(t) >= 0).length === 0 && (await w.locator('.col.wide .note').textContent()).includes('left out here'), 'nothing is listed on both sides, and View says what it leaves out');
  await w.click('.fbtn'); await w.click('.chip[data-k="dom"][data-v="Work"]'); await w.click('.chip[data-k="tier"][data-v="Prio"]');
  ok(await w.locator('.fpanel').count() === 1 && await w.locator('.chip.on').count() === 2, 'on the desktop, choosing filters keeps the panel open and marks each choice');
  await w.emulateMedia({ colorScheme: 'dark' }); await shot(w, 'd_dark_filters'); await w.emulateMedia({ colorScheme: 'light' });
  await w.click('.chip[data-v="all"]'); await w.click('.fbtn');
  await w.locator('.col.wide .row', { hasText: 'Task H' }).locator('[data-a="open"]').click();
  ok(await w.locator('.row.cur + .inl').isVisible() && (await w.locator('.row.cur #dTitle').inputValue()) === 'Task H' && await w.locator('.cols > .col').count() === 2, 'on the desktop, details open under the clicked row and add no column');
  await shot(w, 'd_home_detail');
  ok(await w.locator('.inl [data-a="dflip"]').count() === 0 && await w.locator('.inl .xbtn').count() === 0 && await w.locator('.inl #dTitle').count() === 0, 'the expanded part repeats neither the ring nor the title, which is edited in the row');
  ok((await w.locator('.inl').boundingBox()).height < 260 && (await w.locator('.inl select').first().boundingBox()).height >= 24, 'the expanded part is a few compact lines whose controls stay at least 24 px high');
  await w.selectOption('.inl select[data-c="wh"]', 'Out');
  await w.fill('#dPlace', 'Place B');
  await w.selectOption('.inl select[data-c="tier"]', 'Archived');
  ok((await w.locator('.inl select[data-c="wh"]').inputValue()) === 'Out' && (await w.locator('#dPlace').inputValue()) === 'Place B' && await w.locator('.inl [data-a="dconfirm"]').count() === 0, 'the menus change Tier and Where in place, and choosing Where confirms the guess');
  await w.selectOption('.inl select[data-c="tier"]', 'Active');
  await w.locator('.row.cur #dTitle').click();
  ok(await w.locator('.inl').count() === 1, 'clicking into the title keeps the row open');
  await w.locator('.row.cur .m1').click();
  ok(await w.locator('.inl').count() === 0, 'clicking the open row again closes its details');
  await w.locator('.col.wide .row', { hasText: 'Task H' }).locator('[data-a="open"]').click();
  await w.fill('#dTitle', 'Task H, changed');
  await w.locator('#dTitle').blur();
  await w.waitForFunction(() => { const e = document.querySelector('.row.cur #dTitle'); return e && e.value === 'Task H, changed' && document.activeElement !== e; });
  ok(true, 'a title edited in the row is kept when the field is left');
  await w.click('.inl [data-a="drop"]');
  ok((await w.locator('.toast span').textContent()).startsWith('Dropped:') && await w.locator('.inl').count() === 0, 'dropping closes the details and offers Undo');
  await w.click('.side [data-a="tab"][data-v="all"]');
  await w.fill('#q', 'task h');
  ok((await texts(w, '.sec .sh h2')).join('|') === 'Dropped' && (await w.evaluate(() => document.activeElement.id)) === 'q', 'search finds the dropped task and keeps the cursor in the search field');
  await w.click('.side [data-a="tab"][data-v="today"]');
  const w0 = (await w.locator('.cols > .col').first().boundingBox()).width, sb = await w.locator('.split').boundingBox();
  await w.mouse.move(sb.x + 6, sb.y + 40); await w.mouse.down(); await w.mouse.move(sb.x + 126, sb.y + 60, { steps: 4 }); await w.mouse.up();
  const w1 = (await w.locator('.cols > .col').first().boundingBox()).width;
  ok(w1 > w0 + 90 && w1 < w0 + 150, 'dragging the handle between the columns changes their widths');
  await w.click('.railb');
  ok(await w.locator('.side.min').count() === 1 && (await w.locator('.side').boundingBox()).width < 70 && await w.locator('.side .lbl').first().isHidden(), 'the side bar folds down to its icons');
  await shot(w, 'd_rail');
  await w.reload(); await w.waitForSelector('.side.min');
  const share = (await w.locator('.cols > .col').first().boundingBox()).width / (await w.locator('.cols').boundingBox()).width;
  ok(share > 0.47, 'the folded side bar and the wider column are remembered after a reload');
  await w.click('.side [data-a="tab"][data-v="all"]');
  ok((await w.locator('.hdr h1').textContent()) === 'All', 'the icons of the folded side bar still switch screens');
  await w.click('.railb');
  ok(await w.locator('.side.min').count() === 0, 'the same button unfolds it');
  await w.click('.side [data-a="tab"][data-v="buy"]');
  await shot(w, 'd_buy');

  // ---- colour bars: a Work task and an Out task get different bars on Today
  {
    const stamp = new Date().toISOString(), mk = (id, t, dom, wh) => ({ id, t, status: 'open', tier: 'Active', dom, wh, date: today, created: stamp, updated: stamp });
    await req(API, { key, action: 'sync', tasks: [mk('Tc1', 'Task J', 'Work', 'Desk'), mk('Tc2', 'Task K', 'Personal', 'Out')] });
    const C = await device(390, 844), c = C.page;
    await connect(c);
    const bar = (title) => row(c, title).locator('.cbar').evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, w: getComputedStyle(el).width, hidden: el.getAttribute('aria-hidden') }));
    const bw = await bar('Task J'), bo = await bar('Task K');
    ok(bw.bg !== bo.bg && bw.w === '3px' && bw.hidden === 'true', 'on Today a Work task row and an Out task row have different 3px decorative bars');
    await C.ctx.close();
  }

  // ---- one working copy per browser: the copy opened last works, an older one waits behind a cover
  {
    const F = await device(390, 844), f1 = F.page; await connect(f1);
    // f1's next request reaches the back end at once, and its reply is held until release() is called
    let held = null; const release = () => held && held();
    await f1.route(API, async (route) => { const res = await route.fetch(); if (!held) await new Promise((r) => { held = r; }); route.fulfill({ response: res }); });
    await f1.evaluate(() => { sync(); });
    while (!held) await sleep(50);
    const f2 = await F.ctx.newPage(); f2.on('pageerror', (e) => errors.push(String(e)));
    await f2.goto(APP); await synced(f2);
    await f1.waitForSelector('.park');
    ok(await f1.locator('.hdr').count() === 0 && await f2.locator('.park').count() === 0, 'a second copy in the same browser covers the first');
    let sent = 0; f1.on('request', (r) => { if (r.method() === 'POST' && r.url().startsWith(API)) sent++; });
    const stored = () => f1.evaluate(() => localStorage.getItem('docket.v1')), before = await stored();
    await f1.evaluate(() => { S.lastSync = ''; save(); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); return sync(); });
    await sleep(400);
    ok(sent === 0 && (await stored()) === before, 'a covered copy neither saves nor syncs');
    await add(f2, 'Task L'); await f2.keyboard.press('Enter'); await synced(f2);
    await f1.click('[data-a="unpark"]'); await synced(f1); await tab(f1, 'all');
    const taken = await row(f1, 'Task L').count();
    release(); await sleep(400);
    ok(taken === 1 && await row(f1, 'Task L').count() === 1 && /Task L/.test(await stored()), 'picked again, the copy lists a task added in the other copy, and a reply to a request it sent before it was covered changes nothing');
    await f2.waitForSelector('.park');
    await f1.unroute(API); await f1.reload(); await tab(f1, 'all');
    ok(await row(f1, 'Task L').count() === 1, 'the task is still there after a reload');
    await F.ctx.close();
  }

  // ---- as a tab inside a page from this site the app gives up the notch spacing and its name; framed by another site it stops
  {
    const N = await device(390, 844), n = N.page, cdp = await N.ctx.newCDPSession(n);
    const notch = () => cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, bottom: 34 } });
    // top of the header, bottom of the tab bar, bottom of the add sheet, and the class on <html>
    const pads = async (fr) => {
      await fr.locator('[data-a="addopen"]:visible').first().click();
      const got = await fr.evaluate(() => ['.hdr:paddingTop', '.tabs:paddingBottom', '.sheet:paddingBottom'].map((x) => getComputedStyle(document.querySelector(x.split(':')[0]))[x.split(':')[1]]).concat(document.documentElement.className).join(' '));
      await fr.locator('[data-a="addcancel"]').click();
      return got;
    };
    // The framing page is the static server's own listing of test/, with the app put in as a frame that fills the window.
    const frameIn = async (host) => {
      await n.goto('http://' + host + ':' + APP_PORT + '/test/'); await notch();
      await n.evaluate((src) => { const f = document.createElement('iframe'); f.src = src; f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0'; document.body.appendChild(f); }, APP);
      const fr = await (await n.waitForSelector('iframe')).contentFrame();
      await fr.waitForLoadState('load');
      return fr;
    };
    await notch();
    ok((await pads(n)) === '59px 34px 50px ', 'on its own the app keeps the notch and home-bar spacing');
    ok((await pads(await frameIn('localhost'))) === '12px 0px 16px embed', 'framed by a page from this site it leaves that spacing to the outer page');
    await n.setViewportSize({ width: 1280, height: 800 });
    const wideFrame = await frameIn('localhost');
    ok(await wideFrame.locator('.side').isVisible() && await wideFrame.locator('.side.min').count() === 0 && (await wideFrame.locator('.side .logo').evaluate((el) => getComputedStyle(el).visibility)) === 'hidden', 'framed on a wide screen the side bar shows, unfolded, with the app name hidden');
    // localhost and 127.0.0.1 are different sites to the browser, which is what this needs: a real second host name.
    const other = await frameIn('127.0.0.1'), stopped = () => errors.some((e) => /Framed by another site/.test(e));
    for (let i = 0; i < 60 && !stopped(); i++) await sleep(50);
    ok(stopped() && await other.locator('.hdr').count() === 0 && await other.locator('#app > *').count() === 0, 'framed by another site the app draws nothing');
    await N.ctx.close();
  }

  // ---- the shared look: one block of style text, identical in Team HQ, Docket and Ledger
  {
    // Hash of the shared block: from the first marker's opening /* to the end marker's closing */, nothing after.
    const sharedHash = (html) => { const m = '/* end shared look */', a = html.indexOf('/* Shared look 1'), b = html.indexOf(m) + m.length; return require('crypto').createHash('sha256').update(html.slice(a, b)).digest('hex').slice(0, 16); };
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    ok(sharedHash(html) === '33c0af2999cecd8b', 'shared look block');
    const shell = (sw.match(/const SHELL = \[([^\]]*)\]/) || ['', ''])[1].match(/'\.\/[^']*'/g).map((x) => x.slice(3, -1)), fonts = [...html.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]);
    ok(fonts.length === 5 && fonts.every((f) => shell.includes(f)) && shell.every((f) => fs.existsSync(path.join(ROOT, f || 'index.html'))), 'every font the page names is in the offline file list, and every listed file exists');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' }), t = await ctx.newPage();
    t.on('pageerror', (e) => errors.push(String(e)));
    await t.goto(APP);
    await add(t, 'Task M'); await t.keyboard.press('Enter'); await add(t, 'Task N'); await t.keyboard.press('Enter');
    // contrast of the tick against the fill it is drawn on, read in light and then in dark
    const tick = async (sel) => { const out = []; for (const scheme of ['light', 'dark']) { await t.emulateMedia({ colorScheme: scheme }); out.push(await t.evaluate((sel) => { const lum = (c) => { const v = c.match(/[\d.]+/g).slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      const el = document.querySelector(sel), a = lum(getComputedStyle(el.querySelector('svg')).stroke), b = lum(getComputedStyle(el).backgroundColor); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }, sel)); } return out; };
    await tab(t, 'all'); await row(t, 'Task M').locator('[data-a="flip"]').click();
    const ring = await tick('.ring.done');
    await t.emulateMedia({ colorScheme: 'light' }); await tab(t, 'view'); await t.click('.selb'); await row(t, 'Task N').locator('.lead').click();
    const box = await tick('.box.on');
    ok(ring.concat(box).every((c) => c >= 3), 'the tick on a done ring and on a Select box has at least 3:1 contrast in both themes: ' + ring.concat(box).map((c) => c.toFixed(2)).join(', '));
    await t.click('.selb'); await t.click('.fbtn'); await t.click('.chip[data-k="dom"][data-v="Personal"]');
    const chosen = await t.locator('.chip.on[data-k="dom"]').evaluate((el) => getComputedStyle(el).backgroundColor + ' ' + getComputedStyle(el).color);
    ok(chosen === 'rgb(43, 102, 246) rgb(255, 255, 255)', 'in dark mode a chosen filter is the shared blue with white text: ' + chosen);
    await t.click('.chip[data-v="all"]'); await t.click('.fbtn');
    // every field on a touch screen is at least 16 px, so the phone does not zoom into it: the add panel, a task's details, Settings.
    // The title in the details drawer is left out: it stays 14 px, because its height is counted in lines of that size.
    const sizes = () => t.evaluate(() => [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]),textarea,select')].filter((el) => el.offsetParent && !el.closest('#detail .dhead')).map((el) => parseFloat(getComputedStyle(el).fontSize)));
    let seen = [];
    await vis(t, '[data-a="addopen"]').first().click(); seen = seen.concat(await sizes()); await t.click('[data-a="addcancel"]');
    await tab(t, 'all'); await row(t, 'Task N').locator('[data-a="open"]').click(); seen = seen.concat(await sizes()); await t.click('#detail .foot [data-a="close"]');
    await vis(t, '.stat').first().click(); seen = seen.concat(await sizes());
    ok(seen.length >= 4 && seen.every((n) => n >= 16), 'every field is at least 16 px on a touch screen: ' + seen.join(', '));
    ok((await t.evaluate(() => getComputedStyle(document.body).boxSizing)) === 'border-box', 'the rules after the shared block are intact: body sizes by its border box');
    ok((await t.evaluate(() => { const c = getComputedStyle(document.documentElement); return [c.getPropertyValue('--dash'), c.getPropertyValue('--c2'), c.getPropertyValue('--bg')].map((v) => v.trim().toUpperCase()).join(' '); })) === '#7A8492 #33B679 #111418', 'in dark mode the app\'s own colours and the mapped names resolve');
    await ctx.close();
  }

  ok(errors.filter((e) => !/Framed by another site/.test(e)).length === 0, 'no script errors on any device: ' + errors.join(' | '));
  await browser.close();
  stop();
  console.log(fails ? fails + ' of ' + count + ' checks failed' : 'all ' + count + ' app checks pass');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
