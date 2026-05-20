/**
 * Generic agent spawning interface.
 *
 * One spawn = one tempdir = one Deno process. The top-level agent and any
 * sub-agent are spawned through the same `spawnAgent(...)` call; the only
 * difference between them is the contents of the `ResolvedClass` they're
 * given (which skills, which tools, which bootstrap kind).
 *
 * Lifecycle:
 *   1. The caller passes a `ResolvedClass` — a self-contained snapshot of
 *      the agent.class record together with every agent.skill it references
 *      and every agent.tool.typescript those skills reference. Each tool
 *      carries its FULL main.ts source + deno.json + (optional) deno.lock,
 *      so the caller's resolution doesn't have to leave anything live in the
 *      ATProto network during the spawn.
 *   2. `materializeAgentTempDir(spec)` builds a fresh tempdir:
 *        tempdir/main.ts        # agent_template.ts with imports rewritten
 *        tempdir/deno.json      # absolute-path import map + npm:
 *        tempdir/deno.lock      # copied from agent root if present
 *        tempdir/config.json    # full ResolvedClass + input + bootstrap
 *        tempdir/tools/<n>/main.ts   # verbatim from agent.tool.typescript
 *        tempdir/tools/<n>/deno.json
 *        tempdir/tools/<n>/deno.lock
 *        tempdir/bridge.sock    # created by SubprocessOrchestrator on listen
 *   3. `spawnAgent(spec, parentCtx?)` materializes the tempdir, then hands
 *      the tempdir to `SubprocessOrchestrator` which:
 *        - listens on `bridge.sock` inside the same tempdir,
 *        - spawns `deno run --allow-all main.ts --socket bridge.sock
 *          --config config.json`,
 *        - yields every event the child emits over the bridge, with the
 *          child's root FlowContext re-parented onto `parentCtx`.
 *
 * The same flow applies whether the agent is the top-level webhook
 * handler or a 4th-nested sub-agent. There's no "top-level" code path
 * anywhere — main.ts is just a webhook server that calls `spawnAgent` per
 * request with the top-level-agent class.
 */
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { parse as yamlParse } from "https://deno.land/std@0.136.0/encoding/yaml.ts";
import {
  type FlowContext,
  type OrchestratorEvent,
  SubprocessOrchestrator,
} from "./dffml.ts";

// ── Types ───────────────────────────────────────────────────────────────────

export type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

export type ResolvedTool = {
  uri?: string;
  cid?: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  spawnsSubAgent?: boolean;
  source: string;
  denoJson?: string;
  denoLock?: string;
};

export type ResolvedSkill = {
  uri?: string;
  cid?: string;
  name: string;
  description: string;
  content: string;
  examples: StrongRef[];
  tools: ResolvedTool[];
};

export type Bootstrap =
  | "atproto-password"
  | "welcome-mat-on-enroll"
  | "none";

export type ResolvedClass = {
  uri?: string;
  cid?: string;
  name: string;
  description: string;
  spawnsSubAgent: boolean;
  entryTool?: string;
  bootstrap: Bootstrap;
  skills: ResolvedSkill[];
};

export type AgentSpec = {
  resolvedClass: ResolvedClass;
  input: unknown;
  env?: Record<string, string>;
  digitalOceanToken?: string;
  inferenceModel?: string;
};

// ── Paths to the repo-local sources the materialized tempdir will import.
// We resolve these once at module load so callers don't have to.
const AGENT_REPO_ROOT = new URL("./", import.meta.url);

function fileUrl(relPath: string): string {
  return new URL(relPath, AGENT_REPO_ROOT).href;
}

const DFFML_URL = fileUrl("./dffml.ts");
const WELCOMEMAT_URL = fileUrl("./welcomeMat.ts");
const SUBAGENTS_URL = fileUrl("./subagents.ts");
const AGENTRUNTIME_URL = fileUrl("./agentRuntime.ts");
const TEMPLATE_PATH = new URL("./agent_template.ts", AGENT_REPO_ROOT)
  .pathname;
const PARENT_DENO_LOCK = new URL("./deno.lock", AGENT_REPO_ROOT).pathname;

// Rewrite any relative import of a known agent-repo source file to its
// absolute file:// URL, so the same source compiles in-repo (type-checks
// against the actual files) and works after being materialized into a
// random tempdir. Filenames are matched as the path's final segment, with
// any number of leading "./" or "../" components.
const IMPORT_MAP: Record<string, string> = {
  "dffml.ts": DFFML_URL,
  "welcomeMat.ts": WELCOMEMAT_URL,
  "subagents.ts": SUBAGENTS_URL,
  "agentRuntime.ts": AGENTRUNTIME_URL,
};

function rewriteImports(src: string): string {
  for (const [name, url] of Object.entries(IMPORT_MAP)) {
    const escaped = name.replace(/\./g, "\\.");
    const re = new RegExp(
      `"(?:\\./|\\.\\./)*${escaped}"`,
      "g",
    );
    src = src.replace(re, `"${url}"`);
  }
  return src;
}

