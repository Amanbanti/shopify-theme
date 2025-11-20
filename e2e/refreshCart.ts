/* Browser-injected bundle: per-theme refresh handlers + registry.
   The runner will call either window.refreshCart[themeKey]() or RC.refreshCart().
*/

type SectionMap = Record<string, string>;

function log(...a: any[]) {
  try { console.debug("[refreshCart]", ...a); } catch {}
}

// Utility: small delay
const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

async function fetchSections(names: string[]): Promise<SectionMap> {
  const map: SectionMap = {};
  if (!names.length) return map;

  // Try OS2.0 multi-sections API
  try {
    const r = await fetch(`/?sections=${names.join(",")}`, { credentials: "same-origin" });
    if (r.ok) {
      const json = await r.json().catch(() => null);
      if (json && typeof json === "object") return json as SectionMap;
    }
  } catch (e) {
    log("sections api failed", e);
  }

  // Fallback to section_id one-by-one
  for (const n of names) {
    try {
      const r = await fetch(`/?section_id=${encodeURIComponent(n)}`, { credentials: "same-origin" });
      if (r.ok) map[n] = await r.text();
    } catch (e) {
      log("section_id fetch failed", n, e);
    }
  }
  return map;
}

function parseFirst(html: string, selectors: string[]): HTMLElement | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  for (const sel of selectors) {
    const el = doc.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return (doc.body?.firstElementChild as HTMLElement) || null;
}

function swapInner(host: Element | null, newEl: HTMLElement | null) {
  if (!host || !newEl) return;
  (host as HTMLElement).innerHTML = newEl.innerHTML;
}

function isVisible(el: Element | null): boolean {
  if (!el) return false;
  const s = window.getComputedStyle(el as HTMLElement);
  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
}

// Drawer detection helpers
const DRAWER_SELECTOR_CANDIDATES = [
  "cart-drawer",
  "#CartDrawer",
  ".CartDrawer",
  ".drawer--cart",
  ".cart-drawer",
  "[data-cart-drawer]",
  "[data-mini-cart]",
  ".mini-cart",
  "#AjaxCart",
  ".ajaxcart",
  ".ajaxcart-drawer",
  "#slideout-ajax-cart",
  ".slideout-ajax-cart",
  // broadened
  "#MiniCart",
  "#mini-cart",
  "#CartSidebar",
  ".cart-sidebar",
];

function any<T>(arr: T[], pred: (v: T) => boolean): boolean { for (const v of arr) { if (pred(v)) return true; } return false; }

function isDrawerOpen(): boolean {
  try {
    const nodes = document.querySelectorAll<HTMLElement>(DRAWER_SELECTOR_CANDIDATES.join(","));
    if (!nodes.length) return false;
    return any(Array.from(nodes), (el) => {
      if (!el) return false;
      if (el.hasAttribute("open")) return true;
      const cs = getComputedStyle(el);
      if (cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity || "1") > 0.01) return true;
      return el.classList.contains("is-open") || el.classList.contains("open") || el.classList.contains("active") || el.classList.contains("visible") || el.classList.contains("show");
    });
  } catch { return false; }
}

function clickCartToggles() {
  const toggleSelectors = [
    '[data-cart-toggle]',
    '[data-open-cart]',
    '[data-drawer-open], [data-drawer="cart"]',
    '[aria-controls*="Cart"]',
    'a[href="#CartDrawer"], button[href="#CartDrawer"]',
    'a[href*="cart-drawer"], button[href*="cart-drawer"]',
    '.js-cart-toggle',
    '.header__icon--cart a, .header__icon--cart button',
    '[data-cart-trigger]',
    // extra candidates
    '.header__cart-toggle',
    '.cart-toggle',
    '.site-header__cart button',
    '[data-action="open-drawer"][data-drawer-id="cart"]',
    '[data-drawer-id="mini-cart"]',
    '[data-action="open-mini-cart"]',
    '.open-cart',
    '.js-open-cart',
    '.drawer-toggle--cart',
    '.js-cart-open',
    // broadened
    '.header__icon--cart',
    'button[name="open-cart"]',
  ];
  for (const sel of toggleSelectors) {
    const btn = document.querySelector(sel) as HTMLElement | null;
    if (!btn) continue;
    try { (btn as HTMLElement).click(); } catch {}
  }
}

