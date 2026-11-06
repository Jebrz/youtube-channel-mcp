#!/usr/bin/env python3
"""YouTube Studio CSV export analyser for the youtube-csv-audit skill.

Reads the ZIP or CSV files that YouTube Studio's "Export current view" produces
(Table data.csv, Chart data.csv, Totals.csv), maps English or Malay column
names, and prints reproducible figures with their source file, row and column.

* Python 3.10+ standard library only. No network access, no installs.
* Never extracts archives to disk: ZIP members are read in memory with size,
  member-count and compression-ratio limits.
* Writes nothing unless --out is given (then only audit_data.json and
  audit_facts.md inside that folder).
* Works when piped:  python3 - EXPORT.zip < yt_csv_audit.py

Usage:
  python3 yt_csv_audit.py EXPORT.zip [MORE.zip|FILE.csv|FOLDER ...]
          [--out DIR] [--format json|md] [--top N]
          [--min-impressions N] [--min-engaged-views N]
          [--period-start YYYY-MM-DD --period-end YYYY-MM-DD]
  python3 yt_csv_audit.py --selftest

Every analysis first runs the built-in self-test on synthetic data, so a damaged
copy of this script stops with exit code 4 instead of printing wrong figures.

Exit codes: 0 ok, 2 bad input or usage, 3 no recognisable YouTube export,
4 this copy of the script failed its self-test.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import statistics
import sys
import unicodedata
import zipfile

VERSION = "0.1.0"

# --------------------------------------------------------------------------
# Limits for untrusted input
# --------------------------------------------------------------------------
MAX_INPUT_FILES = 200          # files found in folders / members in a ZIP
MAX_ZIP_BYTES = 200 * 1024**2  # size of a ZIP file on disk
MAX_MEMBER_BYTES = 50 * 1024**2  # one CSV, uncompressed
MAX_TOTAL_BYTES = 100 * 1024**2  # all CSVs in one ZIP, uncompressed
MAX_RATIO = 200                # uncompressed / compressed, for members > 1 MB
MAX_ROWS = 100_000

# --------------------------------------------------------------------------
# Column map. Confidence of each header spelling:
#   seen     - present in a real YouTube Studio export used in testing
#   expected - English wording used by YouTube Studio / YouTube Help; not yet
#              checked against a real English export by this project
#   guess    - plausible Malay wording, not yet seen in a real export
# --------------------------------------------------------------------------
COLUMNS = [
    # key, kind, unit, additive across videos, [(header, language, confidence)]
    ("video_id", "dimension", "id", False, [("Content", "en", "expected"), ("Kandungan", "ms", "seen")]),
    ("title", "dimension", "text", False, [("Video title", "en", "expected"), ("Tajuk video", "ms", "seen")]),
    ("published", "dimension", "date", False, [("Video publish time", "en", "expected"), ("Masa penerbitan video", "ms", "seen")]),
    ("duration_s", "dimension", "duration", False, [("Duration", "en", "expected"), ("Tempoh", "ms", "seen")]),
    ("date", "dimension", "date", False, [("Date", "en", "expected"), ("Tarikh", "ms", "seen")]),
    ("views", "metric", "count", True, [("Views", "en", "expected"), ("Tontonan", "ms", "seen")]),
    ("engaged_views", "metric", "count", True, [("Engaged views", "en", "expected"), ("Tontonan sahih", "ms", "seen")]),
    ("watch_time_h", "metric", "hours", True, [("Watch time (hours)", "en", "expected"), ("Masa tontonan (jam)", "ms", "seen")]),
    ("subscribers", "metric", "count", True, [("Subscribers", "en", "expected"), ("Pelanggan", "ms", "seen")]),
    ("subscribers_gained", "metric", "count", True, [("Subscribers gained", "en", "expected"), ("Pelanggan diperoleh", "ms", "guess")]),
    ("subscribers_lost", "metric", "count", True, [("Subscribers lost", "en", "expected"), ("Pelanggan hilang", "ms", "guess")]),
    ("impressions", "metric", "count", True, [("Impressions", "en", "expected"), ("Thumbnail impressions", "en", "expected"),
                                              ("Tera", "ms", "guess"), ("Tera lakaran kecil", "ms", "seen")]),
    ("ctr_pct", "metric", "percent", False, [("Impressions click-through rate (%)", "en", "expected"),
                                            ("Thumbnail impressions click-through rate (%)", "en", "expected"),
                                            ("Kadar klikan tera (%)", "ms", "guess"),
                                            ("Kadar klikan lakaran kecil (%)", "ms", "seen")]),
    ("avg_view_duration_s", "metric", "duration", False, [("Average view duration", "en", "expected"), ("Purata tempoh tontonan", "ms", "seen")]),
    ("avg_pct_viewed", "metric", "percent", False, [("Average percentage viewed (%)", "en", "expected"),
                                                   ("Purata peratusan ditonton (%)", "ms", "seen")]),
    ("likes", "metric", "count", True, [("Likes", "en", "expected"), ("Suka", "ms", "guess")]),
    ("comments", "metric", "count", True, [("Comments added", "en", "expected"), ("Ulasan ditambah", "ms", "guess")]),
    ("shares", "metric", "count", True, [("Shares", "en", "expected"), ("Perkongsian", "ms", "guess")]),
    ("unique_viewers", "metric", "count", False, [("Unique viewers", "en", "expected"), ("Penonton unik", "ms", "guess")]),
]
LABELS = {
    "views": "Views", "engaged_views": "Engaged views", "watch_time_h": "Watch time (hours)",
    "subscribers": "Subscribers (net)", "subscribers_gained": "Subscribers gained", "subscribers_lost": "Subscribers lost",
    "impressions": "Thumbnail impressions", "ctr_pct": "Impressions CTR (%)", "avg_view_duration_s": "Average view duration (s)",
    "avg_pct_viewed": "Average percentage viewed (%)", "likes": "Likes", "comments": "Comments", "shares": "Shares",
    "unique_viewers": "Unique viewers",
}
TOTAL_LABELS = {"total", "totals", "grand total", "jumlah", "jumlah keseluruhan"}
SENSITIVE_WORDS = ("revenue", "rpm", "cpm", "earnings", "hasil", "pendapatan", "(usd)", "(myr)")
# View-counting changes announced by YouTube (see references/metric-definitions.md).
DEFINITION_CHANGES = [
    ("2025-03-31", "YouTube began counting Shorts views as plays and replays; the earlier Shorts view metric continues as 'Engaged views'."),
    ("2026-08-24", "YouTube Help says views are counted the moment a video starts to play across all formats from this date."),
]
MONTHS = {
    "jan": 1, "january": 1, "januari": 1, "feb": 2, "february": 2, "februari": 2, "mar": 3, "march": 3, "mac": 3,
    "apr": 4, "april": 4, "may": 5, "mei": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "julai": 7,
    "aug": 8, "august": 8, "ogo": 8, "ogos": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "okt": 10, "oktober": 10, "nov": 11, "november": 11,
    "dec": 12, "december": 12, "dis": 12, "disember": 12,
}


def norm_header(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\ufeff", "")
    return re.sub(r"\s+", " ", text).strip().casefold()


HEADER_INDEX = {}
for _key, _kind, _unit, _add, _aliases in COLUMNS:
    for _h, _lang, _conf in _aliases:
        HEADER_INDEX[norm_header(_h)] = (_key, _lang, _conf)
COLUMN_INFO = {c[0]: {"kind": c[1], "unit": c[2], "additive": c[3]} for c in COLUMNS}


class InputError(Exception):
    """A problem with the files the user supplied (reported, exit code 2)."""


# --------------------------------------------------------------------------
# Reading files safely
# --------------------------------------------------------------------------
def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_junk(name: str) -> bool:
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    return (name.startswith("__MACOSX/") or "/__MACOSX/" in name or base.startswith("._")
            or base in (".DS_Store", "Thumbs.db", "desktop.ini"))


def read_zip(path: str, warnings: list) -> list:
    """Return [(member_name, bytes)] for CSV members, enforcing limits."""
    size = os.path.getsize(path)
    if size > MAX_ZIP_BYTES:
        raise InputError(f"{os.path.basename(path)} is larger than {MAX_ZIP_BYTES // 1024**2} MB; this is not a normal YouTube Studio export.")
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise InputError(f"{os.path.basename(path)} is not a valid ZIP file.")
    out, total, seen = [], 0, set()
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_INPUT_FILES:
            raise InputError(f"{os.path.basename(path)} has {len(infos)} entries (limit {MAX_INPUT_FILES}).")
        for info in infos:
            name = info.filename
            if info.is_dir() or is_junk(name):
                continue
            label = name.replace("\\", "/")
            if label.startswith("/") or ".." in label.split("/"):
                warnings.append(warn("unsafe_member_name", f"Skipped ZIP entry with an unsafe path: {label!r}. Nothing is extracted to disk."))
                continue
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                warnings.append(warn("symlink_member", f"Skipped symbolic link inside ZIP: {label}"))
                continue
            low = label.lower()
            if low.endswith(".zip"):
                warnings.append(warn("nested_zip", f"Skipped nested ZIP {label}; upload the inner ZIP directly if it is an export."))
                continue
            if not low.endswith(".csv"):
                warnings.append(warn("ignored_file", f"Ignored non-CSV file in ZIP: {label}"))
                continue
            if info.flag_bits & 0x1:
                raise InputError(f"{label} inside {os.path.basename(path)} is password-protected; export again without a password.")
            if info.file_size > MAX_MEMBER_BYTES:
                raise InputError(f"{label} is larger than {MAX_MEMBER_BYTES // 1024**2} MB uncompressed.")
            if info.file_size > 1024**2 and info.compress_size and info.file_size / info.compress_size > MAX_RATIO:
                raise InputError(f"{label} has a suspicious compression ratio; refusing to read it.")
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise InputError(f"CSV files in {os.path.basename(path)} exceed {MAX_TOTAL_BYTES // 1024**2} MB in total.")
            with zf.open(info) as fh:  # read at most the limit + 1 byte: declared sizes can lie
                data = fh.read(MAX_MEMBER_BYTES + 1)
            if len(data) > MAX_MEMBER_BYTES:
                raise InputError(f"{label} expands beyond {MAX_MEMBER_BYTES // 1024**2} MB; refusing to read it.")
            if label in seen:
                warnings.append(warn("duplicate_member", f"ZIP contains {label} more than once; using the first."))
                continue
            seen.add(label)
            out.append((label, data))
    return out


def collect_inputs(paths: list, warnings: list) -> list:
    """Group inputs into datasets: one per ZIP, one per folder, one for loose CSVs."""
    datasets, loose = [], []
    for p in paths:
        if not os.path.exists(p):
            raise InputError(f"File not found: {p}")
        if os.path.islink(p):
            raise InputError(f"Refusing to follow a symbolic link: {p}")
        if os.path.isdir(p):
            found = []
            for root, dirs, files in os.walk(p, followlinks=False):
                dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "__MACOSX")
                for f in sorted(files):
                    fp = os.path.join(root, f)
                    if os.path.islink(fp) or is_junk(f):
                        continue
                    if f.lower().endswith((".csv", ".zip")):
                        found.append(fp)
                    if len(found) > MAX_INPUT_FILES:
                        raise InputError(f"More than {MAX_INPUT_FILES} files under {p}.")
            csvs = [f for f in found if f.lower().endswith(".csv")]
            for z in (f for f in found if f.lower().endswith(".zip")):
                datasets.append(zip_dataset(z, warnings))
            if csvs:
                datasets.append({"label": os.path.basename(os.path.normpath(p)), "kind": "folder",
                                 "files": [(os.path.relpath(f, p).replace("\\", "/"), read_file(f)) for f in csvs]})
        elif p.lower().endswith(".zip"):
            datasets.append(zip_dataset(p, warnings))
        elif p.lower().endswith(".csv"):
            loose.append((os.path.basename(p), read_file(p)))
        else:
            raise InputError(f"Unsupported file type: {os.path.basename(p)} (expected .zip or .csv)")
    if loose:
        datasets.append({"label": "uploaded CSV files", "kind": "csv", "files": loose})
    return datasets


def read_file(path: str) -> bytes:
    if os.path.getsize(path) > MAX_MEMBER_BYTES:
        raise InputError(f"{os.path.basename(path)} is larger than {MAX_MEMBER_BYTES // 1024**2} MB.")
    with open(path, "rb") as fh:
        return fh.read()


def zip_dataset(path: str, warnings: list) -> dict:
    with open(path, "rb") as fh:
        digest = sha256(fh.read())
    return {"label": os.path.basename(path), "kind": "zip", "sha256": digest, "files": read_zip(path, warnings)}


def decode(data: bytes) -> tuple:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8"), "utf-8-sig"
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16"), "utf-16"
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace"), "cp1252 (fallback)"


def warn(code: str, message: str, **where) -> dict:
    d = {"code": code, "message": message}
    d.update({k: v for k, v in where.items() if v is not None})
    return d


# --------------------------------------------------------------------------
# Value parsing
# --------------------------------------------------------------------------
MISSING_TOKENS = {"", "-", "–", "—", "n/a", "na", "null", "none"}
RE_DOT_DEC = re.compile(r"^-?\d+\.\d+$")
RE_COMMA_DEC = re.compile(r"^-?\d+,\d+$")
# "1.250" or "12,500" could be a decimal or a thousands group: not evidence either way.
RE_AMBIGUOUS = re.compile(r"^-?[1-9]\d{0,2}[.,]\d{3}$")
RE_THOUSANDS_COMMA = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$")
RE_THOUSANDS_DOT = re.compile(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$")
RE_INT = re.compile(r"^-?\d+$")


def clean_num(raw: str) -> str:
    s = raw.strip().replace("\u00a0", "").replace("\u202f", "").replace(" ", "")
    return s[:-1] if s.endswith("%") else s


def detect_decimal(cells: list) -> tuple:
    """Decide the file's decimal separator from cells that can only be read one way."""
    dot = sum(1 for c in cells if RE_DOT_DEC.match(c) and not RE_AMBIGUOUS.match(c))
    comma = sum(1 for c in cells if RE_COMMA_DEC.match(c) and not RE_AMBIGUOUS.match(c))
    ambiguous = sum(1 for c in cells if RE_AMBIGUOUS.match(c))
    amb = f"; {ambiguous} cells like '1.250' could be read either way" if ambiguous else ""
    if comma and not dot:
        return ",", f"decimal comma ({comma} cells like '1,5'){amb}"
    if dot and comma:
        return "conflict", f"both decimal points ({dot}) and decimal commas ({comma}){amb}"
    if dot:
        return ".", f"decimal point ({dot} cells){amb}"
    if ambiguous:
        return "ambiguous", f"no unambiguous decimals; {ambiguous} cells like '1.250' could be decimals or thousands"
    return ".", "no decimal values seen; assumed decimal point"


