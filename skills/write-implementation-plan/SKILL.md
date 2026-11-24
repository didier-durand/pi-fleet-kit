---
name: write-implementation-plan
description: >
  Defines the main points of a good implementation plan: restated goal and
  assumptions, phases ordered by dependency and risk, tasks broken into
  small verifiable units traceable to spec requirements, an explicit test
  strategy per phase, risks with mitigations and rollback, and a
  definition of done per milestone. Use when the user asks to plan an
  implementation, break a specification into work, sequence tasks for a
  team or agent fleet, or review an existing plan.
---

# Implementation Plans

An implementation plan answers **how and in what order** the work will be
done, so that execution can be delegated, verified, and resumed. It turns
a specification into verifiable units of work without inventing new
requirements — if a plan task cannot point at a requirement it serves, it
is either scope creep or a missing spec entry.

## The main points

1. **Goal & traceability** — restate the goal in one paragraph and list
   the spec requirements the plan covers (`REQ-1…REQ-n`). Every task in
   the plan carries the requirement ID(s) it implements; uncovered
   requirements are called out explicitly, never silently dropped.
2. **Assumptions & starting state** — what is assumed true before work
   starts (repo state, environment, credentials, dependencies), and what
   happens if an assumption breaks: the plan names the checkpoint where
   execution must stop and re-confirm.
3. **Phases ordered by dependency and risk** — not by convenience. Each
   phase ends in a verifiable state (compiles, tests green, demo-able).
   Risky or uncertain work is front-loaded into a spike/proof phase —
   never left as the last task before "done".
4. **Tasks** — the unit of delegation:
   - one verifiable outcome per task ("add X", not "work on X");
   - sized to a single session/agent (hours, not weeks);
   - carries: requirement ID, touched files/components, verification
     method (test command, review check, demo), and dependencies on
     earlier tasks;
   - each task's verification is written *before* the task is executed.
5. **Execution graph — parallel vs. sequential** — after the task list is
   written, make the dependency structure explicit so independent tasks
   can actually run in parallel:
   - **Nodes and edges**: nodes are tasks; an edge T1 → T2 means T2 needs
     T1's verified output. If T2 merely *benefits* from T1 but does not
     depend on it, there is no edge — do not invent sequential order.
   - **Waves**: group tasks into waves by topological level — wave 1 is
     every task with no dependencies; wave k is every task whose
     dependencies all sit in earlier waves. Tasks within one wave are
     independent **by construction** and can be executed concurrently —
     delegated to different agents (via `prompt-agent` work orders) or
     run in parallel sessions by the operator.
   - **Wave discipline**: a wave is executed only when every task of the
     previous wave is verified — parallelism never crosses a wave
     boundary. This is what keeps unverified work from accumulating.
   - **Critical path**: the longest dependency chain across waves sets
     the minimum duration of the plan. Name it; parallelize anything
     *off* the critical path first, since that is where concurrency
     actually buys time. If the critical path is long and thin, look for
     a task split that shortens it rather than adding parallelism that
     cannot help.
   - **Write the graph down** — as a wave table and, when helpful, a
     diagram:
     ```text
     Wave 1 (parallel):  T1  T2  T3
     Wave 2 (parallel):  T4 (needs T1)  T5 (needs T2, T3)
     Wave 3:             T6 (needs T4, T5)
     ```
     A task that appears in no wave is either unscheduled scope or a
     missing edge — resolve it before execution starts.
6. **Test strategy per phase** — what is proven at each phase boundary
   and how (unit, integration, manual scenario), mapped to the house test
   bar (≥95% of functional code, meaningful assertions). If a phase
   cannot name its proof, it is not a phase — it is a wish.
7. **Risks, mitigations, rollback** — for each material risk: the
   mitigation taken during execution and the way back if it fires
   (revert point, feature flag, migration undo). One-way-door decisions
   are flagged and deferred to explicit operator sign-off.
8. **Definition of done per milestone** — the checkable state that ends
   each milestone, aligned with the spec's acceptance criteria. The final
   milestone's done-state is exactly the spec's, nothing less.
9. **Out of scope** — restated from the spec, so the plan is not judged
   against work it deliberately excludes.

## What makes a plan good

- **Executable by a stranger**: a competent agent or engineer with only
  the plan and the repo could pick up any task and know what "done"
  means — no knowledge locked in the author's head.
- **Order is load-bearing**: if two tasks can be executed in either
  order, either the dependency graph is wrong or one of them is not
  really needed — the plan states the order and why.
- **Verification is continuous**: every phase boundary is provable; the
  plan never accumulates more than one phase of unverified work.
- **Honest about unknowns**: spike tasks exist to buy knowledge cheaply
  and early; their deliverable is a decision (proceed / change plan), not
  code.
- **Cheap to change**: plans are revised as reality lands — a superseded
  plan is updated or replaced and re-shared, never silently abandoned.
  The spec stays authoritative; the plan serves it.
