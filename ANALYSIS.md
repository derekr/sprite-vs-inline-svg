# SVG sprite (`<use>`) vs inline SVG under Datastar fat-morph updates

Benchmark + analysis for the thread discussion. TL;DR: **your hypothesis holds —
morphing raw inline SVG is fine.** The sprite moves work around rather than
removing it, saves only ~4 KB on the wire after gzip, and buys you
cross-browser footguns in exchange. Details below; everything is reproducible
from this directory.

## What was measured

Realistic datagrid: **1000 rows × 4 action icons** (edit / delete / view / star,
Feather-style 24×24 stroke icons) = **4000 SVG instances**, the "thousands of
SVGs" case from the thread. Statuses flip and the star toggles on each update,
simulating a datastore patch.

- **inline**: every icon is a full `<svg …><path …/></svg>` (~10 repeated
  attributes per instance), morphed as-is — the "just send the raw svg" approach.
- **sprite**: one hidden `<svg><defs>` block with 5 `<symbol>`s + 4000 tiny
  `<svg><use href="#i-…"/></svg>` instances.

Morphing is done with **Idiomorph** (`idiomorph@0.7.3`), the exact library
Datastar uses for `datastar-patch-elements` morphs, so the "fat morph replaces
the whole `<table>`" path is faithful to production Datastar behavior (payload
parse + tree diff included, as on the wire).

Environment: headless Chrome 152 (Mac), 7 measured runs per variant after
2 warmups, alternating morph direction to defeat caching bias. DevTools timeline
traces (`trace-*.json`, open via `chrome://tracing` or the DevTools Performance
panel) + CDP page metrics (DOM nodes, layout/style counters, durations, heap)
captured per variant.

## Results

### Payload (per full-table update)

| | inline | sprite | Δ |
|---|---|---|---|
| HTML bytes | 1,812,308 | 1,372,976 | −24.2% |
| gzip bytes (level 6) | 40,401 | 36,390 | −9.9% (~4 KB) |
| **brotli bytes (q11, static)** | **14,431** | **14,080** | **−2.4% (~0.35 KB)** |
| **brotli bytes (q4, dynamic)** | **16,225** | **15,739** | **−3.0% (~0.5 KB)** |
| DOM nodes | 24,009 | 19,026 | −20.8% |

The gzip row is the "compressed-away" claim from the thread, quantified:
1.8 MB of duplicated SVG compresses ~45:1, so the sprite's dedup advantage
shrinks to ~4 KB per update. **Brotli — what CDNs actually serve — kills it
almost entirely:** ~0.35–0.5 KB either way. Brotli's larger window and
content-defined dictionary dedupe the repeated inline SVG even better than
gzip. Raw-byte savings (−24%) mostly evaporate on any modern wire.
(Gzip figures cross-checked: in-page `CompressionStream` output matches Node
`zlib.gzipSync` byte-for-byte; brotli via `node compress.mjs`.)

### Timing (ms, 1000-row fat morph; mean / median / p95)

| | inline | sprite |
|---|---|---|
| Initial mount | 40.7 / 40.6 / 44.9 | 54.5 / 51.4 / 64.0 (**+34%**, shadow-tree construction) |
| Fat morph (parse + tree diff) | 60.5 / 59.5 / 68.5 | 50.1 / 46.7 / 61.3 (**−17%**) |
| Forced layout after morph | 4.2 / 4.2 / 4.4 | 9.3 / 8.9 / 12.8 (**~2.2× slower**) |
| **End-to-end (morph + layout)** | **~64.7 / ~63.7** | **~59.4 / ~55.6 (single-digit ms edge)** |
| Single-row change morphed vs full table | 61.6 / 57.7 | 44.4 / 44.2 (same deferral pattern) |

