import re
import threading
from datetime import datetime
from pathlib import Path
from .. import config

DATETIME_FORMAT = "%Y-%m-%d %H:%M"

# The root node's stem (its label is the user's name, but the file is stable).
ROOT_STEM = "User"

# Off-grid entities: real markdown files the model reads/writes, but NOT drawn as
# graph nodes. They reference graph nodes via @mentions instead of [[edges]].
OFF_GRID_FILES = {"Assistant", "Calendar", "Journal"}

# Month-name → number, for parsing verbal dates out of Calendar entries.
_MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9, "october": 10,
    "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}

# An @mention of a node inside an off-grid entity (not preceded by a word char).
_MENTION_RE = re.compile(r"(?<![A-Za-z0-9_])@([A-Za-z0-9_]+)")

# Live view into background brain updates (post-processing), so the frontend
# can show a global "updating" spinner and a real-time log of what the memory
# model is doing. This is observation only — it does not change how memory is
# managed. A counter (not a bool) because turns can in principle overlap.
#
#   _processing_count  how many updates are in flight
#   _activity_events   discrete log lines ({seq, ts, type, text}), bounded
#   _activity_stream   the in-progress generation text (the model's "thoughts")
_activity_lock = threading.Lock()
_processing_count = 0
_activity_events = []
_activity_seq = 0
_activity_stream = ""
_MAX_ACTIVITY_EVENTS = 200


def _push_event(etype: str, text: str):
    """Append one discrete log line. Caller must hold _activity_lock."""
    global _activity_seq
    _activity_seq += 1
    _activity_events.append({
        "seq": _activity_seq,
        "ts": datetime.now().strftime("%H:%M:%S"),
        "type": etype,
        "text": text,
    })
    overflow = len(_activity_events) - _MAX_ACTIVITY_EVENTS
    if overflow > 0:
        del _activity_events[:overflow]


def begin_processing():
    """Mark that a background brain update has started and reset the live stream."""
    global _processing_count, _activity_stream
    with _activity_lock:
        _processing_count += 1
        _activity_stream = ""
        _push_event("status", "Reviewing the conversation for things to remember…")


def end_processing():
    """Mark that a background brain update has finished."""
    global _processing_count
    with _activity_lock:
        _processing_count = max(0, _processing_count - 1)


def log_activity(etype: str, text: str):
    """Record a discrete activity line (status / write / delete / error)."""
    with _activity_lock:
        _push_event(etype, text)


def append_stream(text: str):
    """Append generated tokens to the in-progress 'thoughts' buffer."""
    global _activity_stream
    with _activity_lock:
        _activity_stream += text


def is_processing() -> bool:
    """True while at least one background brain update is running."""
    with _activity_lock:
        return _processing_count > 0


def get_activity() -> dict:
    """Snapshot of the current activity feed for the UI."""
    with _activity_lock:
        return {
            "processing": _processing_count > 0,
            "events": list(_activity_events),
            "stream": _activity_stream,
        }

def get_brain_dir(mode: str) -> Path:
    """Returns the absolute path of the brain directory for a given mode.
    
    Raises:
        ValueError: If an unrecognized brain mode is requested.
    """
    if mode not in config.BRAIN_MODES:
        raise ValueError(f"Invalid brain mode: '{mode}'. Must be one of {list(config.BRAIN_MODES.keys())}")
    return config.BRAIN_MODES[mode]

def init_brains():
    """Ensure each brain mode directory exists and is seeded with the off-grid
    entities. The root user node is NOT seeded here — it is created from the
    first-boot name prompt (see init_root); the brain stays "uninitialized"
    until then."""
    for mode, path in config.BRAIN_MODES.items():
        path.mkdir(parents=True, exist_ok=True)
        now_str = datetime.now().strftime(DATETIME_FORMAT)

        # Assistant: persona + response preferences. Off-grid (not a node).
        assistant_file = path / "Assistant.md"
        if not assistant_file.exists():
            assistant_file.write_text(f"""---
created: {now_str}
updated: {now_str}
type: assistant
---

# Assistant

How I (the assistant) should behave: persona, tone, and the user's response
preferences. Not part of the knowledge graph.

## Persona & Tone

## Response Preferences
- (timezone, units, language/style, chat preferences go here)

## Conditional Rules
- (e.g. "When we talk about @SomeTopic, do …")
""", encoding="utf-8")

        # Calendar: the date table (past and future). Off-grid (not a node).
        calendar_file = path / "Calendar.md"
        if not calendar_file.exists():
            calendar_file.write_text(f"""---
created: {now_str}
updated: {now_str}
type: calendar
---

# Calendar

Every dated fact, past and future. Each entry @mentions the node it concerns.

## Entries
""", encoding="utf-8")

        # Journal: the daily log. Off-grid (not a node). Append-only by day.
        journal_file = path / "Journal.md"
        if not journal_file.exists():
            journal_file.write_text(f"""---
created: {now_str}
updated: {now_str}
type: journal
---

# Journal

A running daily log. Each day is a section; past days are read-only.
""", encoding="utf-8")

        # Build/rebuild map.json
        rebuild_map(path)


