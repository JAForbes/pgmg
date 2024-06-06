

/* globals process, console, URL */
/* eslint-disable operator-linebreak */
/* eslint-disable max-depth */
// prettier-ignore

import postgres from 'postgres'
import fs from 'fs/promises'
import { glob } from 'zx'
import * as P from 'node:path'
import os from 'node:os'

// so we can more easily infer if a feature was available when a migration ran
// update this number any time we add/remove some feature
export const revision = 3;

export async function createRole(sql, { name, password=null, with:_with=null }={}){
	const [found] = await sql`
		select rolname
		from pg_catalog.pg_roles
		where rolname = ${name};
	`

	if (found) {
		return
	}

	await sql`create role${sql(name)}${password || _with ? sql` with` : sql``}${password ? sql` login password '${sql.unsafe(password)}'` : sql``}${_with ? sql.unsafe(' ' + _with) : sql``}`
}

export async function createRoleFromUrl(sql, url, { with: _with }={}) {
	const { username, password } = new URL(url)
	return createRole(sql, { name: username, password }, { with: _with })
}

export async function dropRole(sql, { name, ownedBy=false, cascade=false }){
	const [found] = await sql`
		select rolname
		from pg_catalog.pg_roles
		where rolname = ${name};
	`;
	if (found) {
		if (ownedBy) {
			await sql.unsafe(`drop owned by ${name} cascade`);
		}
		if (cascade) {
			await sql.unsafe(`drop role ${name}`);
		}
	}
}

