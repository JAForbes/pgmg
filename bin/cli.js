#!/usr/bin/env node
/* globals process, console */
import { argv, chalk } from 'zx'
import * as M from 'module'

import { main } from '../lib/index.js'

// expose argv like zx
const pkg = M.createRequire(import.meta.url) ('../package.json')

const help =
`
Usage: pgmg (--dev|--prod) [CONNECTION] [OPTIONS] [FILES]

Version: ${pkg.version}

[PGMG OPTiONS]

--help      Logs this help message

--version   Logs the current pgmg version

--debug     Enables verbose debug logging

--v1        Required flag that will become optional soon after releasing v1.
            This let's us know you have read the migration guide and are aware
            that old migrations are not compatible with v1 and should be 
            moved / deleted from your normal migrations folder.

[CONNECTION]

Pass a postgres connection string (just like psql)

[FILES]

Any files passed as arguments after the connection string will be imported as JS migration files.

[OPTIONS]

The only way to specify a connection is via a pg connection URL.

╭――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――╮
│                                                                                          │
│               Note 0.x migration files are incompatible with pgmg@1.x                    │
│                                                                                          │
│                         Check the readme.md to upgrade safely                            │
│                                                                                          │
│                                                                                          │
╰――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――╯

--v1                        Prevents pgmg from warning you that 0.x migration files
                            are incompatible with 1.x.  Only pass this flag
                            after you have read and followed the migration guide
                            at https://github.com/JAForbes/pgmg


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

--dry                       Doesn't run any migrations, instead just prints out the migrations
                            that would run.  But does run initial setup scripts
                            to ensure pgmg tables are coherent.

--health-check-file <file>  Write to <file> when migration completes without error.
                            If in --dev mode this file will be deleted and recreated
                            for each migration.

                            This is designed to be used with docker healthchecks so
                            you can defer starting services or tests until after the
                            migration is complete.
`

const debugLog = argv.debug ? console.log.bind(console, 'DEBUG:') : () => {}

debugLog('debug logging enabled')

if( process.argv.length == 2 || argv.help ){
    debugLog('not enough args or help invoked')
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

if (!argv.v1) {
    console.error(chalk.red`pgmg@v1 has been released, but is not compatible with old 0.x migration files`)
    console.error(chalk.red``)
    console.error(chalk.red`Please read the migration guide at https://github.com/JAForbes/pgmg/blob/main/readme.md`)
    console.error(chalk.red``)
    console.error(chalk.red`When you have made the appropriate changes pass --v1 as an extra arg to pgmg and we will`)
    console.error(chalk.red`skip this warning and continue as normal.`)
    process.exit(1)
}

if (argv.version) {
    console.log(pkg.version);
    process.exit(0);
}

main(argv).catch((e) => {
    console.error(e);
    process.exit(1);
});