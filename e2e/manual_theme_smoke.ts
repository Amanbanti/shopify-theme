import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import type { Page, ScreenshotOptions } from "puppeteer";
import { build } from "esbuild";
import { fileURLToPath } from "url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PIXEL_THRESHOLD = Number(process.env.SMOKE_THRESHOLD || 5); // percent

async function compileRefreshBundle(): Promise<string> {
  const refreshPath = path.resolve(__dirname, "refreshCart.ts");
  const res = await build({
    entryPoints: [refreshPath],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "RC",
    write: false,
    target: ["es2019"],
    loader: { ".ts": "ts" },
  });
  const file = res.outputFiles?.[0];
  if (!file) throw new Error("Failed to compile refreshCart.ts");
  return file.text;
}

function sanitizeName(n: string) {
  return String(n || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80);
}

async function diffPng(
  beforePath: string,
  afterPath: string,
  outPath: string,
): Promise<{ pct: number; pixels: number; width: number; height: number }> {
  const a = PNG.sync.read(fs.readFileSync(beforePath));
  const b = PNG.sync.read(fs.readFileSync(afterPath));
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);

  const crop = (src: PNG): PNG => {
    if (src.width === width && src.height === height) return src;
    const out = new PNG({ width, height });
    PNG.bitblt(src, out, 0, 0, width, height, 0, 0);
    return out;
  };
  const imgA = crop(a);
  const imgB = crop(b);
  const diff = new PNG({ width, height });
  const n = pixelmatch(imgA.data, imgB.data, diff.data, width, height, { threshold: 0.1 });
  fs.writeFileSync(outPath, PNG.sync.write(diff));
  const pct = (n / (width * height)) * 100;
  return { pct, pixels: n, width, height };
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Preload CLS measurement inside page
function preloadCLS() {
  try {
    (window as any).__CLS = 0;
    (window as any).__clsReset = () => ((window as any).__CLS = 0);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // @ts-ignore
        if (!e.hadRecentInput) (window as any).__CLS += (e as any).value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
}

async function gotoWithRetry(page: Page, url: string, label: string, maxAttempts = 4) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      const status = resp?.status();
      if (status === 429 && attempt < maxAttempts) {
        const delay = Math.min(60_000, Math.pow(2, attempt) * 1000 + Math.random() * 1000);
        console.warn(`[smoke] 429 ${label} attempt ${attempt}/${maxAttempts}, sleep ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt >= maxAttempts) throw e;
      const delay = Math.min(60_000, Math.pow(2, attempt) * 500 + Math.random() * 250);
      console.warn(`[smoke] goto err ${label} attempt ${attempt}/${maxAttempts}, sleep ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw lastErr || new Error(`gotoWithRetry exhausted for ${label}`);
}

async function disableAnimations(page: Page) {
  try {
    await page.addStyleTag({
      content: `
        *, *::before, *::after { transition: none !important; animation: none !important; }
        [class*="skeleton"], [class*="shimmer"], .loading, .placeholder { animation: none !important; }
      `,
    });
  } catch {}
}

type CartDomState = {
  cartCountText: string;
  bubbleText: string;
  drawerVisible: boolean;
  drawerExists: boolean;
  miniCartExists: boolean;
  notificationVisible: boolean;
  cartButtonAria: string;
};

async function captureCartDOMState(page: Page): Promise<CartDomState> {
  return await page.evaluate(() => {
    const getText = (sel: string) => (document.querySelector(sel)?.textContent || "").trim();
    const anyVisible = (sels: string[]) => sels.some((s) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const vis = style.visibility !== "hidden" && style.display !== "none" && el.offsetParent !== null;
      return vis || el.hasAttribute("open") || el.classList.contains("is-open") || el.classList.contains("open");
    });

    const drawerSelectors = ["#CartDrawer", "cart-drawer", "#slideout-ajax-cart", ".cart-drawer", "cart-notification-drawer"];
    const notificationSelectors = ["cart-notification", "#CartNotification", ".cart-notification", "cart-notification-drawer"];
    const miniCartSelectors = [".mini-cart", "[data-mini-cart]", "#slideout-ajax-cart"];

    const countText = [
      getText("[data-cart-count]"),
      getText(".cart-count"),
      getText("#CartCount"),
      getText("cart-count"),
    ].filter(Boolean).join("|");

    const bubble = [getText("#cart-icon-bubble"), getText(".cart-count-bubble")].filter(Boolean).join("|");

    const ariaCart = (document.querySelector('[aria-label="Cart"]')?.getAttribute("aria-label") || "").trim();

    return {
      cartCountText: countText,
      bubbleText: bubble,
      drawerVisible: anyVisible(drawerSelectors),
      drawerExists: drawerSelectors.some((s) => !!document.querySelector(s)),
      miniCartExists: miniCartSelectors.some((s) => !!document.querySelector(s)),
      notificationVisible: anyVisible(notificationSelectors),
      cartButtonAria: ariaCart,
    } as any;
  });
}

function compareCartState(a: CartDomState, b: CartDomState): { changed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (a.cartCountText !== b.cartCountText) reasons.push("cart-count changed");
  if (a.bubbleText !== b.bubbleText) reasons.push("cart-bubble changed");
  if (!a.drawerVisible && b.drawerVisible) reasons.push("drawer became visible");
  if (!a.notificationVisible && b.notificationVisible) reasons.push("notification became visible");
  if (!a.miniCartExists && b.miniCartExists) reasons.push("mini-cart appeared");
  return { changed: reasons.length > 0, reasons };
}

async function getCartClip(page: Page): Promise<ScreenshotOptions["clip"] | undefined> {
  const selectors = [
    "header",
    "#CartDrawer",
    "cart-drawer",
    "#cart-icon-bubble",
    ".cart-count-bubble",
    "[data-cart-count]",
    ".cart-count",
    ".mini-cart",
    "cart-notification",
  ];
  try {
    const boxes = await page.evaluate((sels: string[]) => {
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      for (const s of sels) {
        document.querySelectorAll<HTMLElement>(s).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width && r.height) rects.push({ x: r.x, y: r.y, w: r.width, h: r.height });
        });
      }
      if (!rects.length) return null;
      const x1 = Math.max(0, Math.min(...rects.map((r) => r.x)) - 8);
      const y1 = Math.max(0, Math.min(...rects.map((r) => r.y)) - 8);
      const x2 = Math.max(...rects.map((r) => r.x + r.w)) + 8;
      const y2 = Math.max(...rects.map((r) => r.y + r.h)) + 8;
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }, selectors);
    if (boxes && boxes.width > 0 && boxes.height > 0) return boxes as any;
  } catch {}
  return undefined;
}

