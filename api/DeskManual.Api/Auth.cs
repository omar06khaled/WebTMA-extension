using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.Extensions.Caching.Memory;
using Npgsql;

namespace DeskManual.Api;

/// <summary>
/// Sign-in. Production uses ASU CAS. "dev" mode is a stand-in form that exists only in the
/// Development environment, only when switched on explicitly, and only from this machine.
/// </summary>
public static class Auth
{
    public const string AsuriteClaim = "asurite";
    public const string SessionClaim = "sid";
    public const int SessionHours = 10; // a working day
    const string LoginNonceCookie = "deskmanual_login";
    static readonly TimeSpan SessionCheckCache = TimeSpan.FromSeconds(30);

    public static string Asurite(this ClaimsPrincipal user) =>
        user.FindFirstValue(AsuriteClaim) ?? throw new InvalidOperationException("Not signed in");

    public static void MapAuth(this WebApplication app, string mode)
    {
        var cfg = app.Configuration;
        var casBase = cfg["Auth:CasBaseUrl"] ?? "https://weblogin.asu.edu/cas";
        var service = cfg["Auth:ServiceUrl"] ?? "";
        var secure = !app.Environment.IsDevelopment();
        var auth = app.MapGroup("/auth").AllowAnonymous();

        auth.MapGet("/login", (HttpContext ctx) =>
        {
            if (mode == "dev")
                return Results.Redirect("/signin");
            // A one-time cookie proves the sign-in started in this browser. Without it, an attacker could
            // send someone a callback link holding the attacker's own ticket and sign them in as the attacker.
            ctx.Response.Cookies.Append(LoginNonceCookie, Convert.ToHexString(RandomNumberGenerator.GetBytes(16)),
                new CookieOptions { HttpOnly = true, Secure = secure, SameSite = SameSiteMode.Lax, Path = "/auth",
                                    MaxAge = TimeSpan.FromMinutes(10) });
            return Results.Redirect(Cas.LoginUrl(casBase, service));
        });

        auth.MapGet("/callback", async (string? ticket, HttpContext ctx, Db db, IHttpClientFactory http) =>
        {
            if (mode != "cas" || string.IsNullOrEmpty(ticket))
                return Results.BadRequest(new { error = "No CAS ticket." });
            var started = ctx.Request.Cookies.ContainsKey(LoginNonceCookie);
            ctx.Response.Cookies.Delete(LoginNonceCookie, new CookieOptions { Path = "/auth" });
            if (!started)
                return Results.Redirect("/signin?failed=1");
            var who = await Cas.Validate(http.CreateClient(), casBase, service, ticket);
            if (who is null)
                return Results.Redirect("/signin?failed=1");
            return await SignIn(ctx, db, who.Value.Asurite, who.Value.Name)
                ? Results.Redirect("/")
                : Results.Redirect("/signin?noaccess=1");
        });

        if (mode == "dev")
        {
            auth.MapPost("/dev-login", async (DevLogin body, HttpContext ctx, Db db) =>
            {
                // Only from this machine. (The in-process test server has no remote address.)
                var ip = ctx.Connection.RemoteIpAddress;
                if (ip is not null && !IPAddress.IsLoopback(ip))
                    return Results.NotFound();
                var asurite = body.Asurite?.Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(asurite))
                    return Results.BadRequest(new { error = "Enter an ASURITE." });
                if (asurite.Length > 64)
                    return Results.BadRequest(new { error = "That isn't an ASURITE." });
                var name = string.IsNullOrWhiteSpace(body.Name) ? asurite : body.Name.Trim()[..Math.Min(body.Name.Trim().Length, 100)];
                return await SignIn(ctx, db, asurite, name)
                    ? Results.Ok()
                    : Results.Json(new { error = $"{asurite} has no access." }, statusCode: 403);
            });
        }

        auth.MapPost("/logout", async (HttpContext ctx, Db db, IMemoryCache cache) =>
        {
            if (Guid.TryParse(ctx.User.FindFirstValue(SessionClaim), out var sid))
            {
                await db.Anonymous((c, tx) => c.ExecuteAsync("SELECT end_session(@sid)", new { sid }, tx));
                cache.Remove(("session", sid));
            }
            await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.Ok(new { redirect = mode == "cas" ? Cas.LogoutUrl(casBase) : "/" });
        });

        // Anonymous on purpose: a 401 here tells the web app which sign-in to show.
        auth.MapGet("/me", async (HttpContext ctx, Db db) =>
        {
            if (ctx.User.Identity?.IsAuthenticated != true)
                return Results.Json(new { signIn = mode }, statusCode: 401);
            var asurite = ctx.User.Asurite();
            try
            {
                var role = await db.AsUser(asurite, (c, tx) => c.QuerySingleAsync<string>("SELECT my_role()", transaction: tx));
                return Results.Ok(new { asurite, name = ctx.User.Identity.Name, role });
            }
            catch (PostgresException e) when (e.SqlState == "P0001")
            {
                // Deactivated since they signed in.
                await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
                return Results.Json(new { signIn = mode }, statusCode: 401);
            }
        });
    }

    /// <summary>
    /// Runs on every request with a session cookie: the session must still be open and the person still
    /// active. Cached for 30 seconds, so sign-out and deactivation take effect within that.
    /// </summary>
    public static async Task ValidateSession(CookieValidatePrincipalContext ctx)
    {
        var asurite = ctx.Principal?.FindFirstValue(AsuriteClaim);
        var live = Guid.TryParse(ctx.Principal?.FindFirstValue(SessionClaim), out var sid) && asurite is not null
                   && await SessionIsLive(ctx.HttpContext.RequestServices, sid, asurite);
        if (!live)
        {
            ctx.RejectPrincipal();
            await ctx.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
        }
    }

    static async Task<bool> SessionIsLive(IServiceProvider services, Guid sid, string asurite)
    {
        var cache = services.GetRequiredService<IMemoryCache>();
        if (cache.TryGetValue(("session", sid), out bool live))
            return live;
        var owner = await services.GetRequiredService<Db>().Anonymous((c, tx) =>
            c.QuerySingleOrDefaultAsync<string>("SELECT asurite FROM check_session(@sid)", new { sid }, tx));
        live = owner == asurite;
        var seconds = services.GetRequiredService<IConfiguration>().GetValue("Auth:SessionCheckSeconds", (int)SessionCheckCache.TotalSeconds);
        if (seconds > 0)
            cache.Set(("session", sid), live, TimeSpan.FromSeconds(seconds));
        return live;
    }

    /// <summary>Records the person (a first-timer becomes a viewer), opens a session and issues its cookie.</summary>
    static async Task<bool> SignIn(HttpContext ctx, Db db, string asurite, string name)
    {
        var sid = await db.Anonymous(async (c, tx) =>
        {
            await c.ExecuteAsync("SELECT ensure_user(@asurite, @name)", new { asurite, name }, tx);
            var active = await c.QuerySingleAsync<bool>(
                "SELECT active FROM app_user WHERE asurite = @asurite", new { asurite }, tx);
            return active
                ? await c.QuerySingleAsync<Guid?>("SELECT start_session(@asurite, @hours)", new { asurite, hours = SessionHours }, tx)
                : null;
        });
        if (sid is null)
            return false;
        var identity = new ClaimsIdentity(
            [new Claim(AsuriteClaim, asurite), new Claim(ClaimTypes.Name, name), new Claim(SessionClaim, sid.Value.ToString())],
            CookieAuthenticationDefaults.AuthenticationScheme);
        await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));
        return true;
    }

    public record DevLogin(string? Asurite, string? Name);
}
