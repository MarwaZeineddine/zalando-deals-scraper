import { chromium } from "playwright";
import fs from "fs";

const MIN_DISCOUNT_PERCENT = 35;
const MIN_SALE_PRICE = 10;            // ✅ prevents weird tiny numbers slipping through
const ENRICH_SIZES = false;            // turn off if you want faster runs
const ENRICH_MAX_PER_CATEGORY = 25;   // ✅ limit product-page visits per category

const CATEGORY_URLS = [
  "https://www.zalando.it/occhiali-sole-donna/?order=sale",
  "https://www.zalando.it/scarpe-donna/?order=sale"

];

const MAX_ITEMS_PER_CATEGORY = 80;
const SCROLL_STEPS = 10;

function safeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Parse "107,99" / "1.234,56" / "107.99" / "1,234.56"
function parseMoney(text) {
  if (!text) return null;

  const m = String(text).match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
  if (!m) return null;

  let t = m[1];
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");

  if (lastComma > lastDot) {
    // EU: 1.234,56 -> 1234.56
    t = t.replace(/\./g, "").replace(",", ".");
  } else {
    // US: 1,234.56 -> 1234.56
    t = t.replace(/,/g, "");
  }

  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function computeDiscount(original, sale) {
  if (!original || !sale || original <= 0) return 0;
  return Math.round(((original - sale) / original) * 100);
}

async function debugDump(page, prefix = "debug") {
  const ts = Date.now();
  await page.screenshot({ path: `${prefix}-${ts}.png`, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) fs.writeFileSync(`${prefix}-${ts}.html`, html, "utf8");
}

async function acceptCookies(page) {
  try {
    await page.waitForTimeout(1500);

    const selectors = [
      'button:has-text("Accetta tutto")',
      'button:has-text("Accetta")',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      'button[aria-label*="Accetta"]',
      'button[aria-label*="Accept"]',
    ];

    for (const sel of selectors) {
      const btn = page.locator(sel);
      if (await btn.count()) {
        await btn.first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchBrandAndSizes(context, productUrl) {
  const p = await context.newPage();

  try {
    await p.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await acceptCookies(p);
    await p.waitForTimeout(1200);

    // --- BRAND (stable-ish selectors) ---
    const brand =
      safeText(await p.locator('[data-testid="product-header-brand"]').first().textContent().catch(() => "")) ||
      safeText(await p.locator('[data-testid="product-header__brand"]').first().textContent().catch(() => "")) ||
      safeText(await p.locator('a[href*="/brand/"]').first().textContent().catch(() => "")) ||
      safeText(await p.locator('meta[property="product:brand"]').getAttribute("content").catch(() => "")) ||
      "";

    // --- OPEN SIZE DROPDOWN ---
    const openers = [
      // English
      'button:has-text("Choose your size")',
      'button:has-text("Select size")',
      // Italian
      'button:has-text("Seleziona la taglia")',
      'button:has-text("Scegli la taglia")',
      'button:has-text("Seleziona misura")',
      // fallback by aria-label
      'button[aria-label*="taglia" i]',
      'button[aria-label*="size" i]',
    ];

    for (const sel of openers) {
      const btn = p.locator(sel).first();
      if (await btn.count().catch(() => 0)) {
        await btn.click({ timeout: 4000 }).catch(() => {});
        await p.waitForTimeout(800);
        break;
      }
    }

    // --- WAIT FOR SIZE LIST PANEL ---
    // Zalando often shows options as list items / buttons within a dropdown panel
    const panelCandidates = [
      '[role="listbox"]',
      '[data-testid*="size" i]',
      'div:has-text("EU size")',
      'div:has-text("Manufacturer sizes")',
      'div:has-text("Taglie")',
    ];

    let panelFound = false;
    for (const sel of panelCandidates) {
      const loc = p.locator(sel).first();
      const ok = await loc.waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
      if (ok) { panelFound = true; break; }
    }

    if (!panelFound) {
      // If no panel is visible, sizes might be unavailable
      return { brand, available_sizes: [] };
    }

    // --- EXTRACT SIZES FROM OPENED DROPDOWN ---
    // We grab text from common clickable rows (buttons / list items)
    const sizes = await p.evaluate(() => {
      const out = new Set();

      // collect clickable rows in listbox or dropdown containers
      const containers = Array.from(document.querySelectorAll('[role="listbox"], [data-testid*="size" i]'));
      const scope = containers.length ? containers : [document];

      const sizeRegex =
        /^(EU|IT|US|UK)?\s*\d+(\s*\/\s*\d+)?(\.\d+)?$/i; // supports "37 1/3", "36", "35.5"

      for (const root of scope) {
        const nodes = root.querySelectorAll('button, [role="option"], li, div');
        for (const n of nodes) {
          const txt = (n.textContent || "").replace(/\s+/g, " ").trim();

          // Skip disabled / not available
          const ariaDisabled = n.getAttribute?.("aria-disabled");
          const disabled = (n instanceof HTMLButtonElement && n.disabled) || ariaDisabled === "true";
          if (disabled) continue;

          // Most rows look like: "35.5 | 3 €53.95" so we take only the first token before | or €
          const firstChunk = txt.split("|")[0].trim().split("€")[0].trim();

          // Extract the EU-like number part from that chunk
          // e.g. "36 2/3" "37 1/3" "35.5"
          const cleaned = firstChunk
            .replace(/(EU|IT|US|UK)\s*/i, "")
            .trim();

          if (sizeRegex.test(cleaned)) out.add(cleaned);
        }
      }

      return Array.from(out);
    });

    // sort sizes numerically when possible
    const sorted = sizes
      .map(s => String(s))
      .filter(Boolean)
      .sort((a, b) => {
        const na = parseFloat(a.replace(/\s*\/\s*/g, "."));
        const nb = parseFloat(b.replace(/\s*\/\s*/g, "."));
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return a.localeCompare(b);
      });

    return { brand, available_sizes: sorted };
  } catch {
    return { brand: "", available_sizes: [] };
  } finally {
    await p.close().catch(() => {});
  }
}


async function gotoWithRetry(page, url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`🌐 goto ${i}/${tries}: ${url}`);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});

      return;
    } catch (e) {
      lastErr = e;
      console.log(`⚠️ goto failed ${i}: ${e?.message || e}`);
      await page.waitForTimeout(2500);
    }
  }
  throw lastErr;
}

async function waitForProducts(page) {
  const candidates = [
    '[data-testid="product-card"]',
    'article:has(a[href*="/"])',
    'li:has(a[href*="/"])',
    'main a[href*="/"]:has(img)',
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel);
    try {
      await loc.first().waitFor({ timeout: 45000 });
      const count = await loc.count();
      if (count > 5) return sel;
    } catch {}
  }
  return null;
}