def parse_number(raw: str, decimal: str):
    """Return (value, problem). value is None for missing or unreadable cells."""
    if raw is None or raw.strip().casefold() in MISSING_TOKENS:
        return None, "missing"
    s = clean_num(raw)
    if RE_INT.match(s):
        return float(s), None
    if decimal in ("conflict", "ambiguous") and (RE_AMBIGUOUS.match(s) or decimal == "conflict"):
        return None, "unreadable"
    if decimal in (".", "ambiguous"):
        if RE_DOT_DEC.match(s):
            return float(s), None
        if RE_THOUSANDS_COMMA.match(s):
            return float(s.replace(",", "")), "thousands_separator"
    if decimal in (",", "ambiguous"):
        if RE_COMMA_DEC.match(s):
            return float(s.replace(",", ".")), None
        if RE_THOUSANDS_DOT.match(s):
            return float(s.replace(".", "").replace(",", ".")), "thousands_separator"
    return None, "unreadable"


def parse_duration(raw: str):
    if raw is None or raw.strip().casefold() in MISSING_TOKENS:
        return None, "missing"
    s = raw.strip()
    if RE_INT.match(s) or RE_DOT_DEC.match(s):
        return float(s), None
    m = re.match(r"^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$", s)
    if not m:
        return None, "unreadable"
    h, mi, se, frac = m.groups()
    val = int(h or 0) * 3600 + int(mi) * 60 + int(se)
    if frac:
        val += float("0." + frac)
    return float(val), None


