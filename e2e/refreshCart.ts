/* Browser-injected bundle: per-theme refresh handlers + registry.
   The runner will call either window.refreshCart[themeKey]() or RC.refreshCart().
*/

type SectionMap = Record<string, string>;

function log(...a: any[]) {
  try { console.debug("[refreshCart]", ...a); } catch {}
}

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

function tryOpenDrawer(candidates: string[]) {
  for (const sel of candidates) {
    const el: any = document.querySelector(sel);
    if (!el) continue;
    try {
      if (typeof el.open === "function") { el.open(); return; }
      (el as HTMLElement).classList.add("is-open", "open", "active");
      (el as HTMLElement).setAttribute("open", "true");
      return;
    } catch {}
  }
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
    });
    // Bubble badge
    document.querySelectorAll("#cart-icon-bubble, .cart-count-bubble, [data-cart-bubble]").forEach((el) => {
      (el as HTMLElement).dataset.count = String(count);
    });
  }

  // Fire common events many themes listen to
  try { document.dispatchEvent(new CustomEvent("cart:refresh", { bubbles: true, detail: { cart, cartCount: count } })); } catch {}
  try { window.dispatchEvent(new Event("update_cart")); } catch {}
  try { window.dispatchEvent(new CustomEvent("cart-updated", { detail: { cart } })); } catch {}
  try { document.dispatchEvent(new CustomEvent("ajaxProduct:added", { detail: { cart } })); } catch {}
}

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

  const sec = await fetchSections(sections);
  let changed = false;

  // Drawer
  const incomingDrawer = sec["cart-drawer"] || sec["drawer"] || "";
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
      // Fallback: swap a common notification container
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

  // Open drawer
  tryOpenDrawer(openSelectors);

  // Force final visible state similar to native drawers
  try {
    document.documentElement.classList.add("drawer-open", "cart-open");
    document.body.classList.add("drawer-open", "cart-open", "no-scroll", "overflow-hidden");

    const overlaySelectors = [
      ".drawer__overlay",
      ".cart-drawer__overlay",
      ".modal__overlay",
      ".overlay",
      "#slideout-overlay",
      "[data-overlay]",
    ];
    const ov = document.querySelector(overlaySelectors.join(",")) as HTMLElement | null;
    if (ov) {
      ov.style.display = "block";
      ov.style.opacity = "1";
      ov.style.visibility = "visible";
    }
  } catch {}

  await updateCountsAndFire();
  return changed;
}

/* Individual theme handlers (best-effort) */

// Dawn (OS2.0)
export async function refreshAndOpenDawnCart() {
  const changed = await refreshDrawerLike({
    sections: ["cart-drawer", "cart-notification", "cart-icon-bubble"],
    drawerHosts: ["#CartDrawer", "cart-drawer"],
    parseSelectors: ["#CartDrawer", '[id^="CartDrawer-"]', "cart-drawer"],
    openSelectors: ["cart-drawer", "#CartDrawer"],
  });
  try {
    // Also render notification if present
    const sec = await fetchSections(["cart-notification", "cart-icon-bubble"]);
    const notif: any = document.querySelector("cart-notification");
    if (notif && typeof notif.renderContents === "function" && sec["cart-notification"]) {
      notif.renderContents(sec);
    }
  } catch {}
  forceOpenState({
    drawerSelectors: ["cart-drawer", "#CartDrawer"],
    overlaySelectors: [".drawer__overlay", ".cart-drawer__overlay"],
    htmlClasses: ["cart-open", "drawer-open"],
    bodyClasses: ["cart-open", "drawer-open", "no-scroll", "overflow-hidden"],
    drawerInlineStyles: { opacity: "1", visibility: "visible", transform: "translateX(0)" },
  });
  return changed;
}

// Mr Parker (Nest)
export async function refreshAndOpenMrParkerCart() {
  const changed = await refreshDrawerLike({
    sections: ["ajax-cart", "mini-cart", "cart-drawer", "cart-icon-bubble"],
    drawerHosts: ["#slideout-ajax-cart", "#CartDrawer", ".cart-drawer", "[data-cart-drawer]", ".mini-cart"],
    parseSelectors: ["#slideout-ajax-cart", "#CartDrawer", ".cart-drawer", "[data-cart-drawer]", ".mini-cart"],
    openSelectors: ["#slideout-ajax-cart", ".cart-drawer", "#CartDrawer", "[data-cart-drawer]"],
  });
  forceOpenState({
    drawerSelectors: ["#slideout-ajax-cart", ".cart-drawer"],
    overlaySelectors: ["#slideout-overlay", ".js-slideout-overlay", ".drawer__overlay"],
    htmlClasses: ["slideout-open", "drawer-open"],
    bodyClasses: ["slideout-open", "drawer-open", "no-scroll"],
    drawerInlineStyles: { opacity: "1", visibility: "visible", transform: "translateX(0)" },
  });
  return changed;
}

