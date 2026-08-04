# CorePrt — Access app recreate · pre-destroy snapshot · 2026-08-03T13:40:31Z

**Trigger:** The current Access app `c3f1f0da-…` and all artifacts issued under `CF_API_TOKEN` inherit a compromised auth context (the token was posted in chat; per CLAUDE.md gotcha `Any credential that appeared in chat is compromised.`).

**This is a Plan B staging rebuild.** The rebuild is performed with the same (compromised) token so we have a known-good working Access state to point at. The operator MUST rotate `CF_API_TOKEN` in the Cloudflare dashboard and re-run the rebuild before this is production-clean. See `docs/2026-08-03-access-recreate.md` Step 6 for the post-rotation re-run.

**Account:** `fb883e97a51c4525501a42a6a06b7a46`  
**Zone:**   `788487334a7810a9a377e254c0155b25` (`webrnds.com`)  
**Domain:** `coreprt.webrnds.com`

---

## 1. Current Access app `974e7f0c-8027-4183-a66d-394847b4ddd9`

```json
{
  "errors": [],
  "messages": [],
  "result": {
    "allow_authenticate_via_warp": true,
    "allowed_idps": [
      "38fc0781-3eae-49a1-85d5-11d0620f44a1",
      "3ee5b946-17cb-4a77-bb24-31b7e46065f2"
    ],
    "app_launcher_visible": false,
    "aud": "55c81dfc5272fb5fdb74636fbb4803912328d317f15b5c2700be8a99ddc44329",
    "auto_redirect_to_identity": false,
    "created_at": "2026-08-03T13:23:29Z",
    "destinations": [
      {
        "type": "public",
        "uri": "coreprt.webrnds.com"
      }
    ],
    "domain": "coreprt.webrnds.com",
    "eager_redirect_cookie_setting": true,
    "enable_binding_cookie": false,
    "http_only_cookie_attribute": true,
    "id": "974e7f0c-8027-4183-a66d-394847b4ddd9",
    "name": "CorePrt",
    "options_preflight_bypass": false,
    "policies": [
      {
        "created_at": "2026-08-03T13:26:14Z",
        "decision": "allow",
        "exclude": [],
        "id": "54e2a01e-3e8e-4c61-ae9f-8c0facded1e7",
        "include": [
          {
            "email": {
              "email": "schreuderdarren@gmail.com"
            }
          }
        ],
        "name": "mcp-warp-required",
        "precedence": 1,
        "require": [
          {
            "device_posture": {
              "integration_uid": "76b96de1-4cce-43fe-ba8a-26881193a475"
            }
          }
        ],
        "reusable": true,
        "session_duration": "24h",
        "uid": "54e2a01e-3e8e-4c61-ae9f-8c0facded1e7",
        "updated_at": "2026-08-03T13:26:14Z"
      },
      {
        "created_at": "2026-08-03T13:23:32Z",
        "decision": "allow",
        "exclude": [],
        "id": "801f60cd-7e36-44fa-8de6-3387707b0bff",
        "include": [
          {
            "email": {
              "email": "schreuderdarren@gmail.com"
            }
          }
        ],
        "name": "owner-trusted-mac",
        "precedence": 2,
        "require": [
          {
            "device_posture": {
              "integration_uid": "76b96de1-4cce-43fe-ba8a-26881193a475"
            }
          },
          {
            "device_posture": {
              "integration_uid": "c99b5e24-418b-414d-859b-bb428d45a09a"
            }
          },
          {
            "device_posture": {
              "integration_uid": "6ce07058-3f3e-43cd-91e8-2e97d21cd57f"
            }
          },
          {
            "device_posture": {
              "integration_uid": "62c90e6e-bc8a-4b90-868b-e3b5138a0846"
            }
          }
        ],
        "reusable": true,
        "session_duration": "24h",
        "uid": "801f60cd-7e36-44fa-8de6-3387707b0bff",
        "updated_at": "2026-08-03T13:26:13Z"
      },
      {
        "created_at": "2026-08-03T13:23:33Z",
        "decision": "allow",
        "exclude": [],
        "id": "d49d75c7-fabb-47d7-aa06-08314120f683",
        "include": [
          {
            "email": {
              "email": "schreuderdarren@gmail.com"
            }
          }
        ],
        "name": "owner-anywhere",
        "precedence": 3,
        "require": [
          {
            "geo": {
              "country_code": "NL"
            }
          }
        ],
        "reusable": true,
        "session_duration": "6h",
        "uid": "d49d75c7-fabb-47d7-aa06-08314120f683",
        "updated_at": "2026-08-03T13:23:33Z"
      }
    ],
    "self_hosted_domains": [
      "coreprt.webrnds.com"
    ],
    "session_duration": "24h",
    "tags": [],
    "type": "self_hosted",
    "uid": "974e7f0c-8027-4183-a66d-394847b4ddd9",
    "updated_at": "2026-08-03T13:26:15Z"
  },
  "success": true
}
```

