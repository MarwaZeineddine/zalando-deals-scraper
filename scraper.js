import { chromium } from "playwright";
import fs from "fs";

const CATEGORY_URLS = [
  "https://www.zalando.com/womens-shoes-sneakers/",
  "https://www.zalando.com/womens-clothing-dresses/",
  "https://www.zalando.com/mens-shoes-sneakers/"
];

function safeText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function parseMoney(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.,]/g, "");
  let t = cleaned;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma > lastDot) {
    t = t.replace(/\./g, "").replace(",", ".");
  } else {
    t = t.replace(/,/g, "");
  }
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function computeDiscount(original, sale) {
  if (!original || !sale || original <= 0) return 0;
  return Math.round(((original - sale) / original) * 100);
}

async function scrapeCategory(page, url, maxCards = 80) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);

  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1200);
  }

  const cards = await page.$$('[data-testid="product-card"]');
  const results = [];

  for (const card of cards.slice(0, maxCards)) {
    const title = safeText(
      await card.$eval('[data-testid="product-card__title"]', el => el.textContent).catch(() => "")
    );
    const brand = safeText(
      await card.$eval('[data-testid="product-card__brand"]', el => el.textContent).catch(() => "")
    );

    const href = await card.$eval('a[href]', a => a.getAttribute("href")).catch(() => null);
    const product_url = href ? new URL(href, url).toString() : null;

    const image_url = await card
      .$eval("img", el => el.getAttribute("src") || el.getAttribute("data-src"))
      .catch(() => null);

    const priceText =
      (await card.$eval('[data-testid="product-card__price"]', el => el.textContent).catch(() => "")) ||
      (await card.textContent().catch(() => ""));

    const nums = (priceText.match(/[\d.,]+/g) || []).slice(0, 2).map(parseMoney);
    const price_sale = nums[0] ?? null;
    const price_original = nums[1] ?? null;

    const discount_percent = computeDiscount(price_original, price_sale);

    if (!title || !product_url || !price_sale) continue;

    const id = product_url.split("?")[0];

    results.push({
      id,
      title,
      brand,
      price_sale,
      price_original,
      discount_percent,
      image_url,
      product_url,
      source_category: url,
      scraped_at: new Date().toISOString()
    });
  }

  return results;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  });
  await page.setViewportSize({ width: 1366, height: 768 });

  const all = [];
  for (const url of CATEGORY_URLS) {
    try {
      const items = await scrapeCategory(page, url);
      all.push(...items);
    } catch (e) {
      console.error("Failed category:", url, e?.message || e);
    }
  }

  await browser.close();

  const map = new Map();
  for (const p of all) {
    if (!map.has(p.id)) map.set(p.id, p);
  }
  const unique = Array.from(map.values());

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/products.json", JSON.stringify(unique, null, 2), "utf8");

  console.log(`Saved ${unique.length} products`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
