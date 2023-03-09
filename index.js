#!/usr/bin/env node

/* globals process, console, URL */
import { argv, $, glob, chalk } from 'zx'
import postgres from 'postgres'
import * as M from 'module'
import * as P from 'path'
import dotenv from 'dotenv'
import os from 'os'

import * as u from './utils.js'
import dryPostgres from './dryPostgres.js'

// expose argv like zx
const pkg = M.createRequire(import.meta.url) ('./package.json')

const help =
`
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

--search-path=''            Specify custom default search_path for all your migrations.
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
`

if( process.argv.length == 2 || argv.help ){
    console.log(help)
    process.exit(argv.help ? 0 : 1)
}

// we do not use argv.prod, just argv.dev to indicate dev internally
// but we guard here to ensure dev=true means prod=false and vice versa
if ( argv.dev && argv.prod ) {
    console.error(chalk.red`Both --dev and --prod cannot be set at the same time`)
    process.exit(1)
}
if (!(argv.dev || argv.prod)) {
    console.error(chalk.red`Either --dev or --prod must be specified`)
    process.exit(1)
}


if ( argv['env-file'] ) {
    console.log('|'+argv['env-file']+'|')
    const result = dotenv.config({ path: argv['env-file'], override: true })
    if(result.error){
        console.log(chalk.red(`Failed to load environment variables from ${argv['env-file']}`))
        throw result.error
    }
    console.log(chalk.yellow(`Loaded environment variables from ${argv['env-file']}`))
}

const order =
    argv.dev && argv.teardown
    ? [
        { name: 'setupPGMG', hooks: [] }
        , { name: 'devTeardown'
        , hooks: [[
            { name: 'teardown', ifExists: true }
        ,]]
        }
        ,{ name: 'removeDevMigrationRecords', hooks: [[]] }
    ]
    : [
        { name: 'dropCreate', hooks: [], skip: !argv.restore }
        ,{ name: 'setupPGMG', hooks: [] }

        ,{ name: 'restore', hooks: [], skip: !argv.restore }
        ,{ name: 'clusterMigrate'
        , hooks: [
            [
                { name: 'teardown', skip: !argv.dev, ifExists: true }
                ,{ name: 'cluster', skip: false, rememberChange: true, ifNoMigrationUser: true }
            ]
        ]
        }
        ,{ name: 'databaseMigrate'
        , hooks: [
            [
                { name: 'action', skip: false, rememberChange: true }
                , { name: 'always', skip: false, rememberChange: true, always: true }

            ]
        ]
        }
    ]

// so I can override it easily for debugging
function getHostName(){
    return process.env.HOSTNAME || process.env.HOST || os.hostname()
}

function slugify(s){
    return s.split('\n').join('').trim().toLowerCase().replace(/\-|\s/g, '_')
}

