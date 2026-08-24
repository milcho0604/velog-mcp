# velog-mcp

[![npm](https://img.shields.io/npm/v/@milcho0604/velog-mcp)](https://www.npmjs.com/package/@milcho0604/velog-mcp)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org)
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
runner, and TypeScript execution all come from Node itself.

---

## Install

Requires **Node.js 22.18 or newer**. What runs is the compiled `dist/index.js`, but development and verification execute `.ts` directly, and 22.18 is the first release where that works without a flag. CI covers 22.18, 24 and 26.

### As a Claude Code plugin (recommended)

```bash
/plugin marketplace add milcho0604/velog-mcp
/plugin install velog@milcho
```

Installation asks for four values. **Leave them all blank and it still installs,
running read-only.**

| Prompt | If left blank |
| --- | --- |
| Velog refresh token | Read-only (browse, search, stats still work) |
| Allow public publishing | Drafts and private publishing only |
| Allow profile edits | Profile tools stay off |
| Chrome path | Found automatically in standard locations |

**The token goes into the macOS Keychain**, not into a settings file in plaintext.
Only values declared `sensitive: true` reach the Keychain, and a test enforces
that declaration (P7).

Change values later with `/plugin manage`.

### As a plain MCP server

Published on npm, so nothing to clone — your MCP client runs it via `npx`. See
[Configure](#configure) for the config block and the client-support note.

```bash
claude mcp add velog -e VELOG_REFRESH_TOKEN=your_refresh_token \
  -- npx -y @milcho0604/velog-mcp@0.7.3
```

The token stays in your client's config file here. The plugin route above puts it in
the Keychain instead.

### From source

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
      "command": "npx",
      "args": ["-y", "@milcho0604/velog-mcp@0.7.3"],
      "env": {
        "VELOG_REFRESH_TOKEN": "your_refresh_token"
      }
    }
  }
}
```

With the Claude Code CLI:

```bash
claude mcp add velog -e VELOG_REFRESH_TOKEN=your_refresh_token \
  -- npx -y @milcho0604/velog-mcp@0.7.3
