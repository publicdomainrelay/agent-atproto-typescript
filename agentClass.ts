#!/usr/bin/env -S deno run --allow-all
/**
 * gitops CLI: publish com.publicdomainrelay.temp.agent.class records.
 *
 * Reads YAML class definitions from a directory and creates one record per
 * file. Each class file references skills by SKILL.md name; this CLI resolves
 * those names by listing the agent's published skill records.
 *
 * Usage:
 *   AGENT_DID=did:plc:... ATPROTO_PASSWORD=... \
 *     ./agentClass.ts --classes-dir classes [--overwrite]
 *
 * YAML schema (per file):
 *   name: compute-requester
 *   description: A sub-agent that owns its own ATProto account ...
 *   spawnsSubAgent: true
 *   skills:
 *     - "Create new ATProto account"
 *     - "Create compute contract"
 *   parent: optional skill class name to inherit from
 */
import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { parse } from "https://deno.land/std@0.136.0/encoding/yaml.ts";
import { Agent, CredentialSession } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { getPdsEndpoint } from "@atproto/common-web";

const SKILL_COLLECTION = "com.publicdomainrelay.temp.agent.skill";
const CLASS_COLLECTION = "com.publicdomainrelay.temp.agent.class";

type StrongRef = {
  $type: "com.atproto.repo.strongRef";
  uri: string;
  cid: string;
};

type ClassYaml = {
  name: string;
  description: string;
  skills: string[];
  parent?: string;
  spawnsSubAgent?: boolean;
};

const idResolver = new IdResolver();

async function getPdsForDid(did: string): Promise<string> {
  const doc = await idResolver.did.resolve(did);
  if (!doc) throw new Error(`Could not resolve DID: ${did}`);
  const pds = getPdsEndpoint(doc);
  if (!pds) throw new Error(`No PDS endpoint for ${did}`);
  return pds;
}

async function listSkills(
  agent: Agent,
  did: string,
): Promise<Map<string, StrongRef>> {
  const byName = new Map<string, StrongRef>();
  let cursor: string | undefined;
  do {
    const res = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: SKILL_COLLECTION,
      limit: 100,
      cursor,
    });
    for (const r of res.data.records) {
      const v = r.value as { name?: string };
      if (v?.name) {
        byName.set(v.name, {
          $type: "com.atproto.repo.strongRef",
          uri: r.uri,
          cid: r.cid ?? "",
        });
      }
    }
    cursor = res.data.cursor;
  } while (cursor);
  return byName;
}

async function listClasses(
  agent: Agent,
  did: string,
): Promise<Map<string, StrongRef>> {
  const byName = new Map<string, StrongRef>();
  let cursor: string | undefined;
  try {
    do {
      const res = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection: CLASS_COLLECTION,
        limit: 100,
        cursor,
      });
      for (const r of res.data.records) {
        const v = r.value as { name?: string };
        if (v?.name) {
          byName.set(v.name, {
            $type: "com.atproto.repo.strongRef",
            uri: r.uri,
            cid: r.cid ?? "",
          });
        }
      }
      cursor = res.data.cursor;
    } while (cursor);
  } catch {
    // collection may not yet exist
  }
  return byName;
}

async function deleteAllClasses(agent: Agent, did: string): Promise<void> {
  let cursor: string | undefined;
  do {
    let res;
    try {
      res = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection: CLASS_COLLECTION,
        limit: 100,
        cursor,
      });
    } catch {
      return;
    }
    for (const r of res.data.records) {
      const rkey = r.uri.split("/").pop()!;
      await agent.com.atproto.repo.deleteRecord({
        repo: did,
        collection: CLASS_COLLECTION,
        rkey,
      });
      console.error(`Deleted class: ${r.uri}`);
    }
    cursor = res.data.cursor;
  } while (cursor);
}

async function discoverClassFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      files.push(`${dir}/${entry.name}`);
    }
  }
  files.sort();
  return files;
}

async function main() {
  const atprotoPassword = Deno.env.get("ATPROTO_PASSWORD");
  const agentDid = Deno.env.get("AGENT_DID");
  if (!atprotoPassword || !agentDid) {
    console.error("AGENT_DID and ATPROTO_PASSWORD must be set");
    Deno.exit(1);
  }

  const flags = parseArgs(Deno.args, {
    string: ["classes-dir", "class"],
    boolean: ["overwrite"],
  });

  const classesDir = flags["classes-dir"] as string | undefined;
  const singleFile = flags["class"] as string | undefined;
  if (!classesDir && !singleFile) {
    console.error("--classes-dir <dir> or --class <file.yaml> is required");
    Deno.exit(1);
  }

  const pds = await getPdsForDid(agentDid);
  const session = new CredentialSession(new URL(pds));
  await session.login({ identifier: agentDid, password: atprotoPassword });
  const agent = new Agent(session);
  console.error(`Logged in as ${session.did}`);

  // Build skill-name -> strongRef index from the agent's existing skills.
  const skillIdx = await listSkills(agent, agentDid);
  console.error(`Indexed ${skillIdx.size} skills`);

  if (flags.overwrite) {
    console.error("Overwrite: deleting existing agent classes...");
    await deleteAllClasses(agent, agentDid);
  }

  // Build class-name -> strongRef index AFTER any deletion.
  const classIdx = await listClasses(agent, agentDid);

  const files: string[] = [];
  if (classesDir) files.push(...await discoverClassFiles(classesDir));
  if (singleFile) files.push(singleFile);

  // Two-pass: first publish classes with no parent, then those with parent.
  const all: { path: string; doc: ClassYaml }[] = [];
  for (const f of files) {
    if (!await exists(f)) throw new Error(`Not found: ${f}`);
    const doc = parse(await Deno.readTextFile(f)) as ClassYaml;
    if (!doc?.name || !doc?.description || !Array.isArray(doc?.skills)) {
      throw new Error(`${f}: missing required name/description/skills`);
    }
    all.push({ path: f, doc });
  }
  all.sort((a, b) => Number(!!a.doc.parent) - Number(!!b.doc.parent));

  const published: StrongRef[] = [];
  for (const { path, doc } of all) {
    const skillRefs: StrongRef[] = [];
    for (const skillName of doc.skills) {
      const ref = skillIdx.get(skillName);
      if (!ref) throw new Error(`${path}: unknown skill "${skillName}"`);
      skillRefs.push(ref);
    }
    const record: Record<string, unknown> = {
      $type: CLASS_COLLECTION,
      name: doc.name,
      description: doc.description,
      skills: skillRefs,
      createdAt: new Date().toISOString(),
    };
    if (doc.spawnsSubAgent) record.spawnsSubAgent = true;
    if (doc.parent) {
      const pref = classIdx.get(doc.parent);
      if (!pref) throw new Error(`${path}: unknown parent class "${doc.parent}"`);
      record.parent = pref;
    }
    const res = await agent.com.atproto.repo.createRecord({
      repo: agentDid,
      collection: CLASS_COLLECTION,
      record,
    });
    const ref: StrongRef = {
      $type: "com.atproto.repo.strongRef",
      uri: res.data.uri,
      cid: res.data.cid,
    };
    classIdx.set(doc.name, ref);
    published.push(ref);
    console.error(`Published class "${doc.name}": ${ref.uri}`);
  }

  console.log(JSON.stringify(published, null, 2));
}

await main();