def parse_date(raw: str):
    """Return (ISO date string or None, problem)."""
    if raw is None or not raw.strip():
        return None, "missing"
    s = raw.strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", s)
    try:
        if m:
            return dt.date(int(m[1]), int(m[2]), int(m[3])).isoformat(), None
        m = re.match(r"^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})", s)  # Nov 2, 2026
        if m and m[1].casefold() in MONTHS:
            return dt.date(int(m[3]), MONTHS[m[1].casefold()], int(m[2])).isoformat(), None
        m = re.match(r"^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})", s)  # 2 Nov 2026 / 2 Okt 2026
        if m and m[2].casefold() in MONTHS:
            return dt.date(int(m[3]), MONTHS[m[2].casefold()], int(m[1])).isoformat(), None
        m = re.match(r"^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$", s)
        if m:
            a, b, y = int(m[1]), int(m[2]), int(m[3])
            if a > 12 >= b:
                return dt.date(y, b, a).isoformat(), None
            if b > 12 >= a:
                return dt.date(y, a, b).isoformat(), None
            return None, "ambiguous_day_month"
    except ValueError:
        return None, "unreadable"
    return None, "unreadable"


# --------------------------------------------------------------------------
# Parsing one CSV
# --------------------------------------------------------------------------
def parse_csv(file_id: str, name: str, data: bytes, warnings: list) -> dict:
    text, encoding = decode(data)
    if encoding.startswith("cp1252"):
        warnings.append(warn("encoding_fallback", f"{name} is not UTF-8; read it as Windows-1252. Check that titles look right.", file=file_id))
    sample = text[:20000]
    try:
        delimiter = csv.Sniffer().sniff(sample.split("\n", 1)[0], delimiters=",;\t").delimiter
    except csv.Error:
        delimiter = ","
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    rows = [r for r in rows if any(c.strip() for c in r)]
    info = {"id": file_id, "name": name, "sha256": sha256(data), "encoding": encoding,
            "delimiter": {",": "comma", ";": "semicolon", "\t": "tab"}.get(delimiter, delimiter),
            "type": "unknown", "language": "unknown", "columns": [], "unmapped_columns": [],
            "ignored_sensitive_columns": [], "data_rows": 0, "total_row": None}
    if not rows:
        warnings.append(warn("empty_file", f"{name} is empty.", file=file_id))
        return {"info": info, "records": [], "total": None, "keys": {}}
    if len(rows) > MAX_ROWS:
        raise InputError(f"{name} has more than {MAX_ROWS} rows.")
    header = rows[0]
    keys, langs = {}, set()
    for idx, h in enumerate(header):
        hit = HEADER_INDEX.get(norm_header(h))
        if any(w in norm_header(h) for w in SENSITIVE_WORDS):
            info["ignored_sensitive_columns"].append(h)
            continue
        if hit:
            key, lang, conf = hit
            if key in keys:
                warnings.append(warn("duplicate_column", f"{name}: column {h!r} maps to {key} again; using the first.", file=file_id))
                continue
            keys[key] = idx
            langs.add(lang)
            info["columns"].append({"header": h, "key": key, "language": lang, "confidence": conf})
        elif h.strip():
            info["unmapped_columns"].append(h)
    info["language"] = "mixed" if len(langs) > 1 else (langs.pop() if langs else "unknown")
    if "date" in keys and "video_id" in keys:
        info["type"] = "chart"
    elif "date" in keys:
        info["type"] = "totals"
    elif "video_id" in keys:
        info["type"] = "table"
    hint = name.lower()
    for word, typ in (("table", "table"), ("chart", "chart"), ("totals", "totals"), ("jadual", "table"), ("carta", "chart"), ("jumlah", "totals")):
        if word in hint and info["type"] not in ("unknown", typ):
            warnings.append(warn("name_type_mismatch", f"{name} looks like a {info['type']} file from its columns, not a {typ} file as its name suggests.", file=file_id))
    if info["ignored_sensitive_columns"]:
        warnings.append(warn("revenue_ignored", f"{name}: ignored {len(info['ignored_sensitive_columns'])} revenue-type column(s); this audit does not analyse earnings.", file=file_id))
    if info["unmapped_columns"]:
        warnings.append(warn("unmapped_columns", f"{name}: {len(info['unmapped_columns'])} column(s) not recognised and not analysed: "
                             + ", ".join(repr(c) for c in info["unmapped_columns"][:8]), file=file_id))

    metric_keys = [k for k in keys if COLUMN_INFO[k]["kind"] == "metric" and COLUMN_INFO[k]["unit"] != "duration"]
    num_cells = [clean_num(r[keys[k]]) for r in rows[1:] for k in metric_keys if keys[k] < len(r)]
    decimal, decimal_note = detect_decimal(num_cells)
    info["number_format"] = decimal_note
    if decimal == "conflict":
        warnings.append(warn("number_format_conflict", f"{name}: mixed number formats ({decimal_note}); non-integer cells are left blank. "
                             "Re-export, or tell the analysis which format the file uses.", file=file_id))
    elif decimal == "ambiguous":
        warnings.append(warn("number_format_ambiguous", f"{name}: {decimal_note}; those cells are left blank.", file=file_id))
    elif "could be read either way" in decimal_note:
        warnings.append(warn("number_format_assumed", f"{name}: {decimal_note}; read them using the file's {decimal_note.split(' (')[0]}.", file=file_id))

    header_by_key = {k: header[i] for k, i in keys.items()}
    records, total, problems = [], None, {}
    for line_no, r in enumerate(rows[1:], start=2):
        rec = {"_line": line_no}
        for key, idx in keys.items():
            raw = r[idx] if idx < len(r) else ""
            unit = COLUMN_INFO[key]["unit"]
            if unit in ("id", "text"):
                rec[key] = raw.strip()
                continue
            if unit == "date":
                val, prob = parse_date(raw)
            elif unit == "duration":
                val, prob = parse_duration(raw)
            else:
                val, prob = parse_number(raw, decimal)
            rec[key] = val
            if prob and prob != "missing":
                problems.setdefault((key, prob), []).append(line_no)
            if prob == "missing":
                rec.setdefault("_missing", []).append(key)
            if key == "published" and val is None and raw.strip():
                rec["published_raw"] = raw.strip()
        first = (r[0] if r else "").strip().casefold()
        if total is None and first in TOTAL_LABELS:
            total = rec
            continue
        if (total is None and line_no == 2 and info["type"] == "table" and not rec.get("video_id")
                and not rec.get("title") and any(isinstance(rec.get(k), float) for k in metric_keys)):
            total = rec
            warnings.append(warn("unlabelled_total_row", f"{name}: row 2 has no video ID or title but has figures; treated as the Total row.", file=file_id, row=2))
            continue
        records.append(rec)
    for (key, prob), lines in sorted(problems.items()):
        sev = {"thousands_separator": "Read thousands separators in", "unreadable": "Could not read values in",
               "ambiguous_day_month": "Day/month order is ambiguous in"}.get(prob, prob)
        warnings.append(warn(f"value_{prob}", f"{name}: {sev} column {header_by_key[key]!r} on {len(lines)} row(s), e.g. line {lines[0]}."
                             + (" These are left blank, never set to zero." if prob != "thousands_separator" else ""),
                             file=file_id, column=header_by_key[key], rows=lines[:20]))
    info["data_rows"] = len(records)
    if total is not None:
        info["total_row"] = total["_line"]
    return {"info": info, "records": records, "total": total, "keys": keys, "headers": header_by_key}


