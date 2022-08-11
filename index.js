#!/usr/bin/env node

/* globals process, console, URL */
import { argv, $ } from 'zx'
import postgres from 'postgres'
import * as M from 'module'
import * as P from 'path'

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
                            forward migration.

--data-only                 Only runs the \`data\` hook.
                            Does not update the \`pgmg.migration\` table.

--schema-only               Skips the \`data\` hook.  But if you insert or
                            modify data in other hooks, they will still run.

--restore <file>            Restores a database backup.  Does the following:
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


const order = [
    { name: 'dropCreate', hooks: [], skip: !argv.restore }
    ,{ name: 'clusterMigrate'
    , hooks: [
        [
            { name: 'teardown', schemaOnly: true, skip: !argv.dev }             
            ,{ name: 'cluster', skip: argv.dataOnly, recordChange: true }
        ]
    ] 
    }    
    ,{ name: 'restore', hooks: [], skip: !argv.restore }
    ,{ name: 'databaseMigrate'
    , hooks: [
        [
            { name: 'action', skip: argv.dataOnly, recordChange: true }
            , { name: 'transaction', transaction: true, skip: argv.dataOnly, recordChange: true }
            , { name: 'always', skip: argv.dataOnly, recordChange: true, always: true }
            
        ]         
        ,[
            { name: 'data', transaction: true, dev: false, skip: argv.schemaOnly }
        ]
    ] 
    }
]

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

    {
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

            create table if not exists pgmg.migration_hook (
                hook text not null
                , migration_id uuid not null references pgmg.migration(migration_id)
                , created_at timestamptz not null default now()
                
                , primary key (migration_id, hook)
            );
        `
    }

    const migrations = 
        argv._.filter( x => x.endsWith('.js') || x.endsWith('.mjs') )

    async function doHookPhase(hookPhase){

        // so SET EXAMPLE=on is reset per migration
        await app.resetConnection()

        for ( let migration of migrations ) {
            let module = await import(P.resolve(process.cwd(), migration))
            if ( !module.name ) {
                console.error('Migration', migration, 'did not export a name.')
                process.exit(1)
            } else if (!(
                module.transaction 
                || module.action 
                || module.always 
                || module.cluster
                || module.data
                || module.teardown
            )) {
                console.error('Migration', migration, 'did not export lifecycle function (transaction|action|always|cluster|data).')
                process.exit(1)
            }

            for ( 
                let { 
                    name: hook
                    , transaction
                    , always
                    , skip
                    , recordChange
                } of hookPhase
            ) {
                if(skip) {
                    continue;
                }

                let action;
                if ( transaction ) {
                    action = SQL => SQL.begin( sql => {
                        sql.pgmg = u
                        sql.raw = Raw(sql)
                        sql.raw.pgmg = u
                        return module.transaction(sql)
                    })
                } else {
                    action = migration[hook]
                }

                const [found] = always
                    ? [true] 
                    : await app.realSQL`
                        select * 
                        from pgmg.migration M
                        inner join pgmg.migration_hook H using(migration_id)
                        where (name, hook) = (${module.name}, ${hook})
                    `

                let description = module.description 
                    ? module.description.split('\n').map( x => x.trim() ).filter(Boolean).join('\n') 
                    : null

                if (!found && action){
                    try {
                        console.log('Running migration', migration)
                        await action(app.sql)

                        if ( !argv.dev && recordChange ) {
                            await app.sql`
                                insert into pgmg.migration(name, filename, description) 
                                values (${module.name}, ${migration}, ${description})
                                on conflict (migration_id) do nothing;
                            `
                            await app.sql`
                                insert into pgmg.migration_hook(hook, migration_id)
                                select migration_id, ${hook} from pgmg.migration
                                where (name, filename, description) = (${module.name}, ${migration}, ${description})
                                on conflict (migration_id) do nothing;
                            `
                        }
                        console.log('Migration complete')
                        
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
        Object.assign(url, { pathname: '' })+''

    const clusterSQL = postgres(clusterURL, config)

    for ( let { name: restorePhase, skip, hooks: hookPhases } of order ) {
        if (skip) {
            continue;
        }

        if (restorePhase == 'dropCreate' ) {
            await clusterSQL`drop database if exists ${dbName}`
            await clusterSQL`create database if exists ${dbName}`
        } else if ( restorePhase == 'restore' ) {
            await $ `pg_restore --verbose --clean --no-acl --no-owner -d ${clusterURL} ${argv.restore}`
            break;
        }

        for( let hookPhase of hookPhases ) {
            await doHookPhase(hookPhase)
        }
    }

    await app.realSQL.end()
}


main()
.catch( 
    e => {
        console.error(e)
        process.exit(1)
    }
)
