/* globals console */

export default function dryPostgres(realSQL){
    
    function sql(strings, ...args){
        if( strings.raw ) {
            console.log(String.raw(strings, ...args.map( x => `'${x}'`))+';')
            return Promise.resolve([])
        }
        return realSQL(strings, ...args)
    }

    function unsafe(string){
        if( string.raw ) {
            console.log(string[0]+';')
        } else {
            console.log(string+';')
        }
        return Promise.resolve([])
    }

    function begin(f){
        return f(sql)
    }

    async function end(){}

    sql.begin = begin
    sql.unsafe = unsafe
    sql.end = end

    return sql
}