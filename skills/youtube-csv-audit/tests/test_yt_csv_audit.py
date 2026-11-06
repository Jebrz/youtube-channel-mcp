"""Automated tests for the youtube-csv-audit skill. Synthetic data only.

Run from the repository root:
    python3 -m unittest discover -s skills/youtube-csv-audit/tests -v
"""
import ast
import importlib.util
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
SCRIPT = os.path.join(SKILL, "scripts", "yt_csv_audit.py")
FIX = os.path.join(HERE, "fixtures")
REPO = os.path.dirname(os.path.dirname(SKILL))

spec = importlib.util.spec_from_file_location("yt_csv_audit", SCRIPT)
yt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(yt)

_real_socket = socket.socket


def setUpModule():
    def blocked(*a, **k):
        raise AssertionError("network access attempted during tests")
    socket.socket = blocked


def tearDownModule():
    socket.socket = _real_socket


def opts(**kw):
    args = ["x"]
    for k, v in kw.items():
        args += [f"--{k.replace('_', '-')}", str(v)]
    return yt.build_parser().parse_args(args)


def make_zip(path, folder, names=("Table data.csv", "Chart data.csv", "Totals.csv")):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.write(os.path.join(folder, n), n)
    return path


def cli(*args, stdin=None, cwd=None):
    cmd = [sys.executable, "-I", SCRIPT, *args] if stdin is None else [sys.executable, "-I", "-", *args]
    return subprocess.run(cmd, input=stdin, capture_output=True, cwd=cwd, timeout=120)


class TmpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ytcsv-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class MalayExport(TmpCase):
    """Synthetic export structured like the real Malay-interface export."""

    def setUp(self):
        super().setUp()
        zp = make_zip(os.path.join(self.tmp, "Content_2026-01-01_2026-01-29_Synthetic Malay.zip"), os.path.join(FIX, "ms_export"))
        self.res = yt.run([zp], opts())
        self.d = self.res["datasets"][0]

    def test_files_classified_by_columns(self):
        types = {f["name"]: (f["type"], f["language"]) for f in self.d["files"]}
        self.assertEqual(types, {"Table data.csv": ("table", "ms"), "Chart data.csv": ("chart", "ms"), "Totals.csv": ("totals", "ms")})
        self.assertTrue(all(c["confidence"] == "seen" for f in self.d["files"] for c in f["columns"]))

    def test_headline_uses_total_row(self):
        h = {k: v["value"] for k, v in self.d["headline"].items()}
        self.assertEqual(h["views"], 2692)
        self.assertEqual(h["engaged_views"], 875)
        self.assertEqual(h["impressions"], 16775)
        self.assertEqual(h["ctr_pct"], 1.6)
        self.assertEqual(h["avg_view_duration_s"], 95)
        self.assertEqual(h["watch_time_h"], 19.584)
        self.assertEqual(h["subscribers"], 3)
        fact = next(f for f in self.d["facts"] if f["id"] == self.d["headline"]["views"]["fact"])
        self.assertEqual(fact["sources"], [{"file": "S1.1", "column": "Tontonan", "rows": "2"}])

    def test_total_row_not_a_video_and_reconciled(self):
        self.assertEqual(len(self.d["videos"]), 12)
        self.assertNotIn("Jumlah", [v["video_id"] for v in self.d["videos"]])
        rec = {r["metric"]: r for r in self.d["reconciliation"] if "sum_of_rows" in r}
        self.assertEqual(rec["views"]["difference"], 12)
        self.assertEqual(rec["impressions"]["difference"], 30)
        self.assertEqual(rec["engaged_views"]["difference"], 4)
        self.assertAlmostEqual(rec["watch_time_h"]["difference"], 0.05, places=6)
        self.assertIn("total_vs_rows", [w["code"] for w in self.d["warnings"]])

    def test_blank_cells_stay_blank(self):
        v = next(v for v in self.d["videos"] if v["video_id"] == "SYNvid00011")
        for k in ("views", "engaged_views", "watch_time_h", "subscribers", "avg_view_duration_s", "avg_pct_viewed"):
            self.assertIsNone(v[k], k)
        self.assertEqual(v["ctr_pct"], 0)  # a real zero stays zero
        self.assertNotIn("share_of_views_pct", v)
        self.assertEqual(self.d["missing_values"]["Tontonan"], 1)

    def test_period_and_file_name_discrepancy(self):
        p = self.d["period"]
        self.assertEqual((p["start"], p["end"], p["days"]), ("2026-01-01", "2026-01-28", 28))
        self.assertEqual(p["file_name_range"], {"start": "2026-01-01", "end": "2026-01-29"})
        self.assertTrue(any("one day after the last daily row" in n for n in p["notes"]))
        self.assertTrue(any("Table data has no dates" in n for n in p["notes"]))
        self.assertEqual(self.d["publishing"]["days_before_first_listed_video"], 4)

    def test_no_daily_views_invented(self):
        daily = self.d["daily"]
        self.assertEqual(daily["metrics_available"], ["Subscribers (net)"])
        joined = " ".join(daily["not_available"])
        for m in ("Daily Views", "Daily Watch time", "Daily Engaged views", "Daily Thumbnail impressions"):
            self.assertIn(m, joined)
        for f in daily["files"]:
            self.assertEqual(set(f["series"]), {"subscribers"})
            self.assertEqual(f["series"]["subscribers"]["sum"], 3)

    def test_chart_rows_before_publication_flagged(self):
        chart = next(f for f in self.d["daily"]["files"] if f["type"] == "chart")
        self.assertEqual(chart["rows_before_publication"], 40)
        self.assertEqual(chart["rows_before_publication_nonzero"], 0)

    def test_durations_and_dates(self):
        v = next(v for v in self.d["videos"] if v["video_id"] == "SYNvid00005")
        self.assertEqual(v["duration_s"], 720)
        self.assertEqual(v["avg_view_duration_s"], 210)
        self.assertEqual(v["published"], "2026-01-12")
        self.assertEqual(v["length_group"], "over 180 s")

    def test_length_groups_and_shares(self):
        g = {x["group"]: x for x in self.d["length_groups"]["groups"]}
        self.assertEqual({k: g[k]["videos"] for k in g}, {"0-60 s": 6, "61-180 s": 3, "over 180 s": 3})
        self.assertEqual(g["0-60 s"]["total_views"], 2220)
        self.assertEqual(g["over 180 s"]["impression_weighted_ctr_pct"], 1.01)
        top = next(v for v in self.d["videos"] if v["video_id"] == "SYNvid00001")
        self.assertEqual(top["share_of_views_pct"], round(1200 / 2692 * 100, 2))
        conc = {f["label"]: f["value"] for f in self.d["facts"] if f["label"].startswith("Share of channel views")}
        self.assertEqual(conc["Share of channel views from the top 3 videos"], round((1200 + 420 + 300) / 2692 * 100, 2))

    def test_rankings_respect_thresholds(self):
        r = self.d["rankings"]
        self.assertTrue(all(x["impressions"] >= 100 for x in r["top_ctr"]))
        self.assertTrue(all(x["engaged_views"] >= 10 for x in r["top_avg_pct_viewed"]))
        self.assertEqual(r["top_ctr"][0]["video_id"], "SYNvid00001")
        self.assertEqual(r["ctr_eligible_videos"], 10)

    def test_signals_cite_facts(self):
        ids = {f["id"] for f in self.d["facts"]}
        sig = {s["id"]: s for s in self.d["signals"]}
        self.assertTrue({"packaging", "length_vs_retention", "engaged_share", "concentration", "subscribers", "publishing"} <= set(sig))
        for s in sig.values():
            self.assertTrue(set(s["facts"]) <= ids)
        self.assertIn("6 of 10 videos", sig["packaging"]["observation"])

    def test_sample_report_numbers_match_script(self):
        """Every fact the synthetic sample report cites must equal the script's value."""
        with open(os.path.join(SKILL, "examples", "sample-report.md"), encoding="utf-8") as fh:
            report = fh.read()
        self.assertIn("SYNTHETIC SAMPLE", report)
        facts = {f["id"]: f["value"] for f in self.d["facts"]}
        rows = re.findall(r"^\| (F\d{3}) \| [^|]+ \| ([-\d.]+)", report, re.M)
        self.assertGreaterEqual(len(rows), 10)
        for fid, val in rows:
            self.assertEqual(float(val), float(facts[fid]), fid)
        for phrase in ("2,692", "875", "16,775", "1.6%", "1:35", "38.1%", "44.58%", "71.32%", "13.8", "23.6%", "79.4%", "5.56", "9.09"):
            self.assertIn(phrase, report)


