declare global {
  interface Window {
    betterPopupFetch?: (
      originalFetch: typeof fetch,
      ...args: Parameters<typeof fetch>
    ) => ReturnType<typeof fetch>;
    __betterPopupOriginalFetch__?: (
      ...args: Parameters<typeof fetch>
    ) => ReturnType<typeof fetch>;
    ShopifyAnalytics: any;
    Shopify: any;
  }
}
interface RenderableElement extends Element {
  renderContents(sections: any): void;
}
type ThemeHandler = (...args: any[]) => Promise<boolean | void> | boolean | void;
const THEME_HANDLERS: Record<string, ThemeHandler> = {
  // keys are normalized to lowercase schema values
  galleria: refreshAndOpenGalleriaCart,
  north: refreshAndOpenNorthCart,
  // add more themes here e.g.:
  // "dawn": refreshAndOpenDawnCart,
};

export async function refreshCartRouter(...args: any[]): Promise<boolean> {
  try {
    const t = (window as any)?.Shopify?.theme || {};
    const raw = (t.schema ?? t.schema_name ?? t.name ?? "").toString();
    const key = raw.trim().toLowerCase();
    const handler = THEME_HANDLERS[key];

    if (typeof handler === "function") {
    const res = await handler(...args);      // treat undefined/void as handled
      return res !== false;
    }
    console.log(`[refreshCartRouter] No handler for schema "${raw}"`);
  } catch (e) {
    console.log("[refreshCartRouter] Router failed", e);
  }
  return false;
}
export async function refreshAndOpenGalleriaCart(...args: any[]) {
  const theme = window?.Shopify?.theme;
  if (!theme || theme.schema_name !== "Galleria") {
    console.log("[refreshAndOpenGalleriaCart] Not Galleria theme, skipping");
    return;
  }

  const modal = document.querySelector("modal-popup[enable-cart]") as any;
  if (!modal) {
    console.log(
      "[refreshAndOpenGalleriaCart] modal-popup[enable-cart] not found",
    );
    return;
  }

  if (!modal.cartContent) {
    const cartUrl = modal.getAttribute("cart-url") || "/cart";
    const cartTarget = modal.getAttribute("cart-target") || "[data-main-cart]";
    try {
      const html = await fetch(cartUrl, {
        credentials: "same-origin",
      }).then((r) => r.text());
      const doc = new DOMParser().parseFromString(html, "text/html");
      const content = doc.querySelector(cartTarget);
      if (content) modal.cartContent = content;
      else {
        console.log("[refreshAndOpenGalleriaCart] Cart target not found");
        return;
      }
    } catch (err) {
      console.log(
        "[refreshAndOpenGalleriaCart] Failed to fetch cart HTML",
        err,
      );
      return;
    }
  }

  modal.dispatchEvent(
    new CustomEvent("openPopup", { bubbles: true, detail: { target: "CART" } }),
  );
  await new Promise((r) => setTimeout(r, 400));
  console.log("[refreshAndOpenGalleriaCart]", modal);
  if (modal.cartContent?.update)
    modal.cartContent.update(() =>
      console.log("[refreshAndOpenGalleriaCart] Cart refreshed via update()"),
    );
  else modal.dispatchEvent(new CustomEvent("updateCart", { bubbles: true }));
  return true;
}
export async function refreshAndOpenNorthCart(...args: any[]) {
  // Guard: only run for North theme
  const theme = window?.Shopify?.theme;
  if (!theme || theme.name !== "North") {
    console.log("[refreshAndOpenNorthCart] Not North theme, skipping");
    return;
  }

  // --- Refresh cart sections ---
  let sectionsPayload;
  try {
    const r = await fetch("/?sections=cart-bubble,cart-side", {
      credentials: "same-origin",
    });
    sectionsPayload = await r.json();
  } catch (err) {
    console.log("[refreshAndOpenNorthCart] Failed to fetch sections", err);
    return;
  }

  const p = new DOMParser();

  // bubble
  try {
    const bf = p
      .parseFromString(sectionsPayload["cart-bubble"], "text/html")
      .querySelector(".float_count");
    const bt = document.querySelector("#quick_cart .float_count");
    if (bf && bt) bt.innerHTML = bf.innerHTML;
  } catch (err) {
    console.log("[refreshAndOpenNorthCart] Bubble update failed", err);
  }

  // side-cart content
  try {
    const sf = p
      .parseFromString(sectionsPayload["cart-side"], "text/html")
      .querySelector(".side-panel-content");
    const st = document.querySelector("#side-cart .side-panel-content");
    if (sf && st) st.replaceWith(sf);
  } catch (err) {
    console.log("[refreshAndOpenNorthCart] Side-cart update failed", err);
  }

  // --- Open drawer ---
  const forceOpen = () => {
    const w = document.querySelector("#wrapper") as HTMLElement | null;
    const c = document.querySelector("#side-cart") as HTMLElement | null;
    if (w && c) {
      w.classList.add("open-cc");
      c.style.visibility = "visible";
      c.style.transform = "translateX(0%)";
      try {
        c.focus();
      } catch {}
    }
  };

  const trig =
    document.querySelector(".header #quick_cart") ||
    document.querySelector("#quick_cart");
  if (trig) {
    const kill = (e: {
      preventDefault: () => void;
      stopPropagation: () => void;
    }) => {
      e.preventDefault();
      e.stopPropagation();
    };
    trig.addEventListener("click", kill, { capture: true, once: true });
    trig.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    requestAnimationFrame(() => setTimeout(forceOpen, 16));
  } else {
    forceOpen();
  }
  return true;
}
export async function refreshCart(variantId: string): Promise<void> {
  const handled = await refreshCartRouter();
  if (handled) return;
  // We leave existing refresh code in case we don't handle a theme we don't know
  // which might be handled by the code below

  /* Fetch fresh cart JSON */
  const cartRes = await fetch("/cart.js", {
    method: "GET",
    cache: "no-cache",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  if (!cartRes.ok) return;
  const cart = await cartRes.json();
  const count = cart.item_count;

  /* Replace main cart HTML fragments */
  try {
    const htmlRes = await fetch("/cart", {
      credentials: "same-origin",
      cache: "no-cache",
    });
    const html = await htmlRes.text();

    const tpl = document.createElement("template");
    tpl.innerHTML = `<div>${html}</div>`;
    const newEls = tpl.content.querySelectorAll(
      '#site-control .cart:not(.nav-search), [data-section-type="cart-template"]',
    );
    const oldEls = document.querySelectorAll(
      '#site-control .cart:not(.nav-search), [data-section-type="cart-template"]',
    );

    oldEls.forEach((el, i) => {
      const fresh = newEls[i];
      if (!fresh) return;
      fresh
        .querySelectorAll("[data-cc-animate]")
        .forEach((n) => n.removeAttribute("data-cc-animate"));
      el.replaceWith(fresh);
      el.parentElement
        ?.querySelectorAll("[data-cc-animate]")
        .forEach((n) => n.removeAttribute("data-cc-animate"));
    });
  } catch (err) {
    console.log("[refreshCart] HTML replacement failed", err);
  }

  /* Update cart count in all known places */
  const selectors = [
    "[data-cart-item-count]",
    ".header__cart-count",
    ".site-header__cart-count span[data-cart-count]",
    "#CartCount [data-cart-count]",
    ".cart-count",
    ".cartCount[data-cart-count]",
    ".mega-nav-count.nav-main-cart-amount.count-items",
    ".header-actions [data-header-cart-count]",
    ".cart-count-bubble [data-cart-count]",
    ".cart-count-bubble span.visually-hidden",
    ".custom-cart-eye-txt",
    ".cart_count",
    ".header-cart-count .cart_count_val",
  ];
  selectors.forEach((sel) => {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      el.innerHTML = el.innerHTML.replace(/(\d+)/, String(count));
    });
  });

  /* Remove 'hide' class if cart count is now visible */
  document.querySelector("#CartCount.hide")?.classList.remove("hide");

  const hdr = document.querySelector(
    ".site-header__cart .site-header__cart-indicator",
  );
  if (hdr) {
    hdr.innerHTML = hdr.innerHTML.replace(/(\d+)/, String(count));
    if (count > 0) hdr.classList.remove("hide");
  }

  const desktop = document.querySelector("[data-js-cart-count-desktop]");
  if (desktop) {
    desktop.innerHTML = String(count);
    desktop.setAttribute("data-js-cart-count-desktop", String(count));
  }

  const subtotal = document.getElementById("CartCost");
  if (subtotal && (window as any).theme?.moneyFormat) {
    const fmt = (window as any).theme.moneyFormat;
    subtotal.innerHTML = fmt.replace(
      "{{amount}}",
      (cart.items_subtotal_price / 100).toFixed(2),
    );
  }

  /* Fire all system + theme cart hooks */
  const call = (fn: any, ...args: any[]) => {
    try {
      typeof fn === "function" && fn(...args);
    } catch (e) {
      console.log(e);
    }
  };

  const fire = (evt: string, detail?: object) =>
    document.dispatchEvent(new CustomEvent(evt, { detail, bubbles: true }));
  await (async () => {
    const response = await fetch("/cart?section_id=cart-drawer", {
      credentials: "same-origin",
    });
    const parsed = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );

    for (const selector of ["cart-drawer-items", ".cart-drawer__footer"]) {
      const target = document.querySelector(selector);
      const fresh = parsed.querySelector(selector);
      if (target && fresh) target.replaceWith(fresh);
    }
  })();
  // Core theme + plugin triggers
  call((window as any).refreshCart, cart);
  call((window as any).slate?.cart?.updateCart);
  call((window as any).ajaxCart?.load);
  call((window as any).Shopify?.updateQuickCart, cart);
  call((window as any).bcActionList?.atcBuildMiniCartSlideTemplate, cart);
  call(() => (window as any).openMiniCart?.());
  call((window as any).vndHlp?.refreshCart, cart);
  call((window as any).renderCart, cart);
  call((window as any).SATCB?.Helpers?.openCartSlider);
  call((window as any).Shopify?.onCartUpdate, cart, true);
  call((window as any).theme?.Cart?.setCurrentData, cart);
  call((window as any).halo?.updateSidebarCart, cart);
  call(
    (window as any).Shopify?.theme?.ajaxCart?.updateView,
    { cart_url: "/cart" },
    cart,
  );
  call((window as any).theme?.cart?.updateAllHtml);
  call((window as any).theme?.cart?.updateTotals, cart);
  call((window as any).monster_setCartItems, cart.items);
  call((window as any).refreshCartContents, cart);
  call((window as any).clientSpecifics?.update_cart?.trigger, cart);
  call((window as any).theme?.ajaxCart?.update);
  call((window as any).SLIDECART_UPDATE);
  setTimeout(() => call((window as any).SLIDECART_OPEN), 100);
  call((window as any).Shopify?.getCart);
  call((window as any).cart?.getCart);
  call((window as any).updateMiniCartContents);
  call((window as any).loadEgCartDrawer);
  call((window as any).theme?.updateCartSummaries);
  call((window as any).CD_REFRESHCART);
  setTimeout(() => call((window as any).CD_OPENCART), 100);
  call((window as any).buildCart);
  call((window as any).PXUTheme?.jsAjaxCart?.updateView);
  call((window as any).theme?.addedToCartHandler, {});
  call((window as any).updateCartContents, cart);
  call((window as any).HsCartDrawer?.updateSlideCart);
  call((window as any).HS_SLIDE_CART_UPDATE);
  call((window as any).HS_SLIDE_CART_OPEN);

  /* Trigger UI updates and custom events */
  fire("apps:product-added-to-cart");
  fire("theme:cart:change", { cart, cartCount: count });
  fire("cart:refresh");
  fire("cart:build");
  fire("dispatch:cart-drawer:refresh");
  document.documentElement.dispatchEvent(
    new CustomEvent("wetheme-toggle-right-drawer", {
      detail: { type: "cart", forceOpen: undefined, params: { cart } },
      bubbles: true,
    }),
  );

  document.documentElement.dispatchEvent(
    new CustomEvent("cart:refresh", {
      detail: { cart, cartCount: count },
      bubbles: true,
    }),
  );
  window.dispatchEvent(new Event("update_cart"));
  try {
    const event = new Event("tcustomizer-event-cart-change");
    document.dispatchEvent(event);
  } catch (e) {}

  try {
    const siteCart = document.getElementById("site-cart");
    if (siteCart && "show" in siteCart) (siteCart as any).show();
  } catch {}
  // todo this should be refactored at some point. good luck
  try {
    const notif = document.querySelector(
      "cart-notification",
    ) as RenderableElement | null;
    if (!notif || typeof notif?.renderContents !== "function") {
      console.log("[craft-refresh] No <cart-notification> or renderContents()");
    }

    // --- get cart + last item key ---
    let cart, key, count;
    try {
      cart = await (
        await fetch("/cart.js", {
          credentials: "same-origin",
        })
      ).json();
      key = cart.items?.at(-1)?.key || null;
      count = cart.item_count ?? 0;
    } catch (e) {
      console.log("[craft-refresh] /cart.js failed", e);
    }

    // --- try to fetch the exact keys Craft expects (works on /cart/add, sometimes works via GET) ---
    const SECTION_IDS =
      "cart-notification-product,cart-notification-button,cart-icon-bubble";
    async function fetchSections(base: string) {
      const qs = new URLSearchParams({
        sections: SECTION_IDS,
        sections_url: location.pathname,
      });
      const url = `${base}${base.includes("?") ? "&" : "?"}${qs}`;
      const r = await fetch(url, {
        credentials: "same-origin",
      });
      if (!r.ok) return null;
      return r.json();
    }

    let json = await fetchSections("/");
    if (
      !json ||
      !(
        typeof json["cart-notification-product"] === "string" &&
        json["cart-notification-product"].trim() !== ""
      )
    ) {
      console.log("root sections miss, fallback to /cart");
      json = await fetchSections("/cart");
    }

    if (
      json &&
      typeof json["cart-notification-product"] === "string" &&
      json["cart-notification-product"].trim() !== ""
    ) {
      const payload = {
        key,
          id: variantId,
        sections: {
          "cart-notification-product": json["cart-notification-product"],
          "cart-notification-button":
            json["cart-notification-button"] ||
            json["cart-notification-product"],
          "cart-icon-bubble": json["cart-icon-bubble"] || "",
        },
      };
      // debugger;
          console.log(payload);
      notif?.renderContents(payload);
      setTimeout(() => {
        try {
          (window as any).removeTrapFocus?.(document.body);
        } catch {}
        try {
          (document.activeElement as HTMLElement | null)?.blur?.();
        } catch {}
      }, 50);
    }
  } catch (e) {
    console.log(e);
  }

  try {
    const target = (document.querySelector("cart-notification") ||
      document.querySelector("cart-drawer")) as RenderableElement | null;

    if (target !== null && typeof target.renderContents === "function") {
      fetch("cart?sections=cart-notification,cart-drawer,cart-icon-bubble", {
        method: "GET",
        cache: "no-cache",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      }).then((response) => {
        const emptyDrawer = document.querySelector(
          "cart-drawer.drawer.is-empty",
        );
        if (emptyDrawer !== null) emptyDrawer.classList.remove("is-empty");

        try {
          return response
            .clone()
            .json()
            .then((json) => {
              try {
                const payload = { sections: json };
                console.log(payload, json);
                setTimeout(() => {
                  try {
                    (window as any).removeTrapFocus?.(document.body);
                  } catch {}
                  try {
                    (document.activeElement as HTMLElement | null)?.blur?.();
                  } catch {}
                }, 50);
              } catch (errRender) {
                console.log(errRender);
              }
            });
        } catch (errParse) {
          console.log(errParse);
        }
      });
    }
  } catch (errOuter) {
    console.log(errOuter);
  }
}
