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

- **Done** — the condition is met, nothing left to do.
- **Blocked** — it needs a decision or information it cannot invent, so it pauses the loop, asks,
  and waits. Your reply resumes it.

That second case is what makes a loop safe to leave running. The agent stops instead of guessing.

## Install

```bash
pi install npm:@luckycurve/pi-loop     # from npm
pi install git:github.com/LuckyCurve/pi-loop   # from git
pi install ./pi-loop                   # local checkout
pi -e ./extensions/loop/index.ts       # one-off, no install
```

## Commands

| Command | What it does |
|---|---|
| `/loop 5m <prompt>` | Run `<prompt>` every 5 minutes, first run immediately |
| `/loop <prompt> every 20m` | Interval as a trailing clause |
| `/loop <prompt>` | No interval: uses `defaultIntervalMs` (10m) |
| `/loop list` | Show running loops: ids, run/skip counts, next fire time |
| `/loop stop [id\|all]` | Remove one loop or all of them |
| `/loop pause [id\|all]` | Pause without removing |
| `/loop resume [id\|all]` | Resume paused loops |

Intervals accept `ms`, `s`, `m`, `h`, and `d` (`30s`, `5m`, `2h`, `1d`), clamped to 1 second …
7 days. A slash command in the prompt (for example `/loop 20m /review-pr 1234`) is sent to the
model as text rather than re-dispatched, so a loop can never recursively re-enter itself.

## How the agent ends a loop

The extension registers a `loop_break` tool, declared to the model **only while a loop is running**
(no loop, no wasted tool slot):

```jsonc
{ "reason": "Which environment should I target? Staging or production?" }
```

Calling it **pauses** the loop rather than deleting it, records the reason in `/loop list`, and
tells the model to ask you and end its turn. **Your next message resumes the loop automatically.**
Manual resuming stays available with `/loop resume`.

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
`runs` and `skips` are tracked separately so `/loop list` shows what actually happened.

## The footer

While a loop is running, the status line shows the closest upcoming fire:

```
⟳ l1 every 5m · next 2m30s · runs 4 · skips 1 · +1 more
```

## Settings

Add a `piLoop` block to `settings.json`. Every key is optional.

```jsonc
{
  "piLoop": {
    "defaultIntervalMs": 600000,   // interval for /loop <prompt> with no explicit one
    "maxConsecutiveSkips": 0,      // 0 = keep skipping forever; N = stop after N in a row
    "expireAfterMs": 604800000,    // 7 days; 0 = never expire
    "maxLoops": 20,                // cap on concurrent loops
    "notifyEverySkip": false,      // true = notify on every skip, not once per streak
    "statusRefreshMs": 15000       // footer countdown refresh; 0 disables it
  }
}
```

## Behaviour notes

- **Loops live in the pi process.** Close pi and they stop. There is no background daemon and no
  cloud scheduler.
- **No catch-up burst.** After a resume (or `/reload`), every loop waits one interval before firing,
  so restoring a session never dumps a pile of stale prompts at once.
- **Loops survive `/reload`.** State is written to a session entry (`pi-loop-state`) and rebuilt
  from the **active branch**, so loops on an abandoned branch do not come back.
- **A paused loop stays listed** with its reason, so a long block never looks like a crash.
- **A removed loop is gone.** Nothing auto-restarts it; run `/loop` again.

## Design

The scheduling rules have no dependency on pi, which is what makes them testable without a runtime:

| File | Responsibility |
|---|---|
| `extensions/loop/index.ts` | pi wiring: commands, the `loop_break` tool, session lifecycle |
| `src/engine.ts` | scheduling, skipping, pausing, persistence — pure logic |
| `src/duration.ts` | interval parsing and formatting |
| `src/commands.ts` | `/loop` argument grammar, prompt framing, injection detection |
| `src/clock.ts` | injectable clock, so tests control time |
| `src/status.ts` | footer status line |

## Development

This project is developed test-first. See [AGENTS.md](AGENTS.md) for the working agreement.

```bash
npm install
npm test          # 66 tests
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
   while I was away?" has a real answer, visible in `/loop list` and the footer.

## License

MIT
