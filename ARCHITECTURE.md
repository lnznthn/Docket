# Architecture

Docket has two parts: one HTML file served by GitHub Pages, and one Apps Script file bound to a Google Sheet. No build step, no dependencies at run time, no server besides Google's.

```
index.html              the whole app: markup, styles and script
sw.js                   service worker: offline launch and updates
manifest.webmanifest    install metadata
fonts/, icons/          bundled assets
apps-script/Code.gs     the back end, pasted into the sheet's Apps Script project
test/mock-backend.js    runs Code.gs unchanged against in-memory stand-ins for Google's services
test/backend.test.js    back-end checks
test/e2e.js             app checks in Chrome against the mock back end
```

## Data model

A task is a flat record. The sheet's Tasks tab holds one row per task with readable headers; the app and the sync protocol use short keys.

| Key | Column | Notes |
| --- | --- | --- |
| id | ID | Made on the device, or by the script for Inbox rows |
| t | Title | |
| status | Status | open, done, dropped |
| tier | Tier | Prio, Active, Archived |
| dom | Domain | Work, Personal, Admin |
| wh | Where | Phone, Desk, Home, Out |
| place | Place | Used when Where is Out |
| buy, label | Buy, Label | A Buy item is a task with the Buy flag |
| chain, after | Chain, Waits for | `after` holds the ID of the one task this one waits for |
| date, time | Due date, Due time | `yyyy-mm-dd` and `hh:mm` as text |
| cal, dur, eventId | Calendar block, Block length, Event ID | The block and the calendar event that mirrors it |
| remId | Reminder ID | Kept for an assistant that mirrors timed tasks into a phone's reminders |
| guessed | Unconfirmed traits | True while Domain and Where are still a guess |
| src, routine | Source, Routine | Where the task came from |
| created, updated, doneAt | Created, Updated, Done at | ISO timestamps |

Every column is plain text, so the sheet never reinterprets a date or an ID.

Several facts are derived on the device and never stored: whether a task is blocked (any earlier step in its chain is still open), the due date a chain's first step inherits from its later steps, the tier a task is shown at (Prio when it is due within the Prio window, or when a later step is Prio), and online versus physical (from Where).

## Sync

The app keeps the full state in `localStorage` and marks each changed task as dirty. A sync is one POST:

```
request  { key, action: 'sync', tasks: [changed tasks], routines: [{ id, next }], rules: [{ k, trait, value }], events: [{ id, calId, od, ot, scope?, t?, date?, time?, end? }] }
reply    { ok, data: { version, now, today, tasks, routines, rules, words: [{ k, trait, value, m }], settings, events, warn } }
```

The script takes a lock, applies each incoming task if its `updated` stamp is newer than the row's (last write wins per task), applies the Inbox and Edits tabs, reconciles calendar blocks, and returns every open task plus tasks closed within the history window. The app replaces its copy with the reply, except for tasks changed on the device while the request was in flight; those keep their local version and go up at the next sync.

The request is sent as `text/plain` so the browser makes no preflight request, which Apps Script web apps cannot answer. The key is checked on every request and lives in the script's properties, outside the sheet's cells.

Syncs run on launch, when the app returns to the foreground, 1.5 seconds after a change, every 5 minutes while open, and on demand from Settings. A timer in the script runs the Inbox, Edits and calendar steps every 10 minutes, so the sheet stays current while no device is open.

A task link that would form a loop is refused by the script and reported in the reply's `warn` list.

## Guessing traits

`guess(title)` in the app returns a domain, a where and whether the title is a Buy item. A title that starts with buy or order and a further word is a Buy item (order confirmation, form and status excepted). Every word comes from the sheet's Rules tab; the code holds only how they match. Rows with a Match reach the app as `words`, apart from `rules`, so an older copy of the app never reads them as rules. A `word` row matches the keyword as a whole word with an optional ending (-e, -s, -es, -d, -ed, -ing), a `start` row the same as the title's first word only, and a `buy` row as a whole word that counts only for a Buy item's Where (Phone: order online). When words of two values are found, Work beats Admin, and Phone beats Out, Desk and Home in that order; a Home word in a title with a Work word reads Desk. Then the rows without a Match, where the longest keyword found anywhere in the title wins, outrank the words. Without words (a device not yet connected) only the Buy rule guesses. Picking a Domain or Where by hand confirms the task and saves a rule keyed on the full title. An Inbox row can also set `Calendar block` (Yes) and `Block length` (30, 60 or 120; 60 when blank); a block needs a date and a time, and is made in the same sync. When a row is applied the script writes `Done` in Status and the new task's ID in `Task ID`, so a later step can address the task through Edits. A sheet set up before 1.3.0 gets these three Inbox columns at its next sync, without running setup. An Inbox row that leaves Domain or Where blank is marked by the script (`Source` starts with `Inbox:`), and the first device to receive it fills the blank with the same guesser and sends the result back.

