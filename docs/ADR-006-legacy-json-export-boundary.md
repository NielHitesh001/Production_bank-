# ADR-006: Legacy vault to operational-store boundary

Status: accepted for the initial deployment.

## Decision

The legacy financial data workspace remains the source for its generated graph export. The operational system consumes an explicit, revisioned JSON snapshot from `FinanceVault/_system/exports/world-money-graph.v1.json`; it does not install a live write hook inside the legacy writer.

Each export must include a monotonic `revision` and `generated_at` timestamp. The importer records both values with its ingest job. A snapshot is atomic at the file-replace boundary. The operational mirror is permitted to trail the legacy export by **at most 15 minutes plus one ingestion cycle**; the target ingestion cycle is 60 seconds. Stage 5 parity checks compare an operational revision only with the legacy revision it names, never with a later mutable vault state.

## Why not a live write hook

The legacy generator is a long-running Python daemon that writes hundreds of note files and its graph export on independent scheduled jobs. It has no transactional event bus, no stable domain-write boundary, and no retry-safe hook contract. Adding a database write hook there would couple a user-owned local vault writer to operational database availability, risking partial updates and blocking refresh cycles. The export boundary preserves legacy availability and gives the importer a recoverable, replayable artifact.

## Consequences

- The mirror is a bounded-staleness snapshot, not a synchronous replica.
- Every ingestion job must retain the source revision, file hash, import time, and acceptance/rejection counts.
- A parity result older than the stated window is stale and must alert rather than be treated as current.
- A future event-bus-capable legacy writer may supersede this decision with an outbox/write-hook design.
