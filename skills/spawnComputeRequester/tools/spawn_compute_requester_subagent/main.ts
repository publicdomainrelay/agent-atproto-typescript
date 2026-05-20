/**
 * Parent-side tool: spawn a compute-requester sub-agent.
 *
 * Called by the top-level agent's runtime (either via main.ts dispatch or,
 * once LLM mode is implemented in agent_template, via the generic tool
 * dispatcher). Resolves the compute-requester class from local files and
 * delegates to agentRuntime.spawnAgent, which materializes a fresh tempdir,
 * spawns a Deno subprocess, and streams all FlowContext events back through
 * the provided SubprocessBridge.
 *
 * Default export signature matches the agent_template entryTool protocol:
 *   async function ({ input, bridge, config }) → result
 *
 * This tool is also usable as a standalone CLI: when executed with
 * `--socket <path>` it acts as its own SubprocessBridge client, reading the
 * request from stdin and streaming events to the parent.
 */
import { parseArgs } from "jsr:@std/cli/parse-args";
import type { SubprocessBridge } from "../../../../dffml.ts";
import {
  SubprocessBridge as SubprocessBridgeImpl,
  EventType,
} from "../../../../dffml.ts";
import {
  resolveClassFromLocal,
  spawnAgent,
} from "../../../../agentRuntime.ts";

type SubAgentRequest = {
  serviceOrigin?: string;
  service_origin?: string;
  handle: string;
  vmSpec?: Record<string, unknown>;
  vm_spec?: Record<string, unknown>;
  acceptUri?: string;
  accept_uri?: string;
};

type SubAgentReport = {
  did: string;
  handle: string;
  rbacUri: string;
  vmUri: string;
  rfpUri: string;
};

function normalizeRequest(raw: SubAgentRequest) {
  return {
    serviceOrigin: (raw.serviceOrigin ?? raw.service_origin)!,
    handle: raw.handle,
    vmSpec: (raw.vmSpec ?? raw.vm_spec)!,
    acceptUri: raw.acceptUri ?? raw.accept_uri,
  };
}

// Resolve the compute-requester class from local files.
// The path is relative to this file's repo location; agentRuntime's
// import-rewrite only applies to the source of this tool at
// materialization time, not to Deno.cwd() at runtime. We use import.meta
// to find the repo root at runtime whether running in-repo or materialized.
async function loadComputeRequesterClass() {
  // From tempdir/tools/spawn_compute_requester_subagent/ we need to find
  // the classes/ and skills/ dirs.  When materialized, import.meta.url
  // is a file:// URL inside the tempdir, so we cannot navigate relative
  // to it. agentRuntime passes the repo root via AGENT_REPO_ROOT env if set;
  // otherwise fall back to the classic __dirname-style approach for in-repo
  // use.
  const repoRoot = Deno.env.get("AGENT_REPO_ROOT") ??
    new URL("../../../../", import.meta.url).pathname;
  return resolveClassFromLocal(
    `${repoRoot}/classes/compute-requester.yaml`,
    `${repoRoot}/skills`,
  );
}

export default async function run(args: {
  input: unknown;
  bridge: SubprocessBridge;
  config?: unknown;
}): Promise<SubAgentReport> {
  const raw = args.input as SubAgentRequest;
  const req = normalizeRequest(raw);
  const { bridge } = args;

  await bridge.log("info", "resolving compute-requester class...");
  const resolvedClass = await loadComputeRequesterClass();

  await bridge.log("info", `spawning compute-requester sub-agent (@${req.handle})`);

  // Spawn the sub-agent. Its entry tool (run_compute_requester_subagent)
  // will enroll a fresh account and write the RBAC+VM+RFP records.
  const gen = spawnAgent(
    {
      resolvedClass,
      input: req,
      env: {},
    },
    undefined,
  );

  let report: SubAgentReport | undefined;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      if (next.value && typeof next.value === "object" && "did" in (next.value as object)) {
        report = next.value as SubAgentReport;
      }
      break;
    }
    const [, event, data] = next.value;
    // Bubble the sub-agent's events through to this tool's bridge (→ top-level agent).
    await bridge.emit(next.value[0], event, data);
    if (event === EventType.OUTPUT) {
      const d = data as { report?: SubAgentReport };
      if (d?.report) report = d.report;
    }
  }

  if (!report) {
    throw new Error("compute-requester sub-agent produced no report");
  }
  return report;
}

// ── Standalone CLI (invoked directly as a subprocess) ─────────────────────
if (import.meta.main) {
  const flags = parseArgs(Deno.args, { string: ["socket"] });
  if (!flags.socket) {
    console.error("spawn_compute_requester_subagent: --socket required");
    Deno.exit(2);
  }
  const bridge = await SubprocessBridgeImpl.connect(flags.socket);
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(16384);
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    chunks.push(buf.slice(0, n));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  const input = JSON.parse(new TextDecoder().decode(all));

  try {
    const result = await run({ input, bridge });
    await bridge.result(result);
    console.log(JSON.stringify(result));
  } catch (err) {
    const msg = (err as Error).message;
    await bridge.log("error", msg);
    await bridge.result({ error: msg });
    console.log(JSON.stringify({ error: msg }));
    await bridge.close();
    Deno.exit(1);
  } finally {
    await bridge.close();
  }
}
