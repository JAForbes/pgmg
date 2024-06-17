import process from 'node:process'
import assert from 'node:assert'
import { createRoleFromUrl } from "pgmg"

export const name = 'Initial'

export const description = `
    The best way to ensure pgmg is well suited for an application development lifecycle
    is to bake a mini application into the migration tool itself.

    So we are making a little pgmg dashboard that lets you connect to a db instance
    and see which migrations have run.

    This is completely exploratory, it may be a demo app, it may be a thing we actually
    ship eventually.
`

export const action = async (sql) => {
    await createRoleFromUrl(sql, process.env.API_DB_URL)
    await sql`
        create schema app;
    `

    await sql`
        create table app.org(
            org text primary key
            , created_at timestamptz default now()
            , constraint ci check (org = lower(org))
            , admin text[] not null default '{}'
        )
    `

    await sql`
        create index idx_org_usr on app.org using gin (admin)
    `

    await sql`
        create table app.usr(
            usr text primary key
            , created_at timestamptz default now()
            , mail text
            , ph text
            ,  constraint ci_usr check (usr = lower(usr))
            ,  constraint ci_mail check (mail = lower(mail) and mail like '%@%')
            ,  constraint ci_ph check (ph = lower(ph))
        )
    `

    await sql`
        insert into app.usr(
            usr, mail
        )
        -- add your own base64 encoded email here if you like
        -- (not hard to decode but more effort for spammers)
        values (
            'jmsfbs', convert_from(decode('cGdtZ0BkZXYuam1zZmJzLmNvbQ==', 'base64'), 'UTF-8')
        )
    `

    await sql`
        insert into app.org(
            org, admin
        )
        values 
            ('harth', '{jmsfbs, eja}')
            , ('unrelated', '{example, cool}')
    `

    {
        const xs = await sql`
            select * 
            from app.usr 
            inner join app.org 
                on admin @> '{jmsfbs}';
        `

        assert.equal(xs.length, 1)
        assert.equal(xs[0].org, 'harth')
    }
}

export const dev = false