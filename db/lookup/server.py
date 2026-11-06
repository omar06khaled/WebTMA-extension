"""Local, read-only dispatch lookup: pick a task and a building, see who gets the call.

    python db/lookup/server.py --dsn "postgresql://user@127.0.0.1:5432/deskmanual"   ->  http://127.0.0.1:8765

Reads the published (live) version only. Listens on 127.0.0.1 only, and every query runs in a
read-only transaction. DATABASE_URL works instead of --dsn. Requires: pip install "psycopg[binary]"
"""
import argparse
import json
import os
import sys
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import psycopg
from psycopg.rows import dict_row

DSN = None  # set from --dsn in main()
PAGE = Path(__file__).with_name("index.html")
CAMPUSES = ["dtpc", "poly", "tempe", "west"]


def query(sql, params=()):
    with psycopg.connect(DSN, row_factory=dict_row) as conn:
        conn.read_only = True
        return conn.execute(sql, params).fetchall()


def general_notes():
    rows = query("SELECT body_md FROM live.article WHERE title = 'General dispatch notes'")
    if not rows:
        return {}
    sections = re.split(r"^### After (.+)$", rows[0]["body_md"], flags=re.M)
    return {sections[i].strip(): sections[i + 1].strip() for i in range(1, len(sections) - 1, 2)}


def tasks(q):
    return query(
        "SELECT DISTINCT task_code, description, category FROM live.routing_lookup "
        "WHERE description ILIKE %s OR task_code::text LIKE %s OR category ILIKE %s "
        "ORDER BY category, description LIMIT 40", (f"%{q}%", f"{q}%", f"%{q}%"))


def buildings(q):
    return query(
        "SELECT code, name, campus_code FROM live.building_lookup "
        "WHERE code ILIKE %s OR name ILIKE %s ORDER BY (code ILIKE %s) DESC, code LIMIT 25",
        (f"{q}%", f"%{q}%", q))


def route(task, category, building, campus):
    # The same description can sit in two categories (Garbage Disposal, Mold check), so both pick the task.
    rules = query("SELECT * FROM live.routing_lookup WHERE description = %s AND category = %s "
                  "ORDER BY is_rfmt, array_position(%s::text[], campus_code)", (task, category, CAMPUSES))
    if not rules:
        return {"error": f"No task called {task!r} in {category!r}."}
    b = None
    if building:
        found = query("SELECT * FROM live.building_lookup WHERE code = %s", (building,))
        if not found:
            return {"error": f"No building with code {building!r}."}
        b = found[0]
        b["notes"] = [r["note"] for r in query(
            "SELECT n.note FROM live.building_note n JOIN live.building bb ON bb.id = n.building_id "
            "WHERE bb.code = %s AND n.active ORDER BY n.id", (building,))]
        campus = b["campus_code"] or campus
    answers = []
    for r in rules:
        if campus and r["campus_code"] != campus:
            continue
        a = {"is_rfmt": r["is_rfmt"], "campus": r["campus_code"], "kind": r["kind"],
             "trade": r["trade_code"], "instruction": r["instruction"], "zone_options": r["zone_options"]}
        if r["kind"] == "zone" and b:
            mine = (b["rfmt_zones"] if r["is_rfmt"] else b["regular_zones"]) or []
            a["zones"] = [z for z in mine if z in (r["zone_options"] or [])] or mine
        answers.append(a)
    first = rules[0]
    return {"task": {"code": first["task_code"], "description": first["description"],
                     "category": first["category"], "notes": first["notes"],
                     "section_note": first["section_note"], "custodial": first["custodial"]},
            "building": b, "campus": campus, "answers": answers, "grid": rules,
            "general_note": general_notes().get(first["category"])}


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        p = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/":
                return self.send(200, PAGE.read_bytes(), "text/html")
            if url.path == "/api/tasks":
                return self.send(200, tasks(p.get("q", "")))
            if url.path == "/api/buildings":
                return self.send(200, buildings(p.get("q", "")))
            if url.path == "/api/route":
                return self.send(200, route(p.get("task", ""), p.get("category", ""), p.get("building"), p.get("campus")))
            if url.path == "/api/stats":
                return self.send(200, query(
                    "SELECT (SELECT max(version) FROM public.release WHERE is_live) AS version, "
                    "(SELECT count(*) FROM live.building) AS buildings, "
                    "(SELECT count(DISTINCT description) FROM live.routing_lookup) AS tasks")[0])
            self.send(404, {"error": "not found"})
        except psycopg.OperationalError:
            self.send(503, {"error": "Can't reach the database. Is Postgres running?"})

    def log_message(self, *args):
        pass


def main():
    global DSN
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    if not args.dsn:
        sys.exit("Give --dsn or set DATABASE_URL")
    DSN = args.dsn
    print(f"Dispatch lookup on http://127.0.0.1:{args.port}")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
