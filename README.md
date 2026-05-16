# ATProto Native Ephemeral Agent

```bash
AIRGLOW_WEBHOOK_SECRET=... nodemon -e ts --exec "clear; ./run.sh --unix-socket /tmp/sock; test 1" | jq

curl --unix-socket /tmp/sock -d @examples/atproto/thread/simple/0001-init/request.json http://localhost/v1/hooks/airglow
```
