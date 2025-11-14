# Theme Scraper Validator – Instructions

This folder contains everything needed to test and add support for Shopify themes in the `refreshCart.ts` compatibility system.  
Your job is to implement cart‑refresh handlers for a small subset of themes assigned to you.

Read everything carefully. Do not guess. If something on the page is missing, broken, or unclear, stop and ask.

---

## 1. What You Will Do

You will receive **5–10 themes**.  
For each theme:

1. Open the demo store URL.
2. Inspect how the theme shows and updates the cart:
   - Drawer
   - Popup
   - Side panel
   - Notification
3. Identify how the theme loads or refreshes cart content.
4. Implement a matching handler inside `refreshCart.ts`, inside:

```
export const THEME_HANDLERS = {
    "galleria": refreshAndOpenGalleriaCart,
    "north": refreshAndOpenNorthCart,
    ...
};
```

5. Run automated tests through the runner:
```
npm install
npx ts-node e2e_theme_runner.ts --concurrency=3
```

6. Review:
   - `out/results.csv`
   - Diff images in `out/<theme>/`

Tests must show `PASS` unless a harmless cookie popup blocks execution.

If the theme displays blocking popups (cookie banner, age prompt, newsletter modal), report it. Do not continue.

---

## 2. Important Notes

### A) Required Data From Page
If the handler needs more information (cart selectors, events, structure), stop and ask.  
Do **not** guess selectors or rewrite large pieces of HTML.

### B) If Something Fails
If:
- Buttons do nothing
- Cart does not open
- Drawer closes instantly
- Page throws script errors

Stop and report the theme with details.

### C) About Concurrency
Some themes load assets slowly. To avoid inconsistent screenshots:

```
npx ts-node e2e_theme_runner.ts --concurrency=2
```

Run this if your internet connection is weak.

### D) Diffs
If a diff image shows changes only because of:
- Slow loading
- Animations
- Banners
- Network delays

Report it. Do not mark as failure on your own.

---

## 3. File Overview

You get a full copy of:

```
README.md (this file)
e2e/
    e2e_theme_runner.ts
    refreshCart.ts
    out/
        <theme>/
            pre_click.png
            post_click.png
            base_diff.png
            refresh_diff.png
            ...
    package.json
    tsconfig.json
fetch_themes/
    themes.csv
theme_compatibility_guide.md
```

You only modify:
- `refreshCart.ts`

Absolutely never modify:
- `e2e_theme_runner.ts`
- Anything inside `fetch_themes/`
- CSV or PNG files

---

## 4. Implementing a Handler

Handlers use the following pattern:

1. Confirm the correct theme:
```
const theme = window?.Shopify?.theme;
if (!theme || theme.schema_name !== "Galleria") return;
```

2. Fetch and replace cart HTML.

3. Open the drawer / popup.

4. Return `true` when refreshed successfully.

Look at:
- `refreshAndOpenGalleriaCart`
- `refreshAndOpenNorthCart`

as reference examples.

Do not overcomplicate.  
Do not rewrite the router.  
Do not modify global refresh logic.

---

## 5. Flags to Report

If you see any of these: **stop and ask**.

- Cookie banner blocks Add to Cart
- Age verification modal
- Newsletter popup blocking UI
- Cart drawer uses heavy client-side frameworks
- Cart is inside an iframe
- Page refuses to load sections via AJAX
- No add-to-cart button exists for any product

Tests will mark such themes as `NO-PASS`. This is allowed.

---

## 6. After Completing Assigned Themes

After implementing and confirming all your assigned themes:

1. Ensure every theme you touched shows `PASS` in:
   - `out/results.csv`

2. Commit and text me on Upwork:
   - The updated `refreshCart.ts`
   - Notes on problematic themes
   - List of handlers you implemented

---

## 7. Final Reminder

Follow instructions exactly.  
Ask when unsure.  
Never modify files outside `refreshCart.ts`.  
Do not work ahead without confirmation.

Good luck.
Synthesis
