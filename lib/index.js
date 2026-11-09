/**
 * @local/model-auto-switch — ordered third-party model rotation with automatic failover.
 *
 * User-facing behavior (from the request):
 *  1. The user picks models from the currently available catalog and defines an
 *     ordered combination (排序组合).
 *  2. When a third-party model in the combo is rate-limited, or its request
 *     timeout count exceeds 2, automatically switch to the NEXT model in the combo.
 *  3. When no third-party model in the combo is available, switch back to the
 *     models that timed out during the first round tour (retest them once).
 *  4. Finally, the DSH platform model is the last-resort fallback (兜底).
 *
 * Mechanism (verified against dsh sources):
 *  - `agent/request-error` waterfall, observed OUTER-most on the ROOT context
 *    (prepend:true, registered before dsh-llm-retry's plain listener), sees every
 *    failed attempt first. We own the decision: we return {kind:'retry'} without
 *    calling next() so the built-in retry never adds its 10s backoff on top of our
 *    switch; the agent loop then `continue`s and re-runs prepareRequest.
 *  - `agent/request` waterfall, observed OUTER-most on each agent context
 *    (agent/created → agent.ctx.on(..., {prepend:true})), rewrites the frozen call
 *    configuration to the currently active model of our state machine, beating the
 *    built-in installModelSelection override (which calls next() first).
 *  - Non-qualifying failures (or exhausted state machine) return next()
 *    transparently, so ordinary dsh-llm-retry behavior is preserved.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** Providers that count as the DSH platform (fallback tier), configurable. */
const DEFAULT_PLATFORM_PROVIDERS = ["deepseek-official", "deepseek-account"];

/**
 * The provider route under which saved combos are published into the model
 * picker. The harness groups the picker strictly by provider, so a combo has to
 * be a provider plus one model id per combo — that is the only way the user can
 * pick "my combo" from the same list where the ordinary models live.
 */
const DEFAULT_ROTATION_PROVIDER = "model-rotation";

/** Max timeout failures per model inside one phase before it is skipped. */
const DEFAULT_TIMEOUT_THRESHOLD = 2;

/**
 * A rate limit whose stated wait fits in this window is treated as "worth one
 * in-place retry" when retryShortRateLimits is on. Ten seconds is the same
 * ceiling dsh-llm-retry's own backoff tops out at, so anything longer would
 * outlive the retry budget anyway.
 */
const DEFAULT_SHORT_RATE_LIMIT_MS = 10000;

/** Hand-backs one route gets before a short rate limit is treated as terminal. */
const DEFAULT_GRACE_ATTEMPTS = 2;

const PLUGIN_ID = "model-auto-switch";

/* ------------------------------------------------------------------ */
/* Config (cordis.patch.yml / settings UI)                             */
/* ------------------------------------------------------------------ */

const routeSpec = z.object({
	provider: z.string().required(),
	model: z.string().required(),
});

export const Config = z.object({
	/** Ordered third-party rotation; empty = plugin idle. */
	rotation: z.array(routeSpec).default([]).volatile(),
	/** Provider id that publishes the saved combos as selectable models. */
	rotationProvider: z.string().default(DEFAULT_ROTATION_PROVIDER).volatile(),
	/** Provider ids treated as the DSH platform fallback tier. */
	platformProviders: z.array(z.string()).default(DEFAULT_PLATFORM_PROVIDERS).volatile(),
	/** Timeouts allowed per model per phase before switching (count EXCEEDED means switch). */
	timeoutThreshold: z.number().default(DEFAULT_TIMEOUT_THRESHOLD).volatile(),
	/** Master switch. */
	enabled: z.boolean().default(true).volatile(),
	/**
	 * Start the tour without the user picking a combo from the model picker.
	 * Default false: the plugin only acts once a combo is selected there (or
	 * "设为生效" is pressed), so switching the plugin on changes nothing by itself.
	 */
	engageOnStart: z.boolean().default(false).volatile(),
	/**
	 * Give a SHORT rate limit a chance to clear in place before the route is
	 * marked dead. Default false: a 429 means "switch now". Turn this on when a
	 * provider's 429 is momentary (a model that is momentarily busy, a pool that
	 * recovers in seconds) and switching away costs more than waiting.
	 */
	retryShortRateLimits: z.boolean().default(false).volatile(),
	/** A rate limit is "short" when its stated wait is at most this many ms. */
	shortRateLimitMs: z.number().default(DEFAULT_SHORT_RATE_LIMIT_MS).volatile(),
	/** How many times one route may be handed back before it is marked dead. */
	graceAttempts: z.number().default(DEFAULT_GRACE_ATTEMPTS).volatile(),
});

/* ------------------------------------------------------------------ */
/* State machine (per agent)                                           */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_CODES = new Set([
	"RATE_LIMIT",
	"RATE_LIMITED",
	"QUOTA",
	"QUOTA_EXCEEDED",
	"ACCOUNT_QUOTA",
	"TOO_MANY_REQUESTS",
	"HTTP_429",
]);
// Message-level fallback for shims that only put the reason in the text (the
// channel pack reports "可用账号均在限流中" without a canonical code).
const RATE_LIMIT_MESSAGE_RE = /rate.?limit|too many requests|\bquota\b|限流|配额|额度/i;
// Retrying these can never succeed: the provider is not wired up in this
// installation (NO_ADAPTER) or its credentials are rejected. Mark the route
// dead and move on instead of burning the retry budget on it.
const UNUSABLE_CODES = new Set(["NO_ADAPTER", "AUTH", "INVALID_CREDENTIAL", "MISSING_CREDENTIAL"]);
const UNUSABLE_MESSAGE_RE = /no adapter registered|missing credential|invalid credential/i;
const TIMEOUT_MESSAGE_RE = /timeout|timed out|etimedout|econnaborted/i;
// The request itself was refused for its size. Retrying the same route can only
// fail again with the same payload, but another combo member may be fronted by a
// gateway with a larger body limit — so this is a reason to move on, not to stop.
const CAPACITY_CODES = new Set(["CONTEXT_WINDOW_EXCEEDED", "REQUEST_TOO_LARGE"]);
const CAPACITY_MESSAGE_RE = /request entity too large|payload too large|request too large|request body (?:exceeds|too large)|body exceeds|exceeds \d+(?:\.\d+)? ?(?:mb|mib)|context[_ ]length[_ ]exceeded|maximum context length|too many tokens|context window|invalid string length/i;
// The route could not be reached at all (DNS/TCP/TLS/fetch wrapper). The
// channel packs surface this as a bare "unreachable" text with code UNKNOWN,
// which used to read as "not our decision" and let the turn die.
const TRANSPORT_CODES = new Set(["TRANSPORT"]);
const TRANSPORT_MESSAGE_RE = /unreachable|econnrefused|econnreset|econnaborted|enotfound|enotreach|eai_again|epipe|socket hang up|fetch failed|network error|getaddrinfo/i;
/** In-place retries granted before an unreachable route is dropped. */
const DEFAULT_TRANSPORT_GRACE = 1;

/** Whether a failure means "this route will never accept this request as-is". */
function isCapacityFailure(failure) {
	if (!failure) return false;
	if (CAPACITY_CODES.has(failure.code)) return true;
	if (failure.status === 413) return true;
	// Some shims only carry the status inside the code ("HTTP_413") or the text.
	if (typeof failure.code === "string" && /(^|[^0-9])413([^0-9]|$)/.test(failure.code)) return true;
	return typeof failure.message === "string" && (CAPACITY_MESSAGE_RE.test(failure.message) || /\b413\b/.test(failure.message));
}

function classifyFailure(failure) {
	if (!failure) return "other";
	if (failure.code === "TIMEOUT") return "timeout";
	if (isCapacityFailure(failure)) return "capacity";
	if (UNUSABLE_CODES.has(failure.code)) return "unusable";
	if (
		RATE_LIMIT_CODES.has(failure.code) ||
		failure.status === 429 ||
		failure.providerRetryAfterMs !== undefined ||
		(typeof failure.code === "string" && /429/.test(failure.code))
	) {
		return "rate_limit";
	}
	if (typeof failure.message === "string") {
		if (UNUSABLE_MESSAGE_RE.test(failure.message)) return "unusable";
		if (TIMEOUT_MESSAGE_RE.test(failure.message)) return "timeout";
		if (RATE_LIMIT_MESSAGE_RE.test(failure.message)) return "rate_limit";
	}
	if (TRANSPORT_CODES.has(failure.code)) return "transport";
	if (typeof failure.message === "string" && TRANSPORT_MESSAGE_RE.test(failure.message)) return "transport";
	return "other";
}

function isPlatformProvider(provider, platformProviders) {
	return platformProviders.includes(provider);
}

function routeKey(route) {
	return `${route.provider}/${route.model}`;
}

