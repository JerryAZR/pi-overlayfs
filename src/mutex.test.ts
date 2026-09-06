import { describe, expect, it } from "vitest";
import { AsyncMutex } from "./mutex.js";

describe("AsyncMutex", () => {
	it("serializes runners (max concurrency 1)", async () => {
		const mutex = new AsyncMutex();
		let active = 0;
		let maxActive = 0;
		await Promise.all(
			Array.from({ length: 8 }, () =>
				mutex.run(async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					active--;
				}),
			),
		);
		expect(maxActive).toBe(1);
	});

	it("acquires in FIFO arrival order", async () => {
		const mutex = new AsyncMutex();
		const entryOrder: number[] = [];
		// All run() calls are issued synchronously; each must enter in the
		// order it was queued, regardless of how long holders take.
		const tasks = [0, 1, 2, 3, 4].map((i) =>
			mutex.run(async () => {
				entryOrder.push(i);
				// Vary hold times to prove order is queue order, not timing.
				await new Promise((resolve) => setTimeout(resolve, (4 - i) * 4));
			}),
		);
		await Promise.all(tasks);
		expect(entryOrder).toEqual([0, 1, 2, 3, 4]);
	});

	it("releases the lock when a runner throws", async () => {
		const mutex = new AsyncMutex();
		await expect(mutex.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		// A subsequent runner must still acquire.
		await expect(mutex.run(async () => "ok")).resolves.toBe("ok");
	});

	it("returns the runner's value", async () => {
		const mutex = new AsyncMutex();
		await expect(mutex.run(async () => 42)).resolves.toBe(42);
	});
});
