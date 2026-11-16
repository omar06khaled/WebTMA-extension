using Dapper;
using Npgsql;

namespace DeskManual.Api;

/// <summary>
/// The two ways into the database. Every request is one transaction.
/// The rules (peer review, two-person publish, rights) live in the database, so the API stays thin.
/// </summary>
public sealed class Db(string readerConnection, string appConnection) : IDisposable
{
    // Npgsql allows 100 connections per pool and Postgres 100 in total, so a spike used to run the
    // database out of connections (load test, 200 users). Capped, extra requests wait their turn instead.
    // A "Maximum Pool Size" in the connection string still wins.
    readonly NpgsqlDataSource reader = Create(readerConnection, defaultMax: 30);
    readonly NpgsqlDataSource app = Create(appConnection, defaultMax: 10);

    static NpgsqlDataSource Create(string connection, int defaultMax)
    {
        var b = new NpgsqlConnectionStringBuilder(connection);
        if (!connection.Contains("Maximum Pool Size", StringComparison.OrdinalIgnoreCase)
            && !connection.Contains("Max Pool Size", StringComparison.OrdinalIgnoreCase))
            b.MaxPoolSize = defaultMax;
        return NpgsqlDataSource.Create(b.ConnectionString);
    }

    /// <summary>The published (live) manual only, read-only. For dispatch and lookups.</summary>
    public Task<T> Read<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work) =>
        Run(reader, null, readOnly: true, work);

    /// <summary>
    /// As the signed-in person. The database's me() reads them from app.asurite,
    /// so its rules hold even if this API has a bug.
    /// </summary>
    public Task<T> AsUser<T>(string asurite, Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work) =>
        Run(app, asurite, readOnly: false, work);

    /// <summary>Before anyone is signed in: only for ensure_user at sign-in.</summary>
    public Task<T> Anonymous<T>(Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work) =>
        Run(app, null, readOnly: false, work);

    static async Task<T> Run<T>(NpgsqlDataSource source, string? asurite, bool readOnly,
                                Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work)
    {
        await using var conn = await source.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        if (readOnly)
            await conn.ExecuteAsync("SET TRANSACTION READ ONLY", transaction: tx);
        if (asurite is not null)
            await conn.ExecuteAsync("SELECT set_config('app.asurite', @asurite, true)", new { asurite }, tx);
        var result = await work(conn, tx);
        await tx.CommitAsync();
        return result;
    }

    public void Dispose()
    {
        reader.Dispose();
        app.Dispose();
    }
}
