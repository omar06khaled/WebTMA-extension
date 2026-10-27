"""Checks the database enforces the user-story rules. Run it ONLY on a throwaway copy:
it adds test users and publishes test releases.

    python db/setup.py --dsn $TEST_DSN --workbook ... --admin test_admin --admin-name Test
    python db/test_rules.py --dsn $TEST_DSN

Every action runs as the website's database role (deskmanual_app) with a signed-in user,
the same way the app will call it. Prints one line per rule and exits non-zero on a failure.
"""

import argparse
import os
import sys

import psycopg
from psycopg.types.json import Jsonb

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))


class DB:
    def __init__(self, dsn):
        self.conn = psycopg.connect(dsn, autocommit=True)

    def as_(self, user, sql, params=(), role="deskmanual_app"):
        """One transaction as `user` through the app's role. Returns rows, or raises."""
        with self.conn.transaction():
            cur = self.conn.cursor()
            cur.execute(f"SET LOCAL ROLE {role}")
            if user:
                cur.execute("SELECT set_config('app.asurite', %s, true)", (user,))
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else None

    def fails(self, user, sql, params=(), role="deskmanual_app", expect=""):
        try:
            self.as_(user, sql, params, role)
        except psycopg.Error as e:
            msg = str(e).split("\n")[0]
            return (expect.lower() in msg.lower(), msg)
        return (False, "it was allowed")

    def owner(self, sql, params=None):
        cur = self.conn.execute(sql, params)
        return cur.fetchall() if cur.description else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default=os.environ.get("TEST_DSN"))
    args = ap.parse_args()
    db = DB(args.dsn)

    admin = db.owner("SELECT asurite FROM app_user WHERE role = 'admin' ORDER BY created_at LIMIT 1")[0][0]
    for u in ("t_ed1", "t_ed2", "t_ap1", "t_ap2", "t_mgr", "t_disp"):
        db.as_(None, "SELECT ensure_user(%s, %s)", (u, u))
    for u, r in (("t_ed1", "editor"), ("t_ed2", "editor"), ("t_ap1", "approver"), ("t_ap2", "approver"),
                 ("t_mgr", "manager")):
        db.as_(admin, "SELECT set_role(%s, %s)", (u, r))
    zone = db.owner("SELECT code FROM staging.zone WHERE code = 'ACAD A'")[0][0]

    print("\nSign-in and identity")
    ok, msg = db.fails(None, "SELECT submit_change('zone', %s, 'update', %s)",
                       (Jsonb({"code": zone}), Jsonb({"notes": "x"})), expect="no signed-in user")
    check("nothing works without a signed-in user", ok, msg)
    check("first sign-in creates a dispatcher (viewer)",
          db.owner("SELECT role FROM app_user WHERE asurite = 't_disp'")[0][0] == "viewer")
    ok, msg = db.fails("t_disp", "SELECT submit_change('zone', %s, 'update', %s)",
                       (Jsonb({"code": zone}), Jsonb({"notes": "x"})), expect="can't do this")
    check("a dispatcher can't propose edits", ok, msg)

    print("\nNo back doors (security audit)")
    for sql, what in (("UPDATE staging.zone SET notes = 'x'", "write staging directly"),
                      ("INSERT INTO live.trade (code) VALUES ('X')", "write live directly"),
                      ("DELETE FROM change_log", "delete the change log"),
                      ("UPDATE release SET note = 'x'", "edit a release"),
                      ("SELECT load_live('{}'::jsonb)", "call load_live"),
                      ("SELECT bootstrap_publish('x')", "call bootstrap_publish")):
        ok, msg = db.fails("t_ap1", sql, expect="permission denied")
        check(f"the app can't {what}", ok, msg)
    for sql, what in (("DELETE FROM change_log", "change_log can't be deleted"),
                      ("TRUNCATE change_log", "change_log can't be truncated"),
                      ("TRUNCATE staging.zone CASCADE", "staging can't be truncated"),
                      ("DELETE FROM staging.zone WHERE code = 'ACAD A'", "staging rows can't be deleted"),
                      ("DELETE FROM release", "releases can't be deleted"),
                      ("UPDATE release SET note = 'x'", "releases can't be edited")):
        try:
            with db.conn.transaction():
                db.conn.execute(sql)
            check(f"even the owner: {what}", False, "it was allowed")
        except psycopg.Error:
            check(f"even the owner: {what}", True)
    ok, msg = db.fails(None, "SELECT * FROM staging.zone", role="deskmanual_reader", expect="permission denied")
    check("the assistant can't read staging", ok, msg)
    n = db.as_(None, "SELECT count(*) FROM live.routing_lookup", role="deskmanual_reader")[0][0]
    check("the assistant can read the published manual", n > 0)

    print("\nPeer review (decision A, stories 2.2-2.6)")
    r1 = db.as_("t_ed1", "SELECT submit_change('zone', %s, 'update', %s, 'test note')",
                (Jsonb({"code": zone}), Jsonb({"notes": "Test: supervisor changed"})))[0][0]
    ok, msg = db.fails("t_ed1", "SELECT approve_change(%s)", (r1,), expect="own request")
    check("an editor can't approve their own request", ok, msg)
    ok, msg = db.fails("t_ed2", "SELECT deny_change(%s, '')", (r1,), expect="needs a reason")
    check("a denial needs a reason", ok, msg)
    db.as_("t_ed2", "SELECT deny_change(%s, 'Wrong zone')", (r1,))
    ok, msg = db.fails("t_ed2", "SELECT appeal_change(%s, 'pls')", (r1,), expect="only the author")
    check("only the author can appeal", ok, msg)
    db.as_("t_ed1", "SELECT appeal_change(%s, 'Checked with Michael, it is right')", (r1,))
    check("an appeal resubmits it", db.owner("SELECT status FROM change_request WHERE id = %s", (r1,))[0][0] == "pending")
    db.as_("t_ed2", "SELECT approve_change(%s, 'ok after appeal')", (r1,))
    notes = db.owner("SELECT notes FROM staging.zone WHERE code = %s", (zone,))[0][0]
    check("another editor's approval lands it in the next version", notes == "Test: supervisor changed")
    live_notes = db.owner("SELECT notes FROM live.zone WHERE code = %s", (zone,))[0][0]
    check("dispatchers don't see it until it's published", live_notes != notes)
    logged = db.owner("SELECT count(*) FROM change_log WHERE request_id = %s", (r1,))[0][0]
    check("the change log ties the edit to its request", logged == 1)
    events = [e for (e,) in db.owner("SELECT event FROM change_request_event WHERE request_id = %s ORDER BY id", (r1,))]
    check("every step is kept", events == ["submitted", "denied", "appealed", "approved"], str(events))

    r2 = db.as_("t_ed1", "SELECT submit_change('zone', %s, 'update', %s)", (Jsonb({"code": zone}), Jsonb({"notes": "A"})))[0][0]
    r3 = db.as_("t_ed2", "SELECT submit_change('zone', %s, 'update', %s)", (Jsonb({"code": zone}), Jsonb({"notes": "B"})))[0][0]
    clash = db.as_("t_ed2", "SELECT requested_by FROM conflicts_for('zone', %s, %s)", (Jsonb({"code": zone}), r3))
    check("a second editor is warned about the first one's pending edit (decision B)", clash == [("t_ed1",)])
    db.as_("t_ap1", "SELECT deny_change(%s, 'duplicate')", (r3,))
    db.as_("t_ap1", "SELECT reopen_change(%s, 'my mistake')", (r3,))
    check("a reviewer can reopen a denial", db.owner("SELECT status FROM change_request WHERE id = %s", (r3,))[0][0] == "pending")
    db.as_("t_ed1", "SELECT withdraw_change(%s)", (r2,))
    db.as_("t_ed2", "SELECT withdraw_change(%s)", (r3,))
    ok, msg = db.fails("t_ed1", "SELECT submit_change('zone', %s, 'update', %s)",
                       (Jsonb({"code": zone}), Jsonb({"updated_by": "someone"})), expect="not editable")
    check("nobody can forge who made a change", ok, msg)

    print("\nLinked contacts and who to call (stories 2.7, 3.2, 4.1-4.5)")
    def via_request(table, action, proposed, row_key=None):
        rid = db.as_("t_ed1", "SELECT submit_change(%s, %s, %s, %s)",
                     (table, Jsonb(row_key) if row_key else None, action, Jsonb(proposed)))[0][0]
        db.as_("t_ed2", "SELECT approve_change(%s)", (rid,))
        return rid
    via_request("contact", "insert", {"name": "Test Supervisor", "title": "Zone supervisor"})
    cid = db.owner("SELECT id FROM staging.contact WHERE name = 'Test Supervisor'")[0][0]
    via_request("contact_method", "insert", {"contact_id": cid, "kind": "desk", "value": "480-000-0001"})
    via_request("contact_method", "insert", {"contact_id": cid, "kind": "cell", "value": "480-000-0002"})
    via_request("contact_link", "insert", {"target_table": "zone", "target_key": zone, "contact_id": cid, "role": "supervisor"})
    via_request("contact", "insert", {"name": "Test OnCall A"})
    via_request("contact", "insert", {"name": "Test OnCall B"})
    a, b = (r[0] for r in db.owner("SELECT id FROM staging.contact WHERE name LIKE 'Test OnCall%' ORDER BY name"))
    via_request("rotation", "insert", {"name": "Test after-hours", "period_days": 14,
                                       "anchor_date": db.owner("SELECT phx_today() - 15")[0][0].isoformat()})
    rot = db.owner("SELECT id FROM staging.rotation WHERE name = 'Test after-hours'")[0][0]
    via_request("rotation_slot", "insert", {"rotation_id": rot, "position": 1, "contact_id": a})
    via_request("rotation_slot", "insert", {"rotation_id": rot, "position": 2, "contact_id": b})
    via_request("contact_link", "insert", {"target_table": "zone", "target_key": zone, "rotation_id": rot, "role": "on_call"})
    via_request("contact_link", "insert", {"target_table": "zone", "target_key": "NO-SUCH-ZONE", "contact_id": cid, "role": "info"})
    errs = [d for s, n, d in db.as_("t_ap1", "SELECT * FROM release_checks()") if s == "error"]
    check("a link to an entry that doesn't exist blocks publishing", any("NO-SUCH-ZONE" in d for d in errs), str(errs))
    bad = db.owner("SELECT id FROM staging.contact_link WHERE target_key = 'NO-SUCH-ZONE'")[0][0]
    via_request("contact_link", "retire", {}, {"id": bad})
    check("retiring the bad link clears the error",
          not [1 for s, *_ in db.as_("t_ap1", "SELECT * FROM release_checks()") if s == "error"])

    print("\nTwo sign-offs to publish or roll back (stories 6.1-6.7)")
    live_before = db.owner("SELECT version FROM release WHERE is_live")[0][0]
    rr = db.as_("t_ap1", "SELECT request_publish('Test release', 'v-test')")[0][0]
    ok, msg = db.fails("t_ap1", "SELECT confirm_release(%s)", (rr,), expect="second approver")
    check("the approver who asked can't confirm their own publish", ok, msg)
    ok, msg = db.fails("t_ed1", "SELECT confirm_release(%s)", (rr,), expect="can't do this")
    check("an editor can't confirm a publish", ok, msg)
    sneak = db.as_("t_ed1", "SELECT submit_change('zone', %s, 'update', %s)", (Jsonb({"code": zone}), Jsonb({"notes": "late edit"})))[0][0]
    db.as_("t_ed2", "SELECT approve_change(%s)", (sneak,))
    ok, msg = db.fails("t_ap2", "SELECT confirm_release(%s)", (rr,), expect="changed after")
    check("an edit after the ask stops the confirm (B signs off on what A saw)", ok, msg)
    db.as_("t_ap2", "SELECT cancel_release_request(%s)", (rr,))
    rr = db.as_("t_ap1", "SELECT request_publish('Test release', 'v-test')")[0][0]
    v2 = db.as_("t_ap2", "SELECT confirm_release(%s)", (rr,))[0][0]
    row = db.owner("SELECT published_by, confirmed_by, label, is_live FROM release WHERE version = %s", (v2,))[0]
    check("a second approver publishes; both names are on the release", row == ("t_ap1", "t_ap2", "v-test", True), str(row))
    n = db.owner("SELECT count(*) FROM change_request WHERE released_in = %s", (v2,))[0][0]
    check("the release lists the changes in it", n >= 12, str(n))

    who = db.as_("t_disp", "SELECT role, name, best_number, in_hours FROM live.who_to_call "
                           "WHERE target_table = 'zone' AND target_key = %s ORDER BY role, sort_order", (zone,))
    sup = [w for w in who if w[0] == "supervisor"]
    check("the zone supervisor shows with the cell number first", sup and sup[0][2] == "480-000-0002", str(who))
    oncall = [w[1] for w in who if w[0] == "on_call"]
    check("the rotation resolves to whoever is on this period", oncall == ["Test OnCall B"], str(oncall))
    db.as_("t_ed1", "SELECT mark_unavailable(%s, 'out sick')", (cid,))
    off = db.as_("t_disp", "SELECT off_today FROM live.who_to_call WHERE contact_id = %s", (cid,))
    check("'off today' shows at once, without a release", off == [(True,)], str(off))

    ok, msg = db.fails("t_ap1", "SELECT request_rollback(%s, 'undo test')", (v2,), expect="already live")
    check("you can't roll back to the version that's already live", ok, msg)
    rb = db.as_("t_ap1", "SELECT request_rollback(%s, 'undo test')", (live_before,))[0][0]
    ok, msg = db.fails("t_ap1", "SELECT confirm_release(%s)", (rb,), expect="second approver")
    check("a rollback also needs a second approver", ok, msg)
    db.as_("t_ap2", "SELECT confirm_release(%s)", (rb,))
    now_live = db.owner("SELECT version FROM release WHERE is_live")[0][0]
    check("rollback makes the older version live", now_live == live_before)
    n_after = db.owner("SELECT count(*) FROM live.contact WHERE name LIKE 'Test %'")[0][0]
    check("the rolled-back version no longer has the test contacts", n_after == 0, str(n_after))
    check("staging keeps the edits for fixing", db.owner("SELECT count(*) FROM staging.contact WHERE name LIKE 'Test %'")[0][0] == 3)
    ev = db.owner("SELECT event FROM release_event ORDER BY id DESC LIMIT 1")[0][0]
    check("the rollback is itself recorded", ev == "rolled_back")

    print("\nRights and the activity log (stories 7.3, 7.4)")
    ok, msg = db.fails("t_mgr", "SELECT set_role('t_disp', 'admin')", expect="only an admin")
    check("a manager can't make admins", ok, msg)
    ok, msg = db.fails("t_mgr", "SELECT set_role('t_mgr', 'admin')", expect="your own role")
    check("nobody changes their own role", ok, msg)
    db.as_("t_mgr", "SELECT set_role('t_disp', 'editor', true, 'covering for Andy')")
    check("a manager grants editor rights",
          db.owner("SELECT role FROM app_user WHERE asurite = 't_disp'")[0][0] == "editor")
    acts = db.as_("t_mgr", "SELECT count(*) FROM activity WHERE who LIKE 't\\_%%'")[0][0]
    check("the activity log shows edits, reviews, releases and role changes", acts > 20, str(acts))

    print("\nFlags (stories 2.8, 3.3)")
    ok, msg = db.fails("t_disp", "SELECT flag_entry(' ', 'wrong trade')", expect="")
    check("a flag needs a WO number", ok, msg)
    fid = db.as_("t_disp", "SELECT flag_entry('WO-123', 'Lighting went to JANI', 'task', '1')")[0][0]
    ok, msg = db.fails("t_ed1", "SELECT resolve_flag(%s, 'fixed', '')", (fid,), expect="")
    check("closing a flag needs a note", ok, msg)
    db.as_("t_ed1", "SELECT resolve_flag(%s, 'fixed', 'routing corrected in request 12')", (fid,))
    check("an editor closes it with a note", db.owner("SELECT status FROM manual_flag WHERE id = %s", (fid,))[0][0] == "fixed")

    failed = results.count(False)
    print(f"\n{len(results) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
