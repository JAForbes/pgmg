# pgmg 🐘

`pgmg` = postgres + migrations

> 😱 Be aware `pgmg` is iterating at a fairly rapid pace and you should expect
> breaking changes. We use it heavily at https://harth.io/ but we are also
> constantly iterating on features and ideas. Probably best to wait for a 1.0 or
> pin to a specific gitref instead of using `npx pgmg`.

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

// If this fails, any changes will be rolled back
export async function transaction(sql) {
  await sql`
        create table example(
            a int,
            b int,
            primary key (a,b)
        )
    `;
}
```

```bash
# We don't rely on alphabetical order, you just pass in the files
# you want to migrate.
npx pgmg "$DATABASE_URL" "migrations/first-migrations.mjs"
```

## What

- 🧘‍♀️ A forward only, idempotent, postgres migration tool, with minimal noise
- 🧙‍♂️ Just enough convenience and magic to avoid common pitfalls of migrating
  databases
- 🐘 OOTB support for postgres.js, we pass in a preconfigured postgres.js
  instance just point us at migration files
- 😎 A simple migration file format, just export a transaction function a name
  and a description
- 👽 No config files - all metadata stored in the `pgmg` schema in the same
  database that you are migrating - take a peek at it 👀!

## How

A very simple idea, we simply inject a schema (`pgmg`) into your target database
and record whether or not a migration has run for that migration name before. If
so, we skip that file, if not we run it.

If the migration file runs without error, we insert a migration row based on the
exported properties (name, description). If it fails, we don't.

Because all metadata is stored on the migrated db - when you wipe the db, the
migration tool will also be wiped and pgpg will reapply changes on next run.

## API

### CLI

```
Usage: pgmg [PGMG OPTIONS] [CONNECTION] [OPTIONS] [FILES]
Version: ${pkg.version}

[PGMG OPTiONS]

--help      Logs this help message

--version   Logs the current pgmg version

[CONNECTION]
- Pass a postgres connection string (just like psql)
- AND/OR Specify host/user etc as env flags (PGHOST, PGUSER, PGPORT)

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

--restore <file>            Restores a database backup and then runs migrations
                            against it.  Does the following:
                            Drops the original db, creates a new db, runs
                            cluster level migrations, restores the backup into
                            the new database, then runs the remaining migrations.

--env-file <file>           Specify an env file to be loaded before running your
                            migration files.  Note this will overwrite ambient
                            environment variables with the same name.

--search_path=''            Specify custom default search_path for all your migrations.
                            Default='' if not prevented via --keep-default-search-path

--keep-default-search-path  By default pgmg sets search_path='' to encourage you
                            to fully qualify names and/or explicitly set search_path
                            to the minimum required scope.  This flag will leave
                            search_path at its more insecure default.

--ssl
    | --ssl                 Enables ssl
    | --ssl=prefer          Prefers ssl
    | --ssl=require         Requires ssl
    | --ssl=reject          Reject unauthorized connections
    | --ssl=no-reject       Do not reject unauthorized connections
    | --ssl=heroku          --no-ssl-reject if the host ends with a .com

    For more detailed connection options, connect to postgres manually
    via -X
