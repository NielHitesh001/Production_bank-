# World Money — Visual Intelligence & Financial Transaction-Tracing Platform

World Money is a desktop-first financial intelligence workspace for mapping global institutions, tracing transaction relationships, monitoring market and macro signals, and supporting AML investigation workflows.

The platform combines a high-performance React/WebGL analyst interface with a Node.js API layer and a Python data-refresh service. It is designed for read-only intelligence delivery, paper-order simulation, audit evidence, and future backend integration without implying live trading capability.

## Product capabilities

- Interactive relationship graph for sovereigns, central banks, banks, intermediaries, payment rails, and transaction flows.
- Multi-hop path tracing, alert triage, risk tags, entity inspection, notes, saved views, and CSV/JSON exports.
- Macro liquidity, FX, policy-rate, GDP, payment-rail, and central-bank views with explicit live, delayed, stale, degraded, and unavailable states.
- Entitlement-aware read APIs, role-aware masking, and immutable audit events.
- Paper-only order acceptance with database-enforced idempotency, atomic risk reservations, kill-switch controls, four-eyes approval, and a closed `DENY_UNLESS_ALL` live-trading gate.
- Legacy export comparison tooling with freshness exclusion and persisted parity observations.

## Architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Analyst workspace | React, Vite, WebGL graph rendering | Dense graph exploration, filtering, tracing, and inspection |
| API services | Node.js HTTP services | Read projections, cases, audit access, paper controls, and integrations |
| Data refresh | Python scheduled service | Currency, policy, payment-rail, and relationship snapshot generation |
| Persistence | PostgreSQL migrations plus local file fallback | Audit chain, paper orders, risk reservations, and operational state |
| Verification | Node test runner, Python unittest, PostgreSQL integration tests | Contract, security, concurrency, and resilience checks |

The current implementation is suitable for internal analysis and paper-only operation. Live broker execution is deliberately denied. The event-sourced ledger/projector architecture remains pending a Legal/Compliance decision and is not represented as implemented.

## Run locally

```bash
npm install
npm run dev
npm run server
```

Build and test:

```bash
npm run build
npm test
MONEYTRACE_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/postgres npm run test:integration
```

## Data refresh and parity

```bash
python3 obsidian_finance_daemon.py --vault-path ./FinanceVault --once
LEGACY_EXPORT_COMMAND='python3 obsidian_finance_daemon.py --vault-path ./FinanceVault --once' npm run export:legacy-boundary
```

The parity job records export revision, hash, snapshot timestamp, ledger watermark, cross-source gap, eligibility, and result state. Observations outside the documented freshness bound are automatically ineligible.

## Security boundaries

- Never treat fallback or demo data as live data.
- Keep live-trading authorization closed until independent Compliance approval.
- Use server-side identity and entitlement enforcement in deployed environments.
- Provide PostgreSQL and durable archival infrastructure before relying on this system for regulated books-and-records obligations.
- Keep credentials out of source control and configure secrets through the deployment environment.

## License

MIT — see [LICENSE](LICENSE).
