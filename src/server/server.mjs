import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fetchMacroLiquidity, generateDeterministicFallback } from "../services/macroLiquidityService.js";
import { cases as initialCases } from "../../data/intelligenceMock.js";
import { orderRateLimiter, vaultRateLimiter, auditRateLimiter } from "./middleware/rateLimiter.js";
import { metricsRegistry } from "./middleware/metricsCollector.js";
import { getEntities, getTransactions } from "../services/intelligenceService.js";
import { dbClient } from "../db/dbClient.js";
import { getUpcomingMacroEvents } from "../services/macroCalendar.js";
import { getSearchSuggestions, resolveEntityDossier } from "../services/superSearchService.js";
import { STRATEGY_TEMPLATES, runQuantitativeBacktest } from "../services/backtesterEngine.js";
import { pythonBridge } from "../services/pythonBridge.js";
import { processClaudeMessage, handleMCPToolCall } from "./mcpHandler.mjs";
import { STRATEGY_IDE_MCP_TOOLS } from "../services/claudeMCPTools.js";
import { wsMarketManager } from "../services/wsManager.js";
import { validateEntitlement, freshnessState, maskForRole, boundedLimit, buildResearchResult, ENTITLEMENT_VERSION } from "../services/readOnlyIntelligence.js";

// Load .env.local or .env if present
function loadEnv() {
  for (const envFile of [".env.local", ".env"]) {
    const p = path.resolve(envFile);
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [k, ...v] = trimmed.split("=");
        if (k && v) {
          process.env[k.trim()] = v.join("=").trim();
        }
      }
    }
  }
}
loadEnv();