// Impact (Balance)
export async function refreshAndOpenImpactCart() {
  const changed = await refreshDrawerLike({
    sections: ["cart-drawer", "cart-icon-bubble", "cart-notification"],
    drawerHosts: ["#CartDrawer", ".drawer--cart", "cart-drawer", "cart-notification-drawer"],
    parseSelectors: ["#CartDrawer", ".drawer--cart", "cart-drawer", "cart-notification-drawer"],
    openSelectors: ["cart-notification-drawer", "#CartDrawer", ".drawer--cart", "cart-drawer"],
  });
  // Ensure notification drawer visible
  forceOpenState({
    drawerSelectors: ["cart-notification-drawer", "#CartDrawer", ".drawer--cart"],
    overlaySelectors: [".drawer__overlay", ".modal__overlay"],
    htmlClasses: ["drawer-open", "cart-open"],
    bodyClasses: ["drawer-open", "cart-open", "no-scroll"],
    drawerInlineStyles: { opacity: "1", visibility: "visible", bottom: "0", position: "fixed" },
  });
  return changed;
}

// Hyper (Pillar)
export async function refreshAndOpenHyperCart() {
  const changed = await refreshDrawerLike({
    sections: ["cart-drawer", "cart-notification", "cart-icon-bubble"],
    drawerHosts: ["#CartDrawer", ".CartDrawer", ".js-cart-drawer", "cart-notification-drawer"],
    parseSelectors: ["#CartDrawer", ".CartDrawer", ".js-cart-drawer", "cart-notification-drawer"],
    openSelectors: ["cart-notification-drawer", "#CartDrawer", ".CartDrawer", ".js-cart-drawer", ".Drawer--cart"],
  });
  forceOpenState({
    drawerSelectors: ["cart-notification-drawer", "#CartDrawer", ".CartDrawer", ".js-cart-drawer"],
    overlaySelectors: [".drawer__overlay", ".modal__overlay"],
    htmlClasses: ["drawer-open", "cart-open"],
    bodyClasses: ["drawer-open", "cart-open", "no-scroll"],
    drawerInlineStyles: { opacity: "1", visibility: "visible", right: "0", transform: "translateX(0)" },
  });
  return changed;
}

// Grid (Flora)
export async function refreshAndOpenGridCart() {
  const changed = await refreshDrawerLike({
    sections: ["cart-drawer", "mini-cart", "cart-icon-bubble"],
    drawerHosts: ["#CartDrawer", ".mini-cart", "[data-mini-cart]"],
    parseSelectors: ["#CartDrawer", ".mini-cart", "[data-mini-cart]"],
    openSelectors: ["#CartDrawer", ".mini-cart", "[data-mini-cart]"],
  });
  forceOpenState({
    drawerSelectors: ["#CartDrawer", ".mini-cart", "[data-mini-cart]"],
    overlaySelectors: [".drawer__overlay", ".overlay", "[data-overlay]"],
    htmlClasses: ["drawer-open", "cart-open"],
    bodyClasses: ["drawer-open", "cart-open", "no-scroll"],
    drawerInlineStyles: { opacity: "1", visibility: "visible", transform: "translateX(0)" },
  });
  return changed;
}

// Sunrise (Jellybean)
export async function refreshAndOpenSunriseCart() {
  return refreshDrawerLike({
    sections: ["cart-drawer", "cart-notification", "cart-icon-bubble"],
    drawerHosts: ["#CartDrawer", ".CartDrawer", ".ajaxcart-drawer"],
    parseSelectors: ["#CartDrawer", ".CartDrawer", ".ajaxcart-drawer"],
    openSelectors: ["#CartDrawer", ".CartDrawer", ".ajaxcart-drawer"],
  });
}

/* Registry + default router */

export type ThemeHandler = () => Promise<boolean>;

const THEME_HANDLERS: Record<string, ThemeHandler> = {
  // canonical schema keys
  dawn: refreshAndOpenDawnCart,
  "mr parker": refreshAndOpenMrParkerCart,
  impact: refreshAndOpenImpactCart,
  hyper: refreshAndOpenHyperCart,
  grid: refreshAndOpenGridCart,
  sunrise: refreshAndOpenSunriseCart,
  // brand aliases → schema
  nest: refreshAndOpenMrParkerCart,
  balance: refreshAndOpenImpactCart,
  pillar: refreshAndOpenHyperCart,
  flora: refreshAndOpenGridCart,
  jellybean: refreshAndOpenSunriseCart,
};

function norm(s: string) {
  return String(s || "").toLowerCase().trim();
}

export async function refreshCart(themeKeyOrVariant?: unknown): Promise<boolean> {
  const schema = (window as any)?.Shopify?.theme?.schema_name || (window as any)?.Shopify?.theme?.name || "";
  const keys = [norm(String(themeKeyOrVariant || "")), norm(schema)];
  for (const k of keys) {
    if (k && THEME_HANDLERS[k]) {
      log("using handler:", k);
      return THEME_HANDLERS[k]();
    }
  }
  // Try a few defaults if unknown
  if (document.querySelector("cart-drawer") || document.querySelector("#CartDrawer")) {
    return refreshAndOpenDawnCart();
  }
  // Fallback: counts/events only
  await updateCountsAndFire();
  return true;
}

// Expose both forms for the runner
(function expose() {
  const g: any = window as any;
  g.RC = g.RC || {};
  g.RC.refreshCart = refreshCart;
  g.refreshCart = Object.assign(g.refreshCart || {}, THEME_HANDLERS);
})();