/**
 * Per-agent failover state. Phases:
 *  idle → round1 (combo order) → retest (round1 timeouts, fresh budget) → fallback (platform)
 * "dead" models (rate-limited) never come back within the same failover run.
 */
function createState(rotation) {
	return {
		rotation: rotation.map((r) => ({ provider: String(r.provider), model: String(r.model) })),
		phase: "idle", // idle | round1 | retest | fallback
		round1Index: 0,
		retestIndex: 0,
		retestQueue: [], // routes that timed out in round1, in combo order
		timeouts: new Map(), // routeKey -> count (per phase)
		dead: new Set(), // routeKeys hit by rate-limit/quota
		pruned: new Set(), // routeKeys excluded only because their provider is absent
		liveProviders: null, // Set of provider ids that have an adapter right now
		liveProbedAt: 0, // Date.now() of the last provider probe
		retested: new Set(), // routeKeys already consumed in the retest phase
		grace: new Map(), // routeKey -> in-place retries already granted for a short rate limit
		transport: new Map(), // routeKey -> in-place retries already granted for a transport error
		engaged: false, // true once the user picked a combo for this agent
		active: null, // {provider, model} currently forced
		comboId: "", // which saved combo this state was armed from
		timeoutThreshold: null, // per-combo limit; null = follow the global setting
		fallbackTarget: null, // concrete {provider, model} resolved from the platform catalog
		fallbackChoice: null, // user-chosen DSH fallback model {provider, model}, or null = auto
		fallbackDiscoveryFailed: false, // true when no concrete platform model could be discovered
		log: [], // recent human-readable decisions, newest last
	};
}

function note(state, text) {
	state.log.push(`[${new Date().toISOString()}] ${text}`);
	if (state.log.length > 30) state.log.shift();
}

function timeoutBudget(state, route) {
	const key = routeKey(route);
	const count = (state.timeouts.get(key) ?? 0) + 1;
	state.timeouts.set(key, count);
	return count;
}

/**
 * Whether a rate limit is momentary enough to deserve an in-place retry.
 *
 * Providers that rotate accounts behind one route (WorkBuddy & co.) already
 * treat a momentary 429 as "try the next account"; switching the whole model
 * away on the first 429 throws that away. Quota codes are excluded on purpose:
 * their reset is hours away, so retrying in place only burns the retry budget.
 */
function shortRateLimit(failure, shortRateLimitMs) {
	if (failure?.code === "QUOTA" || failure?.code === "ACCOUNT_QUOTA") return false;
	const wait = failure?.providerRetryAfterMs;
	if (Number.isFinite(wait)) return wait <= shortRateLimitMs;
	// No stated wait: a plain 429 is momentary far more often than not, and the
	// per-route grace budget below stops a persistent one from looping.
	return failure?.status === 429 || failure?.code === "RATE_LIMIT";
}

/**
 * Count one hand-back for this route. Returns true while the route still has
 * grace left, i.e. the caller should retry it instead of marking it dead.
 */
function graceBudget(state, key, graceAttempts) {
	const used = (state.grace.get(key) ?? 0) + 1;
	state.grace.set(key, used);
	return used <= graceAttempts;
}

/** Advance to the next usable third-party route; returns the route or null. */
function nextThirdParty(state, phase) {
	const list = state.rotation;
	let index = phase === "round1" ? state.round1Index : state.retestIndex;
	while (index < list.length) {
		const route = list[index];
		const key = routeKey(route);
		if (state.dead.has(key)) {
			index += 1;
			continue;
		}
		if (phase === "retest" && state.retested.has(key)) {
			index += 1;
			continue;
		}
		if (phase === "round1") state.round1Index = index;
		else state.retestIndex = index;
		return route;
	}
	return null;
}

/**
 * Handle one qualifying failure. Mutates state; returns the new active route
 * (or null when the state machine is exhausted and the turn should be
 * handed back to normal handling).
 */
function handleFailure(state, failedProvider, failure, platformProviders, timeoutThreshold, options = {}) {
	const kind = classifyFailure(failure);
	const shortRetry = options.retryShortRateLimits === true;
	const shortLimitMs = Number.isFinite(options.shortRateLimitMs) ? options.shortRateLimitMs : DEFAULT_SHORT_RATE_LIMIT_MS;
	const graceAttempts = Number.isFinite(options.graceAttempts) ? options.graceAttempts : DEFAULT_GRACE_ATTEMPTS;

	// Failure of a platform (fallback) model: never fight the built-ins; give up.
	if (state.phase === "fallback") {
		note(state, `fallback route ${state.active ? routeKey(state.active) : failedProvider} failed (${failure?.code ?? "unknown"}); handing back to normal retry handling`);
		return null;
	}

	const failedIsThirdParty = state.phase !== "idle" && state.active !== null
		? !isPlatformProvider(state.active.provider, platformProviders)
		: !isPlatformProvider(failedProvider, platformProviders);

	if (!failedIsThirdParty) {
		// A platform model failed outside our control (e.g. user had DSH selected
		// and combo enabled): only take over if the combo has something alive.
		note(state, `non-third-party route ${failedProvider} failed; checking combo for takeover`);
		const next = nextThirdParty(state, state.phase === "retest" ? "retest" : "round1");
		if (next === null) return enterFallback(state, platformProviders);
		state.active = next;
		state.phase = state.phase === "retest" ? "retest" : "round1";
		note(state, `taking over: switch to ${routeKey(next)}`);
		return next;
	}

	if (kind === "rate_limit") {
		const target = state.active ?? { provider: failedProvider, model: "" };
		const key = routeKey(target);
		// A momentary limit (the provider's own account rotation may clear it,
		// or it may simply be busy) is worth a bounded in-place retry before the
		// whole model is switched away. QUOTA never qualifies: its reset is far
		// outside any retry budget.
		if (shortRetry && shortRateLimit(failure, shortLimitMs) && graceBudget(state, key, graceAttempts)) {
			note(state, `${key} short rate limit (${failure?.providerRetryAfterMs ?? "no wait"} ms) → retry in place, ${state.grace.get(key)}/${graceAttempts}`);
			return target;
		}
		state.dead.add(key);
		note(state, `${key} rate-limited → marked dead`);
	} else if (kind === "unusable") {
		// The provider is not registered here (or its credentials are rejected),
		// so retrying it is pointless — a combo saved on another machine may
		// name providers this installation does not have.
		const target = state.active ?? { provider: failedProvider, model: "" };
		state.dead.add(routeKey(target));
		note(state, `${routeKey(target)} unusable (${failure?.code ?? failure?.message ?? "unknown"}) → marked dead`);
	} else if (kind === "capacity") {
		// The gateway in front of this route refused the request for its size
		// (413 / context window). The same route would refuse it again, so skip
		// it — but do not treat it as a timeout: it says nothing about the
		// model's health, and the next member may have a larger body limit.
		const target = state.active ?? { provider: failedProvider, model: "" };
		state.dead.add(routeKey(target));
		note(state, `${routeKey(target)} refused the request size (${failure?.status ?? failure?.code ?? "unknown"}) → chain has no budget for it, skipping`);
	} else if (kind === "transport") {
		// The route could not be reached (DNS/TCP/TLS/fetch). Usually a blip, so
		// one in-place retry is cheap and keeps the tour where it is; a second
		// failure means the endpoint is really down, so drop it and move on
		// instead of letting the built-in retries burn five backoffs on it.
		const target = state.active ?? { provider: failedProvider, model: "" };
		const key = routeKey(target);
		const used = (state.transport.get(key) ?? 0) + 1;
		state.transport.set(key, used);
		if (used <= DEFAULT_TRANSPORT_GRACE) {
			note(state, `${key} unreachable (${failure?.code ?? "unknown"}) → retry in place, ${used}/${DEFAULT_TRANSPORT_GRACE}`);
			return target;
		}
		state.dead.add(key);
		note(state, `${key} still unreachable (${failure?.code ?? "unknown"}) → marked dead`);
	} else if (kind === "timeout") {
		const target = state.active ?? { provider: failedProvider, model: "" };
		const count = timeoutBudget(state, target);
		note(state, `${routeKey(target)} timeout ${count}/${timeoutThreshold + 1}`);
		if (count <= timeoutThreshold) {
			// Budget not exhausted: keep the same model, let the loop retry it.
			return target;
		}
		if (state.phase === "round1") {
			const already = state.retestQueue.some((r) => routeKey(r) === routeKey(target));
			if (!already) state.retestQueue.push({ provider: target.provider, model: target.model });
		} else if (state.phase === "retest") {
			state.retested.add(routeKey(target));
		}
	} else {
		// Not our decision (SERVER/TRANSPORT/EMPTY_RESPONSE/...): transparent.
		return undefined;
	}

	// Advance past the failed route to the next third-party route.
	if (state.phase === "round1") {
		state.round1Index += 1;
	} else if (state.phase === "retest") {
		state.retestIndex += 1;
	}
	const phase = state.phase === "retest" ? "retest" : "round1";
	let next = nextThirdParty(state, phase);
	if (next !== null) {
		state.active = next;
		note(state, `switch to next combo model ${routeKey(next)} (${phase})`);
		return next;
	}

	// Combo exhausted for this phase.
	if (phase === "round1" && state.retestQueue.length > 0) {
		state.phase = "retest";
		state.retestIndex = 0;
		state.timeouts.clear(); // fresh timeout budget for the retest round
		next = nextThirdParty(state, "retest");
		if (next !== null) {
			state.active = next;
			note(state, `round1 done; retest phase begins with ${routeKey(next)}`);
			return next;
		}
	}
	return enterFallback(state, platformProviders);
}