## 2. Policies attached (in precedence order)

```
(none returned by API)
```

## 3. Service-token inventory (underscored route)

```json
{
  "errors": [],
  "messages": [],
  "result": [],
  "result_info": {
    "count": 0,
    "page": 1,
    "per_page": 1000,
    "total_count": 0,
    "total_pages": 0
  },
  "success": true
}
```

## 4. Posture integrations (built-in)

```
endpoint not granted on this token (HTTP ?); integration list is also readable via /devices/posture
```

## 5. Tunnel lookup (must remain bound to the same `coreprt` tunnel)

```json
{
  "errors": [],
  "messages": [],
  "result": [
    {
      "account_tag": "fb883e97a51c4525501a42a6a06b7a46",
      "config_src": "local",
      "connections": [
        {
          "client_id": "9e1e9d92-afc4-4465-b6be-66d327a03760",
          "client_version": "2026.7.1",
          "colo_name": "ams06",
          "id": "db19d2b1-05d0-43d9-87da-eba56c855040",
          "is_pending_reconnect": false,
          "opened_at": "2026-08-02T18:18:31.370383Z",
          "origin_ip": "2a09:bac1:5540:10::208:9a",
          "uuid": "db19d2b1-05d0-43d9-87da-eba56c855040"
        },
        {
          "client_id": "9e1e9d92-afc4-4465-b6be-66d327a03760",
          "client_version": "2026.7.1",
          "colo_name": "ams07",
          "id": "b7dc20b1-37d9-481e-bdd4-e938d53a600f",
          "is_pending_reconnect": false,
          "opened_at": "2026-08-03T06:40:20.012982Z",
          "origin_ip": "104.28.219.181",
          "uuid": "b7dc20b1-37d9-481e-bdd4-e938d53a600f"
        },
        {
          "client_id": "9e1e9d92-afc4-4465-b6be-66d327a03760",
          "client_version": "2026.7.1",
          "colo_name": "mad06",
          "id": "3ba5ab47-b986-4aff-8b45-137eeec35c93",
          "is_pending_reconnect": false,
          "opened_at": "2026-08-03T05:31:28.170074Z",
          "origin_ip": "2a09:bac1:5540:10::39f:6b",
          "uuid": "3ba5ab47-b986-4aff-8b45-137eeec35c93"
        },
        {
          "client_id": "9e1e9d92-afc4-4465-b6be-66d327a03760",
          "client_version": "2026.7.1",
          "colo_name": "ams07",
          "id": "42c23093-0006-43e7-98c3-646ca86434fd",
          "is_pending_reconnect": false,
          "opened_at": "2026-08-02T19:41:48.494900Z",
          "origin_ip": "104.28.219.181",
          "uuid": "42c23093-0006-43e7-98c3-646ca86434fd"
        }
      ],
      "conns_active_at": "2026-08-02T18:18:31.370383Z",
      "conns_inactive_at": null,
      "created_at": "2026-07-29T15:34:12.038294Z",
      "deleted_at": null,
      "id": "c40f4029-2ba3-4182-b1c4-b9cab95c305e",
      "metadata": {},
      "name": "coreprt",
      "remote_config": false,
      "status": "healthy",
      "tun_type": "cfd_tunnel"
    }
  ],
  "result_info": {
    "count": 1,
    "page": 1,
    "per_page": 1000,
    "total_count": 1
  },
  "success": true
}
```

## 6. DNS — CNAME for coreprt.webrnds.com

```json
{
  "errors": [
    {
      "code": 10000,
      "message": "Authentication error"
    }
  ],
  "messages": [],
  "result": null,
  "success": false
}
```

## 7. Edge probe (sanity)

```
https://coreprt.webrnds.com/_liveness -> 403 (Location: n/a)
```

## 8. Hashes for change-detection

```
app_id:        974e7f0c-8027-4183-a66d-394847b4ddd9
app_sha256:    4f646576e155142ee28ad60075dd861a559c16eb0c4fbed385d35c4726fb08dc
stokens_count: 0
```

---

## 9. Operator action checklist (post-snapshot)

1. Verify the snapshot looks right (all 6 sections populated, no `Missing X-Auth-…` errors).
2. Proceed to `docs/2026-08-03-access-recreate.md` Step 1: delete the old app.
3. After the new app is live and verified, rotate `CF_API_TOKEN` in Cloudflare dashboard → Account → API Tokens, then re-run `scripts/snapshot-access.py` and `scripts/recreate-access-app.py` to produce a clean-cut replacement.
