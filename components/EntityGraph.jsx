import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { forceCollide, forceRadial, forceX, forceY } from "d3-force";
import GraphSearch from "./GraphSearch";
import GraphControls, { defaultGraphSettings } from "./GraphControls";

const demoNetwork = {
  nodes: [
    { id: "US", name: "United States", type: "country", val: 18, color: "#38bdf8", x: 0, y: 0 },
    { id: "JPM", name: "JPMorgan Chase", type: "major bank", val: 12, color: "#76e2b5", x: 80, y: -60 },
    { id: "BAC", name: "Bank of America", type: "major bank", val: 12, color: "#76e2b5", x: -80, y: -60 },
    { id: "FRB", name: "First Republic", type: "regional bank", val: 7, color: "#eab308", x: 120, y: 80 },
    { id: "SVB", name: "Silicon Valley Bank", type: "regional bank", val: 7, color: "#ee958e", x: -120, y: 80 },
  ],
  links: [
    { source: "US", target: "JPM" },
    { source: "US", target: "BAC" },
    { source: "JPM", target: "FRB" },
    { source: "BAC", target: "SVB" },
  ],
};

const nodeStyles = {
  country: { color: "#38bdf8", val: 13 },
  "central-bank": { color: "#76e2b5", val: 11 },
  currency: { color: "#eab308", val: 9 },
  "payment-rail": { color: "#f97316", val: 10 },
};

function graphFromExport(payload) {
  if (payload?.schema_version !== "1.0" || !Array.isArray(payload.nodes) || !Array.isArray(payload.links)) {
    throw new Error("Unsupported graph export");
  }
  return {
    nodes: payload.nodes.map((node) => ({
      ...node,
      name: node.label || node.id,
      category: node.type,
      ...(nodeStyles[node.type] || { color: "#dce6e3", val: 7 }),
    })),
    links: payload.links,
  };
}

