# pi-loop

为 [pi](https://pi.dev) 提供循环执行能力的扩展：按固定间隔反复执行一段 prompt，直到 Agent 自己判断任务完成或需要你介入。

[English](README.md) · **中文**

```
/loop 5m 检查当前项目缺陷单，看需求是否清晰：清晰就直接修复，不清晰就阻断 loop
```

第一次立即执行，之后每 5 分钟一次。任务完成 —— 或卡在只有你能回答的问题上 —— 时，Agent 会主动结束循环，不再触发后续迭代。

## 为什么不只是问一次

固定间隔把一次性提问变成持续观察：轮询构建、盯 PR、逐条消化缺陷单。Agent 每轮重新读取当前状态，持续推进，直到你给的条件被满足。

关键在**如何退出**。只能靠你手动去停的循环，本质上是个伪装成循环的定时任务。`pi-loop` 让 Agent 有办法**主动**结束循环：

- **完成** —— 条件已满足，无事可做
- **受阻** —— 需要决策或它无法凭空得知的信息，于是暂停循环、向你提问并等待；你回复后自动恢复

第二种情况才是循环敢于放着不管的前提：Agent 会停下来，而不是猜。

## 安装

```bash
pi install npm:@luckycurve/pi-loop          # 从 npm 安装
pi install git:github.com/LuckyCurve/pi-loop  # 从 git 安装
pi install ./pi-loop                        # 本地目录
pi -e ./extensions/loop/index.ts            # 临时试用，无需安装
```

## 命令

只有两种形态，没有别的：

| 命令 | 说明 |
|---|---|
| `/loop 5m <prompt>` | 每 5 分钟执行一次，首次立即执行 |
| `/loop <prompt> every 20m` | 间隔写在句尾 |
| `/loop <prompt>` | 不写间隔：使用 `defaultIntervalMs`（默认 10 分钟） |
| `/loop` | 打开管理面板：查看、禁用、删除循环 |

没有管理子命令 —— 不需要记 `list`、`stop`、`pause`、`resume`。单独输入 `/loop` 会在**屏幕中间**弹出面板：每个循环一行（间隔、状态、次数），下方完整显示当前高亮那个循环的 prompt（自动换行）。选中某行后可选：

| 操作 | 说明 |
|---|---|
| **Disable** / **Enable** | 暂停循环，或重新开始。禁用可逆，不丢东西。 |
| **Run now** | 立即执行一次。Agent 正在运行就跳过，且**完全不影响原有定时**。 |
| **Remove** | 删除循环。 |
| **Back** | 返回列表。 |

prompt 长度不限，所以它永远不会被放进弹窗标题（标题是状态行），而是换行显示在框内正文里。没有循环时不弹窗，只提示 `No loops are running.`。其余一切都会被当成 prompt：`/loop stop the deploy check` 是启动一个循环，不是停止循环。

面板是带边框的居中弹窗（不是编辑器底部那种选择器），打开期间倒计时会自己跳动，不会停在打开那一刻的时间上。

界面文案一律英文（见下方「界面语言」）。

面板只显示**当前会话**的循环。关闭会话、切换会话或 fork 之后，它就什么都没有了 —— 那些循环是没了，不是被藏起来了。

间隔支持 `ms`、`s`、`m`、`h`、`d`（如 `30s`、`5m`、`2h`、`1d`），会被限制在 1 秒至 7 天之间。prompt 里以 `/` 开头的斜杠命令（例如 `/loop 20m /review-pr 1234`）会作为**文本**送给模型，不会二次派发，因此循环不可能递归地再次进入自己。

## Agent 如何结束循环

扩展注册了一个 `loop_break` 工具，**仅在循环运行期间**才声明给模型（没有循环就不占用工具位）：

```jsonc
{ "reason": "目标环境是哪个？staging 还是 production？" }
```

调用它是**暂停**循环而不会删除：原因记录在 `/loop` 面板里，模型被要求向你提问并结束当前回合。**你的下一条消息会自动恢复循环**，也可以在面板里手动重新启用。

需要人工输入的任务，标准用法：

```
/loop 5m 检查缺陷单，需求清晰就修复
        ├─ 清晰   → 直接修复
        └─ 不清晰 → loop_break，列出待确认问题，等我回答
```

## 忙时跳过

到点但 Agent 正在执行时，本次迭代**直接跳过，绝不排队**。排队会把工作悄悄堆在一个长回合后面，然后一次性全部灌进去 —— 既不是你想要的，也不便宜。跳过每次连续只会提示一次，循环在一个间隔后重试，`runs` 与 `skips` 分开统计，在面板和状态栏里都能看到真实发生的事。

## 状态栏

循环运行期间，状态栏显示最近一次触发时间：

```
⟳ LOOP l1 · every 5m · next 2m30s · runs 4 · skips 1 · +1 more
```

## 配置

在 `settings.json` 中加入 `piLoop` 块，所有键都是可选的。

```jsonc
{
  "piLoop": {
    "defaultIntervalMs": 600000,   // /loop <prompt> 未指定间隔时使用
    "maxConsecutiveSkips": 0,      // 0 = 一直跳过；N = 连续跳过 N 次后自动停止
    "expireAfterMs": 604800000,    // 7 天后过期；0 = 不过期
    "maxLoops": 20,                // 并发循环上限
    "notifyEverySkip": false,      // true = 每次跳过都提示（默认每段连续跳过只提示一次）
    "statusRefreshMs": 15000       // 状态栏倒计时刷新频率；0 = 不刷新
  }
}
```

## 行为说明

- **循环活在 pi 进程里。** 关掉 pi 就停止，没有后台守护进程，也没有云端调度。
- **循环属于启动它的那个会话。** 退出、新建会话、切换到别的会话、fork，都会丢掉调度：不会有定时器把 prompt 注入到另一段对话，曾经有循环的对话也不会自己重启它们。
- **`/reload` 是唯一例外。** 它原地重建同一段对话，所以会从 session 条目（`pi-loop-state`）的**当前分支**恢复循环，并先等一个完整间隔，绝不会一次性把过期 prompt 全部倾倒出来。
- **暂停的循环仍然可见**，并带着暂停原因，长期阻塞不会看起来像崩溃。
- **被删除的循环就是删除了。** 不会自动重启，需要重新运行 `/loop`。

## 设计

调度规则不依赖 pi，这正是它们能在无运行时环境下被测试的原因：

| 文件 | 职责 |
|---|---|
| `extensions/loop/index.ts` | pi 接线：命令、`loop_break` 工具、会话生命周期 |
| `extensions/loop/panel-view.ts` | 面板的终端组件：盒子、自己的重绘定时器、高度预算 |
| `src/engine.ts` | 调度、跳过、暂停、持久化 —— 纯逻辑 |
| `src/duration.ts` | 间隔解析与格式化 |
| `src/commands.ts` | `/loop` 参数语法、prompt 包装、注入识别 |
| `src/panel.ts` | 管理面板的行，以及每行派发的动作 |
| `src/clock.ts` | 可注入时钟，让测试掌控时间 |
| `src/status.ts` | 状态栏 |

## 开发

本项目采用测试先行（TDD）开发，详见 [AGENTS.md](AGENTS.md)。

```bash
npm install
npm test          # 156 个测试
npm run typecheck
```

测试分层，由便宜到昂贵：

- `tests/duration.test.ts`、`tests/commands.test.ts`、`tests/engine.test.ts` —— 纯逻辑，不涉及 pi，时间由假时钟控制
- `tests/extension.test.ts` —— 用假 pi API 驱动真实扩展，覆盖上下文失效、持久化失败等路径
- `tests/e2e.test.ts` —— 真实 `AgentSession` + 脚本化 provider，验证假件无法保证的前提：迭代不会排在运行中的回合之后、`expandPromptTemplates: false` 的 prompt 以文本送达模型、`loop_break` 恰好在存在循环时声明、真实用户消息能恢复被 Agent 暂停的循环
- `tests/activation.test.ts` —— 真实运行时回归：`loop_break` 仅在存在循环时暴露，循环在运行中途结束时也能正确撤下
- `tests/triage.test.ts` —— 缺陷单分流工作流的端到端验证
- `tests/live.test.ts` —— 真实模型跑 `/loop`；未配置 provider 时自动跳过
- `tests/panel.test.ts`、`tests/panel-view.test.ts` —— 先是面板的数据（行与动作），再是框住它的盒子与自刷新倒计时
- `tests/status.test.ts` —— 状态栏，含多条循环时的汇总口径
- `tests/language.test.ts` —— `src/` 与 `extensions/` 里不得出现中文
- `tests/session-scope.test.ts` —— 真实运行时的会话作用域：恢复会话保持静止，`/reload` 才恢复
- `tests/isolation.test.ts` —— 所有测试共用的 loader 配置，保证 `npm test` 不会加载开发者本机安装的扩展

## 界面语言

pi 里的一切用户可见文案都是英文：命令描述、面板、通知、状态栏。中文只出现在本文档里。这样可以避免同一条消息里出现两种语言（Agent 给出的 `reason` 是中文时尤其明显），也不需要维护一套翻译。`tests/language.test.ts` 会扫描 `src/` 与 `extensions/` 强制这条规则 —— 它曾经漏检过一次。

## 与 Claude Code `/loop` 的差异

Claude Code 通过 cron 工具 + 内置 skill 实现：模型调用 `CronCreate`，调度器在回合之间把 prompt 入队。`pi-loop` 是一个持有真实定时器的扩展，自己管理调度状态并能直接对其作出反应。

两个有意的差异：

1. **`loop_break` 是工具，不是约定。** Claude Code 依赖模型自己决定不再排下一次执行；这里暂停是一个明确的、可测试的操作，会记录**为什么**停止，并在你回复后恢复。
2. **跳过会被计数，而不是静默。** 由于迭代从不排队，「我不在时循环到底跑了没有」有确切答案，在 `/loop` 面板和状态栏都能看到。

## 许可证

MIT
