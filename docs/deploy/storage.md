# Object storage

By default a host keeps files in the `effect-pi-data` volume and each Workspace in a Docker volume. With object storage they live in S3 buckets on SeaweedFS, which runs beside the server, and Litestream replicates the database to the same store.

| What | Where | How |
| --- | --- | --- |
| Attachments, org skills, screenshots | `attachments`, `skills`, `screenshots` buckets | `STORAGE=s3` |
| Workspace files | `workspaces` bucket, `<id>/files.tar.zst` | `WORKSPACE_STORAGE=s3-copied` |
| Database (conversations, artifacts, accounts) | `litestream` bucket; the file stays in the volume | `deploy.sh` runs Litestream under `STORAGE=s3` |

The search index is left out: it is rebuilt from the database. Decisions: [ADR-0006](../adr/0006-object-storage-beside-local-sqlite.md).

SeaweedFS's data is a Docker volume on this host, so this protects against a lost Sandbox or a corrupted database, not against losing the disk.

## Turn it on

```sh
pnpm seaweed:up                 # writes the keys to .env
```

Then in `.env`, and `deploy/deploy.sh`:

```sh
STORAGE=s3
WORKSPACE_STORAGE=s3-copied
SCREENSHOT_TTL_DAYS=3650        # objects in the screenshots bucket expire after this; 30 by default
```

Workspaces recorded under `docker-volume` move at the next start: their volume becomes the `s3-copied` cache of the same id, so the files stay where they are until that Workspace's next Seat closes, which uploads them and deletes the volume. Nothing copies what the old directories hold into the buckets by itself; do that with the server stopped, before the deploy that switches it on. Attachments keep their keys (`<id>/<file>`).

## Restore the database

Litestream never restores by itself here: the server creates an empty database at start, so a restore has to be done on purpose. With the server stopped:

```sh
docker compose -f deploy/compose.yml stop server litestream
docker compose -f deploy/compose.yml --profile litestream run --rm --no-deps litestream \
  restore -force -o /data/effect-pi.sqlite /data/effect-pi.sqlite
deploy/deploy.sh
```

`-timestamp` or `-txid` restore a point in time; see `litestream restore -h`.
