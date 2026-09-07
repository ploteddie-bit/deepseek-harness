# Schedule session-local reminders

English | [中文](schedule.zh.md)

This overlay opts one `dsh web` process into Schedule reminders without changing the shipped default Web composition:

```sh
dsh web --patch apps/cli/config/examples/schedule/cordis.yml
```

The current overlay supports reminders created with a positive whole-number `after_seconds`, an absolute `at` target, a fixed-rate `every_seconds` interval of at least 300 seconds, or a calendar `cron` rule (a five-field Cron expression or a calendar phrase, interpreted in UTC). The model manages them through `schedule_create`, `schedule_list`, and `schedule_delete`; every result identifies delivery as `session-local`.

With this overlay enabled, a successfully opened Session with active reminders shows a read-only catalog in the conversation header. It lists the complete prompt, scheduled or overdue status, one-time or exact repeating cadence, browser-local target time, and relative time. The sidebar also places a non-interactive alarm after the title of grouped, flat, and search rows when their currently available projection value is non-empty. These surfaces never create, edit, delete, or acknowledge reminders, and a cold Session's cached alarm can be briefly missing or stale.

The browser attaches its IANA zone to each prompt. Time-context tells the model to interpret otherwise-unqualified dates and times in that request's browser zone. This assumption belongs to natural-language interpretation only: `schedule_create.at` must be either a strict RFC 3339 date-time with `Z` or a numeric offset, or `{ date, time, time_zone }` with an explicit `UTC` or IANA Area/Location zone. Schedule does not retain or infer a Session default zone. Daylight-saving gaps are rejected, overlaps choose the first instant, and successful records keep only the resulting UTC target.

The original Session log owns each reminder. A live root Agent waits until it is fully idle, then queues a normal follow-up turn in that conversation. It never steers current work and adds no separate receipt or reminder card. Closing the process or leaving the Session cold stops its in-memory timer without deleting the record; reopening that same Session restores the wait and delivers an overdue reminder. Reading cold history never activates it, and a fork does not inherit its parent's reminders.

Every reminders stay aligned to their creation time; Cron reminders advance to their next rule occurrence. If one is overdue, only its latest due occurrence is presented. All distinct recurring (Every or Cron) records overdue at the same idle decision are combined into one follow-up with one occurrence each; missed occurrences do not create a backlog. Due one-shots run before that batch.

Create and actual delete operations acknowledge success only after Session persistence confirms their event prefix. Schedule does not provide browser, operating-system, email, SMS, or other external notification. A durable dispatch records that the follow-up was queued; it does not acknowledge model success or user receipt.
