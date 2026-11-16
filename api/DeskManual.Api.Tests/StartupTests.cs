using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace DeskManual.Api.Tests;

/// <summary>Checks that need no database: start-up guards, sign-in state, the anti-forgery header.</summary>
public class StartupTests
{
    // Connection strings are only parsed here; nothing connects.
    static WebApplicationFactory<Program> App(string environment, string mode, string serviceUrl = "") =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment(environment);
            b.ConfigureAppConfiguration(c => c.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Auth:Mode"] = mode,
                ["Auth:ServiceUrl"] = serviceUrl,
                ["ConnectionStrings:Reader"] = "Host=127.0.0.1;Port=1;Database=none;Username=none",
                ["ConnectionStrings:App"] = "Host=127.0.0.1;Port=1;Database=none;Username=none",
            }));
        });

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    public void Stand_in_login_refuses_to_start_outside_development(string environment)
    {
        using var app = App(environment, "dev");
        var e = Assert.Throws<InvalidOperationException>(() => app.CreateClient());
        Assert.Contains("Development", e.Message);
    }

    [Fact]
    public void Stand_in_login_refuses_to_start_beside_a_real_cas_setup()
    {
        using var app = App("Development", "dev", "https://desk.example.test/auth/callback");
        var e = Assert.Throws<InvalidOperationException>(() => app.CreateClient());
        Assert.Contains("real deployment", e.Message);
    }

    [Fact]
    public async Task Responses_carry_security_headers()
    {
        using var app = App("Development", "dev");
        var res = await app.CreateClient().GetAsync("/auth/me");
        Assert.Contains("frame-ancestors 'none'", res.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal("nosniff", res.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Equal("DENY", res.Headers.GetValues("X-Frame-Options").Single());
        Assert.Equal("no-referrer", res.Headers.GetValues("Referrer-Policy").Single());
        Assert.Equal("no-store", res.Headers.CacheControl!.ToString());
    }

    [Fact]
    public async Task Cas_callback_without_a_started_sign_in_is_refused()
    {
        // Login CSRF: someone else's ticket, but this browser never went through /auth/login.
        using var app = App("Production", "cas", "https://desk.example.test/auth/callback");
        var client = app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        var res = await client.GetAsync("/auth/callback?ticket=ST-someone-elses");
        Assert.Equal(HttpStatusCode.Redirect, res.StatusCode);
        Assert.Equal("/signin?failed=1", res.Headers.Location!.ToString());
    }

    [Fact]
    public async Task Cas_login_sets_a_one_time_nonce_cookie()
    {
        using var app = App("Production", "cas", "https://desk.example.test/auth/callback");
        var client = app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        var res = await client.GetAsync("/auth/login");
        var cookie = res.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("deskmanual_login="));
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("path=/auth", cookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Cas_needs_a_service_url()
    {
        using var app = App("Production", "cas");
        Assert.Throws<InvalidOperationException>(() => app.CreateClient());
    }

    [Fact]
    public async Task Me_without_a_session_says_which_sign_in_to_show()
    {
        using var app = App("Development", "dev");
        var res = await app.CreateClient().GetAsync("/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Contains("\"signIn\":\"dev\"", await res.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Cas_login_redirects_to_weblogin_with_the_service_url()
    {
        using var app = App("Production", "cas", "https://desk.example.test/auth/callback");
        var client = app.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        var res = await client.GetAsync("/auth/login");
        Assert.Equal(HttpStatusCode.Redirect, res.StatusCode);
        Assert.Equal(
            "https://weblogin.asu.edu/cas/login?service=https%3A%2F%2Fdesk.example.test%2Fauth%2Fcallback",
            res.Headers.Location!.ToString());
    }

    [Fact]
    public async Task Writes_without_the_header_are_refused()
    {
        using var app = App("Development", "dev");
        var res = await app.CreateClient().PostAsync("/auth/logout", null);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Writes_with_the_header_go_through()
    {
        using var app = App("Development", "dev");
        var req = new HttpRequestMessage(HttpMethod.Post, "/auth/logout");
        req.Headers.Add("X-Desk-Manual", "1");
        var res = await app.CreateClient().SendAsync(req);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Unknown_api_paths_are_404_not_the_web_app()
    {
        using var app = App("Development", "dev");
        var res = await app.CreateClient().GetAsync("/api/nope");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }
}
