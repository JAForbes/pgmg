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
pgmg "$DATABASE_URL" "migrations/first-migrations.mjs"
```

## What

- A forward only, idempotent, postgres migration tool, with minimal noise but also minimal magic
- OOTB support for postgres.js, we pass in a preconfigured postgres.js instance just point us at migration files
- A simple migration file format, just export a transaction function a name and a description
- All metadata stored in 1 simple table in the same database that you are migrating, makes it easy to get fine-grained control

## How

A very simple script, we simply inject a schema (`pgmg`) and table (`migration`) into your target database.  And record whether or not a migration has run for that migration name before.  If so, we skip that file, if not we run it.

If the migration file runs without error, we insert a migration row based on the exported properties (name, description).  If it fails, we don't.

pgmg has no opinion on migration order, but most of the time, there is only new files that aren't recorded, and in that case they can be run in any order.  So you can just pass `migrations/*` to pgmg and it will ignore migrations it has een before, and run new ones in sequence in glob order.

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

--ssl 
    | --ssl                 Enables ssl
    | --ssl=prefer          Prefers ssl
    | --ssl=require         Requires ssl
    | --ssl=reject          Reject unauthorized connections
    | --ssl=no-reject       Do not reject unauthorized connections
    | --ssl=heroku          --no-ssl-reject if the host ends with a .com

```

### Migration File

A migration file can have either an `action` export or a `transaction` export.  An `action` export gets a raw sql instance.  And performs no rollbacks if there is a failure.  That means you need to manually handle your own error and rollback cases.

The recommended approach is to use `transaction` instead wherever possible which automatically wraps your migration in [`sql.begin`](https://github.com/porsager/postgres#transactions).  This will work great for most migrations, sometimes though you cannot run your migration in a migration and then you'll need to use `action`.

Beyond that, you _must_ export a unique name property, this name is used by pgmg to determine whether or not this migration has run before.  But, it is also good for reference later to see what migrations have run on this db in the past.  Especially when creating curated or conditional migrations.

`description` is an optional export, but a recommended export.  It is rare you need to change the database schema and there isn't some helpful reason you can provide for the change.  A migration is effectively an admission that our first idea of a model was incorrect or incomplete, that is always worthwhile to document.

#### export transaction

Perform your migration within a transaction.

#### export action

Perform your migration with a raw sql instance, no transaction.

This is necessary for some schema changes, e.g. role changes, or any usage of `concurrently`.

#### export name (required)

The name of the migration.

#### export description (recommended)

A description of why this migration needs to occur.

## FAQ

### How do I order my migrations?

pgmg will apply migrations in the order you pass them to pgmg as arguments.

So if you choose to number your migrations, a simple glob will order them.


```
# Alphabetical ordered files
$ ls -l migrations
01-user-permissions.js
02-full-text-search.js
03-magic-link.js

# globbing will natively order alphabetically by default
$ pgmg $DATABASE_URL migrations/*.js
```

You could also have a simple text file that acts a manifest and expand the file as arguments like so:

Imagine we have a `migrations.txt` file:

```txt
user-permissions.js
full-text-search.js
magic-link.js
```

We can expand that file as arguments like so:

`pgmg $DATABASE_URL $(cat migrations.txt)`

If you wanted, your manifest could be json, or yaml, or whatever you want, as long as you can extract the filenames and pass them as arguments.

## Roadmap

There's a few things I would like to add.

- A dry run, that shows what changes will be made without actually applying them.
- Optional verbose logging
- Some simple commands for housekeeping:
    - Show existing migrations
    - Remove migrations matching filenames
    - Remove migrations match a naming convention
- An interactive bootstrap command that creates a new migration file
