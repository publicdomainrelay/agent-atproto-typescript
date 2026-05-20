#!/usr/bin/env -S deno run --allow-all
import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { parse, stringify as yamlStringify } from "https://deno.land/std@0.136.0/encoding/yaml.ts";
import { Agent, CredentialSession, RichText } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";

// Lexicon: com.publicdomainrelay.temp.agent.skill
export type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

export type PropertyReference =
  | { path: string; string: string }
  | { path: string; $type: "com.atproto.repo.strongRef"; uri: string; cid: string };

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  spawnsSubAgent?: boolean;
};

type AgentSkill = {
  $type: "com.publicdomainrelay.temp.agent.skill";
  name: string;
  description: string;
  content: string;
  examples: StrongRef[];
  property_references?: PropertyReference[];
  tools?: ToolSpec[];
  createdAt: string;
};

const SKILL_COLLECTION = "com.publicdomainrelay.temp.agent.skill";

const idResolver = new IdResolver();

export async function getPdsForDid(did: string): Promise<string> {
  const didDoc = await idResolver.did.resolve(did);
  if (!didDoc) throw new Error(`Could not resolve DID: ${did}`);
  const pds = getPdsEndpoint(didDoc);
  if (!pds) throw new Error(`No PDS endpoint in DID doc for ${did}`);
  return pds;
}

async function resolveStrongRef(ref: StrongRef): Promise<unknown> {
  const atUri = ref.uri;
  const withoutPrefix = atUri.slice("at://".length);
  const [did, collection, rkey] = withoutPrefix.split("/");
  const pds = await getPdsForDid(did);

  const readAgent = new Agent(new URL(pds));
  const result = await readAgent.com.atproto.repo.getRecord({
    repo: did,
    collection,
    rkey,
  });
  return result.data;
}

function isStrongRef(val: unknown): val is StrongRef {
  return (
    typeof val === "object" &&
    val !== null &&
    (val as StrongRef).$type === "com.atproto.repo.strongRef"
  );
}

async function createAtprotoRecord(
  agent: Agent,
  collection: string,
  record: Record<string, unknown>,
): Promise<StrongRef> {
  if (collection === "app.bsky.feed.post" && typeof record.text === "string") {
    const rt = new RichText({ text: record.text });
    await rt.detectFacets(agent);
    record.text = rt.text;
    if (rt.facets && rt.facets.length > 0) record.facets = rt.facets;
  }

  const result = await agent.com.atproto.repo.createRecord({
    repo: agent.assertDid,
    collection,
    record,
  });

  return {
    $type: "com.atproto.repo.strongRef",
    uri: result.data.uri,
    cid: result.data.cid,
  };
}


type Config = {
  skillMd?: string;
  exampleYamls: string[];
  skillsDir?: string;
  overwrite: boolean;
  atprotoPassword: string;
  agentDid: string;
  agent: Agent;
};

function makeEnv(): Config {
  const atprotoPassword = Deno.env.get("ATPROTO_PASSWORD");
  if (!atprotoPassword) {
    console.error("ATPROTO_PASSWORD is not set");
    Deno.exit(1);
  }

  const agentDid = Deno.env.get("AGENT_DID");
  if (!agentDid) {
    console.error("AGENT_DID is not set");
    Deno.exit(1);
  }

  const flags = parseArgs(Deno.args, {
    string: ["skill", "skills-dir"],
    boolean: ["overwrite"],
    collect: ["example"],
    alias: { "examples": "example" },
  });

  const skillMd = flags["skill"] as string | undefined;
  const skillsDir = flags["skills-dir"] as string | undefined;
  const exampleYamls = (flags.example as string[]) ?? [];
  const overwrite = flags["overwrite"] as boolean;

  if (!skillMd && !skillsDir) {
    console.error("--skill <file.md> or --skills-dir <dir> is required");
    Deno.exit(1);
  }

  return {
    skillMd,
    exampleYamls,
    skillsDir,
    overwrite,
    atprotoPassword,
    agentDid,
    agent: null as unknown as Agent,
  };
}

