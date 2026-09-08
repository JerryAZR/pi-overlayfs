import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	Bash,
	createVfsTemplate,
	type MountableFs,
	type OverlayDiff,
	type VfsTemplate,
} from "@jerryan/just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyChangeSetPerEntry,
	partitionChanges,
	runFinisher,
	type ApplyFailure,
	type FinisherDeps,
} from "./finisher.js";
import { createPathMapper, type PathMapper } from "./paths.js";

let tmpRoot: string;
let home: string;
let project: string;
let template: VfsTemplate;
let mapper: PathMapper;
let virtualProject: string;
let stagedForks: MountableFs[];

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-finisher-"));
	home = path.join(tmpRoot, "home");
	project = path.join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "seed.txt"), "seed\n");
	template = createVfsTemplate({ mounts: [{ at: "/home/user", root: home }] });
	mapper = createPathMapper({
		overlays: [{ mountPoint: "/home/user", root: home }],
		projectRoot: project,
	});
	virtualProject = mapper.hostToVirtual(project)!.virtualPath;
	stagedForks = [];
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

/** Stage a command's effects into a fresh fork (as a tool call would). */
async function stage(command: string): Promise<void> {
	const fork = template.fork();
	const bash = new Bash({
		fs: fork,
		cwd: virtualProject,
		env: { HOME: "/home/user" },
		abortOnUnresolvedCommands: true,
	});
	const result = await bash.exec(command);
	expect(result.exitCode).toBe(0);
	stagedForks.push(fork);
}

/** The turn_end barrier: merge the turn's forks into one host-space diff. */
async function mergedHostDiff(): Promise<OverlayDiff> {
	const merged = await template.merge(stagedForks);
	stagedForks = [];
	return merged.diff({ space: "host" });
}