class EnglishExport(TmpCase):
    def setUp(self):
        super().setUp()
        self.res = yt.run([os.path.join(FIX, "en_export")], opts())
        self.d = self.res["datasets"][0]

    def test_bom_crlf_english(self):
        t = next(f for f in self.d["files"] if f["type"] == "table")
        self.assertEqual((t["encoding"], t["language"]), ("utf-8-sig", "en"))
        self.assertEqual(self.d["headline"]["views"]["value"], 1667)
        self.assertEqual(self.d["headline"]["avg_view_duration_s"]["value"], 330)

    def test_hours_long_durations(self):
        v = next(v for v in self.d["videos"] if v["video_id"] == "SYNen000001")
        self.assertEqual(v["avg_view_duration_s"], 1445)
        self.assertEqual(v["duration_s"], 7200)
        self.assertTrue(v.get("published_before_period"))

    def test_revenue_ignored_and_unknown_reported(self):
        t = next(f for f in self.d["files"] if f["type"] == "table")
        self.assertEqual(t["ignored_sensitive_columns"], ["Estimated revenue (USD)"])
        self.assertEqual(t["unmapped_columns"], ["Stayed to watch (%)"])
        dumped = json.dumps(self.res)
        self.assertNotIn("7.38", dumped)
        self.assertNotIn("1.23", dumped)
        codes = [w["code"] for w in self.d["warnings"]]
        self.assertIn("revenue_ignored", codes)
        self.assertIn("unmapped_columns", codes)

    def test_daily_views_available_when_exported(self):
        self.assertEqual(self.d["daily"]["metrics_available"], ["Views"])
        totals = next(f for f in self.d["daily"]["files"] if f["type"] == "totals")
        self.assertEqual(len(totals["series"]["views"]["by_day"]), 14)
        self.assertFalse(any("Daily Views" in n for n in self.d["daily"]["not_available"]))

    def test_title_with_pipe_escaped_in_markdown(self):
        md = yt.to_markdown(self.res)
        self.assertIn("Reader Questions \\| Part 1", md)