export type DiscoveredSkill = {
  dir: string;          // skill directory name (e.g. "spawnComputeRequester")
  skillMd: string;      // path to SKILL.md
  exampleYamls: string[];
  toolSpecs: ToolSpec[]; // contents of skill_dir/tools/<tool>/spec.json
};

// Discover skill subdirectories under a skills directory.
// Convention:
//   <dir>/<skill-dir>/SKILL.md        — required, with frontmatter
//   <dir>/<skill-dir>/examples/*.yaml — optional example records
//   <dir>/<skill-dir>/tools/<tool>/spec.json — optional TS tool specs
//                              /main.ts, deno.json, deno.lock
export async function discoverSkills(dir: string): Promise<DiscoveredSkill[]> {
  const results: DiscoveredSkill[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isDirectory) continue;
    const subdir = `${dir}/${entry.name}`;

    let skillMd: string | undefined;
    for (const candidate of [`${subdir}/SKILL.md`, `${subdir}/${entry.name}.md`]) {
      if (await exists(candidate)) { skillMd = candidate; break; }
    }
    if (!skillMd) continue;

    const exampleYamls: string[] = [];
    const examplesDir = `${subdir}/examples`;
    if (await exists(examplesDir)) {
      for await (const ex of Deno.readDir(examplesDir)) {
        if (ex.isFile && ex.name.endsWith(".yaml")) {
          exampleYamls.push(`${examplesDir}/${ex.name}`);
        }
      }
      exampleYamls.sort();
    }

    const toolSpecs: ToolSpec[] = [];
    const toolsDir = `${subdir}/tools`;
    if (await exists(toolsDir)) {
      for await (const tEntry of Deno.readDir(toolsDir)) {
        if (!tEntry.isDirectory) continue;
        const specPath = `${toolsDir}/${tEntry.name}/spec.json`;
        if (!(await exists(specPath))) continue;
        try {
          const raw = await Deno.readTextFile(specPath);
          const spec = JSON.parse(raw) as ToolSpec;
          if (!spec.name || !spec.description || !spec.inputSchema) {
            console.error(
              `${specPath}: missing required name/description/inputSchema, skipping`,
            );
            continue;
          }
          toolSpecs.push(spec);
        } catch (err) {
          console.error(`${specPath}: failed to parse: ${(err as Error).message}`);
        }
      }
      toolSpecs.sort((a, b) => a.name.localeCompare(b.name));
    }

    results.push({ dir: entry.name, skillMd, exampleYamls, toolSpecs });
  }
  return results;
}

// Parse "---\n...\n---\nbody" frontmatter
function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  return {
    meta: parse(match[1]) as Record<string, unknown>,
    body: match[2],
  };
}

// Create all records for one example YAML. Returns StrongRef of the outermost record.
async function publishExample(agent: Agent, yamlPath: string): Promise<StrongRef> {
  const text = await Deno.readTextFile(yamlPath);
  const doc = parse(text) as Record<string, unknown>;

  const outerType = doc.$type as string;
  if (!outerType) throw new Error(`${yamlPath}: missing top-level $type`);

  // Build outer record, resolving _ref → inner record first
  const outerRecord: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "$type") continue;
    if (k === "_ref" && typeof v === "object" && v !== null) {
      const inner = v as Record<string, unknown>;
      const innerType = inner.$type as string;
      if (!innerType) throw new Error(`${yamlPath}: _ref missing $type`);
      const innerRecord: Record<string, unknown> = { ...inner };
      delete innerRecord.$type;
      const innerRef = await createAtprotoRecord(agent, innerType, innerRecord);
      console.error(`  created inner ${innerType}: ${innerRef.uri}`);
      outerRecord._ref = innerRef;
    } else {
      outerRecord[k] = v;
    }
  }

  const outerRef = await createAtprotoRecord(agent, outerType, outerRecord);
  console.error(`  created outer ${outerType}: ${outerRef.uri}`);
  return outerRef;
}

