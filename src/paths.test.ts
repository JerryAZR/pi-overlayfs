import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeHostPathFs, createPathMapper, type OverlayEntry } from "./paths.js";

// Fixtures use win32-style and posix-style roots; each test pins the platform
// explicitly so results are deterministic on any host. The win32 roots are
// deliberately NON-EXISTENT so the default fs canonicalizer is the identity
// on them (no on-disk casing/symlink rewriting leaks into these cases).

const WIN_HOME = "C:\\sandhome\\jerry";
const WIN_PROJECT = "C:\\sandhome\\jerry\\Projects\\app";
const WIN_PROJECT_SEPARATE = "D:\\sandwork\\app";

const POSIX_HOME = "/home/jerry";
const POSIX_PROJECT = "/home/jerry/projects/app";
const POSIX_PROJECT_SEPARATE = "/opt/app";

function winMapper(overlays: OverlayEntry[], projectRoot: string) {
	// Synthetic fixtures: identity canonicalizer (the fs-based default is
	// host-platform; canonicalization itself is tested separately below).
	return createPathMapper({ overlays, projectRoot, platform: "win32", canonicalize: (p) => p });
}

function posixMapper(overlays: OverlayEntry[], projectRoot: string) {
	return createPathMapper({ overlays, projectRoot, platform: "posix", canonicalize: (p) => p });
}

describe("paths: project-inside-home topology (single home overlay)", () => {
	const overlays: OverlayEntry[] = [{ mountPoint: "/home/user", root: WIN_HOME }];
	const mapper = winMapper(overlays, WIN_PROJECT);

	it("maps the project root to its virtual subpath", () => {
		const m = mapper.hostToVirtual(WIN_PROJECT);
		expect(m).not.toBeNull();
		expect(m!.virtualPath).toBe("/home/user/Projects/app");
		expect(m!.mountPoint).toBe("/home/user");
		expect(m!.overlayRoot).toBe(WIN_HOME);
		expect(m!.overlayRelativePath).toBe("/Projects/app");
		expect(m!.underProject).toBe(true);
	});

	it("maps nested files, accepting forward slashes and different casing", () => {
		const m = mapper.hostToVirtual("c:/SANDHOME/jerry/projects/app/src/index.ts");
		expect(m!.virtualPath).toBe("/home/user/projects/app/src/index.ts");
		expect(m!.underProject).toBe(true);
	});

	it("marks home paths outside the project as not under project", () => {
		const m = mapper.hostToVirtual("C:\\sandhome\\jerry\\Downloads\\x.txt");
		expect(m!.virtualPath).toBe("/home/user/Downloads/x.txt");
		expect(m!.underProject).toBe(false);
	});

	it("returns null for paths under no overlay root", () => {
		expect(mapper.hostToVirtual("D:\\elsewhere\\x.txt")).toBeNull();
	});

	it("does not treat sibling prefixes as inside the project", () => {
		// "app2" shares the "app" prefix but is not underneath it.
		expect(mapper.isUnderProject("C:\\sandhome\\jerry\\Projects\\app2\\x")).toBe(false);
		expect(mapper.isUnderProject("C:\\sandhome\\jerry\\Projects\\app\\x")).toBe(true);
	});
});

describe("paths: separate /project topology", () => {
	const overlays: OverlayEntry[] = [
		{ mountPoint: "/home/user", root: WIN_HOME },
		{ mountPoint: "/project", root: WIN_PROJECT_SEPARATE },
	];
	const mapper = winMapper(overlays, WIN_PROJECT_SEPARATE);

	it("maps the project onto the /project mount", () => {
		const m = mapper.hostToVirtual("D:\\sandwork\\app\\src\\main.ts");
		expect(m!.virtualPath).toBe("/project/src/main.ts");
		expect(m!.mountPoint).toBe("/project");
		expect(m!.overlayRelativePath).toBe("/src/main.ts");
		expect(m!.underProject).toBe(true);
	});

	it("maps the project root itself to the mount point", () => {
		const m = mapper.hostToVirtual(WIN_PROJECT_SEPARATE);
		expect(m!.virtualPath).toBe("/project");
		expect(m!.overlayRelativePath).toBe("/");
	});
});

