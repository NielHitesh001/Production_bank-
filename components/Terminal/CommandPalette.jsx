import React, { useEffect, useMemo, useState } from "react";
import { BLOOMBERG_COMMANDS } from "../../src/services/bloombergCommands.js";

export { BLOOMBERG_COMMANDS };

export default function CommandPalette({ isOpen, onClose, onExecuteCommand }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (isOpen) onClose();
        else onExecuteCommand("OPEN_PALETTE");
      }
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, onExecuteCommand]);

  const filteredCommands = useMemo(() => {
    if (!query) return BLOOMBERG_COMMANDS;
    const q = query.toLowerCase();
    return BLOOMBERG_COMMANDS.filter(
      (cmd) =>
        cmd.code.toLowerCase().includes(q) ||
        cmd.name.toLowerCase().includes(q) ||
        cmd.category.toLowerCase().includes(q)
    );
  }, [query]);

  const handleSelect = (cmd) => {
    onExecuteCommand(cmd.code);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="palette-input-box">
          <span className="palette-prefix">COMMAND &gt;</span>
          <input
            autoFocus
            type="text"
            placeholder="Search actions (e.g. quotes, risk, macro, AML)…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <span className="palette-esc-hint">ESC TO CLOSE</span>
        </div>

        <div className="palette-results-list">
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.code}
              className={`palette-item ${i === selectedIndex ? "selected" : ""}`}
              onClick={() => handleSelect(cmd)}
            >
              <div className="palette-item-left">
                <strong className="cmd-code-badge">{cmd.code}</strong>
                <span className="cmd-name">{cmd.name}</span>
              </div>
              <div className="palette-item-right">
                <span className="cmd-cat">{cmd.category}</span>
                <kbd>&lt;GO&gt;</kbd>
              </div>
            </div>
          ))}
          {filteredCommands.length === 0 && (
            <div className="palette-empty">NO MATCHING INTELLIGENCE COMMANDS</div>
          )}
        </div>

        <div className="palette-footer">
          <span>NAVIGATION: ↑↓ TO SELECT · ENTER TO &lt;GO&gt; · ESC TO DISMISS</span>
          <span className="palette-bloomberg-label">WORLD MONEY COMMAND CENTER</span>
        </div>
      </div>
    </div>
  );
}