function enterFallback(state, platformProviders) {
	const live = state.liveProviders ?? null;
	const usable = Array.isArray(platformProviders)
		? platformProviders.filter((p) => !live || live.has(p))
		: [];
	state.phase = "fallback";
	// A model the user picked on the settings page wins over auto-discovery.
	const choice = state.fallbackChoice;
	const choiceUsable =
		choice &&
		typeof choice.provider === "string" &&
		typeof choice.model === "string" &&
		choice.model !== "" &&
		platformProviders.includes(choice.provider) &&
		(!live || live.has(choice.provider));
	state.active = choiceUsable
		? { provider: choice.provider, model: choice.model }
		: { provider: usable[0] ?? platformProviders[0] ?? "deepseek-official", model: "" };
	state.fallbackTarget = choiceUsable ? { ...state.active } : null;
	state.fallbackDiscoveryFailed = usable.length === 0;
	if (usable.length === 0 && !choiceUsable) {
		note(state, `no third-party model available and no live DSH platform provider → handing back to normal handling`);
		return null;
	}
	note(
		state,
		choiceUsable
			? `no third-party model available → DSH platform fallback ${choice.provider}/${choice.model} (configured)`
			: `no third-party model available → DSH platform fallback`,
	);
	return { ...state.active, fallback: true };
}

/**
 * What the tour is currently routing to. The adapter calls this for every
 * request rather than reading `state.active` directly, so the fallback tier
 * and the tour can never disagree about the target.
 */
function decideActive(state) {
	if (state.phase === "idle") return null;
	if (state.phase === "fallback") {
		// Prefer a concrete platform model discovered from the live catalog;
		// otherwise the empty-model active pins only the provider.
		return state.fallbackTarget ?? state.active;
	}
	return state.active;
}

/* ------------------------------------------------------------------ */
/* Persistence (best-effort runtime rotation, seeded from Config)       */
/* ------------------------------------------------------------------ */

function stateFilePath() {
	const base = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(base, "model-auto-switch-state.json");
}

/**
 * State file schema:
 *   v2 { version: 2, combos: [{id, name, rotation, enabled, timeoutThreshold}], activeId, enabled, timeoutThreshold }
 *   v1 { name, rotation, enabled, timeoutThreshold }   (a single combo)
 * A v1 file is migrated in memory to one combo, so an upgrade never loses the
 * combo the user had already saved.
 */
const STATE_VERSION = 2;
const LEGACY_COMBO_ID = "default";

function sanitizeRoutes(list) {
	if (!Array.isArray(list)) return [];
	return list
		.filter((r) => r && typeof r.provider === "string" && typeof r.model === "string")
		.map((r) => ({ provider: r.provider, model: r.model }))
		.filter((r) => r.provider !== "" && r.model !== "");
}

function sanitizeCombo(raw, fallbackId) {
	const id = typeof raw?.id === "string" && raw.id !== "" ? raw.id : fallbackId;
	return {
		id,
		name: typeof raw?.name === "string" ? raw.name.slice(0, 120) : "",
		rotation: sanitizeRoutes(raw?.rotation),
		enabled: raw?.enabled !== false,
		timeoutThreshold: Number.isFinite(raw?.timeoutThreshold) ? Math.max(0, Math.trunc(raw.timeoutThreshold)) : null,
	};
}

/** A user-chosen DSH fallback model: {provider, model} or null (auto). */
function sanitizeFallback(raw) {
	if (!raw || typeof raw !== "object") return null;
	const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
	const model = typeof raw.model === "string" ? raw.model.trim() : "";
	return provider !== "" && model !== "" ? { provider, model } : null;
}

/** Persisted runtime settings, already normalized to the v2 shape. */
function loadPersisted() {
	try {
		const parsed = JSON.parse(readFileSync(stateFilePath(), "utf8"));
		const enabled = typeof parsed?.enabled === "boolean" ? parsed.enabled : null;
		const timeoutThreshold = Number.isFinite(parsed?.timeoutThreshold) ? parsed.timeoutThreshold : null;
		const retryShortRateLimits = typeof parsed?.retryShortRateLimits === "boolean" ? parsed.retryShortRateLimits : null;
		const shortRateLimitMs = Number.isFinite(parsed?.shortRateLimitMs) ? parsed.shortRateLimitMs : null;
		const graceAttempts = Number.isFinite(parsed?.graceAttempts) ? parsed.graceAttempts : null;
		const fallback = sanitizeFallback(parsed?.fallback);
		if (Array.isArray(parsed?.combos)) {
			const combos = parsed.combos
				.map((raw, index) => sanitizeCombo(raw, `combo-${index + 1}`))
				.filter((combo) => combo.id !== "");
			// Drop duplicate ids rather than letting two cards collide.
			const seen = new Set();
			const unique = combos.filter((combo) => (seen.has(combo.id) ? false : (seen.add(combo.id), true)));
			const activeId = typeof parsed?.activeId === "string" && unique.some((c) => c.id === parsed.activeId) ? parsed.activeId : "";
			return { combos: unique, activeId, enabled, timeoutThreshold, fallback, retryShortRateLimits, shortRateLimitMs, graceAttempts };
		}
		// v1: one implicit combo.
		if (Array.isArray(parsed?.rotation)) {
			const migrated = sanitizeCombo(
				{
					id: LEGACY_COMBO_ID,
					name: parsed.name,
					rotation: parsed.rotation,
					enabled: true,
					timeoutThreshold: parsed.timeoutThreshold,
				},
				LEGACY_COMBO_ID,
			);
			return { combos: [migrated], activeId: LEGACY_COMBO_ID, enabled, timeoutThreshold, fallback, retryShortRateLimits, shortRateLimitMs, graceAttempts };
		}
	} catch {
		/* first run or unreadable — ignore */
	}
	return {
		combos: [],
		activeId: "",
		enabled: null,
		timeoutThreshold: null,
		fallback: null,
		retryShortRateLimits: null,
		shortRateLimitMs: null,
		graceAttempts: null,
	};
}