export default function EntityGraph() {
  const [graphData, setGraphData] = useState(demoNetwork);
  const [dataStatus, setDataStatus] = useState("loading");
  const [selectedNode, setSelectedNode] = useState(null);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [layoutMode, setLayoutMode] = useState("force");
  const [graphSettings, setGraphSettings] = useState(defaultGraphSettings);
  const [dimensions, setDimensions] = useState({ width: 900, height: 620 });

  const stageRef = useRef(null);
  const graphRef = useRef(null);
  const selectedNodeRef = useRef(null);
  const hoveredNodeRef = useRef(null);

  selectedNodeRef.current = selectedNode;
  hoveredNodeRef.current = hoveredNode;

  // ResizeObserver for responsive canvas sizing
  useEffect(() => {
    if (!stageRef.current) return;
    const updateSize = () => {
      if (stageRef.current) {
        setDimensions({
          width: stageRef.current.clientWidth || 900,
          height: stageRef.current.clientHeight || 620,
        });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, []);

  // Fetch graph from API server or fallback
  useEffect(() => {
    const exportUrl = import.meta.env.VITE_GRAPH_EXPORT_URL || "http://127.0.0.1:8766/api/graph";
    let cancelled = false;

    fetch(exportUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Export request failed: ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        const parsed = graphFromExport(payload);
        setGraphData(parsed);
        setDataStatus("live");
        setTimeout(() => graphRef.current?.zoomToFit(600, 50), 250);
      })
      .catch(() => {
        if (!cancelled) {
          setDataStatus("demo");
          setTimeout(() => graphRef.current?.zoomToFit(400, 50), 150);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeNodeId = selectedNode?.id || hoveredNode?.id || null;

  // Neighbors map for instant O(1) highlight lookup
  const neighborSets = useMemo(() => {
    if (!activeNodeId) return { nodes: new Set(), links: new Set() };
    const nodes = new Set([activeNodeId]);
    const links = new Set();
    graphData.links.forEach((link) => {
      const s = link.source?.id || link.source;
      const t = link.target?.id || link.target;
      if (s === activeNodeId) {
        nodes.add(t);
        links.add(`${s}->${t}`);
      } else if (t === activeNodeId) {
        nodes.add(s);
        links.add(`${s}->${t}`);
      }
    });
    return { nodes, links };
  }, [graphData.links, activeNodeId]);

  const filteredData = useMemo(() => {
    const query = graphSettings.searchQuery.trim().toLowerCase();
    const validNodes = graphData.nodes.filter((node) => {
      const nodeName = (node.name || "").toLowerCase();
      const nodeId = String(node.id).toLowerCase();
      const category = (node.category || node.type || "").toLowerCase();
      if (query && !nodeName.includes(query) && !nodeId.includes(query)) return false;
      if (!graphSettings.showTags && category === "tag") return false;
      if (!graphSettings.showAttachments && category === "attachment") return false;
      if (graphSettings.existingOnly && (node.generated || category.includes("transaction"))) return false;
      if (
        !graphSettings.showOrphans &&
        !graphData.links.some(
          (link) => (link.source?.id || link.source) === node.id || (link.target?.id || link.target) === node.id
        )
      ) {
        return false;
      }
      return true;
    });
    const nodeIds = new Set(validNodes.map((node) => node.id));
    const validLinks = graphData.links
      .filter(
        (link) =>
          nodeIds.has(link.source?.id || link.source) && nodeIds.has(link.target?.id || link.target)
      )
      .map((link) => ({
        ...link,
        source: link.source?.id || link.source,
        target: link.target?.id || link.target,
      }));

    return { nodes: validNodes, links: validLinks };
  }, [graphData, graphSettings.searchQuery, graphSettings.showTags, graphSettings.showAttachments, graphSettings.existingOnly, graphSettings.showOrphans]);

  const handleNodeClick = useCallback((node) => {
    if (!node) return;
    setSelectedNode(node);
    if (graphRef.current && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      graphRef.current.centerAt(node.x, node.y, 400);
    }
  }, []);

  const handleNodeHover = useCallback((node) => {
    setHoveredNode(node || null);
  }, []);

  const handleSelectNode = useCallback((node) => {
    setSelectedNode(node);
    if (graphRef.current && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      graphRef.current.centerAt(node.x, node.y, 500);
      graphRef.current.zoom(2.2, 500);
    }
  }, []);

  const handleLayoutChange = (mode) => {
    setLayoutMode(mode);
    if (!graphRef.current) return;
    const graph = graphRef.current;

    if (mode === "radial") {
      graph.d3Force("charge").strength(-160);
      graph.d3Force("link").distance(70);
      graph.d3Force("radial", forceRadial((node) => (node.val || 6) * 12, 0, 0).strength(0.8));
      graph.d3Force("x", null);
      graph.d3Force("y", null);
    } else if (mode === "hierarchical") {
      graph.d3Force("charge").strength(-200);
      graph.d3Force("link").distance(90);
      graph.d3Force("radial", null);
      graph.d3Force("x", forceX((node) => {
        const cat = (node.category || node.type || "").toLowerCase();
        if (cat.includes("country")) return -300;
        if (cat.includes("central")) return -100;
        if (cat.includes("currency")) return 120;
        return 280;
      }).strength(0.8));
      graph.d3Force("y", forceY(0).strength(0.1));
    } else {
      graph.d3Force("charge").strength(-120);
      graph.d3Force("link").distance(75);
      graph.d3Force("radial", null);
      graph.d3Force("x", null);
      graph.d3Force("y", null);
    }
    graph.d3ReheatSimulation();
    setTimeout(() => graph.zoomToFit(500, 45), 150);
  };

  const handleAnimate = () => {
    graphRef.current?.d3ReheatSimulation();
    graphRef.current?.zoomToFit(700, 40);
  };

  return (
    <section className="dashboard-panel entity-graph-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">GLOBAL FINANCIAL RELATIONSHIP GRAPH</span>
          <h2>Global Financial Architecture Network ({filteredData.nodes.length} Nodes · {filteredData.links.length} Relations)</h2>
        </div>
        <div className="graph-live-badge">
          <span className={`status-dot ${dataStatus === "live" ? "live" : "demo"}`} />
          {dataStatus === "live" ? "CANONICAL DATA EXPORT (LIVE)" : "DEMO KNOWLEDGE SEED"}
        </div>
      </div>

      <div ref={stageRef} className="graph-stage-container">
        <div className="graph-floating-controls">
          <GraphSearch nodes={graphData.nodes} onSelectNode={handleSelectNode} />
          <GraphControls settings={graphSettings} onChange={setGraphSettings} onAnimate={handleAnimate} />
          <div className="layout-switcher">
            {[
              ["force", "Force Layout"],
              ["radial", "Radial Hierarchy"],
              ["hierarchical", "Tiered Flows"],
            ].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={layoutMode === mode ? "active" : ""}
                onClick={() => handleLayoutChange(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {selectedNode && (
          <aside className="node-inspector-card">
            <div className="inspector-heading">
              <span className="node-id">[{selectedNode.id}]</span>
              <button type="button" onClick={() => setSelectedNode(null)}>
                ×
              </button>
            </div>
            <div className="inspector-field">
              <span>NAME</span>
              <strong>{selectedNode.name}</strong>
            </div>
            <div className="inspector-field">
              <span>CATEGORY</span>
              <span className="kind-tag" style={{ background: selectedNode.color, color: "#000", fontWeight: "700" }}>
                {selectedNode.category || selectedNode.type}
              </span>
            </div>
            <div className="inspector-field">
              <span>CONNECTED RELATIONS</span>
              <strong>
                {
                  graphData.links.filter(
                    (l) => (l.source?.id || l.source) === selectedNode.id || (l.target?.id || l.target) === selectedNode.id
                  ).length
                }{" "}
                corridors
              </strong>
            </div>
          </aside>
        )}

        {hoveredNode && !selectedNode && (
          <div className="node-floating-tooltip">
            <strong>{hoveredNode.name}</strong> <small>({hoveredNode.id})</small>
            <div className="tooltip-sub">TYPE: {hoveredNode.category || hoveredNode.type}</div>
          </div>
        )}

        <ForceGraph2D
          ref={graphRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={filteredData}
          backgroundColor="#020202"
          nodeRelSize={graphSettings.nodeSize}
          cooldownTicks={120}
          d3AlphaDecay={0.06}
          d3VelocityDecay={0.65}
          onNodeDragEnd={(node) => {
            node.fx = node.x;
            node.fy = node.y;
          }}
          nodePointerAreaPaint={(node, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, 14, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={(link) => {
            const key = `${link.source?.id || link.source}->${link.target?.id || link.target}`;
            if (neighborSets.links.has(key)) return "#64dcb1";
            return activeNodeId ? "rgba(26, 38, 36, 0.2)" : "rgba(35, 54, 50, 0.4)";
          }}
          linkWidth={(link) => {
            const key = `${link.source?.id || link.source}->${link.target?.id || link.target}`;
            return neighborSets.links.has(key) ? graphSettings.linkThickness * 2.2 : graphSettings.linkThickness;
          }}
          linkDirectionalParticles={activeNodeId ? 2 : 0}
          linkDirectionalParticleSpeed={0.004}
          linkDirectionalParticleWidth={2.5}
          linkDirectionalParticleColor={() => "#64dcb1"}
          linkDirectionalArrowLength={graphSettings.arrows ? 5 : 0}
          linkDirectionalArrowRelPos={0.9}
          onNodeClick={handleNodeClick}
          onNodeHover={handleNodeHover}
          nodeCanvasObject={(node, context, globalScale) => {
            const radius = Math.max(4, (node.val || 6) / 2);
            const isHighlighted = neighborSets.nodes.size === 0 || neighborSets.nodes.has(node.id);
            const isSelected = selectedNode?.id === node.id;
            const isHovered = hoveredNode?.id === node.id;

            context.globalAlpha = isHighlighted ? 1 : 0.15;

            // Halo on select or hover
            if (isSelected || isHovered) {
              context.beginPath();
              context.arc(node.x, node.y, radius + 6, 0, 2 * Math.PI);
              context.fillStyle = isSelected ? "rgba(100, 220, 177, 0.3)" : "rgba(56, 189, 248, 0.25)";
              context.fill();
              context.strokeStyle = isSelected ? "#64dcb1" : "#38bdf8";
              context.lineWidth = 1.5 / globalScale;
              context.stroke();
            }

            // Node body
            context.fillStyle = node.color || "#dce6e3";
            context.beginPath();
            context.arc(node.x, node.y, radius, 0, 2 * Math.PI);
            context.fill();

            // Label
            if (globalScale > 1.2 || isSelected || isHovered || (neighborSets.nodes.size > 0 && isHighlighted)) {
              const fontSize = Math.max(8, 11 / globalScale);
              context.font = `600 ${fontSize}px "DM Mono", monospace`;
              context.fillStyle = isHighlighted ? "#f0fdf4" : "#4b5c56";
              context.fillText(node.name, node.x + radius + 4, node.y + 3);
            }
            context.globalAlpha = 1;
          }}
        />
      </div>

      <div className="graph-footer-legend">
        <span><i className="legend-dot" style={{ background: "#38bdf8" }} /> Sovereign Country</span>
        <span><i className="legend-dot" style={{ background: "#76e2b5" }} /> Central Bank</span>
        <span><i className="legend-dot" style={{ background: "#eab308" }} /> Currency Hub</span>
        <span><i className="legend-dot" style={{ background: "#f97316" }} /> Payment Rail</span>
        <span className="graph-hint">Zero-jitter physics · Drag to reposition · Click to inspect relations</span>
      </div>
    </section>
  );
}
