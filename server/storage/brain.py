import re
from datetime import datetime
from pathlib import Path
from .. import config

DATETIME_FORMAT = "%Y-%m-%d %H:%M"

def get_brain_dir(mode: str) -> Path:
    """Returns the absolute path of the brain directory for a given mode.
    
    Raises:
        ValueError: If an unrecognized brain mode is requested.
    """
    if mode not in config.BRAIN_MODES:
        raise ValueError(f"Invalid brain mode: '{mode}'. Must be one of {list(config.BRAIN_MODES.keys())}")
    return config.BRAIN_MODES[mode]

def init_brains():
    """Ensures each brain mode directory exists and is seeded with standard defaults."""
    for mode, path in config.BRAIN_MODES.items():
        path.mkdir(parents=True, exist_ok=True)
        
        # Seed User.md
        user_file = path / "User.md"
        if not user_file.exists():
            now_str = datetime.now().strftime(DATETIME_FORMAT)
            user_content = f"""---
created: {now_str}
updated: {now_str}
---

# User

The root hub for all information about the user.

## Content / Logs
- [{now_str}] **System**: Memory graph initialized.

## Connections & Links
- Related: [[Assistant]]
"""
            user_file.write_text(user_content, encoding="utf-8")
            
        # Seed Assistant.md
        assistant_file = path / "Assistant.md"
        if not assistant_file.exists():
            now_str = datetime.now().strftime(DATETIME_FORMAT)
            assistant_content = f"""---
created: {now_str}
updated: {now_str}
---

# Assistant

The assistant hub storing personality parameters, tone guidelines, and user preferences.

## Content / Logs
- [{now_str}] **System**: Assistant memory profile initialized.

## Connections & Links
- Related: [[User]]
"""
            assistant_file.write_text(assistant_content, encoding="utf-8")

        # Build/rebuild map.json
        _rebuild_map(path)


def _rebuild_map(brain_dir):
    """Build brain/map.json from the current .md files in a directory."""
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
    """Parses markdown contents and returns a structured node dictionary."""
    frontmatter = {"created": "", "updated": ""}
    title = ""
    description = ""
    logs = []
    connections = []

    # 1. Parse frontmatter
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
                if key in ("created", "updated"):
                    frontmatter[key] = val

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

    # 4. Extract unique wikilinks
    wikilink_re = re.compile(r"\[\[([^\]\n]+)\]\]")
    found_links = wikilink_re.findall(body)
    seen = set()
    for link in found_links:
        cleaned = clean_wikilink(link)
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            connections.append(cleaned)

    return {
        "frontmatter": frontmatter,
        "title": title,
        "description": description,
        "logs": logs,
        "connections": connections
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
    
    # Path traversal protection
    if not target_path.is_relative_to(brain_dir):
        raise ValueError("Directory traversal attempt detected in filename.")
        
    target_path.write_text(content, encoding="utf-8")