function makeDeps(diff: OverlayDiff, overrides: Partial<FinisherDeps> = {}): FinisherDeps {
	return {
		diff: () => diff,
		applyChanges: (subset) => applyChangeSetPerEntry(subset),
		isUnderProject: (p) => mapper.isUnderProject(p),
		isExistingDirectory: (p) => {
			try {
				return statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
		outsidePolicy: () => undefined,
		...overrides,
	};
}

function failEverything(error: string): (subset: OverlayDiff) => Promise<ApplyFailure[]> {
	return async (subset) => [
		...subset.deletions.map((p) => ({ path: p, error })),
		...subset.writes.map((w) => ({ path: w.path, error })),
	];
}

describe("partitionChanges", () => {
	it("splits inside/outside by project containment and isolates no-op dir writes", () => {
		const changes: OverlayDiff = {
			writes: [
				{ path: path.join(project, "a.txt"), nodeType: "file", content: new Uint8Array(), mode: 0o644, mtime: new Date() },
				{ path: path.join(home, "b.txt"), nodeType: "file", content: new Uint8Array(), mode: 0o644, mtime: new Date() },
				{ path: home, nodeType: "directory", content: new Uint8Array(), mode: 0o755, mtime: new Date() },
			],
			deletions: [path.join(project, "gone.txt"), path.join(home, "outside-gone.txt")],
		};
		const { inside, outside, noOpDirs } = partitionChanges(
			changes,
			(p) => mapper.isUnderProject(p),
			(p) => existsSync(p),
		);
		expect(inside.writes.map((w) => w.path)).toEqual([path.join(project, "a.txt")]);
		expect(inside.deletions).toEqual([path.join(project, "gone.txt")]);
		expect(outside.writes.map((w) => w.path)).toEqual([path.join(home, "b.txt")]);
		expect(outside.deletions).toEqual([path.join(home, "outside-gone.txt")]);
		// home exists on disk -> mkdir -p no-op -> never applied, never prompts.
		expect(noOpDirs).toEqual([home]);
	});
});

describe("runFinisher (real vfs template on temp dirs)", () => {
	it("auto-applies inside-project changes without any confirmation", async () => {
		await stage("echo staged > staged.txt");
		let confirmCalls = 0;
		const report = await runFinisher(
			makeDeps(await mergedHostDiff(), { confirm: async () => (confirmCalls++, false) }),
		);

		expect(readFileSync(path.join(project, "staged.txt"), "utf8")).toBe("staged\n");
		expect(confirmCalls).toBe(0);
		expect(report.applied).toBeGreaterThan(0);
	});

	it("does not prompt for pre-existing parent dir chain entries", async () => {
		// Writing inside the project stages the whole home->project dir chain in
		// the home overlay; those dirs already exist on disk.
		await stage("echo x > staged.txt");
		const confirmedPaths: string[][] = [];
		await runFinisher(makeDeps(await mergedHostDiff(), { confirm: async (paths) => (confirmedPaths.push(paths), true) }));

		expect(confirmedPaths).toEqual([]);
	});

	it("applies outside-project changes only after confirmation; lists real paths", async () => {
		await stage("echo secret > ../outside.txt");
		const confirmedPaths: string[][] = [];
		const report = await runFinisher(
			makeDeps(await mergedHostDiff(), {
				confirm: async (paths) => {
					confirmedPaths.push(paths);
					return true;
				},
			}),
		);

		expect(confirmedPaths).toEqual([[path.join(home, "outside.txt")]]);
		expect(readFileSync(path.join(home, "outside.txt"), "utf8")).toBe("secret\n");
		expect(report.applied).toBe(1);
	});

	it("denied outside-project changes are simply not applied", async () => {
		await stage("echo secret > ../outside.txt");
		const report = await runFinisher(makeDeps(await mergedHostDiff(), { confirm: async () => false }));

		expect(existsSync(path.join(home, "outside.txt"))).toBe(false);
		// …and reported for the post-turn steering warning.
		expect(report.denied).toHaveLength(1);
		expect(report.denied[0]!.replace(/\\/g, "/")).toContain("outside.txt");
	});

	it("headless: honors PI_OVERLAYFS_OUTSIDE_PROJECT-style policy", async () => {
		await stage("echo a > ../approved.txt");
		const approvedReport = await runFinisher(makeDeps(await mergedHostDiff(), { outsidePolicy: () => "approve" }));
		expect(existsSync(path.join(home, "approved.txt"))).toBe(true);
		expect(approvedReport.denied).toEqual([]);

		await stage("echo b > ../denied.txt");
		const deniedReport = await runFinisher(makeDeps(await mergedHostDiff(), { outsidePolicy: () => undefined }));
		expect(existsSync(path.join(home, "denied.txt"))).toBe(false);
		expect(deniedReport.denied).toHaveLength(1);
		expect(deniedReport.denied[0]!.replace(/\\/g, "/")).toContain("denied.txt");
	});

	it("apply failures are collected per entry and reported (nothing applied)", async () => {
		await stage("echo a > inside.txt");
		await stage("echo b > ../outside.txt");
		const report = await runFinisher(
			makeDeps(await mergedHostDiff(), {
				applyChanges: failEverything("disk full"),
				confirm: async () => true, // outside would have been approved — apply fails first
			}),
		);

		expect(report.failed?.error).toContain("disk full");
		expect(existsSync(path.join(project, "inside.txt"))).toBe(false);
		expect(existsSync(path.join(home, "outside.txt"))).toBe(false);
		// The report names what was lost, for the steering warning.
		const failedPaths = (report.failed?.paths ?? []).map((p) => p.replace(/\\/g, "/"));
		expect(failedPaths.some((p) => p.includes("inside.txt"))).toBe(true);
		expect(failedPaths.some((p) => p.includes("outside.txt"))).toBe(true);
		// Nothing was "denied" — this was a failure, not a rejection.
		expect(report.denied).toEqual([]);
	});

	it("a confirm error reports the outside changes as failed, not denied", async () => {
		await stage("echo x > ../outside.txt");
		const report = await runFinisher(
			makeDeps(await mergedHostDiff(), {
				confirm: async () => {
					throw new Error("ui gone");
				},
			}),
		);

		expect(report.failed?.error).toContain("ui gone");
		expect(existsSync(path.join(home, "outside.txt"))).toBe(false);
		expect(report.failed?.paths.some((p) => p.includes("outside.txt"))).toBe(true);
		expect(report.denied).toEqual([]);
	});

	it("applies deletions inside the project", async () => {
		await stage("rm seed.txt");
		await runFinisher(makeDeps(await mergedHostDiff()));
		expect(existsSync(path.join(project, "seed.txt"))).toBe(false);
	});

	it("is a no-op when nothing is staged", async () => {
		let confirmCalls = 0;
		const report = await runFinisher(
			makeDeps(await mergedHostDiff(), { confirm: async () => (confirmCalls++, true) }),
		);
		expect(report).toEqual({ applied: 0, denied: [], failed: null });
		expect(confirmCalls).toBe(0);
	});
});
