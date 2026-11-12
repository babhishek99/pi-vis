import { randomUUID } from "node:crypto";

const RPC_TIMEOUT_MS = 250;

/** One private, public-Pi EventBus per runtime; no registry or history enumeration. */
export function createSubagentStopClient(events) {
  const clientId = randomUUID();
  let sequence = 0;
  let advertised = false;
  events.on("subagents:ready", () => {
    advertised = true;
  });

  function request(channel, payload) {
    let done = false;
    let unsubscribe;
    let timer;
    let settle;
    const result = new Promise((resolve) => {
      settle = resolve;
    });
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        unsubscribe?.();
      } catch {
        /* cleanup cannot replace the receipt */
      }
      settle(value);
    };
    try {
      unsubscribe = events.on(`${channel}:reply:${payload.requestId}`, (reply) =>
        finish({ reply }),
      );
      timer = setTimeout(() => finish({ timeout: true }), RPC_TIMEOUT_MS);
      timer.unref?.();
      // No await: the extension installs its stop generation in this emit stack.
      events.emit(channel, payload);
    } catch {
      finish({ failed: true });
    }
    return result;
  }

  return {
    async stop() {
      const requestId = randomUUID();
      // Dispatch BEFORE discovery. A delayed ping must never dispatch a stop
      // into later work; both messages belong to this one captured runtime.
      const stopping = request("subagents:rpc:stop-all", {
        requestId,
        clientId,
        sequence: ++sequence,
      });
      const discovery = request("subagents:rpc:ping", { requestId: randomUUID() });
      const [stop, ping] = await Promise.all([stopping, discovery]);
      try {
        if (stop.failed || ping.failed) return { status: "failed" };
        if (stop.reply?.success === false) return { status: "failed" };
        const capabilities = ping.reply?.data;
        if (
          ping.reply &&
          (ping.reply.success !== true ||
            capabilities?.version !== 4 ||
            capabilities?.capabilities?.stopAll !== true)
        )
          return { status: "unsupported" };
        const data = stop.reply?.data;
        if (
          ping.reply?.success === true &&
          stop.reply?.success === true &&
          Number.isSafeInteger(data?.agents) &&
          data.agents >= 0 &&
          Number.isSafeInteger(data?.workflows) &&
          data.workflows >= 0 &&
          typeof data?.pendingOperations === "boolean" &&
          typeof data?.pendingNotifications === "boolean"
        ) {
          return {
            status: "requested",
            agents: data.agents,
            workflows: data.workflows,
            pendingOperations: data.pendingOperations,
            pendingNotifications: data.pendingNotifications,
          };
        }
        // No bound advertisement and no replies is the absent/filtered case.
        // Otherwise a sent stop with no valid acknowledgement stays unknown.
        return {
          status: !advertised && stop.timeout && ping.timeout ? "unavailable" : "outcome_unknown",
        };
      } catch {
        // Never return extension-owned error strings, objects or getters to IPC.
        return { status: "failed" };
      }
    },
  };
}

/** The direct transport is never replayed into a successor or a newer generation. */
export function createTabEscapeHandler({ authority, getSession, getStopClient }) {
  let prior;
  return (request) => {
    const { requestId, sequence, expectedHostInstanceId, expectedSessionEpoch } = request;
    const base = {
      requestId,
      hostInstanceId: expectedHostInstanceId,
      sessionEpoch: expectedSessionEpoch,
    };
    if (
      typeof requestId !== "string" ||
      !requestId ||
      requestId.length > 128 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      expectedHostInstanceId !== authority.hostInstanceId ||
      expectedSessionEpoch !== authority.sessionEpoch ||
      authority.isTransitioning ||
      authority.isClosing
    ) {
      return Promise.resolve({ ...base, disposition: "not_applicable" });
    }
    if (prior && sequence <= prior.sequence) {
      return sequence === prior.sequence && requestId === prior.requestId
        ? prior.result
        : Promise.resolve({ ...base, disposition: "not_applicable" });
    }
    // Install the replay fence before calling Pi: abort listeners can reenter.
    let resolve;
    const result = new Promise((done) => {
      resolve = done;
    });
    const entry = { sequence, requestId, result };
    prior = entry;
    const capturedSession = getSession();
    const current = () =>
      prior === entry &&
      getSession() === capturedSession &&
      authority.hostInstanceId === expectedHostInstanceId &&
      authority.sessionEpoch === expectedSessionEpoch &&
      !authority.isTransitioning &&
      !authority.isClosing;
    const run = async () => {
      // requestEscape signals the parent synchronously, before discovery,
      // extension getters/callbacks, or any await. Its queue custody stays in
      // the existing authority rather than being reconstructed here.
      let parent;
      try {
        parent = authority.requestEscape(requestId);
      } catch {
        // Even a broken parent selector must not suppress the other boundary.
        parent = {
          ...base,
          disposition: "outcome_unknown",
          message: "Interrupt acknowledgement failed",
        };
      }
      let stopping;
      try {
        const client = current() ? getStopClient(capturedSession) : undefined;
        stopping = current() && client ? client.stop() : { status: "unavailable" };
      } catch {
        stopping = { status: "failed" };
      }
      const [value, subagents] = await Promise.all([parent, stopping]);
      if (!current())
        return {
          ...base,
          disposition: "outcome_unknown",
          message: "Session changed before interrupt acknowledgement",
        };
      if (["failed", "outcome_unknown"].includes(value.disposition)) return { ...value, subagents };
      if (["failed", "outcome_unknown", "unsupported"].includes(subagents.status)) {
        return {
          ...value,
          subagents,
          disposition: "outcome_unknown",
          message:
            subagents.status === "unsupported"
              ? "Parent interruption was handled, but this subagent extension needs the stop-all update."
              : "Parent interruption was handled, but subagent cancellation could not be confirmed.",
        };
      }
      if (
        subagents.status === "requested" &&
        (subagents.agents > 0 ||
          subagents.workflows > 0 ||
          subagents.pendingOperations ||
          subagents.pendingNotifications) &&
        ["already_inactive", "not_applicable"].includes(value.disposition)
      ) {
        return { ...value, subagents, disposition: "abort_requested", target: "subagents" };
      }
      return { ...value, subagents };
    };
    // Preserve a rejected parent/buggy client as bounded delivery uncertainty.
    void run().then(resolve, () =>
      resolve({
        ...base,
        disposition: "outcome_unknown",
        message: "Interrupt acknowledgement failed",
      }),
    );
    return result;
  };
}
