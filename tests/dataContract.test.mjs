import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { generateDeterministicFallback, MACRO_SERIES_CONFIG } from "../src/services/macroLiquidityService.js";
import { PAYMENT_RAILS_DATA } from "../data/paymentRailsData.js";
import { CENTRAL_BANKS_DATA } from "../data/centralBanksData.js";
import { server } from "../src/server/server.mjs";

test("Macro Liquidity Service fallback generator produces required series", () => {
  const fallback = generateDeterministicFallback();
  assert.equal(fallback.source, "demo");
  assert.ok(Array.isArray(fallback.gdp));
  assert.ok(fallback.gdp.length >= 5);

  for (const config of MACRO_SERIES_CONFIG) {
    const series = fallback.series[config.key];
    assert.ok(Array.isArray(series), `Series ${config.key} should be an array`);
    assert.ok(series.length > 0, `Series ${config.key} should have data points`);
    assert.ok(series[0].date, `Data point in ${config.key} should have a date`);
    assert.ok(typeof series[0].value === "number", `Data point in ${config.key} should have numeric value`);
  }
});

test("Payment Rails dataset contains major global clearing systems with valid fields", () => {
  assert.ok(PAYMENT_RAILS_DATA.length >= 15, "Expected at least 15 payment rails");
  const requiredRails = [
    "SWIFT", "FEDWIRE", "CHIPS", "TARGET2", "SEPA_INSTANT", "UPI", "CIPS", "PIX", "FEDNOW", "CHAPS",
    "SPEI", "PROMPTPAY", "FAST", "SARIE", "NPP", "T2S"
  ];

  const railIds = new Set(PAYMENT_RAILS_DATA.map((r) => r.id));
  for (const req of requiredRails) {
    assert.ok(railIds.has(req), `Expected rail ${req} in dataset`);
  }

  for (const rail of PAYMENT_RAILS_DATA) {
    assert.ok(rail.name);
    assert.ok(rail.operator);
    assert.ok(rail.currency);
    assert.ok(rail.type);
    assert.ok(rail.hours);
    assert.ok(rail.avgDailyVol);
  }
});

test("Central Banks dataset contains major monetary authorities with valid policy rates", () => {
  assert.ok(CENTRAL_BANKS_DATA.length >= 18, "Expected at least 18 central banks");
  const majorCurrencies = [
    "USD", "EUR", "GBP", "JPY", "CNY", "INR", "CHF", "CAD", "AUD", "BRL",
    "KRW", "MXN", "SAR", "AED", "SGD", "NZD", "NOK", "SEK", "ZAR", "TRY"
  ];

  const currencies = new Set(CENTRAL_BANKS_DATA.map((cb) => cb.currency));
  for (const curr of majorCurrencies) {
    assert.ok(currencies.has(curr), `Expected central bank currency ${curr} in dataset`);
  }

  for (const cb of CENTRAL_BANKS_DATA) {
    assert.ok(cb.institution);
    assert.ok(cb.country);
    assert.ok(typeof cb.rate === "number");
    assert.ok(typeof cb.fxUsd === "number" && cb.fxUsd > 0);
    assert.ok(cb.mandate);
    assert.ok(cb.cbdc);
  }
});

test("Exported canonical relationship graph conforms to schema v1.0", () => {
  const exportPath = path.resolve("./FinanceVault/_system/exports/world-money-graph.v1.json");
  if (fs.existsSync(exportPath)) {
    const raw = fs.readFileSync(exportPath, "utf-8");
    const json = JSON.parse(raw);
    assert.equal(json.schema_version, "1.0");
    assert.ok(Array.isArray(json.nodes));
    assert.ok(Array.isArray(json.links));
    assert.ok(json.nodes.length > 50);
  }
});
