# pgmg

pgmg = postgres + migrations

## Quick Start

- `mkdir -p migrations`
- `touch migrations/first-migration.mjs`

```js
// migrations/first-migration.js
export const name = 'First Migration'
export const description = `
    This is where you can describe what your migration does.

    We automatically trim this so don't worry about indentation etc.
`

// If this fails, any changes will be rolled back
export async function transaction(sql){

    await sql`
        create table example(
            a int,
            b int,
            primary key (a,b)
        )
    `
}
```

```bash
# We don't rely on alphabetical order, you just pass in the files
# you want to migrate.
npx pgmg "$DATABASE_URL" "migrations/first-migrations.mjs"
```

## What

- A forward only, idempotent, postgres migration tool, with minimal noise but also minimal magic
- OOTB support for postgres.js, we pass in a preconfigured postgres.js instance just point us at migration files
- A simple migration file format, just export a transaction function a name and a description
- All metadata stored in 1 schema in the same database that you are migrating, makes it easy to get fine-grained control

## How

A very simple script, we simply inject a schema (`pgmg`) and table (`migration`) into your target database.  And record whether or not a migration has run for that migration name before.  If so, we skip that file, if not we run it.

If the migration file runs without error, we insert a migration row based on the exported properties (name, description).  If it fails, we don't.

pgmg has no opinion on migration order, but most of the time, there is only new files that aren't recorded, and in that case they can be run in any order.  So you can just pass `migrations/*` to pgmg and it will ignore migrations it hasn't seen before, and run new ones in sequence in glob order.

`pgmg` stores its metadata in the target database (instead of in a different config file or something).  It does this because it makes it easy to escape out of the migration system when you know what you are doing.  E.g. when you want to run all migrations from scratch in development (`delete from pgmg.migration`) or even (`drop schema pgmg`).

It also makes testing / local development super logical.  When you wipe the DB, the migration tool will also be wiped and pgpg will reapply changes.


## API

### CLI

```
Usage: pgmg [CONNECTION] [OPTIONS] [FILES]

[CONNECTION]
- Pass a postgres connection string (just like psql)
- AND/OR Specify host/user etc as env flags (PGHOST, PGUSER, PGPORT)

[FILES]

Any files passed as arguments after the connection string will be imported as JS migration files.

[OPTIONS]

The only way to specify a connection is via a pg connection URL.

--data-only                 Only runs the `data` hook.
                            Does not update the `pgmg.migration` table.

--schema-only               Skips the `data` hook.  But if you insert or
                            modify data in other hooks, they will still run.

--dev                       Runs any teardown hooks before running the 
                            forward migration.  Annotates the migration
                            record as `dev` so it will be re-run next time
                            as long as --dev is passed.

                            Only runs teardown hooks after 1 successful migration.

--ssl 
    | --ssl                 Enables ssl
    | --ssl=prefer          Prefers ssl
    | --ssl=require         Requires ssl
    | --ssl=reject          Reject unauthorized connections
    | --ssl=no-reject       Do not reject unauthorized connections
    | --ssl=heroku          --no-ssl-reject if the host ends with a .com

--restore <file>            Restores a database backup.  Does the following:
                            Drops the original db, creates a new db, runs
                            cluster level migrations, restores the backup into
                            the new database, then runs the remaining migrations.
```

### Migration File

A migration file export various lifecycle functions that are run depending on context and other metadata exports.

#### export name (required)

The name of the migration.  You _must_ export a unique name property, this name is used by pgmg to determine whether or not this migration has run before.  But, it is also good for reference later to see what migrations have run on this db in the past.  Especially when creating curated or conditional migrations.

#### export description (recommended)

A description of why this migration needs to occur.  `description` is an optional export, but a recommended export.  It is rare you need to change the database schema and there isn't some helpful reason you can provide for the change.  A migration is effectively an admission that our first idea of a model was incorrect or incomplete, that is always worthwhile to document.

#### export transaction

Perform your migration within a transaction.  If it is ever possible to use `transaction` instead of `action` it is recommended as a failed migration will not leave your database in a partially altered state.  This will work great for most migrations, sometimes though you cannot run your migration in a migration and then you'll need to use `action`.

#### export action

Perform your migration with a raw sql instance, no transaction.

This is necessary for some schema changes, e.g. role changes, or any usage of [`concurrently`](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY).

