# ATProto Native Ephemeral Agent

```bash
AIRGLOW_WEBHOOK_SECRET=... nodemon -e ts --exec "clear; ./run.sh --unix-socket /tmp/sock; test 1" | jq

curl --unix-socket /tmp/sock -d @examples/atproto/thread/simple/0001-init/request.json http://localhost/v1/hooks/airglow
```

## TODO

- [x] Trigger when a bid comes in, decide if you want to do a bid accept
- [ ] Create a new account so that we set the role to the did of the account
  - [ ] Configure RBAC on that account so that the new VM can use it
    - https://pdsls.dev/at://did:plc:5svqtrhheairglgiiyvutzik/com.fedproxy.rbac/3mlewidctvt2n
- [ ] Some shorthand `curl | bash` for setting up oidc in `user_data`, etc.
  - Then tell it to follow example exactly
- [ ] Expand for spindle/tack uscase

## Examples

```
Logged in as did:plc:lpfuqerea3deuoyrn7ojser4
Server started at /tmp/sock
{
  "automation": "at://did:plc:5svqtrhheairglgiiyvutzik/run.airglow.automation/3mlywhsfdz222",
  "lexicon": "app.bsky.feed.post",
  "conditions": [
    {
      "field": "reply.root.uri",
      "operator": "eq",
      "value": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7bivjs2l",
      "comment": "Check if we are asking Alice something"
    }
  ],
  "event": {
    "did": "did:plc:5svqtrhheairglgiiyvutzik",
    "time_us": 1778973188707647,
    "kind": "commit",
    "commit": {
      "operation": "create",
      "collection": "app.bsky.feed.post",
      "rkey": "3mlyxwjgb6s2f",
      "record": {
        "$type": "app.bsky.feed.post",
        "createdAt": "2026-05-16T23:13:08.432Z",
        "langs": [
          "en"
        ],
        "reply": {
          "parent": {
            "cid": "bafyreihafbum3zrkvphecp6z6ukom6cnw6watvdv4h5aujz4yh4u2dgdui",
            "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7ipfj22l"
          },
          "root": {
            "cid": "bafyreib5ddcgpyyjcuu5vmcdqrmhfsfgp7novzruwdrfagfl66l35pvzkm",
            "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7bivjs2l"
          }
        },
        "text": "Please spin me up a vm"
      },
      "cid": "bafyreif6em5kjzb2eeg374mtqrb37xiet3ncng5otaijflor3vqpxmfcgq"
    }
  }
}
{
  "log": "debug",
  "msg": "Loaded agent skills",
  "data": [
    {
      "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/com.publicdomainrelay.temp.agent.skill/3mlz2e5q7e22s",
      "cid": "bafyreibqzwcfybxvok747xljqagytl7rwmmoszcgbznqkfnosvw2cjn66e",
      "value": {
        "name": "Post to bluesky (also for replying to bluesky/bksy threads)",
        "$type": "com.publicdomainrelay.temp.agent.skill",
        "createdAt": "2026-05-16T23:54:50.873Z",
        "description": "Use this skill if you want to post to BlueSky. For example to say something to the network as a whole or to rely to a post in a thread.",
        "examples": [
          {
            "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlz26lrchc2l",
            "cid": "bafyreieafeg7kcim6syvkxc5dz24zzdz6do4xhkj6e7j4akgtjdwuxrq4u",
            "value": {
              "text": "What kind of test do you want?",
              "$type": "app.bsky.feed.post",
              "createdAt": "2026-05-16T23:53:26.810Z",
              "langs": [
                "en"
              ],
              "reply": {
                "root": {
                  "cid": "bafyreib5ddcgpyyjcuu5vmcdqrmhfsfgp7novzruwdrfagfl66l35pvzkm",
                  "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7bivjs2l"
                },
                "parent": {
                  "cid": "bafyreiczvlq4rmgc5qdcl53ljn7amjhanqopcyaegpbdjgrtlmqpmv4rzq",
                  "uri": "at://did:plc:5svqtrhheairglgiiyvutzik/app.bsky.feed.post/3mlywpzsw422f"
                }
              }
            }
          }
        ]
      }
    },
    {
      "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/com.publicdomainrelay.temp.agent.skill/3mlyzk4h4gu2i",
      "cid": "bafyreicbnt5rv6og6v62bnl4xpw6lfk3c3ihzgfh4weoanprltx6ugo6cq",
      "value": {
        "name": "Create compute contract",
        "$type": "com.publicdomainrelay.temp.agent.skill",
        "createdAt": "2026-05-16T23:37:08.616Z",
        "description": "Use this skill if you want to request compute",
        "examples": [
          {
            "uri": "at://did:plc:5svqtrhheairglgiiyvutzik/com.publicdomainrelay.ccrfp/3mlgu55tbvf2v",
            "cid": "bafyreiccaougmp3654xsmrwjpihbsjyxzbcyvvnwhry2cci5fh2ubjtf74",
            "value": {
              "mem": "512M",
              "cpus": 1,
              "disk": "10G",
              "role": "my-cool-role",
              "$type": "com.publicdomainrelay.ccrfp",
              "network": "500G",
              "user_data": "#cloud-init\npackages:\n  - openssh-client\n  - python3\nwrite_files:\n  - path: /var/www/8080/index.html\n    owner: root:root\n    permissions: '0644'\n    content: |\n      Hello World!\n\n  - path: /etc/systemd/system/python-http@.service\n    owner: root:root\n    permissions: '0644'\n    content: |\n      [Unit]\n      Description=Simple Python HTTP server on port %i\n      After=network.target\n      Wants=network.target\n\n      [Service]\n      Type=simple\n      User=root\n      WorkingDirectory=/var/www/%i\n      Environment=PYTHONUNBUFFERED=1\n      ExecStart=/usr/bin/python3 -m http.server %i --bind 127.0.0.1\n      Restart=always\n      RestartSec=5\n      TimeoutStopSec=10\n      StandardOutput=journal\n      StandardError=journal\n\n      [Install]\n      WantedBy=multi-user.target\n\n  - path: /usr/local/bin/ssh-reverse-tunnel-wrapper\n    owner: root:root\n    permissions: '0700'\n    content: |\n      #!/usr/bin/env bash\n      set -euo pipefail\n\n      INSTANCE=\"${1:-}\"\n      [ -n \"$INSTANCE\" ] || { echo \"Missing instance\" >&2; exit 2; }\n\n      # Expect INSTANCE to be SERVICE.HANDLE (HANDLE may contain dots)\n      SERVICE=\"${INSTANCE%%.*}\"\n      HANDLE=\"${INSTANCE#*.}\"\n\n      if [ -z \"$SERVICE\" ] || [ \"$SERVICE\" = \"$HANDLE\" ]; then\n        echo \"Instance must be in the form SERVICE.HANDLE (e.g. myname.aliceoa.bsky.social)\" >&2\n        exit 2\n      fi\n\n      REMOTE_SSH=\"${HANDLE}@fedproxy.com\"\n      REMOTE_BIND=\"${SERVICE}:80:127.0.0.1:8080\"\n\n      exec /usr/bin/ssh -NnT -p 2222 \\\n        -i /root/.ssh/id_ed25519 \\\n        -o UserKnownHostsFile=/dev/null \\\n        -o StrictHostKeyChecking=no \\\n        -o PasswordAuthentication=no \\\n        -o ExitOnForwardFailure=yes \\\n        -R \"${REMOTE_BIND}\" \\\n        \"${REMOTE_SSH}\"\n\n  - path: /etc/systemd/system/fedproxy@.service\n    owner: root:root\n    permissions: '0644'\n    content: |\n      [Unit]\n      Description=SSH reverse tunnel for %i (SERVICE.HANDLE -> %i@fedproxy)\n      After=network-online.target\n      Wants=network-online.target\n      StartLimitIntervalSec=60\n      StartLimitBurst=5\n\n      [Service]\n      Type=simple\n      User=root\n      WorkingDirectory=/root\n      Environment=INSTANCE=%i\n      ExecStart=/usr/local/bin/ssh-reverse-tunnel-wrapper \"%i\"\n      Restart=always\n      RestartSec=5\n      TimeoutStopSec=20\n      StandardOutput=journal\n      StandardError=journal\n\n      [Install]\n      WantedBy=multi-user.target\nruncmd:\n- |\n    # NOTE these run as sh! not bash!\n\n    # TODO This should not be using set -x because tokens get logged\n    set -x\n\n    ATPRP_URL=\"https://rp.fedproxy.com\"\n    # https://pdsls.dev/at://did:plc:5svqtrhheairglgiiyvutzik/com.fedproxy.rbac/3mlewidctvt2n\n    HANDLE=\"johnandersen777.bsky.social\"\n    DID_PLC_KEY=\"5svqtrhheairglgiiyvutzik\"\n    DID_PLC=\"did:plc:${DID_PLC_KEY}\"\n\n    mkdir -p /root/.ssh\n    chmod 660 /root/.ssh\n    yes | ssh-keygen -t ed25519 -N \"\" -f /root/.ssh/id_ed25519\n    SSH_PUB=$(cat /root/.ssh/id_ed25519.pub)\n\n    # TODO Make sure CCB is ingestable\n\n    URL=$(cat /root/secrets/digitalocean.com/serviceaccount/base_url)\n    TEAM_UUID=$(cat /root/secrets/digitalocean.com/serviceaccount/team_uuid)\n    ID_TOKEN=$(cat /root/secrets/digitalocean.com/serviceaccount/token)\n\n    SUBJECT=\"actx:${TEAM_UUID}:plc:${DID_PLC_KEY}:role:my-cool-role\"\n\n    SERVICE=\"$(openssl rand -hex 4)\"\n\n    TOKEN=$(jq -n -c \\\n        --arg aud \"api://ATProto?actx=${DID_PLC}\" \\\n        --arg sub \"${SUBJECT}\" \\\n        --arg ttl 3600 \\\n        '{aud: $aud, sub: $sub, ttl: ($ttl | fromjson)}' | \\\n      curl -sf \\\n        -H \"Authorization: Bearer ${ID_TOKEN}\" \\\n        -d@- \\\n        \"${URL}/v1/oidc/issue\" \\\n        | jq -r .token)\n\n    curl -s \\\n      -X POST \\\n      -H \"Authorization: Bearer ${TOKEN}\" \\\n      -H \"Content-Type: application/json\" \\\n      -d '{\n            \"repo\": \"'\"${DID_PLC}\"'\",\n            \"collection\": \"com.fedproxy.sshPublicKey\",\n            \"record\": {\n              \"$type\": \"com.fedproxy.sshPublicKey\",\n              \"key\": \"'\"${SSH_PUB}\"'\",\n              \"service\": \"'\"${SERVICE}\"'\",\n              \"name\": \"'\"${SERVICE}\"'\",\n              \"createdAt\": \"'$(date -u +\"%Y-%m-%dT%H:%M:%S.%3NZ\")'\"\n            }\n          }' \\\n      \"${ATPRP_URL}/xrpc/com.atproto.repo.createRecord\" | jq\n\n    mkdir -p /var/www/8080\n    chown root:root /var/www/8080\n    systemctl daemon-reload\n    systemctl enable --now python-http@8080.service\n    systemctl enable --now \"fedproxy@${SERVICE}.${HANDLE}.service\"\n",
              "location": {
                "region": "west",
                "country": "USA"
              }
            }
          }
        ]
      }
    }
  ]
}
=== PROMPT ===
SYSTEM: You are an agent that processes webhook payloads from an ATProto social network automation system.
You have access to the following skills (in YAML format):
```yaml
- uri: >-
    at://did:plc:lpfuqerea3deuoyrn7ojser4/com.publicdomainrelay.temp.agent.skill/3mlz2e5q7e22s
  cid: bafyreibqzwcfybxvok747xljqagytl7rwmmoszcgbznqkfnosvw2cjn66e
  value:
    name: Post to bluesky (also for replying to bluesky/bksy threads)
    $type: com.publicdomainrelay.temp.agent.skill
    createdAt: '2026-05-16T23:54:50.873Z'
    description: >-
      Use this skill if you want to post to BlueSky. For example to say
      something to the network as a whole or to rely to a post in a thread.
    examples:
      - uri: 'at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlz26lrchc2l'
        cid: bafyreieafeg7kcim6syvkxc5dz24zzdz6do4xhkj6e7j4akgtjdwuxrq4u
        value:
          text: What kind of test do you want?
          $type: app.bsky.feed.post
          createdAt: '2026-05-16T23:53:26.810Z'
          langs:
            - en
          reply:
            root:
              cid: bafyreib5ddcgpyyjcuu5vmcdqrmhfsfgp7novzruwdrfagfl66l35pvzkm
              uri: >-
                at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7bivjs2l
            parent:
              cid: bafyreiczvlq4rmgc5qdcl53ljn7amjhanqopcyaegpbdjgrtlmqpmv4rzq
              uri: >-
                at://did:plc:5svqtrhheairglgiiyvutzik/app.bsky.feed.post/3mlywpzsw422f
