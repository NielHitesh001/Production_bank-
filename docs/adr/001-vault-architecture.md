# ADR 001: Financial Knowledge Graph Snapshot Architecture

## Status: Accepted

## Context
The platform requires a persistent, human-readable, and version-controllable data store for global sovereign metadata, central bank policies, payment rails, and currency cross-rates that functions offline and integrates cleanly with analytical tools.

## Decision
We adopted a generated Markdown knowledge-graph snapshot architecture with automated background data refresh:
- **Human-Readable & Editable**: Plain Markdown with YAML frontmatter.
- **Bi-directional Knowledge Graph**: Wikilinks `[[Link]]` forming an explicit institutional topology.
- **Git-Native Version Control**: Zero proprietary database lock-in; diffable on GitHub.
- **Human-readable artifacts**: Compatible with standard Markdown research workflows.

## Consequences
- **Positive**: Complete data ownership, offline accessibility, git versioning.
- **Negative**: Requires filesystem synchronization and managed file write mutexes to prevent write tearing.

## Alternatives Considered
1. PostgreSQL + GraphQL API (High hosting footprint for static sovereign data)
2. MongoDB JSON Store (Lacks native human-readable hyperlinked note interface)
