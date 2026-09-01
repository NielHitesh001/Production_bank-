# Checkpoint 2 status

Status: verified on 2026-09-01.

The PostgreSQL privilege integration test was executed against a local
PostgreSQL 16.15 cluster. The `wmt_app` role successfully appended through
`append_audit_event(...)`, while a direct `DELETE FROM audit_events` failed
with `permission denied`.

The cluster was ephemeral and stopped after the test. To reproduce:

```bash
MONEYTRACE_TEST_DATABASE_URL='postgresql://<user>@127.0.0.1:54329/postgres' npm run test:integration
```

The legacy boundary is revisioned export/import with a maximum mirror age of
15 minutes plus one 60-second ingestion cycle. A live write hook was rejected
because the current daemon has independent file jobs, no transactional event
bus, and would couple vault refresh availability to database availability; see
[`ADR-006`](ADR-006-legacy-json-export-boundary.md).

## Test-count note

The earlier report of 64 tests and the current report of 52 tests refer to
different repository snapshots/test scopes. The current `npm test` command
discovers 52 tests across `tests/*.test.mjs`, with 51 passing and the database
integration test skipped when `MONEYTRACE_TEST_DATABASE_URL` is absent. The
same integration test passes when run against PostgreSQL as documented above.