class EdgeCases(TmpCase):
    def one(self, name, **kw):
        return yt.run([os.path.join(FIX, "edge", name)], opts(**kw))["datasets"][0]

    def test_decimal_comma_semicolon(self):
        d = self.one("decimal_comma_semicolon.csv")
        self.assertEqual(d["files"][0]["delimiter"], "semicolon")
        h = {k: v["value"] for k, v in d["headline"].items()}
        self.assertEqual((h["views"], h["watch_time_h"], h["ctr_pct"]), (1250, 12.5, 3.2))
        self.assertEqual([v["views"] for v in d["videos"]], [1000, 250])
        self.assertEqual(d["videos"][0]["watch_time_h"], 10.25)

    def test_no_total_row(self):
        d = self.one("no_total_row.csv")
        self.assertIn("no_total_row", [w["code"] for w in d["warnings"]])
        self.assertEqual(d["headline"]["views"]["value"], 1500)
        self.assertEqual(d["headline"]["ctr_pct"]["value"], 4.4)  # (5*4000 + 2*1000) / 5000
        fact = next(f for f in d["facts"] if f["id"] == d["headline"]["ctr_pct"]["fact"])
        self.assertIn("Estimate", fact["note"])
        self.assertEqual([v["avg_view_duration_s"] for v in d["videos"]], [65, 100, None])
        self.assertIsNone(d["videos"][2]["ctr_pct"])  # "n/a"
        self.assertEqual(d["period"]["start"], None)
        self.assertIn("period_unknown", [w["code"] for w in d["warnings"]])

    def test_period_override(self):
        d = self.one("no_total_row.csv", period_start="2026-03-01", period_end="2026-03-28")
        self.assertEqual((d["period"]["start"], d["period"]["days"]), ("2026-03-01", 28))

    def test_odd_values(self):
        d = self.one("odd_values.csv")
        codes = [w["code"] for w in d["warnings"]]
        for c in ("value_ambiguous_day_month", "value_unreadable", "duplicate_videos", "engaged_above_views"):
            self.assertIn(c, codes)
        self.assertIsNone(d["videos"][0]["published"])  # 03/04/2026
        self.assertEqual(d["videos"][1]["published"], "2026-04-25")
        self.assertEqual(d["videos"][2]["published"], "2026-10-02")  # Malay month "Okt"
        self.assertIsNone(d["videos"][1]["views"])  # "abc" -> blank, not zero

    def test_utf16_and_cp1252(self):
        src = os.path.join(FIX, "edge", "no_total_row.csv")
        with open(src, encoding="utf-8") as fh:
            text = fh.read()
        p16 = os.path.join(self.tmp, "utf16.csv")
        with open(p16, "wb") as fh:
            fh.write(text.encode("utf-16"))
        d = yt.run([p16], opts())["datasets"][0]
        self.assertEqual(d["files"][0]["encoding"], "utf-16")
        self.assertEqual(d["headline"]["views"]["value"], 1500)
        p1252 = os.path.join(self.tmp, "latin.csv")
        with open(p1252, "wb") as fh:
            fh.write(text.replace("Synthetic NT A", "Synthétique A").encode("cp1252"))
        d = yt.run([p1252], opts())["datasets"][0]
        self.assertIn("encoding_fallback", [w["code"] for w in d["warnings"]])
        self.assertEqual(d["videos"][0]["title"], "Synthétique A")

    def test_unrecognised_exit_3(self):
        r = cli(os.path.join(FIX, "edge", "unrecognised.csv"))
        self.assertEqual(r.returncode, 3)
        self.assertIn(b"no YouTube Studio export columns", r.stderr)

    def test_value_parsers(self):
        self.assertEqual(yt.parse_duration("0:01:02"), (62.0, None))
        self.assertEqual(yt.parse_duration("1:02:03"), (3723.0, None))
        self.assertEqual(yt.parse_duration("")[0], None)
        self.assertEqual(yt.parse_number("12%", "."), (12.0, None))
        self.assertEqual(yt.parse_number("1,234", "."), (1234.0, "thousands_separator"))
        self.assertEqual(yt.parse_number("—", "."), (None, "missing"))
        self.assertEqual(yt.parse_number("1.250", "ambiguous"), (None, "unreadable"))
        self.assertEqual(yt.parse_date("Nov 2, 2026"), ("2026-11-02", None))
        self.assertEqual(yt.parse_date("2 Dis 2026"), ("2026-12-02", None))
        self.assertEqual(yt.parse_date("Feb 30, 2026"), (None, "unreadable"))


class ZipSafety(TmpCase):
    def zip_with(self, entries, name="evil.zip"):
        p = os.path.join(self.tmp, name)
        with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
            for n, data in entries:
                z.writestr(n, data)
        return p

    def table(self):
        with open(os.path.join(FIX, "ms_export", "Table data.csv"), "rb") as fh:
            return fh.read()

    def test_unsafe_entries_skipped_and_nothing_extracted(self):
        p = self.zip_with([("../escape.csv", b"Content,Views\nX,1\n"), ("/abs.csv", b"a"), ("Table data.csv", self.table()),
                           ("inner.zip", b"PK"), ("notes.txt", b"hi"), ("__MACOSX/._Table data.csv", b"junk")])
        before = set(os.listdir(self.tmp))
        res = yt.run([p], opts())
        codes = [w["code"] for w in res["warnings"]]
        self.assertEqual(codes.count("unsafe_member_name"), 2)
        self.assertIn("nested_zip", codes)
        self.assertIn("ignored_file", codes)
        self.assertEqual([f["name"] for f in res["datasets"][0]["files"]], ["Table data.csv"])
        self.assertEqual(set(os.listdir(self.tmp)), before)
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.tmp), "escape.csv")))

    def test_zip_bomb_refused(self):
        p = self.zip_with([("Table data.csv", b"0" * (3 * 1024 * 1024))])
        r = cli(p)
        self.assertEqual(r.returncode, 2)
        self.assertIn(b"compression ratio", r.stderr)

    def test_too_many_entries(self):
        p = self.zip_with([(f"f{i}.csv", b"a") for i in range(yt.MAX_INPUT_FILES + 1)])
        r = cli(p)
        self.assertEqual(r.returncode, 2)
        self.assertIn(b"entries", r.stderr)

    def test_encrypted_entry_refused(self):
        p = os.path.join(self.tmp, "locked.zip")
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("Table data.csv", b"Content,Views\n")
        # zipfile can't write encrypted entries; set the "encrypted" flag bit in both headers.
        with open(p, "rb") as fh:
            data = bytearray(fh.read())
        local, central = data.find(b"PK\x03\x04"), data.find(b"PK\x01\x02")
        data[local + 6] |= 0x1
        data[central + 8] |= 0x1
        with open(p, "wb") as fh:
            fh.write(data)
        r = cli(p)
        self.assertEqual(r.returncode, 2)
        self.assertIn(b"password-protected", r.stderr)

    def test_not_a_zip_and_missing_file(self):
        bad = os.path.join(self.tmp, "fake.zip")
        with open(bad, "wb") as fh:
            fh.write(b"not a zip")
        self.assertEqual(cli(bad).returncode, 2)
        self.assertEqual(cli(os.path.join(self.tmp, "nope.zip")).returncode, 2)
        self.assertEqual(cli().returncode, 2)


