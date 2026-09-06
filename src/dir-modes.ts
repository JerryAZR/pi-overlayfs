/**
 * Directory mode normalizer for the sandboxed CPython worker.
 *
 * On Windows hosts, real directories report mode 0o40666 (no execute bit).
 * The just-bash python worker derives emscripten permissions via
 * `stat.mode & 0o777`, so chdir into any real-disk-backed overlay directory
 * fails with EACCES ("Permission denied") — the sandboxed bash commands do
 * not check mode bits, but the CPython worker does.
 *
 * This wrapper presents the same filesystem with directory search bits set
 * (0o111) so the worker can chdir into overlay directories on Windows. It is
 * a no-op on POSIX hosts where real dirs already carry 0o755. Only the python
 * tool's Bash instance needs it.
 *
 * NOTE: the proper fix belongs upstream in just-bash (worker getattr or
 * OverlayFs stat mode reporting on Windows); keep this wrapper until then.
 */
import type { FsStat, IFileSystem } from "@jerryan/just-bash";

function withDirectorySearchBits(stat: FsStat): FsStat {
	if (!stat.isDirectory) return stat;
	return { ...stat, mode: stat.mode | 0o111 };
}

export function normalizeDirectoryModes(inner: IFileSystem): IFileSystem {
	return new Proxy(inner, {
		get(target, prop, receiver) {
			if (prop === "stat") {
				return async (...args: Parameters<IFileSystem["stat"]>) =>
					withDirectorySearchBits(await target.stat(...args));
			}
			if (prop === "lstat") {
				return async (...args: Parameters<IFileSystem["lstat"]>) =>
					withDirectorySearchBits(await target.lstat(...args));
			}
			const value = Reflect.get(target, prop, receiver);
			// Bind methods so private-field access still sees the real instance.
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
