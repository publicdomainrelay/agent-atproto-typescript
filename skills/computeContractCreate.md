---
name: 'Create compute contract'
description: |
  Use this skill if you want to request compute
examples:
- uri: "at://did:plc:lpfuqerea3deuoyrn7ojser4/com.publicdomainrelay.temp.market.rfp/3mlyzk4h4gu2i"
  cid: "bafyreifjjdnnmgm57kztnm6ikkiav4ej6bzzga2xroqe4mb2kaedyvnif4"
---

If you use this, you MUST first create the inner ccrfp then you MUST create the
rfp which strongRef's to the ccfrp. This double call chain is required to
successfully use this tool to create a compute contract.