def is_initialized(mode: str) -> bool:
    """True once the root user node exists with a name set."""
    return bool(get_user_name(mode))


def get_user_name(mode: str) -> str:
    """The user's name from the root node's frontmatter, or '' if not set."""
    root = get_brain_dir(mode) / f"{ROOT_STEM}.md"
    if not root.exists():
        return ""
    try:
        parsed = parse_markdown_node(root.read_text(encoding="utf-8"))
    except Exception:
        return ""
    return parsed.get("frontmatter", {}).get("name", "") or ""


def init_root(mode: str, name: str):
    """Create the single root node, named after the user. The file stem stays
    `User` (a stable anchor) but its label/H1 and `name` field are the user's
    name, so the graph shows the name at the center."""
    clean = (name or "").strip()
    if not clean:
        raise ValueError("A name is required to initialize the brain.")
    brain_dir = get_brain_dir(mode)
    brain_dir.mkdir(parents=True, exist_ok=True)
    now_str = datetime.now().strftime(DATETIME_FORMAT)
    safe_label = clean.replace("\n", " ").strip()
    root = brain_dir / f"{ROOT_STEM}.md"
    root.write_text(f"""---
created: {now_str}
updated: {now_str}
type: user
name: {safe_label}
---

# {safe_label}

The root of the knowledge graph — everything the brain knows about {safe_label}.

## Content / Logs
- [{now_str}] **System**: Brain initialized for {safe_label}.

## Connections & Links
""", encoding="utf-8")
    rebuild_map(brain_dir)


def rebuild_map(brain_dir):
    """Build map.json (filename -> short description) from a brain directory's
    .md files. It's the compact index the routing model sees, so it must be
    rebuilt whenever files change."""
    import json as _json
    brain_map = {}
    for fpath in brain_dir.glob("*.md"):
        try:
            content = fpath.read_text(encoding="utf-8")
            parsed = parse_markdown_node(content)
            brain_map[fpath.stem] = parsed.get("description", "")[:100]
        except Exception:
            brain_map[fpath.stem] = ""
    map_path = brain_dir / "map.json"
    map_path.write_text(_json.dumps(brain_map, indent=2), encoding="utf-8")

def validate_datetime(value: str) -> bool:
    """Helper to check if a string represents a valid datetime in YYYY-MM-DD HH:MM format."""
    try:
        val_strip = value.strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", val_strip):
            return False
        datetime.strptime(val_strip, DATETIME_FORMAT)
        return True
    except ValueError:
        return False

def clean_wikilink(target: str) -> str:
    """Cleans raw wikilink target by stripping aliases, anchors, .md extension, and spaces."""
    if "|" in target:
        target = target.split("|", 1)[0]
    if "#" in target:
        target = target.split("#", 1)[0]
    target = target.strip()
    if target.lower().endswith(".md"):
        target = target[:-3]
    return target.strip()

