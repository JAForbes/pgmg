# pgmg 🐘

`pgmg` = postgres + migrations

> 🎺🎺🎺 `pgmg@next` (this branch) is soon to be released as v1! 🎺🎺🎺
>
> v1 will automatically patch the internal tables in your database
> but old migration files are not compatible.
>
> It's imperative that you move old migration files 
> to a different folder that pgmg cannot see, as
> pgmg will think those old migrations have not run yet and re-run them 😱
>
> To ensure that no-one mistakenly runs 0.x migration files against 1.x
> we have added a (temporary) mandatory `--v1` flag to break CI pipelines
> that use the latest npm version without checking compatibility first.
>
> We apologise for the inconvenience for temporarily breaking your CI
> but we would prefer that minor inconvenience to actually impacting
> a production migration.

## Quick Start

- `mkdir -p migrations`
- `touch migrations/first-migration.mjs`

```js
// migrations/first-migration.js
export const name = "First Migration";
export const description = `
    This is where you can describe what your migration does.

    We automatically trim this so don't worry about indentation etc.
`;

export async function action(sql) {
  await sql`
    create table example(
        a int,
        b int,
        primary key (a,b)
    )
  `;
}
```

First install pgmg and pin it to a specific version

```bash
npm install pgmg@next
```

```bash

# We don't rely on alphabetical order, you just pass in the files
# you want to migrate.

npx pgmg "$DATABASE_URL" "migrations/first-migrations.mjs"
```

## What

