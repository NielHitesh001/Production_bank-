import React, { useState } from "react";
import RealTimeCandleChart from "./RealTimeCandleChart.jsx";
import OrderTicket from "./OrderTicket.jsx";
import PortfolioBlotter, { INITIAL_PORTFOLIO_POSITIONS } from "./PortfolioBlotter.jsx";
import FxCarryAnalytics from "./FxCarryAnalytics.jsx";
import RiskVaRPanel from "./RiskVaRPanel.jsx";
import LiveNewsFeed from "./LiveNewsFeed.jsx";
import InstitutionalEntityBrowser from "./InstitutionalEntityBrowser.jsx";
import StrategyIDETab from "./StrategyIDETab.jsx";

export default function TerminalWorkspace({ onSelectSymbol, onFilterEntity, externalSymbol, focusedDossier }) {
  const [deskLayout, setDeskLayout] = useState("trading"); // "trading" | "risk" | "news" | "graph" | "ide"
  const [selectedSymbol, setSelectedSymbol] = useState(externalSymbol || "EUR/USD");
  const [positions, setPositions] = useState(INITIAL_PORTFOLIO_POSITIONS);
  const [accountBalance, setAccountBalance] = useState(1000000);

  // Sync external symbol if changed via Super Search
  React.useEffect(() => {
    if (externalSymbol && externalSymbol !== selectedSymbol) {
      setSelectedSymbol(externalSymbol);
    }
  }, [externalSymbol]);

  const handleExecuteOrder = (order) => {
    const newPosition = {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      entryPrice: order.executionPrice,
      units: order.units,
      notional: order.notional,
      margin: order.margin,
      leverage: order.leverage,
      carryRateAnnual: order.symbol.includes("USD") ? 2.5 : 0.8,
      holdingDays: 1,
      feePaid: 15,
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    };

    setPositions((prev) => [newPosition, ...prev]);
  };

  const handleClosePosition = (positionId) => {
    setPositions((prev) => prev.filter((p) => p.id !== positionId));
  };

  return (
    <section className="terminal-workspace-container">
      {/* Workspace Sub-Toolbar */}
      <div className="terminal-sub-toolbar">
        <div className="desk-preset-tabs">
          <button
            className={`desk-tab-btn ${deskLayout === "trading" ? "active" : ""}`}
            onClick={() => setDeskLayout("trading")}
          >
            ◈ MARKET & MACRO DESK
          </button>
          <button
            className={`desk-tab-btn ${deskLayout === "risk" ? "active" : ""}`}
            onClick={() => setDeskLayout("risk")}
          >
            ◇ RISK & CONTROL REVIEW
          </button>
          <button
            className={`desk-tab-btn ${deskLayout === "news" ? "active" : ""}`}
            onClick={() => setDeskLayout("news")}
          >
            ◌ EVENT INTELLIGENCE
          </button>
          <button
            className={`desk-tab-btn ${deskLayout === "graph" ? "active" : ""}`}
            onClick={() => setDeskLayout("graph")}
          >
            ◎ RELATIONSHIP GRAPH
          </button>
          <button
            className={`desk-tab-btn ${deskLayout === "ide" ? "active" : ""}`}
            onClick={() => setDeskLayout("ide")}
          >
            ▣ RESEARCH LAB
          </button>
        </div>

        <div className="workspace-status-strip">
          <span>ACTIVE DESK: <b>{deskLayout.toUpperCase()}</b></span>
          <span>DATA STATUS: <b style={{ color: "#64dcb1" }}>CONNECTED (280ms)</b></span>
        </div>
      </div>

      {/* DESK 1: PAPER-ONLY MARKET & MACRO DESK */}
      {deskLayout === "trading" && (
        <div className="trading-desk-grid">
          {/* Top Row: Chart (Left) + Order Ticket (Right) */}
          <div className="trading-top-row">
            <div className="pane-chart">
              <RealTimeCandleChart symbol={selectedSymbol} />
            </div>
            <div className="pane-ticket">
              <OrderTicket
                onExecuteOrder={handleExecuteOrder}
                accountBalance={accountBalance}
              />
            </div>
          </div>

          {/* Bottom Row: Portfolio Blotter */}
          <div className="trading-bottom-row">
            <PortfolioBlotter
              positions={positions}
              onClosePosition={handleClosePosition}
              accountBalance={accountBalance}
            />
          </div>
        </div>
      )}

      {/* DESK 2: RISK & VaR ANALYTICS */}
      {deskLayout === "risk" && (
        <div className="risk-desk-grid">
          <div className="risk-top-row">
            <div className="pane-risk">
              <RiskVaRPanel positions={positions} />
            </div>
            <div className="pane-carry">
              <FxCarryAnalytics
                onSelectPair={(pair) => {
                  setSelectedSymbol(pair);
                  setDeskLayout("trading");
                }}
              />
            </div>
          </div>
          <div className="risk-bottom-row">
            <PortfolioBlotter
              positions={positions}
              onClosePosition={handleClosePosition}
              accountBalance={accountBalance}
            />
          </div>
        </div>
      )}

      {/* DESK 3: LIVE NEWS & EVENT STREAM */}
      {deskLayout === "news" && (
        <div className="news-desk-grid">
          <div className="pane-news-full">
            <LiveNewsFeed onFilterEntity={onFilterEntity} />
          </div>
        </div>
      )}

      {/* DESK 4: INSTITUTIONAL GRAPH & MASTER TABLE */}
      {deskLayout === "graph" && (
        <div style={{ padding: "0", height: "calc(100vh - 180px)", minHeight: "650px" }}>
          <InstitutionalEntityBrowser
            onSelectEntity={(entity) => {
              if (onFilterEntity) onFilterEntity(entity.name);
            }}
          />
        </div>
      )}

      {/* DESK 5: SYSTEMATIC TRADING IDE & QUANT COPILOT */}
      {deskLayout === "ide" && (
        <div style={{ padding: "0", minHeight: "650px", height: "calc(100vh - 180px)" }}>
          <StrategyIDETab initialSymbol={selectedSymbol} />
        </div>
      )}
    </section>
  );
}