// ── Template materialization ───────────────────────────────────────────────

/**
 * Read agent_template.ts source, rewrite its relative imports of
 * dffml/welcomeMat/subagents into absolute file:// URLs so the materialized
 * copy in tempdir/main.ts resolves them against the agent repo, no
 * deno.json gymnastics required.
 */
async function loadTemplateSource(): Promise<string> {
  const src = await Deno.readTextFile(TEMPLATE_PATH);
  return rewriteImports(src);
}

function defaultToolDenoJson(): string {
  return JSON.stringify({
    nodeModulesDir: "auto",
    imports: {
      "@atproto/api": "npm:@atproto/api@^0.19.18",
      "@atproto/common-web": "npm:@atproto/common-web@^0.4.21",
      "@atproto/identity": "npm:@atproto/identity@^0.4.12",
    },
  }, null, 2);
}

function tempdirDenoJson(): string {
  return JSON.stringify({
    nodeModulesDir: "auto",
    imports: {
      "@atproto/api": "npm:@atproto/api@^0.19.18",
      "@atproto/common-web": "npm:@atproto/common-web@^0.4.21",
      "@atproto/identity": "npm:@atproto/identity@^0.4.12",
    },
  }, null, 2);
}

/**
 * Materialize a fresh tempdir containing everything the spawned agent
 * process needs: main.ts (template), deno.json, deno.lock (copied if
 * available), config.json (spec snapshot), and each tool's main.ts/deno.json
 * /deno.lock under tools/<tool>/.
 */