Three full runs (two normal order, one reversed — see "Adversarial
verification") all agree: sprite diffs somewhat faster, lays out somewhat
slower, net difference is a few ms on a ~60 ms update. Run-to-run variance
(sds 2–7 ms) is on the same order as the gap.

### Where the work goes (DevTools trace self-time, one traced mount+morph window)

| self-time | inline | sprite |
|---|---|---|
| `ParseHTML` | 21.9 ms | 32.7 ms |
| `Document::recalcStyle` | 10.0 ms | **17.4 ms** |
| `Document::rebuildLayoutTree` | 4.4 ms | **7.6 ms** |
| `UpdateLayoutTree` | ~0 ms | **9.0 ms** |
| `LocalFrameView::performLayout` | 22.7 ms | **30.7 ms** |

This answers Anders' question directly: **no, the sprite does not save the
browser work overall — it relocates it.** Each `<use>` instance carries a
shadow tree, so style recalc + layout-tree rebuild + layout get *more*
expensive, roughly cancelling the cheaper JS tree-diff (10 attributes × 4000
instances never get compared under `<use>`). The browser must resolve every
shadow tree at layout time; that cost is unavoidable and, unlike diffing,
can't early-exit on "nothing changed."

## Adversarial verification

The harness tried to prove itself wrong, and once succeeded:

1. **Harness bug caught by assertions.** The first run morphed
   `holder.firstElementChild` — which for the sprite variant was the defs
   `<svg>`, not the table — so Idiomorph *duplicated* the grid (4000→8000
   `<use>`) instead of morphing it. Automated checks (icon renders at 16px,
   exact `<use>` count, tick applied, row count) now guard this, and payloads
   were wrapped in a single-root `#app` div so both variants morph 1:1. All
   numbers above are post-fix.
2. **Ordering bias.** `REVERSE=1 node run-headless.mjs` benchmarks sprite
   first (JIT/GC warmup otherwise always favors whoever runs second).
   Reversed end-to-end means: **63.7 ms inline vs 63.7 ms sprite — identical.**
3. **Compression cross-check.** In-page gzip matches Node `zlib` exactly;
   brotli computed independently in Node on the same payload strings.
4. **Trace accounting.** An early summarizer double-counted nested slices;
   replaced with self-time (interval-containment) accounting — the table above.
5. **Page isolation.** The preview page renders both variants side by side,
   but it is screenshot-only — measurement always mounts one variant at a
   time. To rule out shared GC/JIT state anyway, `node isolate.mjs`
   benchmarks each variant in its own fresh browser process: inline
   morph 61.1/layout 4.3 ms, sprite morph 51.7/layout 9.8 ms — within noise
   of the shared-page runs. Isolation doesn't move the numbers.

### Memory / DOM weight

- Live DOM nodes: 24,008 vs 19,025 (~5k fewer nodes for sprite — one `<use>`
  replaces 1–4 `<path>`/`<polyline>` children per icon).
- JS heap after mount + explicit GC: identical (~0.88 MB both). (`usedJSHeapSize`
  doesn't count Blink C++ DOM nodes, so node count is the honest proxy: sprite
  is lighter in DOM weight, immaterially so at this scale.)
- CDP cumulative counters over the traced window agree with the traces:
  `LayoutDuration` 0.023 vs 0.050 s, `RecalcStyleDuration` 0.013 vs 0.060 s —
  sprite spends more in style/layout.

## Interpretation for the thread

1. **drk's hypothesis — confirmed.** Under fat morph, sending raw SVG is fine.
   End-to-end cost of a 1000-row update is ~60–65 ms either way; the few-ms
   edge for sprite is negligible against frame budgets at this update size,
   and it costs you sprite maintenance, wiring, and cross-browser edge cases.
2. **nickchomey's compression point — confirmed and quantified.** Duplication
   across the doc compresses away: −24% raw becomes −10% / ~4 KB gzipped,
   and under brotli (what CDNs serve) it's ~0.4 KB.
3. **"The browser has to do some work" — true, but sprites don't remove it.**
   They trade JS diff work for style/layout work (~2.2× worse forced-layout
   in this test, plus a dedicated `UpdateLayoutTree` pass inline doesn't
   pay). Net: wash.
4. **When sprites *do* make sense:** icons in regions that are *not* fat
   morphed and rarely change (static chrome, server-rendered once) — there the
   smaller DOM and zero re-diff cost is pure win, and the one-time layout cost
   is amortized. That matches drk's "if it isn't being fat morphed then sure."
5. **Footguns to price in** (drk's "ymmv"): `href` vs legacy `xlink:href`
   (Safari-old), external-file sprites + CSP/`file://` quirks, `<use>` shadow
   DOM can't be targeted by page CSS (only inherited properties cross the
   boundary — per-icon coloring tricks break), and `currentColor`/styling
   surprises. Inline SVG has none of these.

## Reproduce / explore

```sh
npm install            # puppeteer-core (drives local Chrome, no download)
node run-headless.mjs  # full benchmark -> results.json + trace-*.json
REVERSE=1 node run-headless.mjs  # adversarial: sprite-first ordering
node mem.mjs [rows]    # heap-after-mount check
node compress.mjs [rows]  # payload sizes: raw + gzip + brotli(q11/q4) -> payload-*.html
ROWS=2000 RUNS=10 node run-headless.mjs   # other scales
```

Or open `index.html` in a browser (Needs network for the Idiomorph CDN.
`?rows=1000&runs=7&autorun=1` runs on load) for the interactive table.
Open `trace-inline.json` / `trace-sprite.json` in `chrome://tracing` or
DevTools → Performance → Load profile to poke at the frames yourself.

Caveats: test surface is positioned off-screen (real layout, paint culled —
paint is negligible for 16px icons either way); single machine/browser;
Idiomorph-in-page stands in for Datastar's patch path (same library, same
`outerHTML`-style morph, minus SSE transport).
