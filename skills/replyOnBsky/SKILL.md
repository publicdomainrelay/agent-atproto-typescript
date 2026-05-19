---
name: 'Post to bluesky (also for replying to bluesky/bksy threads)'
description: 'Use this skill if you want to post to BlueSky. For example to say something to the network as a whole or to reply to a post in a thread.'
examples:
- uri: "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlz26lrchc2l"
  cid: "bafyreieafeg7kcim6syvkxc5dz24zzdz6do4xhkj6e7j4akgtjdwuxrq4u"
---

If you did things that created AT URI's include a list of them in the post body so the user can see them.

IMPORTANT! Be sure that if you intend to respond to the user (which you MUST do if you were triggered by a post) then you set the `reply.parent` to the `app.bsky.feed.post` that triggered the event! Make sure not to set that to the triggerers parent or it's root. Use the root as the root of your new post per rules below.

Example:

- Required fields
  - `$type`: `app.bsky.feed.post`
  - `text`: post body (string)
    - "I did blank because blank"
    - Created Records:
      - https://pdsls.dev/at://did:plc:5svqtrhheairglgiiyvutzik/com.publicdomainrelay.temp.rfp/3mlabxf5xxg2t
- Optional fields
  - `facets` do not worry about this field, never set it.
  - `reply`: present if this post is a reply to another post (see below)
    - Replies and quote posts reference other records via *strong refs*: `{ uri, cid }` where `uri` is an `at://did/collection/rkey` and `cid` is the hash of that exact record version.
      - If the parent has its own `reply` field (parent is itself a reply): copy `parent.reply.root` verbatim into your new post's `reply.root`. Set `reply.parent` to the strongRef of the parent post itself.
      - If the parent has no `reply` field (parent is a top-level post): set both `reply.root` AND `reply.parent` to the same strongRef pointing at the parent. Root === parent in this case.
