import { PI_INDEX_TOKEN, PI_ROLE_INDEX } from "@shared/theme";
import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "./ansi.js";

describe("parseAnsi", () => {
  it("passes plain text through as one unstyled span", () => {
    expect(parseAnsi("hello")).toEqual([{ text: "hello", style: {} }]);
  });

  it("parses the real pi headroom status (truecolor + reset)", () => {
    // Exactly what pi-headroom sends: green ✓, dim gray label
    const input = "\x1b[38;2;181;189;104m✓ \x1b[39m \x1b[38;2;102;102;102m Headroom \x1b[39m";
    const spans = parseAnsi(input);
    expect(spans).toEqual([
      { text: "✓ ", style: { color: "rgb(181,189,104)" } },
      { text: " ", style: {} },
      { text: " Headroom ", style: { color: "rgb(102,102,102)" } },
    ]);
    expect(stripAnsi(input)).toBe("✓   Headroom ");
  });

  it("handles named colors, bold, and full reset", () => {
    const spans = parseAnsi("\x1b[1;32mok\x1b[0m done");
    expect(spans).toEqual([
      { text: "ok", style: { fontWeight: "bold", color: "var(--success)" } },
      { text: " done", style: {} },
    ]);
  });

  it("handles 256-color codes", () => {
    const spans = parseAnsi("\x1b[38;5;196mred\x1b[39m");
    expect(spans[0]).toEqual({ text: "red", style: { color: "rgb(255,0,0)" } });
  });

  it("treats bare ESC[m as a reset", () => {
    const spans = parseAnsi("\x1b[31ma\x1b[mb");
    expect(spans).toEqual([
      { text: "a", style: { color: "var(--danger)" } },
      { text: "b", style: {} },
    ]);
  });

  it("strips non-SGR escape sequences", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Gline")).toBe("line");
    expect(stripAnsi("\x1b]0;title\x07text")).toBe("text");
  });

  it("strips Pi 1.2 APC cursor markers while preserving visible text and SGR styles", () => {
    const input = "\x1b[32mleft\x1b_pi:c\x07\x1b_pi:fc\x07x\x1b_pi:/fc\x07right\x1b[0m";
    expect(stripAnsi(input)).toBe("leftxright");
    expect(parseAnsi(input).every((span) => span.style.color === "var(--success)")).toBe(true);
    expect(stripAnsi("before\x1b_pi:fc\x1b\\x\x1b_pi:/fc\x1b\\after")).toBe("beforexafter");
  });

  it("keeps dim/italic and clears them on 22/23", () => {
    const spans = parseAnsi("\x1b[2;3mfaint\x1b[22;23mnormal");
    expect(spans[0]).toEqual({ text: "faint", style: { opacity: 0.6, fontStyle: "italic" } });
    expect(spans[1]).toEqual({ text: "normal", style: {} });
  });

  // ── Live re-theming: role-identity indices resolve to live CSS vars ───────
  it("a pi-role index (host-emitted) resolves to var(--token), not literal rgb", () => {
    // The host emits stable per-role indices; AnsiText maps each to a live CSS
    // variable so widget text recolors on a scheme change with no re-render.
    const idx = PI_ROLE_INDEX.text!; // e.g. 25
    const token = PI_INDEX_TOKEN.get(idx)!; // "text"
    const spans = parseAnsi(`\x1b[38;5;${idx}mhi\x1b[39m`);
    expect(spans[0]).toEqual({ text: "hi", style: { color: `var(--${token})` } });
  });

  it("a role index used as BACKGROUND also resolves to var(--token)", () => {
    const idx = PI_ROLE_INDEX.success!;
    const token = PI_INDEX_TOKEN.get(idx)!;
    const spans = parseAnsi(`\x1b[48;5;${idx}mhi\x1b[49m`);
    expect(spans[0]).toEqual({ text: "hi", style: { backgroundColor: `var(--${token})` } });
  });
});
