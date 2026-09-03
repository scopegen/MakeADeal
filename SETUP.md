# Setting up a second copy of this app (new Partner account, via zip copy)

For copying this folder (not via git) into a **separate app registration**
under a different Shopify Partner/Dev Dashboard account, while keeping the
exact same code, scopes, and app-proxy configuration. Produces a genuinely
separate app (its own `client_id`, its own database, its own dev store
install) - not the same app moved.

If you're handing this file to a fresh Claude Code session as a prompt: paste
it as-is and say "follow SETUP.md in this folder, using database name
`scopegen_nego_2`" (or whatever name you pick - see Step 2).

## Before zipping: what to exclude

Copying the whole folder as-is works, but a few things are worth leaving out
of the zip - they're either huge and instantly regenerable, or contain values
from *this* install that need to change anyway in the new one:

- **`node_modules/`** - large, and a plain `npm install` in the new location
  rebuilds it in under a minute. Not worth the zip size/time.
- **`.react-router/`**, **`build/`**, **`.cache/`** - build output,
  regenerates automatically.

Everything else - including `.env`, `.shopify/`, `shopify.app.toml`, and the
already-built `extensions/negotiation-widget/assets/negotiation-widget.js` -
is fine to include. That last one actually saves you the widget rebuild step
this time, since it's a real file, not something git was excluding.

## What WILL need changing after you unzip (values from this install)

Unlike a fresh `git clone`, a direct copy brings over live values from this
install that point at the wrong things for a separate app:

- **`.env`**: still has *this* install's `DATABASE_URL`. Must be repointed
  to the new database (Step 3) or the "separate app" will silently share
  data with this one.
- **`shopify.app.toml`**: still has *this* install's `client_id`. Gets
  overwritten automatically by `config:link --reset` in Step 5 - no manual
  edit needed, just don't skip that step.
- **`.shopify/`**: stale link state from this install. Also cleared by
  `config:link --reset`.

## Step 1: Unzip and install

```
cd "path\to\Scopegen Nego 2"
npm install
```

## Step 2: Create a local Postgres database

Same Postgres server already running on this machine, but a **different
role and database name** so it can't collide with or overwrite this app's
data. Run in an elevated PowerShell, substituting your own values for the
placeholders below (including your local `postgres` superuser password -
never commit real passwords into this file, even local-only ones):

```powershell
$DbName     = "scopegen_nego_2"
$DbUser     = "scopegen_nego_2"
$DbPassword = "<choose-a-local-dev-password>"

$env:PGPASSWORD = "<your-local-postgres-superuser-password>"
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"

& $psql -U postgres -h localhost -c "CREATE ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword' CREATEDB;"
& $psql -U postgres -h localhost -c "CREATE DATABASE $DbName OWNER $DbUser;"
```

If either line errors with "already exists," that's fine - it means this
step was already done once.

## Step 3: Update `.env`

Overwrite the copied `.env` with the new database (using the same
`$DbPassword` you chose above):

```
DATABASE_URL="postgresql://scopegen_nego_2:<your-chosen-password>@localhost:5432/scopegen_nego_2"
```

## Step 4: Apply the existing migration history

```
npx prisma generate
npx prisma migrate deploy
```

`migrate deploy` (not `migrate dev`) applies the migrations already present
in `prisma/migrations/` in order, without prompting to create new ones -
exactly what a fresh database needs to end up in the identical schema state.

## Step 5: Link to the other Partner account

The one step that's genuinely yours to drive - a real browser login:

```
npx shopify app config link --reset
```

Pick the target organization, choose **create a new app**, name it. This
overwrites this folder's `shopify.app.toml` with a **new** `client_id` -
the scopes and `[app_proxy]` block already in the file are kept as-is, since
`--reset` only touches the account-linking fields, not your own config.

## Step 6: Install and run

```
npm run dev
```

Installs the app on a dev store under the new org and starts the local dev
server. (If you excluded the built widget asset when zipping, run
`npm run build:widget` first - otherwise it's already there from Step 0.)

## What's still on you, as you said

- Requesting **Protected Customer Data access** in the new app's Dev
  Dashboard (App settings / the "Request access" flow under API access) -
  without it, Draft Order creation fails with the exact
  "not approved to access the DraftOrder object" error this session spent a
  long time diagnosing the first time. Now you know immediately what it is.
- Unlocking the new dev store's storefront password, if it has one, before
  testing the widget on it.
- Filling in Settings (discount %, ladder, templates, colors, button text)
  for the new install - it starts genuinely empty, same as the original did,
  since none of that lives in the zip's database dump (there isn't one -
  Postgres data lives outside the project folder entirely).
