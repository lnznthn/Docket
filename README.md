# Docket

Docket is a personal task list that runs in a browser on a phone and on a computer. Every task carries three traits: a tier (Prio, Active, Archived), a domain (Work, Personal, Admin) and a where (Phone, Desk, Home, Out). Capture takes a title only. The app guesses the traits from the title, marks each guess with a question mark, and keeps a correction as a rule for next time.

The data lives in a Google Sheet that you own. The app keeps a full copy on each device, works without signal, and syncs when it can.

## What it does

- **Today** shows the day once: calendar events and timed tasks in one timeline, then what is due today, what is Prio, and what is due in the next two days.
- **View** groups open tasks by tier, domain or where, with filters. Grouping by where puts errands in the order of their places, so one trip covers them.
- **Buy** is a tick-off list grouped by shop, with online orders in their own group.
- **All** searches everything, including tasks that are done or dropped.
- A task can wait for one other task. A chain of such steps shows only its first unfinished step as actionable.
- **Select** ticks several tasks so one choice changes all of them: tier, domain, where, date, done or dropped, with Undo.
- Routines come due as suggestions to accept or skip. They never add tasks by themselves.
- A task with a date and a time can block that time on Google Calendar. Moving the event moves the task. Blocks can take a colour by where and domain, set in the Settings tab (Block colours).
- The plan can be read for today, tomorrow, three days or a week. A calendar event opens its details in the app, where its title, day and times can be changed; the change goes to Google Calendar at the next sync. A repeating event offers **This event** or **All events**. Moving the times of all events needs one extra step in the script editor: **Services > Google Calendar API > Add**, then a new deployment version.

## Set up

1. Create a Google Sheet. Open **Extensions > Apps Script**, replace the editor's contents with `apps-script/Code.gs`, and save.
2. In the Apps Script editor, open **Project Settings** and set the time zone you live in.
3. Reload the sheet. Choose **Docket > Set up or upgrade this sheet** and approve the permissions it asks for (the sheet, your calendar, and a timer that runs every 10 minutes).
4. In the Apps Script editor choose **Deploy > New deployment > Web app**, with **Execute as: Me** and **Who has access: Anyone**. The key from step 6 is what protects the data.
5. Copy the **Web app URL** that the deployment shows (also under Deploy > Manage deployments). It ends in `/exec`.
6. Back in the sheet choose **Docket > Show connection code** to get the key. The connection code is the Web app URL, then `#`, then the key.
7. Open the app, tap the status button at the top right (on a computer, at the bottom of the side bar), paste the code, and choose **Save and sync**. Repeat on each device.

On an iPhone, open the app in Safari and choose **Share > Add to Home Screen** so it opens like an app.

To host your own copy, fork this repository and turn on GitHub Pages for the `main` branch.

## Updating

The app updates by itself the next time it opens with signal. When `apps-script/Code.gs` changes, paste the new file over the old one, run **Docket > Set up or upgrade this sheet**, then choose **Deploy > Manage deployments > Edit > Version: New version** so the web address stays the same.

## The sheet

| Tab | Purpose |
| --- | --- |
| Tasks | One row per task. The app is the usual way to change it. |
| Routines | One row per routine: title, optional steps separated by `>`, traits, cadence (`Fixed` or `After`), and every (a number of days, or weekday names for `Fixed`). |
| Rules | Keyword, trait, value, origin and match. With Match blank, the keyword counts anywhere in a title and the longest one found wins; corrections made in the app land here. Rows with a Match are the words the app guesses from: `word` (a whole word, with an ending such as -s, -ed or -ing), `start` (the same, as the title's first word only) or `buy` (a whole word in a Buy item, where Phone means order online). A blank-Match row outranks any word. |
| Settings | Calendars to show, the calendar that receives blocks, the day counts the app uses, the two Reminders list names, and Block colours (such as `Out=1, Work=2`: Where or Domain names with a Google Calendar colour ID, first fit wins). |
| Inbox | Rows added here become tasks at the next sync or within 10 minutes. An assistant or a script can write here without touching the Tasks tab. A row can switch on a calendar block and its length; the new task's ID is written back next to the row. |
| Edits | Task ID, field and new value. Each row is applied once and marked Done or Refused with a reason. |
| Browse | A readable copy of the open tasks, rewritten after each change. |

## Privacy

The repository holds code and invented sample data only. Task titles, the names of people and places, calendar IDs, the sheet ID and the connection key exist only in your sheet and on your devices. The code holds no word lists and no colour scheme: the words the app guesses from, names, saved corrections and block colours all live in your sheet.

## Development

```
node test/backend.test.js   # the Apps Script code against in-memory stand-ins for Google's services
node test/e2e.js            # the app in Chrome against the same mock back end (needs Playwright and Chrome)
```

`ARCHITECTURE.md` describes how the parts fit together.

Fonts: Inter and Space Grotesk, SIL Open Font License 1.1 (see `fonts/README.md`).