class CommandLine(TmpCase):
    def test_selftest_direct_and_piped(self):
        r = cli("--selftest")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(SCRIPT, "rb") as fh:
            src = fh.read()
        r = cli("--selftest", stdin=src)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(b"selftest passed", r.stdout)

    def test_piped_analysis_matches_direct(self):
        zp = make_zip(os.path.join(self.tmp, "Content_2026-01-01_2026-01-29_Synthetic.zip"), os.path.join(FIX, "ms_export"))
        with open(SCRIPT, "rb") as fh:
            src = fh.read()
        direct, piped = cli(zp), cli(zp, stdin=src)
        self.assertEqual(direct.returncode, 0, direct.stderr)
        self.assertEqual(direct.stdout, piped.stdout)
        self.assertEqual(cli(zp).stdout, direct.stdout, "output must be deterministic")

    def test_damaged_copy_refuses_to_run(self):
        with open(SCRIPT, encoding="utf-8") as fh:
            src = fh.read()
        damaged = src.replace("return float(s), None\n    if decimal in", "return float(s) * 10, None\n    if decimal in", 1)
        self.assertNotEqual(damaged, src)
        r = cli(os.path.join(FIX, "ms_export"), stdin=damaged.encode())
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertEqual(r.stdout, b"")

    def test_out_writes_only_two_files(self):
        out = os.path.join(self.tmp, "out")
        r = cli(os.path.join(FIX, "ms_export"), "--out", out, cwd=self.tmp)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(os.listdir(self.tmp)), ["out"])
        self.assertEqual(sorted(os.listdir(out)), ["audit_data.json", "audit_facts.md"])
        with open(os.path.join(out, "audit_data.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["tool"]["selftest"], "passed")

    def test_bad_period_arguments(self):
        f = os.path.join(FIX, "ms_export")
        self.assertEqual(cli(f, "--period-start", "2026-13-01", "--period-end", "2026-12-01").returncode, 2)
        self.assertEqual(cli(f, "--period-start", "2026-01-01").returncode, 2)


class StaticChecks(unittest.TestCase):
    def test_script_is_standard_library_and_offline(self):
        with open(SCRIPT, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        mods = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                mods.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                mods.add(node.module.split(".")[0])
        allowed = {"__future__", "argparse", "csv", "datetime", "hashlib", "io", "json", "os", "re", "statistics", "sys",
                   "unicodedata", "zipfile", "tempfile"}
        self.assertEqual(mods - allowed, set())
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        for forbidden in ("__file__", "eval", "exec", "system", "popen", "extractall", "urlopen", "remove", "rmtree", "unlink"):
            self.assertNotIn(forbidden, names, forbidden)

    def test_column_mapping_doc_matches_script(self):
        with open(os.path.join(SKILL, "references", "column-mapping.md"), encoding="utf-8") as fh:
            doc = fh.read()
        rows = set(re.findall(r"^\| `(\w+)` \| ([^|]+?) \| (en|ms) \| (seen|expected|guess) \|$", doc, re.M))
        script = {(k, h, l, c) for k, _, _, _, al in yt.COLUMNS for h, l, c in al}
        self.assertEqual(rows, script)

    def test_skill_frontmatter(self):
        with open(os.path.join(SKILL, "SKILL.md"), encoding="utf-8") as fh:
            text = fh.read()
        m = re.match(r"^---\nname: (.+)\ndescription: (.+)\n---\n", text)
        self.assertIsNotNone(m)
        self.assertEqual(m[1], os.path.basename(SKILL))
        self.assertLessEqual(len(m[2]), 1024)
        self.assertNotIn(":", m[2].replace("e.g.", ""), "unquoted colon would break YAML")
        for ref in re.findall(r"`((?:references|examples|scripts)/[^`]+)`", text):
            self.assertTrue(os.path.exists(os.path.join(SKILL, ref)), ref)


class ReleaseZip(TmpCase):
    def test_build_is_clean(self):
        builder = os.path.join(REPO, "scripts", "build-csv-skill-zip.py")
        out = os.path.join(self.tmp, "skill.zip")
        r = subprocess.run([sys.executable, "-I", builder, "--out", out], capture_output=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with zipfile.ZipFile(out) as z:
            names = z.namelist()
            tops = {n.split("/")[0] for n in names}
            self.assertEqual(tops, {"youtube-csv-audit"})
            self.assertIn("youtube-csv-audit/SKILL.md", names)
            self.assertIn("youtube-csv-audit/scripts/yt_csv_audit.py", names)
            for n in names:
                self.assertFalse(re.search(r"(^|/)(tests|__pycache__)/|\.(csv|zip|json|pyc)$", n), n)
                z.read(n).decode("utf-8")  # text only
            mode = (z.getinfo("youtube-csv-audit/scripts/yt_csv_audit.py").external_attr >> 16) & 0o777
            self.assertEqual(mode, 0o755)
            with open(SCRIPT, "rb") as fh:
                self.assertEqual(z.read("youtube-csv-audit/scripts/yt_csv_audit.py"), fh.read())
        out2 = os.path.join(self.tmp, "skill2.zip")
        subprocess.run([sys.executable, "-I", builder, "--out", out2], check=True, capture_output=True, timeout=120)
        with zipfile.ZipFile(out) as a, zipfile.ZipFile(out2) as b:
            self.assertEqual([(i.filename, i.CRC, i.date_time) for i in a.infolist()], [(i.filename, i.CRC, i.date_time) for i in b.infolist()])

    def test_committed_release_matches_sources(self):
        """release/youtube-csv-audit-<version>.zip must be rebuilt whenever a shipped file changes."""
        committed = os.path.join(REPO, "release", f"youtube-csv-audit-{yt.VERSION}.zip")
        self.assertTrue(os.path.exists(committed), "run: python3 scripts/build-csv-skill-zip.py")
        fresh = os.path.join(self.tmp, "fresh.zip")
        builder = os.path.join(REPO, "scripts", "build-csv-skill-zip.py")
        subprocess.run([sys.executable, "-I", builder, "--out", fresh], check=True, capture_output=True, timeout=120)
        with zipfile.ZipFile(committed) as a, zipfile.ZipFile(fresh) as b:
            self.assertEqual([(i.filename, i.CRC) for i in a.infolist()], [(i.filename, i.CRC) for i in b.infolist()],
                             "release ZIP is stale: run python3 scripts/build-csv-skill-zip.py")

    def test_deny_list_blocks_private_strings(self):
        builder = os.path.join(REPO, "scripts", "build-csv-skill-zip.py")
        deny = os.path.join(self.tmp, "deny.txt")
        with open(deny, "w", encoding="utf-8") as fh:
            fh.write("Synthetic Example Channel\n")  # appears in the sample report
        r = subprocess.run([sys.executable, "-I", builder, "--out", os.path.join(self.tmp, "x.zip"), "--deny-list", deny],
                           capture_output=True, timeout=120)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"deny-listed", r.stderr)


if __name__ == "__main__":
    unittest.main()
