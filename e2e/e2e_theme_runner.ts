const origLog = console.log;
const origWarn = console.warn;
const origErr = console.error;

function reprintBottom() {
  printProgress();
}

console.log = (...args: any[]) => {
  origLog(...args);
  reprintBottom();
};

console.warn = (...args: any[]) => {
  origWarn(...args);
  reprintBottom();
};

console.error = (...args: any[]) => {
  origErr(...args);
  reprintBottom();
};
// e2e_theme_runner.ts
// Run: ts-node e2e_theme_runner.ts
// Deps: puppeteer@^24, pixelmatch, pngjs, csv-parser, esbuild, @types/node
import ansiEscapes from "ansi-escapes";
import fs from "fs";
import path from "path";
import puppeteer, { Browser, Page } from "puppeteer";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import csv from "csv-parser";
import { build } from "esbuild";

const args = process.argv.slice(2);
const ONLY_THEME = args.find((a) => !a.startsWith("--"))?.toLowerCase();
const DEBUG_MODE = args.includes("--debug");
const HOLD_DEBUG_SLOT = args.includes("--hold");
const RESUME_MODE = args.includes("--resume");
const FIX_ERROR =
  args
    .find((a) => a.startsWith("--fix="))
    ?.split("=")[1]
    ?.trim() || "";
// ---- Fixed inputs ----
const INPUT_CSV = path.resolve(__dirname, "../fetch_themes/themes.csv"); // columns: name, demo_store_url
const REFRESH_TS_PATH = fs.existsSync(path.resolve(__dirname, "../src/refreshCart.ts"))
  ? path.resolve(__dirname, "../src/refreshCart.ts")
  : path.resolve(__dirname, "refreshCart.ts"); // must export refreshCart or set window.RC.refreshCart
const OUT_DIR = path.resolve("out");
const CONCURRENCY = Number(
  args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 3,
);
let ACTIVE = 0;
let TOTAL = 0;
let COMPLETED = 0;

function printProgress() {
  if (!TOTAL) return;
  const pct = ((COMPLETED / TOTAL) * 100).toFixed(1);
  const line = `[PROGRESS] ${COMPLETED}/${TOTAL} (${pct}%) active=${ACTIVE}/${CONCURRENCY}`;
  // overwrite same line
  // process.stdout.write("\r" + line.padEnd(90));
    process.stdout.write(
    ansiEscapes.eraseLines(1) +
      `[PROGRESS] ${COMPLETED}/${TOTAL} (${((COMPLETED / TOTAL) * 100).toFixed(1)}%) active=${ACTIVE}/${CONCURRENCY}` +
      "\n"
  );
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  if (!Number.isFinite(limit) || limit < 1) limit = 1;
  let i = 0;
  const n = items.length;
  const runners = Array.from({ length: Math.min(limit, n) }, () =>
    (async function loop() {
      for (;;) {
        const idx = i++;
        if (idx >= n) break;
        await worker(items[idx], idx);
      }
    })(),
  );
  await Promise.all(runners);
}

declare global {
  interface Window {
    ShopifyAnalytics: any;
    Shopify: any;
    // @ts-ignore
    __CLS?: number;
    __clsReset?: () => void;
  }
}

// ---- FS prep ----
const SS_DIR = path.join(OUT_DIR, "screens");
const DIFF_DIR = path.join(OUT_DIR, "diffs");
const LOG_CSV = path.join(OUT_DIR, "results.csv");
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SS_DIR, { recursive: true });
fs.mkdirSync(DIFF_DIR, { recursive: true });

// ---- CSV schema ----
const csvHeaders = [
  "name",
  "demo_url",
  "add_btn_found",
  "clicked_ok",
  "captured_req", // 1 if we resolved a usable variant id
  "manual_add_ok",
  "refresh_ok",
  "cls_after_click", // CLS after UI click settle
  "cls_after_manual", // CLS after add.js + refreshCart
  "pre_click_png", // BEFORE first add-to-cart click
  "post_click_png", // AFTER first add-to-cart click
  "post_refresh_png", // AFTER manual add + refreshCart
  "base_diff_png", // diff(pre_click vs post_click)
  "base_change_pct", // % changed for base diff
  "refresh_diff_png", // diff(post_click vs post_refresh)
  "refresh_change_pct", // % changed for refresh diff
  "skipped_no_change", // 1 if skipped refresh step due to no change
  "dialog_alerted", // 1 if page raised alert/confirm/prompt
  "result", // PASS | NO-PASS
  "error", // reason(s)
  "schema_name",
  "theme_id"
] as const;
type CsvKey = (typeof csvHeaders)[number];
type CsvRow = Record<CsvKey, string | number>;

