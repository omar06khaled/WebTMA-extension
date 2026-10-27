-- Desk manual database (PostgreSQL 15+)
--
-- Decisions this follows (agreed Oct 2026, updated Oct 27 to match the user stories doc):
--   1  every building has a hidden id; its building code is unique
--   2  a building can sit in several zones (building_zone link table)
--   3  every task has a hidden id; the WebTMA task code can repeat or be blank
--   4  routing: one row per task x campus x regular/RFMT, with an explicit kind
--   5  nothing is deleted; rows are retired (active = false)
--   6  roles: viewer (dispatcher) / editor / approver / manager / admin
--   7  edits go: submitted -> peer-approved -> staging ("next version") -> checks ->
--      publish requested by one approver -> confirmed by a second approver -> live.
--      Rollback takes the same two sign-offs. Every version is kept.
--   8  every change is logged automatically; logs are append-only
--   A  peer review: any editor or approver reviews other people's requests, never their own
--   B  edit conflicts warn, they don't block (conflicts_for())
--   H  contacts are stored once and linked to entries (contact_link)
--
-- Three schemas:
--   public   shared things: users, change requests, releases, logs, flags, same-day changes
--   staging  the "next version". Approved edits land here. Approvers can preview it.
--   live     the published version the assistant and dispatchers read.
--            Only the release functions write to it.
--
-- Who is calling: the app signs people in with CAS, then runs
--     SET LOCAL app.asurite = '<their asurite>'
-- at the start of each transaction. Every function below reads the caller from there
-- (public.me()), never from an argument, so nobody can act as someone else by passing
-- a different name. Only the app's database role can connect, so only the app can set it.
--
-- Database roles (created at the bottom):
--   deskmanual_app     the website. Reads everything, writes ONLY through the functions here.
--   deskmanual_reader  the assistant. Reads live.* only.
--   the owner          whoever runs this file and the importers (setup and admin only).

BEGIN;

CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS live;

-- ================================================================ helpers
CREATE FUNCTION public.phx_today() RETURNS date LANGUAGE sql STABLE AS $$
    SELECT (now() AT TIME ZONE 'America/Phoenix')::date $$;
CREATE FUNCTION public.phx_now() RETURNS timestamp LANGUAGE sql STABLE AS $$
    SELECT now() AT TIME ZONE 'America/Phoenix' $$;

-- Append-only tables: no UPDATE, DELETE or TRUNCATE, ever.
CREATE FUNCTION public.block_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP;
END $$;

-- ================================================================ public: people
CREATE TABLE public.app_user (
    asurite       text PRIMARY KEY,                 -- ASU login from CAS
    display_name  text NOT NULL,
    role          text NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer', 'editor', 'approver', 'manager', 'admin')),
    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Story 7.3: every grant or removal of rights.
CREATE TABLE public.role_change (
    id          bigserial PRIMARY KEY,
    asurite     text NOT NULL REFERENCES public.app_user(asurite),
    old_role    text,
    new_role    text NOT NULL,
    old_active  boolean,
    new_active  boolean NOT NULL,
    changed_by  text NOT NULL REFERENCES public.app_user(asurite),
    changed_at  timestamptz NOT NULL DEFAULT now(),
    note        text
);

-- The signed-in caller, as set by the app after CAS.
CREATE FUNCTION public.me() RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v text := nullif(current_setting('app.asurite', true), '');
BEGIN
    IF v IS NULL THEN
        RAISE EXCEPTION 'No signed-in user: the app must SET LOCAL app.asurite first';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.app_user WHERE asurite = v AND active) THEN
        RAISE EXCEPTION '% is not an active user', v;
    END IF;
    RETURN v;
END $$;

CREATE FUNCTION public.my_role() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT role FROM public.app_user WHERE asurite = public.me() $$;

CREATE FUNCTION public.require_role(VARIADIC p_roles text[]) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE v_me text := public.me(); v_role text;
BEGIN
    SELECT role INTO v_role FROM public.app_user WHERE asurite = v_me;
    IF NOT v_role = ANY (p_roles) THEN
        RAISE EXCEPTION '% (%) can''t do this; needs one of: %', v_me, v_role, array_to_string(p_roles, ', ');
    END IF;
    RETURN v_me;
END $$;

-- ================================================================ public: campuses
-- Campuses almost never change, so they are not versioned.
CREATE TABLE public.campus (
    code  text PRIMARY KEY CHECK (code IN ('dtpc', 'poly', 'tempe', 'west')),
    name  text NOT NULL
);

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
    managed_by     text NOT NULL DEFAULT 'fdm'      -- story 8.4: who looks after the space
                   CHECK (managed_by IN ('fdm', 'leased', 'aramark', 'third_party')),
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

-- Prose sheets (radio protocol, SOPs, schedules, contact sheets not yet merged ...) as pages.
CREATE TABLE staging.article (
    id            serial PRIMARY KEY,
    title         text NOT NULL,
    category      text,                             -- the TOC section: "CRITICAL INFO", "JANITORIAL"
    campus_code   text REFERENCES public.campus(code),   -- null = all campuses
    body_md       text NOT NULL DEFAULT '',
    source_sheet  text UNIQUE,                      -- original sheet name
    sort_order    int  NOT NULL DEFAULT 0,
    active        boolean NOT NULL DEFAULT true,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text REFERENCES public.app_user(asurite)
);

-- ---------------------------------------------------------------- contacts (decision H, story 2.7)
-- A person, team or vendor, stored once.
CREATE TABLE staging.contact (
    id          serial PRIMARY KEY,
    name        text NOT NULL,                      -- "Jane Doe" or "Lock Shop"
    kind        text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'team', 'vendor')),
    title       text,                               -- "Zone supervisor, ACAD A"
    org         text,                               -- "FDM", "Aramark", "ASU PD"
    notes       text,
    active      boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text REFERENCES public.app_user(asurite)
);

-- Story 4.4: cell first, desk and radio after.
CREATE TABLE staging.contact_method (
    id          serial PRIMARY KEY,
    contact_id  int  NOT NULL REFERENCES staging.contact(id),
    kind        text NOT NULL CHECK (kind IN ('cell', 'desk', 'radio', 'pager', 'email', 'link', 'other')),
    value       text NOT NULL,
    label       text,                               -- "after hours", "dispatch line"
    sort_order  int  NOT NULL DEFAULT 0,
    active      boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text REFERENCES public.app_user(asurite)
);

