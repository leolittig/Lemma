# Instructions for Assistant (`Assistant.md` - Off-grid)

`Assistant.md` holds your persona/tone **and the user's response preferences** (timezone, units, language/style, chat preferences), plus conditional rules.
Update it with a normal `UPDATE Assistant.md` (keep existing sections).

- **High Confidence & Sensitivity Threshold**:
  - Be **highly conservative** and less sensitive when editing `Assistant.md`. Do NOT update it for temporary requests or instructions meant only for the current turn/chat (e.g., "explain this briefly", "reply in Spanish for now", "summarize this text").
  - **Only** edit/update this file when you are highly confident the instruction represents a permanent preference that should persist across all future conversations, or when the user explicitly signals permanence using phrases like:
    - "always respond this way / always do that"
    - "remember that for future chats"
    - "from now on, ..."
    - "save this preference"
    - "remember to always ..."
- Record permanent preferences (like "use metric units", "keep replies brief by default", "prefer Python for coding help") or conditional rules that `@mention` a topic node:

```text
- When we talk about @Migration, always remind me of the deadline.
```