```

### Migration File

A migration file export various lifecycle functions that are run depending on
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

Perform your migration with a raw sql instance, no transaction.

This is necessary for some schema changes, e.g. role changes, or any usage of
[`concurrently`](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

An `action` export gets a raw sql instance. And performs no rollbacks if there
is a failure. That means you need to manually handle your own error and rollback
cases.

#### `cluster`

The `cluster` hook is designed for cluster level migrations, like defining
users/roles and server settings. It runs before the `action` / `transaction` /
`always` hooks.

What makes `cluster` different to just another hook is that it will run if the
recorded run was on a different hostname. So if you download a prod snapshot,
all the cluster snapshots will run again even if that prod snapshot has already
had that migration run against it.

> 💪 You can also dump roles via `pg_dump` and not bother with cluster hooks at
> all. We may deprecate cluster hooks when we release our own `pg_dump` helper.

#### export always

The `always` hooks runs every time `pgmg` is passed a migration file. This hook
is useful for checks or migrations that should be re-evaluated every time. An
example would be dynamically generated triggers or row level security policies
that query the info schema for tables matching a given rule or predicate.

It can also be useful for local development as your migration will run every
time.

#### export teardown

The `teardown` hook is designed for local development only. `pgmg` is a forward
only migration tool in production, but for local development it can be handy to
re-run the same migration continually and have some clean up logic to reset the
db state so you can test your migration changes.

`teardown` will only run if the `--dev` hook is passed to `pgmg`.

> Note in `--dev` by default `pgmg` automatically tears down created objects
> from the last migration run. You can disable this via
> `export const managedUsers = false`

## Automatic Teardown

`pgmg` has a very clever (and a little bit magical 🪄) feature for automatic
teardown of migrations for local development. We do this because effectively
writing up and down scripts is hard and error prone and probably a bad idea.

How does it work?

We automatically create two roles for every migration file. A migration role and
a service role. Before running your migration hooks we `set role` to the
migration role. When you re-run a dev migration we inject a teardown hook that
just runs `drop owned by <migration role>`.

The only caveat is, if you use `set role` yourself in your migration you opt out
of this feature.

## Automatic Roles

These `pgmg` managed roles can be accessed in the options object passed as a
second argument to your migration hooks

```js
export function actions(sql, { roles }) {
  await sql`grant ${roles.service} to my_pg_user`;
}
```

### Migration Role

Each migration has an auto generated superuser role named
`pgmg_migration_{name}` where name is taken from your unique migration name.
Before any of your migration hooks run, `pgmg` will `set role` to the migration
role so that any created objects are tied to the migration role, not the
connection role (usually the `postgres` super user).

If you are running `pgmg` with the `--dev` flag then a teardown hook will
automatically be applied which destroys any objects created by that migration
user.

> You can disable this feature via `export const managedUsers = false`.

### Service Role

Each migration has an auto generated service role named `pgmg_service_{name}`
where name is taken from your unique migration name. It is recommend to assign
any grants or RLS policies to the generated service role and then grant the
generated service role to your own postgres role one time at the end.

This has several benefits:

- Safe automatic teardown scoped to a specific migration/service role's database
  objects
- Easily see what migrations are relevant to specific service roles via `\du` in
  psql
- Assign / Reuse ownership to multiple services by granting the generated
  service role to multiple downstream postgres roles.
- Revoke permissions associated with a migration via
  `revoke ${sql.unsafe(roles.service)} from the_role`

```js
export async functin cluster(sql){
    await sql`create role guitar_service with password ${sql.unsafe(process.env.GUITAR_SERVICE_PASSWORD)}`
}

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

If you are running `pgmg` with the `--dev` then a teardown hook will
automatically be applied with destroys any objects owned by the service user.

You are encouraged to manually grant the service user to an actual postgres
service user in your app. E.g. if you had a postgres user used by a photo
processing service you might run this line somewhere in your migration.

```js
await sql`grant ${sql.unsafe(roles.service)} to photo_processing`;
```

> You can disable this feature via `export const managedUsers = true`.

> By default the service role has no permissions, and must be explicitly granted
> in your migration hook.

## Other Magic

For local development, if `pgmg` detects a service user already exists we assume
the teardown hook needs to run for that migration. The only reason a
service/migration user would still exist would be if there was a crash or early
exit before `pgmg` finished cleaning up. This mechanism is also how `pgmg`
tracks if the cluster hook needs to re-run on a new machine.

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
$ npx pgmg $DATABASE_URL migrations/*.js
```

You could also have a simple text file that acts a manifest and expand the file
as arguments like so:

Imagine we have a `migrations.txt` file:

```txt
user-permissions.js
full-text-search.js
magic-link.js
```

We can expand that file as arguments like so:

```bash
npx pgmg $DATABASE_URL $(cat migrations.txt)
```

If you wanted, your manifest could be json, or yaml, or whatever you want, as
long as you can extract the filenames and pass them as arguments.