export async function main(argv) {
	const migration_start_time = new Date()
	const debugLog = argv.debug ? console.log.bind(console, 'DEBUG:') : () => {}

	function slugify(s) {
		return s.split("\n").join("").trim().toLowerCase().replace(/\-|\s/g, "_");
	}

	debugLog("starting main function");

	let [connectionString] = argv._;

	let { dry = false, "health-check-file": healthCheckFile } = argv;

	let app = {
		async resetConnection(config = {}) {
			debugLog("resetting connection");
			// Why:
			// https://github.com/JAForbes/pgmg/issues/17

			if (clusterSQL) {
				debugLog("ending cluster sql connection");
				await clusterSQL.end();
				debugLog("ended cluster sql connection");
				clusterSQL = postgres(clusterURL, {
					...config
					,onnotice: console.error,
				});
			}
			if (app.sql) {
				debugLog("ending app sql");
				await app.sql.end();
				debugLog("ended app sql");
			}

			app.sql = RealSQL(config);
			await app.sql`set search_path = ''`;
		},
	};

	function onnotice(...args) {
		if (app.sql.onnotice) {
			app.sql.onnotice(...args);
		} else {
			if (args[0].severity == "NOTICE" && !argv.debug) return;
			console.log(...args);
		}
	}

	const pg = [connectionString, { onnotice, max: 1, prepare: false }];

	const RealSQL = (config = {}) => {
		debugLog("starting postgres instance with", { ...pg[1], ...config });
		return postgres(pg[0], { ...pg[1], ...config })
	};

	debugLog("searching for migration files");
	let migrations = await Promise.all(
		argv._.filter((x) => x.endsWith(".js") || x.endsWith(".mjs")).map((x) =>
			glob(x)
		)
	).then((x) => x.flat());
	debugLog("migration files retrieved");

	async function teardown_pgmg_objects(sql, { migration_user, service_user }) {
		debugLog("tearing down pgmg objects", { migration_user, service_user });

		for (let target of [migration_user, service_user]) {
			await dropRole(sql, { name: target, ownedBy: true, cascade: true })
		}
	}

	async function create_pgmg_objects(sql, { migration_user, service_user }) {
		debugLog("creating pgmg objects", { migration_user, service_user });
		for (let target of [migration_user, service_user]) {
			debugLog("searching for user to create", target);

			if (target === migration_user) {
				await createRole(sql, { name: target, with: 'superuser nologin'})
			} else if (target === service_user) {
				await createRole(sql, { name: target, with: 'noinherit nologin nocreatedb nocreaterole nosuperuser noreplication nobypassrls'})
			}
		}
	}

	const [dbUrl, config] = pg;
	const url = new URL(dbUrl);
	const clusterURL = Object.assign(new URL(url), { pathname: "" }) + "";

	debugLog("starting cluster sql with", { ...config, onnotice: console.error });
	let clusterSQL = 
		postgres(clusterURL, { ...config, onnotice: console.error })
	debugLog("started cluster sql with", { ...config, onnotice: console.error });

	
	if (healthCheckFile) {
		debugLog("removing health check file", {
			healthCheckFile
		});
		await fs
			.rm(healthCheckFile, { encoding: "utf-8", recursive: true })
			.catch(() => {});
		debugLog("removed health check file", {
			healthCheckFile
		});
	}
	debugLog("sequence loop > resetting connection", {
		healthCheckFile
	});
	await app.resetConnection();
	debugLog("sequence loop > resetted connection", {
		healthCheckFile
	});

	debugLog("creating extensions and main migration table if not exists", {
		healthCheckFile
	});
	await app.sql.unsafe`
		set search_path = 'public';
		create extension if not exists pgcrypto;
		create schema if not exists pgmg;
		create table if not exists pgmg.migration (
			migration_id uuid primary key default public.gen_random_uuid()
			, name text not null unique
			, filename text not null
			, description text null
			, created_at timestamptz not null default now()
		)
		;

		create table if not exists pgmg.migration_hook (
			hook text not null
			, name text not null references pgmg.migration(name) on delete cascade
			, created_at timestamptz not null default now()
			, dev boolean not null default false
			, hostname text not null
			, revision int not null
			, primary key (name, hook)
		);
	`;

	debugLog("created main tables", {
		healthCheckFile
	});

	debugLog("entering main sequence loop");
	for (let hook of [
		{ name: "teardown", skip: !argv.dev, ifExists: true }
		,{
			name: "pre"
			,skip: false
			,rememberChange: true
			,always: true,
		}
		,{ name: "action", skip: false, rememberChange: true }
		,{
			name: "post"
			,skip: false
			,rememberChange: true
			,always: true,
		}
	]) {
		
		let {
			name,
			always,
			skip,
			rememberChange,
			ifExists
		} = hook

		debugLog("entered main sequence loop", {
			hook: name
			,skip: hook.skip
		});

		if (hook.skip) {
			debugLog("skipping", { hook: name, skip: hook.skip });
			continue;
		}

		for (let migration of migrations) {
			debugLog("importing module", migration);
			let rawModule = await import(P.resolve(process.cwd(), migration));
			debugLog("imported module", migration);

			if (!rawModule.name) {
				console.error("Migration", migration, "did not export a name.");
				process.exit(1);
			} else if (
				!(
					rawModule.action
					|| rawModule.pre
					|| rawModule.post
					|| rawModule.teardown
				)
			) {
				console.error(
					"Migration",
					migration,
					"did not export lifecycle function (action|pre|post|teardown)."
				);
				process.exit(1);
			}

			const module = {
				...rawModule
				,async teardown(...args) {
					if (argv.dev) {
						await teardown_pgmg_objects(args[0], {
							migration_user
							,service_user,
						});
						await rawModule.teardown?.(...args);
					}
				}
				,async pre(...args) {
					await create_pgmg_objects(args[0], {
						migration_user
						,service_user,
					});

					if (rawModule.pre) {
						console.log("pre::" + rawModule.name);
						const sql = args[0]
						await sql`set role ${sql(migration_user)}`
						await rawModule.pre?.(...args);
					}
				}
			}

			const name_slug = slugify(module.name);
			const migration_user = "pgmg_migration_" + name_slug;
			const service_user = "pgmg_service_" + name_slug;

			const roles = { migration: migration_user, service: service_user };

			debugLog("entering hook phase loop");
			
			{
				
				debugLog("entered hook phase loop", {
					hook: name
					,always
					,skip
					,rememberChange
					,ifExists
				});
				if (skip) {
					debugLog("skipping", {
						hook: name
						,always
						,skip
						,rememberChange
						,ifExists
					});
					continue;
				}

				let action;
				action = module[name];

				debugLog("searching for any migration", module.name, {
					hook: name
					,always
					,skip
					,rememberChange
					,ifExists
				});
				const [anyMigrationFound] = await app.sql`
					select migration_id, *
					from pgmg.migration
					where name = ${module.name}
				`;
				debugLog(
					"any migration search result",
					module.name,
					anyMigrationFound,
					{ hook: name, always, skip, rememberChange, ifExists }
				);

				debugLog("search for migration hooks", module.name, anyMigrationFound, {
					hook: name
					,always
					,skip
					,rememberChange
					,ifExists
				});
				const [{ hooks_count }] = await app.sql`
					select count(*) as hooks_count
					from pgmg.migration_hook
					where name = ${module.name}
					AND created_at < ${migration_start_time}
				`;
				debugLog("search for migration hooks", module.name, hooks_count, {
					hook: name
					,always
					,skip
					,rememberChange
					,ifExists
				});

				debugLog("searching for specific migration", module.name, {
					hook: name
					,always
					,skip
					,rememberChange
					,ifExists
					,hooks_count,
				});
				const [found] = always
					? [{}]
					: await app.sql`
						select
							M.migration_id, H.dev, H.hostname
						from pgmg.migration M
						inner join pgmg.migration_hook H using(name)
						where (name, hook) = (${module.name}, ${name})
						;
					`;
				debugLog("search for specific migration", module.name, {
					found
					,hook: name
					,always
					,skip
					,rememberChange
					,ifExists
					,hooks_count
				});

				debugLog("search for dev hook", module.name, {
					found
					,hook: name
					,always
					,skip
					,rememberChange
					,ifExists
					,hooks_count
				});
				const [anyDevHookFound] = always
					? [{}]
					: // either match on hook for new migrations
						// or for old migrations just match on name
						await app.sql`
							select M.migration_id, H.dev, H.hostname
							from pgmg.migration M
							inner join pgmg.migration_hook H using(name)
							where (name, dev) = (${module.name}, true)
						`;
				debugLog("search for dev hook", module.name, {
					anyDevHookFound
					,found
					,hook: name
					,always
					,skip
					,rememberChange
					,ifExists
					,hooks_count,
				});

				let description = module.description
					? module.description
						.split("\n")
						.map((x) => x.trim())
						.filter(Boolean)
						.join("\n")
					: null;

				const shouldContinue =
					action
					// never ran before
					&& (!found && !ifExists
						// ran before in dev mode and we are in dev mode again
						// skip migrations with no teardown
						|| found
							&& found.dev
							&& argv.dev
							&& module.teardown
							&& module.dev !== false
						// run if any migration exists, for teardown
						|| ifExists
							&& anyMigrationFound
							&& anyDevHookFound
							&& module.dev !== false
						// or it is a cluster hook that has run before but
						// we have no trace of a cluster user so it hasn't
						// run on this machine
						|| always && action);

				debugLog(module.name, name, {
					shouldContinue
					,action
					,found
					,ifExists
					,anyMigrationFound
					,anyDevHookFound
					,hook: name
					,always
					,hooks_count
				});

				runMigration: if (shouldContinue) {
					if (module.connection) {
						debugLog(
							"migration has custom connection options, resetting connection"
						);
						await app.resetConnection(module.connection);
						debugLog("connection reset");
					} else {
						debugLog("resetting role");
						await app.sql.unsafe(`reset role`);
						debugLog("role reset");
					}

					if (dry) {
						console.log(name + "::" + migration, "(dry)");
						break runMigration;
					}
					try {
						console.log(name + "::" + migration);
						debugLog("resetting role");
						await app.sql.unsafe(`reset role`);
						debugLog("role reset");
						if (
							!["pre", "teardown"].includes(name)
						) {
							debugLog("setting role", roles.migration);
							await app.sql.unsafe(`set role ${roles.migration}`);
							debugLog("set role", roles.migration);
						}
						debugLog("running action", module.name);
						await action(app.sql, { ...argv, roles });
						debugLog("action complete", module.name);
						debugLog("resetting role", module.name);
						await app.sql.unsafe(`reset role`);
						debugLog("role reset", module.name);

						if (rememberChange) {
							debugLog("recording change in main table", module.name);
							await app.sql`
								insert into pgmg.migration(name, filename, description)
								values (${module.name}, ${migration}, ${description})
								on conflict (name) do nothing;
							`;
							debugLog("recorded change in main table", module.name);
							debugLog("recorded hook in hooks table", module.name, name);
							await app.sql`
								insert into pgmg.migration_hook(
									hook, name, dev, hostname, revision
								)
								values (
									${name}
									, ${module.name}
									, ${!!argv.dev}
									, ${os.hostname()}
									, ${revision}
								)
								on conflict (hook, name) do nothing;
							`;
							debugLog("recorded hook in hooks table", module.name, name);
						}
					} catch (e) {
						console.error("Migration failed");
						console.error(e);
						process.exit(1);
					}
				
				}
			}
		}
	}

	debugLog("exiting app sql connection");
	await app.sql.end();
	debugLog("exited app sql connection");
	debugLog("exiting cluster sql connection");
	await clusterSQL.end();
	debugLog("exited cluster sql connection");

	console.log("Migration complete");
	if (healthCheckFile) {
		debugLog("health check creation");
		await fs.mkdir(P.dirname(healthCheckFile), { recursive: true });
		await fs
			.writeFile(healthCheckFile, "complete\n", { encoding: "utf-8" })
			.catch((err) => {
				console.error("Could not write to health check file");
				console.error(err);
			});
		debugLog("health check created");
	}
}

