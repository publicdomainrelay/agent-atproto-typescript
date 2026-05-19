---
name: 'Create compute contract'
description: 'Use this skill if you want to request compute'
---

If you use this, you MUST first create the inner ccrfp then you MUST create the
rfp which strongRef's to the ccfrp. This double call chain is required to
successfully use this tool to create a compute contract.

The `role` field in `com.publicdomainrelay.temp.compute.vm` MUST be set to the
`$key` portion of the `did:plc:$key` that was returned by the
`createNewATProtoAccount` skill (which calls `create_welcome_mat_account`).
Example: if the DID is `did:plc:abc123xyz`, set `role: "abc123xyz"`.
