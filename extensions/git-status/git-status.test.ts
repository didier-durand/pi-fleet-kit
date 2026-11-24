/**
 * Unit tests for the git-status extension.
 *
 * Run: node --test          (from the extension directory)
 * With coverage: c8 node --test
 *
 * Strategy: the module's only runtime dependency is `git` itself, reached
 * exclusively through `pi.exec`. Tests drive the exported functions with a
 * scriptable fake `pi` whose exec routes on the (cmd, args) signature, plus
 * a capture-only fake UI — so every branch (parsing, caching, guards,
 * rediscovery) is exercised deterministically, with no live git or LLM.
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
	_resetState,
	refresh,
	refreshMulti,
	refreshSingle,
	resolveRepos,
	repoDisplayName,
	shortstatFull,
} from "./git-status.ts";

// --- fakes -------------------------------------------------------------------

interface ExecResult { code: number; stdout: string; stderr: string }
type Route = (args: string[]) => ExecResult;

function fakePi(routes: Record<string, Route>, calls: string[] = []) {
	return {
		exec: async (cmd: string, args: string[]) => {
			const full = `${cmd} ${args.join(" ")}`;
			calls.push(full);
			for (const [pattern, route] of Object.entries(routes)) {
				if (full.includes(pattern)) return route(args);
			}
			return { code: 1, stdout: "", stderr: `unrouted: ${full}` };
		},
	};
}

function fakeCtx() {
	const statuses: Array<string | undefined> = [];
	return {
		hasUI: true,
		ui: {
			setStatus: (_id: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_color: string, text: string) => text }, // passthrough
		},
		statuses,
	};
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail: ExecResult = { code: 128, stdout: "", stderr: "fatal: not a git repository" };

// Patterns routed on the joined args (after the "-C <root>" pair)
const REV_PARSE = "rev-parse --is-inside-work-tree";
const TOPLEVEL = "rev-parse --show-toplevel";
const FIND = "find /workspace";
const ORIGIN = "config --get remote.origin.url";
const STATUS = "status --porcelain=v1 -b";
const DIFF_WT = "diff --shortstat";
const DIFF_IX = "diff --cached --shortstat";
const DIFF_AHEAD = "diff --shortstat @{u}..HEAD";

// --- shortstatFull (pure parsing) --------------------------------------------

test("shortstatFull parses files and +/- line counts", () => {
	assert.deepEqual(
		shortstatFull(" 3 files changed, 156 insertions(+), 89 deletions(-)"),
		{ files: "3", addDel: "+156/−89" },
	);
});

test("shortstatFull handles single-file and insertion-only diffs", () => {
	assert.deepEqual(shortstatFull(" 1 file changed, 12 insertions(+)"), { files: "1", addDel: "+12/−0" });
	assert.deepEqual(shortstatFull(" 2 files changed, 1 insertion(+)"), { files: "2", addDel: "+1/−0" });
});

test("shortstatFull returns empty for unparseable output", () => {
	assert.deepEqual(shortstatFull(""), { files: "", addDel: "" });
	assert.deepEqual(shortstatFull("nothing to see here"), { files: "", addDel: "" });
});

test("shortstatFull: deletion-only and count-less diffs", () => {
	assert.deepEqual(shortstatFull(" 1 file changed, 89 deletions(-)"), { files: "1", addDel: "+0/−89" });
	// no insertion/deletion counts at all: the line stat is meaningless — both empty
	assert.deepEqual(shortstatFull(" 2 files changed"), { files: "", addDel: "" });
});

test("shortstatFull: insertions without a files count", () => {
	assert.deepEqual(shortstatFull(" 900 insertions(+)"), { files: "", addDel: "+900/−0" });
});

// --- repoDisplayName ---------------------------------------------------------

test("repoDisplayName derives the name from an https origin URL, .git stripped", async () => {
	const pi = fakePi({ [ORIGIN]: () => ok("https://github.com/didier-durand/pi-fleet-kit.git\n") });
	assert.equal(await repoDisplayName(pi as never, "/ws/repo"), "pi-fleet-kit");
});

test("repoDisplayName handles scp-style URLs (git@host:user/repo.git)", async () => {
	const pi = fakePi({ [ORIGIN]: () => ok("git@github.com:acme/widget-engine.git\n") });
	assert.equal(await repoDisplayName(pi as never, "/ws/widget-engine"), "widget-engine");
});

test("repoDisplayName falls back to the directory basename without origin", async () => {
	const pi = fakePi({ [ORIGIN]: () => fail });
	assert.equal(await repoDisplayName(pi as never, "/home/pi/some-clone"), "some-clone");
});

test("repoDisplayName falls back to the basename when origin exists but is empty", async () => {
	const pi = fakePi({ [ORIGIN]: () => ok("\n") }); // code 0, blank URL
	assert.equal(await repoDisplayName(pi as never, "/ws/fallback-dir"), "fallback-dir");
});

test("repoDisplayName falls back when the URL's last segment is empty (trailing colon)", async () => {
	const pi = fakePi({ [ORIGIN]: () => ok("git@github.com:\n") });
	assert.equal(await repoDisplayName(pi as never, "/ws/fallback-dir"), "fallback-dir");
});

test("repoDisplayName caches per root (no repeated git config call)", async () => {
	const calls: string[] = [];
	const pi = fakePi({ [ORIGIN]: () => ok("https://github.com/u/r.git\n") }, calls);
	assert.equal(await repoDisplayName(pi as never, "/ws/r"), "r");
	assert.equal(await repoDisplayName(pi as never, "/ws/r"), "r"); // cache hit
	assert.equal(calls.filter((c) => c.includes("config")).length, 1);
});

// --- resolveRepos ------------------------------------------------------------

test("resolveRepos: cwd toplevel wins and is included", async () => {
	const pi = fakePi({
		[TOPLEVEL]: () => ok("/workspace\n"),
		[FIND]: () => ok(""),
	});
	assert.deepEqual(await resolveRepos(pi as never), ["/workspace"]);
});

test("resolveRepos: nested clones discovered, node_modules excluded, shallowest first", async () => {
	const pi = fakePi({
		[TOPLEVEL]: () => fail,
		[FIND]: () => ok([
			"/workspace/a/deep/nest/.git",      // deeper
			"/workspace/node_modules/pkg/.git", // must be excluded
			"/workspace/b/.git",                // shallow
			"/workspace/b/.git",                // duplicate
		].join("\n") + "\n"),
	});
	assert.deepEqual(await resolveRepos(pi as never), ["/workspace/b", "/workspace/a/deep/nest"]);
});

test("resolveRepos: dedupes the cwd toplevel found again by the scan", async () => {
	const pi = fakePi({
		[TOPLEVEL]: () => ok("/workspace/repo\n"),
		[FIND]: () => ok("/workspace/repo/.git\n"),
	});
	assert.deepEqual(await resolveRepos(pi as never), ["/workspace/repo"]);
});

test("resolveRepos: empty workspace yields empty list", async () => {
	const pi = fakePi({ [TOPLEVEL]: () => fail, [FIND]: () => ok("") });
	assert.deepEqual(await resolveRepos(pi as never), []);
});

// --- refreshSingle -----------------------------------------------------------

const OK_STATUS = "## main...origin/main [ahead 2, behind 1]\n M a.txt\n?? b.txt\n";
const CLEAN_STATUS = "## main...origin/main\n";

function singleRoutes(opts: {
	status?: string; statusCode?: number;
	wt?: string; ix?: string; ahead?: string;
	origin?: string;
} = {}) {
	return {
		[ORIGIN]: () => ok(opts.origin ?? "https://github.com/u/widget.git\n"),
		[STATUS]: () => (opts.statusCode ? fail : ok(opts.status ?? OK_STATUS)),
		// DIFF_AHEAD must precede DIFF_WT: "diff --shortstat @{u}..HEAD"
		// contains "diff --shortstat" and the router matches first-hit.
		[DIFF_AHEAD]: () => ok(opts.ahead ?? " 2 files changed, 41 insertions(+), 12 deletions(-)"),
		[DIFF_WT]: () => ok(opts.wt ?? " 1 file changed, 10 insertions(+), 4 deletions(-)"),
		[DIFF_IX]: () => ok(opts.ix ?? " 1 file changed, 1 insertion(+)"),
	};
}

test("refreshSingle renders the rich footer (name, branch, ahead/behind, dirty lines)", async () => {
	_resetState();
	const pi = fakePi(singleRoutes());
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses.length, 1);
	assert.equal(
		ctx.statuses[0],
		"widget: ⎇ main ↑ c:2 f:2 l:+41/−12 ↓ c:1 ● f:2 l:+11/−4",
	);
});

test("refreshSingle shows a clean repo as ✓clean with no counts", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ status: CLEAN_STATUS }));
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ main ✓clean");
});

test("refreshSingle hides the ↑ segment for behind-only divergence", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ status: "## main...origin/main [behind 5]\n" }));
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ main ↓ c:5 ✓clean");
});

test("refreshSingle: detached head and no-commits-yet render sanely", async () => {
	_resetState();
	const ctx = fakeCtx();
	await refreshSingle(fakePi(singleRoutes({ status: "## HEAD (no branch)\n" })) as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ HEAD (no branch) ✓clean");

	_resetState();
	const ctx2 = fakeCtx();
	await refreshSingle(fakePi(singleRoutes({ status: "## No commits yet on main\n" })) as never, ctx2 as never, "/ws/widget");
	assert.equal(ctx2.statuses[0], "widget: ⎇ main ✓clean");
});

test("refreshSingle: line counts beyond the guard render as >500", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ wt: " 1 file changed, 900 insertions(+)" }));
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.match(ctx.statuses[0] as string, /● f:2 l:>500/);
	assert.match(ctx.statuses[0] as string, /↑ c:2 f:2 l:\+41\/−12/); // ahead diff unaffected
});

test("refreshSingle: worktree and index shortstats are summed when they differ", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ wt: " 2 files changed, 10 insertions(+), 3 deletions(-)", ix: " 1 file changed, 5 insertions(+), 1 deletion(-)" }));
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.match(ctx.statuses[0] as string, /● f:2 l:\+15\/−4/);
});

test("refreshSingle: oversized dirty set skips diffing and shows the f: guard", async () => {
	_resetState();
	const dirty = ["## main...origin/main", ...Array.from({ length: 501 }, (_, i) => `?? f${i}`)].join("\n");
	const calls: string[] = [];
	const pi = fakePi(singleRoutes({ status: dirty }), calls);
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.match(ctx.statuses[0] as string, /● f:501 l:>500/);
	assert.equal(calls.filter((c) => c.includes("diff")).length, 0); // no diffs at all
});

test("refreshSingle: no upstream configured — no ahead/behind, no ahead diff", async () => {
	_resetState();
	const calls: string[] = [];
	const pi = fakePi(singleRoutes({ status: "## main\n M a.txt\n" }), calls);
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ main ● f:1 l:+11/−4");
	assert.equal(calls.filter((c) => c.includes("@{u}")).length, 0);
});

test("refreshSingle: git failure resets the tracked repo and clears the status", async () => {
	_resetState();
	const ctx = fakeCtx();
	await refreshSingle(fakePi(singleRoutes({ statusCode: 1 })) as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], undefined);
});

test("refreshSingle: diff output unparseable — dirty file still shown without line stats", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ wt: "", ix: "" }));
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ main ↑ c:2 f:2 l:+41/−12 ↓ c:1 ● f:2");
});

test("refreshSingle: empty status output renders detached + clean", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ status: "" })); // git succeeded, no output
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ detached ✓clean");
});

test("refreshSingle: ahead commits but unparseable ahead diff — count without line stats", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ status: "## main...origin/main [ahead 2]\n", ahead: "" }));
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ main ↑ c:2 ✓clean");
});

test("refreshSingle: ahead diff beyond the line guard renders >500", async () => {
	_resetState();
	const pi = fakePi(singleRoutes({ status: "## main...origin/main [ahead 3]\n", ahead: " 2 files changed, 900 insertions(+)" }));
	const ctx = fakeCtx();
	await refreshSingle(pi as never, ctx as never, "/ws/widget");
	assert.equal(ctx.statuses[0], "widget: ⎇ main ↑ c:3 f:2 l:>500L ✓clean");
});

// --- refreshMulti ------------------------------------------------------------

function multiRoute(status: string) { return () => ok(status); }

test("refreshMulti renders one compact segment per repo", async () => {
	_resetState();
	const pi = fakePi({
		[STATUS]: (args: string[]) => {
			if (args[1] === "/ws/api") return multiRoute("## main...o [ahead 2]\n M a\n")(args);
			if (args[1] === "/ws/web") return multiRoute("## feat/ui\n")(args);
			return multiRoute("## main...o [behind 1]\n M x\n M y\n M z\n")(args);
		},
	});
	const ctx = fakeCtx();
	await refreshMulti(pi as never, ctx as never, ["/ws/api", "/ws/web", "/ws/docs"]);
	assert.equal(ctx.statuses[0], "api: ⎇ main ↑2 ●1 │ web: ⎇ feat/ui ✓ │ docs: ⎇ main ↓1 ●3");
});

test("refreshMulti caps segments at 5 and reports '+N more'", async () => {
	_resetState();
	const pi = fakePi({ [STATUS]: () => multiRoute(CLEAN_STATUS)() });
	const ctx = fakeCtx();
	await refreshMulti(pi as never, ctx as never, ["/ws/r1", "/ws/r2", "/ws/r3", "/ws/r4", "/ws/r5", "/ws/r6", "/ws/r7"]);
	assert.equal(ctx.statuses[0], "r1: ⎇ main ✓ │ r2: ⎇ main ✓ │ r3: ⎇ main ✓ │ r4: ⎇ main ✓ │ r5: ⎇ main ✓ +2 more");
});

test("refreshMulti: all repos stale triggers a state reset and clears the status", async () => {
	_resetState();
	const pi = fakePi({ [STATUS]: () => fail });
	const ctx = fakeCtx();
	await refreshMulti(pi as never, ctx as never, ["/ws/r1"]);
	assert.equal(ctx.statuses[0], undefined);
});

test("refreshMulti: a single stale repo is skipped, others still render", async () => {
	_resetState();
	const pi = fakePi({
		[STATUS]: (args: string[]) => (args[1] === "/ws/dead" ? fail : multiRoute(CLEAN_STATUS)()),
	});
	const ctx = fakeCtx();
	await refreshMulti(pi as never, ctx as never, ["/ws/dead", "/ws/live"]);
	assert.equal(ctx.statuses[0], "live: ⎇ main ✓");
});

test("refreshMulti: oversized dirty repo shows the f: guard", async () => {
	_resetState();
	const dirty = ["## main...o", ...Array.from({ length: 501 }, (_, i) => `?? f${i}`)].join("\n");
	const pi = fakePi({ [STATUS]: (args: string[]) => (args[1] === "/ws/big" ? multiRoute(dirty)() : multiRoute(CLEAN_STATUS)()) });
	const ctx = fakeCtx();
	await refreshMulti(pi as never, ctx as never, ["/ws/big", "/ws/small"]);
	assert.equal(ctx.statuses[0], "big: ⎇ main ●f:501 │ small: ⎇ main ✓");
});

test("refreshMulti: empty status output renders detached + clean", async () => {
	_resetState();
	const pi = fakePi({ [STATUS]: () => multiRoute("")() });
	const ctx = fakeCtx();
	await refreshMulti(pi as never, ctx as never, ["/ws/odd"]);
	assert.equal(ctx.statuses[0], "odd: ⎇ detached ✓");
});

// --- refresh (dispatch + rediscovery) ----------------------------------------

test("refresh: no UI (print/JSON mode) does nothing", async () => {
	_resetState();
	const pi = fakePi({ [TOPLEVEL]: () => ok("/workspace\n") });
	const ctx = { ...fakeCtx(), hasUI: false };
	await refresh(pi as never, ctx as never);
	assert.equal(ctx.statuses.length, 0);
});

test("refresh: no repos anywhere clears the status", async () => {
	_resetState();
	const pi = fakePi({ [TOPLEVEL]: () => fail, [FIND]: () => ok("") });
	const ctx = fakeCtx();
	await refresh(pi as never, ctx as never);
	assert.equal(ctx.statuses[0], undefined);
});

test("refresh: exactly one repo takes the rich path, several take the compact path", async () => {
	_resetState();
	const ctx = fakeCtx();
	await refresh(
		fakePi({
			[TOPLEVEL]: () => ok("/workspace\n"),
			[FIND]: () => ok(""),
			[ORIGIN]: () => ok("https://github.com/u/widget.git\n"),
			[STATUS]: () => multiRoute(CLEAN_STATUS)(),
		}) as never,
		ctx as never,
	);
	assert.equal(ctx.statuses[0], "widget: ⎇ main ✓clean");

	_resetState();
	const ctx2 = fakeCtx();
	await refresh(
		fakePi({
			[TOPLEVEL]: () => fail,
			[FIND]: () => ok("/workspace/a/.git\n/workspace/b/.git\n"),
			[STATUS]: () => multiRoute(CLEAN_STATUS)(),
		}) as never,
		ctx2 as never,
	);
	assert.equal(ctx2.statuses[0], "a: ⎇ main ✓ │ b: ⎇ main ✓");
});

test("refresh: a tracked repo vanishing triggers full rediscovery in the same tick", async () => {
	_resetState();
	const alive = { on: true };
	const pi = fakePi({
		[REV_PARSE]: () => (alive.on ? ok("true\n") : fail),
		[TOPLEVEL]: () => (alive.on ? ok("/workspace\n") : fail),
		[FIND]: () => ok(""),
		[ORIGIN]: () => ok("https://github.com/u/widget.git\n"),
		[STATUS]: () => multiRoute(CLEAN_STATUS)(),
	});
	const ctx = fakeCtx();
	await refresh(pi as never, ctx as never); // seeds repos = ["/workspace"]
	assert.match(ctx.statuses[0] as string, /^widget:/);

	alive.on = false; // repo disappears...
	await refresh(pi as never, ctx as never); // ...rediscovery finds nothing
	assert.equal(ctx.statuses[1], undefined);

	alive.on = true; // ...and reappears (replacement clone)
	await refresh(pi as never, ctx as never);
	assert.match(ctx.statuses[2] as string, /^widget:/);
});

// --- extension factory (event wiring) ----------------------------------------

test("default export registers the expected events and cleans up on shutdown", async () => {
	const { default: activate } = await import("./git-status.ts");
	const handlers: Record<string, unknown> = {};
	const pi = {
		on: (event: string, handler: unknown) => { handlers[event] = handler; },
		// refresh paths run against an empty workspace — never routed
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	};
	activate(pi as never);
	assert.ok("session_start" in handlers);
	assert.ok("session_shutdown" in handlers);
	assert.ok("tool_result" in handlers);
	assert.ok("agent_start" in handlers);
	assert.ok("agent_end" in handlers);

	// session_start triggers a refresh (which clears the status in an empty
	// workspace) and starts the poll interval; shutdown must clear it — a
	// leaked interval would keep the test process alive forever.
	_resetState();
	const ctx = fakeCtx();
	await (handlers.session_start as (e: unknown, c: unknown) => Promise<void>)(null, ctx);
	assert.equal(ctx.statuses[0], undefined);

	// settle the fire-and-forget refreshes before shutting down
	await new Promise((r) => setImmediate(r));
	await (handlers.session_shutdown as () => Promise<void>)();
	// no further activity: the interval is gone — a second settle tick stays quiet
	await new Promise((r) => setImmediate(r));
});

test("factory runtime: throttling coalesces bursts, poll ticks refresh, shutdown stops them", { timeout: 5000 }, async (t) => {
	const { default: activate } = await import("./git-status.ts");
	// Mocked Date + timers: deterministic throttle/interval testing — no
	// wall-clock coupling. The 10s poll period keeps the interval silent
	// until the poll section deliberately advances 10s per tick.
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
	_resetState();
	const handlers: Record<string, (e?: unknown, c?: unknown) => Promise<void>> = {};
	const pi = {
		on: (event: string, handler: (e?: unknown, c?: unknown) => Promise<void>) => { handlers[event] = handler; },
		exec: async () => ({ code: 1, stdout: "", stderr: "" }), // empty workspace
	};
	activate(pi as never);
	const ctx = fakeCtx();
	process.env.PI_GIT_POLL_MS = "10000";
	const settle = () => new Promise((r) => setImmediate(r));
	try {
		await handlers.session_start(null, ctx);
		await settle();
		const base = ctx.statuses.length; // 1 from the session_start refresh

		// tool_result refreshes immediately (first call is not throttled).
		// mocked Date starts at 0 and `last` is still 0, so advance the clock
		// past MIN_INTERVAL_MS first — otherwise the call looks throttled.
		t.mock.timers.tick(1000);
		await handlers.tool_result(null, ctx);
		await settle();
		assert.equal(ctx.statuses.length, base + 1);

		// ...a burst within the 500ms window is coalesced into one trailing
		// refresh, scheduled at MIN_INTERVAL_MS after the last refresh
		t.mock.timers.tick(100);
		await handlers.tool_result(null, ctx);
		await settle();
		t.mock.timers.tick(100);
		await handlers.tool_result(null, ctx);
		await settle();
		assert.equal(ctx.statuses.length, base + 1); // nothing new yet
		t.mock.timers.tick(400); // trailing setTimeout (400ms) becomes due
		await settle();
		assert.equal(ctx.statuses.length, base + 2);

		// the poll interval refreshes on its own (external-change simulation):
		// each 10s tick fires one throttled refresh
		const before = ctx.statuses.length;
		t.mock.timers.tick(10000);
		await settle();
		assert.ok(ctx.statuses.length > before, "poll tick must refresh");

		// while an agent turn is streaming, poll ticks are suppressed
		await handlers.agent_start();
		const during = ctx.statuses.length;
		t.mock.timers.tick(10000);
		await settle();
		assert.equal(ctx.statuses.length, during); // no tick while streaming
		await handlers.agent_end();

		// a second session_start clears the previous poll timer (line: clearInterval)
		await handlers.session_start(null, ctx);
		await settle();

		// shutdown stops the interval: advancing time changes nothing anymore
		await handlers.session_shutdown();
		const end = ctx.statuses.length;
		t.mock.timers.tick(30000);
		await settle();
		assert.equal(ctx.statuses.length, end);
	} finally {
		delete process.env.PI_GIT_POLL_MS;
		t.mock.timers.reset();
	}
});
