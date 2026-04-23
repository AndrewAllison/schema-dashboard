# Directus Schema Dashboard

A standalone local dev tool to visualise and apply Directus CMS schema differences between dev and prod environments.

## Setup

```bash
# 1. Copy the env template
cp .env.local.example .env.local

# 2. Fill in your Directus static tokens
#    Get them: Directus admin → avatar → My Profile → Token → Generate → Save
nano .env.local

# 3. Install dependencies
yarn install

# 4. Start the dashboard
yarn dev
```

Then open http://localhost:4321

## Features

| Page | What it shows |
|---|---|
| Summary | Overview with counts per category |
| Dev Only | Collections / fields / relations to add to prod, with Apply buttons |
| Prod Only | Items on prod not yet in dev (review manually) |
| Possible Renames | Similar names that may be typos or manual renames |
| Schema Changes | Field type / default value diffs |
| Relation Changes | Allowed collection and sort field diffs |
| Choice Changes | Dropdown option diffs |
| Option Changes | Field config / display diffs |

## Apply workflow

1. Start with **Dev Only → Collections** and apply all collections first
2. Once collections are applied, fields for those collections unlock automatically
3. Apply fields, then relations
4. For Schema / Relation / Choice / Option changes, review each diff before applying

## Caching

Diff results are cached for 5 minutes (in-process + `.diff-cache.json`). Use the **↻ Refresh** button on the Summary page to force a re-fetch.

## Env vars

| Variable | Required | Default |
|---|---|---|
| `DIRECTUS_DEV_TOKEN` | ✓ | — |
| `DIRECTUS_PROD_TOKEN` | ✓ | — |
| `DIRECTUS_DEV_URL` | | `https://directus-ct-shared.gpillar-dev.global.com` |
| `DIRECTUS_PROD_URL` | | `https://directus-ct-shared.gpillar-prod.global.com` |
| `DIRECTUS_COLLECTION_PREFIX` | | `adpower_redesign` |