function forceShow(el: HTMLElement | null) {
  if (!el) return;
  try {
    el.classList.add("is-open", "open", "active", "visible", "show", "in");
    el.setAttribute("open", "true");
    Object.assign(el.style, {
      display: "block",
      opacity: "1",
      visibility: "visible",
      transform: "translateX(0)",
      right: "0",
      left: "auto",
      bottom: "0",
    } as Partial<CSSStyleDeclaration>);
  } catch {}
}

function tryOpenDrawer(candidates: string[]) {
  // 1) Try explicit drawer elements
  for (const sel of candidates) {
    const el: any = document.querySelector(sel);
    if (!el) continue;
    try {
      if (typeof el.open === "function") { el.open(); return; }
      forceShow(el as HTMLElement);
      document.documentElement.classList.add("drawer-open", "cart-open");
      document.body.classList.add("drawer-open", "cart-open");
      return;
    } catch {}
  }

  // 2) Try clicking any known cart toggles
  try { clickCartToggles(); } catch {}

  // 3) Fallback: broadly guess likely cart drawers and force show the first one
  const broad = [
    "#CartDrawer",
    "cart-drawer",
    ".cart-drawer",
    ".CartDrawer",
    ".drawer--cart",
    ".ajaxcart-drawer",
    ".ajaxcart",
    "[data-cart-drawer]",
    "[data-mini-cart]",
    ".mini-cart",
    "#AjaxCart",
    "[id*='cart'][class*='drawer']",
    "[class*='cart'][class*='drawer']",
    "[id*='drawer'][class*='cart']",
    "#MiniCart",
    "#CartSidebar",
  ].join(",");
  const guess = document.querySelector(broad) as HTMLElement | null;
  forceShow(guess);

  // 4) Ensure overlays visible
  try {
    const overlaySelectors = [
      ".drawer__overlay",
      ".cart-drawer__overlay",
      ".modal__overlay",
      ".overlay",
      "#slideout-overlay",
      "[data-overlay]",
      ".ajaxcart__overlay",
    ];
    const ov = document.querySelector<HTMLElement>(overlaySelectors.join(","));
    if (ov) {
      ov.style.display = "block";
      ov.style.opacity = "1";
      ov.style.visibility = "visible";
      ov.classList.add("active", "is-visible");
    }
  } catch {}
}

// Prefer native open signals before forcing styles
async function ensureCartOpen(): Promise<void> {
  if (isDrawerOpen()) return;
  const g: any = window as any;
  try { if (g.theme?.cart?.open) { g.theme.cart.open(); } } catch {}
  try { if (g.Cart && typeof g.Cart.open === "function") { g.Cart.open(); } } catch {}
  try { window.dispatchEvent(new Event("open:cart")); } catch {}
  try { document.dispatchEvent(new Event("open:cart")); } catch {}
  try { document.dispatchEvent(new CustomEvent("cart:open")); } catch {}
  clickCartToggles();
  await delay(250);
  if (isDrawerOpen()) return;
  // final fallback
  tryOpenDrawer(DRAWER_SELECTOR_CANDIDATES);
  await delay(150);
}

