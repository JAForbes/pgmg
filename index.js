#!/usr/bin/env node

/* globals process, console, URL */
import { argv, $, glob } from 'zx'
import postgres from 'postgres'
import * as M from 'module'
import * as P from 'path'
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

--dev                       Runs any teardown hooks before running the
                            forward migration.  Annotates the migration
                            record as \`dev\` so it will be re-run next time
                            as long as --dev is passed.

                            Only runs teardown hooks after 1 successful migration.

--teardown                  Runs the teardown hook for migrations tagged as dev.
                            Not to be used in production.  Will exit non zero
                            if --dev flag is not also passed.

--data-only                 Only runs the \`data\` hook.
                            Does not update the \`pgmg.migration\` table.

--schema-only               Skips the \`data\` hook.  But if you insert or
                            modify data in other hooks, they will still run.

--restore <file>            Restores a database backup and then runs migrations
                            against it.  Does the following:
                            Drops the original db, creates a new db, runs
                            cluster level migrations, restores the backup into
                            the new database, then runs the remaining migrations.

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
                { name: 'teardown', schemaOnly: true, skip: !argv.dev, ifExists: true }
                ,{ name: 'cluster', skip: argv.dataOnly, rememberChange: true, ifNoMigrationUser: true }
            ]
        ]
        }
        ,{ name: 'databaseMigrate'
        , hooks: [
            [
                { name: 'action', skip: argv.dataOnly, rememberChange: true }
                , { name: 'transaction', transaction: true, skip: argv.dataOnly, rememberChange: true }
                , { name: 'always', skip: argv.dataOnly, rememberChange: true, always: true }

            ]
            ,[
                { name: 'data', transaction: true, dev: false, skip: argv.schemaOnly }
            ]
        ]
        }
    ]

function slugify(s){
    return s.split('\n').join('').trim().toLowerCase().replace(/\-|\s/g, '_')
}

async function main(){
    if( process.argv.length == 2 || argv.help ){
        console.log(help)
        process.exit(argv.help ? 0 : 1)
    }

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
            if( app.sql ) {
                await app.sql.end()
            }

            app.realSQL = RealSQL()

            app.drySQL =
                dryPostgres(app.realSQL)

            app.sql = dry ? app.drySQL : app.realSQL
            app.sql.pgmg = u
            app.sql.raw = Raw(app.sql)
            app.sql.Raw = Raw
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

    function Raw(sql){

        return function raw(strings, ...values){
            return sql.unsafe(String.raw(strings, ...values))
        }
    }

    let migrations =
        await Promise.all(
            argv._.filter( x => x.endsWith('.js') || x.endsWith('.mjs') )
                .map( x => glob(x) )
        )
        .then( x => x.flat() )


    async function teardown_pgmg_objects(sql, {migration_user, service_user}){
        for (let target of [migration_user, service_user]) {

            const [found] = await sql`
                select usename
                from pg_catalog.pg_user
                where usename = ${target};
            `
            if ( found ) {
                await sql.unsafe(`drop owned by ${target}`)
                await sql.unsafe(`drop role ${target}`)
            }
        }
    }
    async function create_pgmg_objects(sql, {migration_user, service_user}){
        for (let target of [migration_user, service_user]) {

            console.log('checking if',target,'exists')
            const [found] = await sql`
                select usename
                from pg_catalog.pg_user
                where usename = ${target};
            `
            console.log(target, found)

            if (found) {
                throw new Error('pgmg managed role already exists: ' + target)
            }

            if ( target === migration_user ) {
                console.log('creating',target)
                await sql.unsafe(`create role ${target} with superuser nologin`)
            } else if (target === service_user ) {
                console.log('creating',target)
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
                rawModule.transaction
                || rawModule.action
                || rawModule.always
                || rawModule.cluster
                || rawModule.data
                || rawModule.teardown
            )) {
                console.error('Migration', migration, 'did not export lifecycle function (transaction|action|always|cluster|data).')
                process.exit(1)
            }

            const module = 
                rawModule.managedUsers
                ? {
                    ...rawModule
                    ,async teardown (...args) {
                        console.log('running generated teardown')
                        if(argv.dev) {
                            await teardown_pgmg_objects(app.realSQL, {migration_user, service_user})
                            await rawModule.teardown?.(...args)
                        }
                    }
                    ,async cluster(...args) {    
                        console.log('running generated cluster')
                        await create_pgmg_objects(app.realSQL, {migration_user, service_user})
                        await rawModule.cluster?.(...args)
                    }
                }
                : rawModule

            const name_slug = slugify(module.name)
            const migration_user = 'pgmg_migration_' + name_slug
            const service_user = 'pgmg_service_' + name_slug

            const roles = { migration: migration_user, service: service_user }

            const noMigrationUserFound = await app.realSQL`
                select usename
                from pg_catalog.pg_user
                where usename = ${roles.migration};
            `

            for (
                let {
                    name: hook
                    , transaction
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
                if ( transaction && module[hook] ) {
                    action = SQL => SQL.begin( sql => {
                        sql.pgmg = u
                        sql.raw = Raw(sql)
                        sql.raw.pgmg = u
                        return module[hook](sql)
                    })
                } else {
                    action = module[hook]
                }

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
                        select migration_id, false as dev, ${os.hostname()} as hostname
                        from pgmg.migration
                        where name = ${module.name}
                        and created_at < '2022-08-11'
                        ;
                    `

                const autoMigrationUserEnabled = 
                    module.managedUsers

                const hostIsDifferent = 
                    os.hostname() !== found?.hostname

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
                        || found && (
                            autoMigrationUserEnabled
                            ? ifNoMigrationUser && noMigrationUserFound
                            : hostIsDifferent
                        )

                    )

                if (shouldContinue){
                    try {
                        console.log(hook+'::'+migration)
                        await app.sql.unsafe(`reset role`)
                        if (module.managedUsers){
                            await app.sql.unsafe(`set role ${roles.migration}`)
                        }
                        await action(app.sql, { dev: argv.dev, roles })
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
                                    , ${os.hostname()}
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

    const clusterSQL =
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
