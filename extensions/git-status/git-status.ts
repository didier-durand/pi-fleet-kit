/**
 * git-status extension — reflect the workspace's git state live in the Pi UI.
 *
 * Shows a footer status line: branch, ahead/behind vs upstream, and the
 * number of uncommitted changes. Refreshes after every tool call (bash /
 * edit / write all mutate git state), on agent turns ending, and at session
 * start. Discovers which repos to track: /workspace itself, plus every
 * nested clone found by a bounded scan (retried while none exist). With a
 * single repo the footer is rich (ahead/behind + line stats); with several,
 * it renders one compact segment per repo, prefixed by the repo name.
 *
 * Linux/macOS/Windows(Git Bash) compatible: plain `git` plumbing only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ID = "git-status";
const MIN_INTERVAL_MS = 500; // throttle: git runs at most ~2x/second
const DIFF_FILE_LIMIT = 500; // per-repo dirty-file cap before diffing is skipped
const LINE_LIMIT = 500;      // changed-lines guard for the +/- display
const MAX_REPOS = 5;         // compact segments shown when several repos exist

// The repos the footer tracks (absolute paths), discovered at session start
// and re-discovered whenever one disappears.
let repos: string[] = [];

async function resolveRepos(pi: ExtensionAPI): Promise<string[]> {
	const found: string[] = [];
	// (a) cwd (= /workspace) already inside a repo? `rev-parse` also works
	// from a subdirectory and resolves to the containing toplevel.
	const top = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (top.code === 0) {
		const t = top.stdout.trim();
		if (t) found.push(t);
	}
	// (b) nested clones: bounded scan for .git dirs; node_modules excluded
	// (dependency trees may contain vendored .git dirs at shallow depth).
	const scan = await pi.exec("find", ["/workspace", "-maxdepth", "3", "-name", ".git", "-type", "d"]);
	if (scan.code === 0) {
		for (const p of scan.stdout.split("\n").filter(Boolean)) {
			found.push(p.replace(/\/\.git$/, ""));
		}
	}
	return [...new Set(found
		.filter((p) => !/(^|\/)node_modules(\/|$)/.test(p)))]
		.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

async function refresh(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return; // print/JSON mode: no UI to update

	// Verify known repos; any disappearance triggers a full rediscovery so
	// replacements and new clones are picked up on the same tick. The scan
	// only runs while nothing is known, so a late clone is picked up within
	// one poll interval.
	if (repos.length) {
		const checks = await Promise.all(
			repos.map((r) => pi.exec("git", ["-C", r, "rev-parse", "--is-inside-work-tree"])),
		);
		if (checks.some((c) => c.code !== 0)) repos = [];
	}
	if (repos.length === 0) repos = await resolveRepos(pi);
	if (repos.length === 0) {
		// No repo anywhere in /workspace: clear any stale status
		ctx.ui.setStatus(ID, undefined);
		return;
	}

	if (repos.length === 1) await refreshSingle(pi, ctx, repos[0]);
	else await refreshMulti(pi, ctx, repos);
}

// One repo: the full, rich footer (ahead/behind + line stats).
async function refreshSingle(pi: ExtensionAPI, ctx: ExtensionContext, repoRoot: string): Promise<void> {
	const g = (...args: string[]) => pi.exec("git", ["-C", repoRoot, ...args]);

	// -b: include branch + upstream divergence; --porcelain v1: stable format
	const { code, stdout, stderr } = await g("status", "--porcelain=v1", "-b");

	if (code !== 0) {
		// Repo broke underneath us (deleted .git etc.): full rediscovery
		repos = [];
		ctx.ui.setStatus(ID, undefined);
		return;
	}

	const lines = stdout.split("\n").filter((l) => l.length > 0);
	const head = lines[0] ?? ""; // "## main...origin/main [ahead 1, behind 2]"
	const dirty = lines.length - 1;

	// Line counts (+added/−deleted) for dirty worktree and ahead range.
	// Skipped when the change surface is too large (diff cost grows with it).
	let addDel = "";      // e.g. "+156/−89" for the worktree
	let aheadAddDel = ""; // e.g. "+41/−12" for the ahead commit range
	// Guardrails are LINE-based (display: >500L) whenever the diff is
	// computable; the file-count cap only decides whether diffing at all is
	// worth it (cost scales with change surface).
	if (dirty > 0 && dirty <= DIFF_FILE_LIMIT) {
		const [wt, ix] = await Promise.all([
			g("diff", "--shortstat"),
			g("diff", "--cached", "--shortstat"),
		]);
		// worktree + index: sum both shortstats when they differ
		const a = shortstatFull(wt.stdout), b = shortstatFull(ix.stdout);
		addDel = a.addDel && b.addDel && a.addDel !== b.addDel ? sum(a.addDel, b.addDel) : (a.addDel || b.addDel);
		if (overLines(addDel, LINE_LIMIT)) addDel = `>${LINE_LIMIT}L`; // align guard with lines
	}
	// ahead/behind from "[ahead 1, behind 2]" — parsed BEFORE the ahead-diff
	// block below, which reads `ahead` (const: TDZ crash if declared later)
	// NOTE: no `.*` in the behind-only alternative — a leading `.*` matches at
	// position 0 and steals the match from the `\[ahead` alternative.
	const ab = /\[ahead (\d+)(?:, behind (\d+))?|behind (\d+)\]/.exec(head);
	const ahead = ab?.[1] ?? ""; // behind-only match: no ahead commits → hide ↑
	const behind = ab?.[2] ?? ab?.[3] ?? "";

	let aheadFiles = "";
	if (ahead && Number(ahead) > 0 && Number(ahead) <= DIFF_FILE_LIMIT) {
		const ab2 = await g("diff", "--shortstat", "@{u}..HEAD");
		const s = shortstatFull(ab2.stdout);
		aheadAddDel = s.addDel;
		aheadFiles = s.files;
		if (overLines(aheadAddDel, LINE_LIMIT)) aheadAddDel = `>${LINE_LIMIT}L`;
	}

	// branch: "## main..." | "## No commits yet on main" | "## HEAD (no branch)"
	let branch = head.replace(/^## /, "");
	branch = branch.split("...")[0].replace("No commits yet on ", "").trim();

	const theme = ctx.ui.theme;
	// Repo-name prefix: always identifies which repo the line describes —
	// unambiguous when the workspace holds several clones.
	const repoName = repoRoot.split("/").filter(Boolean).pop() ?? "";
	const parts: string[] = [];
	parts.push(theme.fg("accent", `${repoName}: ⎇ ${branch || "detached"}`));
	if (ahead) parts.push(theme.fg("success", aheadAddDel ? `↑ c:${ahead} f:${aheadFiles} l:${aheadAddDel}` : `↑ c:${ahead}`));
	if (behind) parts.push(theme.fg("warning", `↓ c:${behind}`));
	// Guard display: exact file count is always known (from porcelain); lines
	// beyond the limit are shown as l:>500 — aligned with the line metric.
	if (dirty > DIFF_FILE_LIMIT) parts.push(theme.fg("warning", `● f:${dirty} l:>${DIFF_FILE_LIMIT}`));
	else if (dirty > 0) parts.push(theme.fg("warning", addDel ? `● f:${dirty} l:${addDel}` : `● f:${dirty}`));
	else parts.push(theme.fg("success", "✓clean"));

	ctx.ui.setStatus(ID, parts.join(" "));
}

// Several repos: one compact segment per repo — repo name, branch,
// ahead/behind counts and dirty file count. Line stats are skipped in this
// mode: N repos × 3 diffs per tick would scale the refresh cost with the
// workspace's repo count, and the compact line must stay readable.
async function refreshMulti(pi: ExtensionAPI, ctx: ExtensionContext, list: string[]): Promise<void> {
	const theme = ctx.ui.theme;
	const shown = list.slice(0, MAX_REPOS);
	const segs: string[] = [];
	let stale = false;
	for (const repoRoot of shown) {
		const s = await pi.exec("git", ["-C", repoRoot, "status", "--porcelain=v1", "-b"]);
		if (s.code !== 0) {
			stale = true; // vanished mid-tick: full rediscovery next refresh
			continue;
		}
		const lines = s.stdout.split("\n").filter((l) => l.length > 0);
		const head = lines[0] ?? "";
		const dirty = lines.length - 1;
		// branch: "## main..." | "## No commits yet on main" | "## HEAD (no branch)"
		const branch = head.replace(/^## /, "").split("...")[0].replace("No commits yet on ", "").trim();
		const ab = /\[ahead (\d+)(?:, behind (\d+))?|behind (\d+)\]/.exec(head);
		const ahead = ab?.[1] ?? "";
		const behind = ab?.[2] ?? ab?.[3] ?? "";
		const name = repoRoot.split("/").filter(Boolean).pop() ?? repoRoot;
		let seg = `${name}: ⎇ ${branch || "detached"}`;
		if (ahead) seg += ` ↑${ahead}`;
		if (behind) seg += ` ↓${behind}`;
		if (dirty > DIFF_FILE_LIMIT) seg += ` ●f:${dirty}`;
		else if (dirty > 0) seg += ` ●${dirty}`;
		else seg += ` ✓`;
		// Segment color: warning when there is something to act on, success
		// when the repo is clean and in sync.
		segs.push(theme.fg(dirty > 0 || behind ? "warning" : "success", seg));
	}
	if (segs.length === 0) {
		// Every known repo went stale: rediscover from scratch next refresh
		repos = [];
		ctx.ui.setStatus(ID, undefined);
		return;
	}
	const more = list.length - shown.length;
	const extra = more > 0 ? ` +${more} more` : "";
	ctx.ui.setStatus(ID, segs.join(" │ ") + extra);
}

// " 3 files changed, 156 insertions(+), 89 deletions(-)" -> {files:"3", addDel:"+156/−89"}
function shortstatFull(out: string): { files: string; addDel: string } {
	const f = /(\d+) files? changed/.exec(out);
	const a = /(\d+) insertions?/.exec(out);
	const d = /(\d+) deletions?/.exec(out);
	if (!a && !d) return { files: "", addDel: "" };
	return { files: f?.[1] ?? "", addDel: `+${a?.[1] ?? 0}/−${d?.[1] ?? 0}` };
}

// "+156/−89" -> true when added+deleted exceed the guard limit
function overLines(addDel: string, limit: number): boolean {
	const m = /\+(\d+)\/−(\d+)/.exec(addDel);
	if (!m) return false;
	return Number(m[1]) + Number(m[2]) > limit;
}

function sum(x: string, y: string): string {
	const pa = /\+(\d+)\/−(\d+)/.exec(x), pb = /\+(\d+)\/−(\d+)/.exec(y);
	if (!pa || !pb) return x || y;
	return `+${Number(pa[1]) + Number(pb[1])}/−${Number(pa[2]) + Number(pb[2])}`;
}

export default function (pi: ExtensionAPI) {
	let last = 0;
	let pending = false;
	let streaming = false; // skip periodic ticks while a turn is running
	let pollTimer: NodeJS.Timeout | undefined;

	const throttled = async (pi: ExtensionAPI, ctx: ExtensionContext) => {
		const now = Date.now();
		if (now - last < MIN_INTERVAL_MS) {
			// Coalesce bursts: schedule one trailing refresh
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				void refresh(pi, ctx);
			}, MIN_INTERVAL_MS - (now - last));
			return;
		}
		last = now;
		await refresh(pi, ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		void refresh(pi, ctx);
		// Periodic re-refresh: catches changes by EXTERNAL actors (the user in
		// another terminal, sibling agents, the watchdog, a git pull elsewhere)
		// that no tool event will announce. Zero tokens — filesystem work only.
		const pollMs = Number(process.env.PI_GIT_POLL_MS) || 3000;
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(() => {
			if (streaming) return; // tool-triggered refreshes cover this period
			void throttled(pi, ctx);
		}, pollMs);
	});
	pi.on("session_shutdown", async () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	});
	pi.on("tool_result", async (_event, ctx) => void throttled(pi, ctx));
	pi.on("agent_end", async (_event, ctx) => void throttled(pi, ctx));
	pi.on("agent_start", async () => {
		streaming = true;
	});
	pi.on("agent_end", async () => {
		streaming = false;
	});
}