An `action` export gets a raw sql instance.  And performs no rollbacks if there is a failure.  That means you need to manually handle your own error and rollback cases.

#### export cluster

The `cluster` hook is designed for cluster level migrations, like defining users/roles and server settings.  It runs before the `action` / `transaction` / `always` hooks.

What makes `cluster` different to just another hook is that it will run if the recorded run was on a different hostname.  So if you download a prod snapshot, all the cluster snapshots will run again as they were originally run on a different server.

When writing `cluster` hooks you should still not assume the roles etc you are creating do not already exist, as with any cluster level changes, you should never assume changes were not already applied by another service, system or even your own code on another branch.

#### export always

The `always` hooks runs every time `pgmg` is passed a migration file.  This hook is useful for checks or migrations that should be re-evaluated every time.  An example would be dynamically generated triggers or row level security policies that query the info schema for tables matching a given rule or predicate.

It can also be useful for local development as your migration will run every time.

#### export teardown

The `teardown` hook is designed for local development only.  `pgmg` is a forward only migration tool, but for local development it can be handy to re-run the same migration continually and have some clean up logic to reset the db state so you can test your migration changes.

`teardown` will only run if the `--dev` hook is passed to `pgmg`.

#### export data

You can insert or modify data in any of the above hooks, but it is recommended to do so in the `data` hook as it runs after your table has been modified.

There's some cases where inserting data will create pending triggers, and when a table is pending triggers the table cannot be altered. So having a clean separation between altering tables and inserting data makes sense.

You can skip insert data by passing `--schema-only`, and conversely you can skip all hooks except `data` by passing `--data-only`

## Experimental

### User Management

We are currently experimenting with pgmg managing users declaritively and auto creating migration and service roles per migration.  This way you can easily teardown a migration via `drop owned by`.

You can also assign new permissions to an existing user by assigning the service role to the target user.  If this is managed automatically by pgmg you can avoid a lot of complexity in migration clean up for local development, but also in user permission management as you can revoke a migrations grants by revoking the generated service role from the target role.

Of course, this is hyper opinionated and the original goal for pgmg was to be pretty simple so we'll keep this opt in for a while.  But we tend to build for our needs not an imagined ideal so if it works, it will likely land in core.

#### roles

These pgmg managed roles can be accessed in the options object passed as a second argument to your migration hooks

```js
export function actions(sql, { roles }){
    await sql`grant ${roles.service} to my_pg_user`
}
```

#### Migration Role

Each migration has an auto generated super user role named `pgmg_migration_{name}` where name is taken from your unique migration name.  Before any of your migration hooks run, pgmg will `set role` to the migration role so that any created objects are tied to the migration role, not the connection role (usually the `postgres` super user).

If you are running pgmg with the `--dev` flag then a teardown hook will automatically be applied which destroys any objects created by that migration user.

For now this is opt in via `export const options = { migration_role: true }`

#### Service Role

Each migration has an auto generated service role named `pgmg_service_{name}` where name is taken from your unique migration name.  It is recommend to assign any grants or RLS policies to the service role.

If you are running pgmg with the `--dev` then a teardown hook will automatically be applied with destroys any objects granted to the service user.

You are encouraged to manually grant the service user to an actual postgres service user in your app.  E.g. if you had a postgres user used by a photo processing service you might run this line somewhere in your cluster hook.

```js
await sql`grant ${sql(roles.service)} to photo_processing`
```

By default the service role has no permissions, and must be explicitly granted in your `cluster` hook.  Alternatively you can use the experimental declarative format.

#### Magic

For local development, if pgmg detects a service user already exists we assume the teardown hook needs to run for that migration.  The only reason a service/migration user would still exist would be if there was a crash or early exit before pgmg finished cleaning up.  This mechanism is also how pgmg tracks if the cluster hook needs to re-run on a new machine.

#### Production Usage

The migration/service users make local development far simpler as you can run migrations on a loop

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

You could also have a simple text file that acts a manifest and expand the file as arguments like so:

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

If you wanted, your manifest could be json, or yaml, or whatever you want, as long as you can extract the filenames and pass them as arguments.

## Roadmap

There's a few things I would like to add.

- Optional verbose logging
- Some simple commands for housekeeping:
    - Show existing migrations
    - Remove migrations matching filenames
    - Remove migrations match a naming convention
- An interactive bootstrap command that creates a new migration file
