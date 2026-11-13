namespace DeskManual.Api.Tests;

public class CasTests
{
    [Fact]
    public void Success_gives_lowercase_asurite_and_display_name()
    {
        var who = Cas.Parse("""
            <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
              <cas:authenticationSuccess>
                <cas:user>JDoe1</cas:user>
                <cas:attributes><cas:displayName>Jo Doe</cas:displayName></cas:attributes>
              </cas:authenticationSuccess>
            </cas:serviceResponse>
            """);
        Assert.Equal(("jdoe1", "Jo Doe"), who);
    }

    [Fact]
    public void No_name_attribute_falls_back_to_the_asurite()
    {
        var who = Cas.Parse("""
            <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
              <cas:authenticationSuccess><cas:user>jdoe1</cas:user></cas:authenticationSuccess>
            </cas:serviceResponse>
            """);
        Assert.Equal(("jdoe1", "jdoe1"), who);
    }

    [Fact]
    public void Failure_gives_null()
    {
        var who = Cas.Parse("""
            <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
              <cas:authenticationFailure code="INVALID_TICKET">Ticket not recognized</cas:authenticationFailure>
            </cas:serviceResponse>
            """);
        Assert.Null(who);
    }
}