function persist(payload) {
	try {
		const dir = stateFilePath();
		mkdirSync(join(dir, ".."), { recursive: true });
		writeFileSync(stateFilePath(), JSON.stringify({ version: STATE_VERSION, ...payload }, null, 2));
	} catch {
		/* best-effort only */
	}
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

export const inject = ["llm", "agents", "tools"];

export function apply(ctx, config) {
	/** agentKey -> state */
	const states = new Map();
	const agentKey = (agent) => agent?.session?.id ?? agent?.id ?? String(agent);
	/** Weak ref of config values (volatile getters). */
	const cfg = {
		rotation: () => {
			const v = config.rotation;
			return typeof v?.get === "function" ? v.get() : v;
		},
		platformProviders: () => {
			const v = config.platformProviders;
			const arr = typeof v?.get === "function" ? v.get() : v;
			return Array.isArray(arr) && arr.length > 0 ? arr : DEFAULT_PLATFORM_PROVIDERS;
		},
		timeoutThreshold: () => {
			const v = config.timeoutThreshold;
			const n = typeof v?.get === "function" ? v.get() : v;
			return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_THRESHOLD;
		},
		enabled: () => {
			const v = config.enabled;
			const e = typeof v?.get === "function" ? v.get() : v;
			return e !== false;
		},
		rotationProvider: () => {
			const v = config.rotationProvider;
			return typeof v?.get === "function" ? v.get() : v;
		},
		engageOnStart: () => {
			const v = config.engageOnStart;
			const e = typeof v?.get === "function" ? v.get() : v;
			return e === true;
		},
		retryShortRateLimits: () => {
			const v = config.retryShortRateLimits;
			const e = typeof v?.get === "function" ? v.get() : v;
			return e === true;
		},
		shortRateLimitMs: () => {
			const v = config.shortRateLimitMs;
			const n = typeof v?.get === "function" ? v.get() : v;
			return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHORT_RATE_LIMIT_MS;
		},
		graceAttempts: () => {
			const v = config.graceAttempts;
			const n = typeof v?.get === "function" ? v.get() : v;
			return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_ATTEMPTS;
		},
	};

	const runtime = loadPersisted();

	/** All saved combos (each shown as its own card in the settings page). */
	let combos = runtime.combos.map((combo) => ({ ...combo }));
	/** Which combo the runtime tour currently follows; "" = none selected. */
	let activeComboId = runtime.activeId;

	function nextComboId() {
		let n = combos.length + 1;
		const taken = new Set(combos.map((combo) => combo.id));
		while (taken.has(`combo-${n}`)) n += 1;
		return `combo-${n}`;
	}

	function comboById(id) {
		return combos.find((combo) => combo.id === id);
	}

	/** The combo the state machine arms from: the active one, else the first. */
	function activeCombo() {
		return comboById(activeComboId) ?? combos[0];
	}

	// Seed: a Config-declared rotation becomes the first combo when nothing was
	// ever saved, so the plugin still honours cordis.patch.yml configuration.
	if (combos.length === 0) {
		const configured = cfg.rotation();
		const seed = Array.isArray(configured) ? sanitizeRoutes(configured) : [];
		if (seed.length > 0) {
			combos = [{ id: LEGACY_COMBO_ID, name: "", rotation: seed, enabled: true, timeoutThreshold: null }];
			activeComboId = LEGACY_COMBO_ID;
		}
	}

	/** Rotation currently in force (empty when no combo has members). */
	const currentRotation = () => {
		const combo = activeCombo();
		return combo ? combo.rotation.map((r) => ({ ...r })) : [];
	};

	/** User-chosen DSH fallback model; null = discover the first platform model. */
	let fallbackChoice = runtime.fallback ?? null;
	/** Runtime overrides written by the settings page; null = follow Config. */
	let runtimeEnabled = runtime.enabled;
	let runtimeThreshold = runtime.timeoutThreshold;
	const enabledNow = () => (runtimeEnabled === null ? cfg.enabled() : runtimeEnabled !== false);
	const thresholdNow = () => (runtimeThreshold === null ? cfg.timeoutThreshold() : runtimeThreshold);
	/** Whether an agent starts engaged without picking a combo in the picker. */
	const engageOnStart = () => cfg.engageOnStart() === true;

	/** Rate-limit grace knobs; the runtime values come from the settings page. */
	let runtimeShortRate = runtime.retryShortRateLimits ?? null;
	let runtimeShortRateMs = runtime.shortRateLimitMs ?? null;
	let runtimeGraceAttempts = runtime.graceAttempts ?? null;
	const shortRateRetryNow = () =>
		runtimeShortRate === null ? cfg.retryShortRateLimits() === true : runtimeShortRate === true;
	const shortRateLimitMsNow = () => {
		const n = runtimeShortRateMs === null ? cfg.shortRateLimitMs() : runtimeShortRateMs;
		return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHORT_RATE_LIMIT_MS;
	};
	const graceAttemptsNow = () => {
		const n = runtimeGraceAttempts === null ? cfg.graceAttempts() : runtimeGraceAttempts;
		return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GRACE_ATTEMPTS;
	};

	/** Persist the whole combo list plus the global switches. */
	const persistAll = () =>
		persist({
			combos: combos.map((combo) => ({ ...combo })),
			activeId: activeComboId,
			fallback: fallbackChoice,
			enabled: enabledNow(),
			timeoutThreshold: thresholdNow(),
			retryShortRateLimits: shortRateRetryNow(),
			shortRateLimitMs: shortRateLimitMsNow(),
			graceAttempts: graceAttemptsNow(),
		});

	/** Effective timeout threshold of one combo (its own value, else global). */
	const comboThreshold = (combo) =>
		combo && Number.isFinite(combo.timeoutThreshold) ? combo.timeoutThreshold : thresholdNow();

	/**
	 * Providers registered right now, or null when the registry cannot be read.
	 * A persisted combo may name providers this installation does not have
	 * (e.g. saved on another machine); forcing those would fail every request
	 * with "no adapter registered for provider ...", so they must be skipped.
	 */
	function liveProviders() {
		try {
			const list = ctx.llm?.listProviders?.();
			return Array.isArray(list) ? new Set(list.map((p) => p.id)) : null;
		} catch {
			return null;
		}
	}

	function pruneUnavailable(state) {
		const live = liveProviders();
		state.liveProviders = live;
		state.liveProbedAt = Date.now();
		const platform = cfg.platformProviders();
		for (const route of state.rotation) {
			const key = routeKey(route);
			// The tour covers third-party models only: a DSH platform route in
			// the combo belongs to the fallback tier, never to round1.
			if (platform.includes(route.provider)) {
				state.pruned.add(key);
				if (!state.dead.has(key)) {
					state.dead.add(key);
					note(state, `${key} skipped: DSH platform provider is the fallback tier, not a combo member`);
				}
				continue;
			}
			if (!live) continue;
			if (!live.has(route.provider)) {
				// Remember that this route was removed ONLY because the provider is
				// missing, so a later probe can bring it back when the adapter loads
				// (e.g. the user configures that provider's credentials).
				state.pruned.add(key);
				if (!state.dead.has(key)) {
					state.dead.add(key);
					note(state, `${key} skipped: no adapter registered for provider "${route.provider}"`);
				}
			} else if (state.pruned.delete(key)) {
				// The provider showed up: un-kill the route unless it died for real.
				state.dead.delete(key);
				state.retested.delete(key);
				note(state, `${key} is available again (adapter registered) → re-armed`);
			}
		}
	}

	/**
	 * Re-probe the provider registry. Throttled because it runs on every
	 * request, except while the machine is idle: that is exactly the state in
	 * which we are waiting for a combo member's adapter to appear, so it must
	 * notice the change immediately.
	 */
	function refreshProviders(state) {
		if (state.phase === "idle" || !state.liveProviders || Date.now() - state.liveProbedAt > 15000) {
			pruneUnavailable(state);
		}
	}

	function stateFor(agent) {
		const key = agentKey(agent);
		let state = states.get(key);
		if (!state) {
			const combo = activeCombo();
			const rotation = currentRotation();
			state = armState(
				rotation,
				`armed with combo ${combo?.id ?? "(none)"}: ${rotation.map(routeKey).join(" → ") || "(empty)"}`,
				combo,
				engageOnStart(),
			);
			states.set(key, state);
		}
		return state;
	}

	/**
	 * Resolve the per-agent state from a stream's own options. The adapter never
	 * sees the agent, but the harness stamps every request with `sessionId`, and
	 * that is exactly the key the states map uses (agent.session.id). A session
	 * that has no state yet still gets the tour when exactly one agent is
	 * engaged — the common single-session case — and nothing otherwise, so two
	 * concurrent combos can never steal each other's routing.
	 */
	function stateForStream(options) {
		const sessionId = typeof options?.sessionId === "string" ? options.sessionId : null;
		if (sessionId) {
			const direct = states.get(sessionId);
			if (direct) return direct;
		}
		let found = null;
		for (const state of states.values()) {
			if (!state.engaged) continue;
			if (found) return null;
			found = state;
		}
		return found;
	}

	/**
	 * Resolve one concrete route for the DSH platform (fallback) tier.
	 * The user's pinned choice wins; otherwise the saved default model, and only
	 * then the live platform catalog. Idempotent and cached on the state, so both
	 * the request hook and the adapter's stream may call it.
	 */
	async function ensureFallbackTarget(state, platform) {
		if (state.fallbackTarget) return state.fallbackTarget;
		if (state.fallbackDiscoveryFailed) return null;
		try {
			// 1) Prefer the user's persisted default when it is a platform route:
			//    it is known-valid for this installation.
			const saved = ctx.get("agentDefaultModel")?.currentSelection?.();
			if (saved && platform.includes(saved.provider) && typeof saved.model === "string" && saved.model) {
				state.fallbackTarget = { provider: saved.provider, model: saved.model };
				note(state, `fallback resolved to saved platform model ${saved.provider}/${saved.model}`);
			}
			// 2) Otherwise probe the live platform catalog.
			if (!state.fallbackTarget) {
				for (const provider of platform) {
					const models = await ctx.llm.listModels(provider);
					const first = Array.isArray(models) && models.find((m) => m && typeof m.id === "string" && m.id);
					if (first) {
						state.fallbackTarget = { provider, model: first.id };
						note(state, `fallback resolved to concrete platform model ${provider}/${first.id}`);
						break;
					}
				}
			}
			if (!state.fallbackTarget) {
				state.fallbackDiscoveryFailed = true;
				note(state, "fallback: no valid platform model available; handing back to normal retry");
			}
		} catch (error) {
			state.fallbackDiscoveryFailed = true;
			note(state, `fallback discovery failed (${String(error?.message ?? error)}); handing back to normal retry`);
		}
		return state.fallbackTarget;
	}

	/**
	 * Build a fresh state for a (possibly new) combo and report its starting
	 * phase. Routes whose provider has no adapter here are pruned, and a combo
	 * with nothing usable drops straight to the platform tier.
	 */
	function armState(rotation, noteText, combo, engaged) {
		const fresh = createState(rotation);
		// The tour only runs for an agent whose user picked a combo in the model
		// picker (or pressed 设为生效). Turning the plugin on is not enough.
		fresh.engaged = engaged === true;
		if (combo) {
			fresh.comboId = combo.id ?? "";
			fresh.timeoutThreshold = Number.isFinite(combo.timeoutThreshold) ? combo.timeoutThreshold : null;
		}
		pruneUnavailable(fresh);
		fresh.fallbackChoice = fallbackChoice ? { ...fallbackChoice } : null;
		fresh.phase = fresh.rotation.length > 0 ? "round1" : "idle";
		if (fresh.phase === "round1") {
			const first = nextThirdParty(fresh, "round1");
			if (first) {
				fresh.active = first;
			} else {
				// Nothing in the combo can be reached from this installation. Stay
				// idle instead of hijacking requests: forcing a dead route would fail
				// every turn, and dropping straight to the platform tier would
				// override the user's own selection for no reason. The tour starts
				// on its own once an adapter for a combo member is registered.
				fresh.phase = "idle";
				note(fresh, "combo has no reachable member in this installation; auto-switch stays idle until one appears");
			}
		}
		if (noteText) note(fresh, noteText);
		return fresh;
	}

	function snapshot(state) {
		return {
			engaged: state.engaged === true,
			comboId: state.comboId ?? "",
			phase: state.phase,
			rotation: state.rotation.map(routeKey),
			dead: [...state.dead],
			retestQueue: state.retestQueue.map(routeKey),
			retested: [...state.retested],
			timeouts: Object.fromEntries(state.timeouts),
			active: state.active ? routeKey(state.active) : null,
			log: state.log.slice(-12),
		};
	}

	/* -------- 0. Publish the combos as models of one virtual provider -------- */
	/**
	 * The harness groups the model picker strictly by provider route and offers
	 * no other grouping field, so the only way "my combo" can sit in the same
	 * list as ordinary models is to be a provider whose models ARE the combos.
	 * Selecting one is what engages the tour; selecting any ordinary model
	 * leaves the plugin completely out of the request.
	 */
	const rotationProviderId = () => {
		const configured = cfg.rotationProvider();
		return typeof configured === "string" && configured.trim() !== "" ? configured.trim() : DEFAULT_ROTATION_PROVIDER;
	};
	/**
	 * The harness registers a "<provider> + 自动识图" twin for every provider, so
	 * the combo is pickable from that group too. Both routes are ours.
	 */
	const isOurProvider = (provider) =>
		provider === rotationProviderId() || provider === `${rotationProviderId()}-vision`;
	const comboDisplayName = (combo, index) =>
		combo.name && combo.name.trim() !== "" ? combo.name : `组合 ${index + 1}`;
	const comboDescription = (combo) =>
		combo.rotation.length === 0
			? "空组合：还没有成员，先在设置页添加模型"
			: `${combo.rotation.length} 个成员，顺序降级：${combo.rotation.map(routeKey).join(" → ")}`;
	/**
	 * A combo's modalities decide how the harness assembles the request BEFORE
	 * any member is picked: `llm.stream` projects images to text only when the
	 * routed model lacks the "image" modality, otherwise the images travel as
	 * images. Every historical image then gets base64-inlined by the member's
	 * adapter, which is exactly how a long session turns into "request body
	 * exceeds 10MB" or a bare "Invalid string length" RangeError.
	 *
	 * So a combo only claims images when EVERY live member accepts them. Any
	 * mixed or unknown member downgrades the whole combo to text-only: a text
	 * placeholder for an image is recoverable, an oversized body is not, and
	 * sending images to a text-only member fails the request outright.
	 */
	const comboModalities = async (combo) => {
		const live = liveProviders();
		let sawMember = false;
		for (const route of combo.rotation) {
			if (live !== null && !live.has(route.provider)) continue;
			sawMember = true;
			try {
				const models = await ctx.llm.listModels(route.provider);
				const row = (models ?? []).find((entry) => entry?.id === route.model);
				if (row?.inputModalities === void 0 || !row.inputModalities.includes("image")) return ["text"];
			} catch {
				// A member that cannot be inspected here must not make the combo
				// claim capabilities the assembler would act on.
				return ["text"];
			}
		}
		return sawMember ? ["text", "image"] : ["text"];
	};

	const rotationAdapter = {
		providerInfo(provider) {
			return { id: provider, name: "模型自动切换" };
		},
		/**
		 * `registerAdapter` calls this while it validates the route, so a plain
		 * object (not an LlmAdapter subclass) has to answer it. Undefined means
		 * "use the normal defaults" — the combo route itself never retries, the
		 * member adapters carry their own policies.
		 */
		providerRetryPolicy() {
			return undefined;
		},
		/** The token meter asks this synchronously; no pricing is claimed here. */
		imageRequestPricing() {
			return undefined;
		},
		async listModels(provider) {
			const rows = [];
			for (const [index, combo] of combos.entries()) {
				rows.push({
					provider,
					id: combo.id,
					name: comboDisplayName(combo, index),
					description: comboDescription(combo),
					inputModalities: await comboModalities(combo),
				});
			}
			return rows;
		},
		async resolveModel(provider, model) {
			const combo = comboById(model);
			return {
				provider,
				id: model,
				name: combo ? comboDisplayName(combo, combos.indexOf(combo)) : model,
				context: { contextWindow: 128000 },
				inputModalities: combo ? await comboModalities(combo) : ["text"],
			};
		},
		async prepareCall(provider, model) {
			return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) };
		},
		/**
		 * The combo route is the only seam this harness still leaves us. The
		 * step's provider/model is frozen before prompt assembly and `agent/request`
		 * may no longer replace it ("use agent.model.select() before step
		 * preparation"), so every member swap happens right here: the state
		 * machine decides what is active, this hands the request to that member
		 * and lets the member's own adapter do the real work.
		 *
		 * The failure path is the mirror image: when a member fails, the finish
		 * chunk travels back out with the COMBO as its provider, the root
		 * `agent/request-error` listener advances the machine, and the loop
		 * re-prepares the same frozen selection — landing here again, now
		 * pointing at the next member.
		 */
		async *stream(options) {
			const combo = comboById(typeof options?.model === "string" ? options.model : "");
			if (!combo) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: { message: "模型自动切换：这个组合已经不存在了，请在设置页重新选择", code: "NO_ADAPTER" },
					},
				};
				return;
			}
			const own = rotationProviderId();
			const state = stateForStream(options);
			let route = null;
			if (state && state.engaged) {
				refreshProviders(state);
				if (state.phase === "fallback") {
					await ensureFallbackTarget(state, cfg.platformProviders());
					route = state.fallbackTarget;
					if (!route) {
						yield {
							type: "finish",
							reason: {
								kind: "error",
								failure: {
									message: "模型自动切换：组合里没有可用模型，DSH 平台兜底也没有解析出可用模型",
									code: "NO_ADAPTER",
								},
							},
						};
						return;
					}
				} else if (state.phase !== "idle") {
					route = decideActive(state);
				}
			}
			// No engaged state, or the tour is idle/empty: fall back to the first
			// member this installation can actually reach, so a combo that the
			// plugin cannot reason about still carries the request.
			if (!route) {
				const live = liveProviders();
				route =
					(combo.rotation ?? []).find(
						(candidate) =>
							candidate.provider !== own &&
							candidate.model !== "" &&
							(!live || live.has(candidate.provider)),
					) ?? null;
			}
			if (!route || route.provider === own) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: `模型自动切换：「${comboDisplayName(combo, combos.indexOf(combo))}」里没有本机可用的模型`,
							code: "NO_ADAPTER",
						},
					},
				};
				return;
			}
			yield* ctx.llm.stream({ ...options, provider: route.provider, model: route.model });
		},
	};
	ctx.effect(() => {
		const wanted = rotationProviderId();
		// registerAdapter is all-or-nothing and throws DUPLICATE_ADAPTER, so never
		// fight another plugin (or the user's config) for a route that is taken.
		const taken = (ctx.llm.listProviders() ?? []).some((provider) => provider && provider.id === wanted);
		if (taken) {
			ctx.logger?.warn?.(
				`model-auto-switch: provider "${wanted}" is already registered by another plugin; ` +
					"combos stay out of the model picker and only the 设为生效 button engages them",
			);
			return () => {};
		}
		const registration = ctx.llm.registerAdapter([wanted], rotationAdapter);
		return () => registration();
	}, "model-auto-switch: combo models");

	/* -------- 1. Observe every failure, outer-most on ROOT ctx -------- */
	ctx.on(
		"agent/request-error",
		(payload, next) => {
			const { agent, provider, failure } = payload;
			if (!enabledNow()) return next();
			const state = stateFor(agent);
			// Only an agent whose user picked a combo takes part in failover.
			// Merely enabling the plugin never changes an ordinary request.
			if (!state.engaged) return next();
			if (state.phase === "idle" || state.rotation.length === 0) return next();
			refreshProviders(state);
			const platform = cfg.platformProviders();
			const threshold = state.timeoutThreshold ?? thresholdNow();
			/*
			 * The failure now arrives stamped with the COMBO route: our adapter
			 * hands the request to a member, but the step's frozen selection —
			 * and therefore `request.provider` — stays the combo. The member
			 * that actually failed is the active one, so judge that instead.
			 */
			const own = isOurProvider(provider);
			const failedProvider = own && state.active ? state.active.provider : provider;
			// A provider with no adapter registered here is never retryable, no
			// matter what code the failure carries: kill that route and step on.
			// Our own combo route is registered by definition, so it must never be
			// judged against the member registry.
			const unreachable =
				!own && state.liveProviders && typeof provider === "string" && !state.liveProviders.has(provider);
			const effective = unreachable && failure && failure.code !== "RATE_LIMIT"
				? { ...failure, code: "NO_ADAPTER", message: failure.message ?? `no adapter registered for provider "${provider}"` }
				: failure;
			const result = handleFailure(state, failedProvider, effective, platform, threshold, {
				retryShortRateLimits: shortRateRetryNow(),
				shortRateLimitMs: shortRateLimitMsNow(),
				graceAttempts: graceAttemptsNow(),
			});
			if (result === undefined) return next(); // not our decision
			if (result === null) return next(); // exhausted / fallback failed → normal handling
			// We own the retry: skip the built-in backoff. The agent loop
			// re-prepares the step with the same frozen selection, and our adapter
			// routes that fresh attempt to whatever the machine just made active.
			return { kind: "retry" };
		},
		{ prepend: true },
	);

	/* -------- 2. Per-agent request override (outer-most on agent ctx) -------- */
	/** agentKey -> disposer returned by agent.ctx.effect(); also owned by our effect. */
	const agentEffects = new Map();
	function installForAgent(agent) {
		if (!agent?.ctx) return;
		const key = agentKey(agent);
		if (agentEffects.has(key)) return;
		// practices.md: a registration on agent.ctx has two owners. Wrap it in an
		// agent.ctx.effect() (removed on agent disposal) AND keep its disposer in
		// the plugin's own effect (removed on plugin unload).
		const dispose = agent.ctx.effect(
			() => {
				const off = agent.ctx.on(
					"agent/request",
					async (payload, next) => {
						const resolved = await next();
						if (!enabledNow()) return resolved;
						const state = states.get(key);
						if (!state) return resolved;
						/*
						 * Engagement comes from the selection itself. The user either
						 * picked one of our combo models in the model picker or they
						 * did not; picking an ordinary model disengages the plugin for
						 * this agent again. There is no second switch to forget.
						 */
						if (!isOurProvider(resolved.provider)) {
							if (state.engaged) {
								state.engaged = false;
								note(state, `selection moved to ${routeKey(resolved)} → auto-switch disengaged`);
							}
							return resolved;
						}
						const selected = comboById(typeof resolved.model === "string" ? resolved.model : "");
						if (!selected) {
							note(state, `selected combo "${resolved.model}" no longer exists → leaving the request alone`);
							return resolved;
						}
						// Arm on the selected combo. Re-arming only happens when the
						// selection changed, so a mid-turn failover keeps its progress.
						if (!state.engaged || state.comboId !== selected.id) {
							const fresh = armState(
								selected.rotation.map((route) => ({ ...route })),
								`combo ${selected.id} (${comboDisplayName(selected, 0)}) selected in the model picker`,
								selected,
								true,
							);
							Object.assign(state, fresh, { log: fresh.log });
						}
						const platform = cfg.platformProviders();
						refreshProviders(state);
						// A tour phase always has an active route; if every member died
						// the machine has already moved to the fallback phase. While no
						// member is reachable we stay idle and never touch the request.
						if (state.phase === "idle") {
							// The user picked this combo, so it owns the request. Idle
							// here means no member was reachable at arming time; the
							// probe above may have changed that, so try the tour first.
							const first = state.rotation.length > 0 ? nextThirdParty(state, "round1") : null;
							if (first) {
								state.phase = "round1";
								state.active = first;
								note(state, `combo member ${routeKey(first)} became reachable → tour starts`);
							} else {
								// Nothing in the combo works here: that is exactly the
								// case the platform tier exists for.
								const entered = enterFallback(state, platform);
								if (!entered) return resolved;
							}
						}

						if (state.phase === "fallback") {
							// Final tier: the DSH platform model is the last resort.
							// Make sure a concrete platform route exists for the
							// adapter to dispatch to. It cannot be picked HERE — the
							// step's selection is already frozen — so this only
							// records the target; the adapter does the routing.
							if (!platform.includes(resolved.provider)) await ensureFallbackTarget(state, platform);
							return resolved;
						}

						/*
						 * Never rewrite provider/model here. The harness captures the
						 * step's selection before prompt assembly and rejects a later
						 * change ("use agent.model.select() before step preparation"),
						 * which fails the whole turn. Routing to the active member —
						 * and the DSH fallback — is the adapter's job; see stream().
						 */
						return resolved;
					},
					{ prepend: true },
				);
				return () => off?.();
			},
			"model-auto-switch: agent/request override",
		);

		// A combo is a stable selection whose members change underneath it, so the
		// built-in notice (which compares the selection with the last request
		// header) would fire on every step. Drop only those notices.
		const noticeDispose = agent.ctx.effect(
			() =>
				agent.ctx.on(
					"agent/pre-step",
					async (payload, next) => {
						const decision = await next();
						if (!enabledNow() || decision?.kind === "reject" || !Array.isArray(decision?.messages)) return decision;
						const kept = decision.messages.filter((message) => {
							if (message?.source?.kind !== "model-selection") return true;
							const text = JSON.stringify(message.content ?? "");
							return !text.includes(rotationProviderId());
						});
						if (kept.length === decision.messages.length) return decision;
						return { ...decision, messages: kept };
					},
					{ prepend: true },
				),
			"model-auto-switch: combo switch notice filter",
		);
		agentEffects.set(key, () => {
			dispose?.();
			noticeDispose?.();
		});
	// Create the state eagerly: with a combo configured the first combo model
	// is the authoritative selection from the very first request, not only
	// after the first failure. Empty combo stays idle, so nothing is forced.
	stateFor(agent);
	}

	ctx.on("agent/created", ({ agent }) => installForAgent(agent));
	ctx.on("agent/disposed", ({ agent }) => {
		const key = agentKey(agent);
		agentEffects.get(key)?.();
		agentEffects.delete(key);
	});
	for (const agent of ctx.agents?.list?.() ?? []) installForAgent(agent);

	ctx.effect(
		() => () => {
			for (const dispose of agentEffects.values()) dispose?.();
			agentEffects.clear();
		},
		"model-auto-switch: per-agent overrides",
	);

	/* -------- 3. Agent tools: catalog / set-rotation / status -------- */
	ctx.tools.register(
		defineTool({
			name: "model_rotation_catalog",
			description:
				"List every model currently available for the model auto-switch plugin's rotation combo. Returns provider/model pairs for both DSH platform and third-party providers. Call this before model_rotation_set so the user picks only live models.",
			parameters: {},
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute(_args, exec) {
				const llm = ctx.llm;
				const platform = cfg.platformProviders();
				const groups = [];
				for (const p of llm.listProviders()) {
					let models = [];
					try {
						models = await llm.listModels(p.id);
					} catch {
						models = [];
					}
					if (models.length === 0) continue;
					groups.push({
						platform: platform.includes(p.id),
						provider: p.id,
						providerName: p.name ?? p.id,
						models: models.map((m) => ({ model: m.id, name: m.name ?? m.id })),
					});
				}
				return JSON.stringify({ groups });
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "model_rotation_set",
			description:
				"Define the ordered third-party model rotation combo for the auto-switch plugin (排序组合). Pass provider/model pairs in failover order; only third-party providers belong here (the DSH platform model is appended automatically as the final fallback). The first entry becomes the active model immediately for every agent.",
			parameters: {
				rotation: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							provider: { type: "string", required: true },
							model: { type: "string", required: true },
						},
						description: "One route entry: a provider id and a model id.",
					},
					description: "Ordered provider/model pairs, first = highest priority.",
				},
			},
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute(args, exec) {
				const routes = (args.rotation ?? [])
					.map((r) => ({ provider: String(r?.provider ?? ""), model: String(r?.model ?? "") }))
					.filter((r) => r.provider !== "" && r.model !== "");
				if (routes.length === 0) throw new Error("rotation must contain at least one {provider, model} pair");
				const platform = cfg.platformProviders();
				const thirdPartyOnly = routes.filter((r) => !platform.includes(r.provider));
				// The tool edits the ACTIVE combo (creating one when none exists yet),
				// so a page and a tool call never fight over two different cards.
				let combo = activeCombo();
				if (!combo) {
					combo = { id: nextComboId(), name: "", rotation: [], enabled: true, timeoutThreshold: null };
					combos = [...combos, combo];
				}
				combo.rotation = thirdPartyOnly.map((r) => ({ ...r }));
				activeComboId = combo.id;
				persistAll();
				// Reset every live agent to the new combo, phase round1.
				for (const state of states.values()) {
					const fresh = armState(currentRotation(), "combo redefined by user → reset", combo);
					Object.assign(state, fresh, { log: fresh.log });
				}
				return JSON.stringify({
					ok: true,
					comboId: combo.id,
					rotation: combo.rotation.map(routeKey),
					combos: combos.map((c) => ({ id: c.id, name: c.name, members: c.rotation.length })),
					platformFallback: platform[0] ?? "deepseek-official",
					note: "First combo model is now active; rate-limit marks a model dead, timeouts beyond the threshold advance to the next, retest of timed-out models runs when the combo is exhausted, then the DSH platform model takes over.",
				});
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "model_rotation_status",
			description:
				"Show the current state of the model auto-switch plugin: active model, phase (round1/retest/fallback), per-model timeout counters, dead (rate-limited) models and recent decisions.",
			parameters: {},
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute(_args, exec) {
				const out = [];
				for (const [key, state] of states) {
					out.push({ agent: key, ...snapshot(state) });
				}
				return JSON.stringify(
					{
						enabled: enabledNow(),
						timeoutThreshold: thresholdNow(),
						platformProviders: cfg.platformProviders(),
						fallback: fallbackChoice,
						activeComboId: activeCombo()?.id ?? "",
						combos: combos.map((combo) => ({
							id: combo.id,
							name: combo.name,
							active: combo.id === (activeCombo()?.id ?? ""),
							timeoutThreshold: comboThreshold(combo),
							members: combo.rotation.map(routeKey),
						})),
						configuredRotation: currentRotation().map(routeKey),
						agents: out,
					},
					null,
					2,
				);
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "model_rotation_reset",
			description:
				"Reset the auto-switch state machine for one agent (or all agents): clears timeout counters, dead marks and phase, re-arming the combo from its first model. Does not change the combo itself.",
			parameters: {
				all: { type: "boolean", description: "Reset every agent instead of just the caller." },
			},
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute(args, exec) {
				const scope = args.all === true ? "all" : agentKey(exec?.agent);
				const resetOne = (state) => {
					const combo = activeCombo();
					const fresh = armState(currentRotation(), "state reset", combo);
					Object.assign(state, fresh, { log: fresh.log });
				};
				let count = 0;
				for (const [key, state] of states) {
					if (scope === "all" || key === scope) {
						resetOne(state);
						count += 1;
					}
				}
				return JSON.stringify({ ok: true, reset: count, scope });
			},
		}),
	);

	/* -------- 4. Settings page bridge (same-origin HTTP) -------- */
	// The browser half reads and writes the combo over these routes. They are
	// served by whatever webServer the composition has, so the page works on
	// every kernel line even when no typed Remote binding exists.
	ctx.inject(["webServer"], (scoped) => {
		const server = scoped.webServer;
		const send = (res, status, payload) => {
			try {
				const body = JSON.stringify(payload);
				res.writeHead(status, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
				});
				res.end(body);
			} catch {
				/* socket already gone */
			}
		};

		const readJson = (req) =>
			new Promise((resolve) => {
				let raw = "";
				let settled = false;
				const done = (value) => {
					if (settled) return;
					settled = true;
					resolve(value);
				};
				req.on("data", (chunk) => {
					raw += chunk;
					if (raw.length > 1_000_000) done(null);
				});
				req.on("end", () => {
					try {
						done(JSON.parse(raw || "{}"));
					} catch {
						done(null);
					}
				});
				req.on("error", () => done(null));
			});

		/** Local origin only: this page can start paid model calls and rewrite the combo. */
		const allowed = (req) => {
			const host = req.headers?.host;
			if (typeof host !== "string") return false;
			if (req.headers?.["sec-fetch-site"] === "cross-site") return false;
			const origin = req.headers?.origin;
			if (typeof origin === "string") {
				try {
					if (new URL(origin).host !== host) return false;
				} catch {
					return false;
				}
			}
			const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
			return name === "127.0.0.1" || name === "localhost" || name === "::1" || name === "0.0.0.0";
		};

		let platformIds = [];

		/** One combo, with per-member availability for the card UI. */
		const comboView = (combo, live) => {
			const rotation = combo.rotation.map((r) => ({
				provider: r.provider,
				model: r.model,
				available: !live || live.has(r.provider),
			}));
			return {
				id: combo.id,
				name: combo.name,
				active: combo.id === (activeCombo()?.id ?? ""),
				enabled: combo.enabled !== false,
				timeoutThreshold: comboThreshold(combo),
				rotation,
				memberCount: rotation.length,
				// A combo with no reachable member cannot take part in the tour;
				// the card shows this instead of silently skipping members.
				usable: rotation.some((r) => r.available && !platformIds.includes(r.provider)),
			};
		};

		const stateView = () => {
			const live = liveProviders();
			platformIds = cfg.platformProviders();
			const active = activeCombo();
			return {
				ok: true,
				version: STATE_VERSION,
				// Backwards-compatible flat fields: the active combo.
				name: active?.name ?? "",
				rotation: (active?.rotation ?? []).map((r) => ({
					provider: r.provider,
					model: r.model,
					available: !live || live.has(r.provider),
				})),
				activeId: active?.id ?? "",
				enabled: enabledNow(),
				timeoutThreshold: thresholdNow(),
				platformProviders: platformIds,
				fallback: fallbackChoice,
				rotationProvider: rotationProviderId(),
				engageOnStart: engageOnStart(),
				retryShortRateLimits: shortRateRetryNow(),
				shortRateLimitMs: shortRateLimitMsNow(),
				graceAttempts: graceAttemptsNow(),
				combos: combos.map((combo) => comboView(combo, live)),
				agents: [...states.entries()].map(([agent, state]) => ({ agent, ...snapshot(state) })),
			};
		};

		/** Strip platform + empty routes; combos only hold third-party members. */
		const cleanRoutes = (list) => {
			const platform = cfg.platformProviders();
			const routes = [];
			for (const entry of list) {
				const provider = String(entry?.provider ?? "").trim();
				const model = String(entry?.model ?? "").trim();
				if (provider === "" || model === "") continue;
				if (platform.includes(provider)) continue; // platform is the implicit last resort
				routes.push({ provider, model });
			}
			return routes;
		};

		/** Re-arm every live agent after the combo list changed. */
		/**
		 * Re-arm every agent from the combo it is engaged to. An agent that never
		 * picked a combo stays disengaged — saving a card must not silently take
		 * over conversations that were running on an ordinary model.
		 */
		const rearmAll = (reason) => {
			for (const state of states.values()) {
				if (state.engaged !== true) continue;
				const combo = comboById(state.comboId);
				if (!combo) {
					state.engaged = false;
					state.phase = "idle";
					state.active = null;
					note(state, `${reason}; engaged combo no longer exists → disengaged`);
					continue;
				}
				const fresh = armState(combo.rotation.map((route) => ({ ...route })), reason, combo, true);
				Object.assign(state, fresh, { log: fresh.log });
			}
		};

		/** Engage every live agent to one combo (the page's 设为生效 button). */
		const engageAll = (combo, reason) => {
			for (const state of states.values()) {
				const fresh = armState(combo.rotation.map((route) => ({ ...route })), reason, combo, true);
				Object.assign(state, fresh, { log: fresh.log });
			}
		};

		/**
		 * Upsert one combo. Accepts both shapes:
		 *   {combo: {id?, name, rotation, enabled?, timeoutThreshold?}, makeActive?}
		 *   {id?, name, rotation, enabled?, timeoutThreshold?}   (legacy flat body)
		 * The flat shape is what the pre-multi-combo page posted, so old clients
		 * and the probe suites keep working unchanged.
		 */
		const applySave = (body) => {
			if (body === null || typeof body !== "object" || Array.isArray(body)) {
				return { ok: false, error: "malformed body" };
			}
			const nested = body.combo && typeof body.combo === "object";
			const source = nested ? body.combo : body;
			// A fallback-only body touches no combo: it must not create an empty
			// card just because the fallback model changed.
			const touchesCombo =
				nested ||
				Array.isArray(body.rotation) ||
				typeof body.name === "string" ||
				Number.isFinite(body.timeoutThreshold);
			if (!touchesCombo) {
				if (body.fallback === null) fallbackChoice = null;
				else if (body.fallback && typeof body.fallback === "object") {
					const next = sanitizeFallback(body.fallback);
					if (next && !cfg.platformProviders().includes(next.provider)) {
						return { ok: false, error: `fallback provider ${next.provider} is not a DSH platform provider` };
					}
					if (next) fallbackChoice = next;
				}
				if (typeof body.enabled === "boolean") runtimeEnabled = body.enabled;
				if (typeof body.retryShortRateLimits === "boolean") runtimeShortRate = body.retryShortRateLimits;
				if (Number.isFinite(body.shortRateLimitMs)) runtimeShortRateMs = Math.max(0, Math.trunc(body.shortRateLimitMs));
				if (Number.isFinite(body.graceAttempts)) runtimeGraceAttempts = Math.max(0, Math.trunc(body.graceAttempts));
				persistAll();
				for (const state of states.values()) state.fallbackChoice = fallbackChoice ? { ...fallbackChoice } : null;
				return { ok: true, ...stateView() };
			}
			const requestedId = typeof source.id === "string" && source.id !== "" ? source.id : "";
			// Legacy flat body (no id): edit the combo that is currently active so
			// an old client cannot pile up duplicate cards with every save.
			let combo = requestedId !== "" ? comboById(requestedId) : nested ? null : activeCombo();
			const creating = combo === null || combo === undefined;
			if (creating) {
				combo = {
					id: requestedId !== "" ? requestedId : nextComboId(),
					name: "",
					rotation: [],
					enabled: true,
					timeoutThreshold: null,
				};
				combos = [...combos, combo];
			}
			if (Array.isArray(source.rotation)) combo.rotation = cleanRoutes(source.rotation);
			if (typeof source.name === "string") combo.name = source.name.slice(0, 120);
			if (typeof source.enabled === "boolean") combo.enabled = source.enabled;
			if (Number.isFinite(source.timeoutThreshold)) {
				combo.timeoutThreshold = Math.max(0, Math.trunc(source.timeoutThreshold));
			}
			// The DSH fallback model lives on the top level: one choice for the
			// whole plugin, not per combo (it is the final tier for all of them).
			if (body.fallback === null) fallbackChoice = null;
			else if (body.fallback && typeof body.fallback === "object") {
				const next = sanitizeFallback(body.fallback);
				if (next && cfg.platformProviders().includes(next.provider)) fallbackChoice = next;
				else if (next) return { ok: false, error: `fallback provider ${next.provider} is not a DSH platform provider` };
			}
			// Global switches still live on the top level for backwards compat.
			if (typeof body.enabled === "boolean") runtimeEnabled = body.enabled;
			if (typeof body.retryShortRateLimits === "boolean") runtimeShortRate = body.retryShortRateLimits;
			if (Number.isFinite(body.shortRateLimitMs)) runtimeShortRateMs = Math.max(0, Math.trunc(body.shortRateLimitMs));
			if (Number.isFinite(body.graceAttempts)) runtimeGraceAttempts = Math.max(0, Math.trunc(body.graceAttempts));
			if (Number.isFinite(body.timeoutThreshold) && body.combo === undefined) {
				runtimeThreshold = Math.max(0, Math.trunc(body.timeoutThreshold));
			}
			// First saved combo becomes the active one; makeActive can switch.
			if (activeComboId === "" || body.makeActive === true || creating) {
				activeComboId = combo.id;
			}
			persistAll();
			rearmAll("combo saved from the settings page → state reset");
			return { ok: true, savedId: combo.id, ...stateView() };
		};

		/** Delete one combo; when it was active, fall back to the first left. */
		const applyDelete = (body) => {
			const id = typeof body?.id === "string" ? body.id : "";
			if (id === "" || !comboById(id)) return { ok: false, error: "unknown combo id" };
			combos = combos.filter((combo) => combo.id !== id);
			if (activeComboId === id) activeComboId = combos[0]?.id ?? "";
			persistAll();
			rearmAll("combo deleted from the settings page → state reset");
			return { ok: true, deleted: id, ...stateView() };
		};

		/** Make one combo the runtime tour source. */
		const applyActivate = (body) => {
			const id = typeof body?.id === "string" ? body.id : "";
			if (id === "" || !comboById(id)) return { ok: false, error: "unknown combo id" };
			activeComboId = id;
			persistAll();
			const combo = comboById(id);
			// 设为生效 means "use this combo from now on", including conversations
			// that were still running on an ordinary model.
			engageAll(combo, `combo ${id} (${comboDisplayName(combo, combos.indexOf(combo))}) engaged from the settings page`);
			return { ok: true, activeId: id, ...stateView() };
		};

		/**
		 * Create an empty card so the page can start a new 链路 before it has
		 * anything in it. The id is generated here, never by the browser.
		 */
		const applyCreate = (body) => {
			const name = typeof body?.name === "string" ? body.name.slice(0, 120) : "";
			const combo = {
				id: nextComboId(),
				name,
				rotation: cleanRoutes(Array.isArray(body?.rotation) ? body.rotation : []),
				enabled: true,
				timeoutThreshold: Number.isFinite(body?.timeoutThreshold) ? Math.max(0, Math.trunc(body.timeoutThreshold)) : null,
			};
			combos = [...combos, combo];
			if (activeComboId === "" || body?.makeActive === true) activeComboId = combo.id;
			persistAll();
			rearmAll("combo created from the settings page");
			return { ok: true, createdId: combo.id, ...stateView() };
		};

		const handler = async (req, res) => {
			if (!allowed(req)) {
				send(res, 403, { ok: false, error: "requests must come from the local host" });
				return;
			}
			const url = new URL(req.url ?? "/", "http://localhost");
			const marker = "/api/model-auto-switch";
			const at = url.pathname.indexOf(marker);
			const route = url.pathname.slice(at + marker.length).replace(/\/+$/, "") || "/";
			const method = String(req.method ?? "GET").toUpperCase();
			try {
				if (route === "/state" && (method === "GET" || method === "POST")) {
					send(res, 200, stateView());
					return;
				}
				if (route === "/save" && method === "POST") {
					send(res, 200, applySave(await readJson(req)));
					return;
				}
				if (route === "/create" && method === "POST") {
					send(res, 200, applyCreate(await readJson(req)));
					return;
				}
				if (route === "/delete" && method === "POST") {
					send(res, 200, applyDelete(await readJson(req)));
					return;
				}
				if (route === "/activate" && method === "POST") {
					send(res, 200, applyActivate(await readJson(req)));
					return;
				}
				if (route === "/catalog" && (method === "GET" || method === "POST")) {
					const platform = cfg.platformProviders();
					const groups = [];
					const failures = [];
					for (const provider of ctx.llm.listProviders()) {
						let models = [];
						try {
							models = await ctx.llm.listModels(provider.id);
						} catch (error) {
							failures.push({
								provider: provider.id,
								error: String(error?.message ?? error),
							});
							continue;
						}
						if (!Array.isArray(models) || models.length === 0) continue;
						groups.push({
							provider: provider.id,
							providerName: provider.name ?? provider.id,
							platform: platform.includes(provider.id),
							models: models.map((model) => ({
								model: model.id,
								name: model.name ?? model.id,
								description: model.description ?? "",
							})),
						});
					}
					send(res, 200, { ok: true, platformProviders: platform, groups, failures });
					return;
				}
				if (route === "/reset" && method === "POST") {
					let count = 0;
					for (const state of states.values()) {
						// Resetting the tour keeps the agent on the combo it was
						// already using; it only forgets the failures so far.
						const combo = comboById(state.comboId) ?? activeCombo();
						const fresh = armState(
							(combo?.rotation ?? []).map((route2) => ({ ...route2 })),
							"state reset from the settings page",
							combo,
							state.engaged === true,
						);
						Object.assign(state, fresh, { log: fresh.log });
						count += 1;
					}
					send(res, 200, { ok: true, reset: count, ...stateView() });
					return;
				}
				send(res, 404, { ok: false, error: "not found" });
			} catch (error) {
				send(res, 500, { ok: false, error: String(error?.message ?? error) });
			}
		};

		scoped.effect(
			() => server.register({ kind: "prefix", path: "/api/model-auto-switch", handler }),
			"model-auto-switch: settings bridge",
		);
	});

	// Seed the state file on first load so the page shows what Config declared.
	if (combos.length > 0 && activeComboId === "") activeComboId = combos[0].id;
	persistAll();
}