async function scrollToLoad(page, targetCount) {
  let lastCount = 0;

  for (let i = 0; i < SCROLL_STEPS; i++) {
    const cards = await page.$$('[data-testid="product-card"]');
    const count = cards.length;

    if (count >= targetCount) return;

    if (i > 2 && count === lastCount) break;
    lastCount = count;

    await page.mouse.wheel(0, 1800);
    await page.waitForTimeout(1200);
  }
}

/**
 * ✅ PRICE extraction:
 * Only parse lines containing € AND ignore unit-price patterns like:
 * "€0,29 / 100 g", "€1,99 / 100 ml", "€/kg", "€/l"
 */
async function extractPricesFromCard(card) {
  const text = await card.textContent().catch(() => "");
  if (!text) return { price_original: null, price_sale: null };

  const euroLines = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /€/.test(s));

  const filtered = euroLines.filter((line) => {
    const lower = line.toLowerCase();

    // unit price patterns
    if (/(€\s*\/)|(\/\s*€)/.test(lower)) return false;
    if (/\/\s*\d+\s*(ml|g|kg|l)\b/.test(lower)) return false;
    if (/\bper\s*\d+\s*(ml|g|kg|l)\b/.test(lower)) return false;
    if (/\b(\d+)\s*(ml|g|kg|l)\b/.test(lower) && lower.includes("/")) return false;

    return true;
  });

  const prices = [];
  for (const line of filtered) {
    // extract all prices in the line
    const matches = line.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g) || [];
    for (const raw of matches) {
      const val = parseMoney(raw);
      if (val !== null) prices.push(val);
    }
  }

  const uniq = Array.from(new Set(prices)).sort((a, b) => a - b);
  if (uniq.length === 0) return { price_original: null, price_sale: null };
  if (uniq.length === 1) return { price_original: null, price_sale: uniq[0] };

  return { price_original: uniq[uniq.length - 1], price_sale: uniq[0] };
}