-- Story 4.2: after-hours rotation. Who is on = slot number (weeks since anchor / period) mod slots.
CREATE TABLE staging.rotation (
    id           serial PRIMARY KEY,
    name         text NOT NULL UNIQUE,              -- "Grounds after-hours"
    period_days  int  NOT NULL DEFAULT 14 CHECK (period_days > 0),
    anchor_date  date NOT NULL,                     -- the day slot 1 starts a period
    notes        text,
    active       boolean NOT NULL DEFAULT true,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text REFERENCES public.app_user(asurite)
);

CREATE TABLE staging.rotation_slot (
    rotation_id  int NOT NULL REFERENCES staging.rotation(id),
    position     int NOT NULL CHECK (position > 0),
    contact_id   int NOT NULL REFERENCES staging.contact(id),
    active       boolean NOT NULL DEFAULT true,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text REFERENCES public.app_user(asurite),
    PRIMARY KEY (rotation_id, position)
);

-- Links a contact (or a rotation) to an entry: zone supervisor, trade on-call, building contact ...
-- target_key is the entry's key as text: zone/trade code, or building/task/article id.
-- Optional days/times say when the link applies (story 4.2). Days are ISO: 1 = Monday ... 7 = Sunday.
CREATE TABLE staging.contact_link (
    id            serial PRIMARY KEY,
    target_table  text NOT NULL CHECK (target_table IN ('zone', 'trade', 'building', 'task', 'task_category', 'article')),
    target_key    text NOT NULL,
    contact_id    int  REFERENCES staging.contact(id),
    rotation_id   int  REFERENCES staging.rotation(id),
    role          text NOT NULL CHECK (role IN ('supervisor', 'primary', 'backup', 'on_call', 'info')),
    days          smallint[] CHECK (days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
    start_time    time,                             -- end before start = overnight (22:00-06:00)
    end_time      time,
    sort_order    int  NOT NULL DEFAULT 0,
    note          text,
    active        boolean NOT NULL DEFAULT true,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text REFERENCES public.app_user(asurite),
    CHECK ((contact_id IS NULL) <> (rotation_id IS NULL)),
    CHECK ((start_time IS NULL) = (end_time IS NULL))
);
CREATE INDEX contact_link_target_idx ON staging.contact_link (target_table, target_key);

-- ================================================================ public: logs and requests
-- Decision 8: filled by a trigger on every staging table, so nothing can skip it. Append-only.
CREATE TABLE public.change_log (
    id          bigserial PRIMARY KEY,
    table_name  text NOT NULL,
    action      text NOT NULL,                      -- INSERT / UPDATE
    old_row     jsonb,
    new_row     jsonb,
    changed_by  text,
    request_id  bigint,                             -- the change request that caused it, if any
    changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_table_idx ON public.change_log (table_name, changed_at DESC);

-- Stories 2.2-2.6: an editor proposes; another editor or approver accepts or denies.
CREATE TABLE public.change_request (
    id             bigserial PRIMARY KEY,
    table_name     text NOT NULL,                   -- e.g. 'routing_rule'
    row_key        jsonb,                           -- which row; null for a new row
    target_key     text,                            -- row_key flattened, for conflict lookups
    action         text NOT NULL CHECK (action IN ('insert', 'update', 'retire', 'restore')),
    proposed       jsonb NOT NULL DEFAULT '{}',     -- the new values
    before         jsonb,                           -- the row when the request was made (story 2.3)
    reason         text,
    status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'denied', 'withdrawn')),
    requested_by   text NOT NULL REFERENCES public.app_user(asurite),
    requested_at   timestamptz NOT NULL DEFAULT now(),
    reviewed_by    text REFERENCES public.app_user(asurite),
    reviewed_at    timestamptz,
    review_note    text,
    released_in    int,                             -- release version it went live in
    CHECK (reviewed_by IS DISTINCT FROM requested_by),                  -- decision A: never your own
    CHECK (status NOT IN ('approved', 'denied') OR reviewed_by IS NOT NULL),
    CHECK (status <> 'denied' OR nullif(btrim(review_note), '') IS NOT NULL)  -- story 2.6: denials need a reason
);
CREATE INDEX change_request_target_idx ON public.change_request (table_name, target_key) WHERE status = 'pending';

-- Every step a request goes through (submitted, approved, denied, reopened, appealed ...). Append-only.
CREATE TABLE public.change_request_event (
    id          bigserial PRIMARY KEY,
    request_id  bigint NOT NULL REFERENCES public.change_request(id),
    event       text NOT NULL CHECK (event IN ('submitted', 'approved', 'denied', 'reopened', 'appealed', 'withdrawn')),
    by_user     text NOT NULL REFERENCES public.app_user(asurite),
    at          timestamptz NOT NULL DEFAULT now(),
    note        text
);

-- Decision 7 / story 6.7: one row per published version, holding a full copy of the manual.
CREATE TABLE public.release (
    version       serial PRIMARY KEY,               -- v1, v2, v3 ...
    label         text NOT NULL,                    -- shown to dispatchers (story 3.4)
    published_at  timestamptz NOT NULL DEFAULT now(),
    published_by  text NOT NULL REFERENCES public.app_user(asurite),   -- asked for it
    confirmed_by  text REFERENCES public.app_user(asurite),            -- second sign-off (story 6.1)
    note          text,                             -- "Oct 22: Lock Shop changes"
    eval_score    numeric,                          -- share of the eval cases passed on staging
    checks        jsonb NOT NULL DEFAULT '[]',      -- warnings that were present at publish
    snapshot      jsonb NOT NULL,                   -- every staging table, as JSON
    is_live       boolean NOT NULL DEFAULT false,
    CHECK (confirmed_by IS DISTINCT FROM published_by)
);
CREATE UNIQUE INDEX one_live_release ON public.release (is_live) WHERE is_live;

-- Story 6.1 / decision C: one approver asks, a different approver confirms.
CREATE TABLE public.release_request (
    id              bigserial PRIMARY KEY,
    kind            text NOT NULL CHECK (kind IN ('publish', 'rollback')),
    target_version  int  REFERENCES public.release(version),     -- rollback only
    label           text,
    note            text,
    eval_score      numeric,
    staging_log_id  bigint NOT NULL DEFAULT 0,      -- last change_log id when asked; staging must not move after
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled')),
    requested_by    text NOT NULL REFERENCES public.app_user(asurite),
    requested_at    timestamptz NOT NULL DEFAULT now(),
    decided_by      text REFERENCES public.app_user(asurite),
    decided_at      timestamptz,
    result_version  int  REFERENCES public.release(version),
    CHECK ((kind = 'rollback') = (target_version IS NOT NULL)),
    CHECK (status <> 'done' OR decided_by IS DISTINCT FROM requested_by)
);
CREATE UNIQUE INDEX one_pending_release_request ON public.release_request ((true)) WHERE status = 'pending';