const hasExistingLog = fs.existsSync(LOG_CSV);

let completedNames = new Set<string>();
let retryNames: Set<string> | null = null;

// If resuming and log exists, load completed names
if (RESUME_MODE && hasExistingLog) {
  const raw = fs.readFileSync(LOG_CSV, "utf8").split("\n").slice(1);
  raw.forEach((line) => {
    if (!line.trim()) return;
    const parts = line.split(",");
    const name = parts[0]?.replace(/^"|"$/g, "");
    if (name) completedNames.add(name.toLowerCase());
  });
}

// Fresh run (no resume, no fix) OR no existing log → truncate and write header
if (!hasExistingLog || (!RESUME_MODE && !FIX_ERROR)) {
  fs.writeFileSync(LOG_CSV, csvHeaders.join(",") + "\n");
}

// If --fix=<error> is provided, build a list of theme names to retry
if (FIX_ERROR && hasExistingLog) {
  retryNames = new Set<string>();
  const lines = fs.readFileSync(LOG_CSV, "utf8").split("\n").slice(1);
  const errorIdx = csvHeaders.indexOf("error");

  lines.forEach((line) => {
    if (!line.trim()) return;
    const parts = line.split(",");
    const rawName = parts[0]?.replace(/^"|"$/g, "");
    const rawErr =
      errorIdx >= 0 ? parts[errorIdx]?.replace(/^"|"$/g, "") : "";

    if (!rawName || !rawErr) return;
    if (rawErr.includes(FIX_ERROR)) {
      retryNames!.add(rawName.toLowerCase());
    }
  });

  console.log(
    `[FIX] Mode enabled for error="${FIX_ERROR}", retrying ${retryNames.size} theme(s)`,
  );
}

const outStream = fs.createWriteStream(LOG_CSV, { flags: "a" });

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeRow(row: Partial<CsvRow>) {
  const full: CsvRow = Object.fromEntries(
    csvHeaders.map((k) => [k, row[k] ?? ""]),
  ) as CsvRow;
  outStream.write(csvHeaders.map((k) => csvEscape(full[k])).join(",") + "\n");
}
// Helper to extract the first CSV field (name) handling simple quotes
function extractNameField(line: string): string | null {
  if (!line) return null;
  if (line[0] === '"') {
    let i = 1;
    let out = "";
    while (i < line.length) {
      const ch = line[i];
      if (ch === '"') {
        // Escaped quote
        if (line[i + 1] === '"') {
          out += '"';
          i += 2;
          continue;
        }
        // Closing quote
        return out;
      }
      out += ch;
      i++;
    }
    return out;
  } else {
    const idx = line.indexOf(",");
    return idx === -1 ? line : line.slice(0, idx);
  }
}

// After all writes, dedupe by theme name: keep last occurrence
function compactResultsCsv(): void {
  if (!fs.existsSync(LOG_CSV)) return;
  const text = fs.readFileSync(LOG_CSV, "utf8");
  const lines = text.split("\n");
  if (lines.length <= 2) return;

  const header = lines[0];
  const map = new Map<string, string>(); // nameLower -> line

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const name = extractNameField(line);
    if (!name) continue;

    const key = name.toLowerCase();

    // ensure "last wins" while keeping last occurrence order
    if (map.has(key)) map.delete(key);
    map.set(key, line);
  }

  const deduped = [header, ...map.values()].join("\n") + "\n";
  fs.writeFileSync(LOG_CSV, deduped, "utf8");
}

// ---- helpers ----
function sanitizeName(n: string) {
  return String(n || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 80);
}

