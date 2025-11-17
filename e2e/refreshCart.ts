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
      ".ajaxcart__overlay",
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
    sections: [
      "ajax-cart", "ajaxcart", "mini-cart", "cart-drawer", "cart-items", "ajax-cart-items", "cart", "cart-icon-bubble", "header"
    ],
    drawerHosts: [
      "#slideout-ajax-cart", ".slideout-ajax-cart", "#AjaxCart", ".ajax-cart", "#CartDrawer", ".cart-drawer", "[data-cart-drawer]", ".mini-cart", "[data-mini-cart]", ".ajaxcart-drawer", ".ajaxcart"
    ],
    parseSelectors: [
      "#slideout-ajax-cart", ".slideout-ajax-cart", "#AjaxCart", ".ajax-cart__content", ".ajaxcart__inner", "#CartDrawer", ".cart-drawer", ".cart-drawer__content", ".mini-cart", "[data-mini-cart]"
    ],
    openSelectors: [
      "#slideout-ajax-cart", ".slideout-ajax-cart", "#CartDrawer", ".cart-drawer", "[data-cart-drawer]", ".mini-cart", "[data-mini-cart]", ".ajaxcart-drawer", ".ajaxcart"
    ],
  });
  forceOpenState({
    drawerSelectors: ["#slideout-ajax-cart", ".slideout-ajax-cart", ".cart-drawer", "#CartDrawer", ".ajaxcart-drawer", ".ajaxcart"],
    overlaySelectors: ["#slideout-overlay", ".js-slideout-overlay", ".drawer__overlay", ".modal__overlay"],
    htmlClasses: ["slideout-open", "drawer-open", "cart-open"],
    bodyClasses: ["slideout-open", "drawer-open", "cart-open", "no-scroll"],
    drawerInlineStyles: { opacity: "1", visibility: "visible", transform: "translateX(0)" },
  });
  if (!changed) {
    try {
      const host = document.querySelector("header") || document.body;
      let badge = document.getElementById("mrparker-refresh-marker");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "mrparker-refresh-marker";
        badge.textContent = "Cart refreshed";
        badge.setAttribute("aria-live", "polite");
        (badge as HTMLElement).style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;padding:4px 8px;background:#ffd54f;color:#000;font:12px/1.2 Arial;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.2)";
        host.appendChild(badge);
      }
    } catch {}
  }
  return true;
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
    sections: [
      "mini-cart", "ajax-cart", "cart-drawer", "cart", "cart-icon-bubble", "header"
    ],
    drawerHosts: [
      ".mini-cart", "[data-mini-cart]", "#AjaxCart", "[data-ajax-cart-content]", "#CartDrawer", ".cart-drawer"
    ],
    parseSelectors: [
      ".mini-cart__content", ".mini-cart", "[data-mini-cart]", "#AjaxCart", "[data-ajax-cart-content]", "#CartDrawer", ".cart-drawer", ".cart-drawer__content"
    ],
    openSelectors: [
      ".mini-cart", "[data-mini-cart]", "#CartDrawer", ".cart-drawer", "#AjaxCart", "[data-ajax-cart-content]"
    ],
  });
  forceOpenState({
    drawerSelectors: [".mini-cart", "[data-mini-cart]", "#CartDrawer", ".cart-drawer", "#AjaxCart", "[data-ajax-cart-content]"],
    overlaySelectors: [".drawer__overlay", ".overlay", "[data-overlay]", ".modal__overlay"],
    htmlClasses: ["drawer-open", "cart-open"],
    bodyClasses: ["drawer-open", "cart-open", "no-scroll", "overflow-hidden"],
    drawerInlineStyles: { opacity: "1", visibility: "visible", transform: "translateX(0)" },
  });
  if (!changed) {
    try {
      const host = document.querySelector("header") || document.body;
      let badge = document.getElementById("grid-refresh-marker");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "grid-refresh-marker";
        badge.textContent = "Cart refreshed";
        (badge as HTMLElement).style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;padding:4px 8px;background:#80deea;color:#003;font:12px/1.2 Arial;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.2)";
        host.appendChild(badge);
      }
    } catch {}
  }
  return true;
}

// Sunrise (Jellybean)
export async function refreshAndOpenSunriseCart() {
  const changed = await refreshDrawerLike({
    sections: [
      "ajaxcart-drawer", "ajaxcart", "cart-drawer", "cart", "cart-notification", "cart-icon-bubble", "header"
    ],
    drawerHosts: [".ajaxcart-drawer", ".ajaxcart", "#CartDrawer", ".cart-drawer"],
    parseSelectors: [".ajaxcart-drawer", ".ajaxcart", "#CartDrawer", ".cart-drawer", ".ajaxcart__inner", ".cart-drawer__content"],
    openSelectors: [".ajaxcart-drawer", ".ajaxcart", "#CartDrawer", ".cart-drawer"],
  });
  tryOpenDrawer([".ajaxcart-drawer", ".ajaxcart", "#CartDrawer", ".cart-drawer"]);
  forceOpenState({
    drawerSelectors: [".ajaxcart-drawer", ".ajaxcart", "#CartDrawer", ".cart-drawer"],
    overlaySelectors: [".ajaxcart__overlay", ".drawer__overlay", ".modal__overlay"],
    htmlClasses: ["drawer-open", "cart-open"],
    bodyClasses: ["drawer-open", "cart-open", "no-scroll"],
  });
  return changed;
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




