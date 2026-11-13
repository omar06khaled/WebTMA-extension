using System.Security.Claims;
using Dapper;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Npgsql;

namespace DeskManual.Api;

/// <summary>
/// Sign-in. Production uses ASU CAS. "dev" mode is a stand-in form that exists only in the
/// Development environment (Program.cs refuses to start it anywhere else).
/// </summary>
public static class Auth
{
    public const string AsuriteClaim = "asurite";

    public static string Asurite(this ClaimsPrincipal user) =>
        user.FindFirstValue(AsuriteClaim) ?? throw new InvalidOperationException("Not signed in");

    public static void MapAuth(this WebApplication app, string mode)
    {
        var cfg = app.Configuration;
        var casBase = cfg["Auth:CasBaseUrl"] ?? "https://weblogin.asu.edu/cas";
        var service = cfg["Auth:ServiceUrl"] ?? "";
        var auth = app.MapGroup("/auth").AllowAnonymous();

        auth.MapGet("/login", () => mode == "dev"
            ? Results.Redirect("/signin")
            : Results.Redirect(Cas.LoginUrl(casBase, service)));

        auth.MapGet("/callback", async (string? ticket, HttpContext ctx, Db db, IHttpClientFactory http) =>
        {
            if (mode != "cas" || string.IsNullOrEmpty(ticket))
                return Results.BadRequest(new { error = "No CAS ticket." });
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
                var asurite = body.Asurite?.Trim().ToLowerInvariant();
                if (string.IsNullOrEmpty(asurite))
                    return Results.BadRequest(new { error = "Enter an ASURITE." });
                var name = string.IsNullOrWhiteSpace(body.Name) ? asurite : body.Name.Trim();
                return await SignIn(ctx, db, asurite, name)
                    ? Results.Ok()
                    : Results.Json(new { error = $"{asurite} has no access." }, statusCode: 403);
            });
        }

        auth.MapPost("/logout", async (HttpContext ctx) =>
        {
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

    /// <summary>Records the person (a first-timer becomes a viewer) and issues the session cookie.</summary>
    static async Task<bool> SignIn(HttpContext ctx, Db db, string asurite, string name)
    {
        var active = await db.Anonymous(async (c, tx) =>
        {
            await c.ExecuteAsync("SELECT ensure_user(@asurite, @name)", new { asurite, name }, tx);
            return await c.QuerySingleAsync<bool>(
                "SELECT active FROM app_user WHERE asurite = @asurite", new { asurite }, tx);
        });
        if (!active)
            return false;
        var identity = new ClaimsIdentity(
            [new Claim(AsuriteClaim, asurite), new Claim(ClaimTypes.Name, name)],
            CookieAuthenticationDefaults.AuthenticationScheme);
        await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));
        return true;
    }

    public record DevLogin(string? Asurite, string? Name);
}