describe("paths: posix topology", () => {
	it("maps identity-style under home and separate /project mounts", () => {
		const inside = posixMapper([{ mountPoint: "/home/user", root: POSIX_HOME }], POSIX_PROJECT);
		const m = inside.hostToVirtual("/home/jerry/projects/app/a.ts");
		expect(m!.virtualPath).toBe("/home/user/projects/app/a.ts");
		expect(m!.underProject).toBe(true);

		const separate = posixMapper(
			[
				{ mountPoint: "/home/user", root: POSIX_HOME },
				{ mountPoint: "/project", root: POSIX_PROJECT_SEPARATE },
			],
			POSIX_PROJECT_SEPARATE,
		);
		expect(separate.hostToVirtual("/opt/app/a.ts")!.virtualPath).toBe("/project/a.ts");
		// POSIX comparison is case-sensitive.
		expect(separate.isUnderProject("/OPT/APP/a.ts")).toBe(false);
	});
});

describe("paths: resolveToolPath heuristic", () => {
	const overlays: OverlayEntry[] = [
		{ mountPoint: "/home/user", root: WIN_HOME },
		{ mountPoint: "/project", root: WIN_PROJECT_SEPARATE },
	];
	const mapper = winMapper(overlays, WIN_PROJECT_SEPARATE);

	it("rule 1: host paths under an overlay root map to virtual paths", () => {
		expect(mapper.resolveToolPath("D:\\sandwork\\app\\src\\x.ts")).toBe("/project/src/x.ts");
		expect(mapper.resolveToolPath("C:\\sandhome\\jerry\\notes.md")).toBe("/home/user/notes.md");
	});

	it("rule 2: POSIX-absolute paths pass through as already-virtual", () => {
		expect(mapper.resolveToolPath("/tmp/scratch.py")).toBe("/tmp/scratch.py");
		expect(mapper.resolveToolPath("/project/src/x.ts")).toBe("/project/src/x.ts");
	});

	it("rule 3: drive-rooted paths outside overlays are treated as virtual (pi-mangled POSIX)", () => {
		// On Windows pi resolves "/tmp/x" against the session drive -> "C:\tmp\x".
		expect(mapper.resolveToolPath("C:\\tmp\\x")).toBe("/tmp/x");
	});

	it("posix platform keeps rules 1-2 without drive stripping", () => {
		const pm = posixMapper([{ mountPoint: "/home/user", root: POSIX_HOME }], POSIX_PROJECT);
		expect(pm.resolveToolPath("/home/jerry/a.txt")).toBe("/home/user/a.txt");
		expect(pm.resolveToolPath("/etc/hostname")).toBe("/etc/hostname");
	});
});

describe("paths: realToOverlayRelative (finisher drop mapping)", () => {
	const overlays: OverlayEntry[] = [
		{ mountPoint: "/home/user", root: WIN_HOME },
		{ mountPoint: "/project", root: WIN_PROJECT_SEPARATE },
	];
	const mapper = winMapper(overlays, WIN_PROJECT_SEPARATE);

	it("maps real paths back to overlay-relative POSIX paths", () => {
		expect(mapper.realToOverlayRelative("D:\\sandwork\\app\\dist\\out.js")).toEqual({
			overlayRoot: realpathSafe(WIN_PROJECT_SEPARATE),
			overlayRelativePath: "/dist/out.js",
		});
		expect(mapper.realToOverlayRelative("c:\\sandhome\\jerry\\x")).toEqual({
			overlayRoot: realpathSafe(WIN_HOME),
			overlayRelativePath: "/x",
		});
		expect(mapper.realToOverlayRelative("E:\\nowhere")).toBeNull();
	});
});

