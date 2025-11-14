# Project Overview — Shopify Popup App (Theme Compatibility Expansion)

We’re developing a **Shopify popup app** that automatically displays upsell or cart-related popups when a shopper adds a product to their cart.  
The goal is to make this app compatible with **~250 Shopify themes**, each of which handles its cart and popup logic differently.

Our testing and development process ensures that each theme correctly triggers our popup and refreshes the cart display without breaking any native theme behavior.

---

## How It Works

We already have an **automated testing framework** built using **Puppeteer (Node.js)**.  
It loads each theme’s demo store, clicks “Add to Cart”, and captures a series of **screenshots** to detect how the theme reacts.

Each test produces a **visual diff report**, showing how much of the screen changed before and after an Add-to-Cart event.

### The testing process (simplified)

1. Load theme demo → e.g., `https://theme-dawn-demo.myshopify.com/products/...`
2. Take a screenshot **before** clicking Add to Cart.
3. Click **Add to Cart** (simulate a real user).
4. Take another screenshot and compare changes — if the cart drawer, popup, or notification appears, that’s a “success”.
5. Then we perform a **manual refresh test**:
   - Send a `fetch("/cart/add.js", {...})` request directly to Shopify to simulate a product being added to the cart without UI interaction.
   - Run our custom `refreshCart()` implementation for that theme to check if the cart visually updates correctly.
6. The **diff results** (percentage of changed pixels) tell us if the refresh worked or failed.

This gives us **quantitative validation** for each theme.

---

## The Problem — Every Theme Works Differently

Each Shopify theme uses a different internal mechanism to update or show the cart after an Add-to-Cart event:

| Type | Example Behavior |
|------|------------------|
| **Ajax cart drawer** | Theme updates cart asynchronously via `/cart.js` and opens a drawer element. |
| **Popup modal** | A modal is shown via JS event dispatch (e.g. `modal.dispatchEvent(new CustomEvent("openPopup", {...}))`). |
| **Custom dynamic render** | Some themes use custom JS modules that re-render specific `<section>` elements after cart updates. |

Because of this variation, each theme needs a slightly different `refreshCart()` function — the function that our app runs to re-render or refresh the cart UI.

---

## How We Find the Right Refresh Logic

To make a new theme compatible, we manually investigate how that theme’s cart system works.

### Process Overview

1. **Inspect the storefront**
   - Open the theme’s demo store in Chrome DevTools.
   - Add a product to the cart and observe what happens visually — does it open a drawer? show a modal? refresh the cart page?

2. **Search in the source**
   - View page source (`Ctrl+U`) or use DevTools “Sources” tab.
   - Search for keywords like `"cart"`, `"drawer"`, `"modal"`, `"openPopup"`, `"CartDrawer"`, `"updateCart"`, etc.

3. **Find responsible JS code**
   - Look for the JS that triggers or renders the cart section.  
     This can be inline, or inside a minified file (e.g. `theme.min.js`).

4. **Extract logic**
   - Copy the relevant JS snippets into an LLM (ChatGPT / Claude / etc.) and ask it to summarize what the function does and how the cart refresh is triggered.

5. **Implement `refreshCart()`**
   - Write a short function in TypeScript that replicates how that theme updates its cart.  
     For example:
     ```ts
     export async function refreshCart() {
       const res = await fetch("/?sections=cart-drawer");
       const html = await res.text();
       document.querySelector("#CartDrawer").innerHTML = JSON.parse(html)["cart-drawer"];
     }
     ```

6. **Validate**
   - Run the Puppeteer test again.  
     If the “after” screenshot shows the updated drawer or popup, it means the implementation works.

7. **Iterate**
   - If not, check console errors or diff reports, adjust selectors or fetch logic, and retest.

---

## Developer Resources

- **Automation tool:** Puppeteer (already implemented)
- **Theme data:** `themes.csv` — contains theme name, demo URL, and metadata.
- **Validation outputs:** Screenshot diffs + `results.csv`
- **Code to edit:** TypeScript `refreshCart.ts` file — each theme gets its own variation.

---

## Developer Tasks

1. Pick a theme from the list that isn’t supported yet.
2. Inspect and determine how it handles cart updates.
3. Implement a custom `refreshCart()` function for that theme.
4. Run the automated test to confirm visual diffs behave as expected.
5. Push your implementation (one per theme) with short notes describing what pattern it uses.

---

## Example of Success

**Theme:** Dawn  
**Trigger:** Ajax add to cart → opens cart drawer  

```ts
export async function refreshCart() {
  const sections = ["cart-drawer"];
  const res = await fetch(`/?sections=${sections.join(",")}`);
  const data = await res.json();
  document.querySelector("#CartDrawer").innerHTML = data["cart-drawer"];
}
```

 **Test result:** 0% visual diff after `add.js` call → Works perfectly.

---

## ️ Notes

- Some code may be **minified** — use ChatGPT to deobfuscate or infer structure.
- Always ensure your code **waits** for DOM to update before taking screenshots.
- Some themes show **alert dialogs** (e.g., “Product added to cart”) — these should be skipped automatically by our framework.