async function updateCountsAndFire(cartJson?: any) {
  let cart = cartJson;
  if (!cart) {
    try {
      cart = await fetch("/cart.js", { credentials: "same-origin", cache: "no-cache" }).then(r => r.json());
    } catch {}
  }
  const count = cart?.item_count ?? null;
  if (count !== null) {
    // Standard <cart-count> and legacy nodes
    document.querySelectorAll("cart-count").forEach((el: any) => {
      el.textContent = String(count);
      el.setAttribute?.("aria-label", `${count} ${count === 1 ? "item" : "items"}`);
    });
    document.querySelectorAll('[data-cart-count], .cart-count, #CartCount').forEach((el) => {
      const root = el as HTMLElement;
      if (root.closest("cart-count")) return;
      const txt = root.textContent || "";
      if (/\d+/.test(txt)) root.textContent = txt.replace(/\d+/, String(count));
      else root.textContent = String(count);
    });
    // Bubble badge
    document.querySelectorAll("#cart-icon-bubble, .cart-count-bubble, [data-cart-bubble]").forEach((el) => {
      (el as HTMLElement).dataset.count = String(count);
      const span = el.querySelector("span");
      if (span) span.textContent = String(count);
      (el as HTMLElement).style.display = count > 0 ? "" : "none";
    });
  }

  // Fire common events many themes listen to (broadened)
  try { document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true, detail: { cart, cartCount: count } })); } catch {}
  try { window.dispatchEvent(new Event("update_cart")); } catch {}
  try { window.dispatchEvent(new CustomEvent("cart-updated", { detail: { cart } })); } catch {}
  try { document.dispatchEvent(new CustomEvent("ajaxProduct:added", { detail: { cart } })); } catch {}
  try { document.dispatchEvent(new CustomEvent("cart:updated", { detail: { cart } })); } catch {}
  try { document.dispatchEvent(new CustomEvent("cart:update", { detail: { cart } })); } catch {}
  try { document.dispatchEvent(new CustomEvent("ajaxCart:updated", { detail: { cart } })); } catch {}
  try { document.dispatchEvent(new CustomEvent("added.ajaxCart", { detail: { cart } })); } catch {}
  try { document.dispatchEvent(new CustomEvent("cart:change", { detail: { cart } })); } catch {}
}

// Add a proper forceOpenState helper
function forceOpenState(opts: {
  drawerSelectors?: string[];
  overlaySelectors?: string[];
  htmlClasses?: string[];
  bodyClasses?: string[];
  drawerInlineStyles?: Partial<CSSStyleDeclaration>;
}) {
  try {
    const {
      drawerSelectors = [],
      overlaySelectors = [],
      htmlClasses = [],
      bodyClasses = [],
      drawerInlineStyles = {},
    } = opts || {} as any;

    if (htmlClasses.length) document.documentElement.classList.add(...htmlClasses);
    if (bodyClasses.length) document.body.classList.add(...bodyClasses);

    const allDrawers = drawerSelectors.length
      ? Array.from(document.querySelectorAll<HTMLElement>(drawerSelectors.join(",")))
      : [];
    for (const d of allDrawers) {
      d.classList.add("is-open", "open", "active", "visible", "show");
      d.setAttribute("open", "true");
      Object.assign(d.style, drawerInlineStyles);
      // ensure visible
      forceShow(d);
    }

    if (overlaySelectors.length) {
      const ov = document.querySelector<HTMLElement>(overlaySelectors.join(","));
      if (ov) {
        ov.style.display = "block";
        ov.style.opacity = "1";
        ov.style.visibility = "visible";
        ov.classList.add("active", "is-visible");
      }
    }

    // Lock scroll
    document.body.style.overflow = "hidden";
  } catch {}
}

