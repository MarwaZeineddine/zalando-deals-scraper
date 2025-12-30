import { chromium } from "playwright";
import fs from "fs";

const CATEGORY_URLS = [
  "https://www.zalando.it/promo-sneakers-uomo/"
  
];

const MAX_ITEMS_PER_CATEGORY = 80;
const SCROLL_STEPS = 10;

function safeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Parse "€107,99" / "107,99" / "1.234,56" etc
function parseMoney(text) {
  if (!text) return null;

  const m = text.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
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
        await page.waitForTimeout(1000);
        return true;
      }
    }
    return false;
  } catch {
    return false;
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
 * ✅ PRICE EXTRACTION THAT AVOIDS UNIT PRICES مثل:
 * "€0,29 / 100 g" , "€1,99 / 100 ml" , "€/kg" ...
 */
async function extractPricesFromCard(card) {
  const text = await card.textContent().catch(() => "");
  if (!text) return { price_original: null, price_sale: null };

  // Keep only lines with €
  const euroLines = text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.includes("€"));

  // Remove unit-price lines
  const filtered = euroLines.filter((line) => {
    const lower = line.toLowerCase();

    // If it contains "/ 100", "/100", "€/kg", "€/l", "per 100", etc => unit price
    if (lower.includes("/")) return false;
    if (/\b(100)\b/.test(lower) && /\b(ml|g|kg|l)\b/.test(lower)) return false;
    if (/\b(ml|g|kg|l)\b/.test(lower) && lower.includes("€")) {
      // many unit prices include both € and units
      return false;
    }
    return true;
  });

  // Extract all price numbers from remaining lines
  const prices = [];
  for (const line of filtered) {
    const matches = line.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/g) || [];
    for (const raw of matches) {
      const val = parseMoney(raw);
      if (val !== null) prices.push(val);
    }
  }

  const uniq = Array.from(new Set(prices));
  uniq.sort((a, b) => a - b); // ascending

  if (uniq.length === 0) return { price_original: null, price_sale: null };
  if (uniq.length === 1) return { price_original: null, price_sale: uniq[0] };

  // lowest = sale, highest = original
  return { price_original: uniq[uniq.length - 1], price_sale: uniq[0] };
}

async function extractCardData(card, baseUrl) {
  const href = await card.$eval('a[href*="/"]', (a) => a.getAttribute("href")).catch(() => null);
  const product_url = href ? new URL(href, baseUrl).toString() : null;

  const image_url = await card
    .$eval("img", (el) => el.getAttribute("src") || el.getAttribute("data-src"))
    .catch(() => null);

  const title =
    safeText(await card.$eval('[data-testid="product-card__title"]', (el) => el.textContent).catch(() => "")) ||
    safeText(await card.$eval("img[alt]", (el) => el.getAttribute("alt")).catch(() => "")) ||
    safeText(await card.$eval("h3", (el) => el.textContent).catch(() => ""));

  const brand =
    safeText(await card.$eval('[data-testid="product-card__brand"]', (el) => el.textContent).catch(() => "")) || "";

  const { price_sale, price_original } = await extractPricesFromCard(card);
  const discount_percent = computeDiscount(price_original, price_sale);

  if (!title || !product_url || !price_sale) return null;

  const id = product_url.split("?")[0];

  return {
    id,
    title,
    brand,
    price_sale,
    price_original,
    discount_percent,
    image_url,
    product_url,
    source_category: baseUrl,
    scraped_at: new Date().toISOString(),
  };
}

async function scrapeCategory(page, url, maxCards = MAX_ITEMS_PER_CATEGORY) {
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
  for (const card of cards.slice(0, maxCards)) {
    const item = await extractCardData(card, url);
    if (item) results.push(item);
  }

  if (results.length === 0) {
    console.log("⚠️ Empty results — debug saved.");
    await debugDump(page, "debug-empty");
  }

  console.log(`✅ ${url} → ${results.length} items`);
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
      const items = await scrapeCategory(page, url, MAX_ITEMS_PER_CATEGORY);
      all.push(...items);
    } catch (e) {
      console.error("❌ Failed category:", url, e?.message || e);
    }
  }

  await browser.close();

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
