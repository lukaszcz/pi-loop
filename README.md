# pi-loop

A [Pi](https://pi.dev) extension for sending recurring messages to the agent, similar to Claude Code's `/loop` command.

## Usage

Omit the interval for model-chosen dynamic pacing, or provide a fixed interval in leading or trailing form:

```text
/loop check the deploy                 # model chooses each next delay
/loop 5m check the deploy              # fixed interval
/loop check X every 1h                 # fixed interval
/loop run tests every 30 minutes       # fixed interval
```

Every loop runs once immediately. Fixed loops then repeat at their interval. Dynamic loops ask the model after every iteration to either choose the next delay with the `loop_control` tool or stop the loop.

If the agent is busy when a loop becomes due, delivery waits until the agent settles instead of interrupting the current turn. Repeated fixed ticks are coalesced to one pending delivery, so a slow agent cannot build an unbounded backlog.

Scheduled values are delivered literally as visible loop messages to the agent. Slash-command expansion is intentionally disabled because Pi extension commands bypass the normal busy-agent queue; schedule the underlying instruction as plain text instead.

Fixed intervals and model-chosen delays accept seconds, minutes, hours, and days (`s`, `m`, `h`, `d`, or long names). The minimum is 1 minute and the maximum is 30 days.

### Manage loops

```text
/loop                    # List active loops
/loop list               # List active loops
/loop cancel 2           # Cancel loop #2
/loop cancel all         # Cancel every loop
/loop help               # Show usage
```

Multiple fixed and dynamic loops can run at once. The Pi footer shows whether a loop is waiting, the model is choosing a dynamic delay, or the next delivery time.

## Lifecycle

Loops are intentionally session-runtime scoped:

- They run only while that Pi session is open.
- Switching sessions, starting a new session, reloading extensions, or exiting Pi cancels them.
- Suspending the machine does not replay every missed tick; one overdue tick runs after wake and the normal cadence resumes.

This extension is intended for Pi's long-lived TUI and RPC modes; print and JSON modes exit before a timer can fire. It does not provide durable background scheduling. Use an operating-system or cloud scheduler when a task must survive Pi exiting.

## Install

Copy the standalone extension file into Pi's global extension directory:

```bash
cp extensions/loop.ts ~/.pi/agent/extensions/loop.ts
```

Then restart Pi or run `/reload`. Alternatively, install the package from a local checkout:

```bash
pi install /path/to/pi-loop
```

Or try it without installing:

```bash
pi --no-extensions -e /path/to/pi-loop/extensions/loop.ts
```

For project-local development, install the checkout as a local package and use `/reload` after edits:

```bash
pi install -l "$PWD"
```

## Development

Requires Node.js 22 or newer:

```bash
npm test
```

Pi loads the TypeScript source directly through jiti; no build step or runtime dependencies are required.

## License

MIT