- 🧘‍♀️ A forward only, idempotent, postgres migration tool, with minimal noise
- 🚀 Innovative dev loop with auto teardown
- 🐘 Full access to a [postgres.js](https://github.com/porsager/postgres) instance in every migration hook
- 😎 A simple migration file format, just exported ESM properties and function

## Automatic teardown

Every migration has an associated auto-generated migration user that owns every object created within the migration.

When running locally (`--dev`), any objects owned by that user will be deleted on each run.

You can access the name of this migration user via `options.roles.migration`

```js
export const action = async (sql, { roles: { migration }}) => {...}
```

This completely changes the traditional migration workflow, you do not need to manually write a teardown hook, and you don't need to drop and recreate your db all the time, you can iterate on your schema as easily as you iterate on your application code.

## Service roles

Each migration also has an auto-generated service user.  This user by default has no access until you explicitly grant access.

We recommending granting to the service user first, and then granting the service user to other users.  This makes it easier to logically group related grants.

```js

import { createRole } from 'pgmg'
// runs one time only (in prod)
export async function action(sql, { roles }) {

  // create a role (if it doesn't already exist)
  await createRole('guitar_service', {
    password: process.env.GUITAR_SERVICE_PASSWORD,
    with: 'inherit'
  })

  await sql`grant select on table guitars to ${sql.unsafe(roles.service)}`;
  await sql`grant insert on table guitars to ${sql.unsafe(roles.service)}`;
  await sql`grant execute on function play_guitars() to ${
    sql.unsafe(roles.service)
  }`;

  await sql`create policy on guitars to ${
    sql.unsafe(roles.service)
  } using (...)`;

  // now grant the service role to your own role
  await sql`
    grant ${sql.unsafe(roles.service)} to guitar_service
  `
}
```

You can now use`\du+` in psql to easily see which users have been granted which migration grants.

## Forward only

Locally we give you a very powerful automatic teardown which leads to a fast iterative dev loop.  But this feature is only available locally when using the `--dev` flag.

In production `teardown` hooks never run!  

We recommend "rolling forward" to fix mistakes in production migrations as teardown/down hooks are rarely tested and forward migrations are a lot easier to reason about.

## Migrating from pgmg 0.x


### Breaking change

Originally we planned to gracefully upgrade older migration metadata and handle previous file formats, but after a long period of time we've decided to make 1.x a breaking change with no promise of automatic upgrades.

This keeps the codebase simpler and removes a lot of conditional logic.  Ultimately we want pgmg to be as simple as possible because migrations should be simple and predictable.

We recommend making a clean break when upgrading to v1, make a `migrations/0.x/` folder and put your existing migrations in there.  Then put new migrations in `migrations/v1/` and point v1 at that folder.

You can use any folder naming scheme you'd like, this is just a suggestion.

When you have made this change pass `--v1` on the CLI to pgmg to communicate to the CLI that you are aware of the breaking changes and have made the appropriate change to your migration files.

This flag will be mandatory for a few months after the release of v1, afterwards it will be ignored.

### Changelog

Checkout the [changelog issue](https://github.com/JAForbes/pgmg/issues/38) for a list of changes.  You can also ask questions about upgrading in the comments.

## API

### CLI

```
Usage: pgmg (--dev|--prod) [CONNECTION] [OPTIONS] [FILES]

[PGMG OPTiONS]

--help      Logs this help message

--version   Logs the current pgmg version

--debug     Enables verbose debug logging

--v1        Required flag that will become optional soon after releasing v1.
            This let's us know you have read the migration guide and are aware
            that old migrations are not compatible with v1 and should be 
            moved / deleted from your normal migrations folder.

[CONNECTION]

Pass a postgres connection string (just like psql)

[FILES]

Any files passed as arguments after the connection string will be imported as JS migration files.

[OPTIONS]

The only way to specify a connection is via a pg connection URL.

╭――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――╮
│                                                                                          │
│               Note 0.x migration files are incompatible with pgmg@1.x                    │
│                                                                                          │
│                         Check the readme.md to upgrade safely                            │
│                                                                                          │
│                                                                                          │
╰――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――╯

--v1                        Prevents pgmg from warning you that 0.x migration files
                            are incompatible with 1.x.  Only pass this flag
                            after you have read and followed the migration guide
                            at https://github.com/JAForbes/pgmg


--dev                       Runs any teardown hooks before running the
                            forward migration.  Annotates the migration
                            record as \`dev\` so it will be re-run next time
                            as long as --dev is passed.

                            Only runs teardown hooks after 1 successful migration.

--prod                      Runs your migration without any teardown hooks
                            and on subsequent runs will never run the same migration
                            file again.
                            Cluster hooks will still run 1 time per host to ensure
                            roles and cluster level settings are configured at each site.

--dry                       Doesn't run any migrations, instead just prints out the migrations
                            that would run.  But does run initial setup scripts
                            to ensure pgmg tables are coherent.

--health-check-file <file>  Write to <file> when migration completes without error.
                            If in --dev mode this file will be deleted and recreated
                            for each migration.

                            This is designed to be used with docker healthchecks so
                            you can defer starting services or tests until after the
                            migration is complete.
```

### Migration File Format

A migration file exports various lifecycle functions that are run depending on
context and other metadata exports.

```js
export const name = "";
export const description = "";

// runs in --dev only
// skipped if this migration has already run in --prod mode
export const teardown = async (sql) => {};

// runs every migration
export const pre = async (sql) => {};

// runs one time, recorded and never re-run except in --dev mode
export const action = async (sql) => {};

// runs every migration
export const post = async (sql) => {};
```

#### `name` (required)

The name of the migration. You _must_ export a unique name property, this name
is used by `pgmg` to determine whether or not this migration has run before.
But, it is also good for reference later to see what migrations have run on this
db in the past. Especially when creating curated or conditional migrations.

#### `description` (recommended)

A description of why this migration needs to occur. `description` is an optional
export, but a recommended export. It is rare you need to change the database
schema and there isn't some helpful reason you can provide for the change. A
migration is effectively an admission that our first idea of a model was
incorrect or incomplete, that is always worthwhile to document.

#### `action`

This hook is where you define the majority of your migration logic.

An `action` export gets a raw postgres `sql` instance.

`pgmg` creates a new connection for each migration file to isolate stateful connection contexts.  So be aware any
transaction commits or rollbacks are on a per migration file basis, not the entire set of migration files that are running.

#### `pre`

Run's every time you run `pgmg`.  Can be used for preflight checks that you want to ensure run every time, even after that migration has already run in prod.

#### `post`

Like `pre`, the `post` hooks runs every time `pgmg` is passed a migration file. This hook
is useful for checks or migrations that should be re-evaluated every time. 

An example would be dynamically generated triggers or row level security policies
that query the info schema for tables matching a given rule or predicate.

If `action` has not run yet, `post` runs after `action`.

#### `teardown`

The `teardown` hook is designed for local development only. `pgmg` is a forward
only migration tool in production, but for local development it can be handy to
re-run the same migration continually and have some clean up logic to reset the
db state so you can test your migration changes.

`teardown` will only run if the `--dev` hook is passed to `pgmg` and only runs if a migration has already run for that file.

If you are running `pgmg` with the `--dev` then a teardown hook will
automatically be applied which destroys any objects owned by the migration and service user.

This feature is always on, but you can opt out of it by changing the migration role via `set role` in your migration.

It is completely optional, but you are encouraged to manually grant the service user to an actual postgres service user in your app. E.g. if you had a postgres user used by a photo
processing service you might run this line somewhere in your migration.

```js
await sql`grant select on xyz to ${sql(roles.service)}`
await sql`grant select on abc to ${sql(roles.service)}`

await sql`grant ${sql(roles.service)} to photo_processing`;
```

This leads to a much clearer and more organized grant heirachy.

#### `connection`

By default, pgmg uses a single connection, this makes it much simpler for pgmg to set roles and other config and clean things up efficiently.

However, for large backfills you may want to split your work up into parallel transactions.  In this instance you can configure the `postgres.js` connection directly by exporting a connection options object.

Check out the full documentation for postgres.js connection config [here](https://github.com/porsager/postgres)

```js
export const connection = {
  max: 4
}
```

Note, if you do use this, `pgmg` will reconnect to the database from scratch before and after each hook for that migration.  Unfortunately this is necessary to ensure any config commands (e.g. `set role` or `set search_path = '...') remains isolated to that migration.

We recommend leaving the connection config alone unless if you are backfilling millions of rows.

#### `archived`

When you are sure you will never need pgmg to run a `pre` or `post` migration hook ever again you can export the `archived` flag set to `true`.

You can also simply move the file to a folder pgmg won't see, or somehow avoid passing that migration file name to pgmg in your glob, but some people may prefer to keep the file where it is and use this declarative option instead.

```js
export const archived = true
```

### Utils

#### `createRole`

A util that will create a role if does not already exist

```js
export const action = sql =>
  createRole(sql, { 
    name: 'example'
    , password: process.env.EXAMPLE_PASSWORD //optional
    , with: 'noreplication' // optional
  })
```

#### `createRoleFromUrl`

A util that will create a role if does not already exist

```js
export const pre = sql =>
  createRoleFromUrl(sql, `postgres://example:${process.env.EXAMPLE_PASSWORD}@postgres:5432/postgres`, {
    with: 'noreplication' // optional
  })
```

## FAQ

### How do I order my migrations?

`pgmg` will apply migrations in the order you pass them to pgmg as arguments.

So if you choose to number your migrations, a simple glob will order them.

```bash
# Alphabetical ordered files
$ ls -l migrations
01-user-permissions.js
02-full-text-search.js
03-magic-link.js

# globbing will natively order alphabetically by default
$ pgmg $DATABASE_URL migrations/*.js
```

You could also have a simple text file that acts as a manifest and expand the file as arguments like so:

Imagine we have a `migrations.txt` file:

```txt
user-permissions.js
full-text-search.js
magic-link.js
```

We can expand that file as arguments like so:

```bash
pgmg $DATABASE_URL $(cat migrations.txt)
```

If you wanted, your manifest could be json, or yaml, or whatever you want, as
long as you can extract the filenames and pass them as arguments.

### How do I take a prod snapshot correctly (for local development)?

Postgres has database level objects (like tables, views, policies) and cluster level global objects (like roles, grants, tablespaces).

When you use `pg_dump` you are only getting access to the database level objects not the cluster/global level objects.

To correctly restore a prod instance locally we recommend first capturing and restoring these global objects via `pg_dumpall -g $DB_URL -f globals.sql`, see the postgres documentation for more information.

## Running migrations in production

`pgmg` has two modes `--dev` and `--prod`.  In `--dev` mode pgmg will teardown database objects
from migrations that were run locally and recreate them each time.  This can be combined with
tools like watch, nodemon or node.js' built in `--watch` feature to create a nice fast
feedback loop when working on migrations.

In `--prod` mode, migrations run one time only.  And any migrations marked as completed in `prod`
will never re-run or teardown in `--dev` mode.

