/**
 * Universal agent runner. Copied into each spawned agent's tempdir as
 * main.ts by `agentRuntime.materializeAgentTempDir`. Imports of ./dffml.ts
 * etc. get rewritten to absolute file:// URLs at materialization time, so
 * this file type-checks against the agent repo while the materialized copy
 * resolves them against the agent repo's actual location on disk.
 *
 * Wire-up:
 *   - `--socket <path>` is set by SubprocessOrchestrator (the parent listens
 *     on this unix socket and waits for our SubprocessBridge connection).
 *   - `--config <path>` is set by agentRuntime.spawnAgent and points at
 *     ./config.json in the same tempdir. config.json carries:
 *       { class: {name, entryTool?, bootstrap, ...},
 *         skills: [{name, content, examples, tools: [...]}],
 *         input: <opaque, fed to entry tool / LLM>,
 *         inferenceModel?: string }
 *   - The agent's stdin carries the same `input` payload as JSON (so a tool
 *     run as a CLI subprocess also gets it on stdin — same shape, same
 *     parser).
 *
 * Dispatch:
 *   - If `class.entryTool` is set, we run in DETERMINISTIC mode: dynamically
 *     import `./tools/<entryTool>/main.ts`, call its default export with
 *     `{ input, bridge, config }`, and forward its return value as the
 *     agent's result. The entry tool is responsible for emitting bridge
 *     events itself if it wants its work visible to the parent's
 *     FlowContext.
 *   - Otherwise we run in LLM mode (placeholder in this revision —
 *     migration of main.ts's runAgentLoop into this template is the next
 *     step). For now LLM-mode classes will error out and the caller should
 *     keep using the old in-process loop until that migration lands.
 */
import { parseArgs } from "jsr:@std/cli/parse-args";
import { SubprocessBridge } from "./dffml.ts";

type AgentConfig = {
  class: {
    name: string;
    description: string;
    spawnsSubAgent: boolean;
    entryTool?: string;
    bootstrap: "atproto-password" | "welcome-mat-on-enroll" | "none";
  };
  skills: Array<{
    uri?: string;
    name: string;
    description: string;
    content: string;
    examples: Array<{ uri: string; cid: string; $type: string }>;
    tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      spawnsSubAgent?: boolean;
    }>;
  }>;
  input: unknown;
  inferenceModel?: string;
};

const flags = parseArgs(Deno.args, { string: ["socket", "config"] });
if (!flags.socket || !flags.config) {
  console.error("agent_template: --socket and --config required");
  Deno.exit(2);
}

const config = JSON.parse(
  await Deno.readTextFile(flags.config),
) as AgentConfig;

const bridge = await SubprocessBridge.connect(flags.socket);

async function readStdinAsJson(): Promise<unknown | undefined> {
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(16 * 1024);
  while (true) {
    let n: number | null = null;
    try {
      n = await Deno.stdin.read(buf);
    } catch {
      break;
    }
    if (n === null) break;
    chunks.push(buf.slice(0, n));
  }
  if (chunks.length === 0) return undefined;
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  const txt = new TextDecoder().decode(all).trim();
  if (!txt) return undefined;
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

// stdin input overrides config.input (the parent may stream a fresh payload
// per spawn while config.json holds defaults).
const stdinPayload = await readStdinAsJson();
const input = stdinPayload ?? config.input;

let result: unknown = undefined;
try {
  if (config.class.entryTool) {
    // Deterministic mode: hand off to the entry tool.
    const toolName = config.class.entryTool;
    const toolUrl = new URL(`./tools/${toolName}/main.ts`, import.meta.url)
      .href;
    await bridge.log(
      "info",
      `entryTool=${toolName} bootstrap=${config.class.bootstrap}`,
    );
    const mod = await import(toolUrl) as {
      default?: (args: {
        input: unknown;
        bridge: SubprocessBridge;
        config: AgentConfig;
      }) => Promise<unknown>;
      run?: (args: unknown) => Promise<unknown>;
    };
    const fn = mod.default ?? mod.run;
    if (!fn) {
      throw new Error(
        `tool ${toolName}: main.ts must export a default async function`,
      );
    }
    result = await fn({ input, bridge, config });
  } else {
    // LLM mode is not yet implemented in the universal template. Callers
    // whose class has no entryTool currently run the in-process loop in
    // main.ts; migrating that loop into this template (so main.ts becomes a
    // thin webhook server that spawns top-level-agent through agentRuntime)
    // is the next step.
    throw new Error(
      `LLM-mode classes are not yet supported in agent_template (class="${config.class.name}" has no entryTool)`,
    );
  }
  await bridge.result(result);
  // Also emit on stdout so callers that ignore the bridge can recover it.
  console.log(JSON.stringify(result));
} catch (err) {
  const msg = (err as Error)?.message ?? String(err);
  await bridge.log("error", `agent failed: ${msg}`);
  await bridge.result({ error: msg });
  console.log(JSON.stringify({ error: msg }));
  await bridge.close();
  Deno.exit(1);
} finally {
  await bridge.close();
}
