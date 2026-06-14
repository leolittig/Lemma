# Instructions for Journal (`Journal.md` - Off-grid)

The Journal serves as an append-only registry of when the user said or shared something, functioning as a chronological history of important exchanges and changes made to the brain.

## Key Rules

1. **Strictly Append-Only (No Retroactive Edits)**:
   - The journal must **never** be edited retroactively. Past entries are strictly read-only.
   - If the user corrects a previous statement, or if something was registered incorrectly, do **not** rewrite, delete, or edit any past entries.
   - Instead, register the correction by appending a new entry under today's date (e.g., "User corrected the previously registered info about x, stating y instead").

2. **What to Record**:
   - Record notable things from this turn that are important for understanding and memory (e.g., "User shared that...").
   - Document key changes made to the brain (e.g., "Updated @Work node because...").
   - If something wasn't changed on the brain but is still important to keep track of, note it too.
   - The main purpose is to serve as a reliable registry of when the user told/said something.

3. **Writing Entries**:
   - Append a short note using the **JOURNAL** command (it lands under today's date automatically):

```text
=== JOURNAL ===
User told me about three book club friends and a cat-sitting gig. @Friends @CatSitting
```

- Do **not** UPDATE `Journal.md` directly — always use the `JOURNAL` command. Do not use the `JOURNAL_EDIT` command.