- uri: >-
    at://did:plc:lpfuqerea3deuoyrn7ojser4/com.publicdomainrelay.temp.agent.skill/3mlyzk4h4gu2i
  cid: bafyreicbnt5rv6og6v62bnl4xpw6lfk3c3ihzgfh4weoanprltx6ugo6cq
  value:
    name: Create compute contract
    $type: com.publicdomainrelay.temp.agent.skill
    createdAt: '2026-05-16T23:37:08.616Z'
    description: Use this skill if you want to request compute
    examples:
      - uri: >-
          at://did:plc:5svqtrhheairglgiiyvutzik/com.publicdomainrelay.ccrfp/3mlgu55tbvf2v
        cid: bafyreiccaougmp3654xsmrwjpihbsjyxzbcyvvnwhry2cci5fh2ubjtf74
        value:
          mem: 512M
          cpus: 1
          disk: 10G
          role: my-cool-role
          $type: com.publicdomainrelay.ccrfp
          network: 500G
          user_data: |
            #cloud-init
            packages:
              - openssh-client
              - python3
            write_files:
              - path: /var/www/8080/index.html
                owner: root:root
                permissions: '0644'
                content: |
                  Hello World!

              - path: /etc/systemd/system/python-http@.service
                owner: root:root
                permissions: '0644'
                content: |
                  [Unit]
                  Description=Simple Python HTTP server on port %i
                  After=network.target
                  Wants=network.target

                  [Service]
                  Type=simple
                  User=root
                  WorkingDirectory=/var/www/%i
                  Environment=PYTHONUNBUFFERED=1
                  ExecStart=/usr/bin/python3 -m http.server %i --bind 127.0.0.1
                  Restart=always
                  RestartSec=5
                  TimeoutStopSec=10
                  StandardOutput=journal
                  StandardError=journal

                  [Install]
                  WantedBy=multi-user.target

              - path: /usr/local/bin/ssh-reverse-tunnel-wrapper
                owner: root:root
                permissions: '0700'
                content: |
                  #!/usr/bin/env bash
                  set -euo pipefail

                  INSTANCE="${1:-}"
                  [ -n "$INSTANCE" ] || { echo "Missing instance" >&2; exit 2; }

                  # Expect INSTANCE to be SERVICE.HANDLE (HANDLE may contain dots)
                  SERVICE="${INSTANCE%%.*}"
                  HANDLE="${INSTANCE#*.}"

                  if [ -z "$SERVICE" ] || [ "$SERVICE" = "$HANDLE" ]; then
                    echo "Instance must be in the form SERVICE.HANDLE (e.g. myname.aliceoa.bsky.social)" >&2
                    exit 2
                  fi

                  REMOTE_SSH="${HANDLE}@fedproxy.com"
                  REMOTE_BIND="${SERVICE}:80:127.0.0.1:8080"

                  exec /usr/bin/ssh -NnT -p 2222 \
                    -i /root/.ssh/id_ed25519 \
                    -o UserKnownHostsFile=/dev/null \
                    -o StrictHostKeyChecking=no \
                    -o PasswordAuthentication=no \
                    -o ExitOnForwardFailure=yes \
                    -R "${REMOTE_BIND}" \
                    "${REMOTE_SSH}"

              - path: /etc/systemd/system/fedproxy@.service
                owner: root:root
                permissions: '0644'
                content: |
                  [Unit]
                  Description=SSH reverse tunnel for %i (SERVICE.HANDLE -> %i@fedproxy)
                  After=network-online.target
                  Wants=network-online.target
                  StartLimitIntervalSec=60
                  StartLimitBurst=5

                  [Service]
                  Type=simple
                  User=root
                  WorkingDirectory=/root
                  Environment=INSTANCE=%i
                  ExecStart=/usr/local/bin/ssh-reverse-tunnel-wrapper "%i"
                  Restart=always
                  RestartSec=5
                  TimeoutStopSec=20
                  StandardOutput=journal
                  StandardError=journal

                  [Install]
                  WantedBy=multi-user.target
            runcmd:
            - |
                # NOTE these run as sh! not bash!

                # TODO This should not be using set -x because tokens get logged
                set -x

                ATPRP_URL="https://rp.fedproxy.com"
                # https://pdsls.dev/at://did:plc:5svqtrhheairglgiiyvutzik/com.fedproxy.rbac/3mlewidctvt2n
                HANDLE="johnandersen777.bsky.social"
                DID_PLC_KEY="5svqtrhheairglgiiyvutzik"
                DID_PLC="did:plc:${DID_PLC_KEY}"

                mkdir -p /root/.ssh
                chmod 660 /root/.ssh
                yes | ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519
                SSH_PUB=$(cat /root/.ssh/id_ed25519.pub)

                # TODO Make sure CCB is ingestable

                URL=$(cat /root/secrets/digitalocean.com/serviceaccount/base_url)
                TEAM_UUID=$(cat /root/secrets/digitalocean.com/serviceaccount/team_uuid)
                ID_TOKEN=$(cat /root/secrets/digitalocean.com/serviceaccount/token)

                SUBJECT="actx:${TEAM_UUID}:plc:${DID_PLC_KEY}:role:my-cool-role"

                SERVICE="$(openssl rand -hex 4)"

                TOKEN=$(jq -n -c \
                    --arg aud "api://ATProto?actx=${DID_PLC}" \
                    --arg sub "${SUBJECT}" \
                    --arg ttl 3600 \
                    '{aud: $aud, sub: $sub, ttl: ($ttl | fromjson)}' | \
                  curl -sf \
                    -H "Authorization: Bearer ${ID_TOKEN}" \
                    -d@- \
                    "${URL}/v1/oidc/issue" \
                    | jq -r .token)

                curl -s \
                  -X POST \
                  -H "Authorization: Bearer ${TOKEN}" \
                  -H "Content-Type: application/json" \
                  -d '{
                        "repo": "'"${DID_PLC}"'",
                        "collection": "com.fedproxy.sshPublicKey",
                        "record": {
                          "$type": "com.fedproxy.sshPublicKey",
                          "key": "'"${SSH_PUB}"'",
                          "service": "'"${SERVICE}"'",
                          "name": "'"${SERVICE}"'",
                          "createdAt": "'$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")'"
                        }
                      }' \
                  "${ATPRP_URL}/xrpc/com.atproto.repo.createRecord" | jq

                mkdir -p /var/www/8080
                chown root:root /var/www/8080
                systemctl daemon-reload
                systemctl enable --now python-http@8080.service
                systemctl enable --now "fedproxy@${SERVICE}.${HANDLE}.service"
          location:
            region: west
            country: USA

