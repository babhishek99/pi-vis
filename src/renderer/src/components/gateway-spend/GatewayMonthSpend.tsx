import type React from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useEscapeClaim } from "../../hooks/useEscapeClaim.js";
import { FadeText } from "../common/FadeText.js";
import { IconChevronDown } from "../common/icons.js";
import { GatewaySpendDetails, spendMonth, spendValue } from "./GatewaySpendDetails.js";
import { useGatewayMonthSpend } from "./use-gateway-spend.js";

/** Quiet, inline disclosure: it stays inside the sidebar's overflow boundary. */
export function GatewayMonthSpend(): React.ReactElement | null {
  const read = useGatewayMonthSpend();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const detailsId = useId();
  const titleId = useId();
  const hidden = read.result?.state === "not_configured";
  const expanded = open && !hidden;
  useEscapeClaim(expanded);

  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: MouseEvent | FocusEvent): void => {
      const wrap = wrapRef.current;
      if (!wrap || event.composedPath().includes(wrap) || wrap.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [expanded]);

  useLayoutEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  if (hidden) return null;
  const partial = (read.result?.snapshot?.unpricedRequests ?? 0) > 0;
  const stale = read.result?.stale || (read.failed && read.result?.snapshot != null);
  const value = !read.result && read.busy ? "Reading audit logs…" : spendValue(read.result);
  const summary = `${value}${partial ? " · Partial" : ""}${stale ? " · Stale" : ""}`;

  return (
    <section className="gateway-spend-month" ref={wrapRef} aria-labelledby={titleId}>
      <button
        ref={triggerRef}
        type="button"
        className="gateway-spend-month__trigger fade-scope"
        aria-label="Current month gateway spend"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="gateway-spend-month__summary">
          <span id={titleId} className="gateway-spend-month__title">
            <FadeText>Gateway · {spendMonth(read.result)} · MTD</FadeText>
          </span>
          <FadeText className="gateway-spend-month__amount">{summary}</FadeText>
        </span>
        <IconChevronDown className="gateway-spend-month__caret" />
      </button>
      {expanded && (
        <div
          id={detailsId}
          role="region"
          aria-label="Monthly gateway spend details"
          className="gateway-spend-month__details"
        >
          <GatewaySpendDetails read={read} />
        </div>
      )}
    </section>
  );
}
