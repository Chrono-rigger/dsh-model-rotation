# dsh-model-rotation

[![npm](https://img.shields.io/npm/v/dsh-model-rotation)](https://www.npmjs.com/package/dsh-model-rotation)

**自定义模型自动切换 / Custom model rotation with automatic failover — for DeepSeek Harness.**

Define an ordered chain of models. When a member is rate-limited, or times out more than
`timeoutThreshold` times, the tour moves to the next member. When no third-party member is left,
it goes back and re-tests the models that timed out in the first round. Finally the DSH platform
model catches everything.

- **Ordered failover** — pick any models you have configured, in the order you want them tried.
- **Rate limit → switch immediately**; timeouts are counted per model and only switch past the limit.
- **Retest round** — models that merely timed out get a second chance before the chain is exhausted.
- **DSH platform fallback** — a platform model of your choice (e.g. `deepseek-account/deepseek-flash`)
  is the last resort, and it is sticky: it does not jump back the moment a third-party route revives.
- **Picks up in the model picker** — every saved chain is published as a model under the
  「模型自动切换」 provider, so you select it like any other model. Selecting anything else leaves
  your requests completely untouched.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-model-rotation
```

Then restart DSH. To install from this repository instead:

```sh
dsh plugin --profile <your-profile> add github:Chrono-rigger/dsh-model-rotation
```

The plugin needs a DSH that ships the `agent/request` and `agent/request-error` waterfall
events (0.2.x and newer).

## Use

1. Open **Settings → 模型自动切换** (or the plugin's own page under **Plugins**).
2. **新建组合**, type a name, and add members — the picker searches by model id or name.
   Reorder with ↑/↓; the order is the failover order.
3. Optionally pin a **DSH 兜底模型** — the platform model used when the whole chain is exhausted.
4. **保存组合**, then pick the chain by name in the model picker.

The card list shows every saved chain with its members, per-chain timeout limit, and whether it is
currently usable. A member whose provider has no adapter in this installation is flagged
「当前不可用」 and skipped by the tour instead of failing your request.

### Per-chain settings

| Setting | Meaning |
| --- | --- |
| 超时上限 | How many timeouts one member may hit before the tour moves on. `0` switches on the first one. |
| 短时限流原地重试 | Off by default. When on, a `429` that states a short wait is retried on the same model instead of switching away at once — useful for providers that already rotate accounts behind one route. Quota exhaustion always switches immediately. |
| 最长等待 / 原地重试次数 | The wait ceiling (ms) and how many in-place retries one route gets before it is marked dead. |

### Tools

The agent can drive the same state:

- `model_rotation_catalog` — every provider/model pair available in this installation
- `model_rotation_set` — replace the active chain's members
- `model_rotation_status` — chains, live per-agent phase, decision log
- `model_rotation_reset` — forget failures and start the tour over

## State machine

```
round1   members in order
           rate limit / quota   → marked dead, move on
           timeout              → count++, move on after the per-chain limit
           no adapter / auth    → marked dead, move on
              ↓ all members dead or exhausted
retest   members that only timed out in round1, fresh timeout budget
              ↓ exhausted
fallback DSH platform model (pinned or auto-discovered) — sticky
```

Failures the plugin does not own (`SERVER`, `TRANSPORT`, `EMPTY_RESPONSE`, …) are handed back to
the harness's own retry policy untouched.

Runtime state lives in `~/.dsh/model-auto-switch-state.json` (or `$DSH_HOME`), and is
best-effort: a broken file falls back to the plugin config instead of failing the boot.

### About 「自动识图」

The harness registers a `-vision` twin for every provider that supports image input; those twins
list the *same* models and only differ in accepting images. The picker hides them by default —
turn on **显示「自动识图」变体** if you want to add one. For everyday text work use the plain
entry (cheaper, same context); add the vision twin only when you actually send images.

## Compatibility with provider-level rotation

The plugin rewrites the route at the `agent/request` waterfall, which runs *before* the adapter is
bound. A member that itself rotates accounts behind one provider id (WorkBuddy, free-model pools,
…) therefore keeps that behaviour — its own failover runs first, and only a failure of the whole
pool reaches this plugin.

## License

MIT
