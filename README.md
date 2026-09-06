# pi-overlayfs

A [pi](https://github.com/earendil-works/pi) extension that routes pi's file-touching tools — **bash, read, write, edit**, plus a new **python** tool — through a virtual overlay filesystem ([@jerryan/just-bash](https://www.npmjs.com/package/@jerryan/just-bash) `createAgentSandbox`).

## What it does

- The real home directory is mounted copy-on-write at virtual `/home/user`; the project directory is either a subpath of that overlay (when it lives inside home) or its own overlay at virtual `/project`.
- All tool file access goes through the overlay: writes **stage in a copy-on-write memory layer** and never touch disk directly.
- Once per turn — at `turn_end`, after **all** tool calls in the batch have completed (pi awaits every execution before emitting it, and awaits the finisher before the next LLM call) — a finisher reviews the staged changes (real host paths) and applies them to disk:
  - **Inside the project root** — auto-approved, applied immediately.
  - **Outside the project root** — one `ctx.ui.confirm` dialog per turn listing the affected paths. Approved paths are applied; denied paths are dropped from the overlay (they never existed as far as disk is concerned).
  - **Headless** (no UI) — outside-project changes are dropped unless `PI_OVERLAYFS_OUTSIDE_PROJECT=approve` is set.
  - **Denied changes are never silent** — the model gets a steering message before its next LLM call listing exactly which paths were discarded (whether rejected by the user/policy or lost to an apply failure), so it doesn't believe its writes persisted. Tool results themselves are left untouched (a write that succeeded in the overlay is reported honestly as success).
- Commands that the sandbox cannot resolve (e.g. `git`, `npm`, `node`) fall back to native host execution automatically (static pre-flight analysis first, runtime exit-127 fallback second). Commands the analyzer cannot parse at all (e.g. Windows cmd-style `%VAR%`/`2>nul` syntax) and commands whose cwd maps to no overlay also run natively.
- **Deletion verbs never ride along with host-only commands.** If one bash call mixes `rm`/`mv`/`rmdir` with natively-routed commands (`rm scratch && cargo build`), the call is rejected and the model is asked to run the deletion as its own separate call — a native route would otherwise let the deletion bypass the overlay and its outside-project gate. Matching is token-exact via the shell parser: `git rm`, `echo rm`, and quoted strings are not flagged. Residual gaps (rare; documented, not handled): verbs hidden from static analysis such as `find -delete`, `xargs rm`, or `bash -c "rm ..."`.
- `bash` and `python` calls default to a **300-second timeout** when the model omits `timeout` (on both the sandboxed and native routes), so a hung script can't stall the session until manual abort. An explicit `timeout` always wins.

Because execution is structurally sandboxed, a model mistake like `rm -rf ~/important` hits throwaway memory; the finisher asks before anything outside the project reaches disk.

## ⚠️ Native fallback amplifies command scope

When a command references a program the sandbox cannot resolve (`git`, `npm`, `node`, pip-installed CLIs, ...), the **entire command line runs natively on the host without isolation** — including any destructive file operations in the same compound command. `rm -rf node_modules && npm install` is *not* sandboxed: the `rm -rf` executes directly against your real disk, because the sandbox cannot split a shell command line across two execution engines.

Keep that in mind yourself when reviewing what the agent runs: single-purpose sandbox commands (`rm -rf node_modules` alone) are staged and reviewable; the same operation glued to an unresolved program with `&&`/`;` is not.

The sandbox detects unresolved commands twice: statically before execution (the whole command goes native untouched), and at runtime via just-bash's fail-fast abort (exit 127). On the runtime path the already-executed prefix may have staged writes in the overlay; those are **discarded before the native rerun** so the finisher can never apply stale staged content over the native run's newer results, and the aborted attempt's output is never shown twice.

### Future: split execution ("migration mechanism")

Running `rm` inside the sandbox and `npm install` natively *from the same compound command* would require migrating fs state between the two engines mid-line. Accepted as out of scope for now. Before building it, evaluate how often it matters: replay historical bash tool calls from pi session files (`~/.pi/agent/sessions`) through `analyzeCommands` and bucket them into fully-sandboxed / native-by-analysis / native-only-at-runtime (statically unverifiable, e.g. command substitutions). The last bucket is what split execution would rescue.

## The python tool

Runs sandboxed CPython (Emscripten) over the **same overlay filesystem as bash**:

```
python({ code: "print(1 + 1)" })
python({ path: "scripts/analyze.py", args: ["--verbose"] })
```

Exactly one of `code` / `path` is required. Paths may be host paths inside the project or virtual POSIX paths (e.g. `/tmp/scratch.py`).

## Path resolution heuristic

Tool operations receive absolute paths (pi resolves relative paths against the host session cwd). The adapter maps them to virtual paths:

1. **Host mapping first** — a path under an overlay root (real home or project dir) maps onto that overlay's virtual mount point.
2. **Already-virtual POSIX passthrough** — a path starting with `/` that is under no overlay root is used as-is (`/tmp/...`, `/project/...`). On POSIX hosts this means genuine host paths outside home/project (e.g. `/etc/...`) are seen as virtual: reads fail with ENOENT, writes land in throwaway memory.
3. **Windows drive-rooted fallback** — a drive-rooted path under no overlay root (`C:\tmp\x`) is treated as a virtual POSIX path with the drive stripped (`/tmp/x`), because pi's host-side `resolve()` roots model-typed POSIX paths at the session drive.

## Limitations

- **No output streaming from the sandbox.** just-bash executes a command to completion and returns all output at once, so bash output appears only when the command finishes (buffered stdout first, then stderr — interleaved ordering is not preserved). Native-fallback commands stream as usual. Also note that on abort/timeout just-bash itself discards accumulated stdout (only its abort diagnostic survives); whatever partial output the sandbox does preserve is emitted before the `timeout:<s>`/`aborted` error is raised.
- **Apply-or-drop: nothing stays pending across turns.** If applying staged changes fails (disk full, permissions, ...), the unapplied remainder is **dropped, not retried** — and the model is told exactly which paths were lost via the discard steering message, alongside an error notification. The overlay is a safety guard, not a durability layer.
- **Headless outside-project writes are lost by default.** Without a UI, staged changes outside the project root are dropped unless `PI_OVERLAYFS_OUTSIDE_PROJECT=approve` — that is the intended safety posture, but it means e.g. `bash` writing to `~/notes.md` in a headless run does not persist (the model is told via the discard steering message).

## Concurrency

The finisher needs no concurrency control of its own: `turn_end` fires only after pi has awaited **every** tool execution in the batch, and pi awaits the finisher before the next LLM call — nothing can be in flight when it runs.

Mutating **executions** (sandboxed bash, python, write, edit) are still serialized with a shared async mutex. The remaining reason is the runtime-fallback abort-discard (H1): it drops what an aborted run staged, and path-level before/after attribution cannot separate same-window writers — a concurrent sibling's writes would be silently discarded along with the aborted run's. Native-route bash commands never touch the overlay and run concurrently as before.

**Planned (Phase 2):** per-call overlay branches with a deterministic merge at `turn_end` (the branch *is* the attribution — aborted calls simply drop their branch, conflicts resolve newest-wins). That removes the mutex entirely and lets mutating executions run concurrently. Finisher errors are reported via notification/console and never modify or break tool results.

## Configuration

| Env var | Values | Default | Meaning |
| --- | --- | --- | --- |
| `PI_OVERLAYFS_OUTSIDE_PROJECT` | `approve` | _(unset)_ | Headless policy for staged changes outside the project root: apply them (`approve`) or drop them (anything else). |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (unit tests against a real sandbox on temp dirs)
npm run build       # emit dist/
```

Load with `pi -e /path/to/pi-overlayfs`.