async function captureCartScreenshot(page: Page, filePath: string) {
  await disableAnimations(page);
  const clip = await getCartClip(page);
  if (clip) {
    await page.screenshot({ path: filePath as any, clip, captureBeyondViewport: false });
  } else {
    await page.screenshot({ path: filePath as any, fullPage: false });
  }
}

async function waitForNetworkIdle(page: Page, timeout = 10_000) {
  const anyWait = (page as any).waitForNetworkIdle?.bind(page);
  if (anyWait) {
    try { await anyWait({ idleTime: 800, timeout }); return; } catch {}
  }
  await new Promise((r) => setTimeout(r, 1200));
}

// ----- Themes list -----
// Replace these product URLs with actual products from each theme demo store
const themes = [
  { name: "Dawn", url: "https://theme-dawn-demo.myshopify.com/products/bo-ivy-black", refreshFn: "refreshCartDawn" },
  { name: "Nest", url: "https://mrparkerdemo.myshopify.com/collections/bed-bath/products/unikko-f-q-duvet-set", refreshFn: "refreshCartNest" },
  { name: "Balance", url: "https://impact-theme-shape.myshopify.com/products/infinity-bra-navy-blue", refreshFn: "refreshCartBalance" },
  { name: "Pillar", url: "https://hyper-pillar.myshopify.com/products/breezy-sock", refreshFn: "refreshCartPillar" },
  { name: "Flora", url: "https://grid-theme-light.myshopify.com/collections/clearance/products/finn-jumpsuit-poppy?variant=32029844832330", refreshFn: "refreshCartFlora" },
  { name: "Jellybean", url: "https://uplift-theme-myshopify.com/products/beanie-lion", refreshFn: "refreshCartJellybean" },
];