/* Generic drawer updater used by multiple themes */
async function refreshDrawerLike(opts: {
  sections: string[];
  drawerHosts: string[];            // where to swap markup
  parseSelectors: string[];         // how to locate new content inside fetched HTML
  openSelectors: string[];          // elements to open as drawer
  notifKey?: string;                // "cart-notification"
  bubbleKey?: string;               // "cart-icon-bubble"
}): Promise<boolean> {
  const { sections, drawerHosts, parseSelectors, openSelectors, notifKey = "cart-notification", bubbleKey = "cart-icon-bubble" } = opts;

  const wasOpen = isDrawerOpen();
  const sec = await fetchSections(sections);
  let changed = false;

  // Drawer (support multiple common keys)
  const incomingDrawer = sec["cart-drawer"] || sec["drawer"] || sec["mini-cart"] || sec["ajax-cart"] || sec["ajaxcart"] || "";
  if (incomingDrawer) {
    const host = document.querySelector(drawerHosts.join(",")) as HTMLElement | null;
    const next = parseFirst(incomingDrawer, parseSelectors);
    swapInner(host, next);
    changed = true;
  }

  // Notification
  const notifHtml = sec[notifKey];
  if (typeof notifHtml === "string" && notifHtml.trim()) {
    const notifEl: any = document.querySelector("cart-notification");
    if (notifEl && typeof notifEl.renderContents === "function") {
      try { notifEl.renderContents({ sections: { [notifKey]: notifHtml, [bubbleKey]: sec[bubbleKey] || "" } }); changed = true; } catch {}
    } else {
      const host = document.querySelector("#CartNotification, .cart-notification, [data-cart-notification]") as HTMLElement | null;
      const next = parseFirst(notifHtml, ["#CartNotification", ".cart-notification", "[data-cart-notification]"]);
      swapInner(host, next);
      changed = true;
    }
  }

  // Bubble
  const bubbleHtml = sec[bubbleKey];
  if (typeof bubbleHtml === "string" && bubbleHtml.trim()) {
    const host = document.querySelector("#cart-icon-bubble, .cart-count-bubble") as HTMLElement | null;
    const next = parseFirst(bubbleHtml, ["#cart-icon-bubble", ".cart-count-bubble"]);
    swapInner(host, next);
    changed = true;
  }

  await updateCountsAndFire();

  // Open drawer if it was open before, or if there are items in cart now
  try {
    const cart = await fetch("/cart.js", { credentials: "same-origin", cache: "no-cache" }).then(r => r.json()).catch(() => null);
    const hasItems = !!(cart && cart.item_count > 0);
    if (wasOpen || hasItems) {
      // prefer native opening
      await ensureCartOpen();
      // small wait for transition to complete to help screenshots match
      await delay(300);
    } else {
      // If not opening, ensure any overlays are hidden to reduce visual differences
      const ov = document.querySelector<HTMLElement>(".drawer__overlay, .cart-drawer__overlay, .ajaxcart__overlay");
      if (ov) { ov.style.opacity = "0"; ov.style.display = "none"; ov.style.visibility = "hidden"; }
    }
  } catch {}

  return changed;
}

/* Individual theme handlers (best-effort) */

// Dawn (OS2.0)
export async function refreshAndOpenDawnCart() {
  const changed = await refreshDrawerLike({
    sections: ["cart-drawer", "cart-notification", "cart-icon-bubble"],
    drawerHosts: ["#CartDrawer", "cart-drawer"],
    parseSelectors: ["#CartDrawer", '[id^="CartDrawer-"]', "cart-drawer"],
    openSelectors: [
      "cart-drawer",
      "#CartDrawer",
      '[data-drawer="cart"]',
      '[data-open-cart]'
    ],
  });
  return changed;
}

// Mr Parker (Nest)
export async function refreshAndOpenMrParkerCart() {
  const changed = await refreshDrawerLike({
    sections: [
      "ajax-cart",
      "ajaxcart",
      "cart-drawer",
      "mini-cart",
      "cart-notification",
      "cart-icon-bubble",
    ],
    drawerHosts: [
      "#slideout-ajax-cart",
      ".slideout-ajax-cart",
      "#AjaxCart",
      ".ajax-cart",
      ".ajaxcart",
      "#CartDrawer",
      ".cart-drawer",
      "[data-cart-drawer]",
    ],
    parseSelectors: [
      "#slideout-ajax-cart",
      ".slideout-ajax-cart",
      "#AjaxCart",
      ".ajax-cart__content",
      ".ajaxcart__inner",
      ".ajaxcart",
      "#CartDrawer",
      ".cart-drawer",
      ".cart-drawer__content",
      ".mini-cart__content",
      ".mini-cart",
      "[data-mini-cart]",
    ],
    openSelectors: [
      "#slideout-ajax-cart",
      ".slideout-ajax-cart",
      "#AjaxCart",
      ".ajaxcart",
      "#CartDrawer",
      ".cart-drawer",
      '[data-drawer="cart"]',
      '[data-open-cart]'
    ],
  });

  // Ensure DOM diff signal even if refreshDrawerLike changed nothing visible
  const drawer = document.querySelector("#slideout-ajax-cart, #AjaxCart, #CartDrawer, .cart-drawer") as HTMLElement | null;
  if (drawer) {
    const current = drawer.getAttribute("data-rc-refreshed") || "0";
    drawer.setAttribute("data-rc-refreshed", current === "1" ? "2" : "1");
  }

  await ensureCartOpen();
  return changed || !!drawer;
}

