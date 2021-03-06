#!/usr/bin/env node

/* globals process, console */
import minimist from 'minimist'
import postgres from 'postgres'
import * as M from 'module'
import * as P from 'path'

import * as u from './utils.js'
import dryPostgres from './dryPostgres.js'

// expose argv like zx
const argv = minimist(process.argv.slice(2)) 

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
        `
    }

    const always = []

    const migrations = 
        argv._.filter( x => x.endsWith('.js') || x.endsWith('.mjs') )

    for ( let migration of migrations ) {
        // so SET EXAMPLE=on is reset per migration
        await app.resetConnection()

        let module = await import(P.resolve(process.cwd(), migration))
        if ( !module.name ) {
            console.error('Migration', migration, 'did not export a name.')
            process.exit(1)
        } else if (!(
            module.transaction 
            || module.action 
            || module.always 
        )) {
            console.error('Migration', migration, 'did not export a transaction or action function.')
            process.exit(1)
        }
        let action = 
            module.action 
            || module.transaction && (SQL => SQL.begin( sql => {
                sql.pgmg = u
                sql.raw = Raw(sql)
                sql.raw.pgmg = u
                return module.transaction(sql)
            }))

        if( module.always ) {
            always.push(module.always)
        }

        const [found] = await app.realSQL`
            select * from pgmg.migration where name = ${module.name}
        `
        
        let description = module.description ? module.description.split('\n').map( x => x.trim() ).filter(Boolean).join('\n') : null
        if (!found && action){
            try {
                console.log('Running migration', migration)
                await action(app.sql)
                console.log('Migration complete')
                await app.sql`
                    insert into pgmg.migration(name, filename, description) 
                    values (${module.name}, ${migration}, ${description})
                `
            } catch (e) {
                console.error('Migration failed')
                console.error(e)
                process.exit(1)
            }
        }
    }

    // always are migration hooks that always run
    // they run after the other migrations to guarantee
    // any checks you perform in always are against the changes made in the prior transactions
    // all always checks run within the same transaction
    
    if ( always.length ) {

        try {
            await app.sql.begin( async sql => {
                sql.pgmg = u
                sql.raw = Raw(sql)
                sql.raw.pgmg = u
                for( let f of always ) {
                    await f(sql)
                }
            })
        } catch (e) {
            console.error(e.line)
            throw e
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
