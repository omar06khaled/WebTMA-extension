using System.Xml.Linq;

namespace DeskManual.Api;

/// <summary>ASU CAS 3.0: send people to weblogin, then check the ticket they come back with.</summary>
public static class Cas
{
    static readonly XNamespace CasNs = "http://www.yale.edu/tp/cas";

    public static string LoginUrl(string casBase, string service) =>
        $"{casBase}/login?service={Uri.EscapeDataString(service)}";

    public static string LogoutUrl(string casBase) => $"{casBase}/logout";

    /// <summary>
    /// Checks the ticket server to server. Returns the ASURITE and a display name, or null if CAS refused it.
    /// The service URL must be exactly the one the login used.
    /// </summary>
    public static async Task<(string Asurite, string Name)?> Validate(
        HttpClient http, string casBase, string service, string ticket)
    {
        var url = $"{casBase}/p3/serviceValidate?service={Uri.EscapeDataString(service)}" +
                  $"&ticket={Uri.EscapeDataString(ticket)}";
        return Parse(await http.GetStringAsync(url));
    }

    public static (string Asurite, string Name)? Parse(string xml)
    {
        var success = XDocument.Parse(xml).Root?.Element(CasNs + "authenticationSuccess");
        var user = success?.Element(CasNs + "user")?.Value.Trim();
        if (string.IsNullOrEmpty(user))
            return null;
        var attrs = success!.Element(CasNs + "attributes");
        var name = attrs?.Element(CasNs + "displayName")?.Value
                   ?? attrs?.Element(CasNs + "cn")?.Value
                   ?? user;
        return (user.ToLowerInvariant(), name.Trim());
    }
}
