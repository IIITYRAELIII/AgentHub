import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "./state-store.mjs";

export const CBR_DAILY_RATES_URL = "https://www.cbr.ru/scripts/XML_daily.asp";
export const CREDITS_PER_USD = 25;
export const PTE_PER_CREDIT = 8_000;

function positiveRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function isoRateDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(String(value ?? "").trim());
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

export function parseCbrDailyRatesXml(value) {
  const text = String(value ?? "");
  const block = (text.match(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/giu) ?? [])
    .find((candidate) => /<CharCode>\s*USD\s*<\/CharCode>/iu.test(candidate));
  if (!block) throw new Error("CBR response does not contain the USD rate");
  const nominal = Number(block.match(/<Nominal>\s*([^<]+)\s*<\/Nominal>/iu)?.[1]);
  const quoted = Number(
    String(block.match(/<Value>\s*([^<]+)\s*<\/Value>/iu)?.[1] ?? "")
      .replace(",", "."),
  );
  const usdRub = positiveRate(quoted / nominal);
  if (!usdRub) throw new Error("CBR response contains an invalid USD rate");
  const effectiveDate = isoRateDate(
    text.match(/<ValCurs\b[^>]*\bDate="([^"]+)"/iu)?.[1],
  );
  return {
    usdRub,
    effectiveDate,
    source: "cbr",
    sourceUrl: CBR_DAILY_RATES_URL,
  };
}

function validSnapshot(value) {
  const usdRub = positiveRate(value?.usdRub);
  if (!usdRub) return null;
  return {
    usdRub,
    effectiveDate: String(value?.effectiveDate ?? "").trim() || null,
    fetchedAt: String(value?.fetchedAt ?? "").trim() || null,
    source: "cbr",
    sourceUrl: CBR_DAILY_RATES_URL,
  };
}

export class UsdRubRateStore {
  #cacheFile;
  #fetch;
  #timeoutMs;
  #now;
  #value = null;

  constructor({
    cacheFile,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5_000,
    now = () => new Date(),
  }) {
    this.#cacheFile = cacheFile;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  async load() {
    try {
      this.#value = validSnapshot(JSON.parse(await readFile(this.#cacheFile, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return this.snapshot();
  }

  async refresh() {
    if (typeof this.#fetch !== "function") throw new Error("Fetch API is unavailable");
    const response = await this.#fetch(CBR_DAILY_RATES_URL, {
      headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.1" },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`CBR rate request failed: HTTP ${response.status}`);
    // XML_daily.asp is historically Windows-1251. Tags, USD and numeric values
    // are ASCII, so latin1 preserves every character needed by the parser.
    const xml = Buffer.from(await response.arrayBuffer()).toString("latin1");
    this.#value = {
      ...parseCbrDailyRatesXml(xml),
      fetchedAt: this.#now().toISOString(),
    };
    await mkdir(path.dirname(this.#cacheFile), { recursive: true });
    await writeTextAtomic(this.#cacheFile, `${JSON.stringify(this.#value, null, 2)}\n`);
    return this.snapshot();
  }

  snapshot() {
    return this.#value ? { ...this.#value } : null;
  }
}