async function diffPng(
  beforePath: string,
  afterPath: string,
  outPath: string,
): Promise<{ pixels: number; pct: number; width: number; height: number }> {
  const img1 = PNG.sync.read(fs.readFileSync(beforePath));
  const img2 = PNG.sync.read(fs.readFileSync(afterPath));
  const width = Math.min(img1.width, img2.width);
  const height = Math.min(img1.height, img2.height);

  const crop = (src: PNG): PNG => {
    if (src.width === width && src.height === height) return src;
    const out = new PNG({ width, height });
    PNG.bitblt(src, out, 0, 0, width, height, 0, 0);
    return out;
  };

  const a = crop(img1);
  const b = crop(img2);
  const diff = new PNG({ width, height });
  const n = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: 0.1,
  });
  fs.writeFileSync(outPath, PNG.sync.write(diff));
  const pct = (n / (width * height)) * 100;
  return { pixels: n, pct, width, height };
}

async function compileRefreshCartBundle(): Promise<string> {
  const res = await build({
    entryPoints: [REFRESH_TS_PATH],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "RC",
    write: false,
    target: ["es2019"],
    sourcemap: false,
    loader: { ".ts": "ts" },
  });
  const file = res.outputFiles?.[0];
  if (!file) throw new Error("Failed to compile refreshCart.ts");
  return file.text;
}

type ThemeRec = {
  name?: string;
  demo_store_url?: string;
  demo_url?: string;
  url?: string;
};

// ---- in-page code (preloaded) ----
// NOTE: use evaluateOnNewDocument in Puppeteer v24 to preload before any page script runs. :contentReference[oaicite:2]{index=2}
function preloadCLS() {
  // CLS accumulator
  try {
    (window as any).__CLS = 0;
    (window as any).__clsReset = () => {
      (window as any).__CLS = 0;
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // @ts-ignore
        if (!e.hadRecentInput) (window as any).__CLS += (e as any).value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}

  // 429-aware fetch wrapper with exponential backoff + jitter
  try {
const w: any = window as any;
  const orig = w.fetch?.bind(window);
  if (!orig || w.__fetchWrapped) return;
  w.__fetchWrapped = true;

  const MAX_RETRIES = 6; // same shape as Python: 0..5
  const CAP_MS = 60_000;

  const sleep = (ms: number) =>
    new Promise<void>((res) => setTimeout(res, ms));

  w.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    let lastErr: any = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await orig(...args);

        // Only backoff on 429s, same as your Python helper
        if (res.status !== 429) return res;

        // Force retry error path exactly like Python `raise HTTPError`
        lastErr = new Error(`HTTP 429 (attempt ${attempt})`);
        throw lastErr;
      } catch (e) {
        lastErr = e;

        if (attempt >= MAX_RETRIES - 1) {
          // Exhausted
          throw lastErr;
        }

        // Python-style delay:
        // base = 2**attempt, jitter = random.uniform(0,1)
        const base = Math.pow(2, attempt) * 1000; // convert seconds → ms
        const jitter = Math.random() * 1000;
        const delay = Math.min(CAP_MS, base + jitter);

        console.warn(
          `[fetch-backoff] retry ${attempt + 1}/${MAX_RETRIES} | delay=${delay.toFixed(
            0
          )}ms`
        );

        await sleep(delay);
      }
    }

    throw lastErr || new Error("fetch failed with no error?");
  };
  } catch {
    // if anything explodes, just leave fetch untouched
  }
}

