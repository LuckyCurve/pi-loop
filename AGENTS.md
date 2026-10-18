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
| Pure logic | `tests/duration.test.ts`, `tests/commands.test.ts`, `tests/engine.test.ts`, `tests/status.test.ts` | Scheduling rules, parsing, status text, state transitions. No pi, no I/O, fake clock. |
| Extension contract | `tests/extension.test.ts` | Command/tool wiring, lifecycle, error paths (stale context, persistence failure) through a fake pi API. Dialog answers come from `tests/helpers/scripted-ui.ts`, which drives the real `SelectList` with arrow/enter keys rather than stubbing the choice. |
| Real runtime | `tests/e2e.test.ts` | Anything that depends on real pi behaviour: idleness, injected-prompt delivery, tool activation, resume-after-pause. |
| Activation | `tests/activation.test.ts` | Which tools the model is actually offered, asserted against the real runtime. |
| Workflow | `tests/triage.test.ts` | The end-to-end user story the feature exists for. |
| Real model | `tests/live.test.ts` | A genuine model iterating a loop. Skips itself with no provider configured. |
| Panel | `tests/panel.test.ts`, `tests/panel-view.test.ts` | The management panel: its rows and actions as data, then the box that frames them and repaints its countdown. No pi session. |
| Language | `tests/language.test.ts` | No Chinese anywhere in `src/` or `extensions/`. |
| Session scope | `tests/session-scope.test.ts` | A resumed session stays inert; `/reload` restores. Real runtime, because it depends on pi's branch reconstruction. |
| Isolation | `tests/isolation.test.ts` | Every test helper loads this extension and nothing else. |

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
- **A stale tool-loadout snapshot resurrecting `loop_break`** (`tests/activation.test.ts`). A run
  that is already in flight re-applies the loadout it snapshotted while building its request, so a
  loop that ends mid-run would leave `loop_break` declared after the loop was gone. The intended
  set is therefore re-asserted in `agent_start`, not only on engine change.

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
  ignored, never propagated. `notify` is on that path too: a skip reports, so it can run inside a
  timer callback and must swallow a stale context like everything else there.
- **Loops belong to one session.** Only `session_start` with `reason: "reload"` restores from the
  branch. Startup, new, resume, and fork open a different conversation, and a timer from another
  conversation must never inject into it.
- **One panel, two dialogs.** `/loop` has no subcommands: a bare `/loop` opens the panel, and
  everything else is a prompt. The panel is a `SelectList` in interactive mode (schedule on the left,
  prompt on the right) and `ctx.ui.select()` everywhere else, because RPC cannot render custom
  components. Both paths dispatch the same `src/panel.ts` actions.
- **The panel is a framed, centered overlay.** It opens with `ctx.ui.custom(factory, { overlay: true,
  overlayOptions: { anchor: "center" } })`, and `extensions/loop/panel-view.ts` draws the frame and
  pads every line to the box width. Without `overlay`, `custom()` renders in the editor slot at the
  bottom; without the frame and padding, the overlay composites against the transcript behind it and
  has no edge. No row changes either way, so nothing else would notice:
  `tests/helpers/scripted-ui.ts` records the option and `tests/panel-view.test.ts` pins the box.
- **The model's words and the user's instruction are labelled, never merged.** The panel's detail
  block prints `Stopped:` (the model's `breakReason`) and `Instruction` (the original prompt) as two
  labelled blocks. Concatenated, a model's reply reads like the user's own request.
- **A list is a list.** `loopOptions` rows carry schedule, state, and counters only. The instruction
  and the model's reason are per-loop prose and live on that loop's own page (`loopDetail`), ordered
  instruction-first because the reply is the response to it, each under its own label. A shared
  detail block on the list showed whichever loop the cursor happened to be on.
- **The caption is a status line, never the prompt.** `loopHeading` is short by construction; the
  prompt reaches the panel through `loopDetail`, wrapped into the detail block below the rows. A
  prompt drawn into the border has no length limit and eats the whole line, leaving the box with no
  top edge. `tests/panel.test.ts` asserts the caption cannot contain a prompt.
- **Two endings, not one.** `loop_break` with `outcome: "done"` removes the loop; the default
  `"wait"` pauses it and any real user message resumes it. A single "stop" that pauses would make a
  finished loop indistinguishable from a blocked one, and the user's next message would restart
  finished work.
- **A loop is named `Task N`, never `l1`.** The stored id is a key, not a label. `loopLabel()` in
  `src/engine.ts` is the only place that turns one into the other, and every user-facing surface
  (status line, notifications, panel, tool text) goes through it.
- **Self-pacing is a nudge, not a lifeline.** `/loop <prompt>` with no interval sets `pacing: "self"`:
  the model calls `loop_schedule` each turn and `intervalMs` remains the fallback when it does not.
  Anything that makes the loop *depend* on that call — dying when it is skipped — turns a forgotten
  turn into a silent stop. `fireDue` always resets `pacedFor` and re-arms from `intervalMs`.
- **`loop_schedule` is declared only for a self-paced loop.** A fixed interval has no wait to choose,
  so offering the tool would invite a call that must be refused.
- **The injection header states the pacing, because it is the model's only context.** A self-paced
  loop's header reads `dynamic, you pick the next wait`; `every 5m` would read as a fixed cadence the
  model has no say in, and it would never call `loop_schedule`. `isLoopInjection` matches both forms,
  so a rescheduled loop's own prompt is still recognised as an iteration rather than user input.
- **Run now is a nudge, not a resume.** `LoopEngine.runNow` injects one iteration and leaves `nextAt`,
  the skip counters, and the paused state untouched, so a manual run never resets the rhythm or hides
  a missed iteration. It skips while the agent is busy, like any other iteration.
- **The panel repaints itself.** pi only repaints on input and events, so a countdown in an open
  overlay freezes unless a timer asks for a repaint. `panel-view.ts` owns that timer and clears it
  from `dispose()`, which pi calls when the dialog closes.
- **The extension owns the panel it opened.** pi calls `dispose()` when a dialog closes normally, but
  its teardown path only *hides* the overlay, so a panel open across a session switch would leave a
  repaint timer running for the life of the process. `disposeEngine()` disposes it too.
- **The footer changes on the mark, not on a cadence.** `footerCountdown` snaps to the 15s grid and
  `msUntilFooterChange` arms the timer for exactly that long, so the status line never redraws an
  unchanged number. The panel is the opposite surface: it ticks every second, because the countdown
  is what the user opened it to watch.
- **Never display a value nothing repaints.** Both the footer and the panel show countdowns; when the
  refresh that would tick one is switched off (`statusRefreshMs: 0`), the countdown has to go with
  it. A frozen number keeps claiming a time that has already passed.
- **User-facing text is English.** Commands, the panel, notifications, and the status line are all
  English; Chinese lives only in `README.zh-CN.md`. A mixed message (an English prefix in front of a
  Chinese `reason`) is what this avoids; do not reintroduce per-string translations.
  `tests/language.test.ts` enforces this over `src/` and `extensions/`, because the rule is
  invisible to every other test — a Chinese label renders perfectly well.
- **Tests must not load the developer's extensions.** Every `DefaultResourceLoader` in `tests/`
  passes `noExtensions: true`. Without it the suite merges the global `settings.json` packages,
  which plays notification sounds on every `agent_end` and makes timing depend on the machine.
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
