# velog-mcp

[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-2-lightgrey)](package.json)

An MCP server for [Velog](https://velog.io), the Korean developer blogging platform.
Read your blog, draft posts, publish them, and back everything up — from Claude or any
MCP client.

**[한국어 문서 →](README.ko.md)**

---

## Why another one?

Two Velog MCP servers already exist. This one differs in three ways.

**1. Publishing is a permission, not a default.**
Out of the box the server can create drafts and publish **privately**. Public
publishing requires you to set an environment variable. The model cannot flip that
switch — only you can, in your MCP config.

**2. Every quirk is measured, not assumed.**
Velog's GraphQL API is undocumented. This repo records what it *actually* does,
verified against [velog-io/velog](https://github.com/velog-io/velog) source and live
calls. Six server-side quirks are written up in
[docs/api-reference.md](docs/api-reference.md) — including one that silently returns an
empty list, and one that can turn your published posts private.

**3. Two runtime dependencies.** `@modelcontextprotocol/sdk` and `zod`. HTTP, test
runner, and TypeScript execution all come from Node 24 itself.

---

## Install

Requires **Node.js 24 or newer**.

```bash
git clone https://github.com/milcho0604/velog-mcp.git
cd velog-mcp
npm install && npm run build
```

## Configure

Add this to your MCP client config (`claude_desktop_config.json`, `.mcp.json`, …):

```json
{
  "mcpServers": {
    "velog": {
      "command": "node",
      "args": ["/absolute/path/to/velog-mcp/dist/index.js"],
      "env": {
        "VELOG_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

With the Claude Code CLI:

```bash
claude mcp add velog -- node /absolute/path/to/velog-mcp/dist/index.js
# then add the "env" block to the entry it created
```

### Getting your token

Velog has no public write API, so the server authenticates with your browser session
cookie.

1. Log in at [velog.io](https://velog.io)
2. Open DevTools (`F12`) → **Application** → **Cookies** → `https://velog.io`
3. Copy the value of **`refresh_token`**

**`VELOG_REFRESH_TOKEN` alone is enough.** Velog's server reissues the short-lived
`access_token` on its own ([`authPlugin.mts`](https://github.com/velog-io/velog/blob/main/apps/server/src/common/plugins/global/authPlugin.mts)),
and this server picks the refreshed cookie out of the response. One paste lasts
**30 days**.

`VELOG_ACCESS_TOKEN` also works but expires in about an hour by itself.

> Tokens are read from the environment only. They are never written to disk, and the
> server never reads your browser's cookie database or your OS keychain.
> Whatever you put in your MCP config file does live there in plain text, though —
> that file is yours to protect.

**Without a token the server still starts**, read-only. Public posts, search, trending,
and blog stats all work unauthenticated.

---

## Permissions

| Environment | What you get |
| --- | --- |
| *(nothing set)* | Read everything · create drafts · **publish privately** |
| `VELOG_ALLOW_PUBLIC=1` | All of the above **plus public publishing** |

```json
"env": {
  "VELOG_REFRESH_TOKEN": "...",
  "VELOG_ALLOW_PUBLIC": "1"
}
```

Accepted as "on": `1`, `true`, `yes`, `on`. Anything else is off — a typo won't quietly
enable it.

When public publishing is off, the `is_private` parameter **does not exist** on any
tool, so the model has no way to ask for it. When it's on, `is_private` appears and
still defaults to `true`.

### Why private-by-default

Not caution for its own sake. Velog's rate limiter counts only `is_private: false`
posts:

```ts
// apps/server/src/services/PostApiService/index.mts
count({ where: { fk_user_id, is_private: false, released_at: { gt: fiveMinutesAgo } } })
if (count >= 10) {
  updateMany({ where: { fk_user_id, released_at: { gt: fiveMinutesAgo } },
               data: { is_private: true } })   // flips *everything* recent to private
}
```

Private posts never enter that count, so they can't trigger it. Public posts can — and
once a post is public it has already gone out through RSS, search indexes, and
subscriber email, none of which a delete reaches. That asymmetry is what deserves an
explicit opt-in.

Full reasoning: [docs/security.md](docs/security.md)

---

## Tools

18 tools. Only 6 of them change anything on Velog.

### Reading — no auth required

| Tool | Purpose |
| --- | --- |
| `velog_get_post` | Read one post, body included |
| `velog_list_posts` | A user's posts, optionally filtered by tag |
| `velog_search_posts` | Keyword search; pass `username` to search inside one blog |
| `velog_trending_posts` | Trending by `day` / `week` / `month` / `year` |
| `velog_recent_posts` | Newest posts across Velog |
| `velog_get_user` | Profile, follower counts, bio |
| `velog_list_series` | A user's series, with post counts and IDs |
| `velog_user_tags` | Tags a user writes about, with counts |

### Reading — auth required

| Tool | Purpose |
| --- | --- |
| `velog_whoami` | Which account the token belongs to (also a token health check) |
| `velog_list_drafts` | Your saved drafts, with IDs |

### Derived — things Velog doesn't provide

| Tool | Purpose |
| --- | --- |
| `velog_blog_stats` | Aggregate views/likes/comments, top posts, per-year and per-tag breakdown |
| `velog_export_posts` | Save posts as Markdown files with YAML front matter |

### Writing

| Tool | Effect |
| --- | --- |
| `velog_create_draft` | Save a draft. Never publishes, under any configuration |
| `velog_update_draft` | Replace a draft **entirely** — omitted fields are reset |
| `velog_publish_post` | Publish a new post |
| `velog_publish_draft` | Publish an existing draft, reusing its stored body |
| `velog_unpublish_post` | Send a published post back to drafts |
| `velog_update_post` | Edit a published post — omitted fields are **kept** |

> `velog_update_draft` resets what you omit; `velog_update_post` preserves it.
> The asymmetry is deliberate — see [docs/tools.md](docs/tools.md).

Tools that take a `username` — `velog_list_drafts`, `velog_blog_stats`,
`velog_export_posts`, `velog_search_posts` — fall back to your own account when you
omit it.

---

## Usage

Once it's configured, just talk to your MCP client.

```
"Draft a Velog post about the bug I fixed today"
   → writes Markdown, saves it as a draft, hands back the edit URL

"What did I write about HTTP/2 last year?"
   → searches inside your own posts

"Show my top 10 posts by views, and which tags get read most"
   → walks your whole blog and aggregates

"Back up all my posts to ~/blog-backup"
   → writes .md files with front matter

"Publish that draft"
   → private by default; public only with VELOG_ALLOW_PUBLIC=1
```

Your MCP client asks for approval before each tool call, and irreversible tools carry
`destructiveHint`, so nothing gets published without you seeing it first.

### Exported file format

```yaml
---
title: "Post title"
date: 2022-12-31T18:32:39.790Z
slug: "url-slug"
url: "https://velog.io/@username/url-slug"
tags: ["tag1", "tag2"]
likes: 260
views: 16323
---

Post body in Markdown…
```

---

## Development

```bash
npm test              # node:test, runs .ts directly — no jest, no ts-node
npm run typecheck
npm run build
npm run schema:dump   # dump Velog's current GraphQL schema
```

120 tests. The ones in `src/__tests__/safety.test.ts` pin the security invariants —
if that file fails, find out why instead of working around it.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | Goals, non-goals, success criteria |
| [docs/architecture.md](docs/architecture.md) | Layering, and the TypeScript subset Node's type stripping allows |
| [docs/api-reference.md](docs/api-reference.md) | Measured Velog GraphQL schema and server quirks |
| [docs/security.md](docs/security.md) | Token handling, capability model, what's deliberately unimplemented |
| [docs/tools.md](docs/tools.md) | Full tool catalog with gotchas |
| [docs/decisions/](docs/decisions/) | Architecture decision records |

## Notes

This talks to Velog's internal GraphQL API, which is undocumented and can change
without warning. When something breaks, run `npm run schema:dump` and diff it against
`docs/api-reference.md` — that's the fastest way to find what moved.

Velog's [terms of service](https://velog.io/policy/terms) contain no clause restricting
automated access. Using your own token to manage your own posts stays within scope, and
your posts remain yours (Article 5).

## License

MIT
