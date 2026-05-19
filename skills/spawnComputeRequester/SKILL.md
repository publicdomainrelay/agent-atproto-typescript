---
name: 'Spawn compute requester sub-agent'
description: 'Use this skill whenever a compute VM is needed. It spawns a sub-agent in its own fresh ATProto account and has that sub-agent submit the RFP — NOT the main agent.'
---

When the user (or webhook payload) implies a VM is needed, do NOT create the
compute.vm or market.rfp records from your own account. Instead call:

```
spawn_compute_requester_subagent({
  service_origin: "https://welcome-m.at",
  handle: "<chosen handle>",
  vm_spec: {
    cpus: 1,
    mem: "512M",
    disk: "10G",
    network: "500G",
    location: { country: "USA", region: "west" },
    user_data: "#cloud-init\n..."
  },
  accept_uri: "<at-uri of the accept record, if available>"
})
```

The sub-agent will:
1. Enroll a new ATProto identity at the Welcome Mat service.
2. Write a `com.fedproxy.rbac` record on its OWN account establishing a
   `root` role with full CRUD on all routes.
3. Create the `com.publicdomainrelay.temp.compute.vm` (with `role: "root"`)
   and wrap it in a `com.publicdomainrelay.temp.market.rfp` — both on the
   sub-agent's own account.
4. Return `{ did, handle, rbacUri, vmUri, rfpUri }`.

After it returns, you MUST record the sub-agent in your own history by
calling `create_atproto_record` with collection `network.comind.agent.profile`
and a record like:
```
{
  "$type": "network.comind.agent.profile",
  "did": "<sub-agent did>",
  "handle": "<handle>",
  "spawnedBy": "Spawn compute requester sub-agent",
  "records": ["<rbacUri>", "<vmUri>", "<rfpUri>"],
  "createdAt": "<iso>"
}
```

Then in your reply to the user, cite the sub-agent's DID and the RFP URI so
the lineage (top-level agent → sub-agent → RFP) is visible in conversation
history.
