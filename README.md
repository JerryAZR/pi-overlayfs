# pi-overlayfs

A [pi](https://github.com/earendil-works/pi) package shipping two extensions built on one execution engine — per-call copy-on-write filesystem forks ([@jerryan/just-bash](https://www.npmjs.com/package/@jerryan/just-bash) `createVfsTemplate`):

1. **overlayfs** (`extensions/overlayfs.ts`) — routes pi's file-touching tools (**bash, read, write, edit**, plus a new **python** tool) through the fork machinery with a per-turn apply/approve finisher.
2. **subagents** (`extensions/subagents.ts`) — **delegate / review / explore / follow_up** tools. Read-only agents run fail-closed on the same engine; delegate agents are ordinary pi sessions that inherit the overlayfs extension themselves.

> **Incompatible with [pi-subagent-tools](https://www.npmjs.com/package/@jerryan/pi-subagent-tools):** the subagents extension registers the same four tool names. Install one or the other, not both.

## Tools defined

| Extension | Tool names |
|---|---|
| overlayfs | `bash`, `read`, `write`, `edit` (replacing pi's built-ins by name), `python` (new) |
| subagents | `delegate`, `review`, `explore`, `follow_up` (new) |

The built-in replacements are intentional name overrides. If another extension registers the same tool names, pi's first-registration-wins rule decides which implementation is active.

## What it does

- The real home directory is mounted copy-on-write at its **real-layout virtual path**: on POSIX that's the identical path (`/home/jerry` → `/home/jerry`); on Windows it's the MSYS form (`C:\Users\Jerry` → `/c/Users/Jerry`). The project directory is either a subpath of the home mount (when it lives inside home) or its own mount, also at its real-layout path. Because pi's native route always runs through an MSYS-family bash on Windows (and the real shell on POSIX), **one path form is understood by both the sandbox and native commands** — sandboxed `pwd` output can be pasted into a native command unchanged, and native-spelling `C:\...` paths typed into a sandboxed command are translated to the virtual form (just-bash ≥ 3.10). `/tmp` is shared scratch memory (in-sandbox only; native commands see the host temp dir instead).
- **Every tool call gets a fresh COW fork.** Writes land in the call's private memory layer and never touch disk directly; calls never see each other's uncommitted writes (fork(2) semantics — `/tmp` is the shared channel). Calls run fully concurrently: isolation comes from the topology, not from locking.
- Once per turn — at `turn_end`, after **all** tool calls in the batch have completed (pi awaits every execution before emitting it, and awaits the finisher before the next LLM call) — the turn's forks are **merged** into one change set (deterministic: later `changedAt` wins conflicts, ties by completion order) and a finisher applies it to disk:
  - **Inside the project root** — auto-approved, applied immediately.
  - **Outside the project root** — one `ctx.ui.confirm` dialog per turn listing each staged change with a git-style code (`A` new, `M` modified, `D` deleted; symlinks show their target). Approved changes are applied; denied ones are discarded (they never existed as far as disk is concerned).
  - **Headless** (no UI) — outside-project changes are discarded unless `PI_OVERLAYFS_OUTSIDE_PROJECT=approve` is set.
  - **Discarded changes are never silent** — the model gets a steering message before its next LLM call listing exactly which paths were dropped (whether rejected by the user/policy or lost to an apply failure), so it doesn't believe its writes persisted. Tool results themselves are left untouched (a write that succeeded in its fork is reported honestly as success).
- Commands that the sandbox cannot resolve (e.g. `git`, `npm`, `node`) fall back to native host execution automatically (static pre-flight analysis first, runtime exit-127 fallback second). Commands the analyzer cannot parse at all (e.g. Windows cmd-style `%VAR%`/`2>nul` syntax) and commands whose cwd maps to no overlay also run natively.
- **Deletion verbs never ride along with host-only commands.** If one bash call mixes `rm`/`mv`/`rmdir` with natively-routed commands (`rm scratch && cargo build`), the call is rejected and the model is asked to run the deletion as its own separate call — a native route would otherwise let the deletion bypass the overlay and its outside-project gate. The gate holds on **both** fallback paths: statically unresolved commands, and commands composed at runtime (e.g. `$(echo sometool)`) that only surface as unresolved mid-run. Matching is token-exact via the shell parser: `git rm`, `echo rm`, and quoted strings are not flagged. Residual gaps (rare; documented, not handled): verbs hidden from static analysis such as `find -delete`, `xargs rm`, or `bash -c "rm ..."`.
- `bash` and `python` calls default to a **300-second timeout** when the model omits `timeout` (on both the sandboxed and native routes), so a hung script can't stall the session until manual abort. An explicit `timeout` always wins.

Because execution is structurally sandboxed, a model mistake like `rm -rf ~/important` hits a throwaway fork; the finisher asks before anything outside the project reaches disk. Calls that abort, time out, or fall back to native never register their fork, so their partial writes never reach the merge; completed calls register regardless of exit code (effects before a failure are legitimate).

## ⚠️ Native fallback amplifies command scope

When a command references a program the sandbox cannot resolve (`git`, `npm`, `node`, pip-installed CLIs, ...), the **entire command line runs natively on the host without isolation** — including any destructive file operations in the same compound command. `rm -rf node_modules && npm install` is *not* sandboxed: the `rm -rf` executes directly against your real disk, because the sandbox cannot split a shell command line across two execution engines.

Keep that in mind yourself when reviewing what the agent runs: single-purpose sandbox commands (`rm -rf node_modules` alone) are staged and reviewable; the same operation glued to an unresolved program with `&&`/`;` is not.

The sandbox detects unresolved commands twice: statically before execution (the whole command goes native untouched), and at runtime via just-bash's fail-fast abort (exit 127). On the runtime path the already-executed prefix may have staged writes in its fork; that fork is **never registered for the merge**, so no stale staged content can be applied over the native rerun's newer results, and the aborted attempt's output is never shown twice.

### Future: split execution ("migration mechanism")

Running `rm` inside the sandbox and `npm install` natively *from the same compound command* would require migrating fs state between the two engines mid-line. Accepted as out of scope for now. Historical session analysis (4,809 bash calls) shows the mixed pattern is ~2% of calls and dominated by scratch-file cleanup — the mixed rm/mv rejection above covers the deletion slice; the rest stays native by design.

## The python tool

Runs sandboxed CPython (Emscripten) in a fresh fork per call, over the same virtual filesystem as bash:

```
python({ code: "print(1 + 1)" })
python({ path: "scripts/analyze.py", args: ["--verbose"] })
```

Exactly one of `code` / `path` is required. Paths may be host paths inside the project or virtual POSIX paths (e.g. `/tmp/scratch.py`).

## Path resolution heuristic

Tool operations receive absolute paths (pi resolves relative paths against the host session cwd). The adapter maps them to virtual paths:

1. **Host mapping first** — a path under a mount root (real home or project dir) maps onto that root's real-layout mount point (`C:\Users\Jerry\x` → `/c/Users/Jerry/x`; `/home/jerry/x` → `/home/jerry/x`).
2. **Already-virtual POSIX passthrough** — a path starting with `/` that is under no mount root is used as-is (`/tmp/...`, or an MSYS-form `/c/...` the model typed). On POSIX hosts this means genuine host paths outside home/project (e.g. `/etc/...`) are seen as virtual: reads fail with ENOENT, and writes land in the session's shared scratch — same as `/tmp`: visible to later calls for the rest of the session, never applied to disk, gone at session end.
3. **Windows drive-rooted fallback** — a drive-rooted path under no mount root (`C:\tmp\x`) maps to its real-layout virtual form (`/c/tmp/x`). pi's host-side `resolve()` roots both model-typed POSIX paths (`/tmp/x`) and MSYS paths (`/c/tmp/x`) at the session drive, and this rule maps both spellings to the same virtual path.

## Subagent tools

Four tools for spawning in-process subagent sessions (pi SDK `createAgentSession` — sessions, not subprocesses):

| Tool | Surface | Purpose |
| --- | --- | --- |
| `delegate` | full tools (inherits all extensions) | General-purpose work that needs write access |
| `review` | read-only | Code/diff review in the current project |
| `explore` | read-only | Mapping an unfamiliar project (any `cwd`) |
| `follow_up` | — | Continue a live subagent's session with full context (`agent` id + new task) |

**Read-only agents** (`review`/`explore`) run on the same engine as the main session — same mount topology (real-layout home and project mounts), per-call forks, shared `/tmp` scratch — with these deliberate deltas:

- **Fail-closed bash: no native fallback, ever.** Unresolved commands (`npm`, `node`, third-party CLIs) report `command not found` (exit 127) in-band instead of being rerouted to the host — a read-only agent has no host execution capability at all. `git` is provided *inside* the sandbox via [just-git](https://www.npmjs.com/package/just-git) with networking disabled (mutating verbs like `commit`/`checkout`/`reset` are disabled as UX; the fs boundary is the real enforcement).
- **Mounts are read-only (EROFS).** Writes through an overlay fail loudly at the write site (just-bash `readOnly` template option). Nothing is ever merged or applied — there is no finisher, no confirm, no write path to disk.
- **The whole surface comes from the sandbox.** Their `read` is the overlay read tool (fresh fork per call, live disk reads, mount-confined like `bash cat`) — pi's unconstrained native read/write/edit never enter reader sessions.
- **python** is available (same sandboxed CPython, same fs), so read-only agents can write and run temporary analysis scripts in `/tmp`.

**Delegate agents** are plain pi sessions: they load extensions naturally — including this package's overlayfs extension, which gives each delegate its own template and per-`turn_end` finisher (its confirms surface in the parent TUI through a serialized dialog bridge) — and this subagents extension, so delegates can themselves spawn review/explore agents. Recursion is bounded structurally: `delegate` is denied to child sessions (`excludeTools`), and read-only children load no extensions at all, so the chain can never grow past delegate → read-only.

**Lifecycle:** agent ids are `<role>-<n>` and reported in every result footer. `follow_up` resumes the live session (auto-compacting first when context exceeds 50%); concurrent `follow_up`s on the same agent serialize through a per-agent run chain (parallel calls on *different* agents run in parallel). Agents idle for more than 10 owning-session turns are disposed by a recency sweep (never while streaming); everything is disposed at session shutdown.

## Limitations

- **No output streaming from the sandbox.** just-bash executes a command to completion and returns all output at once, so bash output appears only when the command finishes (buffered stdout first, then stderr — interleaved ordering is not preserved). Native-fallback commands stream as usual. Also note that on abort/timeout just-bash itself discards accumulated stdout (only its abort diagnostic survives); whatever partial output the sandbox does preserve is emitted before the `timeout:<s>`/`aborted` error is raised.
- **Parallel calls can't see each other's project writes.** Forks are isolated until the turn_end merge: two calls in the same batch cannot exchange files through the project — use `/tmp` (shared scratch) for that, or sequence the calls into separate turns. A dependent call must be its own message anyway (batches run in parallel).
- **Apply-or-drop: nothing stays pending across turns.** If applying the merged changes fails per entry (disk full, permissions, ...), the failed entries are **discarded, not retried** — and the model is told exactly which paths were lost via the discard steering message, alongside an error notification. The overlay is a safety guard, not a durability layer.
- **Headless outside-project writes are lost by default.** Without a UI, staged changes outside the project root are discarded unless `PI_OVERLAYFS_OUTSIDE_PROJECT=approve` — that is the intended safety posture, but it means e.g. `bash` writing to `~/notes.md` in a headless run does not persist (the model is told via the discard steering message).

## Concurrency

The overlay engine has **no locks**: safety comes from the fork topology and pi's loop structure. (The subagent layer has one deliberate exception: a per-agent run chain serializing same-agent runs — see Lifecycle above.)

- Every mutating call writes only to its **private fork**, so concurrent calls can't interleave destructively or see half-staged state.
- A failed/aborted call's fork is simply never registered — that is the entire "discard" (the fork *is* the attribution; there is nothing to clean up).
- Registration is a synchronous `push`; `/tmp` scratch ops are atomic per op with ordinary shared-fs semantics.
- Merge+apply runs at `turn_end`, which pi emits only after awaiting **every** execution in the batch, and pi awaits the finisher before the next LLM call — nothing can be in flight. Merge conflicts are deterministic (later `changedAt` wins).
- Native-route bash commands never touch any fork and run concurrently as before.

Finisher errors are reported via notification/console and never modify or break tool results.

## Configuration

| Env var | Values | Default | Meaning |
| --- | --- | --- | --- |
| `PI_OVERLAYFS_OUTSIDE_PROJECT` | `approve` | _(unset)_ | Headless policy for staged changes outside the project root: apply them (`approve`) or drop them (anything else). |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest (unit tests against a real vfs template on temp dirs)
npm run build       # emit dist/
```

Layout: `extensions/` holds the two thin extension entries; `src/overlay/` is the shared engine (fork topology, bash/python execution, finisher, path mapping); `src/subagent/` is the subagent extension's implementation.

Load with `pi -e /path/to/pi-overlayfs` (both extensions), or install it as a package in your pi config. Note that `-e` loads are session-ephemeral: delegate children re-discover extensions from the settings and project dirs, so a package install is what lets delegates inherit the overlayfs sandbox themselves.
