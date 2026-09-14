/**
 * Bidirectional host <-> virtual path mapping for the overlay sandbox.
 *
 * The template (see @jerryan/just-bash createVfsTemplate) mounts copy-on-write
 * overlays at REAL-LAYOUT virtual mount points (virtualMountPointFor):
 * the host root's own path, transformed — posix roots map to themselves;
 * win32 roots map to MSYS form ("C:\\Users\\jerry" -> "/c/Users/jerry").
 * One path form is therefore understood by BOTH the sandbox and the native
 * route (pi's native shell on Windows is always an MSYS-family bash).
 *
 * Pure module (node:path only) so it can be unit-tested for both platforms
 * via the explicit `platform` option.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

export type Platform = "win32" | "posix";

export interface OverlayEntry {
	/** Virtual mount point (real-layout form, see virtualMountPointFor). */
	mountPoint: string;
	/** Real absolute host root backing the overlay. */
	root: string;
}

export interface PathMapper {
	/** Absolute host path -> virtual vfs path, or null when under no overlay root. */
	hostToVirtual(hostPath: string): string | null;
	/** True when `realPath` is the project root or underneath it. */
	isUnderProject(realPath: string): boolean;
	/**
	 * Resolve an absolute path handed to a tool's filesystem operations to a
	 * virtual vfs path. Heuristic (documented in README):
	 *
	 *  1. Host mapping first: if the path sits under an overlay root (real home
	 *     or project dir), map it onto that overlay's virtual mount point. This
	 *     covers relative paths (pi resolves them against the host session cwd)
	 *     and explicit host-absolute paths.
	 *  2. Already-virtual POSIX passthrough: a path starting with "/" that is
	 *     not under any overlay root is treated as an already-virtual sandbox
	 *     path ("/tmp/x", "/project/x", ...). On POSIX hosts this means genuine
	 *     host paths outside home/project ("/etc/...") are seen as virtual —
	 *     they are invisible to the sandbox anyway, so reads fail with ENOENT
	 *     and writes land in throwaway memory.
	 *  3. Windows drive-rooted fallback: a drive-rooted path under no overlay
	 *     root ("C:\\tmp\\x", "D:\\scratch\\y") is almost always a virtual POSIX
	 *     path the model typed that pi's host-side resolve() rooted at the
	 *     session drive ("/tmp/x" -> "C:\\tmp\\x") — OR an MSYS-form path
	 *     ("/c/tmp/x" -> "C:\\tmp\\x"). Map it to its real-layout virtual form
	 *     ("/c/tmp/x"). Genuine outside-sandbox host paths get the same
	 *     treatment (virtual-only, never applied to disk) — the sandbox cannot
	 *     see them either way.
	 */
	resolveToolPath(absolutePath: string): string;
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_PATH = /^[\\/]{2}/;

function toSlashes(p: string): string {
	return p.replace(/\\/g, "/");
}

/** Canonical comparison form: forward slashes, lowercased on win32, no trailing slash. */
function compareForm(p: string, platform: Platform): string {
	let out = toSlashes(p);
	while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
	return platform === "win32" ? out.toLowerCase() : out;
}

/** True when `child` equals `root` or sits underneath it (boundary-aware). */
function isWithin(root: string, child: string, platform: Platform): boolean {
	const r = compareForm(root, platform);
	const c = compareForm(child, platform);
	return c === r || c.startsWith(`${r}/`);
}

function isWindowsAbsolute(p: string): boolean {
	return WINDOWS_ABSOLUTE.test(p) || UNC_PATH.test(p);
}

/**
 * Virtual mount point for a host root: the real-layout transform that makes
 * one path form meaningful to BOTH the sandbox and the native route (pi's
 * native shell on Windows is always an MSYS-family bash, which understands
 * the /c/... form natively).
 *   win32: "C:\\Users\\jerry" -> "/c/Users/jerry"  (lowercase drive letter)
 *   posix: "/home/jerry"      -> "/home/jerry"      (identity)
 * UNC paths get separator normalization only (documented edge): the UNC
 * root IS mounted and routed sandboxed like any other root — whether
 * just-bash handles //server/... mounts correctly is untested upstream.
 */
export function virtualMountPointFor(hostRoot: string, platform?: Platform): string {
	const plat = platform ?? (process.platform as Platform);
	if (plat !== "win32") return toSlashes(hostRoot);
	const normalized = toSlashes(hostRoot);
	const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
	if (!drive) return normalized; // UNC or drive-less
	const rest = drive[2]!.replace(/\/+$/, "");
	return `/${drive[1]!.toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** Longest-overlay-root-prefix match for a host path. */
function matchOverlay(
	hostPath: string,
	overlays: readonly OverlayEntry[],
	platform: Platform,
): OverlayEntry | null {
	let best: OverlayEntry | null = null;
	for (const entry of overlays) {
		if (!isWithin(entry.root, hostPath, platform)) continue;
		if (!best || compareForm(entry.root, platform).length > compareForm(best.root, platform).length) {
			best = entry;
		}
	}
	return best;
}

function relativeToRoot(root: string, hostPath: string, platform: Platform): string {
	const rel = (platform === "win32" ? path.win32 : path.posix).relative(root, hostPath);
	const posix = toSlashes(rel);
	return posix === "" ? "/" : `/${posix}`;
}

/**
 * Canonicalize a host path to on-disk spelling: resolves symlinks and, on
 * case-insensitive filesystems, returns the true casing (e.g. macOS
 * /tmp -> /private/tmp, "c:\users\jerry" -> "C:\Users\jerry"). For paths
 * that do not exist yet, the nearest existing ancestor is canonicalized and
 * the missing tail re-appended unchanged. Falls back to the input when
 * nothing can be resolved.
 *
 * Uses realpathSync.native: on Windows, plain realpathSync preserves the
 * INPUT casing of existing components, only .native returns the on-disk
 * spelling. Any extended-length "\\\\?\" prefix is stripped so the result
 * stays comparable with just-bash's own realpathSync-canonicalized roots.
 */
export function canonicalizeHostPathFs(hostPath: string): string {
	const realpath = realpathSync.native ?? realpathSync;
	const missing: string[] = [];
	let current = hostPath;
	for (;;) {
		try {
			const canonical = stripExtendedLengthPrefix(realpath(current));
			return missing.length > 0 ? path.join(canonical, ...missing) : canonical;
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return hostPath;
			missing.unshift(path.basename(current));
			current = parent;
		}
	}
}

/** "\\\\?\C:\x" -> "C:\x", "\\\\?\UNC\server\share" -> "\\server\share". */
function stripExtendedLengthPrefix(p: string): string {
	if (p.startsWith("\\\\?\\UNC\\")) return `\\${p.slice(8)}`;
	if (p.startsWith("\\\\?\\")) return p.slice(4);
	return p;
}

/**
 * Mount topology shared by the main session and read-only subagent
 * sandboxes: canonicalized home at its real-layout mount point, plus the
 * project at its own real-layout mount point when the cwd is NOT inside
 * home (otherwise the project is a subpath of the home overlay).
 * Canonicalization happens up front (symlinked cwd / $HOME, e.g. macOS /tmp): the template realpaths its mount roots
 * internally, and the mapper must compare against the same canonical
 * spelling or every lookup misses (silent native fallback + outside-project
 * misclassification).
 */
export interface OverlayTopology {
	/** Canonicalized session cwd. */
	cwd: string;
	mounts: { at: string; root: string }[];
	mapper: PathMapper;
	virtualCwd: string;
	/** Virtual mount point of the home overlay (value for the sandbox HOME env). */
	virtualHome: string;
}

export function computeOverlayTopology(cwdInput: string, homeInput: string): OverlayTopology {
	const cwd = canonicalizeHostPathFs(cwdInput);
	const home = canonicalizeHostPathFs(homeInput);
	const rel = path.relative(home, cwd);
	const projectInsideHome = rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
	const virtualHome = virtualMountPointFor(home);
	const mounts = projectInsideHome
		? [{ at: virtualHome, root: home }]
		: [
				{ at: virtualHome, root: home },
				{ at: virtualMountPointFor(cwd), root: cwd },
			];
	const mapper = createPathMapper({
		overlays: mounts.map((m) => ({ mountPoint: m.at, root: m.root })),
		projectRoot: cwd,
	});
	const virtualCwd = mapper.hostToVirtual(cwd) ?? "/";
	return { cwd, mounts, mapper, virtualCwd, virtualHome };
}

export function createPathMapper(options: {
	overlays: readonly OverlayEntry[];
	projectRoot: string;
	platform?: Platform;
	/**
	 * Canonicalizer applied to host paths before overlay matching (symlink +
	 * casing resolution). Defaults to canonicalizeHostPathFs; injectable for
	 * tests. The sandbox canonicalizes overlay roots with realpathSync, so
	 * incoming paths must be canonicalized the same way or a symlinked /
	 * differently-cased cwd silently matches nothing (routing everything
	 * native and misclassifying project writes as outside-project).
	 */
	canonicalize?: (hostPath: string) => string;
}): PathMapper {
	const platform = options.platform ?? (process.platform as Platform);
	const canonicalize = options.canonicalize ?? canonicalizeHostPathFs;
	// Roots must be canonical too: diff() paths are joined onto the sandbox's
	// realpath'd overlay roots, and a symlinked projectRoot would otherwise
	// misclassify every project write as outside-project (headless: dropped).
	const overlays = options.overlays.map((entry) => ({ ...entry, root: canonicalize(entry.root) }));
	const projectRoot = canonicalize(options.projectRoot);

	const hostToVirtual = (hostPath: string): string | null => {
		// Canonicalize first so symlinked cwd prefixes and off-casing inputs
		// map onto the same virtual paths as their on-disk spellings (the vfs
		// is case-sensitive even when the disk is not).
		const canonical = canonicalize(hostPath);
		const canonicalMatch = matchOverlay(canonical, overlays, platform);
		const entry = canonicalMatch ?? matchOverlay(hostPath, overlays, platform);
		if (!entry) return null;
		const matchedPath = canonicalMatch ? canonical : hostPath;
		const overlayRelativePath = relativeToRoot(entry.root, matchedPath, platform);
		return overlayRelativePath === "/"
			? entry.mountPoint
			: path.posix.join(entry.mountPoint, overlayRelativePath);
	};

	return {
		hostToVirtual,
		// Both entry points canonicalize their argument (same canonicalizer as
		// hostToVirtual) so callers can pass any spelling — symlinked, off-casing,
		// or already-canonical diff() paths — and get the same verdict.
		isUnderProject: (realPath) =>
			isWithin(projectRoot, canonicalize(realPath), platform) || isWithin(projectRoot, realPath, platform),
		resolveToolPath: (absolutePath) => {
			// Rule 1: host mapping.
			const mapped = hostToVirtual(absolutePath);
			if (mapped) return mapped;
			// Rule 2: already-virtual POSIX passthrough.
			if (absolutePath.startsWith("/") && !isWindowsAbsolute(absolutePath)) {
				return absolutePath;
			}
			// Rule 3: Windows drive-rooted fallback — real-layout virtual form.
			if (platform === "win32" && WINDOWS_ABSOLUTE.test(absolutePath)) {
				return virtualMountPointFor(absolutePath, platform);
			}
			// UNC or anything else: treat as virtual with slash normalization.
			return toSlashes(absolutePath).replace(/^\/\//, "/");
		},
	};
}