## Calendar

A task with a date, a time and the calendar block switched on gets an event on the block calendar. The script creates, moves or renames the event when the task changes, moves the task when the event was moved in the calendar, and clears the task's schedule when the event was deleted. Dropping a task removes its event; finishing a task keeps it as a record, and a later edit to a finished task's title, day or time still moves or renames that record. Each block is coloured by the Settings row Block colours, a list such as `Out=1, Work=2` of Where or Domain names with a Google Calendar colour ID (1 to 11), read in order: the first name that is the task's Where or Domain gives the colour. With the row blank, blocks keep the calendar's own colour. A trait change recolours the block, a block without a colour gets one at the next sync, and a colour outside the listed IDs that was picked in Google Calendar is kept. Events on the calendars named in Settings are returned for the next 7 days, without the tasks' own events, so Today shows each item once.

The app shows the same scheme. Each event in the sync reply carries its `color` ID, empty for the calendar's default. The app draws a 3 px bar on the left edge of a row: tasks by the same rule as the blocks (`colorOf` in `index.html`, `blockColor_` in the script, from the `colors` list the reply carries in `settings`), events by `color`, none for an empty or unlisted ID. The bar is decorative (`aria-hidden`). The colours are CSS tokens `--c1` to `--c11` for light and dark.

The app can change an event's title, day and times. It sends only the fields that changed; the script applies them to calendars named in Settings, and keeps the event's length when only the start moves. Every occurrence of a repeating event shares one ID, so the app identifies an occurrence by ID plus its original day and time and sends those with a scope. Scope `one` changes that occurrence. Scope `all` renames the series through `CalendarApp`, and moves the times of the series through the Google Calendar API advanced service when it has been added to the script; without it the script answers with a warning that names the step. The day of a whole series is left to Google Calendar. The app shows the change at once and holds it until a sync has delivered it.

## Rendering

The app builds its screen as one HTML string from the state and swaps it in. Clicks are handled by one listener that reads a `data-a` action name. Text fields are never redrawn while they have focus: typing updates the state and redraws only the parts that depend on it, and a redraw nobody asked for (a finished sync, an expiring message) waits until no finger is down and no field has focus. Scroll positions and the caret are restored after each redraw.

The layout switches at 900 px: below it, one screen at a time with a bottom tab bar; above it, Today's plan and View side by side, with a row's details opening in place under that row.

## Spacing and sizes

One system covers every screen, so new parts have rules to follow.

- **Steps of 4 px.** Paddings, gaps and control heights use 4, 8, 12, 16 or 24 px. Related things sit 4 to 8 px apart (a label and its control, rows of one list), separate groups 16 px, columns 24 px.
- **Touch sizes by default.** Anything tappable is at least 44 px high, the size Apple's guidelines and WCAG 2.5.5 give for a finger. Chips that wrap in a group are 40 px high with 8 px between them, following Material's pattern of a smaller chip inside a larger touch area. The tab bar is 56 px.
- **Compact sizes only with a mouse.** The media query `(min-width: 900px) and (pointer: fine)` lowers rows to 36 px and controls to 28 to 36 px. Nothing goes under 24 px, the WCAG 2.5.8 minimum. A wide touch screen keeps the touch sizes.
- **Details.** On the phone a task opens in a drawer of full-size fields. With a mouse it opens under its row as a few lines of labelled menus and fields, and the row's own title becomes the title field.
- **Type.** 14 px for content, 12 px for labels, traits and notes, and two weights. Headings are the only larger text. On touch screens, fields use 16 px, because iOS zooms the page when a smaller field takes focus.
- **Small-looking controls.** The +N chain button, the OK button and the status button keep their look and get a larger invisible hit area, so the visible size and the target size can differ.

## Shared look

The `<style>` opens with one block of text, from `/* Shared look 1 … */` to `/* end shared look */`, that is identical in Docket, Ledger and Team HQ: the five font declarations (Inter 400, 500, 600 and 700, Space Grotesk 700), the light and dark colour tokens, the type sizes, spacing steps, corner radii, tap sizes and the notch tokens `--sat` and `--sab`, zeroed under `html.embed`. The look is Docket's own, so here the block replaces the font and token rules the app had, and a short local `:root` straight after it maps the names the rest of the stylesheet uses (`--bg`, `--card`, `--mut`, `--blue`, `--seg` and so on) onto the shared ones and holds the colours only Docket uses: the dashed-ring grey and the calendar colours `--c1` to `--c11`, in both themes. Nothing inside the block is edited in one app alone. A change to it is made in all three repositories in the same round, and `test/e2e.js` checks the first 16 hex characters of the block's SHA-256 (from the `/*` that opens the first marker to the `*/` that closes the end marker), so a copy that drifts fails the run. The same run checks that every font file the page names is in the service worker's offline list. The font licence is in `fonts/OFL.txt`.