```

Based on the webhook payload and available skills, decide what actions to take.
IMPORTANT! If you have a skill which might allow you to respond to the user, and you're directly
interfacing with a user and not a backend request, then it's probably wise to respond to them.
You may call the create_atproto_record tool to create records in the ATProto repository.
Valid record collections (from skill examples): app.bsky.feed.post, com.publicdomainrelay.ccrfp

After completing all actions, respond with a JSON object with exactly these fields:
  "description": a plain-english description of the actions taken
  "reasoning": brief reasoning for why these actions were appropriate
  "createdRecords": array of strongRef objects for any records created (uri and cid)
USER: Webhook payload:

{
  "automation": "at://did:plc:5svqtrhheairglgiiyvutzik/run.airglow.automation/3mlywhsfdz222",
  "lexicon": "app.bsky.feed.post",
  "conditions": [
    {
      "field": "reply.root.uri",
      "operator": "eq",
      "value": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7bivjs2l",
      "comment": "Check if we are asking Alice something"
    }
  ],
  "event": {
    "did": "did:plc:5svqtrhheairglgiiyvutzik",
    "time_us": 1778973188707647,
    "kind": "commit",
    "commit": {
      "operation": "create",
      "collection": "app.bsky.feed.post",
      "rkey": "3mlyxwjgb6s2f",
      "record": {
        "$type": "app.bsky.feed.post",
        "createdAt": "2026-05-16T23:13:08.432Z",
        "langs": [
          "en"
        ],
        "reply": {
          "parent": {
            "cid": "bafyreihafbum3zrkvphecp6z6ukom6cnw6watvdv4h5aujz4yh4u2dgdui",
            "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7ipfj22l"
          },
          "root": {
            "cid": "bafyreib5ddcgpyyjcuu5vmcdqrmhfsfgp7novzruwdrfagfl66l35pvzkm",
            "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7bivjs2l"
          }
        },
        "text": "Please spin me up a vm"
      },
      "cid": "bafyreif6em5kjzb2eeg374mtqrb37xiet3ncng5otaijflor3vqpxmfcgq"
    }
  }
}
==============
createRecord: validating against 2 example records for collection com.publicdomainrelay.ccrfp
createRecord: validating against 2 example records for collection app.bsky.feed.post
{
  "log": "debug",
  "func": "createAtprotoRecord",
  "msg": "creating record...",
  "data": {
    "repo": "did:plc:lpfuqerea3deuoyrn7ojser4",
    "collection": "com.publicdomainrelay.ccrfp",
    "record": {
      "$type": "com.publicdomainrelay.ccrfp",
      "mem": "512M",
      "cpus": 1,
      "disk": "10G",
      "role": "default-vm",
      "network": "10G",
      "user_data": "#cloud-init\npackages:\n  - python3\nruncmd:\n- echo 'VM Provisioned Successfully'",
      "location": {
        "region": "west",
        "country": "USA"
      }
    }
  }
}
{
  "log": "debug",
  "func": "createAtprotoRecord",
  "msg": "creating record...",
  "data": {
    "repo": "did:plc:lpfuqerea3deuoyrn7ojser4",
    "collection": "app.bsky.feed.post",
    "record": {
      "$type": "app.bsky.feed.post",
      "createdAt": "2026-05-16T23:13:12.000Z",
      "langs": [
        "en"
      ],
      "reply": {
        "root": {
          "cid": "bafyreib5ddcgpyyjcuu5vmcdqrmhfsfgp7novzruwdrfagfl66l35pvzkm",
          "uri": "at://did:plc:lpfuqerea3deuoyrn7ojser4/app.bsky.feed.post/3mlyw7bivjs2l"
        },
        "parent": {
          "cid": "bafyreif6em5kjzb2eeg374mtqrb37xiet3ncng5otaijflor3vqpxmfcgq",
          "uri": "at://did:plc:5svqtrhheairglgiiyvutzik/app.bsky.feed.post/3mlyxwjgb6s2f"
        }
      },
      "text": "I've received your request to spin up a VM. A compute contract has been created and you will be contacted when it's ready."
    }
  }
}
Agent response: {
  "description": "Processed the request to spin up a VM by creating a compute contract with default specifications (512M memory, 1 CPU, 10G disk). Replied to the original post to acknowledge the request and confirm the contract creation.",
  "reasoning": "The webhook payload indicated a request to 'spin me up a vm' in a post. This matches the 'Create compute contract' skill description. I created a compute contract record to fulfill the request and used the 'Post to bluesky' skill to reply and inform the user.",
  "createdRecords": [
    {
      "$type": "com.atproto.repo.strongRef",
      "uri": "example",
      "cid": "example"
    },
    {
      "$type": "com.atproto.repo.strongRef",
      "uri": "example",
      "cid": "example"
    }
  ]
}
```