def parse_markdown_node(content: str) -> dict:
    """Parses markdown contents and returns a structured node dictionary.

    Captures all frontmatter keys (so `type`, `status`, `tags`, `relationship`,
    `name`, … flow through), plus wikilink `connections` (graph edges) and
    `@mentions` (off-grid → node references)."""
    frontmatter = {"created": "", "updated": "", "type": ""}
    title = ""
    description = ""
    logs = []
    connections = []

    # 1. Parse frontmatter — keep every key.
    frontmatter_match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n", content, re.DOTALL)
    body = content
    if frontmatter_match:
        body = content[frontmatter_match.end():]
        fm_text = frontmatter_match.group(1)
        for line in fm_text.splitlines():
            if ":" in line:
                key, val = line.split(":", 1)
                key = key.strip()
                val = val.strip().strip("'\"")
                if key:
                    frontmatter[key] = val
        # Back-compat: accept the old `category` key as `type`.
        if not frontmatter.get("type") and frontmatter.get("category"):
            frontmatter["type"] = frontmatter["category"]
    if not frontmatter.get("type"):
        frontmatter["type"] = "leaf"

    # 2. Extract H1 Title and Description
    # Remove code blocks before searching for title
    body_for_title = re.sub(r"```.*?```", "", body, flags=re.DOTALL)
    title_match = re.search(r"^#\s+(.+)$", body_for_title, re.MULTILINE)
    if title_match:
        title = title_match.group(1).strip()
        post_title = body_for_title[title_match.end():].strip()
        desc_parts = re.split(r"\n\s*(?:#+\s|[-*+]\s|\d+\.\s)", post_title, maxsplit=1)
        description = desc_parts[0].strip() if desc_parts else ""

    # 3. Extract logs starting with [YYYY-MM-DD HH:MM]
    log_re = re.compile(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.*)")
    for line in body.splitlines():
        cleaned = line.strip().lstrip("-*+ \t")
        m = log_re.match(cleaned)
        if m:
            ts, text = m.group(1), m.group(2).strip()
            if validate_datetime(ts):
                logs.append({"timestamp": ts, "text": text})

    # 4. Extract unique wikilinks (graph edges)
    wikilink_re = re.compile(r"\[\[([^\]\n]+)\]\]")
    found_links = wikilink_re.findall(body)
    seen = set()
    for link in found_links:
        cleaned = clean_wikilink(link)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            connections.append(cleaned)

    # 5. Extract unique @mentions (off-grid → node references)
    mentions = []
    seen_m = set()
    for m in _MENTION_RE.findall(body):
        if m and m not in seen_m:
            seen_m.add(m)
            mentions.append(m)

    return {
        "frontmatter": frontmatter,
        "title": title,
        "description": description,
        "logs": logs,
        "connections": connections,
        "mentions": mentions,
    }

def validate_markdown_node(content: str) -> bool:
    """Checks if frontmatter format, entry timestamps, and wikilink formats are valid."""
    # 1. Validate frontmatter
    frontmatter_match = re.match(r"^---\s*\r?\n(.*?)\r?\n---\s*\r?\n", content, re.DOTALL)
    if not frontmatter_match:
        return False

    fm_text = frontmatter_match.group(1)
    frontmatter = {}
    for line in fm_text.splitlines():
        if ":" in line:
            key, val = line.split(":", 1)
            frontmatter[key.strip()] = val.strip().strip("'\"")

    if "created" not in frontmatter or "updated" not in frontmatter:
        return False
    if not validate_datetime(frontmatter["created"]) or not validate_datetime(frontmatter["updated"]):
        return False

    body = content[frontmatter_match.end():]

    # 2. Validate log entry timestamps (if present)
    # Match any list marker followed by a bracket. If it starts with a digit, it's a timestamp candidate.
    log_line_re = re.compile(r"^\s*[-*+]\s*\[(.*?)\]")
    for line in body.splitlines():
        m = log_line_re.match(line)
        if m:
            val = m.group(1)
            # Differentiate from checklists: check if the content starts with a digit
            if val and val[0].isdigit():
                if not validate_datetime(val):
                    return False

    # 3. Validate wikilinks (ensure balanced brackets and valid file names)
    if content.count("[[") != content.count("]]"):
        return False

    # Perform linear scan for unbalanced or nested brackets
    idx = 0
    forbidden = set(r'\/:*?"<>|')
    while True:
        start = body.find("[[", idx)
        if start == -1:
            break
        end = body.find("]]", start)
        if end == -1:
            return False
        
        # Check if there is another [[ before ]]
        next_start = body.find("[[", start + 2)
        if next_start != -1 and next_start < end:
            return False
            
        raw_target = body[start + 2:end]
        if "\n" in raw_target:
            return False
            
        cleaned_target = clean_wikilink(raw_target)
        if not cleaned_target or any(c in forbidden for c in cleaned_target):
            return False
            
        idx = end + 2

    return True

