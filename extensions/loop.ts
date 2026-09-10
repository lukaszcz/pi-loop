import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;

export type LoopCommand =
	| { kind: "list" }
	| { kind: "help" }
	| { kind: "cancel"; target: string }
	| { kind: "schedule"; intervalMs?: number; message: string }
	| { kind: "error"; message: string };

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

const DURATION = "(\\d+(?:\\.\\d+)?)\\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)";
const LEADING_DURATION_RE = new RegExp(`^${DURATION}(?:\\s+|$)`, "i");
const TRAILING_DURATION_RE = new RegExp(`^(.*?)\\s+every\\s+${DURATION}\\s*$`, "i");

export function parseDuration(value: string): number | null {
	const match = value.trim().match(new RegExp(`^${DURATION}$`, "i"));
	if (!match) return null;

	const amount = Number(match[1]);
	const multiplier = UNIT_MS[match[2].toLowerCase()];
	const milliseconds = amount * multiplier;
	if (!Number.isFinite(milliseconds) || milliseconds <= 0 || !Number.isSafeInteger(milliseconds)) return null;
	return milliseconds;
}

function validateSchedule(intervalMs: number, message: string): LoopCommand {
	if (!message.trim()) return { kind: "error", message: "A message is required after the interval." };
	if (intervalMs < MIN_INTERVAL_MS) return { kind: "error", message: "The minimum loop interval is 1 minute." };
	if (intervalMs > MAX_INTERVAL_MS) return { kind: "error", message: "The maximum loop interval is 30 days." };
	return { kind: "schedule", intervalMs, message: message.trim() };
}

/** Parse fixed schedules and model-paced loops, plus management subcommands. */
export function parseLoopCommand(args: string): LoopCommand {
	const input = args.trim();
	if (!input) return { kind: "list" };
	if (/^(?:help|--help|-h)$/i.test(input)) return { kind: "help" };
	if (/^(?:list|status)$/i.test(input)) return { kind: "list" };

	const cancel = input.match(/^(?:cancel|stop|remove)(?:\s+(.+))?$/i);
	if (cancel) {
		return cancel[1]
			? { kind: "cancel", target: cancel[1].trim().toLowerCase() }
			: { kind: "error", message: "Specify a loop ID or `all` to cancel." };
	}

	const leading = input.match(LEADING_DURATION_RE);
	if (leading) {
		const durationText = `${leading[1]}${leading[2]}`;
		const intervalMs = parseDuration(durationText);
		if (intervalMs === null) return { kind: "error", message: `Invalid interval: ${durationText}` };
		return validateSchedule(intervalMs, input.slice(leading[0].length));
	}

	const trailing = input.match(TRAILING_DURATION_RE);
	if (trailing) {
		const durationText = `${trailing[2]}${trailing[3]}`;
		const intervalMs = parseDuration(durationText);
		if (intervalMs === null) return { kind: "error", message: `Invalid interval: ${durationText}` };
		return validateSchedule(intervalMs, trailing[1]);
	}

	return { kind: "schedule", message: input };
}

