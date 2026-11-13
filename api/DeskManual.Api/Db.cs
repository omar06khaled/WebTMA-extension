using Dapper;
using Npgsql;

namespace DeskManual.Api;

/// <summary>
/// The two ways into the database. Every request is one transaction.
/// The rules (peer review, two-person publish, rights) live in the database, so the API stays thin.
/// </summary>
public sealed class Db(string readerConnection, string appConnection) : IDisposable
{
    readonly NpgsqlDataSource reader = NpgsqlDataSource.Create(readerConnection);
    readonly NpgsqlDataSource app = NpgsqlDataSource.Create(appConnection);

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
