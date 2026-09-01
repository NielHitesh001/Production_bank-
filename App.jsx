import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import BloombergBlotter from "./components/BloombergBlotter";
import CentralBankPolicyHub from "./components/CentralBankPolicyHub";
import ConnectionFinder from "./components/ConnectionFinder";
import EntityGraph from "./components/EntityGraph";
import FxPolicyConverter from "./components/FxPolicyConverter";
import MacroLiquidityPanel from "./components/MacroLiquidityPanel";
import NetworkCanvas from "./components/NetworkCanvas";
import PaymentRailsMatrix from "./components/PaymentRailsMatrix";
import CommandPalette from "./components/Terminal/CommandPalette.jsx";
import LiveTickerRibbon from "./components/Terminal/LiveTickerRibbon.jsx";
import TerminalWorkspace from "./components/Terminal/TerminalWorkspace.jsx";
import SuperSearchBar from "./components/Terminal/SuperSearchBar.jsx";
import { cases as initialCases, entities as initialEntities, transactions as initialTransactions } from "./data/intelligenceMock";
import { findBidirectionalPath, findDirectedPath, parseCsv } from "./lib/investigationUtils.mjs";
import { addCaseNoteApi, checkServerHealth, fetchCasesApi, logAuditEventApi, syncCaseApi } from "./src/services/apiClient.js";
import "./styles.css";

const formats = { entity: "Entity", transaction: "Transaction" };
const riskLabel = (risk) => (risk >= 80 ? "Critical" : risk >= 55 ? "Elevated" : "Standard");
const roles = ["Analyst", "Investigator", "Admin"];
const MAX_RENDERED_NODES = 2_000;
const MAX_RENDERED_EDGES = 5_000;

const formatDisplayAmount = (amount, currency) => `${currency === "USD" ? "$" : ""}${(Number(amount) / 1_000_000).toFixed(2)}M`;

const validateEntity = (entity, index) => {
  const missing = ["id", "name", "country"].filter((field) => !entity[field]);
  if (missing.length) return `Entity ${index + 1}: missing ${missing.join(", ")}`;
  if (!/^[A-Z]{2}$/.test(entity.country)) return `Entity ${index + 1}: country must be ISO 3166-1 alpha-2`;
  if (entity.lei && !/^[A-Z0-9]{20}$/.test(entity.lei)) return `Entity ${index + 1}: LEI must be 20 uppercase alphanumeric characters`;
  if (entity.bic && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(entity.bic)) return `Entity ${index + 1}: BIC must be 8 or 11 characters`;
  return null;
};

const maskIdentifier = (value) => {
  if (!value || value.length <= 6) return value || "—";
  return `${value.slice(0, 4)}••••${value.slice(-2)}`;
};

const savedViewStorageKey = "moneytrace.saved-views.v1";