async function main(){

    if( argv.version ) {
        console.log(pkg.version)
        process.exit(0)
    }

    let [connectionString] = argv._

    let {
        ssl:theirSSL,
        dry=false
    } = argv


    if ( theirSSL == 'heroku' ) {
        let hosts = []
        if (process.env.PGHOST) {
            hosts = process.env.PGHOST.split(',')
        } else if (connectionString ) {
            hosts =
                connectionString.split('@')[1].split('/')[0].split(',').map( x => x.split(':')[0])
        }

        theirSSL =
            hosts.every( x => x.endsWith('.com') )
            ? 'no-reject'
            : false
    }

    const ssl =
        theirSSL == 'no-reject'
            ? { rejectUnauthorized: false }
        : theirSSL == 'reject'
            ? { rejectUnauthorized: true }
        // inspired by: https://github.com/porsager/postgres/blob/master/lib/index.js#L577
        : theirSSL !== 'disabled' && theirSSL !== false && theirSSL


    let app = {

        async resetConnection(){
            // Why:
            // https://github.com/JAForbes/pgmg/issues/17

            if (clusterSQL) {
                await clusterSQL.end()
                clusterSQL = postgres(clusterURL, { ...config, onnotice: console.error })
            }
            if( app.sql ) {
                await app.sql.end()
                await app.realSQL?.end()
            }


            app.realSQL = RealSQL()

            app.drySQL =
                dryPostgres(app.realSQL)

            app.sql = dry ? app.drySQL : app.realSQL
            app.sql.pgmg = u

            if (!argv['keep-default-search-path']) {
                await app.sql`
                    set search_path = '${app.sql.unsafe(argv['search-path'] ?? '')}'
                `
            }
        }
    }

    function onnotice(...args){
        if( app.realSQL.onnotice ) {
            app.realSQL.onnotice(...args)
        } else {
            if(args[0].severity == 'NOTICE') return;
            console.log(...args)
        }
    }

    const pg = [
        connectionString
        , { ssl, onnotice, max: 1, prepare: false }
    ]

    const RealSQL = () =>
        postgres(...pg)

    let migrations =
        await Promise.all(
            argv._.filter( x => x.endsWith('.js') || x.endsWith('.mjs') )
                .map( x => glob(x) )
        )
        .then( x => x.flat() )


    async function teardown_pgmg_objects(sql, {migration_user, service_user}){
        for (let target of [migration_user, service_user]) {

            const [found] = await sql`
                select rolname
                from pg_catalog.pg_roles
                where rolname = ${target};
            `
            if ( found ) {
                await sql.unsafe(`drop owned by ${target} cascade`)
                await sql.unsafe(`drop role ${target}`)
            }
        }
    }
    async function create_pgmg_objects(sql, {migration_user, service_user}){
        for (let target of [migration_user, service_user]) {

            const [found] = await sql`
                select rolname
                from pg_catalog.pg_roles
                where rolname = ${target};
            `

            if (found) {
                if (!argv.dev) {
                    throw new Error('pgmg managed role already exists: ' + target)
                }
                return;
            }

            if ( target === migration_user ) {
                await sql.unsafe(`create role ${target} with superuser nologin`)
            } else if (target === service_user ) {
                await sql.unsafe(`create role ${target} with noinherit nologin nocreatedb nocreaterole nosuperuser noreplication nobypassrls`)
            }
        }
    }

    async function doHookPhase(hookPhase){


        for ( let migration of migrations ) {
            await app.resetConnection()
            let rawModule = await import(P.resolve(process.cwd(), migration))
            if ( !rawModule.name ) {
                console.error('Migration', migration, 'did not export a name.')
                process.exit(1)
            } else if (!(
                rawModule.action
                || rawModule.always
                || rawModule.cluster
                || rawModule.teardown
            )) {
                console.error('Migration', migration, 'did not export lifecycle function (action|always|cluster).')
                process.exit(1)
            }

            const module =
                // if its not exported, its true
                rawModule.managedUsers !== false
                ? {
                    ...rawModule
                    ,async teardown (...args) {
                        if(argv.dev) {
                            await rawModule.teardown?.(...args)
                            await teardown_pgmg_objects(args[0], {migration_user, service_user})
                        }
                    }
                    ,async cluster(...args) {
                        await create_pgmg_objects(args[0], {migration_user, service_user})
                        await rawModule.cluster?.(...args)
                    }
                }
                : rawModule

            const name_slug = slugify(module.name)
            const migration_user = 'pgmg_migration_' + name_slug
            const service_user = 'pgmg_service_' + name_slug

            const roles = { migration: migration_user, service: service_user }

            const [migrationUserFound] = await app.realSQL`
                select rolname
                from pg_catalog.pg_roles
                where rolname = ${roles.migration};
            `
            const noMigrationUserFound = !migrationUserFound

            for (
                let {
                    name: hook
                    , always
                    , skip
                    , rememberChange
                    , ifExists
                    , ifNoMigrationUser
                } of hookPhase
            ) {

                if(skip) {
                    continue;
                }

                let action;
                action = module[hook]
                const [anyMigrationFound] =
                    await app.realSQL`
                        select migration_id
                        from pgmg.migration
                        where name = ${module.name}
                    `

                const [found] = always
                    ? [{}]
                    // either match on hook for new migrations
                    // or for old migrations just match on name
                    : await app.realSQL`
                        select M.migration_id, H.dev, H.hostname
                        from pgmg.migration M
                        inner join pgmg.migration_hook H using(name)
                        where (name, hook) = (${module.name}, ${hook})
                        union all
                        select migration_id, false as dev, ${getHostName()} as hostname
                        from pgmg.migration
                        where name = ${module.name}
                        and created_at < '2022-08-11'
                        ;
                    `

                const autoMigrationUserEnabled =
                    module.managedUsers

                const hostIsDifferent =
                    getHostName() !== found?.hostname

                const [anyDevHookFound] = always
                    ? [{}]
                    // either match on hook for new migrations
                    // or for old migrations just match on name
                    : await app.realSQL`
                        select M.migration_id, H.dev, H.hostname
                        from pgmg.migration M
                        inner join pgmg.migration_hook H using(name)
                        where (name, dev) = (${module.name}, true)
                        ;
                    `

                let description = module.description
                    ? module.description.split('\n').map( x => x.trim() ).filter(Boolean).join('\n')
                    : null

                const shouldContinue =
                    action
                    && (

                        // never ran before
                        !found && !ifExists

                        // ran before in dev mode and we are in dev mode again
                        // skip migrations with no teardown
                        || found && found.dev && argv.dev && module.teardown

                        // run if any migration exists, for teardown
                        || ifExists && anyMigrationFound && anyDevHookFound

                        // or it is a cluster hook that has run before but
                        // we have no trace of a cluster user so it hasn't
                        // run on this machine
                        || found && hook === 'cluster' && (
                            autoMigrationUserEnabled
                            ? ifNoMigrationUser && noMigrationUserFound
                            : hostIsDifferent
                        )

                    )

                if (shouldContinue){
                    try {
                        console.log(hook+'::'+migration)
                        await app.sql.unsafe(`reset role`)
                        if (module.managedUsers && !['cluster','teardown'].includes(hook)){
                            await app.sql.unsafe(`set role ${roles.migration}`)
                        }
                        await action(app.sql, { ...argv, roles })
                        await app.sql.unsafe(`reset role`)
                        if ( rememberChange ) {
                            await app.sql`
                                insert into pgmg.migration(name, filename, description)
                                values (${module.name}, ${migration}, ${description})
                                on conflict (name) do nothing;
                            `
                            await app.sql`
                                insert into pgmg.migration_hook(
                                    hook, name, dev, hostname
                                )
                                values (
                                    ${hook}
                                    , ${module.name}
                                    , ${!!argv.dev}
                                    , ${getHostName()}
                                )
                                on conflict (hook, name) do nothing;
                            `
                        }

                    } catch (e) {
                        console.error('Migration failed')
                        console.error(e)
                        process.exit(1)
                    }
                }
            }
        }
    }

    const [dbUrl, config] = pg
    const url =  new URL(dbUrl)
    const dbName = url.pathname.slice(1)
    const clusterURL =
        Object.assign(new URL(url), { pathname: '' })+''

    let clusterSQL =
        postgres(clusterURL, { ...config, onnotice: console.error })

    for ( let { name: restorePhase, skip, hooks: hookPhases } of order ) {
        if (skip) {
            continue;
        }

        if (restorePhase == 'setupPGMG') {
            await app.resetConnection()
            await app.realSQL.unsafe`
                create extension if not exists pgcrypto;
                create schema if not exists pgmg;
                create table if not exists pgmg.migration (
                    migration_id uuid primary key default public.gen_random_uuid()
                    , name text not null
                    , filename text not null
                    , description text null
                    , created_at timestamptz not null default now()
                )
                ;

                alter table pgmg.migration add unique (name)
                ;

                create table if not exists pgmg.migration_hook (
                    hook text not null
                    , name text not null references pgmg.migration(name) on delete cascade
                    , created_at timestamptz not null default now()
                    , dev boolean not null default false
                    , hostname text not null
                    , primary key (name, hook)
                );
            `
        } else if (restorePhase == 'dropCreate' ) {
            await clusterSQL.unsafe(`drop database if exists ${dbName};`)
            await clusterSQL.unsafe(`create database ${dbName};`)
            await app.resetConnection()
        } else if ( restorePhase == 'restore' ) {
            await $`pg_restore --verbose --clean -d ${dbUrl} ${argv.restore}`.nothrow()
        } else if (restorePhase == 'removeDevMigrationRecords') {
            await app.sql`
                delete from pgmg.migration_hook where dev;
            `
            await app.sql`
                delete from pgmg.migration M
                where true
                and created_at >= '2022-08-11'
                and (
                    select count(*) as n
                    from pgmg.migration_hook H
                    where M.name = H.name
                ) = 0;
            `
        }

        for( let hookPhase of hookPhases ) {
            await doHookPhase(hookPhase)
        }
    }

    await app.realSQL.end()
    await clusterSQL.end()

    console.log('Migration complete')
}


main()
.catch(
    e => {
        console.error(e)
        process.exit(1)
    }
)
