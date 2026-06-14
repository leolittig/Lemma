# Instructions for Calendar (`Calendar.md` - Off-grid)

Whenever a date is mentioned — a birthday, a deadline, an event that happened, a future plan — record it with the **CALENDAR** command (append-only, safe):

```text
=== CALENDAR ===
**Birthday**: Bob — July 25th. @Bob
```

Rules:
- Always write the event date in **English words** (e.g. "July 25th", "March 3rd, 2025"), and `@mention` the node it concerns when one exists. One CALENDAR command per dated fact.
- **Recurrent & Associated Life Events**:
  - Birthdays and anniversaries are recurrent yearly events. Always record them when mentioned.
  - When the user mentions beliefs, religion, or personal relationships, associate related traditional holidays/dates to the calendar:
    - If the user mentions they are Christian, add **Christmas** (December 25th) to the calendar.
    - If the user mentions a romantic partner (e.g. spouse, boyfriend, girlfriend, husband, wife) and there is a relationship anniversary, add that **Anniversary** to the calendar (with the start year/date if known, or just the day and month), AND automatically add **Valentine's Day** (February 14th) to the calendar.
  - Examples:
    - User says: "I am Christian" ->
      `=== CALENDAR ===`
      `**Holiday**: Christmas — December 25th. @User`
    - User says: "My wife is Eve. Our anniversary is May 13th." ->
      `=== CALENDAR ===`
      `**Anniversary**: Married Eve — May 13th. @Eve`
      `=== CALENDAR ===`
      `**Holiday**: Valentine's Day — February 14th. @Eve`

- **Relative Date Calculations**:
  - Always calculate dates relative to the `Current date/time` provided in the prompt.
  - Notice the day of the week in the current date/time (e.g., if today is "Friday, 2026-06-12 18:30").
  - "Next week" refers to the week immediately following the current week. If today is Friday, June 12th, the current week runs through Sunday, June 14th, and "next week" begins on Monday, June 15th. Therefore:
    - "Next week Tuesday" is Tuesday, June 16th.
    - "Next week Wednesday" is Wednesday, June 17th.
    - Do NOT jump an extra week into the future (e.g., do NOT resolve "next week Tuesday" to June 23rd when today is Friday, June 12th).
  - If a user mentions days of the week for "next week", resolve them to the specific calendar dates of that upcoming week.
  - If the user says "next [weekday]" (e.g., "next Tuesday" or "next Wednesday"), it refers to the weekday in the week immediately following the current day.

- **Consolidation and Resolution of Calendar Entries**:
  - If a calendar event that was previously recorded (such as an "Undated" relationship anniversary or event) is now specified with a precise date, or if a date is updated/corrected, you **MUST** resolve it.
  - Do not keep duplicate, outdated, or "Undated" versions of the same resolved event in `Calendar.md`.
  - Since the `=== CALENDAR ===` command only appends new lines, you must clean up obsolete entries by using the `=== UPDATE Calendar ===` command to rewrite the entire `Calendar.md` file, removing the outdated/undated lines and keeping only the resolved, correct entries.