function loadSavedViews() {
  try {
    const stored = window.localStorage.getItem(savedViewStorageKey);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("terminal"); // "terminal" | "liquidity" | "investigate"
  const [liquiditySubView, setLiquiditySubView] = useState("macro"); // "macro" | "rails" | "centralbanks" | "converter" | "network"
  const [investigationViewMode, setInvestigationViewMode] = useState("graph"); // "graph" | "blotter"
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [serverOnline, setServerOnline] = useState(false);
  const [focusedSymbol, setFocusedSymbol] = useState("EUR/USD");
  const [focusedEntityDossier, setFocusedEntityDossier] = useState(null);

  const [workspace, setWorkspace] = useState({ entities: initialEntities, transactions: initialTransactions });
  const [query, setQuery] = useState("");
  const [minimumRisk, setMinimumRisk] = useState(0);
  const [currency, setCurrency] = useState("All currencies");
  const [dateWindow, setDateWindow] = useState("All dates");
  const [minimumAmount, setMinimumAmount] = useState(0);
  const [crossBorderOnly, setCrossBorderOnly] = useState(true);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selected, setSelected] = useState({ type: "transaction", value: "TX-2026-08494" });
  const [traceMode, setTraceMode] = useState(true);
  const [traceOrigin, setTraceOrigin] = useState("JPM-US");
  const [audit, setAudit] = useState(["09:42 — session authenticated", "09:44 — trace started: Baltic routing anomaly"]);
  const [activeCaseId, setActiveCaseId] = useState("CASE-1842");
  const [caseItems, setCaseItems] = useState(() =>
    initialCases.map((item) => ({
      ...item,
      itemIds: item.id === "CASE-1842" ? ["TX-2026-08492", "TX-2026-08493", "TX-2026-08494", "TX-2026-08495"] : [],
    }))
  );
  const [caseNotes, setCaseNotes] = useState([]);
  const [note, setNote] = useState("");
  const [role, setRole] = useState("Investigator");
  const [flaggedItems, setFlaggedItems] = useState(new Set());
  const [triagedAlerts, setTriagedAlerts] = useState(new Set());
  const [auditOpen, setAuditOpen] = useState(false);
  const [savedViews, setSavedViews] = useState(loadSavedViews);
  const graphActions = useRef(null);
  const batchInputRef = useRef(null);
  const [intakeMessage, setIntakeMessage] = useState("");
  const entities = workspace.entities;
  const transactions = workspace.transactions;
  const deferredQuery = useDeferredValue(query);

  const recordAudit = (event) => {
    setAudit((events) => [`09:49 — ${event}`, ...events]);
    logAuditEventApi(event);
  };

  useEffect(() => {
    checkServerHealth().then((isHealthy) => {
      setServerOnline(isHealthy);
      if (isHealthy) {
        fetchCasesApi(caseItems).then((remoteCases) => {
          if (Array.isArray(remoteCases) && remoteCases.length > 0) {
            setCaseItems(remoteCases);
          }
        });
      }
    });
  }, []);

  useEffect(() => {
    const handler = setTimeout(() => {
      window.localStorage.setItem(savedViewStorageKey, JSON.stringify(savedViews.slice(0, 5)));
    }, 300);
    return () => clearTimeout(handler);
  }, [savedViews]);

  const entityById = useMemo(() => new Map(entities.map((entity) => [entity.id, entity])), [entities]);

  // Pre-index search tokens to avoid N^2 string allocations on every keystroke
  const txSearchIndex = useMemo(() => {
    const map = new Map();
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const source = entityById.get(tx.source);
      const target = entityById.get(tx.target);
      const str = `${tx.id} ${tx.currency || ""} ${tx.rail || ""} ${tx.flag || ""} ${source?.name || ""} ${target?.name || ""}`.toLowerCase();
      map.set(tx.id, str);
    }
    return map;
  }, [transactions, entityById]);

  const datasetNow = useMemo(
    () => transactions.reduce((latest, item) => Math.max(latest, Date.parse(item.date || "") || 0), 0),
    [transactions]
  );

  const matchingTransactions = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const windowCutoff =
      dateWindow === "Last 24 hours" ? datasetNow - 86_400_000 : dateWindow === "Last 7 days" ? datasetNow - 604_800_000 : 0;

    return transactions.filter((tx) => {
      if (tx.risk < minimumRisk || tx.amount < minimumAmount) return false;
      if (currency !== "All currencies" && tx.currency !== currency) return false;
      if (flaggedOnly && !tx.flag) return false;

      if (windowCutoff) {
        const transactionDate = Date.parse(tx.date || "");
        if (!Number.isFinite(transactionDate) || transactionDate < windowCutoff) return false;
      }

      if (crossBorderOnly) {
        const source = entityById.get(tx.source);
        const target = entityById.get(tx.target);
        if (source && target && source.country === target.country) return false;
      }

      if (normalizedQuery) {
        const cachedStr = txSearchIndex.get(tx.id);
        if (!cachedStr || !cachedStr.includes(normalizedQuery)) return false;
      }

      return true;
    });
  }, [transactions, entityById, txSearchIndex, datasetNow, deferredQuery, minimumRisk, minimumAmount, currency, dateWindow, crossBorderOnly, flaggedOnly]);

  const candidateEntityIds = useMemo(() => new Set(matchingTransactions.flatMap((tx) => [tx.source, tx.target])), [matchingTransactions]);
  const visibleEntities = useMemo(
    () => entities.filter((entity) => candidateEntityIds.has(entity.id)).sort((a, b) => b.risk - a.risk).slice(0, MAX_RENDERED_NODES),
    [entities, candidateEntityIds]
  );
  const visibleEntityIds = useMemo(() => new Set(visibleEntities.map((entity) => entity.id)), [visibleEntities]);
  const visibleTransactions = useMemo(
    () =>
      matchingTransactions
        .filter((tx) => visibleEntityIds.has(tx.source) && visibleEntityIds.has(tx.target))
        .sort((a, b) => b.risk - a.risk || b.amount - a.amount)
        .slice(0, MAX_RENDERED_EDGES),
    [matchingTransactions, visibleEntityIds]
  );

  const alertQueue = useMemo(
    () =>
      matchingTransactions
        .filter((tx) => tx.risk >= 80 || tx.flag)
        .filter((tx) => !triagedAlerts.has(tx.id))
        .sort((a, b) => b.risk - a.risk || b.amount - a.amount),
    [matchingTransactions, triagedAlerts]
  );

  const selectedObject = selected.type === "entity" ? entities.find((entity) => entity.id === selected.value) : transactions.find((tx) => tx.id === selected.value);
  const select = (next) => {
    setSelected(next);
    recordAudit(`inspected ${formats[next.type].toLowerCase()} ${next.value}`);
  };
  const inspectItem = selected.type === "entity" ? selectedObject : entities.find((entity) => entity.id === selectedObject?.target);
  const projectSensitive = (value) => (role === "Analyst" ? maskIdentifier(value) : value || "—");
  const activeCase = caseItems.find((item) => item.id === activeCaseId) || caseItems[0];
  const traceTarget = selected.type === "entity" ? selected.value : selectedObject?.target;
  const trace = traceMode ? findDirectedPath(visibleTransactions, traceOrigin, traceTarget) : { nodeIds: [], edgeIds: [] };

  const addToCase = () => {
    if (activeCase.itemIds.includes(selected.value)) return;
    const updatedCase = {
      ...activeCase,
      itemIds: [...activeCase.itemIds, selected.value],
      transactions: activeCase.transactions + 1,
      updated: "just now",
    };
    setCaseItems((items) => items.map((item) => (item.id === activeCaseId ? updatedCase : item)));
    syncCaseApi(updatedCase);
    recordAudit(`${selected.value} added to ${activeCaseId}`);
  };

  const flagForReview = () => {
    setFlaggedItems((items) => new Set([...items, selected.value]));
    recordAudit(`${selected.value} flagged for investigator review`);
  };

  const resolveAlert = () => {
    if (selected.type !== "transaction") return;
    setTriagedAlerts((items) => new Set([...items, selected.value]));
    recordAudit(`alert triaged: ${selected.value}`);
  };

  const updateCaseStatus = (status) => {
    if (status === activeCase.status) return;
    const updatedCase = { ...activeCase, status, updated: "just now" };
    setCaseItems((items) => items.map((item) => (item.id === activeCaseId ? updatedCase : item)));
    syncCaseApi(updatedCase);
    recordAudit(`${activeCaseId} status changed to ${status}`);
  };

  const saveView = () => {
    const snapshot = {
      id: `${Date.now()}`,
      createdAt: new Date().toISOString(),
      query,
      minimumRisk,
      minimumAmount,
      currency,
      dateWindow,
      crossBorderOnly,
      flaggedOnly,
      traceMode,
      traceOrigin,
      selected,
      activeCaseId,
    };
    setSavedViews((views) => [snapshot, ...views].slice(0, 5));
    recordAudit("saved investigation view");
  };

  const restoreView = () => {
    const snapshot = savedViews[0];
    if (!snapshot) return;
    setQuery(snapshot.query);
    setMinimumRisk(snapshot.minimumRisk);
    setMinimumAmount(snapshot.minimumAmount || 0);
    setCurrency(snapshot.currency);
    setDateWindow(snapshot.dateWindow || "All dates");
    setCrossBorderOnly(snapshot.crossBorderOnly);
    setFlaggedOnly(snapshot.flaggedOnly);
    setTraceMode(snapshot.traceMode);
    setTraceOrigin(snapshot.traceOrigin || "JPM-US");
    setSelected(snapshot.selected);
    setActiveCaseId(snapshot.activeCaseId);
    recordAudit("restored saved investigation view");
  };

  const importBatch = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const payload = file.name.toLowerCase().endsWith(".csv") ? { transactions: parseCsv(text) } : JSON.parse(text);
      const incomingEntities = Array.isArray(payload) ? [] : payload.entities || [];
      const incomingTransactions = (Array.isArray(payload) ? payload : payload.transactions || []).map((tx) => ({
        ...tx,
        id: tx.id || tx.transaction_id,
        source: tx.source || tx.source_entity_id,
        target: tx.target || tx.target_entity_id,
        risk: tx.risk ?? tx.risk_score,
        date: tx.date || tx.timestamp,
      }));
      const availableEntityIds = new Set([...entities.map((item) => item.id), ...incomingEntities.map((item) => item.id)]);
      const entityErrors = incomingEntities.map(validateEntity).filter(Boolean);
      const transactionErrors = incomingTransactions.flatMap((tx, index) => {
        const missing = ["id", "source", "target", "currency", "amount"].filter((field) => !tx[field]);
        if (missing.length) return [`Row ${index + 1}: missing ${missing.join(", ")}`];
        if (!availableEntityIds.has(tx.source) || !availableEntityIds.has(tx.target)) return [`Row ${index + 1}: source or target is not a known entity`];
        if (!/^[A-Z]{3}$/.test(tx.currency)) return [`Row ${index + 1}: currency must be ISO 4217`];
        if (!Number.isFinite(Number(tx.amount)) || Number(tx.amount) <= 0) return [`Row ${index + 1}: amount must be positive`];
        return [];
      });
      const errors = [...entityErrors, ...transactionErrors];
      if (errors.length) {
        setIntakeMessage(`Batch rejected — ${errors[0]}`);
        recordAudit("batch validation rejected");
        return;
      }
      const normalizedEntities = incomingEntities.map((entity, index) => ({
        ...entity,
        risk: Number(entity.risk ?? 50),
        x: Number.isFinite(Number(entity.x)) ? Number(entity.x) : Math.cos(index) * 0.8,
        y: Number.isFinite(Number(entity.y)) ? Number(entity.y) : Math.sin(index) * 0.8,
      }));
      const normalizedTransactions = incomingTransactions.map((tx) => ({
        ...tx,
        amount: Number(tx.amount),
        risk: Number(tx.risk ?? 50),
        date: tx.date || new Date().toISOString(),
        rail: tx.rail || "SWIFT",
        display: tx.display || formatDisplayAmount(tx.amount, tx.currency),
        flag: tx.flag || null,
      }));
      setWorkspace((current) => {
        const entityMap = new Map(current.entities.map((e) => [e.id, e]));
        for (let i = 0; i < normalizedEntities.length; i++) {
          entityMap.set(normalizedEntities[i].id, normalizedEntities[i]);
        }
        const txMap = new Map(current.transactions.map((t) => [t.id, t]));
        for (let i = 0; i < normalizedTransactions.length; i++) {
          txMap.set(normalizedTransactions[i].id, normalizedTransactions[i]);
        }
        return {
          entities: Array.from(entityMap.values()),
          transactions: Array.from(txMap.values()),
        };
      });
      setIntakeMessage(`Batch accepted — ${normalizedEntities.length} entities, ${normalizedTransactions.length} transactions`);
      recordAudit(`batch ingested: ${normalizedTransactions.length} transactions`);
    } catch (error) {
      setIntakeMessage(`Batch rejected — ${error instanceof SyntaxError ? "invalid JSON" : "unable to read file"}`);
      recordAudit("batch intake failed");
    }
  };

  const saveNote = (event) => {
    event.preventDefault();
    const trimmed = note.trim();
    if (!trimmed) return;
    setCaseNotes((notes) => [{ id: `${activeCaseId}-${notes.length}`, caseId: activeCaseId, text: trimmed }, ...notes]);
    addCaseNoteApi(activeCaseId, trimmed);
    setNote("");
    recordAudit(`investigator note saved to ${activeCaseId}`);
  };

  const exportReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      case: activeCase,
      filters: { minimumRisk, minimumAmount, currency, dateWindow, crossBorderOnly, flaggedOnly, query },
      transactions: visibleTransactions,
      trace,
      notes: caseNotes.filter((item) => item.caseId === activeCaseId),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement("a"), { href: url, download: `moneytrace-${activeCaseId.toLowerCase()}.json` });
    anchor.click();
    URL.revokeObjectURL(url);
    recordAudit("exported filtered JSON report");
  };

  const exportCsv = () => {
    const headings = ["transaction_id", "source", "target", "amount", "currency", "rail", "timestamp", "risk_score", "alert_reason"];
    const csvEscape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const rows = visibleTransactions.map((tx) => [tx.id, tx.source, tx.target, tx.amount, tx.currency, tx.rail, tx.date, tx.risk, tx.flag]);
    const blob = new Blob([[headings, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement("a"), { href: url, download: `moneytrace-${activeCaseId.toLowerCase()}-transactions.csv` });
    anchor.click();
    URL.revokeObjectURL(url);
    recordAudit("exported filtered CSV report");
  };

  const exportAudit = (format) => {
    const events = audit.map((event, index) => ({ sequence: audit.length - index, event }));
    const content =
      format === "json"
        ? JSON.stringify({ generatedAt: new Date().toISOString(), role, events }, null, 2)
        : [["sequence", "event"], ...events.map((item) => [item.sequence, item.event])].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement("a"), { href: url, download: `moneytrace-audit-ledger.${format}` });
    anchor.click();
    URL.revokeObjectURL(url);
    recordAudit(`exported audit ledger as ${format.toUpperCase()}`);
  };

  const handleBloombergCommand = (code) => {
    recordAudit(`executed Bloomberg function: ${code}`);
    if (code === "ALLQ" || code === "BLOT" || code === "OMST" || code === "VAR" || code === "NEWS") {
      setActiveTab("terminal");
    } else if (code === "WIRP" || code === "CORP") {
      setActiveTab("liquidity");
      setLiquiditySubView("macro");
    } else if (code === "CBRT") {
      setActiveTab("liquidity");
      setLiquiditySubView("centralbanks");
    } else if (code === "RAIL") {
      setActiveTab("liquidity");
      setLiquiditySubView("rails");
    } else if (code === "FXFA") {
      setActiveTab("liquidity");
      setLiquiditySubView("converter");
    } else if (code === "AML") {
      setActiveTab("investigate");
    } else if (code === "OPEN_PALETTE") {
      setCommandPaletteOpen(true);
    }
  };

  return (
    <main className="intel-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-glyph">W</span>
          <span>WorldMoney</span>
          <small>INSTITUTIONAL TERMINAL</small>
        </div>
        <nav>
          <button
            className={activeTab === "terminal" ? "active" : ""}
            onClick={() => setActiveTab("terminal")}
          >
            ⚡ Bloomberg Terminal
          </button>
          <button
            className={activeTab === "liquidity" ? "active" : ""}
            onClick={() => setActiveTab("liquidity")}
          >
            Global Liquidity Map
          </button>
          <button
            className={activeTab === "investigate" ? "active" : ""}
            onClick={() => setActiveTab("investigate")}
          >
            MoneyTrace AML
          </button>
          <button
            className={activeTab === "cases" ? "active" : ""}
            onClick={() => {
              setActiveTab("investigate");
            }}
          >
            Cases <b>03</b>
          </button>
          <button onClick={() => setAuditOpen(true)}>Audit Ledger</button>
          <button
            className="cmd-k-trigger"
            onClick={() => setCommandPaletteOpen(true)}
            title="Press Cmd+K for Bloomberg commands"
          >
            <kbd>CMD</kbd> (Cmd+K)
          </button>
        </nav>

        {/* SUPER SEARCH CONTEXT-SHIFT BAR */}
        <div style={{ marginLeft: "auto", marginRight: "12px" }}>
          <SuperSearchBar
            onSelectSymbol={(sym) => {
              setFocusedSymbol(sym);
              setActiveTab("terminal");
            }}
            onSelectEntity={(dossier) => {
              setFocusedEntityDossier(dossier);
              if (dossier.symbol) setFocusedSymbol(dossier.symbol);
              setActiveTab("terminal");
              recordAudit(`SuperSearch context-shift pivoted to ${dossier.query || dossier.symbol}`);
            }}
          />
        </div>

        <div className="operator">
          <span className={`live-dot ${serverOnline ? "server-live" : ""}`} /> {serverOnline ? "API Connected" : "Local Session"}
          <label className="role-switch">
            <span>ROLE</span>
            <select
              value={role}
              onChange={(event) => {
                setRole(event.target.value);
                recordAudit(`role view switched to ${event.target.value}`);
              }}
            >
              {roles.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <span className="avatar">AN</span>
        </div>
      </header>

      {/* GLOBAL TICKER MARQUEE */}
      <LiveTickerRibbon onSelectSymbol={(sym) => {
        setFocusedSymbol(sym);
        setActiveTab("terminal");
      }} />

      {/* VIEW 0: BLOOMBERG TERMINAL WORKSPACE */}
      {activeTab === "terminal" && (
        <TerminalWorkspace
          externalSymbol={focusedSymbol}
          focusedDossier={focusedEntityDossier}
          onSelectSymbol={(sym) => setFocusedSymbol(sym)}
          onFilterEntity={(entityId) => {
            setActiveTab("investigate");
            setQuery(entityId);
            setSelected({ type: "entity", value: entityId });
            setTraceOrigin(entityId);
            recordAudit(`inspected entity ${entityId} from live news feed wire`);
          }}
        />
      )}

      {/* VIEW 1: GLOBAL LIQUIDITY MAP */}
      {activeTab === "liquidity" && (
        <section className="liquidity-workbench">
          <nav className="liquidity-nav-tabs">
            <button
              className={liquiditySubView === "macro" ? "active" : ""}
              onClick={() => setLiquiditySubView("macro")}
            >
              Macro Liquidity (FRED / WB)
            </button>
            <button
              className={liquiditySubView === "converter" ? "active" : ""}
              onClick={() => setLiquiditySubView("converter")}
            >
              FX & Rate Arbitrage
            </button>
            <button
              className={liquiditySubView === "rails" ? "active" : ""}
              onClick={() => setLiquiditySubView("rails")}
            >
              Payment Rails Matrix
            </button>
            <button
              className={liquiditySubView === "centralbanks" ? "active" : ""}
              onClick={() => setLiquiditySubView("centralbanks")}
            >
              Central Bank Policy Hub
            </button>
            <button
              className={liquiditySubView === "network" ? "active" : ""}
              onClick={() => setLiquiditySubView("network")}
            >
              Financial Relationship Graph
            </button>
          </nav>

          {liquiditySubView === "macro" && <MacroLiquidityPanel />}
          {liquiditySubView === "converter" && <FxPolicyConverter />}
          {liquiditySubView === "rails" && <PaymentRailsMatrix />}
          {liquiditySubView === "centralbanks" && <CentralBankPolicyHub />}
          {liquiditySubView === "network" && <EntityGraph />}
        </section>
      )}

      {/* VIEW 2: MONEYTRACE INVESTIGATION WORKBENCH */}
      {activeTab === "investigate" && (
        <>
          <section className="commandbar">
            <div className="breadcrumb">
              INVESTIGATIONS <i>/</i> {activeCase.id} <strong>{activeCase.title}</strong>
              {role === "Analyst" ? (
                <span className="case-status">{activeCase.status}</span>
              ) : (
                <label className="case-status">
                  <span>STATUS</span>
                  <select value={activeCase.status} onChange={(event) => updateCaseStatus(event.target.value)}>
                    <option>Open</option>
                    <option>In review</option>
                    <option>Closed</option>
                  </select>
                </label>
              )}
            </div>
            <div className="command-actions">
              <button
                onClick={() => {
                  setTraceMode(!traceMode);
                  recordAudit(traceMode ? "trace cleared" : "path trace activated");
                }}
                className={traceMode ? "trace-on" : ""}
              >
                ◉ {traceMode ? "Tracing active" : "Trace path"}
              </button>
              <button onClick={saveView}>Save view</button>
              {savedViews.length > 0 && <button onClick={restoreView}>Restore view</button>}
              <button onClick={exportReport}>Export JSON</button>
              <button onClick={exportCsv}>Export CSV</button>
              {role === "Admin" && (
                <>
                  <input
                    ref={batchInputRef}
                    className="file-input"
                    type="file"
                    accept=".json,.csv,application/json,text/csv"
                    onChange={importBatch}
                  />
                  <button onClick={() => batchInputRef.current?.click()}>Import batch</button>
                </>
              )}
              {role === "Analyst" ? (
                <button className="primary" disabled={flaggedItems.has(selected.value)} onClick={flagForReview}>
                  {flaggedItems.has(selected.value) ? "Flag submitted" : "+ Flag for review"}
                </button>
              ) : (
                <button className="primary" disabled={activeCase.itemIds.includes(selected.value)} onClick={addToCase}>
                  {activeCase.itemIds.includes(selected.value) ? "In active case" : "+ Add to case"}
                </button>
              )}
            </div>
          </section>

          <section className="workbench">
            <aside className="filter-rail">
              <div className="rail-title">
                <span>ANALYSIS CONTROLS</span>
                <button
                  onClick={() => {
                    setQuery("");
                    setMinimumRisk(0);
                    setMinimumAmount(0);
                    setCurrency("All currencies");
                    setDateWindow("All dates");
                    setCrossBorderOnly(true);
                    setFlaggedOnly(false);
                  }}
                >
                  Reset
                </button>
              </div>
              <label className="search">
                <span>⌕</span>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search entity or transaction" />
              </label>
              <fieldset>
                <legend>Transaction risk</legend>
                <div className="risk-scale">
                  <span>Any</span>
                  <output>{minimumRisk || "All"}</output>
                </div>
                <input
                  aria-label="Minimum transaction risk"
                  type="range"
                  min="0"
                  max="90"
                  step="10"
                  value={minimumRisk}
                  onChange={(e) => setMinimumRisk(Number(e.target.value))}
                />
                <div className="range-ends">
                  <span>0</span>
                  <span>90+</span>
                </div>
              </fieldset>
              <fieldset>
                <legend>Currency</legend>
                {["All currencies", "USD", "EUR", "GBP", "AED"].map((item) => (
                  <label className="choice" key={item}>
                    <input type="radio" name="currency" checked={currency === item} onChange={() => setCurrency(item)} />
                    {item}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Transaction volume</legend>
                <label className="choice">
                  <input type="radio" name="amount" checked={minimumAmount === 0} onChange={() => setMinimumAmount(0)} /> Any amount
                </label>
                <label className="choice">
                  <input
                    type="radio"
                    name="amount"
                    checked={minimumAmount === 10_000_000}
                    onChange={() => setMinimumAmount(10_000_000)}
                  />{" "}
                  $10M+
                </label>
                <label className="choice">
                  <input
                    type="radio"
                    name="amount"
                    checked={minimumAmount === 50_000_000}
                    onChange={() => setMinimumAmount(50_000_000)}
                  />{" "}
                  $50M+
                </label>
              </fieldset>
              <fieldset>
                <legend>Date range</legend>
                {["All dates", "Last 24 hours", "Last 7 days"].map((item) => (
                  <label className="choice" key={item}>
                    <input type="radio" name="dateWindow" checked={dateWindow === item} onChange={() => setDateWindow(item)} />
                    {item}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>Flow type</legend>
                <label className="choice">
                  <input type="checkbox" checked={crossBorderOnly} onChange={(event) => setCrossBorderOnly(event.target.checked)} /> Cross-border only
                </label>
                <label className="choice">
                  <input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} /> Flagged flows
                </label>
              </fieldset>
              <div className="scope">
                <span>VIEW SCOPE</span>
                <strong>
                  {visibleEntities.length} / {candidateEntityIds.size} entities · {visibleTransactions.length} / {matchingTransactions.length} transfers
                </strong>
                <small>Rendering is capped at 2,000 nodes and 5,000 flows, prioritized by risk and exposure.</small>
              </div>
              <section className="alert-queue">
                <div>
                  <span>ALERT TRIAGE</span>
                  <strong>{alertQueue.length} open</strong>
                </div>
                {alertQueue.slice(0, 3).map((tx) => (
                  <button key={tx.id} onClick={() => select({ type: "transaction", value: tx.id })}>
                    <b>{tx.risk}</b>
                    <span>
                      {tx.id}
                      <small>{tx.flag || "High-risk flow"}</small>
                    </span>
                  </button>
                ))}
                {alertQueue.length > 3 && <small>+ {alertQueue.length - 3} additional alerts</small>}
              </section>
            </aside>

            <section className="graph-shell">
              <div className="graph-header">
                <div>
                  <span className="eyebrow">{investigationViewMode === "graph" ? "LIVE RELATIONSHIP GRAPH" : "BLOOMBERG DATA GRID"}</span>
                  <h1>{investigationViewMode === "graph" ? "Cross-border transaction network" : "Interbank Transaction & Entity Blotter"}</h1>
                </div>

                <div className="view-mode-toggle-group">
                  <button
                    className={`view-mode-btn ${investigationViewMode === "graph" ? "active" : ""}`}
                    onClick={() => setInvestigationViewMode("graph")}
                  >
                    ◉ Graph
                  </button>
                  <button
                    className={`view-mode-btn ${investigationViewMode === "blotter" ? "active" : ""}`}
                    onClick={() => setInvestigationViewMode("blotter")}
                  >
                    ▤ Bloomberg Full List
                  </button>
                </div>

                <div className="graph-stat">
                  <span>EXPOSURE</span>
                  <strong>$258.7M</strong>
                  <small>LAST 24 HOURS</small>
                </div>
              </div>

              <ConnectionFinder
                entities={visibleEntities}
                transactions={visibleTransactions}
                selectedId={selected.value}
                onSelectEntity={(id) => select({ type: "entity", value: id })}
                onSelectTransaction={(id) => select({ type: "transaction", value: id })}
                onSetTrace={(result) => {
                  setTraceMode(true);
                  if (result.nodeIds[0]) setTraceOrigin(result.nodeIds[0]);
                  recordAudit(`multi-entity trace path evaluated: ${result.nodeIds.join(" -> ")}`);
                }}
              />

              {investigationViewMode === "graph" ? (
                <div className="graph-wrap">
                  <NetworkCanvas
                    entities={visibleEntities}
                    transactions={visibleTransactions}
                    selectedId={selected.value}
                    trace={trace}
                    onSelect={select}
                    actionsRef={graphActions}
                  />
                  <div className="graph-tools">
                    <button aria-label="Zoom in" onClick={() => graphActions.current?.zoomIn()}>
                      ＋
                    </button>
                    <button aria-label="Zoom out" onClick={() => graphActions.current?.zoomOut()}>
                      −
                    </button>
                    <button aria-label="Reset graph view" onClick={() => graphActions.current?.reset()}>
                      ⊙
                    </button>
                  </div>
                  <div className="trace-status">
                    {traceMode ? (
                      trace.edgeIds.length ? (
                        <>
                          <span>TRACE ROUTE</span>
                          <strong>
                            {trace.nodeIds.length} nodes · {trace.edgeIds.length} hops from {traceOrigin}
                          </strong>
                        </>
                      ) : (
                        <>
                          <span>TRACE ROUTE</span>
                          <strong>No directed path from {traceOrigin}</strong>
                        </>
                      )
                    ) : (
                      <>
                        <span>TRACE ROUTE</span>
                        <strong>Disabled</strong>
                      </>
                    )}
                  </div>
                  {intakeMessage && (
                    <div className="intake-status" role="status">
                      {intakeMessage}
                    </div>
                  )}
                  <div className="legend">
                    <span>
                      <i className="low" />Standard
                    </span>
                    <span>
                      <i className="mid" />Elevated
                    </span>
                    <span>
                      <i className="high" />Critical
                    </span>
                    <em>Click a node or flow to inspect</em>
                  </div>
                </div>
              ) : (
                <BloombergBlotter
                  entities={visibleEntities}
                  transactions={visibleTransactions}
                  selectedId={selected.value}
                  onSelect={select}
                  onTraceOrigin={(originId) => {
                    setTraceOrigin(originId);
                    setTraceMode(true);
                    recordAudit(`trace origin set to ${originId}`);
                  }}
                  onAddToCase={addToCase}
                  activeCaseId={activeCaseId}
                  role={role}
                />
              )}
            </section>

            <aside className="inspector">
              <div className="inspector-title">
                <div>
                  <span className="eyebrow">{formats[selected.type].toUpperCase()} INSPECTOR</span>
                  <h2>{selectedObject?.id || "No selection"}</h2>
                </div>
                <button onClick={() => setSelected({ type: "transaction", value: "TX-2026-08494" })}>×</button>
              </div>
              {selectedObject && (
                <>
                  <div className={`risk-banner risk-${riskLabel(selectedObject.risk).toLowerCase()}`}>
                    <span>RISK SCORE</span>
                    <strong>
                      {selectedObject.risk}
                      <small>/100</small>
                    </strong>
                    <em>{riskLabel(selectedObject.risk)}</em>
                  </div>
                  <section className="detail-block">
                    <h3>{selected.type === "transaction" ? "Flow detail" : "Institution detail"}</h3>
                    {selected.type === "transaction" ? (
                      <dl>
                        <div>
                          <dt>Amount</dt>
                          <dd>
                            {selectedObject.display} {selectedObject.currency}
                          </dd>
                        </div>
                        <div>
                          <dt>Source</dt>
                          <dd>{entityById.get(selectedObject.source)?.name || selectedObject.source}</dd>
                        </div>
                        <div>
                          <dt>Destination</dt>
                          <dd>{entityById.get(selectedObject.target)?.name || selectedObject.target}</dd>
                        </div>
                        <div>
                          <dt>Rail</dt>
                          <dd>{selectedObject.rail}</dd>
                        </div>
                        <div>
                          <dt>Timestamp</dt>
                          <dd>{selectedObject.date}</dd>
                        </div>
                        <div>
                          <dt>Routing</dt>
                          <dd>{role === "Analyst" ? "Masked routing details" : selectedObject.routing?.correspondent || "Direct settlement"}</dd>
                        </div>
                        <div>
                          <dt>Alert reason</dt>
                          <dd className="danger">{selectedObject.flag || "No active alert"}</dd>
                        </div>
                      </dl>
                    ) : (
                      <dl>
                        <div>
                          <dt>Legal name</dt>
                          <dd>{selectedObject.name}</dd>
                        </div>
                        <div>
                          <dt>Jurisdiction</dt>
                          <dd>{selectedObject.country}</dd>
                        </div>
                        <div>
                          <dt>BIC / SWIFT</dt>
                          <dd>{projectSensitive(selectedObject.bic)}</dd>
                        </div>
                        <div>
                          <dt>LEI / Account</dt>
                          <dd>{projectSensitive(selectedObject.lei || selectedObject.account)}</dd>
                        </div>
                        <div>
                          <dt>PEP screening</dt>
                          <dd className={selectedObject.aml?.pep !== "Clear" ? "danger" : ""}>{selectedObject.aml?.pep || "Pending"}</dd>
                        </div>
                        <div>
                          <dt>Sanctions lists</dt>
                          <dd className={selectedObject.aml?.sanctions !== "No match" ? "danger" : ""}>
                            {selectedObject.aml?.sanctions || "Pending"}
                          </dd>
                        </div>
                      </dl>
                    )}
                  </section>
                  {selected.type === "entity" && selectedObject.aml?.typologies?.length > 0 && (
                    <section className="detail-block typologies">
                      <h3>Typology signals</h3>
                      <div>
                        {selectedObject.aml.typologies.map((typology) => (
                          <span key={typology}>{typology}</span>
                        ))}
                      </div>
                    </section>
                  )}
                  {selected.type === "transaction" && (selectedObject.risk >= 80 || selectedObject.flag) && (
                    <section className="detail-block triage-action">
                      <h3>Alert triage</h3>
                      <p>
                        {triagedAlerts.has(selectedObject.id)
                          ? "This alert has been triaged in the current session."
                          : "Open alert — review routing context and disposition the signal."}
                      </p>
                      {role !== "Analyst" && (
                        <button className="secondary" disabled={triagedAlerts.has(selectedObject.id)} onClick={resolveAlert}>
                          {triagedAlerts.has(selectedObject.id) ? "Triaged" : "Mark triaged"}
                        </button>
                      )}
                    </section>
                  )}
                  <section className="detail-block counterpart">
                    <h3>Selected endpoint</h3>
                    <strong>{inspectItem?.name}</strong>
                    <span>
                      {inspectItem?.kind} · {inspectItem?.country}
                    </span>
                    <button className="secondary" onClick={() => select({ type: "entity", value: inspectItem?.id })}>
                      Inspect entity →
                    </button>
                    {inspectItem?.id && (
                      <button
                        className="secondary"
                        onClick={() => {
                          setTraceOrigin(inspectItem.id);
                          setTraceMode(true);
                          recordAudit(`trace origin set to ${inspectItem.id}`);
                        }}
                      >
                        Trace from this entity →
                      </button>
                    )}
                  </section>
                  <section className="detail-block case-note">
                    <h3>Investigator note</h3>
                    {role === "Analyst" ? (
                      <p className="permission-note">Analyst access: view, trace, and flag. Case annotations require Investigator or Admin access.</p>
                    ) : (
                      <>
                        <form onSubmit={saveNote}>
                          <textarea
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            placeholder={`Add an observation to ${activeCase.id}`}
                            maxLength="500"
                          />
                          <button className="secondary" type="submit">
                            Save note
                          </button>
                        </form>
                        {caseNotes
                          .filter((item) => item.caseId === activeCaseId)
                          .slice(0, 2)
                          .map((item) => (
                            <p key={item.id}>{item.text}</p>
                          ))}
                      </>
                    )}
                  </section>
                  <section className="detail-block audit-mini">
                    <h3>Case activity</h3>
                    {audit.slice(0, 4).map((event, index) => (
                      <p key={`${event}-${index}`}>{event}</p>
                    ))}
                  </section>
                </>
              )}
            </aside>
          </section>

          <section className="casebar">
            <div className="case-label">
              <span>OPEN CASES</span>
              <strong>Priority queue</strong>
            </div>
            {caseItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveCaseId(item.id);
                  recordAudit(`opened ${item.id}`);
                }}
                className={`case-card ${activeCaseId === item.id ? "selected-case" : ""}`}
              >
                <span className={`severity ${item.severity.toLowerCase()}`} /> <b>{item.id}</b>
                <strong>{item.title}</strong>
                <small>
                  {item.status} · {item.transactions} transactions · {item.updated}
                </small>
              </button>
            ))}
            <button className="case-more">View all cases →</button>
          </section>
        </>
      )}

      {/* AUDIT OVERLAY */}
      {auditOpen && (
        <div className="audit-overlay" role="dialog" aria-modal="true" aria-label="Audit event ledger">
          <section className="audit-panel">
            <header>
              <div>
                <span className="eyebrow">APPEND-ONLY SESSION LEDGER</span>
                <h2>Audit review</h2>
              </div>
              <button onClick={() => setAuditOpen(false)} aria-label="Close audit review">
                ×
              </button>
            </header>
            <p>Events are retained in-session in chronological order. A production API persists this stream to immutable storage.</p>
            <div className="audit-exports">
              <button onClick={() => exportAudit("json")}>Export JSON</button>
              <button onClick={() => exportAudit("csv")}>Export CSV</button>
            </div>
            <ol>
              {audit.map((event, index) => (
                <li key={`${event}-${index}`}>
                  <b>{String(audit.length - index).padStart(3, "0")}</b>
                  {event}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      {/* BLOOMBERG COMMAND PALETTE MODAL */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onExecuteCommand={handleBloombergCommand}
      />
    </main>
  );
}
