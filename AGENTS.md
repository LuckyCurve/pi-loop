# AGENTS.md

Working agreement for agents and humans editing `pi-loop`.

## This project is developed test-first

**Write the failing test before the implementation.** This is not a preference, it is the working
method here, for two reasons specific to this codebase:

1. **The hard part is invisible without a test.** Whether an iteration is skipped or queued behind a
   running turn depends on pi's internal idle state at timer-fire time. Reading the code will not
   tell you. A test will.
2. **Time is the primary input.** Every interesting behaviour — intervals, skips, expiries,
   pauses — is a function of elapsed time. Tests control time through an injectable clock
   (`src/clock.ts`), so they assert on exact scheduling instead of sleeping and hoping.

The loop is:

1. Write a test that fails for the reason you expect. Run it, and **read the failure**. If it fails
   for a different reason, the test is wrong, not the code.
2. Implement the smallest change that makes it pass.
3. Run the whole suite. Fix any test that now fails, and confirm each failure is a real regression
   rather than a test that encoded an assumption you just changed.

Never delete or weaken an assertion to get green. If an assertion is genuinely wrong, change it in
its own commit and say why.

### Where a test belongs

Pick the cheapest layer that can actually fail for the reason you care about:

| Layer | File | Use it for |
|---|---|---|
| Pure logic | `tests/duration.test.ts`, `tests/commands.test.ts`, `tests/engine.test.ts` | Scheduling rules, parsing, state transitions. No pi, no I/O, fake clock. |
| Extension contract | `tests/extension.test.ts` | Command/tool wiring, lifecycle, error paths (stale context, persistence failure) through a fake pi API. |
| Real runtime | `tests/e2e.test.ts` | Anything that depends on real pi behaviour: idleness, injected-prompt delivery, tool activation, resume-after-pause. |
| Workflow | `tests/triage.test.ts` | The end-to-end user story the feature exists for. |
| Real model | `tests/live.test.ts` | A genuine model iterating a loop. Skips itself with no provider configured. |

If a rule can be tested at the pure-logic layer, it must be. Reaching for the real runtime is a
last resort, because those tests are slow and their failures are harder to attribute.

### Bugs become tests

Every bug fix starts with a test that reproduces it. Two examples already in the suite, both found
by running against real pi rather than by reading docs:

- **Stale context in a timer callback** (`shuts the loop down instead of throwing when the context
  goes stale`). pi throws from `isIdle()` after the session is replaced or disposed. That throw
  happens inside a `setTimeout`, where nothing can catch it.
- **No `session_start` in SDK/print modes** (covered by the lazy-init path and its tests). The
  engine is created on demand rather than assumed from a lifecycle event.

## Architecture rules

- **`src/` must not import pi.** The engine, parser, and status formatter are plain TypeScript with
  an injected clock and host. This is what makes the scheduling rules testable and is why the
  pure-logic layer exists at all. Only `extensions/loop/index.ts` may import
  `@earendil-works/pi-coding-agent`.
- **Keep the engine free of I/O.** It receives `inject` and `isBusy` callbacks and reports through
  `notify` / `onChange`. It never calls pi, the filesystem, or `Date.now()` directly.
- **One tick, one iteration.** `fireDue` serves at most one loop per pass and reschedules the rest
  with a short retry that does *not* count as a skip. A second injection in the same pass would be
  delivered as a queued steer into the run that just started, which is exactly the failure mode
  this project exists to avoid.
- **Never throw out of a timer.** Everything reachable from a scheduled callback must absorb a
  stale context, a failed `appendEntry`, or a failed tool-activation call. Failures are logged or
  ignored, never propagated.
- **Host-provided packages are peer dependencies.** `@earendil-works/pi-coding-agent` and `typebox`
  belong in `peerDependencies` with `"*"`, never in `dependencies`. A physical copy bypasses pi's
  extension module mapping and creates duplicate runtimes.

## Conventions

- TypeScript, ESM, `verbatimModuleSyntax`. Use `import type` for types and keep `.ts` extensions in
  relative imports (`./engine.ts`) — pi loads extensions through `jiti` and resolves them directly.
- Tabs for indentation. Double quotes.
- Comments explain *why*, not *what*. The existing comments document constraints that are not
  visible from the code (pi's delivery rules, timer hazards, token cost). Match that bar; delete
  comments that merely restate the next line.
- Tool and command descriptions are user-facing prompt surface. When you change agent-visible text
  (`description`, `promptGuidelines`, prompt framing), update `tests/e2e.test.ts` expectations.

## Commands

```bash
npm test            # whole suite
npm run typecheck   # tsc --noEmit, must be clean before committing
npx vitest --run tests/engine.test.ts   # one file
```

Both `npm test` and `npm run typecheck` must pass before a commit. Do not commit with a failing
test or a type error and a note to fix it later.

## Commits

Small, focused, test-alongside-implementation. Message in the imperative mood, describing the
behaviour change rather than the file touched:

```
Skip iterations while the agent is busy instead of queuing them
Pause the loop when the model calls loop_break
Survive a stale extension context in timer callbacks
```

Mention the failing scenario in the body when the fix is subtle — that context is what future
readers need and what the code cannot express.
