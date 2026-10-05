# Coding Agent Guide

## Mission

Build ParadoxDB as a real, testable distributed database. Do not optimize for fake complexity or marketing claims.

## Hard constraints

1. Never implement a CAP-breaking claim.
2. Never silently weaken strict-mode guarantees.
3. Never make a network timeout mean "success" unless the API explicitly reports unknown outcome.
4. Every mutation has a unique mutation ID.
5. Every internal state transition is observable through logs/metrics.
6. Every persistence format is versioned.
7. Every distributed algorithm has a failure path.

## Development order

1. storage engine.
2. HTTP API.
3. CLI.
4. partitioning.
5. membership.
6. strict replication.
7. failure recovery.
8. available mode.
9. conflict resolution.
10. SDKs.

## Agent workflow

For each task:

```text
READ relevant MD
  -> inspect existing interfaces
  -> implement smallest vertical slice
  -> add unit tests
  -> add failure test if distributed
  -> run formatter/linter
  -> run targeted tests
  -> run integration tests
  -> update docs
```

## Definition of done

A change is not complete until:

- behavior is tested.
- error behavior is tested.
- metrics/logging exist for meaningful failure states.
- public APIs have docs/examples.
- compatibility concerns are documented.

## Preferred abstractions

Use traits/interfaces for:

- clock.
- filesystem.
- network transport.
- storage engine.
- consensus.
- replication.
- membership.

This makes deterministic testing possible.

## Avoid

- global mutable state.
- hidden retries.
- unbounded queues.
- blocking the async runtime on filesystem operations.
- unsafe code unless justified and reviewed.
- large refactors without tests.
