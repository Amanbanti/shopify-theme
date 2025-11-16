import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { build } from "esbuild";
import { fileURLToPath } from "url";

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ----- Themes list -----
const themes = [
  { name: "Dawn", url: "https://theme-dawn-demo.myshopify.com/products/bo-ivy-black", refreshFn: "refreshCartDawn" },
  { name: "Nest", url: "https://mrparkerdemo.myshopify.com/collections/bed-bath/products/unikko-f-q-duvet-set", refreshFn: "refreshCartNest" },
  { name: "Balance", url: "https://impact-theme-shape.myshopify.com/products/infinity-bra-navy-blue", refreshFn: "refreshCartBalance" },
  { name: "Pillar", url: "https://hyper-pillar.myshopify.com/products/breezy-sock", refreshFn: "refreshCartPillar" },
  { name: "Flora", url: "https://grid-theme-light.myshopify.com/collections/clearance/products/finn-jumpsuit-poppy?variant=32029844832330", refreshFn: "refreshCartFlora" },
  { name: "Jellybean", url: "https://grid-theme-light.myshopify.com/products/box-tee-black-stripe?pr_prod_strat=collection_fallback&pr_rec_id=dfae0ed0b&pr_rec_pid=4576951566410&pr_ref_pid=4572503048266&pr_seq=uniform&variant=32029115023434", refreshFn: "refreshCartJellybean" },
];


(async () => {
  const outRoot = path.join(__dirname, "out");
  fs.mkdirSync(outRoot, { recursive: true });

  const refreshBundle = await compileRefreshBundle();

  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  for (const theme of themes) {
    const folder = path.join(outRoot, theme.name.toLowerCase());
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

    console.log(`\n=== Testing theme: ${theme.name} ===`);

    // Navigate with 120s timeout
    try {
      await page.goto(theme.url, { waitUntil: "networkidle2", timeout: 180000 });
    } catch (err) {
      console.log(`Failed to load ${theme.name}:`, err);
      continue; // skip to next theme if navigation fails
    }

    // Pre-click screenshot
    await page.screenshot({ path: path.join(folder, "pre_click.png") as `${string}.png` });
    console.log("Pre-click screenshot taken");

    // Click Add to Cart (best-effort)
    try {
      const sel1 = 'button[name="add"]';
      if (await page.$(sel1)) {
        await page.click(sel1);
      } else {
        const sel2 = 'form[action*="/cart/add"] button, form[action*="/cart/add"] [type="submit"]';
        await page.click(sel2);
      }
      await new Promise((r) => setTimeout(r, 1200));
      console.log("Add to Cart clicked (UI flow)");
    } catch (err) {
      console.log("Add to Cart button not found/click failed:", err);
    }

    // Post-click screenshot
    await page.screenshot({ path: path.join(folder, "post_click.png") as `${string}.png` });
    console.log("Post-click screenshot taken");

    // Extract variant ID
    const variantId = await page.evaluate(() => {
      const input = document.querySelector('form[action*="/cart/add"] input[name="id"]') as HTMLInputElement | null;
      return input?.value || null;
    });

    if (variantId) {
      // Manual /cart/add.js
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

      // Inject refreshCart bundle once per page load
      await page.addScriptTag({ content: refreshBundle });

      // Call theme-specific refresh if available; else fall back
      await page.evaluate(async (fnName, vid) => {
        const g: any = window as any;
        try {
          if (typeof (g as any)[fnName] === "function") {
            await (g as any)[fnName]();
            return;
          }
          if (g.RC && typeof g.RC.refreshCart === "function") {
            await g.RC.refreshCart(vid);
            return;
          }
          if (typeof g.refreshCart === "function") {
            await g.refreshCart(vid);
            return;
          }
        } catch (e) {
          console.error("refresh invocation failed", e);
        }
      }, theme.refreshFn, variantId);

      await new Promise((resolve) => setTimeout(resolve, 600));

      // Post-refresh screenshot
      await page.screenshot({ path: path.join(folder, "post_refresh.png") as `${string}.png` });
      console.log("Post-refresh screenshot taken");
    } else {
      console.log("Variant ID not found, skipping manual add + refresh");
    }
  }

  await browser.close();
  console.log("\n=== All themes tested, screenshots saved in e2e/out/ ===");
})();