async function extractCardData(card, baseUrl, context, allowEnrich) {
  const href = await card.$eval('a[href*="/"]', (a) => a.getAttribute("href")).catch(() => null);
  const product_url = href ? new URL(href, baseUrl).toString() : null;

  const image_url = await card
    .$eval("img", (el) => el.getAttribute("src") || el.getAttribute("data-src"))
    .catch(() => null);

const title =
  safeText(await card.$eval('[data-testid="product-card__title"]', el => el.textContent).catch(() => "")) ||
  safeText(await card.$eval('header h3 span:nth-child(2)', el => el.textContent).catch(() => "")) ||
  safeText(await card.$eval('h3 span:nth-child(2)', el => el.textContent).catch(() => "")) ||
  safeText(await card.$eval("img[alt]", el => el.getAttribute("alt")).catch(() => "")) ||
  safeText(await card.$eval("h3", el => el.textContent).catch(() => ""));


// ✅ BRAND from listing card DOM (Zalando puts it in the first span inside h3)
const brand =
  safeText(await card.$eval('header h3 span:first-child', el => el.textContent).catch(() => "")) ||
  safeText(await card.$eval('h3 span:first-child', el => el.textContent).catch(() => "")) ||
  safeText(await card.$eval('a[href*="/brand/"]', el => el.textContent).catch(() => "")) ||
  "";

  const { price_sale, price_original } = await extractPricesFromCard(card);
  if (!title || !product_url || !price_sale) return null;

  // price sanity
  if (price_sale < MIN_SALE_PRICE) return null;

  // discount
  let discount_percent = 0;
  if (price_original && price_sale && price_original > price_sale) {
    discount_percent = computeDiscount(price_original, price_sale);
  }
  if (discount_percent < MIN_DISCOUNT_PERCENT) return null;

  // enrichment
  let brand_final = brand;
  let available_sizes = [];

  if (ENRICH_SIZES && allowEnrich && context && product_url) {
    const extra = await fetchBrandAndSizes(context, product_url);
    if (extra.brand) brand_final = extra.brand;
    available_sizes = extra.available_sizes || [];
  }

  const id = product_url.split("?")[0];

  return {
    id,
    title,
    brand: brand_final,
    // available_sizes,
    price_sale,
    price_original,
    discount_percent,
    image_url,
    product_url,
    source_category: baseUrl,
    scraped_at: new Date().toISOString(),
  };
}

async function scrapeCategory(page, url, context, maxCards = MAX_ITEMS_PER_CATEGORY) {
  console.log("➡️ Opening:", url);

  try {
    await gotoWithRetry(page, url, 3);
  } catch (e) {
    console.error("❌ NAV FAILED:", url, e?.message || e);
    await debugDump(page, "debug-nav-failed");
    return [];
  }

  await acceptCookies(page);

  const landed = page.url();
  if (/countries|country|available|choose/i.test(landed)) {
    console.log("⚠️ Redirected to country gate:", landed);
    await debugDump(page, "debug-country-gate");
    return [];
  }

  const foundSel = await waitForProducts(page);
  if (!foundSel) {
    console.log("⚠️ No product selector found. Dumping debug.");
    await debugDump(page, "debug-no-products");
    return [];
  }

  await scrollToLoad(page, maxCards);

  let cards = await page.$$('[data-testid="product-card"]');
  if (cards.length === 0) cards = await page.$$('article:has(a[href*="/"])');
  if (cards.length === 0) cards = await page.$$('li:has(a[href*="/"])');

  const results = [];
  let enrichedCount = 0;

  for (const card of cards.slice(0, maxCards)) {
    const allowEnrich = enrichedCount < ENRICH_MAX_PER_CATEGORY;
    const item = await extractCardData(card, url, context, allowEnrich);

    if (item) {
      results.push(item);
      if (ENRICH_SIZES && allowEnrich) enrichedCount += 1;
    }
  }

  if (results.length === 0) {
    console.log("⚠️ Empty results — debug saved.");
    await debugDump(page, "debug-empty");
  }

  console.log(`✅ ${url} → ${results.length} items (enriched: ${Math.min(enrichedCount, ENRICH_MAX_PER_CATEGORY)})`);
  return results;
}

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "it-IT",
    timezoneId: "Europe/Rome",
    geolocation: { latitude: 41.9028, longitude: 12.4964 },
    permissions: ["geolocation"],
  });

  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  const all = [];
  for (const url of CATEGORY_URLS) {
    try {
      const items = await scrapeCategory(page, url, context, MAX_ITEMS_PER_CATEGORY);
      all.push(...items);
    } catch (e) {
      console.error("❌ Failed category:", url, e?.message || e);
    }
  }

  await browser.close();

  // Deduplicate
  const map = new Map();
  for (const p of all) if (!map.has(p.id)) map.set(p.id, p);
  const unique = Array.from(map.values());

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/products.json", JSON.stringify(unique, null, 2), "utf8");

  console.log(`🎉 Saved ${unique.length} products to public/products.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