def save_markdown_node(mode: str, filename: str, content: str):
    """Validates and saves node content to the correct directory with path traversal protection."""
    if not validate_markdown_node(content):
        raise ValueError(f"Content for file '{filename}' failed markdown node validation standards.")
        
    if "/" in filename or "\\" in filename:
        raise ValueError("Subdirectories are not allowed in filename.")
        
    if not filename.endswith(".md"):
        filename += ".md"
        
    brain_dir = get_brain_dir(mode).resolve()
    target_path = (brain_dir / filename).resolve()
    
    target_path.write_text(content, encoding="utf-8")


def rename_markdown_node(mode: str, old_filename: str, new_filename: str):
    """Renames a markdown node, updates its H1 title if it matches, and updates wikilinks pointing to it in all other nodes."""
    if "/" in old_filename or "\\" in old_filename or "/" in new_filename or "\\" in new_filename:
        raise ValueError("Subdirectories are not allowed in filenames.")
        
    old_stem = old_filename[:-3] if old_filename.endswith(".md") else old_filename
    new_stem = new_filename[:-3] if new_filename.endswith(".md") else new_filename

    if not old_stem or not new_stem:
        raise ValueError("Filenames cannot be empty.")

    if old_stem in ("User", "Assistant"):
        raise ValueError("Renaming the core hubs 'User' and 'Assistant' is not allowed.")

    old_file = old_stem + ".md"
    new_file = new_stem + ".md"

    brain_dir = get_brain_dir(mode).resolve()
    old_path = (brain_dir / old_file).resolve()
    new_path = (brain_dir / new_file).resolve()

    # Path traversal protection
    if not old_path.is_relative_to(brain_dir) or not new_path.is_relative_to(brain_dir):
        raise ValueError("Directory traversal attempt detected.")

    if not old_path.exists() or not old_path.is_file():
        raise ValueError(f"Source memory file '{old_file}' does not exist.")

    if new_path.exists():
        raise ValueError(f"Destination memory file '{new_file}' already exists.")

    # 1. Read old file contents, update H1 title, and save to new path
    content = old_path.read_text(encoding="utf-8")
    
    # Update H1 title in content if it matches the old filename stem (case-insensitive)
    lines = content.splitlines()
    for idx, line in enumerate(lines):
        if line.startswith("# "):
            current_title = line[2:].strip()
            if current_title.lower() == old_stem.lower():
                lines[idx] = f"# {new_stem}"
                break
    content = "\n".join(lines)
    
    # Write to new path and delete old path
    new_path.write_text(content, encoding="utf-8")
    old_path.unlink()

    # 2. Update all wikilinks in all other files
    # Match [[old_stem]] or [[old_stem#anchor]] or [[old_stem|alias]] or [[old_stem#anchor|alias]]
    # Group 1: optional anchor (starts with #)
    # Group 2: optional alias (starts with |)
    link_pattern = re.compile(
        r'\[\[' + re.escape(old_stem) + r'((?:#[^\]|]+)?)((\|[^\]]+)?)\text{]}]'
    )
    def replace_link(match):
        anchor = match.group(1) or ""
        alias = match.group(2) or ""
        return f"[[{new_stem}{anchor}{alias}]]"

    for fpath in brain_dir.glob("*.md"):
        if fpath == new_path:
            continue
        try:
            file_content = fpath.read_text(encoding="utf-8")
            updated_content = link_pattern.sub(replace_link, file_content)
            if updated_content != file_content:
                fpath.write_text(updated_content, encoding="utf-8")
        except Exception as e:
            print(f"Error updating wikilinks in {fpath.name}: {e}")

    # 3. Rebuild map
    rebuild_map(brain_dir)


# --- Off-grid entities: helpers, Calendar, Journal, references ----------------

def _strip_frontmatter(content: str) -> str:
    m = re.match(r"^---\s*\r?\n.*?\r?\n---\s*\r?\n", content, re.DOTALL)
    return content[m.end():] if m else content


def _dedupe(seq):
    out, seen = [], set()
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _bump_updated(content: str) -> str:
    now_str = datetime.now().strftime(DATETIME_FORMAT)
    if re.search(r"^updated:.*$", content, re.MULTILINE):
        return re.sub(r"^updated:.*$", f"updated: {now_str}", content, count=1, flags=re.MULTILINE)
    return content


