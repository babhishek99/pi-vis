import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Offline fixture: only the public Radius artifact endpoint is intercepted. */
export default function sessionShareFixture(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://radius.pi.dev/v1/artifacts?")) {
      writeFileSync(
        join(process.env["PI_CODING_AGENT_DIR"]!, "share-upload.json"),
        JSON.stringify({ url, method: init?.method, headers: init?.headers, body: init?.body }),
      );
      return new Response(
        JSON.stringify({
          artifact: { canonical_url: "https://radius.pi.dev/artifact/real-sdk-fixture" },
        }),
      );
    }
    return originalFetch(input, init);
  };
}