## Framing and copies

Docket runs on its own or as a frame inside a page from its own site (the Docket tab in Team HQ). A block at the top of the script walks up the frame chain: a parent from any other site, at any level, or a sandboxed frame that withholds same-site access, empties the page and stops the script before it reads storage. GitHub Pages cannot send the header that forbids framing, so this check stands in for it. Inside a same-site frame the page gets the class `embed` on `<html>`: the notch and home-bar spacing (`--sat`, `--sab`) drops to 0, because the outer page owns it, and the app name in the side bar is hidden with its space kept, because the outer page already names the app.

Every copy of Docket in one browser (a tab, the installed app, the frame in Team HQ) shares one saved state and writes all of it from memory, so two working copies would overwrite each other. Each copy announces itself on a `BroadcastChannel` named `docket` when it opens. The copy opened last does the work; an older copy shows a cover with a "Use Docket here" button, and while covered it neither saves nor syncs. The button re-reads the saved state and takes over, which covers the other copy. A reply to a request that was sent before the copy was covered, or before it re-read its state, is dropped, because it describes a state no longer in use. Known limit: an add draft that was not saved is lost when its copy is covered, because the re-read resets the screen state.

## Service worker

The page is fetched network-first with a 3-second budget and falls back to the cached copy, so any launch with signal runs the newest version. Fonts, icons and the manifest are cache-first. Requests to the sheet are never cached. On activation the worker deletes only caches whose names start with `docket-`, because other apps are served from the same address and keep their own. Bump `CACHE` in `sw.js` together with `VERSION` in `index.html` on each release.

## Versions

`VERSION` in `index.html` and `VERSION_` in `Code.gs` follow the same major number. The app warns in Settings when the sheet runs a script with a different major number.

- 1.0.0: the first build. Today, View, Buy and All for phone and desktop, title-only capture with guessed traits, chains, routines as suggestions, calendar blocks and offline-first sync; one Apps Script file bound to a Google Sheet, with Inbox and Edits tabs for changes made outside the app; tests that run the script unchanged against in-memory stand-ins for Google's services.
- 1.0.1: the Show connection code dialog shows the key and says where to copy the Web app URL, because the address the script reports for itself may belong to a deployment that does not answer.
- 1.0.2: the Filter panel closes only by its own button, the app follows the device's dark setting, and every selected state uses one accent pair.
- 1.1.0: the plan can be read for today, tomorrow, three days or a week; a calendar event opens its details, and its title, day and times can be changed in the app. Sheet script 1.1.0 applies those changes and leaves repeating events alone.
- 1.1.1: on wide screens a task or an event opens in place under its row, which replaces the third column. The phone keeps its bottom sheet.
- 1.2.0: on wide screens the open row's title is edited in the row, and the part under it repeats neither the ring, the title nor the time; the two columns share their width through a draggable handle, and the side bar folds down to icons. Both choices are remembered on the device.
- 1.2.1: with a mouse, the open row's details are a few compact lines. One spacing system replaces the earlier sizes (see Spacing and sizes): 4 px steps, 44 px touch targets, compact sizes only with a fine pointer at 900 px and up, nothing under 24 px, 16 px fields on touch.
- 1.3.0: Select mode. One choice of tier, domain, where, date, done or dropped applies to every selected task, with Undo.
- 1.4.0: a repeating event opens with a choice of This event or All events; an occurrence is identified by its ID plus its original day and time. Sheet script 1.2.0.
- Sheet script 1.3.0: calendar blocks are coloured by the task's Where and Domain; an edit to a finished task reaches its block; the Inbox gains the Task ID, Calendar block and Block length columns, which older sheets get at their next sync.
- 1.5.0: row bars are coloured by the task's Where and Domain, by the same rule as the calendar blocks, and each event in the sync reply carries its colour ID.
- Sheet script 1.5.0: the guesser's words (Rules rows with a Match) and the block colours (Settings, Block colours) are read from the sheet.
- 1.5.1: groundwork for running as a tab inside Team HQ, with nothing to see when the app runs on its own. The service worker deletes only its own old caches; the app stops when a page from another site frames it, and inside a same-site frame it gives up the notch spacing and hides its name; of several copies open in one browser only the newest works, and the others wait behind a cover.
- 1.6.0: the shared look. The font and colour rules at the top of the stylesheet become a block of style text that is identical in Docket, Ledger and Team HQ, checked by its hash in the tests. Docket looks as before apart from two contrast fixes: field and chip borders are a shade darker in light mode, and the segment track is a shade darker in dark mode.