-- Story 6.6: publishes and rollbacks, as they happened. Append-only.
CREATE TABLE public.release_event (
    id            bigserial PRIMARY KEY,
    event         text NOT NULL CHECK (event IN ('published', 'rolled_back')),
    version       int  NOT NULL REFERENCES public.release(version),   -- the version that became live
    from_version  int  REFERENCES public.release(version),            -- what was live before
    requested_by  text NOT NULL REFERENCES public.app_user(asurite),
    confirmed_by  text NOT NULL REFERENCES public.app_user(asurite),
    at            timestamptz NOT NULL DEFAULT now(),
    note          text
);

-- Stories 2.8 / 3.3: a dispatcher says an entry is wrong, with the WO number.
CREATE TABLE public.manual_flag (
    id               bigserial PRIMARY KEY,
    wo_number        text NOT NULL CHECK (btrim(wo_number) <> ''),
    target_table     text,                          -- the entry flagged, if known
    target_key       text,
    description      text NOT NULL CHECK (btrim(description) <> ''),
    release_version  int REFERENCES public.release(version),   -- what they were reading
    flagged_by       text NOT NULL REFERENCES public.app_user(asurite),
    flagged_at       timestamptz NOT NULL DEFAULT now(),
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'dismissed')),
    resolved_by      text REFERENCES public.app_user(asurite),
    resolved_at      timestamptz,
    resolution_note  text,
    CHECK (status = 'open' OR (resolved_by IS NOT NULL AND nullif(btrim(resolution_note), '') IS NOT NULL))
);

-- Story 4.5: "off today". Takes effect at once, no release, and only counts on its own day.
CREATE TABLE public.contact_unavailable (
    id          bigserial PRIMARY KEY,
    contact_id  int  NOT NULL,                      -- staging/live contact id (ids never change)
    day         date NOT NULL DEFAULT public.phx_today(),
    note        text,
    set_by      text NOT NULL REFERENCES public.app_user(asurite),
    set_at      timestamptz NOT NULL DEFAULT now(),
    cleared_by  text REFERENCES public.app_user(asurite),
    cleared_at  timestamptz
);

-- Story 10.2: which Excel sheets were imported, and whether the lead has checked them.
CREATE TABLE public.import_sheet (
    sheet_name    text PRIMARY KEY,
    workbook      text NOT NULL,                    -- "Desk Manual 2027"
    target        text NOT NULL CHECK (target IN ('core', 'article', 'skipped')),
    article_id    int,
    rows_read     int,
    warnings      jsonb NOT NULL DEFAULT '[]',      -- things the importer couldn't carry over
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'needs_fix')),
    reviewed_by   text REFERENCES public.app_user(asurite),
    reviewed_at   timestamptz,
    note          text,
    imported_at   timestamptz NOT NULL DEFAULT now()
);

-- ================================================================ staging triggers
-- The tables that make up one version of the manual, in load order.
CREATE FUNCTION public.manual_tables() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
    SELECT ARRAY['zone', 'building', 'building_zone', 'building_note', 'trade',
                 'task_category', 'task', 'routing_rule', 'article',
                 'contact', 'contact_method', 'rotation', 'rotation_slot', 'contact_link']
$$;

-- Decision 5: no deletes in staging. Retire instead (active = false).
CREATE FUNCTION staging.block_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Rows in % are retired, not deleted. Set active = false instead.', TG_TABLE_NAME;
END $$;

-- Decision 8: log every insert/update in staging.
CREATE FUNCTION staging.log_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    INSERT INTO public.change_log (table_name, action, old_row, new_row, changed_by, request_id)
    VALUES (TG_TABLE_NAME, TG_OP,
            CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
            to_jsonb(NEW),
            COALESCE(NEW.updated_by, nullif(current_setting('app.asurite', true), ''), current_user),
            nullif(current_setting('app.request_id', true), '')::bigint);
    RETURN NEW;
END $$;