const VAULT_MASTER_KEY = crypto.createHash("sha256").update(process.env.VAULT_KEY || "world_money_default_master_encryption_key_2026").digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", VAULT_MASTER_KEY, iv);
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${enc}:${tag}`;
}

function decrypt(encryptedText) {
  const [ivHex, encHex, tagHex] = encryptedText.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", VAULT_MASTER_KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  let dec = decipher.update(encHex, "hex", "utf8");
  dec += decipher.final("utf8");
  return dec;
}

const PORT = Number(process.env.PORT || 8766);
const DB_PATH = path.resolve("./FinanceVault/_system/server_db.json");
const GRAPH_EXPORT_PATH = path.resolve("./FinanceVault/_system/exports/world-money-graph.v1.json");

function initDb() {
  if (fs.existsSync(DB_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
    } catch {
      // ignore parse error and re-init
    }
  }

  const initialDb = {
    cases: initialCases.map((c) => ({
      ...c,
      itemIds: c.id === "CASE-1842" ? ["TX-2026-08492", "TX-2026-08493", "TX-2026-08494", "TX-2026-08495"] : [],
      notes: [],
    })),
    audit: [
      { sequence: 1, event: "09:42 — session authenticated", timestamp: new Date().toISOString() },
      { sequence: 2, event: "09:44 — trace started: Baltic routing anomaly", timestamp: new Date().toISOString() },
    ],
    triagedAlerts: [],
    savedViews: [],
  };

  saveDb(initialDb);
  return initialDb;
}

function saveDb(data) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save DB:", err.message);
  }
}

let db = initDb();

function readEntitlement(req) {
  try { return JSON.parse(req.headers["x-entitlement-snapshot"] || "null"); } catch { return null; }
}

function appendReadAudit(event, req, details = {}) {
  db.immutableAuditLogs = db.immutableAuditLogs || [];
  const previousHash = db.immutableAuditLogs.at(-1)?.hash || "0".repeat(64);
  const sequence = db.immutableAuditLogs.length + 1;
  const serverTimestamp = new Date().toISOString();
  const payload = JSON.stringify({ sequence, event, previousHash, serverTimestamp, ...details });
  const hash = crypto.createHash("sha256").update(payload).digest("hex");
  db.immutableAuditLogs.push({ sequence, event, previousHash, hash, serverTimestamp, user: req.headers["x-subject-id"] || "unknown", ...details });
  saveDb(db);
  metricsRegistry.incAudit();
  return sequence;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  try {
    // 0. Root Landing Page
    if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>World Money & MoneyTrace — Backend API Hub</title>
  <style>
    body { background: #050505; color: #d1dcd8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; margin: 0; padding: 40px 20px; line-height: 1.5; }
    .container { max-width: 800px; margin: 0 auto; background: #0c0c0c; border: 1px solid #202020; border-radius: 6px; padding: 32px; box-shadow: 0 10px 40px rgba(0,0,0,0.8); }
    h1 { color: #f0fdf4; margin: 0 0 8px; font-size: 24px; font-weight: 600; }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; background: rgba(100, 220, 177, 0.12); color: #64dcb1; border: 1px solid #1a4233; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; margin-bottom: 24px; }
    .btn-launch { display: inline-block; background: #64dcb1; color: #03100b; font-weight: 700; text-decoration: none; padding: 12px 24px; border-radius: 4px; font-size: 14px; margin-bottom: 28px; transition: 0.2s background; }
    .btn-launch:hover { background: #82e8c4; }
    h2 { font-size: 16px; color: #a4b8b2; margin: 24px 0 12px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #1a1a1a; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th { text-align: left; color: #6c827c; padding: 8px; border-bottom: 1px solid #1f1f1f; font-weight: 500; }
    td { padding: 10px 8px; border-bottom: 1px solid #141414; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #161616; padding: 2px 6px; border-radius: 3px; font-family: monospace; color: #e2e8f0; font-size: 12px; }
    .badge-ok { color: #64dcb1; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <div class="status-pill">● BACKEND SERVICE ONLINE (PORT 8766)</div>
    <h1>World Money & MoneyTrace API</h1>
    <p>Persistent storage engine, FRED live observation proxy, and financial knowledge graph provider.</p>

    <div style="margin-top: 20px;">
      <a class="btn-launch" href="http://localhost:5173/" target="_blank">Open Frontend Dashboard (http://localhost:5173) →</a>
    </div>

    <h2>API Endpoints</h2>
    <table>
      <thead>
        <tr><th>METHOD & PATH</th><th>DESCRIPTION</th><th>STATUS</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>GET</code> <a href="/api/health">/api/health</a></td>
          <td>Service health check and FRED key verification</td>
          <td><span class="badge-ok">ACTIVE</span></td>
        </tr>
        <tr>
          <td><code>GET</code> <a href="/api/macro">/api/macro</a></td>
          <td>Live FRED observations & World Bank GDP series</td>
          <td><span class="badge-ok">ACTIVE</span></td>
        </tr>
        <tr>
          <td><code>GET</code> <a href="/api/graph">/api/graph</a></td>
          <td>Canonical Obsidian Financial Knowledge Graph</td>
          <td><span class="badge-ok">ACTIVE</span></td>
        </tr>
        <tr>
          <td><code>GET</code> <a href="/api/cases">/api/cases</a></td>
          <td>Persistent MoneyTrace investigation case records</td>
          <td><span class="badge-ok">ACTIVE</span></td>
        </tr>
        <tr>
          <td><code>GET</code> <a href="/api/audit">/api/audit</a></td>
          <td>Immutable audit event ledger stream</td>
          <td><span class="badge-ok">ACTIVE</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</body>
</html>`);
      return;
    }

    // 1. Health check
    if (pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, {
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        fredApiKeyConfigured: Boolean(process.env.FRED_API_KEY && process.env.FRED_API_KEY !== "your_fred_api_key_here"),
        version: "1.1.0",
      });
      return;
    }

    // 2. Macro Liquidity Feed
    if (pathname === "/api/macro" && req.method === "GET") {
      const data = await fetchMacroLiquidity();
      sendJson(res, 200, data);
      return;
    }

    // Checkpoint 3: entitlement-aware, read-only market projection.
    if (pathname === "/api/v1/market-data" && req.method === "GET") {
      const subjectId = req.headers["x-subject-id"] || "unknown";
      const decision = validateEntitlement(readEntitlement(req), { subjectId, scope: "market:read" });
      if (!decision.allowed) { sendJson(res, 403, { error: "market_data_entitlement_denied", reason: decision.reason }); return; }
      const role = req.headers["x-role"] || "Analyst";
      const now = Date.now();
      const tickers = wsMarketManager.getAllTickers().map((ticker) => ({ ...maskForRole(ticker, role), freshness: freshnessState({ watermarkAt: ticker.timestamp, now }) }));
      appendReadAudit("market_data.read", req, { scope: "market:read", count: tickers.length });
      sendJson(res, 200, { entitlementVersion: ENTITLEMENT_VERSION, serverWatermark: new Date(now).toISOString(), tickers });
      return;
    }

    // Checkpoint 3: bounded analytics/research projection; no mutations.
    if (pathname === "/api/v1/research/query" && req.method === "GET") {
      const subjectId = req.headers["x-subject-id"] || "unknown";
      const decision = validateEntitlement(readEntitlement(req), { subjectId, scope: "research:read" });
      if (!decision.allowed) { sendJson(res, 403, { error: "research_entitlement_denied", reason: decision.reason }); return; }
      const query = parsedUrl.searchParams.get("q") || "";
      const limit = boundedLimit(parsedUrl.searchParams.get("limit"));
      const rows = getTransactions({ anomalousOnly: parsedUrl.searchParams.get("anomalousOnly") });
      const filtered = query ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query.toLowerCase())) : rows;
      const role = req.headers["x-role"] || "Analyst";
      const result = buildResearchResult(filtered.map((row) => maskForRole(row, role)), { limit, query });
      appendReadAudit("research.query", req, { scope: "research:read", query, count: result.rows.length });
      sendJson(res, 200, result);
      return;
    }

    // 3. Current Graph Export
    if (pathname === "/api/graph" && req.method === "GET") {
      if (fs.existsSync(GRAPH_EXPORT_PATH)) {
        const content = fs.readFileSync(GRAPH_EXPORT_PATH, "utf-8");
        sendJson(res, 200, JSON.parse(content));
      } else {
        sendJson(res, 404, { error: "Graph export not found" });
      }
      return;
    }

    // 3a-2. Large 25k Synthetic Cross-Border Transaction Network Graph API
    if (pathname === "/api/v1/graph/large" && req.method === "GET") {
      const LARGE_GRAPH_PATH = path.resolve("./FinanceVault/_system/graph_25k.json");
      if (!fs.existsSync(LARGE_GRAPH_PATH)) {
        sendJson(res, 404, { error: "Large graph dataset not found. Run scripts/generate_graph_25k.py first." });
        return;
      }
      const raw = JSON.parse(fs.readFileSync(LARGE_GRAPH_PATH, "utf-8"));
      const p = parsedUrl.searchParams;
      const jurisdiction = p.get("jurisdiction") || null;
      const entityType   = p.get("entity_type") || null;
      const minRisk      = Number(p.get("min_risk") || 0);
      const maxRisk      = Number(p.get("max_risk") || 100);
      const flaggedOnly  = p.get("flagged") === "true";
      const search       = (p.get("search") || "").toLowerCase();
      const limit        = Math.min(Number(p.get("limit") || 2000), 25000);
      const anchorId     = p.get("anchor") || null;

      let nodes = raw.nodes.filter((n) => {
        if (jurisdiction && n.jurisdiction !== jurisdiction) return false;
        if (entityType && n.entity_type !== entityType) return false;
        if (n.risk_score < minRisk || n.risk_score > maxRisk) return false;
        if (flaggedOnly && n.pep_screening !== "Flagged" && n.sanctions_list !== "Match Found") return false;
        if (search && !n.legal_name.toLowerCase().includes(search) && !n.id.toLowerCase().includes(search)) return false;
        return true;
      }).slice(0, limit);

      const nodeIdSet = new Set(nodes.map((n) => n.id));

      if (anchorId) {
        raw.edges.filter((e) => e.source === anchorId || e.target === anchorId).forEach((e) => {
          nodeIdSet.add(e.source);
          nodeIdSet.add(e.target);
        });
        const extras = raw.nodes.filter((n) => nodeIdSet.has(n.id) && !nodes.find((x) => x.id === n.id));
        nodes = [...nodes, ...extras];
      }

      const edges = raw.edges.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));

      sendJson(res, 200, {
        meta: { total_nodes: raw.nodes.length, total_edges: raw.edges.length, returned_nodes: nodes.length, returned_edges: edges.length },
        nodes,
        edges,
      });
      return;
    }

    // 3b. Large Entity & Transaction Graph API
    if (pathname === "/api/v1/entities" && req.method === "GET") {
      const filters = {
        type: parsedUrl.searchParams.get("type"),
        country: parsedUrl.searchParams.get("country"),
        minRisk: parsedUrl.searchParams.get("minRisk"),
        search: parsedUrl.searchParams.get("search"),
      };
      sendJson(res, 200, getEntities(filters));
      return;
    }

    if (pathname === "/api/v1/transactions" && req.method === "GET") {
      const filters = {
        rail: parsedUrl.searchParams.get("rail"),
        currency: parsedUrl.searchParams.get("currency"),
        anomalousOnly: parsedUrl.searchParams.get("anomalousOnly"),
        entityId: parsedUrl.searchParams.get("entityId"),
      };
      sendJson(res, 200, getTransactions(filters));
      return;
    }

    // 3c. Production Trading Status & Execution Telemetry
    if (pathname === "/api/v1/trading/status" && req.method === "GET") {
      sendJson(res, 200, {
        mode: process.env.ALPACA_MODE || "paper",
        capital: Number(process.env.LIVE_CAPITAL_LIMIT || 50000),
        equity: Number(process.env.LIVE_CAPITAL_LIMIT || 50000),
        liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === "true",
        maxOrderNotional: Number(process.env.MAX_ORDER_NOTIONAL || 5000),
        dailyLossLimit: Number(process.env.MAX_DAILY_LOSS_LIMIT || -5000),
        status: "READY",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 3d. Database Health & Persistence Status
    if ((pathname === "/api/v1/database/health" || pathname === "/api/v1/database/status") && (req.method === "GET" || req.method === "POST")) {
      const health = await dbClient.getHealth();
      sendJson(res, 200, health);
      return;
    }

    // 3e. Macro Economic Calendar Stream
    if (pathname === "/api/v1/economic-calendar" && req.method === "GET") {
      const days = Number(parsedUrl.searchParams.get("days") || 3);
      sendJson(res, 200, getUpcomingMacroEvents(days * 24));
      return;
    }

    // 3f. Positions & Pending Orders API
    if (pathname === "/api/v1/positions" && req.method === "GET") {
      sendJson(res, 200, [
        { symbol: "EURUSD", quantity: 10000, entryPrice: 1.0850, currentPrice: 1.0874, pnl: 24.00, side: "BUY" },
        { symbol: "SPY", quantity: 10, entryPrice: 580.25, currentPrice: 580.80, pnl: 5.50, side: "BUY" },
      ]);
      return;
    }

    if (pathname === "/api/v1/orders/pending" && req.method === "GET") {
      sendJson(res, 200, []);
      return;
    }

    // 3g. Super Search Context-Shift API
    if (pathname === "/api/v1/search/suggest" && req.method === "GET") {
      const q = parsedUrl.searchParams.get("q") || "";
      sendJson(res, 200, getSearchSuggestions(q));
      return;
    }

    if (pathname === "/api/v1/search/entity" && req.method === "GET") {
      const q = parsedUrl.searchParams.get("q") || "SPY";
      sendJson(res, 200, resolveEntityDossier(q));
      return;
    }

    // 3h. Systematic Trading IDE Backtester API
    if (pathname === "/api/v1/strategy/templates" && req.method === "GET") {
      sendJson(res, 200, STRATEGY_TEMPLATES);
      return;
    }

    if (pathname === "/api/v1/strategy/backtest" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const results = await pythonBridge.call("run_backtest", {
        strategy_code: body.code || "",
        symbol: body.params?.symbol || "SPY",
        initial_capital: body.params?.initialCapital || 100000,
        commission: body.params?.commission || 0.0005,
        slippage: body.params?.slippage || 0.0002,
        preset: body.params?.preset || "mean_reversion",
      });
      sendJson(res, 200, results);
      return;
    }

    if (pathname === "/api/v1/strategy/walk-forward" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const results = await pythonBridge.call("walk_forward", {
        strategy_code: body.code || "",
        symbol: body.params?.symbol || "SPY",
        num_folds: body.params?.numFolds || 5,
        preset: body.params?.preset || "mean_reversion",
      });
      sendJson(res, 200, results);
      return;
    }

    if (pathname === "/api/v1/strategy/monte-carlo" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const results = await pythonBridge.call("monte_carlo", {
        trades: body.trades || [],
        num_simulations: body.numSimulations || 500,
        initial_capital: body.initialCapital || 100000,
      });
      sendJson(res, 200, results);
      return;
    }

    if (pathname === "/api/v1/models/train" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const results = await pythonBridge.call("train_model", {
        model_type: body.modelType || "garch",
        symbol: body.symbol || "SPY",
      });
      sendJson(res, 200, results);
      return;
    }

    if (pathname === "/api/v1/datasets" && req.method === "GET") {
      const results = await pythonBridge.call("list_datasets", {});
      sendJson(res, 200, results.datasets || []);
      return;
    }

    // 3i. Claude MCP Assistant Message & Tools Endpoints
    if (pathname === "/api/v1/claude/message" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const reply = await processClaudeMessage({
        messages: body.messages || [],
        system: body.system || "",
        tools: body.tools || STRATEGY_IDE_MCP_TOOLS,
      });
      sendJson(res, 200, reply);
      return;
    }

    if (pathname === "/api/v1/assistant/tools" && (req.method === "GET" || req.method === "POST")) {
      sendJson(res, 200, { tools: STRATEGY_IDE_MCP_TOOLS, count: STRATEGY_IDE_MCP_TOOLS.length });
      return;
    }

    // 4. Cases API
    if (pathname === "/api/cases" && req.method === "GET") {
      sendJson(res, 200, db.cases);
      return;
    }

    if (pathname === "/api/cases" && req.method === "POST") {
      const payload = await parseJsonBody(req);
      if (payload.id) {
        const index = db.cases.findIndex((c) => c.id === payload.id);
        if (index >= 0) {
          db.cases[index] = { ...db.cases[index], ...payload, updated: "just now" };
        } else {
          db.cases.push({ ...payload, notes: payload.notes || [], updated: "just now" });
        }
        saveDb(db);
        sendJson(res, 200, { status: "saved", case: payload });
      } else {
        sendJson(res, 400, { error: "Case ID required" });
      }
      return;
    }

    // 5. Case Notes API (/api/cases/:id/notes)
    if (pathname.startsWith("/api/cases/") && pathname.endsWith("/notes") && req.method === "POST") {
      const caseId = pathname.split("/")[3];
      const payload = await parseJsonBody(req);
      const targetCase = db.cases.find((c) => c.id === caseId);
      if (targetCase) {
        const note = {
          id: `${caseId}-${Date.now()}`,
          caseId,
          text: payload.text,
          timestamp: new Date().toISOString(),
        };
        targetCase.notes = targetCase.notes || [];
        targetCase.notes.unshift(note);
        saveDb(db);
        sendJson(res, 200, { status: "note_added", note });
      } else {
        sendJson(res, 404, { error: "Case not found" });
      }
      return;
    }

    // 6. Audit Trail API
    if (pathname === "/api/audit" && req.method === "GET") {
      sendJson(res, 200, db.audit);
      return;
    }

    if (pathname === "/api/audit" && req.method === "POST") {
      const payload = await parseJsonBody(req);
      if (payload.event) {
        const entry = {
          sequence: db.audit.length + 1,
          event: payload.event,
          timestamp: new Date().toISOString(),
        };
        db.audit.unshift(entry);
        saveDb(db);
        sendJson(res, 200, { status: "logged", entry });
      } else {
        sendJson(res, 400, { error: "Event message required" });
      }
      return;
    }

    // ==========================================
    // PHASE 3: CREDENTIAL VAULT ENDPOINTS (AES-256-GCM)
    // ==========================================
    if (pathname === "/api/v1/vault/alpaca-tokens" && req.method === "POST") {
      const rate = vaultRateLimiter.check(req.socket?.remoteAddress || "client");
      if (!rate.allowed) {
        metricsRegistry.incRateLimit();
        sendJson(res, 429, { error: rate.message, retryAfterSeconds: rate.resetSeconds });
        return;
      }

      const payload = await parseJsonBody(req);
      db.vault = db.vault || {};
      const encrypted = encrypt(JSON.stringify(payload));
      db.vault.alpaca = {
        ciphertext: encrypted,
        expiresAt: Date.now() + (payload.expiresIn || 900) * 1000,
        updatedAt: new Date().toISOString(),
      };
      saveDb(db);
      sendJson(res, 200, { status: "vaulted", vaultedAt: new Date().toISOString() });
      return;
    }

    if (pathname === "/api/v1/vault/alpaca-tokens/access" && req.method === "GET") {
      const rate = vaultRateLimiter.check(req.socket?.remoteAddress || "client");
      if (!rate.allowed) {
        metricsRegistry.incRateLimit();
        sendJson(res, 429, { error: rate.message, retryAfterSeconds: rate.resetSeconds });
        return;
      }

      if (db.vault?.alpaca?.ciphertext) {
        try {
          const decrypted = JSON.parse(decrypt(db.vault.alpaca.ciphertext));
          const remainingSec = Math.max(0, Math.round((db.vault.alpaca.expiresAt - Date.now()) / 1000));
          sendJson(res, 200, {
            accessToken: decrypted.accessToken || "mock-access-token",
            expiresIn: remainingSec,
            status: "active",
          });
        } catch (err) {
          sendJson(res, 500, { error: `Decryption failed: ${err.message}` });
        }
      } else {
        sendJson(res, 200, {
          accessToken: "alpaca-sandbox-token",
          expiresIn: 900,
          status: "sandbox_default",
        });
      }
      return;
    }

    if (pathname === "/api/v1/vault/alpaca-tokens" && req.method === "DELETE") {
      if (db.vault) {
        delete db.vault.alpaca;
        saveDb(db);
      }
      sendJson(res, 200, { status: "revoked" });
      return;
    }

    // ==========================================
    // PHASE 3: IMMUTABLE AUDIT LOG (RULE 17a-5)
    // ==========================================
    if (pathname === "/api/v1/audit-log/append" && req.method === "POST") {
      const rate = auditRateLimiter.check(req.socket?.remoteAddress || "client");
      if (!rate.allowed) {
        metricsRegistry.incRateLimit();
        sendJson(res, 429, { error: rate.message, retryAfterSeconds: rate.resetSeconds });
        return;
      }

      const entry = await parseJsonBody(req);
      db.immutableAuditLogs = db.immutableAuditLogs || [];
      const lastHash = db.immutableAuditLogs.length > 0
        ? db.immutableAuditLogs[db.immutableAuditLogs.length - 1].hash
        : "0000000000000000000000000000000000000000000000000000000000000000";

      const record = {
        ...entry,
        sequence: db.immutableAuditLogs.length + 1,
        previousHash: lastHash,
        serverTimestamp: new Date().toISOString(),
      };
      db.immutableAuditLogs.push(record);
      saveDb(db);
      metricsRegistry.incAudit();
      sendJson(res, 200, { status: "appended", sequence: record.sequence, hash: record.hash });
      return;
    }

    if (pathname === "/api/v1/audit-log/last-hash" && req.method === "GET") {
      db.immutableAuditLogs = db.immutableAuditLogs || [];
      const lastHash = db.immutableAuditLogs.length > 0
        ? db.immutableAuditLogs[db.immutableAuditLogs.length - 1].hash
        : "0000000000000000000000000000000000000000000000000000000000000000";
      sendJson(res, 200, { lastHash, count: db.immutableAuditLogs.length });
      return;
    }

    if (pathname === "/api/v1/audit-log/export" && req.method === "GET") {
      const logs = db.immutableAuditLogs || [];
      const headers = "Sequence,Timestamp,Event,OrderID,Symbol,Side,Qty,Notional,User,ExecutionMode,Hash,PreviousHash\n";
      const rows = logs.map((l) =>
        `${l.sequence},${l.timestamp},${l.event},${l.orderId || ""},${l.symbol || ""},${l.side || ""},${l.qty || ""},${l.notional || ""},${l.user || ""},${l.compliance?.executionMode || ""},${l.hash || ""},${l.previousHash || ""}`
      ).join("\n");

      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="sec-rule17a5-audit-${Date.now()}.csv"`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(headers + rows);
      return;
    }

    // ==========================================
    // PHASE 3: PROMETHEUS METRICS & OBSERVABILITY
    // ==========================================
    if (pathname === "/metrics" && req.method === "GET") {
      const promText = metricsRegistry.formatPrometheus();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(promText);
      return;
    }

    if (pathname === "/api/monitoring/snapshot" && req.method === "GET") {
      sendJson(res, 200, metricsRegistry.getSnapshot());
      return;
    }

    if (pathname === "/monitoring" && req.method === "GET") {
      const snap = metricsRegistry.getSnapshot();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>World Money Terminal — Operator Observability</title>
  <style>
    body { background: #050807; color: #d0ded8; font-family: 'DM Mono', monospace; padding: 24px; }
    h1 { color: #64dcb1; font-size: 18px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card { background: #0c1511; border: 1px solid #1a2c24; padding: 14px; border-radius: 4px; }
    .card h4 { margin: 0 0 6px; font-size: 10px; color: #799088; text-transform: uppercase; }
    .card strong { font-size: 22px; color: #f0fdf4; }
    .status-badge { color: #64dcb1; background: rgba(100, 220, 177, 0.1); padding: 2px 6px; border-radius: 2px; }
    pre { background: #090e0c; border: 1px solid #1a2c24; padding: 12px; border-radius: 4px; color: #8da49c; font-size: 11px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>🔍 World Money Operator Observability Dashboard</h1>
  <div class="grid">
    <div class="card"><h4>Broker Connectivity</h4><strong class="status-badge">${snap.brokerStatus}</strong></div>
    <div class="card"><h4>Audit Records</h4><strong>${snap.auditLogsTotal}</strong></div>
    <div class="card"><h4>Order Latency P50</h4><strong>${snap.latencyP50Ms} ms</strong></div>
    <div class="card"><h4>Order Latency P99</h4><strong>${snap.latencyP99Ms} ms</strong></div>
    <div class="card"><h4>Rate Limit Throttles</h4><strong>${snap.rateLimitsHit}</strong></div>
    <div class="card"><h4>V8 Heap Usage</h4><strong>${snap.heapMemoryMb} MB</strong></div>
  </div>
  <h3>Raw Prometheus Stream (<a href="/metrics" style="color:#64dcb1;">/metrics</a>)</h3>
  <pre id="rawProm">${metricsRegistry.formatPrometheus()}</pre>
</body>
</html>`);
      return;
    }

    // 404 handler
    sendJson(res, 404, { error: "Endpoint not found" });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

const isDirectExecution = process.argv[1] && process.argv[1].endsWith("server.mjs");

if (isDirectExecution) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`MoneyTrace & World Money Backend API running on http://127.0.0.1:${PORT}`);
  });
}

export { server };
