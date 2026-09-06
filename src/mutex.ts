/**
 * A minimal async mutual-exclusion lock (promise chain).
 *
 * Used to serialize sandboxed tool execution and the post-tool finisher so a
 * finisher can never apply another in-flight tool's half-staged writes
 * (pi supports parallel tool calls).
 */
export class AsyncMutex {
	private tail: Promise<void> = Promise.resolve();

	/** Run `fn` exclusively; concurrent callers queue in arrival order. */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
