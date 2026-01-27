---
title: API Introduction
description: Integrate with the Detent API
---

The Detent API enables programmatic access to CI management, healing, and organization features.

## Base URL

::::scalar-tabs
:::scalar-tab{ title="Cloud" }
```bash
https://backend.detent.sh/v1
```
:::

:::scalar-tab{ title="Self-Hosted" }
```bash
https://your-domain.com/v1
```
:::
::::

## Authentication

All API requests require authentication via JWT bearer token from WorkOS.

```bash
curl https://backend.detent.sh/v1/projects \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

See [Authentication](/api/authentication) for details on obtaining tokens.

## Response Format

All responses are JSON. Successful responses return the requested data:

```json
{
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "organization_id": "660e8400-e29b-41d4-a716-446655440001",
  "handle": "api",
  "provider_repo_full_name": "handleui/detent"
}
```

Error responses include an `error` field:

```json
{
  "error": "Not a member of this organization"
}
```

## HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `201` | Created |
| `400` | Bad Request - Invalid parameters |
| `401` | Unauthorized - Invalid or missing token |
| `403` | Forbidden - Insufficient permissions |
| `404` | Not Found - Resource doesn't exist |
| `429` | Too Many Requests - Rate limited |
| `500` | Internal Server Error |

## Rate Limiting

API requests are rate limited per user:

| Endpoint | Limit |
|----------|-------|
| `/v1/*` | 100 requests/minute |
| `/webhooks/*` | 1000 requests/minute |

Rate limit headers are included in responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1704067200
```

## API Endpoints

::::scalar-row
:::scalar-card{ icon="solid/basic-key" title="Authentication" }
OAuth and token management

[View Docs →](/api/authentication)
:::

:::scalar-card{ icon="solid/basic-link" title="Webhooks" }
GitHub and GitLab webhooks

[View Docs →](/api/webhooks)
:::

:::scalar-card{ icon="solid/basic-folder" title="Projects" }
Project and repository management

[View Docs →](/api/repositories)
:::

:::scalar-card{ icon="solid/basic-check-circle" title="Checks" }
CI check execution and healing

[View Docs →](/api/checks)
:::
::::

## SDKs

Currently, the recommended way to interact with the API is via the CLI or direct HTTP requests. Official SDKs are planned for:

- TypeScript/JavaScript
- Python
- Go

## Example: List Projects

```bash
curl https://backend.detent.sh/v1/projects?organization_id=YOUR_ORG_ID \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

Response:

```json
{
  "projects": [
    {
      "project_id": "550e8400-e29b-41d4-a716-446655440000",
      "organization_id": "660e8400-e29b-41d4-a716-446655440001",
      "handle": "api",
      "provider_repo_name": "detent",
      "provider_repo_full_name": "handleui/detent",
      "is_private": false,
      "created_at": "2024-01-15T10:30:00Z"
    }
  ]
}
```
