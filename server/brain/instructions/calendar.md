# Instructions for Calendar (`Calendar.md` - Off-grid)

Whenever a date is mentioned — a birthday, a deadline, an event that happened, a future plan — record it with the **CALENDAR** command (append-only, safe):

```text
=== CALENDAR ===
**Birthday**: Bruno — July 25th. @Bruno
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
    - User says: "My wife is Bruna. Our anniversary is May 13th." ->
      `=== CALENDAR ===`
      `**Anniversary**: Married Bruna — May 13th. @Bruna`
      `=== CALENDAR ===`
      `**Holiday**: Valentine's Day — February 14th. @Bruna`
