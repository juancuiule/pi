# Litestream

Streams the WAL of `EFFECT_PI_DB` (`data/effect-pi.sqlite`, which holds conversations, attachment metadata and artifacts) to the `litestream` bucket on the local SeaweedFS gateway (`docker/seaweedfs`). The database file itself stays on local disk; only replicas live in S3.

- `pnpm litestream:up` — ensures the bucket (`init-bucket.ts`) and starts replication.
- `pnpm litestream:down` — stops it. SeaweedFS keeps running.

Credentials come from `docker/seaweedfs/.env`; the container reaches the gateway's published `127.0.0.1:8333` as `host.docker.internal:8333`.

## Restore

With the server stopped:

1. Remove or move aside the local file: `rm data/effect-pi.sqlite*` (or keep a copy first).
2. `pnpm litestream:up`. Replication runs with `-restore-if-db-not-exists`, so a missing database is rebuilt from the replica before syncing resumes.
3. `pnpm server`.

To restore explicitly to any path while the stack is down:

    docker compose -f docker/litestream/docker-compose.yml -p litestream run --rm \
      litestream restore -o /data/effect-pi.sqlite /data/effect-pi.sqlite

(relative to the container's `/data`, the bind-mounted `data/`). `-o` picks the output path, `-force` overwrites an existing file, `-txid`/`-timestamp` give a point-in-time restore; see `litestream restore -h`.

Note: SQLite removes the `-wal` file when no process holds the database open, and litestream logs `cannot verify wal state: open wal file` until a writer reopens it. With the server running the connection stays open, so this only appears while the server is stopped.
