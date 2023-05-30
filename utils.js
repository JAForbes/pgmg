export async function triggerChange(sql, { table, column, expression, security='invoker' }){
    let TG_NAME = sql.unsafe(`${table}_${column}`)
    let FN_NAME = sql.unsafe(`${table}_${column}`)

    await sql`
        create or replace function ${FN_NAME}() returns trigger as $$
        begin
            ${sql.unsafe(expression)};
            return NEW;
        end;
        $$ language plpgsql security ${sql.unsafe(security)} set search_path = '';

    `

    await sql`
        create trigger ${TG_NAME}_update
        before update on ${sql.unsafe(table)}
        for each row
        execute function ${FN_NAME}();

    `

    await sql`
        create trigger ${TG_NAME}_insert
        before insert on ${sql.unsafe(table)}
        for each row
        execute function ${FN_NAME}();
    `
}