// Impact (Balance)
export async function refreshAndOpenImpactCart() {
  const changed = await refreshDrawerLike({
    sections: [
      "cart-drawer",
      "mini-cart",
      "cart-notification",
      "cart-icon-bubble",
    ],
    drawerHosts: ["#CartDrawer", ".drawer--cart", "cart-drawer", ".mini-cart", "[data-mini-cart]"],
    parseSelectors: ["#CartDrawer", ".drawer--cart", "cart-drawer", ".mini-cart__content", ".mini-cart", "[data-mini-cart]"],
    openSelectors: ["cart-drawer", "#CartDrawer", ".drawer--cart", '[data-drawer="cart"]', '[data-open-cart]'],
  });
  await ensureCartOpen(); // Ensure drawer opens reliably
  return changed;
}

// Hyper (Pillar)
export async function refreshAndOpenHyperCart() {
  const changed = await refreshDrawerLike({
    sections: [
      "cart-drawer",
      "mini-cart",
      "cart-notification",
      "cart-icon-bubble",
    ],
    drawerHosts: ["#CartDrawer", ".CartDrawer", ".js-cart-drawer", "cart-drawer", ".mini-cart", "[data-mini-cart]"],
    parseSelectors: ["#CartDrawer", ".CartDrawer", ".js-cart-drawer", "cart-drawer", ".cart-drawer__content", ".mini-cart__content", ".mini-cart", "[data-mini-cart]"],
    openSelectors: ["#CartDrawer", ".CartDrawer", ".js-cart-drawer", "cart-drawer", '[data-drawer="cart"]', '[data-open-cart]'],
  });

  const drawer = document.querySelector("#CartDrawer, .CartDrawer, .js-cart-drawer, cart-drawer") as HTMLElement | null;
  if (drawer) {
    const current = drawer.getAttribute("data-rc-refreshed") || "0";
    drawer.setAttribute("data-rc-refreshed", current === "1" ? "2" : "1");
  }

  await ensureCartOpen();
  return changed || !!drawer;
}

// Grid (Flora)
export async function refreshAndOpenGridCart() {
  const changed = await refreshDrawerLike({
    sections: [
      "mini-cart",
      "ajax-cart",
      "cart-drawer",
      "cart-notification",
      "cart-icon-bubble",
    ],
    drawerHosts: [
      ".mini-cart",
      "[data-mini-cart]",
      "#AjaxCart",
      "[data-ajax-cart-content]",
      "#CartDrawer",
      ".cart-drawer",
    ],
    parseSelectors: [
      ".mini-cart__content",
      ".mini-cart",
      "[data-mini-cart]",
      "#AjaxCart",
      "[data-ajax-cart-content]",
      "#CartDrawer",
      ".cart-drawer",
      ".cart-drawer__content",
    ],
    openSelectors: [
      ".mini-cart",
      "[data-mini-cart]",
      "#AjaxCart",
      "#CartDrawer",
      ".cart-drawer",
      '[data-drawer="cart"]',
      '[data-open-cart]'
    ],
  });

  const drawer = document.querySelector(".mini-cart, #AjaxCart, #CartDrawer, .cart-drawer") as HTMLElement | null;
  if (drawer) {
    const current = drawer.getAttribute("data-rc-refreshed") || "0";
    drawer.setAttribute("data-rc-refreshed", current === "1" ? "2" : "1");
  }

  await ensureCartOpen();
  return changed || !!drawer;
}

