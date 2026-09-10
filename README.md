# pi-loop

A [Pi](https://pi.dev) extension for sending recurring messages to the agent, similar to Claude Code's `/loop` command.

## Usage

Schedule with either a leading interval or a trailing `every` clause:

```text
/loop 5m check the deploy
/loop check X every 1h
/loop run tests every 30 minutes
/loop 2h review src/index.ts
```

The first message is sent after one full interval. If the agent is busy when a loop fires, delivery waits until the agent settles instead of interrupting the current turn. Repeated ticks are coalesced to one pending delivery, so a slow agent cannot build an unbounded backlog.

Scheduled values are delivered as literal user messages. Slash-command expansion is intentionally disabled because Pi extension commands bypass the normal busy-agent queue; schedule the underlying instruction as plain text instead.

Intervals accept seconds, minutes, hours, and days (`s`, `m`, `h`, `d`, or long names). The minimum is 1 minute and the maximum is 30 days.

### Manage loops

```text
/loop                    # List active loops
/loop list               # List active loops
/loop cancel 2           # Cancel loop #2
/loop cancel all         # Cancel every loop
/loop help               # Show usage
```

Multiple loops can run at once. The Pi footer shows the active loop count and the next delivery time.

## Lifecycle

Loops are intentionally session-runtime scoped:

- They run only while that Pi session is open.
- Switching sessions, starting a new session, reloading extensions, or exiting Pi cancels them.
- Suspending the machine does not replay every missed tick; one overdue tick runs after wake and the normal cadence resumes.

This extension is intended for Pi's long-lived TUI and RPC modes; print and JSON modes exit before a timer can fire. It does not provide durable background scheduling. Use an operating-system or cloud scheduler when a task must survive Pi exiting.

## Install

From a local checkout:

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
