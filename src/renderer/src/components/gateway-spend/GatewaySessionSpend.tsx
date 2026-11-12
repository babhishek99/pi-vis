import type { SessionId } from "@shared/ids.js";
import type React from "react";
import { GatewaySpendDetails } from "./GatewaySpendDetails.js";
import { useGatewaySessionSpend } from "./use-gateway-spend.js";

/** Mounted only by the open ContextMeter; no background session billing poll. */
export function GatewaySessionSpend({
  sessionId,
}: { sessionId: SessionId }): React.ReactElement | null {
  const read = useGatewaySessionSpend(sessionId);
  if (read.result?.state === "not_configured") return null;
  return (
    <section className="gateway-session-spend" aria-label="Direct session gateway spend">
      <div className="gateway-session-spend__heading">
        <span>Direct session gateway spend</span>
        <span className="gateway-spend__partial">Partial</span>
      </div>
      <GatewaySpendDetails read={read} session />
    </section>
  );
}