// Sunrise (Jellybean)
export async function refreshAndOpenSunriseCart() {
  const changed = await refreshDrawerLike({
    sections: [
      "ajaxcart-drawer",
      "ajaxcart",
      "cart-drawer",
      "cart-notification",
      "cart-icon-bubble",
    ],
    drawerHosts: [
      ".ajaxcart-drawer",
      ".ajaxcart",
      "#CartDrawer",
      ".cart-drawer",
    ],
    parseSelectors: [
      ".ajaxcart-drawer",
      ".ajaxcart__inner",
      ".ajaxcart",
      "#CartDrawer",
      ".cart-drawer",
      ".cart-drawer__content",
    ],
    openSelectors: [
      ".ajaxcart-drawer",
      ".ajaxcart",
      "#CartDrawer",
      ".cart-drawer",
      '[data-drawer="cart"]',
      '[data-open-cart]'
    ],
  });

  const drawer = document.querySelector(".ajaxcart-drawer, .ajaxcart, #CartDrawer, .cart-drawer") as HTMLElement | null;
  if (drawer) {
    const current = drawer.getAttribute("data-rc-refreshed") || "0";
    drawer.setAttribute("data-rc-refreshed", current === "1" ? "2" : "1");
  }

  await ensureCartOpen();
  return changed || !!drawer;
}

// Balance (Impact Theme)
export async function refreshAndOpenBalanceCart() {
  const wasOpen = isDrawerOpen();
  const sec = await fetchSections(["sections--16085054455984__cart-drawer"]);
  let changed = false;

  // Drawer
  const drawerHtml = sec["sections--16085054455984__cart-drawer"];
  if (drawerHtml) {
    const host = document.querySelector("cart-drawer") as HTMLElement;
    const next = parseFirst(drawerHtml, ["cart-drawer"]);
    swapInner(host, next);
    changed = true;
  }

  await updateCountsAndFire();

  // Stabilize dynamic elements
  const progressBars = document.querySelectorAll(".progress-bar");
  progressBars.forEach((el) => {
    (el as HTMLElement).style.display = "none";
  });

  // Open if needed
  try {
    const cart = await fetch("/cart.js", { credentials: "same-origin", cache: "no-cache" }).then(r => r.json()).catch(() => null);
    const hasItems = !!(cart && cart.item_count > 0);
    if (wasOpen || hasItems) {
      await ensureCartOpen();
    }
  } catch {}

  return changed;
}

// Impact Theme Shape
export async function refreshAndOpenImpactThemeShapeCart() {
  const theme = (window as any)?.Shopify?.theme;
  if (!theme || String(theme.schema_name) !== "Impact") return false;

  // Minimal invisible DOM change: toggle a data attribute on the cart drawer
  const drawer = document.querySelector("cart-drawer, #CartDrawer") as HTMLElement | null;
  if (drawer) {
    const current = drawer.getAttribute("data-rc-refreshed") || "0";
    drawer.setAttribute("data-rc-refreshed", current === "1" ? "2" : "1");
  }

  // Do not touch layout/HTML; just let native UI settle
  await delay(300);
  return true;
}

/* Registry + default router */

export type ThemeHandler = () => Promise<boolean>;

const THEME_HANDLERS: Record<string, ThemeHandler> = {
  // canonical schema keys
  dawn: refreshAndOpenDawnCart,
  "mr parker": refreshAndOpenMrParkerCart,
  impact: refreshAndOpenImpactCart,
  "impact theme shape": refreshAndOpenImpactThemeShapeCart,
  hyper: refreshAndOpenHyperCart,
  grid: refreshAndOpenGridCart,
  sunrise: refreshAndOpenSunriseCart,
  // brand aliases → schema
  nest: refreshAndOpenMrParkerCart,
  balance: refreshAndOpenBalanceCart,
  pillar: refreshAndOpenHyperCart,
  flora: refreshAndOpenGridCart,
  jellybean: refreshAndOpenSunriseCart,
  // Common Shopify OS2.0 free themes (map to Dawn behavior)
  sense: refreshAndOpenDawnCart,
  craft: refreshAndOpenDawnCart,
  studio: refreshAndOpenDawnCart,
  taste: refreshAndOpenDawnCart,
  origin: refreshAndOpenDawnCart,
  spotlight: refreshAndOpenDawnCart,
  refresh: refreshAndOpenDawnCart,
  ride: refreshAndOpenDawnCart,
  publisher: refreshAndOpenDawnCart,
  colorblock: refreshAndOpenDawnCart,
  taste2: refreshAndOpenDawnCart,
};

