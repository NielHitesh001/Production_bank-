import React, { useEffect, useState } from "react";
import { wsMarketManager } from "../../src/services/wsManager.js";

export default function LiveTickerRibbon({ onSelectSymbol }) {
  const [tickers, setTickers] = useState(() => wsMarketManager.getAllTickers());
  const [recentUpdates, setRecentUpdates] = useState({});

  useEffect(() => {
    const unsubscribe = wsMarketManager.subscribe((updatedTick) => {
      setTickers((prev) =>
        prev.map((t) => (t.symbol === updatedTick.symbol ? updatedTick : t))
      );

      // Flash highlight animation for 600ms
      setRecentUpdates((prev) => ({
        ...prev,
        [updatedTick.symbol]: updatedTick.lastDirection || "up",
      }));

      setTimeout(() => {
        setRecentUpdates((prev) => {
          const next = { ...prev };
          delete next[updatedTick.symbol];
          return next;
        });
      }, 600);
    });

    return () => unsubscribe();
  }, []);

  return (
    <div className="terminal-ticker-ribbon">
      <div className="ticker-ribbon-badge">
        <span className="live-pulse-dot" />
        <b>MARKET DATA</b>
      </div>

      <div className="ticker-marquee-track">
        {tickers.concat(tickers).map((ticker, index) => {
          const isFlashing = recentUpdates[ticker.symbol];
          const isPositive = ticker.pctChange >= 0;
          return (
            <div
              key={`${ticker.symbol}-${index}`}
              className={`ticker-item ${isFlashing ? `flash-${isFlashing}` : ""}`}
              onClick={() => onSelectSymbol && onSelectSymbol(ticker.symbol)}
              title={`Click to analyze ${ticker.name}`}
            >
              <span className="ticker-symbol">{ticker.symbol}</span>
              <strong className="ticker-price">{ticker.last.toFixed(ticker.decimals || 4)}</strong>
              <span className={`ticker-delta ${isPositive ? "pos" : "neg"}`}>
                {isPositive ? "▲ +" : "▼ "}{ticker.pctChange.toFixed(2)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
