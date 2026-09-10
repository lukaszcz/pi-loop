import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../extensions/loop.ts";

interface SentMessage {
	content: string;
	display: boolean;
	options: unknown;
}

interface Harness {
	command: { handler: (args: string, ctx: unknown) => Promise<void> };
	tool: { execute: (...args: unknown[]) => Promise<unknown> };
	emit: (name: string, ctx: unknown, event?: unknown) => unknown;
	sent: SentMessage[];
	notifications: string[];
	ctx: {
		isIdle: () => boolean;
		ui: {
			notify: (message: string) => void;
			setStatus: (_key: string, value: string | undefined) => void;
		};
	};
	setIdle: (value: boolean) => void;
}

function createHarness(): Harness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let command: Harness["command"] | undefined;
	let tool: Harness["tool"] | undefined;
	let idle = true;
	const sent: SentMessage[] = [];
	const notifications: string[] = [];

	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand(_name: string, options: Harness["command"]) {
			command = options;
		},
		registerTool(options: Harness["tool"]) {
			tool = options;
		},
		sendMessage(message: { content: string; display: boolean }, options: unknown) {
			sent.push({ content: message.content, display: message.display, options });
		},
	};

	const ctx = {
		isIdle: () => idle,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
		},
	};

	loopExtension(pi as never);
	assert.ok(command);
	assert.ok(tool);
	return {
		command,
		tool,
		emit(name, eventCtx, event = {}) {
			const handler = handlers.get(name);
			assert.ok(handler, `missing ${name} handler`);
			return handler(event, eventCtx);
		},
		sent,
		notifications,
		ctx,
		setIdle(value) {
			idle = value;
		},
	};
}

function startCurrentRun(harness: Harness): void {
	harness.setIdle(false);
	harness.emit("agent_start", harness.ctx);
}

function settleCurrentRun(harness: Harness): void {
	harness.setIdle(true);
	harness.emit("agent_settled", harness.ctx);
}

function visibleMessages(harness: Harness): SentMessage[] {
	return harness.sent.filter((message) => message.display);
}

test("fixed loops run immediately and again after one interval", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);

	await harness.command.handler("1m check X", harness.ctx);
	assert.deepEqual(visibleMessages(harness), [
		{ content: "check X", display: true, options: { triggerTurn: true } },
	]);
	startCurrentRun(harness);
	settleCurrentRun(harness);

	t.mock.timers.tick(59_999);
	assert.equal(visibleMessages(harness).length, 1);
	t.mock.timers.tick(1);
	assert.equal(visibleMessages(harness).length, 2);
	assert.equal(visibleMessages(harness)[1].content, "check X");
});

test("busy fixed-loop ticks coalesce until the agent settles", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);
	harness.setIdle(false);

	await harness.command.handler("1m check X", harness.ctx);
	t.mock.timers.tick(180_000);
	assert.equal(visibleMessages(harness).length, 0);

	settleCurrentRun(harness);
	assert.equal(visibleMessages(harness).length, 1);
});

test("pending delivery notices idle transitions without agent_settled", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);
	harness.setIdle(false);

	await harness.command.handler("check the deploy", harness.ctx);
	assert.equal(visibleMessages(harness).length, 0);
	harness.setIdle(true);
	t.mock.timers.tick(1_000);
	assert.equal(visibleMessages(harness).length, 1);
});

test("dynamic loops run immediately and arm their chosen delay after settling", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);

	await harness.command.handler("check the deploy", harness.ctx);
	assert.equal(visibleMessages(harness)[0].content, "check the deploy");
	assert.ok(harness.sent.some((message) => !message.display && message.content.includes("loop_control")));
	startCurrentRun(harness);

	await harness.tool.execute(
		"call-1",
		{ action: "schedule", loopId: 1, delaySeconds: 120, reason: "deployment still running" },
		undefined,
		undefined,
		harness.ctx,
	);
	// The delay does not run while the current iteration is still active.
	t.mock.timers.tick(120_000);
	assert.equal(visibleMessages(harness).length, 1);
	settleCurrentRun(harness);

	t.mock.timers.tick(119_999);
	assert.equal(visibleMessages(harness).length, 1);
	t.mock.timers.tick(1);
	assert.equal(visibleMessages(harness).length, 2);
});

test("loop_control rejects stale and duplicate decisions", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);
	await harness.command.handler("check the deploy", harness.ctx);
	startCurrentRun(harness);

	await harness.tool.execute("call-1", { action: "schedule", loopId: 1, delaySeconds: 60 }, undefined, undefined, harness.ctx);
	const duplicate = await harness.tool.execute(
		"call-2",
		{ action: "schedule", loopId: 1, delaySeconds: 120 },
		undefined,
		undefined,
		harness.ctx,
	) as { details?: { error?: string } };
	assert.equal(duplicate.details?.error, "stale or duplicate decision");
});

test("a dynamic loop ends when the model does not schedule another iteration", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);

	await harness.command.handler("check the deploy", harness.ctx);
	startCurrentRun(harness);
	settleCurrentRun(harness);

	assert.ok(harness.notifications.some((message) => message.includes("ended without scheduling")));
	t.mock.timers.tick(300_000);
	assert.equal(visibleMessages(harness).length, 1);
});

test("cancelling clears future fixed-loop timers", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);

	await harness.command.handler("1m check X", harness.ctx);
	startCurrentRun(harness);
	settleCurrentRun(harness);
	await harness.command.handler("cancel 1", harness.ctx);
	t.mock.timers.tick(120_000);
	assert.equal(visibleMessages(harness).length, 1);
});