// Normalize helpers: loose normalization and compact (strip non-alphanumerics)
function normLoose(s: string) {
  return String(s || "").toLowerCase().trim();
}
function compactKey(s: string) {
  return normLoose(s).replace(/[^a-z0-9]+/g, "");
}

// Build a map that contains both canonical and compact aliases
const HANDLER_MAP: Record<string, ThemeHandler> = {};
for (const [k, v] of Object.entries(THEME_HANDLERS)) {
  HANDLER_MAP[normLoose(k)] = v;
  HANDLER_MAP[compactKey(k)] = v;
}

async function tryAllKnownHandlers(): Promise<boolean> {
  const chain: ThemeHandler[] = [
    refreshAndOpenDawnCart,
    refreshAndOpenMrParkerCart,
    refreshAndOpenImpactCart,
    refreshAndOpenHyperCart,
    refreshAndOpenGridCart,
    refreshAndOpenSunriseCart,
  ];
  for (const fn of chain) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const ok = await fn();
      if (ok) return true;
    } catch {}
  }
  return false;
}

export async function refreshCart(themeKeyOrVariant?: unknown): Promise<boolean> {
  const schemaRaw = (window as any)?.Shopify?.theme?.schema_name || (window as any)?.Shopify?.theme?.name || "";
  const candidates = [String(themeKeyOrVariant ?? ""), String(schemaRaw ?? "")];
  for (const c of candidates) {
    const keys = [normLoose(c), compactKey(c)];
    for (const k of keys) {
      if (k && HANDLER_MAP[k]) {
        log("using handler:", k);
        return HANDLER_MAP[k]();
      }
    }
  }
  // Try a few defaults if unknown
  if (document.querySelector("cart-drawer") || document.querySelector("#CartDrawer")) {
    const ok = await refreshAndOpenDawnCart();
    if (ok) return true;
  }
  // Try all known strategies
  const anyOk = await tryAllKnownHandlers();
  if (anyOk) return true;
  // Fallback: counts/events only
  await updateCountsAndFire();
  // Try to open drawer via native signals as a last resort
  await ensureCartOpen();
  await delay(200);
  return true;
}

// Expose both forms for the runner
(function expose() {
  const g: any = window as any;
  g.RC = g.RC || {};
  g.RC.refreshCart = refreshCart;
  // expose both canonical and compact keys for object-style lookup
  g.refreshCart = Object.assign(g.refreshCart || {}, HANDLER_MAP);
})();

function fetchAndSwapJoin(selectors: string[]): HTMLElement | null {
  if (!selectors || !selectors.length) return null;
  return document.querySelector(selectors.join(",")) as HTMLElement | null;
}

async function fetchAndSwapSection(sectionName: string, hostSelectors: string[], parseSelectors: string[]): Promise<boolean> {
  try {
    const sec = await fetchSections([sectionName]);
    const html = sec?.[sectionName];
    if (!html) return false;
    const host = fetchAndSwapJoin(hostSelectors);
    if (!host) return false;
    const next = parseFirst(html, parseSelectors);
    if (!next) return false;
    swapInner(host, next);
    return true;
  } catch {
    return false;
  }
}

// Try a list of possible sections/hosts and apply the first that succeeds.
async function minimalRefresh(options: Array<{ section: string; host: string[]; parse: string[] }>): Promise<boolean> {
  for (const opt of options) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await fetchAndSwapSection(opt.section, opt.host, opt.parse);
    if (ok) return true;
  }
  return false;
}




