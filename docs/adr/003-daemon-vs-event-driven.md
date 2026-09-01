# ADR 003: Background Daemon vs. Event-Driven Ingestion

## Status: Accepted

## Context
Global financial telemetry updates at different frequencies: FX rates tick continuously/minutely, Central Bank policy decisions update periodically on economic schedules, and country demographic data updates yearly.

## Decision
We utilize a multi-threaded Python data-refresh daemon (`obsidian_finance_daemon.py`) with prioritized periodic job loops:
- `job_fx`: 15-minute polling with selective file diff checks.
- `job_policy_rates`: Daily economic sync.
- `job_rail_status`: Real-time clearing window state updates.
- `job_countries`: Daily sovereign metadata refresh.

## Consequences
- **Positive**: Low operational overhead, predictable memory consumption, independent scheduling per data source.
- **Negative**: Polling latency bound by schedule intervals.
