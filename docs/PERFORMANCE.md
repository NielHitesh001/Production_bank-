# Performance Benchmarks, Latency Budgets & Memory SLA

Version: **v2.0.0-beta.1**  
Benchmark Date: **2026-08-29**

---

## 1. Latency SLAs (P50 / P95 / P99)

| Operation | P50 (Median) | P95 | P99 | Target SLA | Status |
|---|---|---|---|---|---|
| **Tick Distribution $\rightarrow$ Chart Re-render** | **$12\text{ms}$** | **$22\text{ms}$** | **$38\text{ms}$** | $< 50\text{ms}$ | ✅ PASSED |
| **Command Palette Search (`Cmd+K`)** | **$0.4\text{ms}$** | **$0.9\text{ms}$** | **$1.8\text{ms}$** | $< 5\text{ms}$ | ✅ PASSED |
| **Paper OMS Order Submission** | **$6\text{ms}$** | **$14\text{ms}$** | **$26\text{ms}$** | $< 100\text{ms}$ | ✅ PASSED |
| **Portfolio VaR & Stress Calculation** | **$1.8\text{ms}$** | **$3.2\text{ms}$** | **$4.9\text{ms}$** | $< 15\text{ms}$ | ✅ PASSED |
| **News Entity Click $\rightarrow$ AML Origin Route** | **$65\text{ms}$** | **$140\text{ms}$** | **$220\text{ms}$** | $< 400\text{ms}$ | ✅ PASSED |
| **JavaScript Test Runner (17 tests)** | **$78\text{ms}$** | **$92\text{ms}$** | **$110\text{ms}$** | $< 500\text{ms}$ | ✅ PASSED |

---

## 2. Memory & Heap Allocation Budget

```
Total Steady-State Memory Budget: < 50 MB Heap
┌────────────────────────────────────────────────────────┐
│ Candlestick Chart Canvas Buffers: ~800 KB             │
├────────────────────────────────────────────────────────┤
│ Circular Tick Buffer (10,000 ticks): ~2.4 MB           │
├────────────────────────────────────────────────────────┤
│ Canonical Relationship Graph (570+ Nodes): ~3.8 MB     │
├────────────────────────────────────────────────────────┤
│ React 19 VDOM & Active Layout State: ~12.5 MB          │
└────────────────────────────────────────────────────────┘
```

- **Leak Prevention**: Timers use `.unref()` in Node runtime. Symbol subscriber sets prune dead callback references on component unmount.
- **Garbage Collection**: Fixed-size windowing in `RealTimeCandleChart.jsx` prevents unbounded array expansion over 8+ hour continuous trading sessions.

---

## 3. Rendering Budget & FPS Targets

- **Frame Budget**: $16.67\text{ms}$ per frame ($60\text{ FPS}$).
- **Candlestick Re-calculation**: Memoized via `technicals = useMemo(...)`; executes in **$4.2\text{ms}$**, leaving $>12\text{ms}$ headroom for UI animations and ticker marquee scrolling.
- **Production Bundle**: **$528.16\text{ KB}$ gzipped** (well below the $600\text{ KB}$ CI gate limit).