# --------------------------------------------------------------------------
# Facts with provenance
# --------------------------------------------------------------------------
class Facts:
    def __init__(self):
        self.items = []

    def add(self, label, value, unit, formula, sources, note=None):
        fid = f"F{len(self.items) + 1:03d}"
        item = {"id": fid, "label": label, "value": rnd(value, 2 if unit == "percent" else 4), "unit": unit, "formula": formula, "sources": sources}
        if note:
            item["note"] = note
        self.items.append(item)
        return fid


def rnd(v, places=4):
    if isinstance(v, float):
        v = round(v, places)
        return int(v) if v.is_integer() and abs(v) < 1e15 else v
    return v


def src(file_id, column, rows):
    return {"file": file_id, "column": column, "rows": rows}


def row_span(records):
    lines = [r["_line"] for r in records]
    return f"{min(lines)}-{max(lines)}" if lines else ""


def median(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def bucket(duration):
    if duration is None:
        return "unknown length"
    if duration <= 60:
        return "0-60 s"
    if duration <= 180:
        return "61-180 s"
    return "over 180 s"


# --------------------------------------------------------------------------
# Dataset analysis
# --------------------------------------------------------------------------
def analyse_dataset(ds: dict, ds_index: int, opts) -> dict:
    warnings, facts = [], Facts()
    parsed = []
    for i, (name, data) in enumerate(ds["files"], start=1):
        parsed.append(parse_csv(f"S{ds_index}.{i}", name, data, warnings))
    out = {"label": ds["label"], "kind": ds["kind"], "sha256": ds.get("sha256"),
           "files": [p["info"] for p in parsed], "warnings": warnings}
    tables = [p for p in parsed if p["info"]["type"] == "table"]
    charts = [p for p in parsed if p["info"]["type"] == "chart"]
    totals = [p for p in parsed if p["info"]["type"] == "totals"]
    if not (tables or charts or totals):
        out["recognised"] = False
        return out
    out["recognised"] = True
    if len(tables) > 1:
        warnings.append(warn("multiple_tables", f"{len(tables)} table files in one dataset; only the first ({tables[0]['info']['name']}) is analysed. Upload separate exports separately."))

    # ---- reporting period -------------------------------------------------
    period = {"start": None, "end": None, "days": None, "basis": None, "notes": []}
    m = re.search(r"(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})", ds["label"])
    name_range = (m[1], m[2]) if m else None
    dates = sorted({r["date"] for p in charts + totals for r in p["records"] if r.get("date")})
    if name_range:
        period["file_name_range"] = {"start": name_range[0], "end": name_range[1]}
    if dates:
        period["data_range"] = {"start": dates[0], "end": dates[-1], "distinct_days": len(dates)}
    if opts.period_start and opts.period_end:
        period.update(start=opts.period_start, end=opts.period_end, basis="given by the user (--period-start/--period-end)")
    elif dates:
        period.update(start=dates[0], end=dates[-1], basis="first and last dates in the daily (chart/totals) files")
    elif name_range:
        period.update(start=name_range[0], end=name_range[1], basis="date range in the export file name (no daily file to confirm it)")
    else:
        period["basis"] = "unknown: no dates in the files or file name"
        warnings.append(warn("period_unknown", "The reporting period is unknown. Ask the user which date range they exported; do not guess."))
    if period["start"] and period["end"]:
        d0, d1 = dt.date.fromisoformat(period["start"]), dt.date.fromisoformat(period["end"])
        period["days"] = (d1 - d0).days + 1
        for when, what in DEFINITION_CHANGES:
            if d0 < dt.date.fromisoformat(when) <= d1:
                period["notes"].append(f"The period spans {when}: {what} Figures before and after that date may not be comparable.")
    if name_range and dates and name_range != (dates[0], dates[-1]):
        gap = (dt.date.fromisoformat(name_range[1]) - dt.date.fromisoformat(dates[-1])).days
        extra = (" The file name's end date is one day after the last daily row; the export may name the end date exclusively, "
                 "or the last day may be missing. Not resolved from the files.") if name_range[0] == dates[0] and gap == 1 else ""
        period["notes"].append(f"File name says {name_range[0]} to {name_range[1]}; daily rows run {dates[0]} to {dates[-1]}.{extra}")
    if tables:
        period["notes"].append("Table data has no dates; its figures are assumed to cover the export's selected date range above.")
    if len(dates) >= 2 and period["days"] and len(dates) < period["days"] and not (opts.period_start and opts.period_end):
        period["notes"].append(f"Daily files have {len(dates)} distinct dates for a {period['days']}-day range; some days are missing rows.")
    out["period"] = period

    # ---- table data ---------------------------------------------------------
    videos, headline = [], {}
    if tables:
        t = tables[0]
        fid, hdr, recs, tot = t["info"]["id"], t["headers"], t["records"], t["total"]
        mkeys = [k for k in t["keys"] if COLUMN_INFO[k]["kind"] == "metric"]
        # duplicates
        ids = [r.get("video_id") for r in recs if r.get("video_id")]
        dups = sorted({i for i in ids if ids.count(i) > 1})
        if dups:
            warnings.append(warn("duplicate_videos", f"{len(dups)} video ID(s) appear more than once in {t['info']['name']}; rows are kept as exported.", file=fid))
        # headline figures
        for k in mkeys:
            if tot is not None and tot.get(k) is not None:
                headline[k] = {"value": tot[k], "fact": facts.add(f"Channel total: {LABELS[k]}", tot[k], COLUMN_INFO[k]["unit"],
                                                                  "Total row as exported by YouTube Studio", [src(fid, hdr[k], str(tot["_line"]))])}
            elif COLUMN_INFO[k]["additive"]:
                vals = [r[k] for r in recs if r.get(k) is not None]
                if vals:
                    headline[k] = {"value": sum(vals), "fact": facts.add(f"Sum of video rows: {LABELS[k]}", sum(vals), COLUMN_INFO[k]["unit"],
                                                                         f"sum of {len(vals)} non-blank video rows (no Total row in the file)",
                                                                         [src(fid, hdr[k], row_span(recs))],
                                                                         note="May be lower than the channel total: deleted videos and rows beyond the 500-row export limit are not listed.")}
        if tot is None:
            warnings.append(warn("no_total_row", f"{t['info']['name']} has no Total row; channel totals are sums of the listed videos only.", file=fid))
            if "ctr_pct" in mkeys and "impressions" in mkeys:
                pairs = [(r["ctr_pct"], r["impressions"]) for r in recs if r.get("ctr_pct") is not None and r.get("impressions")]
                if pairs:
                    w = sum(c * i for c, i in pairs) / sum(i for _, i in pairs)
                    headline["ctr_pct"] = {"value": w, "fact": facts.add("Estimated channel CTR (impression-weighted)", w, "percent",
                                                                       "sum(CTR x impressions) / sum(impressions) over video rows",
                                                                       [src(fid, hdr["ctr_pct"], row_span(recs)), src(fid, hdr["impressions"], row_span(recs))],
                                                                       note="Estimate; YouTube's own total may differ.")}
        # reconciliation
        recon = []
        if tot is not None:
            for k in mkeys:
                if not COLUMN_INFO[k]["additive"] or tot.get(k) is None:
                    continue
                vals = [r[k] for r in recs if r.get(k) is not None]
                s = sum(vals)
                diff = tot[k] - s
                recon.append({"metric": k, "column": hdr[k], "total_row": rnd(tot[k]), "sum_of_rows": rnd(s), "difference": rnd(diff),
                              "difference_pct_of_total": rnd(diff / tot[k] * 100, 2) if tot[k] else None})
            if any(abs(x["difference"]) > 1e-9 for x in recon):
                warnings.append(warn("total_vs_rows", "The Total row differs from the sum of listed videos for some metrics. YouTube counts deleted "
                                     "videos in totals and exports at most 500 rows, so this is expected; shares use the Total row as denominator.", file=fid))
            if "ctr_pct" in mkeys and "impressions" in mkeys and tot.get("ctr_pct") is not None:
                pairs = [(r["ctr_pct"], r["impressions"]) for r in recs if r.get("ctr_pct") is not None and r.get("impressions")]
                if pairs:
                    w = sum(c * i for c, i in pairs) / sum(i for _, i in pairs)
                    recon.append({"metric": "ctr_pct", "column": hdr["ctr_pct"], "total_row": rnd(tot["ctr_pct"]),
                                  "impression_weighted_mean_of_rows": rnd(w, 3), "note": "percentages are not added; weighted mean shown as a check only"})
            if "avg_view_duration_s" in mkeys and "watch_time_h" in mkeys and tot.get("avg_view_duration_s"):
                checks = []
                for denom in ("views", "engaged_views"):
                    if tot.get(denom):
                        checks.append({"denominator": hdr.get(denom, denom), "watch_time_seconds_per_view": rnd(tot["watch_time_h"] * 3600 / tot[denom], 1)})
                recon.append({"metric": "avg_view_duration_s", "column": hdr["avg_view_duration_s"], "total_row": rnd(tot["avg_view_duration_s"]),
                              "watch_time_divided_by": checks,
                              "note": "YouTube calculates average view duration from engaged views and their watch time, so it need not equal watch time / views. Use the exported value; do not recompute it."})
        out["reconciliation"] = recon

        # per-video records
        denom = {k: headline[k]["value"] for k in ("views", "watch_time_h", "engaged_views", "impressions") if k in headline}
        p_end = dt.date.fromisoformat(period["end"]) if period["end"] else None
        p_start = dt.date.fromisoformat(period["start"]) if period["start"] else None
        for r in recs:
            v = {"row": r["_line"], "video_id": r.get("video_id", ""), "title": r.get("title", "")}
            for k in ("published", "duration_s"):
                if k in r:
                    v[k] = rnd(r[k])
            if r.get("published_raw"):
                v["published_raw"] = r["published_raw"]
            for k in mkeys:
                v[k] = rnd(r.get(k))
            v["length_group"] = bucket(r.get("duration_s"))
            for k, d in denom.items():
                if r.get(k) is not None and d:
                    v[f"share_of_{k}_pct"] = rnd(r[k] / d * 100, 2)
            if r.get("views") and r.get("engaged_views") is not None:
                v["engaged_per_view_pct"] = rnd(r["engaged_views"] / r["views"] * 100, 1)
            if r.get("views") and r.get("subscribers") is not None:
                v["subscribers_per_1000_views"] = rnd(r["subscribers"] / r["views"] * 1000, 2)
            if r.get("published") and p_end:
                pub = dt.date.fromisoformat(r["published"])
                v["days_live_by_period_end"] = (p_end - pub).days + 1
                if p_start and pub < p_start:
                    v["published_before_period"] = True
            if r.get("_missing"):
                v["blank_columns"] = [hdr[k] for k in r["_missing"] if k in hdr]
            if r.get("engaged_views") is not None and r.get("views") is not None and r["engaged_views"] > r["views"]:
                warnings.append(warn("engaged_above_views", f"Row {r['_line']}: engaged views exceed views; check the export.", file=fid, row=r["_line"]))
            videos.append(v)
        out["videos"] = videos
        out["missing_values"] = {hdr[k]: sum(1 for r in recs if r.get(k) is None) for k in t["keys"] if COLUMN_INFO[k]["kind"] == "metric"}
        out["headline"] = {k: {"label": LABELS[k], "value": rnd(h["value"]), "fact": h["fact"]} for k, h in headline.items()}

        # rankings
        def rank(key, min_key=None, min_val=0, reverse=True):
            pool = [v for v in videos if v.get(key) is not None and (min_key is None or (v.get(min_key) or 0) >= min_val)]
            pool.sort(key=lambda v: (-(v[key]) if reverse else v[key], v["row"]))
            return [{"row": v["row"], "video_id": v["video_id"], "title": v["title"], key: v[key],
                     **({min_key: v.get(min_key)} if min_key else {})} for v in pool[:opts.top]], len(pool)
        rankings = {}
        for key in ("views", "engaged_views", "watch_time_h", "impressions", "subscribers"):
            if key in mkeys:
                rankings[f"top_by_{key}"], _ = rank(key)
        if "ctr_pct" in mkeys:
            rankings["top_ctr"], n = rank("ctr_pct", "impressions", opts.min_impressions)
            rankings["bottom_ctr"], _ = rank("ctr_pct", "impressions", opts.min_impressions, reverse=False)
            rankings["ctr_eligible_videos"] = n
        if "avg_pct_viewed" in mkeys:
            basis = "engaged_views" if "engaged_views" in mkeys else "views"
            rankings["top_avg_pct_viewed"], n = rank("avg_pct_viewed", basis, opts.min_engaged_views)
            rankings["bottom_avg_pct_viewed"], _ = rank("avg_pct_viewed", basis, opts.min_engaged_views, reverse=False)
            rankings["retention_eligible_videos"] = n
        rankings["thresholds"] = {"min_impressions_for_ctr": opts.min_impressions, "min_engaged_views_for_retention": opts.min_engaged_views,
                                  "note": "Practical cut-offs to avoid ranking tiny samples, not statistical significance tests."}
        out["rankings"] = rankings

        # concentration
        if "views" in denom and denom["views"]:
            ordered = sorted((v.get("views") or 0 for v in videos), reverse=True)
            for n in (1, 3, 10):
                if len(ordered) >= n:
                    s = sum(ordered[:n])
                    facts.add("Share of channel views from the top video" if n == 1 else f"Share of channel views from the top {n} videos",
                              s / denom["views"] * 100, "percent",
                              f"sum of the {n} highest per-video views / channel total views x 100",
                              [src(fid, hdr["views"], row_span(recs)), src(fid, hdr["views"], str(tot["_line"]) if tot else row_span(recs))])

        # length groups
        groups = {}
        for v in videos:
            groups.setdefault(v["length_group"], []).append(v)
        gstats = []
        for g in ("0-60 s", "61-180 s", "over 180 s", "unknown length"):
            vs = groups.get(g)
            if not vs:
                continue
            row = {"group": g, "videos": len(vs)}
            for k in ("views", "engaged_views", "watch_time_h", "impressions", "subscribers"):
                if k in mkeys:
                    row[f"total_{k}"] = rnd(sum(v[k] for v in vs if v.get(k) is not None))
            if "views" in mkeys:
                row["median_views"] = rnd(median([v.get("views") for v in vs]))
            if "ctr_pct" in mkeys and "impressions" in mkeys:
                pairs = [(v["ctr_pct"], v["impressions"]) for v in vs if v.get("ctr_pct") is not None and v.get("impressions")]
                if pairs and sum(i for _, i in pairs):
                    row["impression_weighted_ctr_pct"] = rnd(sum(c * i for c, i in pairs) / sum(i for _, i in pairs), 2)
            if "avg_pct_viewed" in mkeys:
                row["median_avg_pct_viewed"] = rnd(median([v.get("avg_pct_viewed") for v in vs]), 2)
            if "avg_view_duration_s" in mkeys:
                row["median_avg_view_duration_s"] = rnd(median([v.get("avg_view_duration_s") for v in vs]), 1)
            if row.get("total_views") and "total_engaged_views" in row:
                row["engaged_per_view_pct"] = rnd(row["total_engaged_views"] / row["total_views"] * 100, 1)
            row["fact"] = facts.add(f"Length group {g}: videos and views", row.get("total_views"), "count",
                                    f"{len(vs)} videos with duration in {g}; sums and medians over their rows",
                                    [src(fid, hdr.get("duration_s", "duration"), ",".join(str(v['row']) for v in vs[:50]))])
            gstats.append(row)
        out["length_groups"] = {"groups": gstats, "note": "Grouped by the Duration column only. The export does not say which videos are Shorts; "
                                "a video of 3 minutes or less may or may not be a Short."}

        # publishing
        pubs = sorted(v["published"] for v in videos if v.get("published"))
        if pubs:
            pubinfo = {"first": pubs[0], "last": pubs[-1], "videos_with_dates": len(pubs),
                       "unparsed_dates": sum(1 for v in videos if v.get("published_raw"))}
            if period["start"]:
                inside = [p for p in pubs if period["start"] <= p <= (period["end"] or p)]
                pubinfo["published_inside_period"] = len(inside)
                pubinfo["published_before_period"] = sum(1 for p in pubs if p < period["start"])
                before = (dt.date.fromisoformat(pubs[0]) - dt.date.fromisoformat(period["start"])).days
                if before > 0:
                    pubinfo["days_before_first_listed_video"] = before
                    period["notes"].append(f"The first listed video was published {before} day(s) after the period starts; "
                                           "per-day averages over the whole period would understate activity.")
            weeks = {}
            for p in pubs:
                y, w, _ = dt.date.fromisoformat(p).isocalendar()
                weeks[f"{y}-W{w:02d}"] = weeks.get(f"{y}-W{w:02d}", 0) + 1
            pubinfo["videos_per_iso_week"] = dict(sorted(weeks.items()))
            if p_end:
                young = [v for v in videos if v.get("days_live_by_period_end") is not None and v["days_live_by_period_end"] <= 7]
                pubinfo["videos_live_7_days_or_less"] = len(young)
            out["publishing"] = pubinfo

    # ---- daily data -----------------------------------------------------------
    daily = {"files": [], "metrics_available": [], "not_available": []}
    seen_metrics = set()
    for p in charts + totals:
        info, hdr = p["info"], p["headers"]
        mk = [k for k in p["keys"] if COLUMN_INFO[k]["kind"] == "metric"]
        seen_metrics.update(mk)
        entry = {"file": info["id"], "name": info["name"], "type": info["type"], "metrics": [hdr[k] for k in mk], "series": {}}
        for k in mk:
            by_day = {}
            for r in p["records"]:
                if r.get("date") and r.get(k) is not None:
                    by_day[r["date"]] = by_day.get(r["date"], 0.0) + r[k]
            if not by_day:
                continue
            vals = list(by_day.values())
            peak_day = max(sorted(by_day), key=lambda d: by_day[d])
            fact = facts.add(f"{info['type'].title()} file daily {LABELS[k]}: sum over days", sum(vals), COLUMN_INFO[k]["unit"],
                             f"sum of {len(vals)} daily values" + (" across all listed videos" if info["type"] == "chart" else ""),
                             [src(info["id"], hdr[k], row_span(p["records"]))])
            entry["series"][k] = {"label": LABELS[k], "days_with_values": len(vals), "sum": rnd(sum(vals)), "nonzero_days": sum(1 for x in vals if x),
                                  "peak_day": peak_day if any(vals) else None, "peak_value": rnd(by_day[peak_day]) if any(vals) else None, "fact": fact}
            if info["type"] == "totals":
                entry["series"][k]["by_day"] = {d: rnd(by_day[d]) for d in sorted(by_day)}
        if info["type"] == "chart":
            vids = sorted({r.get("video_id") for r in p["records"] if r.get("video_id")})
            entry["videos_in_chart"] = len(vids)
            pre = [r for r in p["records"] if r.get("published") and r.get("date") and r["date"] < r["published"]]
            if pre:
                nonzero = [r for r in pre if any(r.get(k) for k in mk)]
                entry["rows_before_publication"] = len(pre)
                entry["rows_before_publication_nonzero"] = len(nonzero)
                warnings.append(warn("chart_rows_before_publication", f"{info['name']}: {len(pre)} daily row(s) are dated before the video was published "
                                     f"({len(nonzero)} with non-zero values). The export fills these days; they are not activity.", file=info["id"]))
        daily["files"].append(entry)
    daily["metrics_available"] = sorted(LABELS[k] for k in seen_metrics)
    for k in ("views", "watch_time_h", "engaged_views", "impressions", "subscribers"):
        if k not in seen_metrics:
            daily["not_available"].append(f"Daily {LABELS[k]}: not in this export. Do not estimate it from Table data.")
    if tables and "subscribers" in headline:
        for p in totals:
            s = p["info"]["id"]
            if "subscribers" in p["keys"]:
                tot_sum = sum(r["subscribers"] for r in p["records"] if r.get("subscribers") is not None)
                out.setdefault("reconciliation", []).append({"metric": "subscribers", "check": "Totals file daily sum vs Table Total row",
                                                             "totals_file_sum": rnd(tot_sum), "table_total": rnd(headline["subscribers"]["value"]),
                                                             "difference": rnd(headline["subscribers"]["value"] - tot_sum), "file": s})
    out["daily"] = daily

    # ---- signals (observations to ground experiments) ---------------------------
    out["signals"] = build_signals(out, headline, facts, opts)
    out["facts"] = facts.items
    return out


def build_signals(out, headline, facts, opts):
    sig, videos = [], out.get("videos", [])
    if not videos:
        return sig
    ch_ctr = headline.get("ctr_pct", {}).get("value")
    pool = [v for v in videos if v.get("ctr_pct") is not None and (v.get("impressions") or 0) >= opts.min_impressions]
    if ch_ctr is not None and pool:
        below = sorted((v for v in pool if v["ctr_pct"] < ch_ctr), key=lambda v: (-v["impressions"], v["row"]))
        above = sorted((v for v in pool if v["ctr_pct"] >= ch_ctr), key=lambda v: (-v["ctr_pct"], v["row"]))
        sig.append({"id": "packaging", "facts": [headline["ctr_pct"]["fact"]],
                    "observation": f"{len(below)} of {len(pool)} videos with at least {opts.min_impressions} impressions have CTR below the channel's {rnd(ch_ctr, 2)}%.",
                    "examples_below": [{"row": v["row"], "title": v["title"], "impressions": v["impressions"], "ctr_pct": v["ctr_pct"]} for v in below[:3]],
                    "examples_above": [{"row": v["row"], "title": v["title"], "impressions": v["impressions"], "ctr_pct": v["ctr_pct"]} for v in above[:3]]})
    groups = out.get("length_groups", {}).get("groups", [])
    if len([g for g in groups if g.get("median_avg_pct_viewed") is not None]) >= 2:
        sig.append({"id": "length_vs_retention", "facts": [g["fact"] for g in groups],
                    "observation": "; ".join(f"{g['group']}: {g['videos']} videos, median average % viewed {g.get('median_avg_pct_viewed')}, median views {g.get('median_views')}"
                                             for g in groups if g.get("median_avg_pct_viewed") is not None)})
    if any("engaged_per_view_pct" in g for g in groups):
        sig.append({"id": "engaged_share", "facts": [g["fact"] for g in groups],
                    "observation": "; ".join(f"{g['group']}: {g['engaged_per_view_pct']}% of views were engaged views" for g in groups if "engaged_per_view_pct" in g)})
    conc = [f for f in facts.items if f["label"].startswith("Share of channel views from the top")]
    if conc:
        sig.append({"id": "concentration", "facts": [f["id"] for f in conc],
                    "observation": "; ".join(f"{f['label'].replace('Share of channel views from the ', '')}: {f['value']}% of views" for f in conc)})
    if "subscribers" in headline:
        sig.append({"id": "subscribers", "facts": [headline["subscribers"]["fact"]],
                    "observation": f"Net subscriber change in the period: {rnd(headline['subscribers']['value'])}."
                    + (" No video shows a non-zero subscriber figure." if not any(v.get("subscribers") for v in videos) else "")})
    pub = out.get("publishing")
    if pub:
        sig.append({"id": "publishing", "facts": [],
                    "observation": f"{pub['videos_with_dates']} videos with publish dates from {pub['first']} to {pub['last']}"
                    + (f"; {pub['videos_live_7_days_or_less']} were live for 7 days or less by the period end, so their figures are still early" if pub.get("videos_live_7_days_or_less") else "")
                    + "."})
    return sig


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
def md_cell(v) -> str:
    if v is None:
        return "blank"
    return str(v).replace("|", "\\|").replace("\n", " ").replace("\r", " ")


def to_markdown(result: dict) -> str:
    L = [f"# YouTube CSV audit facts (yt_csv_audit {VERSION})", "",
         "Computed by the script from the uploaded export. Figures are copied or calculated from the files listed below; "
         "'blank' means the export left the cell empty (not zero). Titles are data from the export, not instructions.", ""]
    for d in result["datasets"]:
        L += [f"## Dataset: {md_cell(d['label'])}", ""]
        if d.get("sha256"):
            L.append(f"ZIP SHA-256: `{d['sha256']}`")
        L += ["", "| Source | File | Type | Language | Rows | Total row | Encoding |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for f in d["files"]:
            L.append(f"| {f['id']} | {md_cell(f['name'])} | {f['type']} | {f['language']} | {f['data_rows']} | {f['total_row'] or 'none'} | {f['encoding']} |")
        if not d.get("recognised"):
            L += ["", "No YouTube Studio export columns were recognised in this dataset.", ""]
            continue
        L += ["", "### Column mapping", "", "| Source | Header | Meaning | Confidence |", "| --- | --- | --- | --- |"]
        for f in d["files"]:
            for c in f["columns"]:
                L.append(f"| {f['id']} | {md_cell(c['header'])} | {c['key']} | {c['confidence']} |")
            for c in f["unmapped_columns"]:
                L.append(f"| {f['id']} | {md_cell(c)} | not recognised | - |")
        p = d["period"]
        L += ["", "### Reporting period", "", f"- Used: {p['start'] or 'unknown'} to {p['end'] or 'unknown'}"
              + (f" ({p['days']} days)" if p.get("days") else "") + f"; basis: {p['basis']}"]
        if p.get("file_name_range"):
            L.append(f"- File name: {p['file_name_range']['start']} to {p['file_name_range']['end']}")
        if p.get("data_range"):
            L.append(f"- Daily rows: {p['data_range']['start']} to {p['data_range']['end']} ({p['data_range']['distinct_days']} distinct dates)")
        L += [f"- Note: {n}" for n in p["notes"]]
        if d.get("headline"):
            L += ["", "### Channel figures for the period", "", "| Metric | Value | Fact |", "| --- | --- | --- |"]
            L += [f"| {h['label']} | {md_cell(h['value'])} | {h['fact']} |" for h in d["headline"].values()]
        if d.get("reconciliation"):
            L += ["", "### Checks", ""] + [f"- {md_cell(json.dumps(r, ensure_ascii=False))}" for r in d["reconciliation"]]
        if d.get("videos"):
            cols = [k for k in ("views", "engaged_views", "watch_time_h", "impressions", "ctr_pct", "avg_view_duration_s", "avg_pct_viewed", "subscribers")
                    if any(k in v for v in d["videos"])]
            top = sorted(d["videos"], key=lambda v: (-(v.get("views") or 0), v["row"]))[: max(result["options"]["top"], 1)]
            L += ["", f"### Top {len(top)} videos by views (of {len(d['videos'])})", "",
                  "| Row | Title | Published | Duration s | " + " | ".join(LABELS[k] for k in cols) + " | Share of views % |",
                  "| --- " * (5 + len(cols)) + "|"]
            for v in top:
                L.append(f"| {v['row']} | {md_cell(v['title'])} | {md_cell(v.get('published'))} | {md_cell(v.get('duration_s'))} | "
                         + " | ".join(md_cell(v.get(k)) for k in cols) + f" | {md_cell(v.get('share_of_views_pct'))} |")
            L += ["", "Missing values per column: " + ", ".join(f"{md_cell(k)}: {n}" for k, n in d["missing_values"].items())]
        if d.get("length_groups"):
            L += ["", "### Length groups", "", d["length_groups"]["note"], ""]
            L += [f"- {md_cell(json.dumps(g, ensure_ascii=False))}" for g in d["length_groups"]["groups"]]
        if d.get("publishing"):
            L += ["", "### Publishing", "", f"- {md_cell(json.dumps(d['publishing'], ensure_ascii=False))}"]
        dl = d["daily"]
        L += ["", "### Daily data", "", f"- Metrics with daily values: {', '.join(dl['metrics_available']) or 'none'}"]
        L += [f"- {n}" for n in dl["not_available"]]
        for f in dl["files"]:
            for s in f["series"].values():
                L.append(f"- {f['file']} ({f['type']}): {s['label']} sum {s['sum']} over {s['days_with_values']} days, non-zero on {s['nonzero_days']} [{s['fact']}]")
        if d.get("signals"):
            L += ["", "### Signals for experiments", ""]
            for s in d["signals"]:
                L.append(f"- **{s['id']}** {md_cell(s['observation'])} (facts: {', '.join(s['facts']) or 'video rows'})")
                for label, key in (("below channel CTR", "examples_below"), ("at or above channel CTR", "examples_above")):
                    for e in s.get(key, []):
                        L.append(f"  - {label}: row {e['row']} {md_cell(e['title'])}: {e['impressions']} impressions, CTR {e['ctr_pct']}%")
        if d["warnings"]:
            L += ["", "### Warnings", ""] + [f"- `{w['code']}` {md_cell(w['message'])}" for w in d["warnings"]]
        L += ["", "### Calculation log", "", "| Fact | Label | Value | Formula | Sources |", "| --- | --- | --- | --- | --- |"]
        for f in d["facts"]:
            srcs = "; ".join(f"{s['file']} '{s['column']}' rows {s['rows']}" for s in f["sources"])
            L.append(f"| {f['id']} | {md_cell(f['label'])} | {md_cell(f['value'])} | {md_cell(f['formula'])} | {md_cell(srcs)} |")
        L.append("")
    if result["warnings"]:
        L += ["## Input warnings", ""] + [f"- `{w['code']}` {md_cell(w['message'])}" for w in result["warnings"]]
    return "\n".join(L) + "\n"


def run(paths, opts) -> dict:
    warnings = []
    datasets = collect_inputs(paths, warnings)
    result = {"tool": {"name": "yt_csv_audit", "version": VERSION, "selftest": "passed"},
              "options": {"top": opts.top, "min_impressions": opts.min_impressions, "min_engaged_views": opts.min_engaged_views},
              "warnings": warnings, "datasets": []}
    for i, ds in enumerate(datasets, start=1):
        if not ds["files"]:
            warnings.append(warn("no_csv", f"{ds['label']} contains no CSV files."))
            continue
        result["datasets"].append(analyse_dataset(ds, i, opts))
    return result


def build_parser():
    ap = argparse.ArgumentParser(prog="yt_csv_audit", description="Analyse YouTube Studio CSV/ZIP exports (offline, standard library only).")
    ap.add_argument("inputs", nargs="*", help="ZIP files, CSV files or folders exported from YouTube Studio")
    ap.add_argument("--out", help="folder to write audit_data.json and audit_facts.md (default: print to stdout)")
    ap.add_argument("--format", choices=("json", "md"), default="json", help="stdout format when --out is not given")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--min-impressions", type=int, default=100, help="minimum impressions before a video's CTR is ranked")
    ap.add_argument("--min-engaged-views", type=int, default=10, help="minimum engaged views (or views) before retention is ranked")
    ap.add_argument("--period-start")
    ap.add_argument("--period-end")
    ap.add_argument("--selftest", action="store_true", help="run built-in checks on synthetic data and exit")
    return ap


def main(argv=None) -> int:
    opts = build_parser().parse_args(argv)
    if opts.selftest:
        return selftest()
    if not opts.inputs:
        print("error: give at least one export ZIP, CSV or folder (or --selftest)", file=sys.stderr)
        return 2
    for name in ("period_start", "period_end"):
        val = getattr(opts, name)
        if val:
            try:
                dt.date.fromisoformat(val)
            except ValueError:
                print(f"error: --{name.replace('_', '-')} must be YYYY-MM-DD", file=sys.stderr)
                return 2
    if bool(opts.period_start) != bool(opts.period_end):
        print("error: give both --period-start and --period-end", file=sys.stderr)
        return 2
    if selftest(quiet=True) != 0:
        print("error: this copy of yt_csv_audit.py failed its built-in self-test, so it may be damaged or edited. "
              "Use an unmodified copy of the script.", file=sys.stderr)
        return 4
    try:
        result = run(opts.inputs, opts)
    except InputError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if not any(d.get("recognised") for d in result["datasets"]):
        print("error: no YouTube Studio export columns were recognised. Expected Table data.csv / Chart data.csv / Totals.csv "
              "from Analytics > Advanced mode > Export current view > CSV.", file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False, indent=1), file=sys.stderr)
        return 3
    if opts.out:
        os.makedirs(opts.out, exist_ok=True)
        with open(os.path.join(opts.out, "audit_data.json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        with open(os.path.join(opts.out, "audit_facts.md"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(to_markdown(result))
        print(f"Wrote audit_data.json and audit_facts.md to {opts.out}")
    else:
        text = to_markdown(result) if opts.format == "md" else json.dumps(result, ensure_ascii=False, indent=1) + "\n"
        sys.stdout.buffer.write(text.encode("utf-8"))
    return 0


# --------------------------------------------------------------------------
# Self-test on synthetic data (also detects a damaged copy of this script)
# --------------------------------------------------------------------------
def selftest(quiet: bool = False) -> int:
    import tempfile
    table = ("Kandungan,Tajuk video,Masa penerbitan video,Tempoh,Pelanggan,Tontonan sahih,Tera lakaran kecil,"
             "Kadar klikan lakaran kecil (%),Purata tempoh tontonan,Purata peratusan ditonton (%),Tontonan,Masa tontonan (jam)\n"
             "Jumlah,,,,3,60,3000,2.5,0:00:40,55.5,210,1.5\n"
             "SYNTHVID001,Synthetic A,\"Jan 3, 2026\",45,2,40,2000,3,0:00:35,77.7,150,1.1\n"
             "SYNTHVID002,Synthetic B,\"Jan 10, 2026\",300,1,15,950,1.5,0:01:30,30,55,0.35\n"
             "SYNTHVID003,Synthetic C,\"Jan 20, 2026\",30,,,40,0,,,,\n")
    totals = "Tarikh,Pelanggan\n" + "".join(f"2026-01-{d:02d},{1 if d in (3, 10, 21) else 0}\n" for d in range(1, 29))
    checks = []
    with tempfile.TemporaryDirectory() as tmp:
        zp = os.path.join(tmp, "Content_2026-01-01_2026-01-29_Selftest.zip")
        with zipfile.ZipFile(zp, "w") as z:
            z.writestr("Table data.csv", table)
            z.writestr("Totals.csv", totals)
        res = run([zp], build_parser().parse_args(["x"]))
    d = res["datasets"][0]
    h = d["headline"]
    checks += [("views total row", h["views"]["value"] == 210), ("ctr from total row", h["ctr_pct"]["value"] == 2.5),
               ("avg view duration seconds", h["avg_view_duration_s"]["value"] == 40),
               ("three video rows", len(d["videos"]) == 3), ("blank stays blank", d["videos"][2]["views"] is None),
               ("period from daily rows", (d["period"]["start"], d["period"]["end"]) == ("2026-01-01", "2026-01-28")),
               ("reconciliation views diff 5", any(r.get("metric") == "views" and r.get("difference") == 5 for r in d["reconciliation"])),
               ("no daily views claimed", any("Daily Views" in n for n in d["daily"]["not_available"])),
               ("share of views", d["videos"][0]["share_of_views_pct"] == round(150 / 210 * 100, 2)),
               ("malay mapping", all(c["confidence"] == "seen" for c in d["files"][0]["columns"]))]
    failed = [n for n, ok in checks if not ok]
    if not quiet:
        for n, ok in checks:
            print(f"[{'ok' if ok else 'FAIL'}] {n}")
        print("selftest passed" if not failed else f"selftest FAILED: {', '.join(failed)}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
