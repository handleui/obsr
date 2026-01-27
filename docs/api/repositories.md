---
title: Projects
description: Manage projects and repositories
---

Projects link repositories to organizations in Detent.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/projects` | Register a project |
| `GET` | `/v1/projects` | List organization projects |
| `GET` | `/v1/projects/lookup` | Find by repo name |
| `GET` | `/v1/projects/by-handle` | Find by handle |
| `GET` | `/v1/projects/:id` | Get project details |
| `DELETE` | `/v1/projects/:id` | Remove project |

:::scalar-callout{type="info"}
Full API reference with request/response schemas coming soon via OpenAPI.
:::

## List Projects

```bash
curl https://backend.detent.sh/v1/projects?organization_id=ORG_UUID \
  -H "Authorization: Bearer $TOKEN"
```

## Register Project

```bash
curl -X POST https://backend.detent.sh/v1/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "organization_id": "...",
    "provider_repo_full_name": "owner/repo"
  }'
```

## Lookup by Repository

```bash
curl "https://backend.detent.sh/v1/projects/lookup?repo=owner/repo" \
  -H "Authorization: Bearer $TOKEN"
```

## Project Handles

Projects can have custom URL handles:
- Lowercase alphanumeric and hyphens
- Unique within organization
- Example: `api`, `web-app`, `cli`