DO $$
DECLARE t text; c record;
BEGIN
    FOREACH t IN ARRAY public.manual_tables() LOOP
        EXECUTE format('CREATE TRIGGER log_change BEFORE INSERT OR UPDATE ON staging.%I
                        FOR EACH ROW EXECUTE FUNCTION staging.log_change()', t);
        EXECUTE format('CREATE TRIGGER block_delete BEFORE DELETE ON staging.%I
                        FOR EACH ROW EXECUTE FUNCTION staging.block_delete()', t);
        EXECUTE format('CREATE TRIGGER block_truncate BEFORE TRUNCATE ON staging.%I
                        FOR EACH STATEMENT EXECUTE FUNCTION public.block_change()', t);
        -- live gets the same columns, no keys or triggers: it is only ever replaced wholesale.
        EXECUTE format('CREATE TABLE live.%I (LIKE staging.%I INCLUDING DEFAULTS)', t, t);
    END LOOP;
    -- live tables must not pick up staging's id sequences
    FOR c IN SELECT table_name, column_name FROM information_schema.columns
             WHERE table_schema = 'live' AND column_default LIKE 'nextval(%' LOOP
        EXECUTE format('ALTER TABLE live.%I ALTER COLUMN %I DROP DEFAULT', c.table_name, c.column_name);
    END LOOP;
END $$;

-- Append-only logs (security audit, Oct 26).
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['change_log', 'change_request_event', 'release_event', 'role_change'] LOOP
        EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.%I
                        FOR EACH ROW EXECUTE FUNCTION public.block_change()', t);
        EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON public.%I
                        FOR EACH STATEMENT EXECUTE FUNCTION public.block_change()', t);
    END LOOP;
END $$;

-- Releases are kept forever and never edited; only which one is live can change.
CREATE FUNCTION public.guard_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Releases are never deleted (story 6.7)';
    END IF;
    IF (to_jsonb(NEW) - 'is_live') IS DISTINCT FROM (to_jsonb(OLD) - 'is_live') THEN
        RAISE EXCEPTION 'A published release can''t be edited; only is_live changes';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER guard_release BEFORE UPDATE OR DELETE ON public.release
    FOR EACH ROW EXECUTE FUNCTION public.guard_release();
CREATE TRIGGER guard_release_truncate BEFORE TRUNCATE ON public.release
    FOR EACH STATEMENT EXECUTE FUNCTION public.block_change();

-- ================================================================ users and rights (story 7.3)
-- Managers grant and remove editor and approver rights. Only admins make managers or admins.
-- Nobody changes their own role.
CREATE FUNCTION public.set_role(p_asurite text, p_role text, p_active boolean DEFAULT true, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('manager', 'admin'); v_old public.app_user;
BEGIN
    IF p_asurite = v_me THEN
        RAISE EXCEPTION 'You can''t change your own role';
    END IF;
    SELECT * INTO v_old FROM public.app_user WHERE asurite = p_asurite;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No user %; they must sign in once first', p_asurite;
    END IF;
    IF public.my_role() = 'manager' AND (p_role IN ('manager', 'admin') OR v_old.role IN ('manager', 'admin')) THEN
        RAISE EXCEPTION 'Only an admin can change manager or admin rights';
    END IF;
    UPDATE public.app_user SET role = p_role, active = p_active WHERE asurite = p_asurite;
    INSERT INTO public.role_change (asurite, old_role, new_role, old_active, new_active, changed_by, note)
    VALUES (p_asurite, v_old.role, p_role, v_old.active, p_active, v_me, p_note);
END $$;

-- Story 7.1: first CAS sign-in creates a viewer. Called by the app with the CAS attributes.
-- (Runs before app.asurite means anything, so it takes the asurite as an argument; the app
-- passes only what CAS returned.)
CREATE FUNCTION public.ensure_user(p_asurite text, p_display_name text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    INSERT INTO public.app_user (asurite, display_name) VALUES (lower(p_asurite), p_display_name)
    ON CONFLICT (asurite) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING role
$$;

-- ================================================================ change requests (stories 2.2-2.6, 2.9)
-- Primary key columns of a staging table, in order.
CREATE FUNCTION public.pk_columns(p_table text) RETURNS text[] LANGUAGE sql STABLE AS $$
    SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey::int2[], a.attnum))
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = format('staging.%I', p_table)::regclass AND i.indisprimary
$$;

CREATE FUNCTION public.flat_key(p_table text, p_row_key jsonb) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT string_agg(p_row_key ->> c, '|' ORDER BY o)
    FROM unnest(public.pk_columns(p_table)) WITH ORDINALITY AS u(c, o)
$$;

-- Fetches one staging row by key, as JSON (null if it doesn't exist).
CREATE FUNCTION public.staging_row(p_table text, p_row_key jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v jsonb; v_pk text[] := public.pk_columns(p_table);
BEGIN
    EXECUTE format('SELECT to_jsonb(t) FROM staging.%I t WHERE (%s) = (SELECT %s FROM jsonb_populate_record(NULL::staging.%I, $1))',
                   p_table,
                   (SELECT string_agg(format('t.%I', c), ', ') FROM unnest(v_pk) c),
                   (SELECT string_agg(format('%I', c), ', ') FROM unnest(v_pk) c),
                   p_table)
    INTO v USING p_row_key;
    RETURN v;
END $$;

-- Checks a request is well-formed before anyone sees it.
CREATE FUNCTION public.validate_request(p_table text, p_row_key jsonb, p_action text, p_proposed jsonb)
RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE v_cols text[]; v_bad text[]; v_pk text[];
BEGIN
    IF NOT p_table = ANY (public.manual_tables()) THEN
        RAISE EXCEPTION '% is not a manual table', p_table;
    END IF;
    v_pk := public.pk_columns(p_table);
    SELECT array_agg(column_name::text) INTO v_cols FROM information_schema.columns
    WHERE table_schema = 'staging' AND table_name = p_table;
    SELECT array_agg(k) INTO v_bad FROM jsonb_object_keys(COALESCE(p_proposed, '{}')) k
    WHERE NOT k = ANY (v_cols) OR k IN ('updated_at', 'updated_by');
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'Not editable on %: %', p_table, array_to_string(v_bad, ', ');
    END IF;
    IF p_action = 'insert' THEN
        IF p_row_key IS NOT NULL THEN RAISE EXCEPTION 'A new row has no row_key'; END IF;
        IF COALESCE(p_proposed, '{}') = '{}' THEN RAISE EXCEPTION 'Nothing proposed'; END IF;
    ELSE
        IF p_row_key IS NULL OR EXISTS (SELECT 1 FROM unnest(v_pk) c WHERE p_row_key ->> c IS NULL) THEN
            RAISE EXCEPTION 'row_key must give %', array_to_string(v_pk, ', ');
        END IF;
        IF public.staging_row(p_table, p_row_key) IS NULL THEN
            RAISE EXCEPTION 'No % row %', p_table, p_row_key;
        END IF;
        IF p_action = 'update' AND COALESCE(p_proposed, '{}') = '{}' THEN
            RAISE EXCEPTION 'Nothing proposed';
        END IF;
        IF p_action = 'update' AND EXISTS (SELECT 1 FROM unnest(v_pk) c WHERE p_proposed ? c) THEN
            RAISE EXCEPTION 'Key columns (%) can''t be edited; retire the row and add a new one',
                            array_to_string(v_pk, ', ');
        END IF;
        IF p_action IN ('retire', 'restore') AND NOT 'active' = ANY (v_cols) THEN
            RAISE EXCEPTION '% rows can''t be retired; edit them instead', p_table;
        END IF;
    END IF;
END $$;

-- Decision B: other people's pending requests on the same entry. Warn, don't block.
CREATE FUNCTION public.conflicts_for(p_table text, p_row_key jsonb, p_exclude bigint DEFAULT NULL)
RETURNS TABLE (request_id bigint, requested_by text, display_name text, requested_at timestamptz, action text)
LANGUAGE sql STABLE AS $$
    SELECT r.id, r.requested_by, u.display_name, r.requested_at, r.action
    FROM public.change_request r JOIN public.app_user u ON u.asurite = r.requested_by
    WHERE r.status = 'pending' AND r.table_name = p_table
      AND r.target_key = public.flat_key(p_table, p_row_key)
      AND r.id IS DISTINCT FROM p_exclude
    ORDER BY r.requested_at
$$;

CREATE FUNCTION public.submit_change(p_table text, p_row_key jsonb, p_action text, p_proposed jsonb, p_reason text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin'); v_id bigint; v_n int;
BEGIN
    PERFORM public.validate_request(p_table, p_row_key, p_action, p_proposed);
    INSERT INTO public.change_request (table_name, row_key, target_key, action, proposed, before, reason, requested_by)
    VALUES (p_table, p_row_key,
            CASE WHEN p_row_key IS NOT NULL THEN public.flat_key(p_table, p_row_key) END,
            p_action, COALESCE(p_proposed, '{}'),
            CASE WHEN p_row_key IS NOT NULL THEN public.staging_row(p_table, p_row_key) END,
            p_reason, v_me)
    RETURNING id INTO v_id;
    INSERT INTO public.change_request_event (request_id, event, by_user, note) VALUES (v_id, 'submitted', v_me, p_reason);
    IF p_row_key IS NOT NULL THEN
        SELECT count(*) INTO v_n FROM public.conflicts_for(p_table, p_row_key, v_id);
        IF v_n > 0 THEN
            RAISE NOTICE 'Heads up: % other pending request(s) on this entry. See conflicts_for().', v_n;
        END IF;
    END IF;
    RETURN v_id;
END $$;

-- Writes an approved request into staging. Internal: only approve_change() calls it.
CREATE FUNCTION public.apply_change(p_req public.change_request) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_pk   text[] := public.pk_columns(p_req.table_name);
    v_cols text;
    v_n    int;
    v_new  jsonb := p_req.proposed || jsonb_build_object('updated_by', p_req.requested_by);
BEGIN
    -- re-check: the row may have changed or been retired since it was submitted
    PERFORM public.validate_request(p_req.table_name, p_req.row_key, p_req.action, p_req.proposed);
    PERFORM set_config('app.request_id', p_req.id::text, true);

    IF p_req.action = 'insert' THEN
        SELECT string_agg(format('%I', k), ', ') INTO v_cols FROM jsonb_object_keys(v_new) k;
        EXECUTE format('INSERT INTO staging.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::staging.%I, $1)',
                       p_req.table_name, v_cols, v_cols, p_req.table_name) USING v_new;
        v_n := 1;
    ELSE
        IF p_req.action = 'retire'  THEN v_new := jsonb_build_object('active', false, 'updated_by', p_req.requested_by); END IF;
        IF p_req.action = 'restore' THEN v_new := jsonb_build_object('active', true,  'updated_by', p_req.requested_by); END IF;
        SELECT string_agg(format('%I', k), ', ') INTO v_cols FROM jsonb_object_keys(v_new) k;
        EXECUTE format('UPDATE staging.%1$I t SET (%2$s) = (SELECT %2$s FROM jsonb_populate_record(NULL::staging.%1$I, $1))
                        WHERE (%3$s) = (SELECT %4$s FROM jsonb_populate_record(NULL::staging.%1$I, $2))',
                       p_req.table_name,
                       CASE WHEN v_cols LIKE '%,%' THEN v_cols ELSE 'ROW(' || v_cols || ')' END,
                       (SELECT string_agg(format('t.%I', c), ', ') FROM unnest(v_pk) c),
                       (SELECT string_agg(format('%I', c), ', ') FROM unnest(v_pk) c))
        USING v_new, p_req.row_key;
        GET DIAGNOSTICS v_n = ROW_COUNT;
    END IF;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'Request % changed % rows, expected 1', p_req.id, v_n;
    END IF;
    PERFORM set_config('app.request_id', '', true);
END $$;
REVOKE ALL ON FUNCTION public.apply_change(public.change_request) FROM PUBLIC;

CREATE FUNCTION public.approve_change(p_id bigint, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin'); v_req public.change_request;
BEGIN
    SELECT * INTO v_req FROM public.change_request WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR v_req.status <> 'pending' THEN
        RAISE EXCEPTION 'Request % is not pending', p_id;
    END IF;
    IF v_req.requested_by = v_me THEN
        RAISE EXCEPTION 'You can''t approve your own request (decision A)';
    END IF;
    PERFORM public.apply_change(v_req);
    UPDATE public.change_request
    SET status = 'approved', reviewed_by = v_me, reviewed_at = now(), review_note = p_note WHERE id = p_id;
    INSERT INTO public.change_request_event (request_id, event, by_user, note) VALUES (p_id, 'approved', v_me, p_note);
END $$;

CREATE FUNCTION public.deny_change(p_id bigint, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin'); v_req public.change_request;
BEGIN
    SELECT * INTO v_req FROM public.change_request WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR v_req.status <> 'pending' THEN RAISE EXCEPTION 'Request % is not pending', p_id; END IF;
    IF v_req.requested_by = v_me THEN RAISE EXCEPTION 'You can''t review your own request (decision A)'; END IF;
    IF nullif(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'A denial needs a reason (story 2.6)'; END IF;
    UPDATE public.change_request
    SET status = 'denied', reviewed_by = v_me, reviewed_at = now(), review_note = p_reason WHERE id = p_id;
    INSERT INTO public.change_request_event (request_id, event, by_user, note) VALUES (p_id, 'denied', v_me, p_reason);
END $$;

-- Story 2.6: the reviewer who denied it (or any approver) reopens it.
CREATE FUNCTION public.reopen_change(p_id bigint, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin'); v_req public.change_request;
BEGIN
    SELECT * INTO v_req FROM public.change_request WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR v_req.status <> 'denied' THEN RAISE EXCEPTION 'Request % is not denied', p_id; END IF;
    IF v_req.reviewed_by <> v_me AND public.my_role() NOT IN ('approver', 'admin') THEN
        RAISE EXCEPTION 'Only the reviewer who denied it, or an approver, can reopen it';
    END IF;
    UPDATE public.change_request SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
    WHERE id = p_id;
    INSERT INTO public.change_request_event (request_id, event, by_user, note) VALUES (p_id, 'reopened', v_me, p_note);
END $$;

-- Story 2.6: the author appeals with a note, which resubmits it.
CREATE FUNCTION public.appeal_change(p_id bigint, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin'); v_req public.change_request;
BEGIN
    SELECT * INTO v_req FROM public.change_request WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR v_req.status <> 'denied' THEN RAISE EXCEPTION 'Request % is not denied', p_id; END IF;
    IF v_req.requested_by <> v_me THEN RAISE EXCEPTION 'Only the author can appeal'; END IF;
    IF nullif(btrim(p_note), '') IS NULL THEN RAISE EXCEPTION 'An appeal needs a note'; END IF;
    UPDATE public.change_request SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
    WHERE id = p_id;
    INSERT INTO public.change_request_event (request_id, event, by_user, note) VALUES (p_id, 'appealed', v_me, p_note);
END $$;

CREATE FUNCTION public.withdraw_change(p_id bigint, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin'); v_req public.change_request;
BEGIN
    SELECT * INTO v_req FROM public.change_request WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR v_req.status NOT IN ('pending', 'denied') THEN RAISE EXCEPTION 'Request % can''t be withdrawn', p_id; END IF;
    IF v_req.requested_by <> v_me THEN RAISE EXCEPTION 'Only the author can withdraw'; END IF;
    UPDATE public.change_request SET status = 'withdrawn' WHERE id = p_id;
    INSERT INTO public.change_request_event (request_id, event, by_user, note) VALUES (p_id, 'withdrawn', v_me, p_note);
END $$;

-- ================================================================ automatic checks before a release
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
    -- a contact link points at an entry that doesn't exist or is retired
    SELECT 'error', 'contact linked to missing entry', l.target_table || ' ' || l.target_key
    FROM staging.contact_link l
    WHERE l.active AND NOT CASE l.target_table
        WHEN 'zone'          THEN EXISTS (SELECT 1 FROM staging.zone x          WHERE x.code = l.target_key AND x.active)
        WHEN 'trade'         THEN EXISTS (SELECT 1 FROM staging.trade x         WHERE x.code = l.target_key AND x.active)
        WHEN 'building'      THEN EXISTS (SELECT 1 FROM staging.building x      WHERE x.id::text = l.target_key AND x.active)
        WHEN 'task'          THEN EXISTS (SELECT 1 FROM staging.task x          WHERE x.id::text = l.target_key AND x.active)
        WHEN 'task_category' THEN EXISTS (SELECT 1 FROM staging.task_category x WHERE x.id::text = l.target_key AND x.active)
        WHEN 'article'       THEN EXISTS (SELECT 1 FROM staging.article x       WHERE x.id::text = l.target_key AND x.active)
    END
    UNION ALL
    -- a live link to a retired contact or rotation
    SELECT 'error', 'link to retired contact', l.target_table || ' ' || l.target_key || ' -> ' || COALESCE(c.name, r.name)
    FROM staging.contact_link l
    LEFT JOIN staging.contact  c ON c.id = l.contact_id
    LEFT JOIN staging.rotation r ON r.id = l.rotation_id
    WHERE l.active AND NOT COALESCE(c.active, r.active)
    UNION ALL
    -- a rotation that is linked somewhere but has nobody in it
    SELECT DISTINCT 'error', 'rotation has no one in it', r.name
    FROM staging.contact_link l JOIN staging.rotation r ON r.id = l.rotation_id AND r.active
    WHERE l.active AND NOT EXISTS (SELECT 1 FROM staging.rotation_slot s
                                   JOIN staging.contact c ON c.id = s.contact_id AND c.active
                                   WHERE s.rotation_id = r.id AND s.active)
    UNION ALL
    -- one WebTMA task code on two different active tasks. The same task listed under two
    -- categories (Garbage Disposal 23090, Mold check 27060: academic vs residential) is fine.
    SELECT 'warning', 'task code used twice',
           t.task_code || ': ' || string_agg(DISTINCT t.description, ' | ')
    FROM staging.task t WHERE t.active AND t.task_code IS NOT NULL
    GROUP BY t.task_code HAVING count(DISTINCT t.description) > 1
    UNION ALL
    -- an active building with no zone at all
    SELECT 'warning', 'building has no zone', b.code || ' ' || b.name
    FROM staging.building b
    WHERE b.active AND NOT EXISTS (SELECT 1 FROM staging.building_zone bz
                                   WHERE bz.building_id = b.id AND bz.active)
    UNION ALL
    -- a linked contact with no way to reach them
    SELECT DISTINCT 'warning', 'contact has no number or email', c.name
    FROM staging.contact c
    WHERE c.active AND NOT EXISTS (SELECT 1 FROM staging.contact_method m WHERE m.contact_id = c.id AND m.active)
    UNION ALL
    -- story 3.2: a zone dispatchers can route to, with no supervisor on file
    SELECT 'warning', 'zone has no supervisor', z.code
    FROM staging.zone z
    WHERE z.active AND NOT EXISTS (SELECT 1 FROM staging.contact_link l
                                   WHERE l.active AND l.target_table = 'zone' AND l.target_key = z.code
                                     AND l.role = 'supervisor')
$$;

-- ================================================================ publish and roll back (stories 6.1-6.7)
-- Copies a snapshot into the live tables, replacing what is there. Internal.
CREATE FUNCTION public.load_live(p_snapshot jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t text;
BEGIN
    EXECUTE 'TRUNCATE ' || (SELECT string_agg(format('live.%I', x), ', ') FROM unnest(public.manual_tables()) x);
    FOREACH t IN ARRAY public.manual_tables() LOOP
        EXECUTE format('INSERT INTO live.%I SELECT * FROM jsonb_populate_recordset(NULL::live.%I, $1 -> %L)', t, t, t)
        USING p_snapshot;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.load_live(jsonb) FROM PUBLIC;

CREATE FUNCTION public.last_change_id() RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT COALESCE(max(id), 0) FROM public.change_log $$;

-- Publishes staging as a new release. Internal: confirm_release() and bootstrap_publish() call it.
CREATE FUNCTION public.do_publish(p_requested_by text, p_confirmed_by text, p_label text, p_note text, p_eval_score numeric)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_errors   jsonb;
    v_warnings jsonb;
    v_snapshot jsonb := '{}';
    v_version  int;
    v_from     int;
    t          text;
BEGIN
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

    SELECT version INTO v_from FROM public.release WHERE is_live;
    PERFORM public.load_live(v_snapshot);
    UPDATE public.release SET is_live = false WHERE is_live;
    v_version := nextval(pg_get_serial_sequence('public.release', 'version'));
    INSERT INTO public.release (version, label, published_by, confirmed_by, note, eval_score, checks, snapshot, is_live)
    VALUES (v_version, COALESCE(nullif(btrim(p_label), ''), 'v' || v_version),
            p_requested_by, p_confirmed_by, p_note, p_eval_score, v_warnings, v_snapshot, true);
    -- story 6.2: the release lists the changes in it
    UPDATE public.change_request SET released_in = v_version WHERE status = 'approved' AND released_in IS NULL;
    INSERT INTO public.release_event (event, version, from_version, requested_by, confirmed_by, note)
    VALUES ('published', v_version, v_from, p_requested_by, COALESCE(p_confirmed_by, p_requested_by), p_note);
    RETURN v_version;
END $$;
REVOKE ALL ON FUNCTION public.do_publish(text, text, text, text, numeric) FROM PUBLIC;

-- Step 1 (approver A): ask to publish staging, or to roll back to an older version.
-- p_eval_score: the editor app runs the eval cases against staging first and passes the result.
CREATE FUNCTION public.request_publish(p_note text, p_label text DEFAULT NULL, p_eval_score numeric DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('approver', 'admin'); v_id bigint; v_errors int;
BEGIN
    SELECT count(*) INTO v_errors FROM public.release_checks() WHERE severity = 'error';
    IF v_errors > 0 THEN
        RAISE EXCEPTION 'Fix % check error(s) first; see release_checks()', v_errors;
    END IF;
    INSERT INTO public.release_request (kind, label, note, eval_score, staging_log_id, requested_by)
    VALUES ('publish', p_label, p_note, p_eval_score, public.last_change_id(), v_me)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE FUNCTION public.request_rollback(p_version int, p_note text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('approver', 'admin'); v_id bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.release WHERE version = p_version) THEN
        RAISE EXCEPTION 'No release v%', p_version;
    END IF;
    IF EXISTS (SELECT 1 FROM public.release WHERE version = p_version AND is_live) THEN
        RAISE EXCEPTION 'v% is already live', p_version;
    END IF;
    INSERT INTO public.release_request (kind, target_version, note, requested_by)
    VALUES ('rollback', p_version, p_note, v_me) RETURNING id INTO v_id;
    RETURN v_id;
END $$;

-- Step 2 (approver B, not A): confirm. Publishing is refused if staging changed after the ask,
-- so B signs off on exactly what A saw.
CREATE FUNCTION public.confirm_release(p_id bigint)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('approver', 'admin'); v_rr public.release_request; v_version int; v_from int;
BEGIN
    SELECT * INTO v_rr FROM public.release_request WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR v_rr.status <> 'pending' THEN RAISE EXCEPTION 'Release request % is not pending', p_id; END IF;
    IF v_rr.requested_by = v_me THEN
        RAISE EXCEPTION 'A second approver must confirm (story 6.1)';
    END IF;

    IF v_rr.kind = 'publish' THEN
        IF public.last_change_id() <> v_rr.staging_log_id THEN
            RAISE EXCEPTION 'The next version changed after this was requested. Cancel and request again.';
        END IF;
        v_version := public.do_publish(v_rr.requested_by, v_me, v_rr.label, v_rr.note, v_rr.eval_score);
    ELSE
        SELECT version INTO v_from FROM public.release WHERE is_live;
        PERFORM public.load_live((SELECT snapshot FROM public.release WHERE version = v_rr.target_version));
        UPDATE public.release SET is_live = false WHERE is_live;
        UPDATE public.release SET is_live = true  WHERE version = v_rr.target_version;
        INSERT INTO public.release_event (event, version, from_version, requested_by, confirmed_by, note)
        VALUES ('rolled_back', v_rr.target_version, v_from, v_rr.requested_by, v_me, v_rr.note);
        v_version := v_rr.target_version;
    END IF;

    UPDATE public.release_request
    SET status = 'done', decided_by = v_me, decided_at = now(), result_version = v_version WHERE id = p_id;
    RETURN v_version;
END $$;

CREATE FUNCTION public.cancel_release_request(p_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('approver', 'admin');
BEGIN
    UPDATE public.release_request SET status = 'cancelled', decided_by = v_me, decided_at = now()
    WHERE id = p_id AND status = 'pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Release request % is not pending', p_id; END IF;
END $$;

-- First release only, from the setup script (owner only, never granted to the app).
-- There is no second approver yet on day one, so this is the one publish with a single name.
CREATE FUNCTION public.bootstrap_publish(p_note text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('approver', 'admin');
BEGIN
    IF EXISTS (SELECT 1 FROM public.release) THEN
        RAISE EXCEPTION 'There is already a release; use request_publish() + confirm_release()';
    END IF;
    RETURN public.do_publish(v_me, NULL, NULL, p_note, NULL);
END $$;
REVOKE ALL ON FUNCTION public.bootstrap_publish(text) FROM PUBLIC;

-- ================================================================ flags and same-day changes
CREATE FUNCTION public.flag_entry(p_wo_number text, p_description text, p_table text DEFAULT NULL, p_key text DEFAULT NULL)
RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    INSERT INTO public.manual_flag (wo_number, description, target_table, target_key, release_version, flagged_by)
    VALUES (btrim(p_wo_number), p_description, p_table, p_key,
            (SELECT version FROM public.release WHERE is_live), public.me())
    RETURNING id
$$;

CREATE FUNCTION public.resolve_flag(p_id bigint, p_status text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin');
BEGIN
    UPDATE public.manual_flag
    SET status = p_status, resolved_by = v_me, resolved_at = now(), resolution_note = p_note
    WHERE id = p_id AND status = 'open';
    IF NOT FOUND THEN RAISE EXCEPTION 'Flag % is not open', p_id; END IF;
END $$;

CREATE FUNCTION public.mark_unavailable(p_contact_id int, p_note text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin'); v_id bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM live.contact WHERE id = p_contact_id) THEN
        RAISE EXCEPTION 'No published contact %', p_contact_id;
    END IF;
    INSERT INTO public.contact_unavailable (contact_id, note, set_by) VALUES (p_contact_id, p_note, v_me)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE FUNCTION public.clear_unavailable(p_id bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('editor', 'approver', 'admin');
BEGIN
    UPDATE public.contact_unavailable SET cleared_by = v_me, cleared_at = now()
    WHERE id = p_id AND cleared_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Nothing to clear for %', p_id; END IF;
END $$;

CREATE FUNCTION public.review_import(p_sheet text, p_status text, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_me text := public.require_role('approver', 'admin');
BEGIN
    UPDATE public.import_sheet SET status = p_status, reviewed_by = v_me, reviewed_at = now(), note = p_note
    WHERE sheet_name = p_sheet;
    IF NOT FOUND THEN RAISE EXCEPTION 'No imported sheet %', p_sheet; END IF;
END $$;

-- ================================================================ what the assistant and dispatchers read
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
SELECT b.code, b.name, b.campus_code, b.subtype, b.rate_schedule, b.managed_by,
       array_agg(bz.zone_code ORDER BY z.is_rfmt, bz.zone_code) FILTER (WHERE bz.zone_code IS NOT NULL) AS zones,
       array_agg(bz.zone_code ORDER BY bz.zone_code) FILTER (WHERE z.is_rfmt)     AS rfmt_zones,
       array_agg(bz.zone_code ORDER BY bz.zone_code) FILTER (WHERE NOT z.is_rfmt) AS regular_zones
FROM live.building b
LEFT JOIN live.building_zone bz ON bz.building_id = b.id AND bz.active
LEFT JOIN live.zone z           ON z.code = bz.zone_code AND z.active
WHERE b.active
GROUP BY b.id, b.code, b.name, b.campus_code, b.subtype, b.rate_schedule, b.managed_by;

-- Stories 1.3, 3.2, 4.1-4.5: who to call for an entry right now, best first.
-- Resolves rotations to whoever is on this period, skips nobody but marks people who are
-- off today or outside their hours, and puts the cell number first.
CREATE VIEW live.who_to_call AS
WITH now_phx AS (
    SELECT public.phx_today() AS today, public.phx_now()::time AS t, extract(isodow FROM public.phx_now())::int AS dow
),
slots AS (
    SELECT s.rotation_id, s.contact_id,
           row_number() OVER (PARTITION BY s.rotation_id ORDER BY s.position) - 1 AS idx,
           count(*)     OVER (PARTITION BY s.rotation_id) AS n
    FROM live.rotation_slot s JOIN live.contact c ON c.id = s.contact_id AND c.active
    WHERE s.active
),
resolved AS (
    SELECT l.*, COALESCE(l.contact_id, s.contact_id) AS who, r.name AS rotation_name
    FROM live.contact_link l
    LEFT JOIN live.rotation r ON r.id = l.rotation_id AND r.active
    LEFT JOIN slots s ON s.rotation_id = r.id
         AND s.idx = (((SELECT today FROM now_phx) - r.anchor_date) / r.period_days) % s.n
    WHERE l.active
)
SELECT x.target_table, x.target_key, x.role, x.rotation_name,
       c.id AS contact_id, c.name, c.title, c.org,
       (SELECT m.value FROM live.contact_method m
        WHERE m.contact_id = c.id AND m.active AND m.kind IN ('cell', 'desk', 'radio', 'pager')
        ORDER BY array_position(ARRAY['cell', 'desk', 'radio', 'pager'], m.kind), m.sort_order LIMIT 1) AS best_number,
       (SELECT jsonb_agg(jsonb_build_object('kind', m.kind, 'value', m.value, 'label', m.label)
               ORDER BY array_position(ARRAY['cell', 'desk', 'radio', 'pager', 'email', 'link', 'other'], m.kind), m.sort_order)
        FROM live.contact_method m WHERE m.contact_id = c.id AND m.active) AS methods,
       EXISTS (SELECT 1 FROM public.contact_unavailable u
               WHERE u.contact_id = c.id AND u.day = n.today AND u.cleared_at IS NULL) AS off_today,
       (x.days IS NULL OR n.dow = ANY (x.days))
       AND (x.start_time IS NULL
            OR (x.start_time <= x.end_time AND n.t >= x.start_time AND n.t < x.end_time)
            OR (x.start_time >  x.end_time AND (n.t >= x.start_time OR n.t < x.end_time))) AS in_hours,
       x.days, x.start_time, x.end_time, x.note, x.sort_order
FROM resolved x
CROSS JOIN now_phx n
JOIN live.contact c ON c.id = x.who AND c.active;

-- Story 7.4: one activity log over everything people did. Read-only, built from append-only tables.
CREATE VIEW public.activity AS
SELECT e.at, e.by_user AS who, 'request ' || e.event AS action,
       r.table_name || COALESCE(' ' || r.target_key, ' (new)') AS item, e.note, r.id AS request_id, NULL::int AS version
FROM public.change_request_event e JOIN public.change_request r ON r.id = e.request_id
UNION ALL
SELECT at, requested_by, event || ' (asked)', 'v' || version, note, NULL, version FROM public.release_event
UNION ALL
SELECT at, confirmed_by, event || ' (confirmed)', 'v' || version, note, NULL, version FROM public.release_event
UNION ALL
SELECT changed_at, changed_by, 'role ' || COALESCE(old_role, '-') || ' -> ' || new_role || CASE WHEN NOT new_active THEN ' (deactivated)' ELSE '' END,
       asurite, note, NULL, NULL FROM public.role_change;

INSERT INTO public.campus (code, name) VALUES
    ('dtpc', 'Downtown Phoenix'), ('poly', 'Polytechnic'), ('tempe', 'Tempe'), ('west', 'West Valley');

-- ================================================================ database roles (least privilege)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deskmanual_app') THEN
        CREATE ROLE deskmanual_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deskmanual_reader') THEN
        CREATE ROLE deskmanual_reader NOLOGIN;
    END IF;
END $$;

REVOKE ALL ON SCHEMA public, staging, live FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public, staging FROM PUBLIC;

-- The assistant: published manual only.
GRANT USAGE ON SCHEMA live, public TO deskmanual_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA live TO deskmanual_reader;
GRANT SELECT ON public.contact_unavailable, public.release TO deskmanual_reader;
GRANT EXECUTE ON FUNCTION public.phx_today(), public.phx_now() TO deskmanual_reader;

-- The website: reads everything (it hides staging and logs from people by role),
-- and changes things only through the functions.
GRANT USAGE ON SCHEMA public, staging, live TO deskmanual_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public, staging, live TO deskmanual_app;
GRANT EXECUTE ON FUNCTION
    public.phx_today(), public.phx_now(), public.me(), public.my_role(),
    public.ensure_user(text, text), public.set_role(text, text, boolean, text),
    public.pk_columns(text), public.flat_key(text, jsonb), public.staging_row(text, jsonb),
    public.conflicts_for(text, jsonb, bigint),
    public.submit_change(text, jsonb, text, jsonb, text), public.approve_change(bigint, text),
    public.deny_change(bigint, text), public.reopen_change(bigint, text),
    public.appeal_change(bigint, text), public.withdraw_change(bigint, text),
    public.release_checks(), public.last_change_id(),
    public.request_publish(text, text, numeric), public.request_rollback(int, text),
    public.confirm_release(bigint), public.cancel_release_request(bigint),
    public.flag_entry(text, text, text, text), public.resolve_flag(bigint, text, text),
    public.mark_unavailable(int, text), public.clear_unavailable(bigint),
    public.review_import(text, text, text), public.manual_tables()
TO deskmanual_app;

COMMIT;