async function deleteAllSkills(agent: Agent): Promise<void> {
  let cursor: string | undefined;
  do {
    const res = await agent.com.atproto.repo.listRecords({
      repo: agent.assertDid,
      collection: SKILL_COLLECTION,
      limit: 100,
      cursor,
    });
    for (const record of res.data.records) {
      const rkey = record.uri.split("/").pop()!;
      await agent.com.atproto.repo.deleteRecord({
        repo: agent.assertDid,
        collection: SKILL_COLLECTION,
        rkey,
      });
      console.error(`Deleted skill: ${record.uri}`);
    }
    cursor = res.data.cursor;
  } while (cursor);
}

export type PreparedSkill = {
  dir?: string;
  name: string;
  description: string;
  content: string;
  exampleRefs: StrongRef[];
  tools: ToolSpec[];
};

export async function prepareSkill(
  agent: Agent,
  skillMd: string,
  extraExampleYamls: string[],
  toolSpecs: ToolSpec[] = [],
  dir?: string,
): Promise<PreparedSkill> {
  const mdText = await Deno.readTextFile(skillMd);
  const { meta, body } = parseFrontmatter(mdText);

  const existingExamples = (meta.examples as StrongRef[] | undefined) ?? [];
  for (const example of existingExamples) {
    example["$type"] = "com.atproto.repo.strongRef";
  }

  const exampleRefs: StrongRef[] = [...existingExamples];

  for (const yamlPath of extraExampleYamls) {
    console.error(`Publishing example: ${yamlPath}`);
    const ref = await publishExample(agent, yamlPath);
    exampleRefs.push(ref);
  }

  return {
    dir,
    name: meta.name as string,
    description: meta.description as string,
    content: body.trim(),
    exampleRefs,
    tools: toolSpecs,
  };
}

export async function publishPreparedSkill(
  agent: Agent,
  prepared: PreparedSkill,
): Promise<StrongRef> {
  const skillRecord: AgentSkill = {
    $type: SKILL_COLLECTION,
    name: prepared.name,
    description: prepared.description,
    content: prepared.content,
    examples: prepared.exampleRefs,
    createdAt: new Date().toISOString(),
  };
  if (prepared.tools.length > 0) skillRecord.tools = prepared.tools;

  const skillRef = await createAtprotoRecord(agent, SKILL_COLLECTION, skillRecord as unknown as Record<string, unknown>);
  console.error(
    `Published skill "${skillRecord.name}" (${prepared.tools.length} tool${prepared.tools.length === 1 ? "" : "s"}): ${skillRef.uri}`,
  );
  return skillRef;
}

export async function deleteAllSkillsForAgent(agent: Agent): Promise<void> {
  await deleteAllSkills(agent);
}

const main = async () => {
  const config = makeEnv();

  const pds = await getPdsForDid(config.agentDid);
  const session = new CredentialSession(new URL(pds));
  await session.login({
    identifier: config.agentDid,
    password: config.atprotoPassword,
  });
  config.agent = new Agent(session);
  console.error(`Logged in as ${session.did}`);

  // Collect all (skillMd, exampleYamls, toolSpecs, dir) entries
  const entries: { dir?: string; skillMd: string; exampleYamls: string[]; toolSpecs: ToolSpec[] }[] = [];
  if (config.skillsDir) {
    entries.push(...await discoverSkills(config.skillsDir));
  }
  if (config.skillMd) {
    entries.push({ skillMd: config.skillMd, exampleYamls: config.exampleYamls, toolSpecs: [] });
  }

  // Phase 1: create all example records
  const prepared: PreparedSkill[] = [];
  for (const e of entries) {
    prepared.push(await prepareSkill(config.agent, e.skillMd, e.exampleYamls, e.toolSpecs, e.dir));
  }

  // Phase 2: optionally wipe existing skill collection
  if (config.overwrite) {
    console.error("Overwrite: deleting existing skills...");
    await deleteAllSkills(config.agent);
  }

  // Phase 3: publish skill records
  const publishedRefs: StrongRef[] = [];
  for (const p of prepared) {
    publishedRefs.push(await publishPreparedSkill(config.agent, p));
  }

  console.log(JSON.stringify(publishedRefs, null, 2));
};

if (import.meta.main) {
  await main();
}