export function formatDuration(milliseconds: number): string {
	const units: Array<[number, string]> = [
		[86_400_000, "day"],
		[3_600_000, "hour"],
		[60_000, "minute"],
		[1_000, "second"],
	];

	for (const [size, name] of units) {
		if (milliseconds >= size && milliseconds % size === 0) {
			const amount = milliseconds / size;
			return `${amount} ${name}${amount === 1 ? "" : "s"}`;
		}
	}
	return `${milliseconds} ms`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
	const remaining = Math.max(0, timestamp - now);
	if (remaining < 60_000) return "in <1 minute";

	const totalMinutes = Math.ceil(remaining / 60_000);
	if (totalMinutes < 60) return `in ${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;

	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (totalHours < 48) {
		const hoursText = `${totalHours} hour${totalHours === 1 ? "" : "s"}`;
		return minutes === 0 ? `in ${hoursText}` : `in ${hoursText} ${minutes} min`;
	}

	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	const daysText = `${days} day${days === 1 ? "" : "s"}`;
	return hours === 0 ? `in ${daysText}` : `in ${daysText} ${hours} hr`;
}

type LoopMode = "fixed" | "dynamic";

interface LoopTask {
	id: string;
	mode: LoopMode;
	message: string;
	intervalMs?: number;
	nextRunAt?: number;
	runs: number;
	pendingSince?: number;
	awaitingDecision: boolean;
	lastReason?: string;
	pendingDecision?: { delayMs: number; reason?: string };
	timer?: ReturnType<typeof setTimeout>;
}

const STATUS_KEY = "pi-loop";
const MAX_TIMEOUT_MS = 2_147_000_000;
const USAGE = [
	"Usage:",
	"  /loop <message>                  Run now; model chooses each next delay",
	"  /loop <interval> <message>       Run now; repeat on a fixed interval",
	"  /loop <message> every <interval>",
	"  /loop                            List active loops",
	"  /loop cancel <id|all>            Cancel loops",
	"",
	"Intervals use s, m, h, or d (minimum 1 minute).",
	"Examples:",
	"  /loop check the deploy",
	"  /loop 5m check the deploy",
	"  /loop check X every 1h",
].join("\n");

const LoopControlParams = Type.Object({
	action: Type.Unsafe<"schedule" | "stop">({
		type: "string",
		enum: ["schedule", "stop"],
		description: "Schedule the next dynamic-loop iteration or stop the loop",
	}),
	loopId: Type.Integer({ minimum: 1, description: "Dynamic loop ID from the loop instructions" }),
	delaySeconds: Type.Optional(
		Type.Integer({
			minimum: MIN_INTERVAL_MS / 1_000,
			maximum: MAX_INTERVAL_MS / 1_000,
			description: "Delay before the next iteration; required for schedule",
		}),
	),
	reason: Type.Optional(Type.String({ description: "Brief reason for this delay or for stopping" })),
});

export default function loopExtension(pi: ExtensionAPI) {
	const tasks = new Map<string, LoopTask>();
	let nextId = 1;
	let sessionContext: ExtensionContext | undefined;
	let generation = 0;
	let deliveryStarting = false;
	let runningDynamicLoopId: string | undefined;
	let pendingRetryTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTaskTimer(task: LoopTask): void {
		if (task.timer !== undefined) clearTimeout(task.timer);
		task.timer = undefined;
	}

	function clearPendingRetry(): void {
		if (pendingRetryTimer !== undefined) clearTimeout(pendingRetryTimer);
		pendingRetryTimer = undefined;
	}

	function removeTask(task: LoopTask): void {
		clearTaskTimer(task);
		tasks.delete(task.id);
		if (![...tasks.values()].some((candidate) => candidate.pendingSince !== undefined)) clearPendingRetry();
	}

	function clearAll(): void {
		for (const task of tasks.values()) clearTaskTimer(task);
		tasks.clear();
		clearPendingRetry();
	}

	function clearDeliveryGuard(): void {
		deliveryStarting = false;
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

		const deciding = [...tasks.values()].filter((task) => task.awaitingDecision).length;
		if (deciding > 0) {
			ctx.ui.setStatus(STATUS_KEY, `loop: ${tasks.size} · model deciding`);
			return;
		}
		const chosen = [...tasks.values()].filter((task) => task.pendingDecision !== undefined).length;
		if (chosen > 0) {
			ctx.ui.setStatus(STATUS_KEY, `loop: ${tasks.size} · next delay chosen`);
			return;
		}

		const next = [...tasks.values()]
			.filter((task): task is LoopTask & { nextRunAt: number } => task.nextRunAt !== undefined)
			.sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
		if (!next) {
			ctx.ui.setStatus(STATUS_KEY, `loop: ${tasks.size}`);
			return;
		}

		const due = new Date(next.nextRunAt);
		const dueTime = `${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`;
		ctx.ui.setStatus(STATUS_KEY, `loop: ${tasks.size} · next ${dueTime}`);
	}

	function dynamicInstructions(task: LoopTask): string {
		return [
			`Dynamic /loop #${task.id} is running this iteration.`,
			`After handling the user's loop message, decide whether another iteration is useful.`,
			`If it is, call loop_control with action "schedule", loopId ${task.id}, and a delaySeconds value appropriate to what you observed.`,
			`Otherwise call loop_control with action "stop" and loopId ${task.id}.`,
			`You must make exactly one of those loop_control decisions during this iteration.`,
		].join(" ");
	}

	function schedulePendingRetry(): void {
		if (pendingRetryTimer !== undefined) return;
		const retryGeneration = generation;
		pendingRetryTimer = setTimeout(() => {
			pendingRetryTimer = undefined;
			if (retryGeneration !== generation) return;
			if (![...tasks.values()].some((task) => task.pendingSince !== undefined)) return;
			deliverNextPending();
			if ([...tasks.values()].some((task) => task.pendingSince !== undefined)) schedulePendingRetry();
		}, 1_000);
		pendingRetryTimer.unref?.();
	}

	function deliverNextPending(ctx = sessionContext): void {
		if (!ctx) return;
		if (!ctx.isIdle() || deliveryStarting) {
			schedulePendingRetry();
			return;
		}
		const task = [...tasks.values()]
			.filter((candidate) => candidate.pendingSince !== undefined)
			.sort((a, b) => a.pendingSince! - b.pendingSince!)[0];
		if (!task) return;

		deliveryStarting = true;
		task.pendingSince = undefined;
		task.runs += 1;
		if (task.mode === "dynamic") {
			task.awaitingDecision = true;
			runningDynamicLoopId = task.id;
		}
		updateStatus(ctx);

		try {
			if (task.mode === "dynamic") {
				pi.sendMessage({
					customType: "pi-loop-instructions",
					content: dynamicInstructions(task),
					display: false,
				});
			}
			pi.sendMessage(
				{
					customType: "pi-loop",
					content: task.message,
					display: true,
					details: { loopId: task.id, mode: task.mode, run: task.runs },
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			task.pendingSince = Date.now();
			task.runs -= 1;
			task.awaitingDecision = false;
			if (runningDynamicLoopId === task.id) runningDynamicLoopId = undefined;
			clearDeliveryGuard();
			updateStatus(ctx);
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Loop #${task.id} could not deliver: ${message}`, "error");
			schedulePendingRetry();
		}
	}

	function scheduleTimer(task: LoopTask, taskGeneration: number): void {
		clearTaskTimer(task);
		if (task.nextRunAt === undefined) return;

		const delay = Math.min(Math.max(0, task.nextRunAt - Date.now()), MAX_TIMEOUT_MS);
		task.timer = setTimeout(() => {
			if (taskGeneration !== generation || !tasks.has(task.id) || task.nextRunAt === undefined) return;

			const now = Date.now();
			if (now < task.nextRunAt) {
				scheduleTimer(task, taskGeneration);
				return;
			}

			if (task.mode === "fixed") {
				const intervalMs = task.intervalMs!;
				const elapsedIntervals = Math.floor((now - task.nextRunAt) / intervalMs) + 1;
				task.nextRunAt += elapsedIntervals * intervalMs;
				scheduleTimer(task, taskGeneration);
			} else {
				task.nextRunAt = undefined;
				task.timer = undefined;
			}

			// Coalesce repeated fixed ticks while the agent is busy. Keeping the
			// delivery local means /loop cancel can retract it before it starts.
			task.pendingSince ??= now;
			updateStatus();
			deliverNextPending();
		}, delay);
		task.timer.unref?.();
	}

	function describeTask(task: LoopTask): string {
		let state: string;
		if (task.pendingSince !== undefined) state = "waiting to run";
		else if (task.awaitingDecision) state = "model choosing next delay";
		else if (task.pendingDecision !== undefined) state = `next delay: ${formatDuration(task.pendingDecision.delayMs)}`;
		else if (task.nextRunAt !== undefined) state = formatRelativeTime(task.nextRunAt);
		else state = "not scheduled";

		const cadence = task.mode === "fixed"
			? `every ${formatDuration(task.intervalMs!)}`
			: "self-paced";
		const reason = task.lastReason ? ` · ${task.lastReason}` : "";
		return `#${task.id} · ${cadence} · ${state} · ${task.runs} run${task.runs === 1 ? "" : "s"}${reason} · ${task.message}`;
	}

	function listTasks(ctx: ExtensionContext): void {
		if (tasks.size === 0) {
			ctx.ui.notify("No active loops.\n\n" + USAGE, "info");
			return;
		}
		const lines = [...tasks.values()]
			.sort((a, b) => Number(a.id) - Number(b.id))
			.map(describeTask);
		ctx.ui.notify(`Active loops:\n${lines.join("\n")}\n\nCancel with /loop cancel <id|all>.`, "info");
	}

	pi.on("session_start", (_event, ctx) => {
		generation += 1;
		clearAll();
		clearDeliveryGuard();
		runningDynamicLoopId = undefined;
		sessionContext = ctx;
		nextId = 1;
		updateStatus(ctx);
	});

	pi.on("agent_start", () => {
		clearDeliveryGuard();
	});

	pi.on("agent_settled", (_event, ctx) => {
		clearDeliveryGuard();

		if (runningDynamicLoopId !== undefined) {
			const task = tasks.get(runningDynamicLoopId);
			if (task?.awaitingDecision) {
				removeTask(task);
				ctx.ui.notify(`Dynamic loop #${task.id} ended without scheduling another iteration.`, "info");
			} else if (task?.pendingDecision) {
				const decision = task.pendingDecision;
				task.pendingDecision = undefined;
				task.nextRunAt = Date.now() + decision.delayMs;
				scheduleTimer(task, generation);
			}
			runningDynamicLoopId = undefined;
		}

		updateStatus(ctx);
		deliverNextPending(ctx);
	});

	pi.on("session_shutdown", () => {
		generation += 1;
		clearAll();
		clearDeliveryGuard();
		runningDynamicLoopId = undefined;
		if (sessionContext) sessionContext.ui.setStatus(STATUS_KEY, undefined);
		sessionContext = undefined;
	});

	pi.registerTool({
		name: "loop_control",
		label: "Loop Control",
		description: "Schedule the next iteration of a self-paced /loop, or stop it",
		promptSnippet: "Schedule or stop the next iteration of a self-paced /loop",
		promptGuidelines: [
			"Use loop_control only when the current turn contains dynamic /loop instructions, and make exactly one schedule-or-stop decision for that loop.",
		],
		parameters: LoopControlParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			sessionContext = ctx;
			const id = String(params.loopId);
			const task = tasks.get(id);
			if (!task) {
				return {
					content: [{ type: "text", text: `Loop #${id} is no longer active.` }],
					details: { action: params.action, loopId: id, error: "not active" },
				};
			}
			if (task.mode !== "dynamic") {
				return {
					content: [{ type: "text", text: `Loop #${id} has a fixed interval; use /loop cancel ${id} to stop it.` }],
					details: { action: params.action, loopId: id, error: "fixed interval" },
				};
			}
			if (runningDynamicLoopId !== id || !task.awaitingDecision) {
				return {
					content: [{ type: "text", text: `Loop #${id} is not awaiting a decision in this iteration.` }],
					details: { action: params.action, loopId: id, error: "stale or duplicate decision" },
				};
			}

			if (params.action === "stop") {
				task.awaitingDecision = false;
				removeTask(task);
				updateStatus(ctx);
				return {
					content: [{ type: "text", text: `Stopped dynamic loop #${id}.` }],
					details: { action: "stop", loopId: id, reason: params.reason },
				};
			}

			if (params.delaySeconds === undefined) {
				throw new Error("delaySeconds is required when action is schedule");
			}
			const delayMs = params.delaySeconds * 1_000;
			task.awaitingDecision = false;
			task.lastReason = params.reason;
			task.pendingDecision = { delayMs, reason: params.reason };
			updateStatus(ctx);
			return {
				content: [{
					type: "text",
					text: `Dynamic loop #${id} will run again ${formatDuration(delayMs)} after this iteration settles.`,
				}],
				details: {
					action: "schedule",
					loopId: id,
					delaySeconds: params.delaySeconds,
					reason: params.reason,
				},
			};
		},
	});

	pi.registerCommand("loop", {
		description: "Run a message now and repeat it on a fixed or model-chosen schedule",
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
					removeTask(task);
					updateStatus(ctx);
					ctx.ui.notify(`Cancelled loop #${id}: ${task.message}`, "info");
					return;
				}
				case "schedule": {
					const now = Date.now();
					const mode: LoopMode = command.intervalMs === undefined ? "dynamic" : "fixed";
					const task: LoopTask = {
						id: String(nextId++),
						mode,
						message: command.message,
						intervalMs: command.intervalMs,
						nextRunAt: command.intervalMs === undefined ? undefined : now + command.intervalMs,
						runs: 0,
						pendingSince: now,
						awaitingDecision: false,
					};
					tasks.set(task.id, task);
					scheduleTimer(task, generation);
					updateStatus(ctx);

					if (mode === "fixed") {
						ctx.ui.notify(
							`Loop #${task.id} running now, then every ${formatDuration(task.intervalMs!)}.\n${task.message}`,
							"info",
						);
					} else {
						ctx.ui.notify(
							`Dynamic loop #${task.id} running now. The model will choose each next delay.\n${task.message}`,
							"info",
						);
					}
					deliverNextPending(ctx);
				}
			}
		},
	});
}
