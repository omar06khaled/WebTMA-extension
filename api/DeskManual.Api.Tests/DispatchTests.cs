using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Dapper;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Npgsql;

namespace DeskManual.Api.Tests;

/// <summary>
/// Against a real, loaded desk manual database. Set DESKMANUAL_TEST_DB to the base connection string of a
/// throwaway copy (these tests add a flag, and flags can't be deleted), for example
/// "Host=127.0.0.1;Port=5433;Database=deskmanual_test". The login roles desk_web and desk_reader must exist.
/// Skipped when it isn't set.
/// </summary>
public class DispatchTests : IDisposable
{
    static readonly string? Base = Environment.GetEnvironmentVariable("DESKMANUAL_TEST_DB");
    readonly WebApplicationFactory<Program>? factory;

    public DispatchTests()
    {
        if (Base is null)
            return;
        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Development");
            b.ConfigureAppConfiguration(c => c.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:Mode"] = "dev",
                ["ConnectionStrings:Reader"] = Base + ";Username=desk_reader",
                ["ConnectionStrings:App"] = Base + ";Username=desk_web",
            }));
        });
    }

    public void Dispose() => factory?.Dispose();

    async Task<HttpClient> SignedIn(string asurite = "test_dispatcher")
    {
        Skip.If(factory is null, "DESKMANUAL_TEST_DB is not set");
        var client = factory!.CreateClient();
        client.DefaultRequestHeaders.Add("X-Desk-Manual", "1");
        var res = await client.PostAsJsonAsync("/auth/dev-login", new { asurite });
        res.EnsureSuccessStatusCode();
        return client;
    }

    static NpgsqlConnection Sql() => new(Base + ";Username=desk_web");

    static async Task<JsonElement> Json(HttpResponseMessage res)
    {
        Assert.True(res.IsSuccessStatusCode, $"{(int)res.StatusCode}: {await res.Content.ReadAsStringAsync()}");
        return await res.Content.ReadFromJsonAsync<JsonElement>();
    }

    [SkippableFact]
    public async Task Lookups_need_a_signed_in_person()
    {
        Skip.If(factory is null, "DESKMANUAL_TEST_DB is not set");
        var res = await factory!.CreateClient().GetAsync("/api/tasks?q=plumb");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [SkippableFact]
    public async Task Every_task_answers_all_eight_cells_exactly_as_the_routing_view_has_them()
    {
        var client = await SignedIn();
        await using var db = Sql();
        var expected = (await db.QueryAsync("""
            SELECT t.id, r.campus_code, r.is_rfmt, r.kind, r.trade_code
            FROM live.routing_rule r JOIN live.task t ON t.id = r.task_id AND t.active
            JOIN live.task_category c ON c.id = t.category_id AND c.active
            """)).GroupBy(r => (int)r.id).ToList();
        Assert.True(expected.Count > 100, "the test database looks empty");

        foreach (var task in expected)
        {
            var d = await Json(await client.GetAsync($"/api/dispatch/route?taskId={task.Key}"));
            var got = d.GetProperty("grid").EnumerateArray()
                .Select(c => $"{c.GetProperty("campusCode")}|{c.GetProperty("isRfmt")}|{c.GetProperty("kind")}|{c.GetProperty("tradeCode")}")
                .OrderBy(s => s).ToList();
            var want = task.Select(r => $"{r.campus_code}|{(r.is_rfmt ? "True" : "False")}|{r.kind}|{r.trade_code}")
                .OrderBy(s => s).ToList();
            Assert.Equal(want, got);
            Assert.Equal(8, d.GetProperty("answers").GetArrayLength());
        }
    }

    [SkippableFact]
    public async Task A_building_sets_the_campus_and_narrows_zone_answers_to_its_own_zones()
    {
        var client = await SignedIn();
        await using var db = Sql();
        var pick = await db.QueryFirstAsync("""
            SELECT b.code, b.campus_code, b.regular_zones, t.id AS task_id
            FROM live.building_lookup b
            JOIN live.routing_rule r ON r.campus_code = b.campus_code AND NOT r.is_rfmt AND r.kind = 'zone'
            JOIN live.task t ON t.id = r.task_id AND t.active
            WHERE b.campus_code = 'tempe' AND cardinality(b.regular_zones) = 1
            ORDER BY b.code, t.id LIMIT 1
            """);

        var d = await Json(await client.GetAsync($"/api/dispatch/route?taskId={pick.task_id}&building={pick.code}"));
        Assert.Equal("tempe", d.GetProperty("campus").GetString());
        var answers = d.GetProperty("answers").EnumerateArray().ToList();
        Assert.Equal(2, answers.Count); // regular and RFMT, Tempe only
        Assert.All(answers, a => Assert.Equal("tempe", a.GetProperty("campus").GetString()));
        var regular = answers.Single(a => !a.GetProperty("isRfmt").GetBoolean());
        Assert.Equal(((string[])pick.regular_zones)[0], regular.GetProperty("zones")[0].GetString());
    }

    [SkippableFact]
    public async Task A_zone_never_answers_for_another_campus()
    {
        // A building with no campus on file still has zones that belong to one campus (Hayden Hall West).
        var client = await SignedIn();
        await using var db = Sql();
        var pick = await db.QueryFirstOrDefaultAsync("""
            SELECT b.code, t.id AS task_id
            FROM live.building_lookup b
            JOIN live.zone z ON z.code = ANY (b.zones) AND z.campus_code IS NOT NULL
            JOIN live.routing_rule r ON r.kind = 'zone' AND r.is_rfmt = z.is_rfmt AND r.campus_code <> z.campus_code
            JOIN live.task t ON t.id = r.task_id AND t.active
            WHERE b.campus_code IS NULL
            ORDER BY b.code, t.id LIMIT 1
            """);
        Skip.If(pick is null, "no campus-less building with a campus zone in this data");

        var d = await Json(await client.GetAsync($"/api/dispatch/route?taskId={pick!.task_id}&building={pick.code}"));
        var zoneCampus = (await db.QueryAsync<(string, string?)>("SELECT code, campus_code FROM live.zone"))
            .ToDictionary(z => z.Item1, z => z.Item2);
        foreach (var a in d.GetProperty("answers").EnumerateArray().Where(a => a.GetProperty("kind").GetString() == "zone"))
            foreach (var z in a.GetProperty("zones").EnumerateArray())
                Assert.True(zoneCampus[z.GetString()!] is null || zoneCampus[z.GetString()!] == a.GetProperty("campus").GetString(),
                            $"{z} answered for {a.GetProperty("campus")}");
    }

    [SkippableFact]
    public async Task Campus_alone_narrows_to_that_campus()
    {
        var client = await SignedIn();
        var taskId = (await Json(await client.GetAsync("/api/tasks?q=plumbing")))[0].GetProperty("id").GetInt32();
        var d = await Json(await client.GetAsync($"/api/dispatch/route?taskId={taskId}&campus=poly"));
        Assert.All(d.GetProperty("answers").EnumerateArray(), a => Assert.Equal("poly", a.GetProperty("campus").GetString()));
        Assert.Equal(8, d.GetProperty("grid").GetArrayLength());
    }

    [SkippableFact]
    public async Task Bad_inputs_are_plain_errors()
    {
        var client = await SignedIn();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/dispatch/route?taskId=999999")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/dispatch/route?taskId=1&campus=mars")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/buildings/NOPE-0000")).StatusCode);
    }

    [SkippableFact]
    public async Task General_notes_come_with_the_category_they_follow()
    {
        var client = await SignedIn();
        await using var db = Sql();
        var body = await db.QuerySingleAsync<string>("SELECT body_md FROM live.article WHERE title = 'General dispatch notes'");
        var category = body.Split('\n').First(l => l.StartsWith("### After ")).Substring(10).Trim();
        var taskId = await db.QueryFirstAsync<int>("""
            SELECT t.id FROM live.task t JOIN live.task_category c ON c.id = t.category_id
            WHERE c.name = @category AND t.active ORDER BY t.id
            """, new { category });

        var d = await Json(await client.GetAsync($"/api/dispatch/route?taskId={taskId}"));
        Assert.False(string.IsNullOrWhiteSpace(d.GetProperty("generalNote").GetString()));
    }

    [SkippableFact]
    public async Task Search_finds_buildings_tasks_and_articles()
    {
        var client = await SignedIn();
        await using var db = Sql();
        var title = await db.QueryFirstAsync<string>(
            "SELECT title FROM live.article WHERE active AND title <> 'General dispatch notes' ORDER BY id");
        var word = title.Split(' ', StringSplitOptions.RemoveEmptyEntries).OrderByDescending(w => w.Length).First();

        var d = await Json(await client.GetAsync($"/api/search?q={Uri.EscapeDataString(word)}"));
        Assert.Contains(d.GetProperty("articles").EnumerateArray(), a => a.GetProperty("title").GetString() == title);

        var p = await Json(await client.GetAsync("/api/search?q=plumbing"));
        Assert.True(p.GetProperty("tasks").GetArrayLength() > 0);
    }

    [SkippableFact]
    public async Task A_flag_needs_a_wo_number_and_is_saved_as_the_person_who_raised_it()
    {
        var client = await SignedIn("test_flagger");
        var missing = await client.PostAsJsonAsync("/api/flags", new { woNumber = " ", description = "wrong zone" });
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);

        var wo = "TEST-" + Guid.NewGuid().ToString("N")[..8];
        var ok = await Json(await client.PostAsJsonAsync("/api/flags",
            new { woNumber = wo, description = "wrong zone", targetTable = "building", targetKey = "157A" }));
        await using var db = Sql();
        var row = await db.QuerySingleAsync("SELECT flagged_by, status, release_version FROM manual_flag WHERE id = @id",
            new { id = ok.GetProperty("id").GetInt64() });
        Assert.Equal("test_flagger", (string)row.flagged_by);
        Assert.Equal("open", (string)row.status);
        Assert.NotNull(row.release_version);
    }

    [Fact]
    public void General_note_section_is_picked_by_category()
    {
        var body = "### After Plumbing\nCall the plumber.\n\n### After Lock Shop\nLocks.";
        Assert.Equal("Call the plumber.", Dispatch.GeneralNoteFor(body, "Plumbing"));
        Assert.Equal("Locks.", Dispatch.GeneralNoteFor(body, "Lock Shop"));
        Assert.Null(Dispatch.GeneralNoteFor(body, "Electrical"));
    }

    [Fact]
    public void Snippet_centres_on_the_match()
    {
        var body = new string('a', 300) + " needle " + new string('b', 300);
        var s = Dispatch.Snippet(body, "NEEDLE");
        Assert.Contains("needle", s);
        Assert.StartsWith("…", s);
        Assert.EndsWith("…", s);
    }

    [Fact]
    public void Snippet_reads_tables_as_text()
    {
        var body = "| Bldg | Phone |\n|---|---|\n| 917 | [call](tel:6025550100) |\n| a \\| b | x<br>y |";
        Assert.Equal("Bldg · Phone · 917 · call · a | b · x y", Dispatch.Snippet(body, "bldg"));
    }
}