export async function materializeAgentTempDir(
  spec: AgentSpec,
): Promise<{ tempDir: string; mainPath: string; configPath: string }> {
  const tempDir = await Deno.makeTempDir({
    prefix: `agent-${spec.resolvedClass.name.replace(/[^a-z0-9-]+/gi, "_")}-`,
  });

  // 1. main.ts — the universal runner template.
  const templateSrc = await loadTemplateSource();
  const mainPath = `${tempDir}/main.ts`;
  await Deno.writeTextFile(mainPath, templateSrc);

  // 2. deno.json — npm import map + nodeModulesDir.
  await Deno.writeTextFile(`${tempDir}/deno.json`, tempdirDenoJson());

  // 3. deno.lock — copy parent's if present so npm hash-pins match.
  if (await exists(PARENT_DENO_LOCK)) {
    try {
      const lock = await Deno.readTextFile(PARENT_DENO_LOCK);
      await Deno.writeTextFile(`${tempDir}/deno.lock`, lock);
    } catch { /* best-effort */ }
  }

  // 4. tools/<name>/ — source from each ResolvedTool, with the same
  //    relative→file:// import rewriting we apply to the template, so the
  //    materialized copy can resolve dffml / welcomeMat / subagents etc.
  //    against the agent repo regardless of how the tool sat on disk
  //    pre-publication.
  await Deno.mkdir(`${tempDir}/tools`, { recursive: true });
  for (const skill of spec.resolvedClass.skills) {
    for (const tool of skill.tools) {
      const toolDir = `${tempDir}/tools/${tool.name}`;
      await Deno.mkdir(toolDir, { recursive: true });
      await Deno.writeTextFile(
        `${toolDir}/main.ts`,
        rewriteImports(tool.source),
      );
      const denoJson = tool.denoJson ?? defaultToolDenoJson();
      await Deno.writeTextFile(`${toolDir}/deno.json`, denoJson);
      if (tool.denoLock) {
        await Deno.writeTextFile(`${toolDir}/deno.lock`, tool.denoLock);
      }
    }
  }

  // 5. config.json — the full spec (minus secrets that live in env).
  const configPath = `${tempDir}/config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify(
      {
        class: {
          name: spec.resolvedClass.name,
          description: spec.resolvedClass.description,
          spawnsSubAgent: spec.resolvedClass.spawnsSubAgent,
          entryTool: spec.resolvedClass.entryTool,
          bootstrap: spec.resolvedClass.bootstrap,
        },
        skills: spec.resolvedClass.skills.map((s) => ({
          uri: s.uri,
          name: s.name,
          description: s.description,
          content: s.content,
          examples: s.examples,
          tools: s.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            spawnsSubAgent: t.spawnsSubAgent ?? false,
          })),
        })),
        input: spec.input,
        inferenceModel: spec.inferenceModel,
        // Note: digitalOceanToken + ATPROTO_PASSWORD are passed via env, not
        // config.json, so config.json is safe to log.
      },
      null,
      2,
    ),
  );

  return { tempDir, mainPath, configPath };
}

// ── Spawning ────────────────────────────────────────────────────────────────

/**
 * Spawn an agent in a fresh tempdir + process. Yields every bubbled
 * orchestrator event from the child; the generator's return value is
 * whatever the child sent via `bridge.result(...)`.
 *
 * Cleanup: when the child exits we ATTEMPT to remove the tempdir. If
 * something errors mid-spawn we leave it on disk so the user can inspect.
 */
export async function* spawnAgent(
  spec: AgentSpec,
  parentCtx?: FlowContext,
): AsyncGenerator<OrchestratorEvent, unknown, unknown> {
  const { tempDir, mainPath, configPath } = await materializeAgentTempDir(
    spec,
  );

  const env: Record<string, string> = { ...spec.env };
  if (spec.digitalOceanToken) {
    env["DIGITALOCEAN_TOKEN"] = spec.digitalOceanToken;
  }

  const orc = new SubprocessOrchestrator();
  const gen = orc.run(
    {
      scriptPath: mainPath,
      input: spec.input,
      args: ["--config", configPath],
      env,
    },
    parentCtx,
    `agent:${spec.resolvedClass.name}`,
  );

  let result: unknown = undefined;
  try {
    while (true) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      yield next.value;
    }
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch { /* leave on disk for inspection */ }
  }
  return result;
}

// ── Local resolution (development before publishing to ATProto) ─────────────

type ClassYaml = {
  name: string;
  description: string;
  skills: string[]; // skill directory names
  parent?: string;
  spawnsSubAgent?: boolean;
  entryTool?: string;
  bootstrap?: Bootstrap;
};

type SkillFrontmatter = {
  name: string;
  description: string;
  examples?: StrongRef[];
};

type ToolSpecJson = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  spawnsSubAgent?: boolean;
};

function parseFrontmatter(text: string): { meta: SkillFrontmatter; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: { name: "", description: "" }, body: text };
  return {
    meta: yamlParse(m[1]) as SkillFrontmatter,
    body: m[2],
  };
}

/**
 * Resolve a class definition entirely from local files (classes/<name>.yaml
 * + skills/<dir>/SKILL.md + skills/<dir>/tools/<tool>/...). Used before
 * gitops has had a chance to publish ATProto records, or in environments
 * where the agent wants to run against its own working tree rather than
 * the network's latest snapshot.
 *
 * Returns a fully-resolved `ResolvedClass` with every tool's source content
 * embedded — identical shape to what a network resolver would produce.
 */
export async function resolveClassFromLocal(
  classYamlPath: string,
  skillsDir: string,
): Promise<ResolvedClass> {
  const doc = yamlParse(await Deno.readTextFile(classYamlPath)) as ClassYaml;
  if (!doc?.name || !doc?.description || !Array.isArray(doc?.skills)) {
    throw new Error(`${classYamlPath}: invalid class yaml`);
  }

  const skills: ResolvedSkill[] = [];
  for (const dirName of doc.skills) {
    const skillDir = `${skillsDir}/${dirName}`;
    let skillMd: string | undefined;
    for (
      const cand of [`${skillDir}/SKILL.md`, `${skillDir}/${dirName}.md`]
    ) {
      if (await exists(cand)) {
        skillMd = cand;
        break;
      }
    }
    if (!skillMd) {
      throw new Error(`${classYamlPath}: skill dir ${skillDir}/ has no SKILL.md`);
    }
    const { meta, body } = parseFrontmatter(await Deno.readTextFile(skillMd));

    // Tools.
    const tools: ResolvedTool[] = [];
    const toolsDir = `${skillDir}/tools`;
    if (await exists(toolsDir)) {
      for await (const tEntry of Deno.readDir(toolsDir)) {
        if (!tEntry.isDirectory) continue;
        const tDir = `${toolsDir}/${tEntry.name}`;
        const specPath = `${tDir}/spec.json`;
        const mainPath = `${tDir}/main.ts`;
        if (!(await exists(specPath)) || !(await exists(mainPath))) continue;
        const spec = JSON.parse(
          await Deno.readTextFile(specPath),
        ) as ToolSpecJson;
        const source = await Deno.readTextFile(mainPath);
        const denoJsonPath = `${tDir}/deno.json`;
        const denoLockPath = `${tDir}/deno.lock`;
        const denoJson = (await exists(denoJsonPath))
          ? await Deno.readTextFile(denoJsonPath)
          : undefined;
        const denoLock = (await exists(denoLockPath))
          ? await Deno.readTextFile(denoLockPath)
          : undefined;
        tools.push({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.inputSchema,
          spawnsSubAgent: spec.spawnsSubAgent,
          source,
          denoJson,
          denoLock,
        });
      }
      tools.sort((a, b) => a.name.localeCompare(b.name));
    }

    skills.push({
      name: meta.name ?? dirName,
      description: meta.description ?? "",
      content: body.trim(),
      examples: meta.examples ?? [],
      tools,
    });
  }

  return {
    name: doc.name,
    description: doc.description,
    spawnsSubAgent: doc.spawnsSubAgent ?? false,
    entryTool: doc.entryTool,
    bootstrap: doc.bootstrap ?? "none",
    skills,
  };
}
