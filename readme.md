# pgmg 🐘

`pgmg` = postgres + migrations

> 😱 Be aware `pgmg` is iterating at a fairly rapid pace and you should expect
> breaking changes. We use it heavily at https://harth.io/ but we are also
> constantly iterating on features and ideas. Probably best to wait for a 1.0 or
> pin to a specific gitref instead of using `pgmg`.
>
> If you want to jump over early, run this version of `pgmg` against a different migrations folder as the 
> metadata stored from older pgmg versions is not compatible.

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
export const roles = [
  { name: 'guitar_service'
  , password: process.env.GUITAR_SERVICE_PASSWORD
  , with: 'login inherit'
  }
]

export async function action(sql, { roles }) {
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

## API

### CLI

```
Usage: pgmg [PGMG OPTIONS] [CONNECTION] [OPTIONS] [FILES]

[PGMG OPTiONS]

--help      Logs this help message

--version   Logs the current pgmg version

--debug     Enables verbose debug logging

[CONNECTION]

Pass a postgres connection string (just like psql)

[FILES]

Any files passed as arguments after the connection string will be imported as JS migration files.

[OPTIONS]

The only way to specify a connection is via a pg connection URL.


╭――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――╮
│                                                                                          │
│               Note you must specify --dev or --prod modes when running pgmg              │
│                                                                                          │
╰――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――╯


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

--teardown                  Runs the teardown hook for migrations tagged as dev.
                            Not to be used in production.  Will exit non zero
                            if --dev flag is not also passed.

--env-file <file>           Specify an env file to be loaded before running your
                            migration files.  Note this will overwrite ambient
                            environment variables with the same name.

--search-path=''            Specify custom default search_path for all your migrations.
                            Default='' if not prevented via --keep-default-search-path

--keep-default-search-path  By default pgmg sets search_path='' to encourage you
                            to fully qualify names and/or explicitly set search_path
                            to the minimum required scope.  This flag will leave
                            search_path at its more insecure default.

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

// runs once per host
export const cluster = async (sql) => {};

// runs once per migration
export const action = async (sql) => {};

// runs every migration
export const always = async (sql) => {};
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

#### `cluster`

The `cluster` hook is designed for cluster level migrations, like defining
users/roles and server settings. It runs before the `action` /
`always` hooks.

What makes `cluster` different to just another hook is that it will run if the
recorded run was on a different hostname. So if you download a prod snapshot,
all the cluster snapshots will run again even if that prod snapshot has already
had that migration run against it.

> 💪 You can also dump roles via `pg_dumpall` and not bother with cluster hooks at
> all. But it can be slow to dump/restore an entire cluster instead of a single database.

#### `always`

The `always` hooks runs every time `pgmg` is passed a migration file. This hook
is useful for checks or migrations that should be re-evaluated every time. An
example would be dynamically generated triggers or row level security policies
that query the info schema for tables matching a given rule or predicate.

It can also be useful for local development as your migration will run every
time.

#### `teardown`

The `teardown` hook is designed for local development only. `pgmg` is a forward
only migration tool in production, but for local development it can be handy to
re-run the same migration continually and have some clean up logic to reset the
db state so you can test your migration changes.

`teardown` will only run if the `--dev` hook is passed to `pgmg`.

If you are running `pgmg` with the `--dev` then a teardown hook will
automatically be applied which destroys any objects owned by the migration and service user.

You are encouraged to manually grant the service user to an actual postgres
service user in your app. E.g. if you had a postgres user used by a photo
processing service you might run this line somewhere in your migration.

```js
await sql`grant ${sql.unsafe(roles.service)} to photo_processing`;
```

## FAQ

### How do I order my migrations?

pgmg will apply migrations in the order you pass them to pgmg as arguments.

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

## Running migrations in production

`pgmg` has two modes `--dev` and `--prod`.  In `--dev` mode pgmg will teardown database objects
from migrations that were run locally and recreate them each time.  This can be combined with
tools like watch, nodemon or node.js' built in `--watch` feature to create a nice fast
feedback loop when working on migrations.

In `--prod` mode, migrations run one time only.  And any migrations marked as completed in `prod`
will never re-run or teardown in `--dev` mode.

If you are using `cluster` hooks, its important to maintain a consistent `HOSTNAME` when running
migrations in production mode.  This will prevent roles or other cluster level objects from
needlessly being created twice.  If you run your migrations in CI / Github actions you will want to 
pass a fixed `HOSTNAME` variable so each new runner doesn't get treated as a new "prod".

```
HOSTNAME=prod pgmg ...
```

If you are running migrations in CI prefix your `pgmg` command with `HOSTNAME=ci` so that the 
randomized hostname doesn't confuse pgmg into running a cluster hook twice.