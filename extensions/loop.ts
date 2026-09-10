import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatDuration,
	formatRelativeTime,
	parseLoopCommand,
} from "./schedule.ts";

interface LoopTask {
	id: string;
	message: string;
	intervalMs: number;
	nextRunAt: number;
	runs: number;
	pendingSince?: number;
	timer?: ReturnType<typeof setTimeout>;
}

const STATUS_KEY = "pi-loop";
const MAX_TIMEOUT_MS = 2_147_000_000;
const USAGE = [
	"Usage:",
	"  /loop <interval> <message>",
	"  /loop <message> every <interval>",
	"  /loop                         List active loops",
	"  /loop cancel <id|all>         Cancel loops",
	"",
	"Intervals use s, m, h, or d (minimum 1 minute).",
	"Examples:",
	"  /loop 5m check the deploy",
	"  /loop check X every 1h",
	"  /loop 30m review src/index.ts",
].join("\n");

export default function loopExtension(pi: ExtensionAPI) {
	const tasks = new Map<string, LoopTask>();
	let nextId = 1;
	let sessionContext: ExtensionContext | undefined;
	let generation = 0;
	let deliveryStarting = false;
	let startingTaskId: string | undefined;

	function clearTask(task: LoopTask): void {
		if (task.timer !== undefined) clearTimeout(task.timer);
		task.timer = undefined;
	}

	function clearAll(): void {
		for (const task of tasks.values()) clearTask(task);
		tasks.clear();
	}

	function clearDeliveryGuard(): void {
		deliveryStarting = false;
		startingTaskId = undefined;
	}

	function updateStatus(ctx = sessionContext): void {
		if (!ctx) return;
		if (tasks.size === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const pending = [...tasks.values()].filter((task) => task.pendingSince !== undefined).length;
		if (pending > 0) {
			ctx.ui.setStatus(STATUS_KEY, `loop: ${tasks.size} · ${pending} waiting`);
			return;
		}

		const next = [...tasks.values()].sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
		const due = new Date(next.nextRunAt);
		const dueTime = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
		ctx.ui.setStatus(STATUS_KEY, `loop: ${tasks.size} · next ${dueTime}`);
	}

	function deliverNextPending(ctx = sessionContext): void {
		if (!ctx?.isIdle() || deliveryStarting) return;
		const task = [...tasks.values()]
			.filter((candidate) => candidate.pendingSince !== undefined)
			.sort((a, b) => a.pendingSince! - b.pendingSince!)[0];
		if (!task) return;

		deliveryStarting = true;
		startingTaskId = task.id;
		try {
			// Keep expansion disabled so every scheduled value is an actual user
			// message. In particular, Pi extension commands otherwise bypass its
			// message queue and execute immediately.
			pi.sendUserMessage(task.message);
		} catch (error) {
			clearDeliveryGuard();
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Loop #${task.id} could not deliver: ${message}`, "error");
			return;
		}

		// ExtensionAPI delivery is fire-and-forget. Keep the task pending and the
		// start guard locked until the agent lifecycle confirms that Pi accepted it.
	}

	function scheduleTimer(task: LoopTask, taskGeneration: number): void {
		clearTask(task);
		const delay = Math.min(Math.max(0, task.nextRunAt - Date.now()), MAX_TIMEOUT_MS);
		task.timer = setTimeout(() => {
			if (taskGeneration !== generation || !tasks.has(task.id)) return;

			const now = Date.now();
			if (now < task.nextRunAt) {
				scheduleTimer(task, taskGeneration);
				return;
			}

			// Preserve the cadence, but skip missed ticks after sleep instead of flooding
			// the agent with catch-up messages.
			const elapsedIntervals = Math.floor((now - task.nextRunAt) / task.intervalMs) + 1;
			task.nextRunAt += elapsedIntervals * task.intervalMs;
			scheduleTimer(task, taskGeneration);

			// Coalesce repeated ticks while the agent is busy. Keeping the pending
			// delivery here (instead of Pi's queue) means /loop cancel can retract it.
			task.pendingSince ??= now;
			updateStatus();
			deliverNextPending();
		}, delay);

		// A loop should live only as long as its Pi session; it should not keep a
		// headless Node process alive on its own.
		task.timer.unref?.();
	}

	function listTasks(ctx: ExtensionContext): void {
		if (tasks.size === 0) {
			ctx.ui.notify("No active loops.\n\n" + USAGE, "info");
			return;
		}

		const lines = [...tasks.values()]
			.sort((a, b) => Number(a.id) - Number(b.id))
			.map((task) => {
				const state = task.pendingSince === undefined
					? formatRelativeTime(task.nextRunAt)
					: "waiting for agent to become idle";
				return `#${task.id} · every ${formatDuration(task.intervalMs)} · ${state} · ${task.runs} run${task.runs === 1 ? "" : "s"} · ${task.message}`;
			});
		ctx.ui.notify(`Active loops:\n${lines.join("\n")}\n\nCancel with /loop cancel <id|all>.`, "info");
	}

	pi.on("session_start", (_event, ctx) => {
		generation += 1;
		clearAll();
		clearDeliveryGuard();
		sessionContext = ctx;
		nextId = 1;
		updateStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (startingTaskId === undefined) return;
		const task = tasks.get(startingTaskId);
		if (!task) return;
		task.pendingSince = undefined;
		task.runs += 1;
		updateStatus(ctx);
	});

	pi.on("agent_start", () => {
		clearDeliveryGuard();
	});

	pi.on("agent_settled", (_event, ctx) => {
		clearDeliveryGuard();
		deliverNextPending(ctx);
	});

	pi.on("session_shutdown", () => {
		generation += 1;
		clearAll();
		clearDeliveryGuard();
		if (sessionContext) sessionContext.ui.setStatus(STATUS_KEY, undefined);
		sessionContext = undefined;
	});

	pi.registerCommand("loop", {
		description: "Send a message to the agent on a recurring interval",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "help", label: "help", description: "Show usage" },
				{ value: "list", label: "list", description: "List active loops" },
				{ value: "cancel all", label: "cancel all", description: "Cancel every loop" },
				...[...tasks.keys()].map((id) => ({
					value: `cancel ${id}`,
					label: `cancel ${id}`,
					description: "Cancel this loop",
				})),
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			sessionContext = ctx;
			const command = parseLoopCommand(args);

			switch (command.kind) {
				case "help":
					ctx.ui.notify(USAGE, "info");
					return;

				case "list":
					listTasks(ctx);
					return;

				case "error":
					ctx.ui.notify(`${command.message}\n\n${USAGE}`, "warning");
					return;

				case "cancel": {
					if (command.target === "all") {
						const count = tasks.size;
						clearAll();
						updateStatus(ctx);
						ctx.ui.notify(count === 0 ? "No active loops." : `Cancelled ${count} loop${count === 1 ? "" : "s"}.`, "info");
						return;
					}

					const id = command.target.replace(/^#/, "");
					const task = tasks.get(id);
					if (!task) {
						ctx.ui.notify(`Loop #${id} was not found.`, "warning");
						return;
					}
					clearTask(task);
					tasks.delete(id);
					updateStatus(ctx);
					ctx.ui.notify(`Cancelled loop #${id}: ${task.message}`, "info");
					return;
				}

				case "schedule": {
					const now = Date.now();
					const task: LoopTask = {
						id: String(nextId++),
						message: command.message,
						intervalMs: command.intervalMs,
						nextRunAt: now + command.intervalMs,
						runs: 0,
					};
					tasks.set(task.id, task);
					scheduleTimer(task, generation);
					updateStatus(ctx);
					ctx.ui.notify(
						`Loop #${task.id} scheduled every ${formatDuration(task.intervalMs)}. First run ${formatRelativeTime(task.nextRunAt)}.\n${task.message}`,
						"info",
					);
				}
			}
		},
	});
}
