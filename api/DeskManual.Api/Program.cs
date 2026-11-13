using Dapper;
using DeskManual.Api;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(sp =>
{
    var cfg = sp.GetRequiredService<IConfiguration>();
    return new Db(
        cfg.GetConnectionString("Reader") ?? throw new InvalidOperationException("Set ConnectionStrings:Reader."),
        cfg.GetConnectionString("App") ?? throw new InvalidOperationException("Set ConnectionStrings:App."));
});
builder.Services.AddHttpClient();

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.Cookie.Name = "deskmanual";
        o.Cookie.HttpOnly = true;
        o.Cookie.SameSite = SameSiteMode.Lax;
        o.Cookie.SecurePolicy = builder.Environment.IsDevelopment()
            ? CookieSecurePolicy.SameAsRequest
            : CookieSecurePolicy.Always;
        o.ExpireTimeSpan = TimeSpan.FromHours(10); // a working day
        o.SlidingExpiration = false;
        // An API answers 401/403; it doesn't redirect to a login page.
        o.Events.OnRedirectToLogin = c => { c.Response.StatusCode = 401; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = 403; return Task.CompletedTask; };
    });
// Everything needs a signed-in person unless it says AllowAnonymous.
builder.Services.AddAuthorization(o =>
    o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

var app = builder.Build();

// Checked after Build so the final configuration (including test overrides) is what's checked.
var authMode = app.Configuration["Auth:Mode"] ?? "cas";
if (authMode is not ("cas" or "dev"))
    throw new InvalidOperationException($"Auth:Mode must be cas or dev, not {authMode}.");
// The stand-in login skips CAS, so it must never run anywhere but a developer's machine.
if (authMode == "dev" && !app.Environment.IsDevelopment())
    throw new InvalidOperationException("Auth:Mode=dev only runs in the Development environment.");
if (authMode == "cas" && string.IsNullOrEmpty(app.Configuration["Auth:ServiceUrl"]))
    throw new InvalidOperationException("Set Auth:ServiceUrl to the URL registered with ASU CAS.");
app.Services.GetRequiredService<Db>(); // fail at start-up, not on the first request, if a connection string is missing

// Rule refusals raised by the database ("you can't approve your own request") reach the screen
// as plain messages, not 500s.
app.UseExceptionHandler(e => e.Run(async ctx =>
{
    var error = ctx.Features.Get<IExceptionHandlerFeature>()?.Error;
    (int status, string message) = error switch
    {
        PostgresException { SqlState: "P0001" } pg => (400, pg.MessageText),
        NpgsqlException => (503, "Can't reach the database."),
        _ => (500, "Something went wrong."),
    };
    ctx.Response.StatusCode = status;
    await ctx.Response.WriteAsJsonAsync(new { error = message });
}));

// Browsers can't add a custom header to a cross-site form post, and there is no CORS policy,
// so requiring one on every write blocks cross-site request forgery.
app.Use(async (ctx, next) =>
{
    var method = ctx.Request.Method;
    if (!HttpMethods.IsGet(method) && !HttpMethods.IsHead(method) && !HttpMethods.IsOptions(method)
        && ctx.Request.Headers["X-Desk-Manual"] != "1")
    {
        ctx.Response.StatusCode = 400;
        await ctx.Response.WriteAsJsonAsync(new { error = "Missing X-Desk-Manual header." });
        return;
    }
    await next();
});

// In production the API serves the built web app (web/ builds into wwwroot), so there is one origin.
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();

app.MapAuth(authMode);

app.MapGet("/api/health", async (Db db) =>
{
    var live = await db.Read((c, tx) => c.QuerySingleAsync<int?>(
        "SELECT max(version) FROM public.release WHERE is_live", transaction: tx));
    return Results.Ok(new { status = "ok", liveVersion = live });
}).AllowAnonymous();

app.MapFallback("/api/{**rest}", () => Results.NotFound(new { error = "Not found." })).AllowAnonymous();
app.MapFallbackToFile("index.html").AllowAnonymous();

app.Run();

public partial class Program;
