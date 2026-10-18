# pi-loop

Recurring prompt loops for [pi](https://pi.dev): run a prompt on an interval until the agent
decides the job is done.

**English** · [中文文档](README.zh-CN.md)

```
/loop 5m 检查当前项目缺陷单，看需求是否清晰：清晰就直接修复，不清晰就阻断 loop
```

The first iteration runs immediately, then every 5 minutes. When the work is finished — or blocked
on something only you can answer — the agent stops the loop itself. No further iterations fire.

## Why a loop instead of just asking once

An interval turns a single prompt into a watch. Poll a build, babysit a PR, or work through a
backlog one ticket at a time: the agent re-reads the world on each iteration and keeps going until
the condition you gave it is met.

The interesting part is the exit. A loop that only stops when you remember to stop it is a cron
job wearing a costume. `pi-loop` gives the agent a way to end the loop *deliberately*:

- **Done** — the condition is met. The loop is **removed**, so your next message cannot restart it.
- **Blocked** — it needs a decision or information it cannot invent, so it pauses the loop, asks,
  and waits. Your reply resumes it.

Those are two different endings on purpose. Pausing a finished loop looks identical to waiting for
you, and then a simple "thanks" would start the work again.

## Install

```bash
pi install npm:@luckycurve/pi-loop     # from npm
pi install git:github.com/LuckyCurve/pi-loop   # from git
pi install ./pi-loop                   # local checkout
pi -e ./extensions/loop/index.ts       # one-off, no install
```

## Commands

Two forms, nothing else:

| Command | What it does |
|---|---|
| `/loop 5m <prompt>` | Run `<prompt>` every 5 minutes, first run immediately |
| `/loop <prompt> every 20m` | Interval as a trailing clause |
| `/loop <prompt>` | No interval: the model paces itself, with a 5m fallback |
| `/loop` | Open the management panel: see, disable, or remove loops |

**No interval means self-paced.** The model picks the wait between iterations — 1 to 60 minutes —
based on what it just observed (`loop_schedule`). It is a nudge, not a lifeline: if it says nothing
on some turn, the loop simply runs again after `defaultIntervalMs` (5m). The wait is chosen during
the iteration itself, so if it runs out while the agent is still working, the next iteration happens
as soon as that work finishes — it is never counted as a missed one. Pausing, finishing, and
`Run now` all work exactly as they do on a fixed-interval loop.

There are no management subcommands — no `list`, `stop`, `pause`, or `resume` to remember. A bare
`/loop` opens a panel in the middle of the screen with one row per loop — schedule, state, and
counters. Selecting a row opens that loop's own page, which shows its instruction in full followed by
the model's reason for stopping, as two labelled blocks. The list itself carries no prose: every loop
has a different instruction, so a shared block would only show whichever row the cursor was on.

| Action | What it does |
|---|---|
| **Disable** / **Enable** | Pause the loop, or start it again. A disable is reversible; nothing is lost. |
| **Run now** | One iteration straight away. Skipped if the agent is busy, and the schedule is left exactly as it was. |
| **Remove** | Delete the loop. |
| **Back** | Return to the list. |

A prompt can be any length, so the panel never puts one in the box caption — that is a status line —
and wraps the full text into the body instead. Nothing running means no popup at all, just a short
"No loops are running." Everything else is a plain prompt: `/loop stop the deploy check` starts a
loop, it does not stop one.

The panel is a centered overlay with its own frame, not a selector sitting in the editor at the
bottom of the screen, and its countdown ticks while it is open instead of freezing at whatever it
read when you opened it. The panel ticks once a second because the countdown is the thing you opened
it to watch; the footer changes only on the :15/:30/:45/:00 marks, because a number that moves every
second competes with whatever you are reading.

All user-facing text is English — commands, notifications, the panel, the status line. Chinese lives
only in [README.zh-CN.md](README.zh-CN.md), which `tests/language.test.ts` enforces.

The panel only ever shows the loops of the **current session**. Close it, switch sessions, or fork,
and there is nothing to see — those loops are gone, not hidden.

Intervals accept `ms`, `s`, `m`, `h`, and `d` (`30s`, `5m`, `2h`, `1d`), clamped to 1 second …
7 days. A slash command in the prompt (for example `/loop 20m /review-pr 1234`) is sent to the
model as text rather than re-dispatched, so a loop can never recursively re-enter itself.

## How the agent ends a loop

The extension registers a `loop_break` tool, declared to the model **only while a loop is running**
(no loop, no wasted tool slot):

```jsonc
{ "reason": "Which environment should I target? Staging or production?" }
```

The tool takes an `outcome`:

| `outcome` | Meaning | What happens |
|---|---|---|
| `"done"` | The work is finished | The loop is **removed**; it never runs again |
| `"wait"` (default) | Blocked on something only you know | The loop is **paused**; your next message resumes it |

Picking `done` is what makes a finished loop stay finished. A paused loop resumes on any real
message, and "thanks" is not a reason to start working again.

**A failed iteration is not a stop.** A provider error, an aborted turn, or a model that ends without
choosing a wait all leave the schedule armed, so the loop tries again instead of quietly disappearing.
Only `loop_break`, removing the loop yourself, the expiry window, or closing the session end it.

The intended pattern for work that needs human input:

```
/loop 5m check the defect backlog: fix it when the requirement is clear
        ├─ clear      → fix it now
        └─ unclear    → loop_break, list the open questions, wait for me
```

## Skipping while the agent is busy

An iteration that comes due while the agent is running is **skipped, never queued**. Queuing would
silently pile work behind a long turn and then deliver all of it at once, which is neither what you
asked for nor cheap. A skip is reported once per streak, the loop retries one interval later, and
`runs` and `skips` are tracked separately so the panel and the footer show what actually happened.

## The footer

The footer is deliberately slow: it repaints every 15 seconds, not every second. It is redrawn on
every terminal update, so a second-by-second countdown would flicker under whatever you are reading,
and a minute-scale countdown does not need second precision to be useful. The panel is the opposite —
it ticks once a second, because there the countdown is what you opened it to look at.

While a loop is running, the status line shows the closest upcoming fire:

```
⟳ LOOP Task 1 · every 5m · next 2m30s · runs 4 · skips 1 · +1 more
```

A self-paced loop reads `dynamic` where a fixed one reads `every 5m`. The line is painted with the
active theme's `accent`, `muted`, and `dim` roles, so it sits at the same brightness as the rest of
the footer on both light and dark themes, and follows a theme change immediately.

## Settings

Add a `piLoop` block to `settings.json`. Every key is optional.

```jsonc
{
  "piLoop": {
    "defaultIntervalMs": 300000,   // fallback wait when a self-paced loop's model says nothing
    "maxConsecutiveSkips": 0,      // 0 = keep skipping forever; N = stop after N in a row
    "expireAfterMs": 604800000,    // 7 days; 0 = never expire
    "maxLoops": 20,                // cap on concurrent loops
    "notifyEverySkip": false,      // true = notify on every skip, not once per streak
    "statusRefreshMs": 15000       // footer countdown refresh; 0 = show the status, drop the countdown
  }
}
```

## Behaviour notes

- **Loops live in the pi process.** Close pi and they stop. There is no background daemon and no
  cloud scheduler.
- **Loops belong to the session that started them.** Quitting, starting a new session, resuming
  another one, or forking all drop the schedule: no timer may inject prompts into a different
  conversation, and a conversation that once had loops does not restart them.
- **`/reload` is the exception.** It rebuilds the same conversation in place, so loops are restored
  from a session entry (`pi-loop-state`) and the **active branch**, after waiting one interval — a
  reload never dumps a pile of stale prompts at once.
- **A paused loop stays listed** with its reason, so a long block never looks like a crash.
- **A removed loop is gone.** Nothing auto-restarts it; run `/loop` again.

## Design

The scheduling rules have no dependency on pi, which is what makes them testable without a runtime:

| File | Responsibility |
|---|---|
| `extensions/loop/index.ts` | pi wiring: commands, the `loop_break` tool, session lifecycle |
| `extensions/loop/panel-view.ts` | the panel as a terminal component: the box, its repaint timer, its height budget |
| `src/engine.ts` | scheduling, skipping, pausing, persistence — pure logic |
| `src/duration.ts` | interval parsing and formatting |
| `src/commands.ts` | `/loop` argument grammar, prompt framing, injection detection |
| `src/panel.ts` | the management panel's rows and the action each dispatches |
| `src/clock.ts` | injectable clock, so tests control time |
| `src/status.ts` | footer status line |

## Development

This project is developed test-first. See [AGENTS.md](AGENTS.md) for the working agreement.

```bash
npm install
npm test          # 223 tests
npm run typecheck
```

Test layers, cheapest first:

- `tests/duration.test.ts`, `tests/commands.test.ts`, `tests/engine.test.ts` — pure logic, no pi
  involved, time controlled by a fake clock
- `tests/extension.test.ts` — the real extension driven through a fake pi API, including
  stale-context and persistence-failure paths
- `tests/e2e.test.ts` — a real `AgentSession` with a scripted provider, verifying the assumptions
  the fakes cannot: iterations are not queued behind a running turn, prompts sent with
  `expandPromptTemplates: false` reach the model as text, `loop_break` is declared exactly while a
  loop exists, and a real user message resumes an agent-paused loop
- `tests/panel.test.ts`, `tests/panel-view.test.ts` — the panel as data (rows and actions), then the
  box that frames it and repaints its countdown
- `tests/status.test.ts` — the footer line, including how it summarises several loops
- `tests/language.test.ts` — no Chinese anywhere in `src/` or `extensions/`
- `tests/session-scope.test.ts` — real-runtime session scope: a resumed session stays inert while
  `/reload` restores
- `tests/isolation.test.ts` — the loader configuration every test uses, so `npm test` never loads
  the developer's installed extensions
- `tests/activation.test.ts` — real-runtime regression: `loop_break` is offered exactly while a
  loop exists, including after a loop ends mid-run
- `tests/triage.test.ts` — the defect-triage workflow end to end
- `tests/live.test.ts` — a real model iterating a `/loop`; skips itself when no provider is set

## Comparison with Claude Code's `/loop`

Claude Code schedules through cron tools and a bundled skill: the model calls `CronCreate`, and the
scheduler enqueues prompts between turns. `pi-loop` is an extension with a real timer, so it holds
its own scheduling state and can act on it directly.

Two deliberate differences:

1. **`loop_break` is a tool, not a convention.** Claude Code's flow relies on the model deciding to
   stop and scheduling nothing next. Here the pause is an explicit, testable operation that records
   *why* the loop stopped and resumes on your reply.
2. **Skips are counted, not silent.** Because an iteration never queues, "did the loop actually run
   while I was away?" has a real answer, visible in the `/loop` panel and the footer.

## License

MIT
