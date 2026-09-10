import assert from "node:assert/strict";
import test from "node:test";
import {
	formatDuration,
	formatRelativeTime,
	parseDuration,
	parseLoopCommand,
} from "../extensions/schedule.ts";

test("parseDuration supports short and long units", () => {
	assert.equal(parseDuration("60s"), 60_000);
	assert.equal(parseDuration("5 minutes"), 300_000);
	assert.equal(parseDuration("1.5h"), 5_400_000);
	assert.equal(parseDuration("2 DAYS"), 172_800_000);
});

test("parseDuration rejects malformed and unsafe durations", () => {
	assert.equal(parseDuration(""), null);
	assert.equal(parseDuration("five minutes"), null);
	assert.equal(parseDuration("1h30m"), null);
	assert.equal(parseDuration("0m"), null);
	assert.equal(parseDuration("999999999999999999d"), null);
});

test("parses a leading compact interval", () => {
	assert.deepEqual(parseLoopCommand("5m check the deploy"), {
		kind: "schedule",
		intervalMs: 300_000,
		message: "check the deploy",
	});
});

test("parses a leading long-form interval and slash command", () => {
	assert.deepEqual(parseLoopCommand("2 hours /review src/index.ts"), {
		kind: "schedule",
		intervalMs: 7_200_000,
		message: "/review src/index.ts",
	});
});

test("parses a trailing every clause", () => {
	assert.deepEqual(parseLoopCommand("check X every 1h"), {
		kind: "schedule",
		intervalMs: 3_600_000,
		message: "check X",
	});
	assert.deepEqual(parseLoopCommand("run tests every 5 minutes"), {
		kind: "schedule",
		intervalMs: 300_000,
		message: "run tests",
	});
});

test("missing intervals select dynamic self-pacing", () => {
	assert.deepEqual(parseLoopCommand("check the deploy"), {
		kind: "schedule",
		message: "check the deploy",
	});
	assert.deepEqual(parseLoopCommand("check every PR"), {
		kind: "schedule",
		message: "check every PR",
	});
});

test("enforces interval bounds and requires a message", () => {
	assert.deepEqual(parseLoopCommand("30s check now"), {
		kind: "error",
		message: "The minimum loop interval is 1 minute.",
	});
	assert.deepEqual(parseLoopCommand("31d check later"), {
		kind: "error",
		message: "The maximum loop interval is 30 days.",
	});
	assert.deepEqual(parseLoopCommand("5m"), {
		kind: "error",
		message: "A message is required after the interval.",
	});
});

test("parses list, help, and cancellation commands", () => {
	assert.deepEqual(parseLoopCommand(""), { kind: "list" });
	assert.deepEqual(parseLoopCommand("status"), { kind: "list" });
	assert.deepEqual(parseLoopCommand("help"), { kind: "help" });
	assert.deepEqual(parseLoopCommand("cancel #12"), { kind: "cancel", target: "#12" });
	assert.deepEqual(parseLoopCommand("stop all"), { kind: "cancel", target: "all" });
	assert.equal(parseLoopCommand("cancel").kind, "error");
});

test("formats durations and relative times", () => {
	assert.equal(formatDuration(60_000), "1 minute");
	assert.equal(formatDuration(7_200_000), "2 hours");
	assert.equal(formatDuration(5_400_000), "90 minutes");
	assert.equal(formatRelativeTime(1_030_000, 1_000_000), "in <1 minute");
	assert.equal(formatRelativeTime(1_120_000, 1_000_000), "in 2 minutes");
	assert.equal(formatRelativeTime(4_660_000, 1_000_000), "in 1 hour 1 min");
});
