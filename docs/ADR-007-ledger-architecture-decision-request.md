# ADR-007: Financial Record-Keeping Architecture Decision Request

**Status:** decision requested — engineering work is paused pending Legal/Compliance response.

**Audience:** Legal, Compliance, and Risk

## Decision required

Engineering needs a determination on the required authoritative record for orders, cash movements, and account balances. This depends on the registered-entity model and applicable books-and-records obligations; it is not an engineering-only decision.

## Option A: Authoritative Transactional Ledger with Tamper-Evident Audit Trail

Orders, balances, and cash movements are maintained as authoritative current state in transactional tables. Every state change is separately captured in a cryptographically chained, append-only audit trail.

This design can demonstrate what happened, when it happened, and who initiated it. Historical state reconstruction relies on retained transactional records, audit evidence, and point-in-time backups; native event replay is not the primary reconstruction mechanism.

## Option B: Event-Sourced Financial Ledger with Replayable History

The authoritative record is a sequenced, immutable financial event log. Current-state tables such as balances and positions may still exist, but they are derived, rebuildable projections rather than the source of truth.

This design natively supports replaying event history to reconstruct financial state at an arbitrary historical point. It requires additional storage, projection, ordering, replay, and operational controls.

| Capability | Option A | Option B |
| --- | --- | --- |
| Tamper-evident record of action, time, and actor | Yes | Yes |
| Current-state operational tables | Yes | Yes, as derived projections |
| Native authoritative event replay | No | Yes |
| Historical reconstruction approach | Audit evidence plus retained records/backups | Event-log replay plus projections |
| Engineering and operational complexity | Lower | Higher |

## Questions for Legal / Compliance

1. Which books-and-records, supervision, retention, and examination frameworks apply to the final registered-entity model?
2. Do those frameworks require native, mechanical reconstruction of exact historical financial state, or accurate tamper-evident records retrievable within a required timeframe?
3. Is Option A sufficient for the applicable obligations, or is Option B required?
4. What retention periods, retrievability requirements, third-party storage controls, examination access, and legal-hold requirements must be designed in from the start?

## Engineering recommendation

Engineering recommends Option A unless Legal/Compliance determines that native event-level replay is required. This is an engineering recommendation only; it does not resolve regulatory applicability or sufficiency.

## Decision record

| Decision | Approver | Date | Conditions |
| --- | --- | --- | --- |
| Option A — transactional ledger plus tamper-evident audit trail |  |  |  |
| Option B — event-sourced ledger with replayable history |  |  |  |
| More information required |  |  |  |

Until this ADR is resolved, event-store/projector work and architecture revision remain paused. Checkpoint 4A reconciliation and Checkpoint 5 parity remain logic-verified only, pending the resulting ledger decision and real projection infrastructure.