```

To run a local checkout instead, swap the command for
`node /absolute/path/to/velog-mcp/dist/index.js`.

> **Which clients can run this?** This is a stdio server: the client starts it as a
> local process. That works in Claude Code, Claude Desktop, Cursor, and other clients
> that run MCP servers locally. It does **not** work in the claude.ai or ChatGPT web
> apps — both accept only remote MCP servers reachable over HTTP, since the connection
> originates from their servers rather than your machine. Using it there would mean
> hosting it publicly and handing your Velog token to that deployment, which defeats
> the point of keeping the token on your own machine.

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
| *(nothing set)* | Read everything · create drafts · **publish privately** · draw and upload images — 22 tools |
| `VELOG_ALLOW_PUBLIC=1` | …plus **public publishing** (adds an `is_private` parameter) |
| `VELOG_ALLOW_PROFILE=1` | …plus **profile editing** (adds 5 tools) |

The two switches are independent — enable either, both, or neither.

```json
"env": {
  "VELOG_REFRESH_TOKEN": "...",
  "VELOG_ALLOW_PUBLIC": "1",
  "VELOG_ALLOW_PROFILE": "1"
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

Private posts don't **increment** that count. But `isPostLimitReached()` runs
unconditionally, *before* privacy is examined — so if ten public posts already exist in
the last five minutes, even a private draft request can trigger the sweep. "Doesn't
increment" is not "can't trigger." That's why write retries stay disabled and the local
limiter stays in place.

Public posts do increment it, and once a post is public it has already gone out through
RSS, search indexes, and subscriber email, none of which a delete reaches. That
asymmetry is what deserves an explicit opt-in.

Full reasoning: [docs/security.md](docs/security.md)

---

## Tools

22 tools. Only 10 of them change anything on Velog.

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

#### Automatic thumbnail

Omit `thumbnail` and the **first image in the body** becomes the thumbnail, so list and
share cards aren't text-only. What was chosen is always reported back, along with the
other candidates when there is more than one.

| `thumbnail` | Behaviour |
| --- | --- |
| omitted | first image in the body |
| a URL | used as given |
| `null` | **opt out** — leave it empty on purpose |

Images inside code fences and inline code are excluded, so a markdown example never
becomes your thumbnail. `velog_update_post` **never replaces an existing thumbnail** —
editing a title should not change the card. There, `null` means "don't fill it in",
not "delete it".

#### Series — by name, in one call

Pass `series_name` and the server resolves it **before** saving, then sends the id in the
**same request** — writing and filing happen in one call. Names are matched ignoring case
and surrounding whitespace; `series_id` wins if you know it.

⚠️ **If the name isn't found, nothing is written** — saving without the series would look
like it worked. The available series are listed in the error.

Omit both and the result carries **your series list**. That lookup never fails the write
(cancellation included — reporting failure after a successful save makes retries duplicate
the post).

> ⚠️ The velog API cannot **create** a series — there is no series mutation, and
> `WritePostInput` only accepts `series_id`. Create one on velog once, then this
> server can attach posts to it.

Tools that take a `username` — `velog_list_drafts`, `velog_blog_stats`,
`velog_export_posts`, `velog_search_posts` — fall back to your own account when you
omit it.

### Diagrams and images

| Tool | Effect |
| --- | --- |
| `velog_render_diagram` | Draw an architecture/flow diagram and upload it |
| `velog_render_sequence` | Draw a sequence diagram from participants and ordered messages |
| `velog_render_cover` | Draw a 1200×630 cover card for a post |
| `velog_upload_image` | Upload a local image file, get the Markdown back |

You describe **what exists and what flows where**; the renderer owns everything else —
palette, spacing, text measurement, corner rounding, canvas size. That is deliberate: a
diagram redrawn from scratch each time looks different each time.

Every measurement is real. Node widths and line breaks come from the browser's
`getBBox()`, never from a character count — with mixed Korean and English text, counting
characters is wrong every time. The canvas is sized *after* drawing, from the content's
bounding box, so a diagram cannot be clipped.

Then it audits itself and reports five classes of defect:

```
text spilling outside its card · letter-spacing squeezed to fit
a line crossing (or hiding behind) a node
two lines overlapping · two nodes overlapping · a label sitting on a card
```

**If the audit finds anything, nothing is uploaded — and there is no flag to turn that
off.** Velog has no delete-image API and every upload counts against your quota, so a
flawed diagram is worth redrawing rather than shipping. An override that the model can
set itself is not a safeguard (same reasoning as the publishing switch in
[ADR 0004](docs/decisions/0004-capability-model.md)). If you really want a flawed
diagram online, render with `upload: false`, look at the PNG, then pass its path to
`velog_upload_image`.

Icons are 28 built-in glyphs (`server`, `database`, `cloud`, `clock`, `alert`, …) drawn
from primitive shapes. Nothing is fetched — the renderer runs with DNS disabled.

**Requires Chrome** (or any Chromium-based browser: Edge, Brave, Chromium). It is found
automatically on macOS/Linux/Windows; set `VELOG_CHROME_PATH` if yours lives elsewhere.
Only `velog_render_diagram`, `velog_render_sequence` and `velog_render_cover` need it — `velog_upload_image`
just reads a local file, so it and the other 18 tools work without a browser.

**Cost, measured:** one diagram is ~1 GB peak across 9–11 Chrome processes for 3–4
seconds, then back to zero. That's Chrome's floor, not our content. Coordinates, text
lengths and array sizes are all bounded, and the canvas cap (6000px / 9M px) is enforced
**inside the page** — a browser commits to a surface the moment it receives width and
height, so checking after the fact is too late. Renders are
**serialized** — MCP clients call tools in parallel, and without that a five-diagram
request would mean 45 Chrome processes and 6 GB. Serialized, four concurrent requests
still peak at one render's worth. Ten renders in a row show no accumulation.

### Profile editing — `VELOG_ALLOW_PROFILE=1`

Five more tools appear: `velog_update_profile` (display name, bio),
`velog_update_about`, `velog_update_blog_title`, `velog_update_social_links`,
`velog_update_profile_image`. Without the flag they aren't registered at all.

The gate isn't about danger — these are reversible, affect only your own account, and
aren't distributed anywhere. It's about **confusion**: a profile's `short_bio` and a
post's `short_description` sound alike. "Fix my description" is ambiguous, and with the
switch off a wrong guess can't reach your profile.

`velog_update_profile` **keeps what you omit.** Velog's `UpdateProfileInput` requires
both `display_name` and `short_bio`, so sending one alone would blank the other — the
tool reads your current values and fills them in.

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

"Draw how the request flows from the LB through the workers to Redis"
   → renders a diagram, audits it, uploads it, hands back the Markdown line

"Make a cover image for this post"
   → 1200×630 card; pass the URL to velog_update_post's thumbnail
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
npm run typecheck     # includes tests — they used to be excluded, which hid real errors
npm run lint          # typescript-eslint, type-aware
npm run build         # tsconfig.build.json (tests excluded from dist)
npm run schema:dump   # dump Velog's current GraphQL schema
```

276 tests. `src/__tests__/safety.test.ts` pins the security invariants (A1–A11),
`render.test.ts` pins the drawing ones (R1–R23), and `plugin.test.ts` pins the
packaging ones (P1–P26) — if any fails, find out why instead of working around it.

Every guard here was checked by **breaking it on purpose**: 54 mutations against the
source, plus 12 against the publish gate itself (`scripts/gate-mutation.sh`), each of
which must make exactly one check fail. A test that still passes with the guard removed
is not a test. Several in this repo did pass at first, and that is how they got fixed.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | Goals, non-goals, success criteria |
| [docs/architecture.md](docs/architecture.md) | Layering, and the TypeScript subset Node's type stripping allows |
| [docs/api-reference.md](docs/api-reference.md) | Measured Velog GraphQL schema and server quirks |
| [docs/security.md](docs/security.md) | Token handling, capability model, what's deliberately unimplemented |
| [docs/tools.md](docs/tools.md) | Full tool catalog with gotchas |
| [docs/decisions/](docs/decisions/) | Architecture decision records |
| [CHANGELOG.md](CHANGELOG.md) | What was broken and what got fixed, per release |

## Notes

This talks to Velog's internal GraphQL API, which is undocumented and can change
without warning. When something breaks, run `npm run schema:dump` and diff it against
`docs/api-reference.md` — that's the fastest way to find what moved.

Velog's [terms of service](https://velog.io/policy/terms) contain no clause restricting
automated access. Using your own token to manage your own posts stays within scope, and
your posts remain yours (Article 5).

## License

MIT
