import React, { useEffect, useMemo, useState } from "react";
import { wsMarketManager } from "../../src/services/wsManager.js";
import { routeOrderSubmission } from "../../src/services/orderRouting.js";
import { liveGuardrails } from "../../src/services/liveExecutionGuardrails.js";

export default function OrderTicket({ onExecuteOrder, accountBalance = 1000000 }) {
  const [symbol, setSymbol] = useState("EUR/USD");
  const [side, setSide] = useState("BUY"); // "BUY" | "SELL"
  const [orderType, setOrderType] = useState("MARKET"); // "MARKET" | "LIMIT" | "STOP"
  const [brokerVenue, setBrokerVenue] = useState("alpaca_paper"); // "alpaca_paper" | "internal_sim"
  const [amountUsd, setAmountUsd] = useState(50000);
  const [leverage, setLeverage] = useState(5);
  const [limitPrice, setLimitPrice] = useState(1.0873);
  const [executionMessage, setExecutionMessage] = useState(null);
  const [guardrailStatus, setGuardrailStatus] = useState(() => liveGuardrails.getStatus());

  const [currentTick, setCurrentTick] = useState(() => wsMarketManager.getTicker(symbol) || { last: 1.0873, bid: 1.0872, ask: 1.0874, decimals: 4 });

  useEffect(() => {
    const t = wsMarketManager.getTicker(symbol);
    if (t) {
      setCurrentTick(t);
      setLimitPrice(t.last);
    }
    const unsubscribe = wsMarketManager.subscribeSymbol(symbol, (tick) => {
      setCurrentTick(tick);
    });
    return () => unsubscribe();
  }, [symbol]);

  const executionPrice = useMemo(() => {
    if (orderType === "LIMIT") return Number(limitPrice);
    return side === "BUY" ? currentTick.ask : currentTick.bid;
  }, [orderType, limitPrice, side, currentTick]);

  const units = useMemo(() => {
    if (executionPrice <= 0) return 0;
    return Math.floor(amountUsd / executionPrice);
  }, [amountUsd, executionPrice]);

  const requiredMargin = useMemo(() => {
    return Math.round(amountUsd / leverage);
  }, [amountUsd, leverage]);

  const handleToggleKillSwitch = () => {
    if (guardrailStatus.paused) {
      liveGuardrails.resumeOrders();
    } else {
      liveGuardrails.pauseNewOrders("Manual operator kill switch engaged");
    }
    setGuardrailStatus(liveGuardrails.getStatus());
  };

  const handlePlaceOrder = async (e) => {
    e.preventDefault();

    const orderPayload = {
      id: `ORD-${Date.now().toString().slice(-6)}`,
      symbol,
      side,
      type: orderType,
      executionPrice,
      units,
      notional: amountUsd,
      margin: requiredMargin,
      leverage,
      timestamp: new Date().toISOString(),
      assetClass: currentTick.assetClass || "FX",
      entryPrice: executionPrice,
    };

    const receipt = await routeOrderSubmission(orderPayload, {
      destination: brokerVenue,
      currentEquity: accountBalance,
      dailyPnL: 0,
      positionVol: 0.02,
    });

    if (receipt.status === "REJECTED") {
      setExecutionMessage({
        status: "REJECTED",
        text: receipt.rejectionReason || "Order rejected by pre-trade risk guardrails.",
      });
      return;
    }

    if (onExecuteOrder) onExecuteOrder(receipt);

    setExecutionMessage({
      status: "FILLED",
      text: `✓ PAPER ACCEPTED: ${side} ${units.toLocaleString()} ${symbol} @ ${receipt.executionPrice.toFixed(currentTick.decimals || 4)} (Notional: $${(amountUsd / 1000).toFixed(0)}k @ ${leverage}x)`,
    });

    setTimeout(() => setExecutionMessage(null), 5000);
  };

  const allTickers = useMemo(() => wsMarketManager.getAllTickers(), []);

  return (
    <div className="terminal-order-ticket">
      <div className="ticket-header">
        <div className="ticket-title-group">
          <span className="eyebrow">PAPER-ONLY ORDER REVIEW</span>
          <h3>Simulated Order Ticket</h3>
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <button
            type="button"
            className={`kill-switch-btn ${guardrailStatus.paused ? "engaged" : ""}`}
            onClick={handleToggleKillSwitch}
            title="Emergency trading kill switch"
          >
            {guardrailStatus.paused ? "🛑 PAPER HALTED" : "⚡ RISK GUARDRAILS"}
          </button>
          <div className="ticket-badge">
            <span>● {brokerVenue === "alpaca_paper" ? "PAPER SANDBOX" : "INTERNAL SIM"}</span>
          </div>
        </div>
      </div>

      <form onSubmit={handlePlaceOrder} className="ticket-form">
        {/* Destination Venue & Instrument Row */}
        <div className="form-grid-2">
          <div className="form-row">
            <label>SIMULATION VENUE</label>
            <select value={brokerVenue} onChange={(e) => setBrokerVenue(e.target.value)}>
              <option value="alpaca_paper">Paper Sandbox</option>
              <option value="internal_sim">Internal Simulator</option>
            </select>
          </div>

          <div className="form-row">
            <label>INSTRUMENT</label>
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {allTickers.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  [{t.assetClass}] {t.symbol} — {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Live Bid / Ask Spread Display */}
        <div className="bid-ask-box">
          <div className="bid-cell" onClick={() => setSide("SELL")}>
            <span className="ba-label">SELL / BID</span>
            <strong className="ba-price">{currentTick.bid.toFixed(currentTick.decimals || 4)}</strong>
          </div>
          <div className="spread-cell">
            <span>SPREAD</span>
            <small>{((currentTick.ask - currentTick.bid) / (currentTick.pipSize || 0.0001)).toFixed(1)} PIPS</small>
          </div>
          <div className="ask-cell" onClick={() => setSide("BUY")}>
            <span className="ba-label">BUY / ASK</span>
            <strong className="ba-price">{currentTick.ask.toFixed(currentTick.decimals || 4)}</strong>
          </div>
        </div>

        {/* Side & Order Type */}
        <div className="form-grid-2">
          <div>
            <label>SIDE</label>
            <div className="side-toggle-group">
              <button
                type="button"
                className={`side-btn buy ${side === "BUY" ? "active" : ""}`}
                onClick={() => setSide("BUY")}
              >
                BUY / LONG
              </button>
              <button
                type="button"
                className={`side-btn sell ${side === "SELL" ? "active" : ""}`}
                onClick={() => setSide("SELL")}
              >
                SELL / SHORT
              </button>
            </div>
          </div>

          <div>
            <label>ORDER TYPE</label>
            <div className="type-toggle-group">
              {["MARKET", "LIMIT", "STOP"].map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`type-btn ${orderType === t ? "active" : ""}`}
                  onClick={() => setOrderType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Notional Amount & Quick Sizing */}
        <div className="form-row">
          <div className="label-with-val">
            <label>NOTIONAL VALUE (USD)</label>
            <span>${(amountUsd / 1000).toLocaleString()}k</span>
          </div>
          <div className="amount-quick-pills">
            {[25000, 100000, 250000, 500000, 1000000].map((amt) => (
              <button
                key={amt}
                type="button"
                className={`amt-pill ${amountUsd === amt ? "active" : ""}`}
                onClick={() => setAmountUsd(amt)}
              >
                ${amt >= 1000000 ? `${amt / 1000000}M` : `${amt / 1000}k`}
              </button>
            ))}
          </div>
        </div>

        {/* Leverage Sizing */}
        <div className="form-row">
          <div className="label-with-val">
            <label>LEVERAGE SIZING</label>
            <span>{leverage}x</span>
          </div>
          <div className="leverage-pills">
            {[1, 2, 5, 10, 20].map((lev) => (
              <button
                key={lev}
                type="button"
                className={`lev-pill ${leverage === lev ? "active" : ""}`}
                onClick={() => setLeverage(lev)}
              >
                {lev}x
              </button>
            ))}
          </div>
        </div>

        {/* Pre-Trade Risk Summary */}
        <div className="pre-trade-summary">
          <div className="pt-row">
            <span>Required Margin:</span>
            <strong>${requiredMargin.toLocaleString()} USD</strong>
          </div>
          <div className="pt-row">
            <span>Calculated Units:</span>
            <strong>{units.toLocaleString()}</strong>
          </div>
          <div className="pt-row">
            <span>Est. Execution Price:</span>
            <strong>{executionPrice.toFixed(currentTick.decimals || 4)}</strong>
          </div>
        </div>

        {/* Execute Button */}
        <button
          type="submit"
          className={`execute-order-btn ${side.toLowerCase()}`}
        >
          SUBMIT PAPER {side} {symbol} (${(amountUsd / 1000).toFixed(0)}k @ {leverage}x)
        </button>

        {executionMessage && (
          <div className={`execution-banner ${executionMessage.status.toLowerCase()}`}>
            {executionMessage.text}
          </div>
        )}
      </form>
    </div>
  );
}
