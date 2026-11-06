#!/usr/bin/env python3
"""Build the distributable ZIP for skills/youtube-csv-audit.

The ZIP holds one top-level folder, youtube-csv-audit/, with SKILL.md at its
root, as Claude's skill upload and Agensi's submission checks expect. Only an
allow-list of text files is included: no tests, fixtures, CSV/ZIP/JSON data,
caches, symlinks or OS junk. Entries are sorted and time-stamped identically on
every build, so the same sources give the same entries and checksums.

Checks before writing (the build fails on any of them):
  * SKILL.md frontmatter: name matches the folder; description present, <= 1024 chars
  * every file is UTF-8 text; no symlinks
  * no secret-looking strings (API keys, private keys, OAuth tokens, client secrets)
  * no YouTube channel IDs (UC + 22 characters)
  * optional --deny-list FILE: one string per line (for example the video IDs and
    titles of a real export used in testing) that must not appear anywhere

Usage:
  python3 scripts/build-csv-skill-zip.py [--out release/youtube-csv-audit-<version>.zip] [--deny-list FILE]
"""
import argparse
import hashlib
import os
import re
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL_DIR = os.path.join(REPO, "skills", "youtube-csv-audit")
NAME = "youtube-csv-audit"
INCLUDE = [
    "SKILL.md",
    "README.md",
    "LICENSE",
    "scripts/yt_csv_audit.py",
    "references/audit-template.md",
    "references/column-mapping.md",
    "references/compatibility.md",
    "references/export-instructions.md",
    "references/metric-definitions.md",
    "examples/sample-report.md",
]
EXECUTABLE = {"scripts/yt_csv_audit.py"}
STAMP = (2026, 11, 6, 0, 0, 0)
SECRET_PATTERNS = [
    (r"AKIA[0-9A-Z]{16}", "AWS access key"),
    (r"AIza[0-9A-Za-z_\-]{35}", "Google API key"),
    (r"ya29\.[0-9A-Za-z_\-]{20,}", "Google OAuth access token"),
    (r"1//[0-9A-Za-z_\-]{30,}", "Google refresh token"),
    (r"GOCSPX-[0-9A-Za-z_\-]{20,}", "Google OAuth client secret"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key"),
    (r"gh[pousr]_[0-9A-Za-z]{30,}", "GitHub token"),
    (r"sk-[A-Za-z0-9_\-]{20,}", "API secret key"),
    (r"\bUC[0-9A-Za-z_\-]{22}\b", "YouTube channel ID"),
]


def fail(msg):
    print(f"build failed: {msg}", file=sys.stderr)
    sys.exit(1)


def version():
    with open(os.path.join(SKILL_DIR, "scripts", "yt_csv_audit.py"), encoding="utf-8") as fh:
        m = re.search(r'^VERSION = "([^"]+)"', fh.read(), re.M)
    return m[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--deny-list")
    args = ap.parse_args()
    out = args.out or os.path.join(REPO, "release", f"{NAME}-{version()}.zip")

    deny = []
    if args.deny_list:
        with open(args.deny_list, encoding="utf-8") as fh:
            deny = [line.strip() for line in fh if len(line.strip()) >= 4]

    files = {}
    for rel in INCLUDE:
        path = os.path.join(SKILL_DIR, *rel.split("/"))
        if os.path.islink(path):
            fail(f"{rel} is a symlink")
        if not os.path.isfile(path):
            fail(f"missing {rel}")
        with open(path, "rb") as fh:
            data = fh.read()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            fail(f"{rel} is not UTF-8 text")
        for pat, what in SECRET_PATTERNS:
            if re.search(pat, text):
                fail(f"{rel} contains something that looks like a {what}")
        for s in deny:
            if s in text:
                fail(f"{rel} contains a deny-listed string (not printed)")
        files[rel] = data

    skill = files["SKILL.md"].decode("utf-8")
    m = re.match(r"^---\nname: (.+)\ndescription: (.+)\n---\n(.+)", skill, re.S)
    if not m:
        fail("SKILL.md frontmatter must be name + description between --- lines")
    if m[1].strip() != NAME:
        fail(f"SKILL.md name {m[1]!r} must equal folder name {NAME!r}")
    if not (20 <= len(m[2]) <= 1024):
        fail("SKILL.md description must be 20-1024 characters")
    if len(m[3].split()) < 50:
        fail("SKILL.md body is too short")

    # Anything in the skill folder that is not shipped must be development-only.
    for root, dirs, names in os.walk(SKILL_DIR):
        dirs[:] = [d for d in dirs if d not in ("tests", "__pycache__")]
        for n in names:
            rel = os.path.relpath(os.path.join(root, n), SKILL_DIR).replace(os.sep, "/")
            if rel not in files:
                fail(f"{rel} is in the skill folder but not in the release allow-list; add it or move it to tests/")

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + ".partial"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for d in sorted({f"{NAME}/"} | {f"{NAME}/{r.rsplit('/', 1)[0]}/" for r in files if "/" in r}):
            info = zipfile.ZipInfo(d, STAMP)
            info.external_attr = (0o40755 << 16) | 0x10
            z.writestr(info, b"")
        for rel in sorted(files):
            info = zipfile.ZipInfo(f"{NAME}/{rel}", STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = ((0o100755 if rel in EXECUTABLE else 0o100644) << 16)
            info.create_system = 3
            z.writestr(info, files[rel])
    os.replace(tmp, out)
    with open(out, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    print(f"{out}\n  {len(files)} files, {os.path.getsize(out)} bytes, sha256 {digest}")
    for rel in sorted(files):
        print(f"  {NAME}/{rel}  sha256 {hashlib.sha256(files[rel]).hexdigest()[:16]}")


if __name__ == "__main__":
    main()
