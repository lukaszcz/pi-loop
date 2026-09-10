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
	if (!message.trim()) {
		return { kind: "error", message: "A message is required after the interval." };
	}
	if (intervalMs < MIN_INTERVAL_MS) {
		return { kind: "error", message: "The minimum loop interval is 1 minute." };
	}
	if (intervalMs > MAX_INTERVAL_MS) {
		return { kind: "error", message: "The maximum loop interval is 30 days." };
	}
	return { kind: "schedule", intervalMs, message: message.trim() };
}

/** Parse both `/loop 5m check X` and `/loop check X every 5 minutes`. */
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