def parse_verbal_date(text: str):
    """Find a verbal date in free text — 'July 25th', 'March 3, 2025', '25 July'.
    Returns {month, day, year|None, has_year, iso, sort_key} or None. sort_key
    uses the stated year, else the current year (so undated-year events still
    place on the timeline / split past vs upcoming)."""
    months = "|".join(_MONTHS.keys())
    # Month Day[, Year] — (?!\d) keeps the day from eating a 4-digit year.
    m = re.search(
        rf"\b({months})\b\.?\s+(\d{{1,2}})(?!\d)(?:st|nd|rd|th)?(?:,?\s*(\d{{4}}))?",
        text, re.IGNORECASE)
    if not m:
        # Day Month[ Year]
        m = re.search(
            rf"\b(\d{{1,2}})(?!\d)(?:st|nd|rd|th)?\s+({months})\b\.?(?:,?\s*(\d{{4}}))?",
            text, re.IGNORECASE)
        if not m:
            return None
        day, month_name, year_s = m.group(1), m.group(2), m.group(3)
    else:
        month_name, day, year_s = m.group(1), m.group(2), m.group(3)

    month = _MONTHS[month_name.lower()]
    day = int(day)
    if not (1 <= day <= 31):
        return None
    year = int(year_s) if year_s else None
    eff_year = year if year else datetime.now().year
    return {
        "month": month, "day": day, "year": year, "has_year": year is not None,
        "iso": f"{eff_year:04d}-{month:02d}-{day:02d}",
        "sort_key": (eff_year, month, day),
    }


_CAL_LOG_RE = re.compile(r"^\s*[-*+]\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.*)$")


def parse_calendar(mode: str) -> list:
    """Parse Calendar.md into a chronological list of dated entries.
    Each: { ts (recorded), text, event_date (iso|None), has_year, refs }."""
    path = get_brain_dir(mode) / "Calendar.md"
    if not path.exists():
        return []
    events = []
    for line in _strip_frontmatter(path.read_text(encoding="utf-8")).splitlines():
        m = _CAL_LOG_RE.match(line)
        if not m:
            continue
        ts, text = m.group(1), m.group(2).strip()
        ev = parse_verbal_date(text)
        events.append({
            "ts": ts,
            "text": text,
            "event_date": ev["iso"] if ev else None,
            "has_year": ev["has_year"] if ev else False,
            "sort_key": ev["sort_key"] if ev else None,
            "refs": _dedupe(_MENTION_RE.findall(text)),
        })
    events.sort(key=lambda e: (e["sort_key"] is None, e["sort_key"] or (9999, 99, 99), e["ts"]))
    return events


def calendar_mention_counts(mode: str) -> dict:
    """How many Calendar entries @mention each node — drives the 📅 badge."""
    counts = {}
    for ev in parse_calendar(mode):
        for r in ev["refs"]:
            counts[r] = counts.get(r, 0) + 1
    return counts


def append_calendar(mode: str, entry_text: str):
    """Append one dated row to Calendar.md under '## Entries'. The recorded
    timestamp is added automatically; the entry text carries the verbal event
    date and any @node references. Append-only, so history is never clobbered."""
    entry_text = " ".join((entry_text or "").split())
    if not entry_text:
        return
    brain_dir = get_brain_dir(mode)
    path = brain_dir / "Calendar.md"
    if not path.exists():
        init_brains()
    content = path.read_text(encoding="utf-8")
    now_str = datetime.now().strftime(DATETIME_FORMAT)
    line = f"- [{now_str}] {entry_text}"
    if not content.endswith("\n"):
        content += "\n"
    if "## Entries" in content:
        content += line + "\n"
    else:
        content += f"\n## Entries\n{line}\n"
    path.write_text(_bump_updated(content), encoding="utf-8")


_JOURNAL_HEAD_RE = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})\s*$")
_JOURNAL_ENTRY_RE = re.compile(r"^\s*[-*+]\s*\[(\d{1,2}:\d{2})\]\s*(.*)$")


