import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../extensions/loop.ts";

interface Harness {
	command: { handler: (args: string, ctx: unknown) => Promise<void> };
	emit: (name: string, ctx: unknown) => void;
	sent: Array<{ content: string; options: unknown }>;
	notifications: string[];
	statuses: Array<string | undefined>;
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
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	let command: Harness["command"] | undefined;
	let idle = true;
	const sent: Harness["sent"] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];

	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => void) {
			handlers.set(name, handler);
		},
		registerCommand(_name: string, options: Harness["command"]) {
			command = options;
		},
		sendUserMessage(content: string, options: unknown) {
			sent.push({ content, options });
		},
	};

	const ctx = {
		isIdle: () => idle,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	loopExtension(pi as never);
	assert.ok(command);
	return {
		command,
		emit(name, eventCtx) {
			const handler = handlers.get(name);
			assert.ok(handler, `missing ${name} handler`);
			handler({}, eventCtx);
		},
		sent,
		notifications,
		statuses,
		ctx,
		setIdle(value) {
			idle = value;
		},
	};
}

test("delivers the first message after one interval", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);

	await harness.command.handler("1m check X", harness.ctx);
	assert.equal(harness.sent.length, 0);

	t.mock.timers.tick(59_999);
	assert.equal(harness.sent.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(harness.sent, [{ content: "check X", options: undefined }]);
});

test("serializes loops that become due together", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);

	await harness.command.handler("1m check A", harness.ctx);
	await harness.command.handler("1m check B", harness.ctx);
	t.mock.timers.tick(60_000);
	assert.equal(harness.sent.length, 1);

	harness.emit("before_agent_start", harness.ctx);
	harness.setIdle(false);
	harness.emit("agent_start", harness.ctx);
	harness.setIdle(true);
	harness.emit("agent_settled", harness.ctx);
	assert.equal(harness.sent.length, 2);
	assert.deepEqual(harness.sent.map((item) => item.content), ["check A", "check B"]);
});

test("coalesces busy ticks and delivers once after the agent settles", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);
	harness.setIdle(false);

	await harness.command.handler("1m check X", harness.ctx);
	t.mock.timers.tick(180_000);
	assert.equal(harness.sent.length, 0);

	harness.setIdle(true);
	harness.emit("agent_settled", harness.ctx);
	assert.equal(harness.sent.length, 1);
});

test("cancelling retracts a pending delivery and shutdown clears timers", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	const harness = createHarness();
	harness.emit("session_start", harness.ctx);
	harness.setIdle(false);

	await harness.command.handler("1m check X", harness.ctx);
	t.mock.timers.tick(60_000);
	await harness.command.handler("cancel 1", harness.ctx);
	harness.setIdle(true);
	harness.emit("agent_settled", harness.ctx);
	assert.equal(harness.sent.length, 0);

	await harness.command.handler("1m check Y", harness.ctx);
	harness.emit("session_shutdown", harness.ctx);
	t.mock.timers.tick(120_000);
	assert.equal(harness.sent.length, 0);
});