// Resolve a product handle + (productId, variantId) that is in stock.
async function resolveProductAndVariant(): Promise<{
  handle: string | null;
  productId: number | string | null;
  variantId: number | string | null;
  source: string;
}> {
  // 1) Paginate /products.json?page=N until we find something or hit empty.
  try {
    for (let page = 1; page <= 20; page++) {
      const r = await fetch(`/products.json?page=${page}`, {
        credentials: "same-origin",
      });
      if (!r.ok) break;

      const data = await r.json();
      const list = Array.isArray((data as any)?.products)
        ? (data as any).products
        : [];

      if (list.length === 0) break; // dead page → stop

      const pick =
        list.find(
          (p: any) =>
            Array.isArray(p?.variants) &&
            p.variants.some((v: any) => v?.available),
        ) ||
        list[0] ||
        null;

      if (pick) {
        const v =
          (pick.variants || []).find((x: any) => x?.available) ||
          (pick.variants || [])[0];

        if (v?.id) {
          return {
            handle: pick.handle || null,
            productId: pick.id || null,
            variantId: v.id,
            source: `/products.json?page=${page}`,
          };
        }
      }
    }
  } catch {}

  // 2) If we’re on a product page, fallback to /products/<handle>.js
  try {
    const m = location.pathname.match(/\/products\/([^/?#]+)/);
    if (m && m[1]) {
      const r = await fetch(`/products/${m[1]}.js`, {
        credentials: "same-origin",
      });
      if (r.ok) {
        const p = await r.json();
        const v =
          (p?.variants || []).find((x: any) => x?.available) ||
          (p?.variants || [])[0];
        if (v?.id) {
          return {
            handle: p?.handle || m[1],
            productId: p?.id || null,
            variantId: v.id,
            source: "product.js",
          };
        }
      }
    }
  } catch {}

  // 3) Nothing found.
  return { handle: null, productId: null, variantId: null, source: "none" };
}

// Wait until CLS stops increasing for a short window (settle heuristic).
async function waitForCLSSilence(msStable = 600): Promise<void> {
  const read = () => (window as any).__CLS || 0;
  return new Promise<void>((resolve) => {
    let last = read();
    let t = 0;
    const tick = () => {
      const cur = read();
      if (cur === last) {
        t += 100;
        if (t >= msStable) return resolve();
      } else {
        last = cur;
        t = 0;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

// ---- Node-side helpers ----
async function waitForSettle(page: Page, ms = 1200) {
  await new Promise((r) => setTimeout(r, ms));
  await page.evaluate(() => new Promise(requestAnimationFrame));
}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffDelay(attempt: number, base = 500, jitter = 250): number {
  // attempt is 1-based; 1 → base, 2 → 2*base, 3 → 4*base, etc.
  const exp = Math.pow(2, attempt - 1);
  const rand = Math.random() * jitter;
  return base * exp + rand;
}

async function gotoWithRetry(
  page: Page,
  url: string,
  label: string,
  maxAttempts = 4,
) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });

      const status = resp?.status();
      if (status === 429 && attempt < maxAttempts) {
        const headers = resp?.headers() || {};
        let delay = backoffDelay(attempt);
        const ra =
          headers["retry-after"] ??
          headers["Retry-After"] ??
          headers["retry_after"];
        const raNum = ra ? parseInt(String(ra), 10) : NaN;
        if (!Number.isNaN(raNum) && raNum > 0) {
          delay = raNum * 1000;
        }

        console.warn(
          `[gotoWithRetry] 429 for ${label} (attempt ${attempt}/${maxAttempts}), sleeping ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt >= maxAttempts) {
        console.error(
          `[gotoWithRetry] error on ${label} (attempt ${attempt}/${maxAttempts}), giving up`,
          e,
        );
        throw e;
      }
      const delay = backoffDelay(attempt);
      console.warn(
        `[gotoWithRetry] error on ${label} (attempt ${attempt}/${maxAttempts}), sleeping ${delay}ms`,
      );
      await sleep(delay);
    }
  }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw lastErr || new Error(`gotoWithRetry exhausted for ${label}`);
}

async function clearSiteData(page: Page, urlForOrigin: string) {
  const client = await page.createCDPSession(); // CDP access. :contentReference[oaicite:3]{index=3}
  const origin = new URL(urlForOrigin).origin;
  try {
    await client.send("Network.clearBrowserCookies");
  } catch {}
  try {
    await client.send("Network.clearBrowserCache");
  } catch {}
  try {
    await client.send("Storage.clearDataForOrigin", {
      origin,
      storageTypes: "all",
    });
  } catch {}
}

// ---- core ----
// ---- core ----
async function runOne(
  browser: Browser,
  refreshBundleCode: string,
  rec: ThemeRec,
  idx: number,
): Promise<void> {
  const name = rec.name || (rec as any).theme || "";
  const url = rec.demo_store_url || rec.demo_url || rec.url || "";
  const tag = sanitizeName(
    name || (url ? new URL(url).hostname : `job-${idx}`),
  );

  // Incognito to isolate storage per job
  const context = await browser.createBrowserContext();
  let page: Page | undefined;

  // CSV row init (matches NEW headers)
  const row: Partial<CsvRow> = {
    name,
    demo_url: url,
    add_btn_found: 0,
    clicked_ok: 0,
    captured_req: 0,
    manual_add_ok: 0,
    refresh_ok: 0,
    cls_after_click: "",
    cls_after_manual: "",
    pre_click_png: "",
    post_click_png: "",
    post_refresh_png: "",
    base_diff_png: "",
    base_change_pct: "",
    refresh_diff_png: "",
    refresh_change_pct: "",
    skipped_no_change: 0,
    dialog_alerted: 0,
    result: "",
    error: "",
    schema_name: "",
    theme_id: 0
  };

  // Convenience for early exits in debug+hold
  async function maybeHoldForDebug(p?: Page) {
    if (DEBUG_MODE && HOLD_DEBUG_SLOT && p) {
      await new Promise<void>((res) => p.on("close", () => res()));
    }
  }

  // File paths
  const themeOutDir = path.join(OUT_DIR, tag);
  const preClickPath = path.join(themeOutDir, "pre_click.png");
  const postClickPath = path.join(themeOutDir, "post_click.png");
  const postRefreshPath = path.join(themeOutDir, "post_refresh.png");
  const baseDiffPath = path.join(themeOutDir, "base_diff.png");
  const refreshDiffPath = path.join(themeOutDir, "refresh_diff.png");

  try {
    if (!url) {
      row.error = "no_demo_url";
      writeRow(row);
      return await maybeHoldForDebug();
    }

    fs.mkdirSync(themeOutDir, { recursive: true });

    page = await context.newPage();
    if (DEBUG_MODE) await page.bringToFront();
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(15_000);

    console.log(`[JOB ${idx}] ${tag} → ${url}`);

    await page.setBypassCSP(true);
    await page.evaluateOnNewDocument(preloadCLS);

    let dialogAlerted = false;
    page.on("dialog", async (d) => {
      dialogAlerted = true;
      try {
        await d.dismiss();
      } catch {}
    });
    page.on("console", (msg) => console.log(`[JOB ${idx}]`, msg.text()));
    page.on("requestfailed", (r) =>
      console.warn(`[JOB ${idx}] ✖`, r.failure()?.errorText, r.url()),
    );

    // 1) Open theme landing
     await gotoWithRetry(page, url, `landing ${tag}`);
    // capture theme schema_name (if any)
    try {
      const schema = await page.evaluate(() => {
        const t = (window as any).Shopify?.theme;
        return t?.schema_name || t?.name || "";
      });
            const theme_id = await page.evaluate(() => {
        const t = (window as any).Shopify?.theme;
        return t?.id || "";
      });
      if (schema) row.schema_name = schema;
      if (schema) row.theme_id = theme_id;
    } catch {
      row.schema_name = "";
    }

    if (dialogAlerted) {
      row.dialog_alerted = 1;
      row.error = (row.error ? row.error + ";" : "") + "alert_dialog";
      writeRow(row);
      return await maybeHoldForDebug(page);
    }

    // 2) Resolve product + variant (twice like OLD)
    let pick = await page.evaluate(resolveProductAndVariant);
    const { handle, productId, variantId } = pick || {};
    if (variantId) row.captured_req = 1;

    if (!handle || !variantId) {
      row.error = (row.error ? row.error + ";" : "") + "no_variant_available";
      writeRow(row);
      return await maybeHoldForDebug(page);
    }

    // 3) Navigate to product page
    const origin = (await page.evaluate("location.origin")) as string;
    const productUrl = `${origin}/products/${handle}`;
    console.log(
      `[JOB ${idx}] Product: ${productUrl} (productId=${productId}, variantId=${variantId})`,
    );
    await gotoWithRetry(page, productUrl, `product ${tag}`);

    // 4) Pre-click screenshot (extra vs OLD; harmless + useful)
    await page.screenshot({ path: preClickPath as any, fullPage: false });
    row.pre_click_png = path.relative(OUT_DIR, preClickPath);

    // 5) Find add-to-cart
    const addSel = 'form[action*="/cart/add"] button';
    const addBtn =
      (await page.$(addSel)) ||
      (await page
        .waitForSelector(addSel, { timeout: 8_000 })
        .catch(() => null));
    row.add_btn_found = addBtn ? 1 : 0;
    if (!addBtn) {
      row.error = (row.error ? row.error + ";" : "") + "no_add_button";
      writeRow(row);
      return await maybeHoldForDebug(page);
    }

    // 6) Reset CLS, click, settle, screenshot (this matches OLD timing for cls_after_click)
    await page.evaluate(() => window.__clsReset && window.__clsReset());
    await addBtn.click({ delay: 30 });
    await new Promise((r) => setTimeout(r, 5_000));
    row.clicked_ok = 1;

    await page.screenshot({ path: postClickPath as any, fullPage: false });
    row.post_click_png = path.relative(OUT_DIR, postClickPath);
    row.cls_after_click = (await page.evaluate("window.__CLS || 0")) as number;

    // 7) Base diff: pre_click vs post_click
    try {
      const base = await diffPng(preClickPath, postClickPath, baseDiffPath);
      row.base_diff_png = path.relative(OUT_DIR, baseDiffPath);
      row.base_change_pct = Number(base.pct.toFixed(4));
      if (base.pixels === 0) {
        row.skipped_no_change = 1;
        row.result = "NO-PASS";
        row.error = (row.error ? row.error + ";" : "") + "base_no_change";
        writeRow(row);
        return await maybeHoldForDebug(page);
      }
    } catch (e: any) {
      row.error =
        (row.error ? row.error + ";" : "") +
        `base_diff_failed:${e?.message || e}`;
    }

    // 8) Disable cache + clear storage, reload product
    try {
      await (page as any).setCacheEnabled?.(false);
    } catch {}
    await clearSiteData(page, productUrl);
    await page.setBypassCSP(true);
await gotoWithRetry(page, productUrl, `product reload ${tag}`);

    // 10) using the variant id call add.js, then run CLS start
    await page.evaluate(() => window.__clsReset && window.__clsReset());
    let manualOk = false;
    if (variantId) {
      manualOk = await page.evaluate(async (vid: number | string) => {
        try {
          const r = await fetch("/cart/add.js", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ id: vid, quantity: 1 }),
          });
          return r.ok;
        } catch {
          return false;
        }
      }, variantId);
    }
    row.manual_add_ok = manualOk ? 1 : 0;
    await waitForSettle(page, 2_000);
    // 11) run refresh cart, wait a little
    await page.addScriptTag({ content: refreshBundleCode }); // works with CSP bypass. :contentReference[oaicite:6]{index=6}
    const refreshed = await page.evaluate(async (variantId: string | number | null) => {
      const g: any = window as any;
      try {
        if (typeof g.refreshCart === "function") {
          await g.refreshCart(variantId);
          return true;
        }
        if (g.RC && typeof g.RC.refreshCart === "function") {
          await g.RC.refreshCart(variantId);
          return true;
        }
      } catch(e) {
          console.error(e)
      }
      return false;
    }, variantId);
    row.refresh_ok = refreshed ? 1 : 0;

    await new Promise((r) => setTimeout(r, 5_000));

    // 11) Post-refresh screenshot + CLS
    await page.screenshot({ path: postRefreshPath as any, fullPage: false });
    row.post_refresh_png = path.relative(OUT_DIR, postRefreshPath);
    row.cls_after_manual = (await page.evaluate("window.__CLS || 0")) as number;

    // 12) Refresh diff: post_click vs post_refresh
    try {
      const diff = await diffPng(
        postClickPath,
        postRefreshPath,
        refreshDiffPath,
      );
      row.refresh_diff_png = path.relative(OUT_DIR, refreshDiffPath);
      row.refresh_change_pct = Number(diff.pct.toFixed(4));
      if (diff.pixels > 0) {
        row.result = "NO-PASS";
        row.error =
          (row.error ? row.error + ";" : "") + "refresh_nonzero_change";
      } else {
        row.result = "PASS";
      }
    } catch (e: any) {
      row.error =
        (row.error ? row.error + ";" : "") +
        `refresh_diff_failed:${e?.message || e}`;
    }

    writeRow(row);
  } catch (err: any) {
    console.error(`[JOB ${idx}]`, err);
    row.error =
      (row.error ? row.error + ";" : "") + String(err?.message || err);
    writeRow(row);
  } finally {
    if (!DEBUG_MODE) {
      try {
        await page?.close();
      } catch {}
      try {
        await context.close();
      } catch {}
    } else if (HOLD_DEBUG_SLOT) {
      await maybeHoldForDebug(page);
      try {
        await context.close();
      } catch {}
    }
  }
}

// ---- main (sequential) ----
(async () => {
  console.log("Compiling refreshCart.ts...");
  const refreshBundle = await compileRefreshCartBundle();

  console.log(
    `Launching Chromium (${DEBUG_MODE ? "headed debug" : "headless"})...`,
  );
  const browser = await puppeteer.launch({
    headless: !DEBUG_MODE,
    devtools: DEBUG_MODE,
    defaultViewport: null,
    protocolTimeout: 0,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--start-maximized",
    ],
  });
  console.log("Reading CSV:", INPUT_CSV);

  // ---- Sort rows by priority: Free themes first, then reviews_total desc ----
  const records: any[] = [];
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(INPUT_CSV)
      .pipe(csv())
      .on("data", (r) => records.push(r))
      .on("end", () => resolve())
      .on("error", reject);
  });

  // normalize fields
  records.forEach((r) => {
    r.reviews_total = Number(r.reviews_total || 0);
    r.price_text = String(r.price_text || "").trim();
  });

  // sort: Free first, then reviews desc
  records.sort((a, b) => {
    const aFree = a.price_text.toLowerCase().includes("free") ? 1 : 0;
    const bFree = b.price_text.toLowerCase().includes("free") ? 1 : 0;
    if (aFree !== bFree) return bFree - aFree; // Free first
    return (b.reviews_total || 0) - (a.reviews_total || 0);
  });

  // Build worklist (preserves sorting, filters by ONLY_THEME if provided)
const work = records.filter((rec) => {
  const name = (rec.name || (rec as any).theme || "").toLowerCase();
  // --- FIX mode: only rerun rows that had the target error ---
  if (FIX_ERROR) {
    if (!retryNames || retryNames.size === 0) return false;

    // must have been in results.csv with that error
    if (!retryNames.has(name)) return false;

    // still allow narrowing with ONLY_THEME if provided
    if (ONLY_THEME && !name.includes(ONLY_THEME)) return false;

    // RESUME_MODE is ignored in fix-mode: we want to rerun even if completed before
    return true;
  }
  if (!ONLY_THEME && !RESUME_MODE) return true;

  if (ONLY_THEME && !name.includes(ONLY_THEME)) return false;

  return !(RESUME_MODE && completedNames.has(name));


});

  TOTAL = work.length;
  console.log(`Total themes to process: ${TOTAL}`);
  printProgress();
  // Run with bounded concurrency
  await runPool(work, CONCURRENCY, async (rec, idx) => {
    ACTIVE++;
    console.log(`[POOL] start active=${ACTIVE}/${CONCURRENCY} idx=${idx}`);
    try {
      await runOne(browser, refreshBundle, rec, idx);
    } finally {
      ACTIVE--;
      COMPLETED++;
      printProgress();
      console.log(`[POOL] done  active=${ACTIVE}/${CONCURRENCY} idx=${idx}`);
    }
    (global as any).gc?.();
  });

  process.stdout.write("\n");

  // Ensure all rows are flushed before compaction
  await new Promise<void>((resolve) => outStream.end(() => resolve()));

  // Deduplicate results by theme name: keep last occurrence
  try {
    compactResultsCsv();
  } catch (e) {
    console.warn("[compactResultsCsv] failed:", e);
  }

  if (!DEBUG_MODE) await browser.close();
  console.log(
    `Done. processed=${work.length}, concurrency=${CONCURRENCY}` +
      (DEBUG_MODE ? " (browser left open for debugging)" : ""),
  );
})();