function realpathSafe(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

// Guard against regressions in the relative-path helper used for joins.
describe("paths: sanity", () => {
	it("uses platform-specific relative semantics", () => {
		expect(path.win32.relative("C:\\a", "C:\\a\\b\\c")).toBe("b\\c");
		expect(path.posix.relative("/a", "/a/b/c")).toBe("b/c");
	});
});

/**
 * H3/M4: canonicalization against the REAL filesystem. Overlay roots are
 * realpath'd by the sandbox; inputs arriving through symlinks or with
 * off-casing must map to the same virtual paths, or routing silently falls
 * back to native and project writes get misclassified as outside-project.
 */
describe("paths: canonicalization (real fs)", () => {
	let tmpRoot: string;
	let home: string;
	let project: string;

	beforeEach(async () => {
		tmpRoot = await mkdtemp(path.join(os.tmpdir(), "pi-overlayfs-paths-"));
		home = path.join(tmpRoot, "home");
		project = path.join(home, "project");
		await mkdir(project, { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpRoot, { recursive: true, force: true });
	});

	it("maps through a directory symlink (macOS /tmp-style)", async () => {
		const link = path.join(tmpRoot, "link");
		// Junctions need no admin on Windows; plain symlink elsewhere.
		await symlink(home, link, process.platform === "win32" ? "junction" : "dir");

		// Mapper built with canonical roots; input arrives via the symlink.
		const mapper = createPathMapper({
			overlays: [{ mountPoint: "/home/user", root: realpathSync(home) }],
			projectRoot: path.join(link, "project"),
		});
		const viaLink = mapper.hostToVirtual(path.join(link, "project", "src", "x.ts"));
		const viaReal = mapper.hostToVirtual(path.join(home, "project", "src", "x.ts"));
		expect(viaLink).not.toBeNull();
		expect(viaLink!.virtualPath).toBe(viaReal!.virtualPath);
		expect(viaLink!.underProject).toBe(true);
		// projectRoot through the symlink must classify canonical diff paths too.
		expect(mapper.isUnderProject(path.join(realpathSync(home), "project", "y.ts"))).toBe(true);
	});

	it("one file, one virtual path regardless of input casing", async () => {
		if (process.platform !== "win32") return; // casing aliasing is a Windows concern
		const realDir = path.join(project, "MixedCase");
		await mkdir(realDir);
		const mapper = createPathMapper({
			overlays: [{ mountPoint: "/home/user", root: realpathSync(home) }],
			projectRoot: project,
		});
		const proper = mapper.hostToVirtual(path.join(project, "MixedCase", "f.txt"));
		const upper = mapper.hostToVirtual(path.join(project, "MIXEDCASE", "f.txt"));
		const lower = mapper.hostToVirtual(path.join(project, "mixedcase", "f.txt"));
		expect(proper!.virtualPath).toContain("MixedCase");
		expect(upper!.virtualPath).toBe(proper!.virtualPath);
		expect(lower!.virtualPath).toBe(proper!.virtualPath);
	});

	it("canonicalizes the nearest existing ancestor for not-yet-created paths", () => {
		const missing = path.join(project, "newdir", "file.txt");
		const canonical = canonicalizeHostPathFs(missing);
		expect(canonical).toBe(path.join(canonicalizeHostPathFs(project), "newdir", "file.txt"));
	});

	it("injected canonicalizer: posix symlink semantics are deterministic", () => {
		const mapper = createPathMapper({
			overlays: [{ mountPoint: "/home/user", root: "/private/tmp/home" }],
			projectRoot: "/private/tmp/home/project",
			platform: "posix",
			canonicalize: (p) => (p.startsWith("/tmp/") ? `/private${p}` : p),
		});
		const m = mapper.hostToVirtual("/tmp/home/project/src/x.ts");
		expect(m!.virtualPath).toBe("/home/user/project/src/x.ts");
		expect(m!.underProject).toBe(true);
	});
});