def parse_journal(mode: str) -> list:
    """Parse Journal.md into day sections, newest first.
    Each: { date, entries: [{ ts, text, refs }] }."""
    path = get_brain_dir(mode) / "Journal.md"
    if not path.exists():
        return []
    days, cur = [], None
    for line in _strip_frontmatter(path.read_text(encoding="utf-8")).splitlines():
        h = _JOURNAL_HEAD_RE.match(line)
        if h:
            cur = {"date": h.group(1), "entries": []}
            days.append(cur)
            continue
        if cur is not None:
            e = _JOURNAL_ENTRY_RE.match(line)
            if e:
                txt = e.group(2).strip()
                cur["entries"].append({"ts": e.group(1), "text": txt,
                                       "refs": _dedupe(_MENTION_RE.findall(txt))})
    days.sort(key=lambda d: d["date"], reverse=True)
    return days


def get_today_journal_text(mode: str) -> str:
    """Today's journal entries as plain lines, for chat-prompt recall."""
    today = datetime.now().strftime("%Y-%m-%d")
    for d in parse_journal(mode):
        if d["date"] == today:
            return "\n".join(f"- [{e['ts']}] {e['text']}" for e in d["entries"])
    return ""


def append_journal(mode: str, entry_text: str):
    """Append one timestamped entry under TODAY's section (creating it if first
    of the day). Append-only: prior days are never touched."""
    entry_text = (entry_text or "").strip()
    if not entry_text:
        return
    # Collapse multi-line model output into one entry.
    entry_text = " ".join(entry_text.split())
    brain_dir = get_brain_dir(mode)
    path = brain_dir / "Journal.md"
    if not path.exists():
        init_brains()
    content = path.read_text(encoding="utf-8")
    today = datetime.now().strftime("%Y-%m-%d")
    now_hm = datetime.now().strftime("%H:%M")
    line = f"- [{now_hm}] {entry_text}"
    if not content.endswith("\n"):
        content += "\n"
    if f"## {today}" in content:
        content += line + "\n"          # today's section is always the last one
    else:
        content += f"\n## {today}\n{line}\n"
    path.write_text(_bump_updated(content), encoding="utf-8")


def edit_journal_day(mode: str, day: str, new_body: str):
    """Rewrite a specific day's section. The ONLY path that mutates history —
    used solely when the user explicitly orders a change to a past entry."""
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", (day or "").strip()):
        raise ValueError(f"Invalid journal day: {day!r}")
    day = day.strip()
    brain_dir = get_brain_dir(mode)
    path = brain_dir / "Journal.md"
    if not path.exists():
        init_brains()
    content = path.read_text(encoding="utf-8")
    body = (new_body or "").strip()
    section_re = re.compile(r"(^##\s+" + re.escape(day) + r"\s*\n)(.*?)(?=^## |\Z)",
                            re.DOTALL | re.MULTILINE)
    if section_re.search(content):
        content = section_re.sub(lambda m: m.group(1) + body + "\n\n", content)
    else:
        content = content.rstrip() + f"\n\n## {day}\n{body}\n"
    path.write_text(_bump_updated(content), encoding="utf-8")


def node_refs(mode: str, node_stem: str) -> dict:
    """Where the off-grid entities reference a node (via @mentions)."""
    result = {"calendar": [], "journal": [], "assistant": False}
    for ev in parse_calendar(mode):
        if node_stem in ev["refs"]:
            result["calendar"].append({"ts": ev["ts"], "text": ev["text"],
                                       "event_date": ev["event_date"]})
    for d in parse_journal(mode):
        for e in d["entries"]:
            if node_stem in e["refs"]:
                result["journal"].append({"date": d["date"], "ts": e["ts"], "text": e["text"]})
    apath = get_brain_dir(mode) / "Assistant.md"
    if apath.exists():
        if node_stem in _MENTION_RE.findall(_strip_frontmatter(apath.read_text(encoding="utf-8"))):
            result["assistant"] = True
    return result


def reset_brain(mode: str):
    """Deletes all memory files in the brain directory for a given mode, and seeds default hubs."""
    brain_dir = get_brain_dir(mode).resolve()
    if not brain_dir.exists() or not brain_dir.is_dir():
        return
    # Delete all files in the brain directory
    for fpath in brain_dir.iterdir():
        if fpath.is_file():
            fpath.unlink()
    # Re-initialize brains (re-seeds default hubs and rebuilds map.json)
    init_brains()
