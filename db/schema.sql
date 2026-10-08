-- Desk manual database (PostgreSQL 15+)
--
-- Decisions this follows (agreed Oct 2026):
--   1  every building has a hidden id; its building code is unique
--   2  a building can sit in several zones (building_zone link table)
--   3  every task has a hidden id; the WebTMA task code can repeat or be blank
--   4  routing: one row per task x campus x regular/RFMT, with an explicit kind
--   5  nothing is deleted; rows are retired (active = false)
--   6  roles: viewer / editor / approver / admin
--   7  edits go: proposed -> approved -> staging ("next version") -> checks -> published release.
--      An approver publishes by hand. Any release can be rolled back.
--   8  every change to staging is logged automatically
--
-- Three schemas:
--   public   shared things: campus, users, change requests, change log, releases
--   staging  the "next version". Approved edits land here. Never read by the assistant.
--   live     the published version. Read-only copy the assistant reads. Only publish()
--            and rollback() write to it.

BEGIN;

CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS live;

-- ================================================================ public: shared
CREATE TABLE public.app_user (
    asurite       text PRIMARY KEY,                 -- ASU login from CAS
    display_name  text NOT NULL,
    role          text NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer', 'editor', 'approver', 'admin')),
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Campuses almost never change, so they are not versioned.
CREATE TABLE public.campus (
    code  text PRIMARY KEY CHECK (code IN ('dtpc', 'poly', 'tempe', 'west')),
    name  text NOT NULL
);

-- Step 1-2 of decision 7: an editor proposes, an approver accepts or rejects.
-- Accepting applies the change to staging (done by the editor app, which sets updated_by).
CREATE TABLE public.change_request (
    id            bigserial PRIMARY KEY,
    table_name    text NOT NULL,                    -- e.g. 'routing_rule'
    row_key       jsonb,                            -- which row; null for a new row
    action        text NOT NULL CHECK (action IN ('insert', 'update', 'retire', 'restore')),
    proposed      jsonb NOT NULL,                   -- the new values
    reason        text,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
    requested_by  text NOT NULL REFERENCES public.app_user(asurite),
    requested_at  timestamptz NOT NULL DEFAULT now(),
    reviewed_by   text REFERENCES public.app_user(asurite),
    reviewed_at   timestamptz,
    review_note   text,
    CHECK (status = 'pending' OR reviewed_by IS NOT NULL)
);

-- Decision 8: filled by a trigger on every staging table, so nothing can skip it.
CREATE TABLE public.change_log (
    id          bigserial PRIMARY KEY,
    table_name  text NOT NULL,
    action      text NOT NULL,                      -- INSERT / UPDATE / DELETE
    old_row     jsonb,
    new_row     jsonb,
    changed_by  text,
    changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_table_idx ON public.change_log (table_name, changed_at DESC);

-- Decision 7: one row per published version, holding a full copy of the manual at that moment.
-- The whole manual is a few thousand rows, so keeping every version is cheap.
CREATE TABLE public.release (
    version       serial PRIMARY KEY,               -- v1, v2, v3 ...
    published_at  timestamptz NOT NULL DEFAULT now(),
    published_by  text NOT NULL REFERENCES public.app_user(asurite),
    note          text,                             -- "Oct 22: Lock Shop changes"
    eval_score    numeric,                          -- share of the eval_cases.json tests passed
    checks        jsonb NOT NULL DEFAULT '[]',      -- warnings that were present at publish
    snapshot      jsonb NOT NULL,                   -- every staging table, as JSON
    is_live       boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_live_release ON public.release (is_live) WHERE is_live;

-- ================================================================ staging: the next version
CREATE TABLE staging.zone (
    code         text PRIMARY KEY,                  -- "ACAD A", "POLY-A01", "RFMT-ZONE-1"
    campus_code  text REFERENCES public.campus(code),  -- null for DC / LA / other sites
    is_rfmt      boolean NOT NULL DEFAULT false,
    active       boolean NOT NULL DEFAULT true,
    notes        text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text REFERENCES public.app_user(asurite)
);

CREATE TABLE staging.building (
    id             serial PRIMARY KEY,              -- hidden id (decision 1)
    code           text NOT NULL UNIQUE,            -- WebTMA building code: "157A", "E835"
    name           text NOT NULL,
    campus_code    text REFERENCES public.campus(code),
    rate_schedule  text,                            -- "CM", "CB", "CM/CB"
    subtype        text,                            -- "Residential Facilities"
    address        text,
    active         boolean NOT NULL DEFAULT true,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     text REFERENCES public.app_user(asurite)
);

-- Decision 2: one row per building-zone pair.
CREATE TABLE staging.building_zone (
    building_id  int  NOT NULL REFERENCES staging.building(id),
    zone_code    text NOT NULL REFERENCES staging.zone(code) ON UPDATE CASCADE,
    note         text,                              -- replaces meaning that lived in highlighting
    active       boolean NOT NULL DEFAULT true,     -- false = building taken out of this zone
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text REFERENCES public.app_user(asurite),
    PRIMARY KEY (building_id, zone_code)
);

CREATE TABLE staging.building_note (
    id           serial PRIMARY KEY,
    building_id  int  NOT NULL REFERENCES staging.building(id),
    note         text NOT NULL,
    active       boolean NOT NULL DEFAULT true,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text REFERENCES public.app_user(asurite)
);

-- Anything a work order can go to that isn't a zone: JANI, LOCK, CAPSTONE, RFMT-HVAC ...
CREATE TABLE staging.trade (
    code        text PRIMARY KEY,
    is_global   boolean NOT NULL DEFAULT false,     -- "(Global)" trades serve every campus
    active      boolean NOT NULL DEFAULT true,
    notes       text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text REFERENCES public.app_user(asurite)
);

CREATE TABLE staging.task_category (
    id            serial PRIMARY KEY,
    name          text NOT NULL UNIQUE,             -- "Plumbing", "Lock Shop"
    section_note  text,                             -- applies to every task in it
    sort_order    int  NOT NULL DEFAULT 0,
    active        boolean NOT NULL DEFAULT true,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text REFERENCES public.app_user(asurite)
);

-- Decision 3: hidden id; task_code is a plain field.
CREATE TABLE staging.task (
    id           serial PRIMARY KEY,
    task_code    int,                               -- WebTMA task code; can repeat or be blank
    description  text NOT NULL,                     -- "Plumbing - GENERAL"
    category_id  int  NOT NULL REFERENCES staging.task_category(id),
    custodial    boolean NOT NULL DEFAULT false,
    notes        text,
    sort_order   int  NOT NULL DEFAULT 0,
    active       boolean NOT NULL DEFAULT true,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text REFERENCES public.app_user(asurite),
    UNIQUE (category_id, description)
);
CREATE INDEX task_code_idx ON staging.task (task_code);

-- Decision 4: one row per cell of the 8 trade columns.
--   zone         send to the building's zone (options come from the zone table)
--   trade        send to trade_code
--   see_note     the task notes say what to do
--   not_handled  the cell is blank in the manual: this campus doesn't do it
CREATE TABLE staging.routing_rule (
    task_id      int     NOT NULL REFERENCES staging.task(id),
    campus_code  text    NOT NULL REFERENCES public.campus(code),
    is_rfmt      boolean NOT NULL,
    kind         text    NOT NULL CHECK (kind IN ('zone', 'trade', 'see_note', 'not_handled')),
    trade_code   text    REFERENCES staging.trade(code) ON UPDATE CASCADE,
    instruction  text,                              -- "Check RFMT Zone Guide"
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text REFERENCES public.app_user(asurite),
    PRIMARY KEY (task_id, campus_code, is_rfmt),
    CHECK ((kind = 'trade') = (trade_code IS NOT NULL))
);

-- Prose sheets (radio protocol, SOPs, contacts ...) as pages.
CREATE TABLE staging.article (
    id            serial PRIMARY KEY,
    title         text NOT NULL,
    category      text,
    campus_code   text REFERENCES public.campus(code),   -- null = all campuses
    body_md       text NOT NULL DEFAULT '',
    source_sheet  text,                             -- original sheet name
    active        boolean NOT NULL DEFAULT true,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text REFERENCES public.app_user(asurite)
);

-- Decision 5: no deletes in staging. Retire instead (active = false).
CREATE FUNCTION staging.block_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Rows in % are retired, not deleted. Set active = false instead.', TG_TABLE_NAME;
END $$;

-- Decision 8: log every insert/update in staging.
CREATE FUNCTION staging.log_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    INSERT INTO public.change_log (table_name, action, old_row, new_row, changed_by)
    VALUES (TG_TABLE_NAME, TG_OP,
            CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
            to_jsonb(NEW),
            COALESCE(NEW.updated_by, current_setting('app.user', true), current_user));
    RETURN NEW;
END $$;

-- The tables that make up one version of the manual, in load order.
CREATE FUNCTION public.manual_tables() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
    SELECT ARRAY['zone', 'building', 'building_zone', 'building_note', 'trade',
                 'task_category', 'task', 'routing_rule', 'article']
$$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY public.manual_tables() LOOP
        EXECUTE format('CREATE TRIGGER log_change BEFORE INSERT OR UPDATE ON staging.%I
                        FOR EACH ROW EXECUTE FUNCTION staging.log_change()', t);
        -- Statement-level: one-off bulk deletes still need the trigger disabled by an admin.
        EXECUTE format('CREATE TRIGGER block_delete BEFORE DELETE ON staging.%I
                        FOR EACH ROW EXECUTE FUNCTION staging.block_delete()', t);
        -- live gets the same columns, no keys or triggers: it is only ever replaced wholesale.
        EXECUTE format('CREATE TABLE live.%I (LIKE staging.%I INCLUDING DEFAULTS)', t, t);
    END LOOP;
END $$;
-- live tables must not pick up staging's id sequences
ALTER TABLE live.building      ALTER COLUMN id DROP DEFAULT;
ALTER TABLE live.building_note ALTER COLUMN id DROP DEFAULT;
ALTER TABLE live.task_category ALTER COLUMN id DROP DEFAULT;
ALTER TABLE live.task          ALTER COLUMN id DROP DEFAULT;
ALTER TABLE live.article       ALTER COLUMN id DROP DEFAULT;

-- ================================================================ step 4: automatic checks
-- 'error' blocks publishing. 'warning' is shown to the approver but doesn't block.
CREATE FUNCTION public.release_checks()
RETURNS TABLE (severity text, check_name text, detail text)
LANGUAGE sql STABLE AS $$
    -- a rule sends work to a trade that has been retired
    SELECT 'error', 'retired trade in use',
           t.description || ' (' || r.campus_code || CASE WHEN r.is_rfmt THEN ' RFMT' ELSE '' END
           || ') -> ' || r.trade_code
    FROM staging.routing_rule r
    JOIN staging.task t   ON t.id = r.task_id AND t.active
    JOIN staging.trade tr ON tr.code = r.trade_code AND NOT tr.active
    UNION ALL
    -- an active task has lost its routing rules
    SELECT 'error', 'task has no routing', t.description
    FROM staging.task t
    WHERE t.active AND NOT EXISTS (SELECT 1 FROM staging.routing_rule r WHERE r.task_id = t.id)
    UNION ALL
    -- a "zone" rule for a campus that has no active zones to offer
    SELECT DISTINCT 'error', 'no zones for zone rule',
           r.campus_code || CASE WHEN r.is_rfmt THEN ' RFMT' ELSE '' END
    FROM staging.routing_rule r
    JOIN staging.task t ON t.id = r.task_id AND t.active
    WHERE r.kind = 'zone' AND NOT EXISTS (
        SELECT 1 FROM staging.zone z
        WHERE z.campus_code = r.campus_code AND z.is_rfmt = r.is_rfmt AND z.active)
    UNION ALL
    -- an active building is still linked to a retired zone
    SELECT 'error', 'building in retired zone', b.code || ' ' || b.name || ' -> ' || z.code
    FROM staging.building_zone bz
    JOIN staging.building b ON b.id = bz.building_id AND b.active
    JOIN staging.zone z     ON z.code = bz.zone_code AND NOT z.active
    WHERE bz.active
    UNION ALL
    -- the same WebTMA task code on two active tasks (e.g. 27070)
    SELECT 'warning', 'task code used twice',
           t.task_code || ': ' || string_agg(t.description, ' | ' ORDER BY t.description)
    FROM staging.task t WHERE t.active AND t.task_code IS NOT NULL
    GROUP BY t.task_code HAVING count(*) > 1
    UNION ALL
    -- an active building with no zone at all
    SELECT 'warning', 'building has no zone', b.code || ' ' || b.name
    FROM staging.building b
    WHERE b.active AND NOT EXISTS (SELECT 1 FROM staging.building_zone bz
                                   WHERE bz.building_id = b.id AND bz.active)
$$;

-- ================================================================ step 5: publish and roll back
-- Copies a snapshot into the live tables, replacing what is there.
CREATE FUNCTION public.load_live(p_snapshot jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text;
BEGIN
    EXECUTE 'TRUNCATE ' || (SELECT string_agg(format('live.%I', x), ', ') FROM unnest(public.manual_tables()) x);
    FOREACH t IN ARRAY public.manual_tables() LOOP
        EXECUTE format('INSERT INTO live.%I SELECT * FROM jsonb_populate_recordset(NULL::live.%I, $1 -> %L)', t, t, t)
        USING p_snapshot;
    END LOOP;
END $$;

CREATE FUNCTION public.require_approver(p_user text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.app_user
                   WHERE asurite = p_user AND active AND role IN ('approver', 'admin')) THEN
        RAISE EXCEPTION '% is not an approver', p_user;
    END IF;
END $$;

-- Decision 7: an approver publishes by hand. Blocked if any check is an error.
-- p_eval_score: the editor app runs eval_cases.json against staging first and passes the result.
CREATE FUNCTION public.publish(p_user text, p_note text, p_eval_score numeric DEFAULT NULL)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
    v_errors   jsonb;
    v_warnings jsonb;
    v_snapshot jsonb := '{}';
    v_version  int;
    t          text;
BEGIN
    PERFORM public.require_approver(p_user);

    SELECT jsonb_agg(c) FILTER (WHERE c.severity = 'error'),
           COALESCE(jsonb_agg(c) FILTER (WHERE c.severity = 'warning'), '[]')
    INTO v_errors, v_warnings
    FROM public.release_checks() c;
    IF v_errors IS NOT NULL THEN
        RAISE EXCEPTION 'Publish blocked by % check error(s): %', jsonb_array_length(v_errors), v_errors;
    END IF;

    FOREACH t IN ARRAY public.manual_tables() LOOP
        EXECUTE format('SELECT $1 || jsonb_build_object(%L, COALESCE((SELECT jsonb_agg(x) FROM staging.%I x), ''[]''))', t, t)
        INTO v_snapshot USING v_snapshot;
    END LOOP;

    PERFORM public.load_live(v_snapshot);
    UPDATE public.release SET is_live = false WHERE is_live;
    INSERT INTO public.release (published_by, note, eval_score, checks, snapshot, is_live)
    VALUES (p_user, p_note, p_eval_score, v_warnings, v_snapshot, true)
    RETURNING version INTO v_version;
    RETURN v_version;
END $$;

-- Makes an older release live again. Staging is untouched, so the edits from the bad
-- release stay in the next version to be fixed.
CREATE FUNCTION public.rollback_to(p_user text, p_version int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_snapshot jsonb;
BEGIN
    PERFORM public.require_approver(p_user);
    SELECT snapshot INTO v_snapshot FROM public.release WHERE version = p_version;
    IF v_snapshot IS NULL THEN
        RAISE EXCEPTION 'No release v%', p_version;
    END IF;
    PERFORM public.load_live(v_snapshot);
    UPDATE public.release SET is_live = false WHERE is_live;
    UPDATE public.release SET is_live = true  WHERE version = p_version;
END $$;

-- ================================================================ what the assistant reads
-- One row per active task x campus x regular/RFMT, from the live version only.
CREATE VIEW live.routing_lookup AS
SELECT t.task_code,
       t.description,
       c.name          AS category,
       r.campus_code,
       r.is_rfmt,
       r.kind,
       r.trade_code,
       CASE WHEN r.kind = 'zone' THEN (
           SELECT array_agg(z.code ORDER BY z.code) FROM live.zone z
           WHERE z.campus_code = r.campus_code AND z.is_rfmt = r.is_rfmt AND z.active)
       END             AS zone_options,
       r.instruction,
       t.notes,
       c.section_note,
       t.custodial
FROM live.routing_rule r
JOIN live.task t          ON t.id = r.task_id AND t.active
JOIN live.task_category c ON c.id = t.category_id AND c.active;

-- Zones for one building, for "which zone does 157A go to?"
CREATE VIEW live.building_lookup AS
SELECT b.code, b.name, b.campus_code, b.subtype, b.rate_schedule,
       array_agg(bz.zone_code ORDER BY z.is_rfmt, bz.zone_code) FILTER (WHERE bz.zone_code IS NOT NULL) AS zones,
       array_agg(bz.zone_code ORDER BY bz.zone_code) FILTER (WHERE z.is_rfmt)     AS rfmt_zones,
       array_agg(bz.zone_code ORDER BY bz.zone_code) FILTER (WHERE NOT z.is_rfmt) AS regular_zones
FROM live.building b
LEFT JOIN live.building_zone bz ON bz.building_id = b.id AND bz.active
LEFT JOIN live.zone z           ON z.code = bz.zone_code AND z.active
WHERE b.active
GROUP BY b.id, b.code, b.name, b.campus_code, b.subtype, b.rate_schedule;

INSERT INTO public.campus (code, name) VALUES
    ('dtpc', 'Downtown Phoenix'), ('poly', 'Polytechnic'), ('tempe', 'Tempe'), ('west', 'West Valley');

COMMIT;