(async () => {
  const outRoot = path.join(__dirname, "out");
  fs.mkdirSync(outRoot, { recursive: true });
  const resultsCsv = path.join(outRoot, "results_smoke.csv");
  if (!fs.existsSync(resultsCsv)) {
    fs.writeFileSync(
      resultsCsv,
      [
        "name",
        "schema_name",
        "url",
        "base_diff_pct",
        "refresh_diff_pct",
        "cls_after_click",
        "cls_after_manual",
        "status",
        "error",
        "pre_click_png",
        "post_click_png",
        "post_refresh_png",
        "base_diff_png",
        "refresh_diff_png",
      ].join(",") + "\n",
      "utf8",
    );
  }

  const refreshBundle = await compileRefreshBundle();

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  await page.evaluateOnNewDocument(preloadCLS);
  page.setDefaultNavigationTimeout(90_000);

  // auto-dismiss alert dialogs (some themes use alert())
  page.on("dialog", async (d) => {
    try { await d.dismiss(); } catch {}
  });

  for (const theme of themes) {
    const tag = sanitizeName(theme.name);
    const folder = path.join(outRoot, tag);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    let schemaName = "";
    let basePct = NaN;
    let refreshPct = NaN;
    let status = "";
    let errMsg = "";
    let clsAfterClick: number | string = "";
    let clsAfterManual: number | string = "";

    const preClickPng = path.join(folder, "pre_click.png");
    const postClickPng = path.join(folder, "post_click.png");
    const postRefreshPng = path.join(folder, "post_refresh.png");
    const baseDiffPng = path.join(folder, "base_diff.png");
    const refreshDiffPng = path.join(folder, "refresh_diff.png");

    try {
      console.log(`\n=== Testing theme: ${theme.name} ===`);
      await gotoWithRetry(page, theme.url, theme.name);

      // capture schema name & baseline DOM state
      schemaName = (await page.evaluate(() => (window as any).Shopify?.theme?.schema_name || (window as any).Shopify?.theme?.name || "")) as string;
      const domBeforeClick = await captureCartDOMState(page);

      // Pre-click screenshot
      await captureCartScreenshot(page, preClickPng);

      // Click Add to Cart (best-effort)
      try {
        await page.evaluate(() => (window as any).__clsReset?.());
        const sel1 = 'button[name="add"]';
        const hadSel1 = !!(await page.$(sel1));
        if (hadSel1) {
          await page.click(sel1);
        } else {
          const sel2 = 'form[action*="/cart/add"] button, form[action*="/cart/add"] [type="submit"]';
          await page.click(sel2);
        }
        await new Promise((r) => setTimeout(r, 1200));
      } catch (err) {
        console.log("Add to Cart button not found/click failed:", err);
      }

      // Post-click screenshot + CLS
      await captureCartScreenshot(page, postClickPng);
      clsAfterClick = (await page.evaluate("window.__CLS || 0")) as number;

      // Base diff (pre vs post click)
      try {
        const base = await diffPng(preClickPng, postClickPng, baseDiffPng);
        basePct = Number(base.pct.toFixed(4));
      } catch (e: any) {
        errMsg = (errMsg ? errMsg + ";" : "") + `base_diff_failed:${e?.message || e}`;
      }

      // Extract variant ID (URL ?variant= fallback → form input)
      const variantId = await page.evaluate(() => {
        const urlVar = new URLSearchParams(location.search).get("variant");
        if (urlVar) return urlVar;
        const input = document.querySelector('form[action*="/cart/add"] input[name="id"]') as HTMLInputElement | null;
        return input?.value || null;
      });

      // Manual /cart/add.js + refresh
      if (variantId) {
        await page.evaluate(async (id) => {
          try {
            const fd = new FormData();
            fd.append("id", id as string);
            fd.append("quantity", "1");
            await fetch("/cart/add.js", { method: "POST", body: fd, credentials: "same-origin" });
          } catch (e) {
            console.error("/cart/add.js failed", e);
          }
        }, variantId);

        // baseline DOM before refresh
        const domBeforeRefresh = await captureCartDOMState(page);

        // Inject refreshCart bundle and call refresh (retry on context destroyed + fallback theme key)
        let invoked = false;
        let invokeError = "";
        for (let attempt = 0; attempt < 2 && !invoked; attempt++) {
          try {
            await page.addScriptTag({ content: refreshBundle });
            invoked = await page.evaluate(async (fnName) => {
              const g: any = window as any;
              const schema = (g.Shopify?.theme?.schema_name || g.Shopify?.theme?.name || "").toLowerCase().trim();
              const key = (schema || "").replace(/[^a-z0-9]+/g, "");
              try {
                if (g.refreshCart && typeof g.refreshCart === "object" && key && typeof g.refreshCart[key] === "function") {
                  await g.refreshCart[key]();
                  return true;
                }
                if (typeof (g as any)[fnName] === "function") {
                  await (g as any)[fnName]();
                  return true;
                }
                if (g.RC && typeof g.RC.refreshCart === "function") {
                  await g.RC.refreshCart(key);
                  return true;
                }
                if (typeof g.refreshCart === "function") {
                  await g.refreshCart(key);
                  return true;
                }
              } catch (e) {
                console.error("refresh invocation failed", e);
              }
              return false;
            }, theme.refreshFn);
          } catch (e: any) {
            const msg = String(e?.message || e || "");
            invokeError = msg;
            if (msg.includes("Execution context was destroyed") || msg.includes("Target closed")) {
              try { await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }); } catch {}
              continue;
            }
            break;
          }
        }

        // wait for network idle and a small settle
        await waitForNetworkIdle(page, 10_000);
        await new Promise((r) => setTimeout(r, 600));

        // Post-refresh screenshot + CLS
        await captureCartScreenshot(page, postRefreshPng);
        clsAfterManual = (await page.evaluate("window.__CLS || 0")) as number;

        // Refresh diff (post_click vs post_refresh)
        try {
          const r = await diffPng(postClickPng, postRefreshPng, refreshDiffPng);
          refreshPct = Number(r.pct.toFixed(4));
        } catch (e: any) {
          errMsg = (errMsg ? errMsg + ";" : "") + `refresh_diff_failed:${e?.message || e}`;
        }

        const domAfterRefresh = await captureCartDOMState(page);
        const domDelta = compareCartState(domBeforeRefresh, domAfterRefresh);

        // Decision (improved)
        const passByDom = domDelta.changed;
        const passByPixels = Number.isFinite(refreshPct) && refreshPct > PIXEL_THRESHOLD;

        if (passByDom || passByPixels) {
          status = "PASS";
          const reason = [
            passByDom ? `DOM: ${domDelta.reasons.join("; ")}` : "",
            passByPixels ? `PIXELS>${PIXEL_THRESHOLD}% (${refreshPct}%)` : "",
          ].filter(Boolean).join(" | ");
          console.log(`[${theme.name}] PASS reason → ${reason}`);
        } else {
          status = "NO-PASS";
          const reason = [
            `PIXELS=${Number.isFinite(refreshPct) ? refreshPct + "%" : "n/a"} ≤ ${PIXEL_THRESHOLD}%`,
            domDelta.reasons.length ? `DOM(no decisive change)` : "DOM(no change)",
            invokeError ? `invoke:${invokeError}` : "",
          ].filter(Boolean).join(" | ");
          errMsg = (errMsg ? errMsg + ";" : "") + reason;
        }
      } else {
        status = "NO-PASS";
        errMsg = (errMsg ? errMsg + ";" : "") + "no_variant_available";
      }

      // If base diff is 0, note it (but we keep PASS if DOM says success)
      if (Number.isFinite(basePct) && basePct === 0 && status !== "PASS") {
        errMsg = (errMsg ? errMsg + ";" : "") + "base_no_change";
      }
    } catch (e: any) {
      status = "ERROR";
      errMsg = (errMsg ? errMsg + ";" : "") + String(e?.message || e);
    }

    // Append CSV row
    const row = [
      theme.name,
      schemaName,
      theme.url,
      Number.isFinite(basePct) ? basePct.toFixed(4) : "",
      Number.isFinite(refreshPct) ? refreshPct.toFixed(4) : "",
      clsAfterClick,
      clsAfterManual,
      status,
      errMsg,
      preClickPng,
      postClickPng,
      postRefreshPng,
      baseDiffPng,
      refreshDiffPng,
    ].map(csvEscape).join(",") + "\n";

    fs.appendFileSync(resultsCsv, row, "utf8");

    console.log(
      `Result: ${status} | base=${Number.isFinite(basePct) ? basePct.toFixed(2) + '%' : 'n/a'} | refresh=${Number.isFinite(refreshPct) ? refreshPct.toFixed(2) + '%' : 'n/a'} | schema=${schemaName}`,
    );
  }

  await browser.close();
  console.log("\n=== Smoke run complete. See e2e/out/results_smoke.csv ===");
})();
