import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSandbox, type AgentSandbox, type SandboxChangeSet } from "@jerryan/just-bash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { partitionChanges, runFinisher, type FinisherDeps } from "./finisher.js";
import { createPathMapper, type PathMapper } from "./paths.js";

let tmpRoot: string;
let home: string;
let project: string;
let sandbox: AgentSandbox;
let mapper: PathMapper;

beforeEach(async () => {
	tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-finisher-"));
	home = path.join(tmpRoot, "home");
	project = path.join(home, "project");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "seed.txt"), "seed\n");
	sandbox = createAgentSandbox({ home, project, abortOnUnresolvedCommands: true });
	mapper = createPathMapper({
		overlays: [...sandbox.overlays.entries()].map(([mountPoint, { root }]) => ({ mountPoint, root })),
		projectRoot: project,
	});
});

afterEach(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<FinisherDeps> = {}): FinisherDeps {
	return {
		diff: () => sandbox.diff(),
		applyChanges: (subset) => sandbox.applyChanges(subset),
		drop: (realPaths) => {
			const byOverlay = new Map<string, { fs: { drop(p: string[]): void }; rel: string[] }>();
			for (const realPath of realPaths) {
				const found = mapper.realToOverlayRelative(realPath);
				if (!found) continue;
				const entry = [...sandbox.overlays.values()].find((o) => o.root === found.overlayRoot);
				if (!entry) continue;
				let group = byOverlay.get(found.overlayRoot);
				if (!group) {
					group = { fs: entry.fs, rel: [] };
					byOverlay.set(found.overlayRoot, group);
				}
				group.rel.push(found.overlayRelativePath);
			}
			for (const group of byOverlay.values()) group.fs.drop(group.rel);
		},
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

async function stage(command: string): Promise<void> {
	const result = await sandbox.exec(command);
	expect(result.exitCode).toBe(0);
}

describe("partitionChanges", () => {
	it("splits inside/outside by project containment and isolates no-op dir writes", () => {
		const changes: SandboxChangeSet = {
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
		// home exists on disk -> mkdir -p no-op -> silent drop, never prompts.
		expect(noOpDirs).toEqual([home]);
	});
});

describe("runFinisher (real sandbox on temp dirs)", () => {
	it("auto-applies inside-project changes without any confirmation", async () => {
		await stage("echo staged > staged.txt");
		let confirmCalls = 0;
		const report = await runFinisher(makeDeps({ confirm: async () => (confirmCalls++, false) }));

		expect(readFileSync(path.join(project, "staged.txt"), "utf8")).toBe("staged\n");
		expect(confirmCalls).toBe(0);
		expect(report.appliedInside).toBeGreaterThan(0);
		expect(sandbox.diff().writes).toHaveLength(0);
	});

	it("drops pre-existing parent dir chain entries silently instead of prompting", async () => {
		// Writing inside the project stages the whole home->project dir chain in
		// the home overlay; those dirs already exist on disk.
		await stage("echo x > staged.txt");
		const confirmedPaths: string[][] = [];
		await runFinisher(makeDeps({ confirm: async (paths) => (confirmedPaths.push(paths), true) }));

		expect(confirmedPaths).toEqual([]);
		expect(sandbox.diff().writes).toHaveLength(0);
	});

	it("applies outside-project changes only after confirmation; lists real paths", async () => {
		await stage("echo secret > ../outside.txt");
		const confirmedPaths: string[][] = [];
		const report = await runFinisher(
			makeDeps({
				confirm: async (paths) => {
					confirmedPaths.push(paths);
					return true;
				},
			}),
		);

		expect(confirmedPaths).toEqual([[path.join(home, "outside.txt")]]);
		expect(readFileSync(path.join(home, "outside.txt"), "utf8")).toBe("secret\n");
		expect(report.appliedOutside).toBe(1);
	});

	it("drops denied outside-project changes (never written to disk, not re-prompted)", async () => {
		await stage("echo secret > ../outside.txt");
		const report = await runFinisher(makeDeps({ confirm: async () => false }));

		expect(existsSync(path.join(home, "outside.txt"))).toBe(false);
		expect(report.droppedOutside).toBe(1);
		// Denied entries are gone from the pending set.
		expect(sandbox.diff().writes).toHaveLength(0);
		// …and reported for the post-turn steering warning.
		expect(report.droppedDenied).toHaveLength(1);
		expect(report.droppedDenied[0]!.replace(/\\/g, "/")).toContain("outside.txt");
	});

	it("headless: honors PI_OVERLAYFS_OUTSIDE_PROJECT-style policy", async () => {
		await stage("echo a > ../approved.txt");
		const approvedReport = await runFinisher(makeDeps({ outsidePolicy: () => "approve" }));
		expect(existsSync(path.join(home, "approved.txt"))).toBe(true);
		expect(approvedReport.droppedDenied).toEqual([]);

		await stage("echo b > ../denied.txt");
		const deniedReport = await runFinisher(makeDeps({ outsidePolicy: () => undefined }));
		expect(existsSync(path.join(home, "denied.txt"))).toBe(false);
		expect(deniedReport.droppedDenied).toHaveLength(1);
		expect(deniedReport.droppedDenied[0]!.replace(/\\/g, "/")).toContain("denied.txt");
	});

	it("applies deletions inside the project", async () => {
		await stage("rm seed.txt");
		await runFinisher(makeDeps());
		expect(existsSync(path.join(project, "seed.txt"))).toBe(false);
		expect(sandbox.diff().deletions).toHaveLength(0);
	});

	it("is a no-op when nothing is staged", async () => {
		let confirmCalls = 0;
		const report = await runFinisher(makeDeps({ confirm: async () => (confirmCalls++, true) }));
		expect(report).toEqual({ appliedInside: 0, appliedOutside: 0, droppedOutside: 0, droppedDenied: [] });
		expect(confirmCalls).toBe(0);
	});

	it("L1: droppedOutside counts only entries actually removed from the pending set", async () => {
		// drop() that removes nothing (OverlayFs.drop keeps dir nodes whose
		// children are still pending): the report must reflect reality.
		const outsideFile = path.join(home, "kept.txt");
		const changes: SandboxChangeSet = {
			writes: [
				{ path: outsideFile, nodeType: "file", content: new Uint8Array(), mode: 0o644, mtime: new Date() },
			],
			deletions: [],
		};
		const report = await runFinisher(
			makeDeps({
				diff: () => changes,
				drop: () => {},
				confirm: async () => false,
			}),
		);
		expect(report.droppedOutside).toBe(0);
		expect(report.appliedOutside).toBe(0);
	});
});
