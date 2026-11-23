/**
 * git-status extension — reflect the workspace's git state live in the Pi UI.
 *
 * Shows a footer status line: branch, ahead/behind vs upstream, and the
 * number of uncommitted changes. Refreshes after every tool call (bash /
 * edit / write all mutate git state), on agent turns ending, and at session
 * start. Hidden entirely when the workspace is not a git repo.
 *
 * Linux/macOS/Windows(Git Bash) compatible: plain `git` plumbing only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ID = "git-status";
const MIN_INTERVAL_MS = 500; // throttle: git runs at most ~2x/second

async function refresh(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return; // print/JSON mode: no UI to update

	// -b: include branch + upstream divergence; --porcelain v1: stable format
	const { code, stdout, stderr } = await pi.exec("git", ["status", "--porcelain=v1", "-b"]);

	if (code !== 0) {
		// Not a repo (or git broken): clear any stale status
		ctx.ui.setStatus(ID, undefined);
		return;
	}

	const lines = stdout.split("\n").filter((l) => l.length > 0);
	const head = lines[0] ?? ""; // "## main...origin/main [ahead 1, behind 2]"
	const dirty = lines.length - 1;

	// Line counts (+added/−deleted) for dirty worktree and ahead range.
	// Skipped when the change surface is too large (diff cost grows with it).
	const DIFF_FILE_LIMIT = 500;
	let addDel = "";      // e.g. "+156/−89" for the worktree
	let aheadAddDel = ""; // e.g. "+41/−12" for the ahead commit range
	// Guardrails are LINE-based (display: >500L) whenever the diff is
	// computable; the file-count cap only decides whether diffing at all is
	// worth it (cost scales with change surface).
	const LINE_LIMIT = 500;
	if (dirty > 0 && dirty <= DIFF_FILE_LIMIT) {
		const [wt, ix] = await Promise.all([
			pi.exec("git", ["diff", "--shortstat"]),
			pi.exec("git", ["diff", "--cached", "--shortstat"]),
		]);
		// worktree + index: sum both shortstats when they differ
		const a = shortstatFull(wt.stdout), b = shortstatFull(ix.stdout);
		addDel = a.addDel && b.addDel && a.addDel !== b.addDel ? sum(a.addDel, b.addDel) : (a.addDel || b.addDel);
		if (overLines(addDel, LINE_LIMIT)) addDel = `>${LINE_LIMIT}L`; // align guard with lines
	}
	let aheadFiles = "";
	if (ahead && Number(ahead) > 0 && Number(ahead) <= DIFF_FILE_LIMIT) {
		const ab2 = await pi.exec("git", ["diff", "--shortstat", "@{u}..HEAD"]);
		const s = shortstatFull(ab2.stdout);
		aheadAddDel = s.addDel;
		aheadFiles = s.files;
		if (overLines(aheadAddDel, LINE_LIMIT)) aheadAddDel = `>${LINE_LIMIT}L`;
	}

	// branch: "## main..." | "## No commits yet on main" | "## HEAD (no branch)"
	let branch = head.replace(/^## /, "");
	branch = branch.split("...")[0].replace("No commits yet on ", "").trim();

	// ahead/behind from "[ahead 1, behind 2]"
	const ab = /\[ahead (\d+)(?:, behind (\d+))?|.*behind (\d+)\]/.exec(head);
	const ahead = ab?.[1] ?? (ab?.[3] ? "0" : "");
	const behind = ab?.[2] ?? ab?.[3] ?? "";

	const theme = ctx.ui.theme;
	const parts: string[] = [];
	parts.push(theme.fg("accent", `⎇ ${branch || "detached"}`));
	if (ahead) parts.push(theme.fg("success", aheadAddDel ? `↑ c:${ahead} f:${aheadFiles} l:${aheadAddDel}` : `↑ c:${ahead}`));
	if (behind) parts.push(theme.fg("warning", `↓ c:${behind}`));
	// Guard display: exact file count is always known (from porcelain); lines
	// beyond the limit are shown as l:>500 — aligned with the line metric.
	if (dirty > DIFF_FILE_LIMIT) parts.push(theme.fg("warning", `● f:${dirty} l:>${DIFF_FILE_LIMIT}`));
	else if (dirty > 0) parts.push(theme.fg("warning", addDel ? `● f:${dirty} l:${addDel}` : `● f:${dirty}`));
	else parts.push(theme.fg("success", "✓clean"));

	ctx.ui.setStatus(ID, parts.join(" "));
}

// " 3 files changed, 156 insertions(+), 89 deletions(-)" -> {files:"3", addDel:"+156/−89"}
function shortstatFull(out: string): { files: string; addDel: string } {
	const f = /(\d+) files? changed/.exec(out);
	const a = /(\d+) insertions?/.exec(out);
	const d = /(\d+) deletions?/.exec(out);
	if (!a && !d) return { files: "", addDel: "" };
	return { files: f?.[1] ?? "", addDel: `+${a?.[2] ?? 0}/−${d?.[2] ?? 0}` };
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

	pi.on("session_start", async (_event, ctx) => void refresh(pi, ctx));
	pi.on("tool_result", async (_event, ctx) => void throttled(pi, ctx));
	pi.on("agent_end", async (_event, ctx) => void throttled(pi, ctx));
}
