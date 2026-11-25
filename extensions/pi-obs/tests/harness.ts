/**
 * pi-obs — mock ExtensionAPI / ExtensionContext harness (DEV_PLAN
 * Step 6). pi-obs's own code (not a test-only shortcut): the mock
 * surface pi-obs actually uses, so index.ts's unit tests drive real
 * subscriptions, handlers, commands, and the print-mode emit path to
 * the coverage gate without the pi package installed.
 *
 *   - mockPi(): `on()` records subscriptions (D-category ACs assert
 *     the absent ones); `emit()` runs the event's handlers in order
 *     against ONE shared context (pi semantics) and records the last
 *     non-undefined return (category-C inertness); `registerCommand`
 *     records commands; `appendEntry` exists as a RECORDING SPY so
 *     tests can prove it is never called (R1 observation-only AC).
 *   - mockContext(): fake `sessionManager` (branch over fixture
 *     entries, session dir/file/id), fake `ui` whose setStatus/notify
 *     calls land in the context's `uiLog`, mode/hasUI switches for
 *     the print-mode emit path.
 *
 * Event payload shapes are intentionally loose (`unknown`): index.ts
 * reads them defensively, exactly as it must read real pi payloads.
 */

/** The subset of pi's ExtensionAPI pi-obs touches. */
export interface MockPi {
	/** Hook name → registered handlers, in subscription order. */
	readonly handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	/** Command name → registration. */
	readonly commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>;
	/** R1 spy: every appendEntry call is recorded (expected: none, ever). */
	readonly appendEntryCalls: unknown[][];
	/** R1 spy surface: pi's appendEntry, recording instead of writing. */
	appendEntry(...entry: unknown[]): void;
	/** The context handed to the handlers of the most recent emit(). */
	readonly lastContext: unknown;
	/** Default context options for subsequent emit() calls. */
	contextOptions: MockContextOptions;
	/** Subscribe (what pi's `on` does for us). */
	on(hook: string, handler: (event: unknown, ctx: unknown) => unknown): void;
	/** Register a command. */
	registerCommand(name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }): void;
	/** Fire one event: runs its handlers in order against one shared context; returns the last non-undefined result. */
	emit(hook: string, event?: unknown, ctxOverride?: unknown): Promise<unknown>;
	/** Registered hook names (subscription order preserved). */
	subscribed(): string[];
	/** Run a registered command by name (as pi would). */
	runCommand(name: string, args?: string): Promise<void>;
}

/** A pi session entry shape (fixtures for the fake sessionManager). */
export interface FakeEntry {
	type: string;
	[key: string]: unknown;
}

/** Recorded UI interactions, attached to every mock context. */
export interface UiLog {
	status: Array<{ key: string; value: string }>;
	notify: Array<{ text: string; level: string }>;
}

export interface MockContextOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	cwd?: string;
	branch?: FakeEntry[];
	sessionDir?: string;
	sessionFile?: string | null;
	sessionId?: string;
	model?: { provider: string; id: string };
}

/** A mock ExtensionContext, with its UI log attached for assertions. */
export interface MockContext {
	mode: string;
	hasUI: boolean;
	cwd: string;
	uiLog: UiLog;
	sessionManager: {
		getBranch(): FakeEntry[];
		getSessionDir(): string;
		getSessionFile(): string | null;
		getSessionId(): string | null;
	};
	ui: {
		setStatus(key: string, value: string): void;
		notify(text: string, level: string): void;
	};
	isIdle(): boolean;
	signal: AbortSignal;
	model: { provider: string; id: string } | undefined;
}

/** Build a mock ExtensionContext (fresh per emit — like pi's per-event ctx). */
export function mockContext(opts: MockContextOptions = {}): MockContext {
	const uiLog: UiLog = { status: [], notify: [] };
	return {
		mode: opts.mode ?? "print",
		hasUI: opts.hasUI ?? false,
		cwd: opts.cwd ?? "/work/demo",
		uiLog,
		sessionManager: {
			getBranch: () => opts.branch ?? [],
			getSessionDir: () => opts.sessionDir ?? "/work/demo/.pi/sessions",
			getSessionFile: () => opts.sessionFile ?? null,
			getSessionId: () => opts.sessionId ?? null,
		},
		ui: {
			setStatus(key: string, value: string) {
				uiLog.status.push({ key, value });
			},
			notify(text: string, level: string) {
				uiLog.notify.push({ text, level });
			},
		},
		isIdle: () => true,
		signal: new AbortController().signal,
		model: opts.model,
	};
}

/** Build a mock ExtensionAPI. */
export function mockPi(contextOptions: MockContextOptions = {}): MockPi {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> | void }>();
	const appendEntryCalls: unknown[][] = [];
	const mock: MockPi = {
		handlers,
		commands,
		appendEntryCalls,
		get lastContext() {
			return lastContext;
		},
		contextOptions,
		on(hook, handler) {
			const list = handlers.get(hook) ?? [];
			list.push(handler);
			handlers.set(hook, list);
		},
		appendEntry(...entry: unknown[]) {
			appendEntryCalls.push(entry);
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
		async emit(hook, event = {}, ctxOverride?: unknown) {
			const ctx = (ctxOverride ?? mockContext(mock.contextOptions)) as MockContext; // the LIVE property — tests may reassign it
			lastContext = ctx;
			let result: unknown;
			for (const handler of handlers.get(hook) ?? []) {
				const value = await handler(event, ctx);
				if (value !== undefined) result = value;
			}
			return result;
		},
		subscribed() {
			return [...handlers.keys()];
		},
		async runCommand(name: string, args = "") {
			const def = commands.get(name);
			if (def === undefined) throw new Error(`no command "${name}" registered`);
			const ctx = mockContext(mock.contextOptions); // the LIVE property
			lastContext = ctx;
			await def.handler(args, ctx);
		},
	};
	let lastContext: unknown;
	return mock;
}
