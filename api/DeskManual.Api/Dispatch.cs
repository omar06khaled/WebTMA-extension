using System.Text.RegularExpressions;
using Dapper;
using Npgsql;

namespace DeskManual.Api;

/// <summary>
/// Read-only answers from the published manual: who gets the call, buildings, zones, trades, articles.
/// None of these call the AI, so they keep working when it is down.
/// </summary>
public static partial class Dispatch
{
    static readonly string[] Campuses = ["dtpc", "poly", "tempe", "west"];
    const string GeneralNotesTitle = "General dispatch notes";

    public static void MapDispatch(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/tasks", (string? q, Db db) => db.Read((c, tx) => c.QueryAsync<TaskRow>("""
            SELECT t.id, t.task_code, t.description, c.name AS category
            FROM live.task t JOIN live.task_category c ON c.id = t.category_id AND c.active
            WHERE t.active AND (t.description ILIKE @like OR c.name ILIKE @like OR t.task_code::text LIKE @prefix)
            ORDER BY c.sort_order, t.sort_order, t.description
            LIMIT 40
            """, Like(q), tx)));

        api.MapGet("/dispatch/route", async (int taskId, string? building, string? campus, Db db) =>
        {
            if (campus is not null && !Campuses.Contains(campus))
                return Results.BadRequest(new { error = $"Unknown campus {campus}." });
            var answer = await db.Read((c, tx) => Route(c, tx, taskId, building, campus));
            return answer is null
                ? Results.NotFound(new { error = building is null ? "No such task." : $"No task {taskId} or no building {building}." })
                : Results.Ok(answer);
        });

        api.MapGet("/buildings", (string? q, Db db) => db.Read((c, tx) => c.QueryAsync<BuildingRow>("""
            SELECT code, name, campus_code FROM live.building_lookup
            WHERE code ILIKE @prefix OR name ILIKE @like
            ORDER BY (code ILIKE @exact) DESC, code
            LIMIT 25
            """, Like(q), tx)));

        api.MapGet("/buildings/{code}", async (string code, Db db) =>
        {
            var b = await db.Read((c, tx) => Building(c, tx, code));
            return b is null ? Results.NotFound(new { error = $"No building with code {code}." }) : Results.Ok(b);
        });

        api.MapGet("/zones/{code}", async (string code, Db db) =>
        {
            var zone = await db.Read(async (c, tx) =>
            {
                var z = await c.QuerySingleOrDefaultAsync<ZoneRow>(
                    "SELECT code, campus_code, is_rfmt, notes FROM live.zone WHERE code = @code AND active", new { code }, tx);
                if (z is null)
                    return null;
                var buildings = await c.QueryAsync<BuildingRow>("""
                    SELECT b.code, b.name, b.campus_code
                    FROM live.building_zone bz JOIN live.building b ON b.id = bz.building_id AND b.active
                    WHERE bz.zone_code = @code AND bz.active
                    ORDER BY b.code
                    """, new { code }, tx);
                return new { zone = z, buildings };
            });
            return zone is null ? Results.NotFound(new { error = $"No zone {code}." }) : Results.Ok(zone);
        });

        // Story: start from the trade. Which tasks go to it, on which campus, for which kind of WO.
        api.MapGet("/trades/{code}", async (string code, Db db) =>
        {
            var trade = await db.Read(async (c, tx) =>
            {
                var t = await c.QuerySingleOrDefaultAsync<TradeRow>(
                    "SELECT code, is_global, notes FROM live.trade WHERE code = @code AND active", new { code }, tx);
                if (t is null)
                    return null;
                var tasks = await c.QueryAsync<TradeTaskRow>("""
                    SELECT t.id AS task_id, t.task_code, t.description, c.name AS category, r.campus_code, r.is_rfmt
                    FROM live.routing_rule r
                    JOIN live.task t ON t.id = r.task_id AND t.active
                    JOIN live.task_category c ON c.id = t.category_id AND c.active
                    WHERE r.trade_code = @code
                    ORDER BY c.sort_order, t.sort_order, t.description, r.is_rfmt,
                             array_position(@campuses, r.campus_code)
                    """, new { code, campuses = Campuses }, tx);
                return new { trade = t, tasks };
            });
            return trade is null ? Results.NotFound(new { error = $"No trade {code}." }) : Results.Ok(trade);
        });

        // One box that finds anything: tasks, buildings, zones, trades and manual articles.
        api.MapGet("/search", async (string? q, Db db) =>
        {
            if (string.IsNullOrWhiteSpace(q))
                return Results.Ok(new { tasks = Array.Empty<object>(), buildings = Array.Empty<object>(),
                                        zones = Array.Empty<object>(), trades = Array.Empty<object>(), articles = Array.Empty<object>() });
            var p = Like(q);
            var result = await db.Read(async (c, tx) => new
            {
                tasks = await c.QueryAsync<TaskRow>("""
                    SELECT t.id, t.task_code, t.description, c.name AS category
                    FROM live.task t JOIN live.task_category c ON c.id = t.category_id AND c.active
                    WHERE t.active AND (t.description ILIKE @like OR t.task_code::text LIKE @prefix)
                    ORDER BY c.sort_order, t.sort_order LIMIT 10
                    """, p, tx),
                buildings = await c.QueryAsync<BuildingRow>("""
                    SELECT code, name, campus_code FROM live.building_lookup
                    WHERE code ILIKE @prefix OR name ILIKE @like
                    ORDER BY (code ILIKE @exact) DESC, code LIMIT 10
                    """, p, tx),
                zones = await c.QueryAsync<ZoneRow>("""
                    SELECT code, campus_code, is_rfmt, notes FROM live.zone
                    WHERE active AND code ILIKE @like ORDER BY code LIMIT 10
                    """, p, tx),
                trades = await c.QueryAsync<TradeRow>("""
                    SELECT code, is_global, notes FROM live.trade
                    WHERE active AND code ILIKE @like ORDER BY code LIMIT 10
                    """, p, tx),
                articles = (await c.QueryAsync<ArticleRow>("""
                    SELECT id, title, category, campus_code, body_md FROM live.article
                    WHERE active AND (title ILIKE @like OR body_md ILIKE @like)
                    ORDER BY (title ILIKE @like) DESC, sort_order, title LIMIT 15
                    """, p, tx)).Select(a => new { a.Id, a.Title, a.Category, a.CampusCode, snippet = Snippet(a.BodyMd, q) }),
            });
            return Results.Ok(result);
        });

        api.MapGet("/manual", (Db db) => db.Read((c, tx) => c.QueryAsync<ArticleRow>("""
            SELECT id, title, category, campus_code, NULL AS body_md FROM live.article
            WHERE active ORDER BY category, sort_order, title
            """, transaction: tx)));

        api.MapGet("/manual/{id:int}", async (int id, Db db) =>
        {
            var a = await db.Read((c, tx) => c.QuerySingleOrDefaultAsync<ArticleRow>(
                "SELECT id, title, category, campus_code, body_md FROM live.article WHERE id = @id AND active",
                new { id }, tx));
            return a is null ? Results.NotFound(new { error = "No such article." }) : Results.Ok(a);
        });

        // Flag a mistake (needs a WO number). Runs as the signed-in person, so it's theirs in the log.
        api.MapPost("/flags", async (FlagRequest f, HttpContext ctx, Db db) =>
        {
            if (string.IsNullOrWhiteSpace(f.WoNumber))
                return Results.BadRequest(new { error = "Enter the WO number." });
            if (string.IsNullOrWhiteSpace(f.Description))
                return Results.BadRequest(new { error = "Say what is wrong." });
            var id = await db.AsUser(ctx.User.Asurite(), (c, tx) => c.QuerySingleAsync<long>(
                "SELECT flag_entry(@wo, @description, @table, @key)",
                new { wo = f.WoNumber.Trim(), description = f.Description.Trim(), table = f.TargetTable, key = f.TargetKey }, tx));
            return Results.Ok(new { id });
        });
    }

    /// <summary>
    /// Who gets the call for one task. A building sets the campus and narrows zone answers to its own zones.
    /// With no building and no campus, every campus is answered.
    /// </summary>
    static async Task<RouteAnswer?> Route(NpgsqlConnection c, NpgsqlTransaction tx, int taskId, string? buildingCode, string? campus)
    {
        var task = await c.QuerySingleOrDefaultAsync<TaskDetail>("""
            SELECT t.id, t.task_code, t.description, c.name AS category, t.notes, c.section_note, t.custodial
            FROM live.task t JOIN live.task_category c ON c.id = t.category_id AND c.active
            WHERE t.id = @taskId AND t.active
            """, new { taskId }, tx);
        if (task is null)
            return null;

        BuildingDetail? building = null;
        if (buildingCode is not null)
        {
            building = await Building(c, tx, buildingCode);
            if (building is null)
                return null;
            campus = building.CampusCode ?? campus;
        }

        var grid = (await c.QueryAsync<Cell>("""
            SELECT r.campus_code, r.is_rfmt, r.kind, r.trade_code, r.instruction,
                   CASE WHEN r.kind = 'zone' THEN (
                       SELECT array_agg(z.code ORDER BY z.code) FROM live.zone z
                       WHERE z.campus_code = r.campus_code AND z.is_rfmt = r.is_rfmt AND z.active)
                   END AS zone_options
            FROM live.routing_rule r
            WHERE r.task_id = @taskId
            ORDER BY r.is_rfmt, array_position(@campuses, r.campus_code)
            """, new { taskId, campuses = Campuses }, tx)).ToList();

        // Zones that belong to no campus (BIOS, LACA, WADC) can answer for any campus; the rest only for their own.
        var campuslessZones = building is null ? [] : (await c.QueryAsync<string>(
            "SELECT code FROM live.zone WHERE campus_code IS NULL AND active", transaction: tx)).ToHashSet();

        var answers = grid
            .Where(r => campus is null || r.CampusCode == campus)
            .Select(r =>
            {
                string[]? zones = null;
                if (r.Kind == "zone" && building is not null)
                {
                    var mine = (r.IsRfmt ? building.RfmtZones : building.RegularZones) ?? [];
                    var onCampus = mine.Where(z => r.ZoneOptions?.Contains(z) == true).ToArray();
                    zones = onCampus.Length > 0 ? onCampus : mine.Where(campuslessZones.Contains).ToArray();
                }
                return new Answer(r.CampusCode, r.IsRfmt, r.Kind, r.TradeCode, r.Instruction, r.ZoneOptions, zones);
            })
            .ToList();

        var generalNotes = await c.QuerySingleOrDefaultAsync<string>(
            "SELECT body_md FROM live.article WHERE title = @title AND active", new { title = GeneralNotesTitle }, tx);

        return new RouteAnswer(task, building, campus, answers, grid, GeneralNoteFor(generalNotes, task.Category));
    }

    static async Task<BuildingDetail?> Building(NpgsqlConnection c, NpgsqlTransaction tx, string code)
    {
        var b = await c.QuerySingleOrDefaultAsync<BuildingDetail>("""
            SELECT code, name, campus_code, subtype, rate_schedule, managed_by, regular_zones, rfmt_zones
            FROM live.building_lookup WHERE code = @code
            """, new { code }, tx);
        if (b is null)
            return null;
        b.Notes = (await c.QueryAsync<string>("""
            SELECT n.note FROM live.building_note n JOIN live.building bb ON bb.id = n.building_id
            WHERE bb.code = @code AND n.active ORDER BY n.id
            """, new { code }, tx)).ToArray();
        return b;
    }

    /// <summary>The General Notes article holds "### After &lt;category&gt;" sections; return the one for this category.</summary>
    public static string? GeneralNoteFor(string? body, string category)
    {
        if (body is null)
            return null;
        var parts = AfterHeading().Split(body);
        for (var i = 1; i + 1 < parts.Length; i += 2)
            if (parts[i].Trim() == category)
                return parts[i + 1].Trim();
        return null;
    }

    /// <summary>About 200 characters of the article around the first match, on one line.</summary>
    public static string Snippet(string? body, string q)
    {
        if (string.IsNullOrEmpty(body))
            return "";
        // Read as text: drop table rules, turn cell borders and <br> into separators, flatten links.
        var plain = TableRule().Replace(body, " ").Replace("<br>", " ").Replace(@"\|", "¦");
        plain = MarkdownLink().Replace(plain, "$1").Replace("|", " · ").Replace("¦", "|").Replace("### ", "");
        var flat = Whitespace().Replace(SeparatorRun().Replace(plain, " · "), " ").Trim(' ', '·');
        var at = flat.IndexOf(q.Trim(), StringComparison.OrdinalIgnoreCase);
        var start = Math.Max(0, at < 0 ? 0 : at - 80);
        var text = flat.Substring(start, Math.Min(200, flat.Length - start));
        return (start > 0 ? "…" : "") + text + (start + text.Length < flat.Length ? "…" : "");
    }

    static object Like(string? q)
    {
        // Escape LIKE wildcards so a search for "100%" means the text, not a pattern.
        var t = (q ?? "").Trim().Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_");
        return new { like = $"%{t}%", prefix = $"{t}%", exact = t };
    }

    [GeneratedRegex(@"^### After (.+)$", RegexOptions.Multiline)]
    private static partial Regex AfterHeading();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"^\|(\s*:?-{3,}:?\s*\|)+\s*$", RegexOptions.Multiline)]
    private static partial Regex TableRule();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)\s]+\)")]
    private static partial Regex MarkdownLink();

    [GeneratedRegex(@"(\s*·\s*){2,}")]
    private static partial Regex SeparatorRun();

    public record TaskRow(int Id, int? TaskCode, string Description, string Category);
    public record TaskDetail(int Id, int? TaskCode, string Description, string Category, string? Notes, string? SectionNote, bool Custodial);
    public record BuildingRow(string Code, string Name, string? CampusCode);
    public record ZoneRow(string Code, string? CampusCode, bool IsRfmt, string? Notes);
    public record TradeRow(string Code, bool IsGlobal, string? Notes);
    public record TradeTaskRow(int TaskId, int? TaskCode, string Description, string Category, string CampusCode, bool IsRfmt);
    public record ArticleRow(int Id, string Title, string? Category, string? CampusCode, string? BodyMd);
    // Properties, not a positional record: Dapper won't pass a text[] column to a string[] constructor parameter.
    public record Cell
    {
        public string CampusCode { get; init; } = "";
        public bool IsRfmt { get; init; }
        public string Kind { get; init; } = "";
        public string? TradeCode { get; init; }
        public string? Instruction { get; init; }
        public string[]? ZoneOptions { get; init; }
    }
    public record Answer(string Campus, bool IsRfmt, string Kind, string? Trade, string? Instruction, string[]? ZoneOptions, string[]? Zones);
    public record RouteAnswer(TaskDetail Task, BuildingDetail? Building, string? Campus, List<Answer> Answers, List<Cell> Grid, string? GeneralNote);
    public record FlagRequest(string? WoNumber, string? Description, string? TargetTable, string? TargetKey);

    public class BuildingDetail
    {
        public string Code { get; set; } = "";
        public string Name { get; set; } = "";
        public string? CampusCode { get; set; }
        public string? Subtype { get; set; }
        public string? RateSchedule { get; set; }
        public string? ManagedBy { get; set; }
        public string[]? RegularZones { get; set; }
        public string[]? RfmtZones { get; set; }
        public string[] Notes { get; set; } = [];
    }
}
