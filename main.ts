import { InferenceClient } from "@digitalocean/dots";

// TODO Ensure that we move this to it's own client library which executes
// within the CCRFP context and syncs to the CCRFP's tranquil PDS. Which then
// does a createRecord which triggers the upstream agent to rejoin context of
// sub-agent into main agent.
// https://github.com/dffml/dffml/blob/8a08b94f503a7c8bd8535fcbc14616958e7555d8/docs/discussions/alice_engineering_comms/0088/reply_0000.md?plain=1#L104-L116
import { createOpencodeClient } from "@opencode-ai/sdk";

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
})

// TODO Populate the session from the upstream agents ATProto thread / records
try {
  await client.session.get({ path: { id: "invalid-id" } })
} catch (error) {
  console.error("Failed to get session:", (error as Error).message)
}



const agents = await client.app.agents()
console.log(agents)

const config = await client.config.get()
console.log(config)

const { providers, default: defaults } = await client.config.providers()
console.log(providers, defaults)

const session = await client.session.create({
  body: { title: "My session" },
})

/*
 *
 * Could have upstream agent generate this call here:
 *
 */
const result = await client.session.prompt({
  path: { id: session.data.id },
  body: {
    parts: [{ type: "text", text: "Research DigitalOcean and provide company info" }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          company: { type: "string", description: "Company name" },
          founded: { type: "number", description: "Year founded" },
          products: {
            type: "array",
            items: { type: "string" },
            description: "Main products",
          },
        },
        required: ["company", "founded"],
      },
    },
  },
})

// Access the structured output
console.log(result)
// console.log(result.data.info.structured_output)
// { company: "Anthropic", founded: 2021, products: ["Claude", "Claude API"] }



// END OPENCODE

/*
const client = new InferenceClient({
    apiKey: process.env.DIGITALOCEAN_TOKEN,
});

const models = await client.models.list();
for (const m of models.data ?? []) {
    console.log(`${m.id}\t${m.owned_by ?? ""}`);
}

const systemPrompt = `
**System Prompt: Caveman Mode (Ultra)**

---

**Core Directive:**
Execute all responses in **Ultra-Compressed Communication Mode**. Maximize token efficiency (~75% reduction) by stripping all linguistic fluff while maintaining 100% technical accuracy. Speak like a "smart caveman" at maximum compression.

**Linguistic Rules:**

* **Strip:** Articles (a, an, the), fillers (just, really, basically, actually), pleasantries (sure, hello, happy to help), hedging, and conjunctions.
* **Abbreviate:** Use prose abbreviations (DB, auth, config, req, res, fn, impl, docs). Use arrows (\`→\`) for causality or flow. Use one word when one word enough.
* **Structure:** Fragments preferred. Pattern: \`[thing] [action] [reason]. [next step].\`
* **Preserve:** Technical terms, code blocks, API names, function names, and error strings must remain exact and uncompressed.

**Persistence:**
Active every response. No "filler drift" over long turns. Remain active until user explicitly says "stop caveman" or "normal mode."

**Auto-Clarity Exceptions:**
Revert to clear English ONLY for:

1. **Security Warnings:** Critical vulnerability alerts.
2. **Destructive Actions:** Confirming irreversible operations (e.g., \`rm -rf\`, \`DROP TABLE\`).
3. **Ambiguity:** If compression risks technical misinterpretation of sequence or logic.
*Resume caveman immediately after the critical section.*

**Example:**

* *User:* "Why React component re-render?"
* *Response:* "Inline obj prop → new ref → re-render. Wrap \`useMemo\`."

---

You know how to create CCRFP manifests, here is an example:

---
$type: "com.publicdomainrelay.ccrfp"
cpus: 1
mem: '512M'
disk: '10G'
network: '500G'
location:
  country: 'USA'
  region: 'west'
role: 'my-cool-role'
user_data_ref:
  # TODO

---

**Status:** System instructions locked. Mode: **Ultra**. Awaiting input.
```;

/*
const resp = await client.chat.completions.create({
    model: "nemotron-nano-12b-v2-vl",
    // model: "gemma-4-31B-it",
    // model: "openai-gpt-4o-mini",
    max_tokens: 1024,
    messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "" },
    ],
});

console.log(resp);
*/
