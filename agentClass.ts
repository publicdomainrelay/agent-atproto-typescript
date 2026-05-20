#!/usr/bin/env -S deno run --allow-all
/**
 * gitops CLI for agent classes.
 *
 * Reads YAML class definitions from a directory and, for each one, FIRST
 * publishes the skills it references (resolving them from local skill
 * directories under --skills-dir), THEN writes a
 * com.publicdomainrelay.temp.agent.class record whose `skills` list contains
 * the (uri, cid) strongRefs of those just-published skill records.
 *
 * Each class YAML's `skills:` list names skill DIRECTORIES (not display
 * names) so the resolution is unambiguous against the filesystem:
 *
 *     name: compute-requester
 *     description: A sub-agent that owns its own ATProto account ...
 *     spawnsSubAgent: true
 *     skills:
 *       - spawnComputeRequester        # ./skills/spawnComputeRequester/
 *       - createNewATProtoAccount      # ./skills/createNewATProtoAccount/
 *       - computeContractCreate
 *     parent: top-level-agent          # optional: another class by name
 *
 * The CLI deduplicates across classes — if two classes both list
 * `spawnComputeRequester`, the skill record is published exactly once and
 * both class records reference the same uri/cid.
 *
 * Usage:
 *   AGENT_DID=did:plc:... ATPROTO_PASSWORD=... \
 *     ./agentClass.ts --classes-dir classes --skills-dir skills [--overwrite]
 */
import { parseArgs } from "jsr:@std/cli/parse-args";
import { exists } from "https://deno.land/std@0.136.0/fs/mod.ts";
import { parse } from "https://deno.land/std@0.136.0/encoding/yaml.ts";
import { Agent, CredentialSession } from "@atproto/api";
import {
  deleteAllSkillsForAgent,
  type DiscoveredSkill,
  discoverSkills,
  getPdsForDid,
  prepareSkill,
  publishPreparedSkill,
  type StrongRef,
} from "./skills.ts";

const CLASS_COLLECTION = "com.publicdomainrelay.temp.agent.class";

type ClassYaml = {
  name: string;
  description: string;
  skills: string[]; // skill directory names under skills/
  parent?: string;  // optional class name to inherit from
  spawnsSubAgent?: boolean;
};

async function listClasses(agent: Agent, did: string): Promise<Map<string, StrongRef>> {
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
  } catch { /* collection may not yet exist */ }
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
    } catch { return; }
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
    string: ["classes-dir", "class", "skills-dir"],
    boolean: ["overwrite"],
    default: { "skills-dir": "skills" },
  });

  const classesDir = flags["classes-dir"] as string | undefined;
  const singleClassFile = flags["class"] as string | undefined;
  const skillsDir = flags["skills-dir"] as string;
  if (!classesDir && !singleClassFile) {
    console.error("--classes-dir <dir> or --class <file.yaml> is required");
    Deno.exit(1);
  }

  // 1. Login.
  const pds = await getPdsForDid(agentDid);
  const session = new CredentialSession(new URL(pds));
  await session.login({ identifier: agentDid, password: atprotoPassword });
  const agent = new Agent(session);
  console.error(`Logged in as ${session.did}`);

  // 2. Collect class YAMLs.
  const files: string[] = [];
  if (classesDir) files.push(...await discoverClassFiles(classesDir));
  if (singleClassFile) files.push(singleClassFile);

  const classDocs: { path: string; doc: ClassYaml }[] = [];
  for (const f of files) {
    if (!await exists(f)) throw new Error(`Not found: ${f}`);
    const doc = parse(await Deno.readTextFile(f)) as ClassYaml;
    if (!doc?.name || !doc?.description || !Array.isArray(doc?.skills)) {
      throw new Error(`${f}: missing required name/description/skills`);
    }
    classDocs.push({ path: f, doc });
  }

  // 3. Discover all skills under skills-dir, index by directory name.
  const allSkills = await discoverSkills(skillsDir);
  const skillByDir = new Map<string, DiscoveredSkill>();
  for (const s of allSkills) skillByDir.set(s.dir, s);

  // 4. Compute union of referenced skill dirs.
  const referenced = new Set<string>();
  for (const { path, doc } of classDocs) {
    for (const dirName of doc.skills) {
      if (!skillByDir.has(dirName)) {
        throw new Error(
          `${path}: references skill dir "${dirName}" but ${skillsDir}/${dirName} does not exist or has no SKILL.md`,
        );
      }
      referenced.add(dirName);
    }
  }
  console.error(
    `Resolved ${referenced.size} unique skill(s) across ${classDocs.length} class(es)`,
  );

  // 5. If --overwrite, wipe existing skill + class collections first so we
  //    don't accumulate duplicates on republish.
  if (flags.overwrite) {
    console.error("Overwrite: deleting existing skills and classes...");
    await deleteAllSkillsForAgent(agent);
    await deleteAllClasses(agent, agentDid);
  }

  // 6. Publish each referenced skill exactly once. Map dir → strongRef.
  const skillRefByDir = new Map<string, StrongRef>();
  for (const dirName of [...referenced].sort()) {
    const ds = skillByDir.get(dirName)!;
    const prepared = await prepareSkill(
      agent,
      ds.skillMd,
      ds.exampleYamls,
      ds.toolSpecs,
      ds.dir,
    );
    const ref = await publishPreparedSkill(agent, prepared);
    skillRefByDir.set(dirName, ref);
  }

  // 7. Publish classes: parentless first so children resolve their parent
  //    strongRef from this session's just-published index.
  classDocs.sort((a, b) => Number(!!a.doc.parent) - Number(!!b.doc.parent));
  const classRefByName = await listClasses(agent, agentDid);
  const published: StrongRef[] = [];

  for (const { path, doc } of classDocs) {
    const skillRefs: StrongRef[] = doc.skills.map((dirName) => {
      const ref = skillRefByDir.get(dirName);
      if (!ref) throw new Error(`${path}: missing published skill ref for "${dirName}"`);
      return ref;
    });

    const record: Record<string, unknown> = {
      $type: CLASS_COLLECTION,
      name: doc.name,
      description: doc.description,
      skills: skillRefs,
      createdAt: new Date().toISOString(),
    };
    if (doc.spawnsSubAgent) record.spawnsSubAgent = true;
    if (doc.parent) {
      const pref = classRefByName.get(doc.parent);
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
    classRefByName.set(doc.name, ref);
    published.push(ref);
    console.error(
      `Published class "${doc.name}" (${skillRefs.length} skills): ${ref.uri}`,
    );
  }

  console.log(JSON.stringify(published, null, 2));
}

if (import.meta.main) {
  await main();
}
