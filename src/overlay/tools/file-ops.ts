/**
 * read/write/edit operations adapters: map the absolute paths pi hands the
 * tools to virtual vfs paths (see paths.ts resolveToolPath) and delegate to
 * the sandbox filesystem. Pi's own tool factories retain all logic
 * (truncation, image handling, edit matching); only the storage layer moves.
 */
import path from "node:path";
import type { EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import type { BufferEncoding } from "@jerryan/just-bash";

/** Minimal vfs surface used by the adapters (satisfied by just-bash IFileSystem). */
export interface OverlayVfs {
	readFileBuffer(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: string | Uint8Array, options?: { encoding?: BufferEncoding }): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	exists(path: string): Promise<boolean>;
}

export type ToolPathResolver = (absolutePath: string) => string;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

export function createOverlayReadOps(vfs: OverlayVfs, resolve: ToolPathResolver): ReadOperations {
	return {
		readFile: async (absolutePath) => Buffer.from(await vfs.readFileBuffer(resolve(absolutePath))),
		access: async (absolutePath) => {
			if (!(await vfs.exists(resolve(absolutePath)))) {
				// pi's edit tool checks `"code" in error` for formatting — set it.
				const error = new Error(`ENOENT: no such file or directory, access '${absolutePath}'`) as Error & {
					code: string;
				};
				error.code = "ENOENT";
				throw error;
			}
		},
		detectImageMimeType: async (absolutePath) =>
			IMAGE_MIME_BY_EXT[path.posix.extname(resolve(absolutePath)).toLowerCase()] ?? null,
	};
}

export function createOverlayWriteOps(vfs: OverlayVfs, resolve: ToolPathResolver): WriteOperations {
	return {
		writeFile: async (absolutePath, content) => {
			await vfs.writeFile(resolve(absolutePath), content, { encoding: "utf8" });
		},
		mkdir: async (dir) => {
			await vfs.mkdir(resolve(dir), { recursive: true });
		},
	};
}

export function createOverlayEditOps(vfs: OverlayVfs, resolve: ToolPathResolver): EditOperations {
	const readOps = createOverlayReadOps(vfs, resolve);
	const writeOps = createOverlayWriteOps(vfs, resolve);
	return {
		readFile: readOps.readFile,
		writeFile: writeOps.writeFile,
		access: readOps.access,
	};
}
