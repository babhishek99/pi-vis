import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { formatTokens } from "../../lib/format.js";
import { useSessionsStore } from "../../stores/sessions-store.js";
import { GatewaySessionSpend } from "../gateway-spend/GatewaySessionSpend.js";
import "./ContextMeter.css";

/**
 * Circular context-usage ring with a click-to-open details dropdown.
 *
 * Reads `get_session_stats` data from the store:
 *  - `contextUsage.{tokens, contextWindow, percent}` drives the ring.
 *  - `tokens.{input, output, cacheRead, cacheWrite}` populates the dropdown
 *    breakdown + a derived cache-hit rate.
 *
 * The dropdown is an in-flow card (not a modal) anchored under the ring,
 * right-aligned to the controls cluster edge. It claims ESC + closes on
 * outside click, matching the model/thinking dropdowns.
 */
export function ContextMeter({ sessionId }: { sessionId: SessionId }): React.ReactElement {
  // Streaming updates replace the session object frequently. Subscribe only
  // to the stats slice so the title-bar meter does not rerender for every
  // transcript delta.
  const stats = useSessionsStore((s) => s.sessions.get(sessionId)?.stats);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();

  useEscapeClaim(open);

  useLayoutEffect(() => {
    if (!open) return;
    const fit = (): void => {
      const wrap = wrapRef.current;
      const card = wrap?.querySelector<HTMLElement>(".context-dropdown");
      if (!wrap || !card) return;
      // Compact mode puts the ring inside the main card's clipping boundary.
      // Fit its actual anchor/clip, not a guessed title-bar or sidebar width.
      const anchor = wrap.getBoundingClientRect();
      const clip = wrap.closest(".app__main")?.getBoundingClientRect();
      const left = Math.max(0, clip?.left ?? 0);
      const right = Math.min(window.innerWidth, clip?.right ?? window.innerWidth);
      const available = Math.max(0, right - left);
      card.style.maxWidth = `calc(${available}px - var(--space-4))`;
      card.style.minWidth = `min(22rem, calc(${available}px - var(--space-4)))`;
      const style = getComputedStyle(card);
      const width = card.offsetWidth;
      const inset = Math.max(
        0,
        Math.min(Number.parseFloat(style.paddingLeft), (available - width) / 2),
      );
      const cardRight = Math.max(left + inset + width, Math.min(anchor.right, right - inset));
      card.style.right = `${anchor.right - cardRight}px`;
      const top = anchor.top + Number.parseFloat(style.top);
      if (!Number.isFinite(top)) return;
      const bottom = Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight);
      card.style.maxHeight = `calc(${Math.max(0, bottom - top)}px - var(--space-2))`;
    };
    const wrap = wrapRef.current;
    const controls = wrap?.parentElement;
    const clip = wrap?.closest(".app__main");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    const observeLayout = (): void => {
      observer?.disconnect();
      if (clip) observer?.observe(clip);
      if (controls) {
        observer?.observe(controls);
        // Font loading or a picker label can move the ring within a wrapping
        // row without resizing the pane (or the ring itself).
        for (const child of controls.children) observer?.observe(child);
      }
      fit();
    };
    observeLayout();
    const mutations =
      controls && typeof MutationObserver !== "undefined"
        ? new MutationObserver(observeLayout)
        : null;
    if (controls) mutations?.observe(controls, { childList: true });
    window.addEventListener("resize", fit);
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      // Electron/Chromium may retarget a title-bar event while preserving its
      // composed path. Treat the trigger as inside before changing state;
      // otherwise the opening mousedown closes the card and the following
      // click immediately reopens it instead of toggling it closed.
      if (e.composedPath().includes(wrap) || wrap.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const pct = stats?.contextUsage?.percent != null ? Math.round(stats.contextUsage.percent) : null;
  const ring = pct ?? 0;
  const used = stats?.contextUsage?.tokens ?? null;
  const windowTok = stats?.contextUsage?.contextWindow ?? null;

  const cacheHitRate = useMemo(() => {
    const t = stats?.tokens;
    if (!t) return null;
    const reads = t.cacheRead ?? 0;
    const base = (t.input ?? 0) + reads;
    if (reads <= 0 || base <= 0) return null;
    return reads / base;
  }, [stats?.tokens]);

  const tokenRows = useMemo(() => {
    const t = stats?.tokens;
    if (!t) return [];
    return [
      { label: "Input", value: formatTokens(t.input ?? 0) },
      { label: "Output", value: formatTokens(t.output ?? 0) },
      t.cacheRead > 0 ? { label: "Cache read", value: formatTokens(t.cacheRead) } : null,
      t.cacheWrite > 0 ? { label: "Cache write", value: formatTokens(t.cacheWrite) } : null,
      cacheHitRate != null && cacheHitRate > 0
        ? { label: "Cache hit rate", value: `${Math.round(cacheHitRate * 100)}%` }
        : null,
    ].filter((row): row is { label: string; value: string } => row !== null);
  }, [cacheHitRate, stats?.tokens]);

  const danger = (pct ?? 0) >= 90;
  const warn = !danger && (pct ?? 0) >= 80;
  const tone = danger ? "context-ring--danger" : warn ? "context-ring--warn" : "";

  // Ring geometry
  const size = 16;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (ring / 100) * circ;

  return (
    <div className="context-meter-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`context-ring ${tone} ${open ? "context-ring--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={pct !== null ? `${pct}% context used` : "Context usage"}
        aria-label={pct !== null ? `${pct}% context used` : "Context usage"}
        aria-expanded={open}
        aria-controls={detailsId}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
          focusable="false"
        >
          <circle
            className="context-ring__track"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
          />
          <circle
            className="context-ring__fill"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </button>

      {open && (
        <div
          id={detailsId}
          className="context-dropdown"
          role="dialog"
          aria-label="Context usage details"
        >
          {/* Context headline + linear meter (the ring, unrolled). */}
          <div className="context-dropdown__head">
            <span className="context-dropdown__label">Context</span>
            <span className="context-dropdown__value">
              {used != null ? formatTokens(used) : "—"}
              {windowTok != null && used != null && (
                <span className="context-dropdown__dim">
                  {" / "}
                  {formatTokens(windowTok)}
                </span>
              )}
              {pct !== null && (
                <span
                  className={`context-dropdown__pct${danger ? " context-dropdown__pct--danger" : warn ? " context-dropdown__pct--warn" : ""}`}
                >
                  {pct}%
                </span>
              )}
            </span>
          </div>
          <div
            className={`context-dropdown__meter${danger ? " context-dropdown__meter--danger" : warn ? " context-dropdown__meter--warn" : ""}`}
            aria-hidden
          >
            <div
              className="context-dropdown__meter-fill"
              style={{ width: `${Math.min(100, ring)}%` }}
            />
          </div>
          {tokenRows.length > 0 && (
            <dl className="context-dropdown__rows">
              {tokenRows.map((row) => (
                <Row key={row.label} label={row.label}>
                  {row.value}
                </Row>
              ))}
            </dl>
          )}
          <GatewaySessionSpend sessionId={sessionId} />
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="context-dropdown__row">
      <dt className="context-dropdown__label">{label}</dt>
      <dd className="context-dropdown__value">{children}</dd>
    </div>
  );
}
