export function triggerChange(sql, { table, column, expression, security='invoker' }){
    let TG_NAME = `${table}_${column}`
    let FN_NAME = `${table}_${column}`
    sql = String.raw

    const out = sql`
        create or replace function ${FN_NAME}() returns trigger as $$
        begin
            ${expression};
            return NEW;
        end;
        $$ language plpgsql security ${security} set search_path = '';

        create trigger ${TG_NAME}_update
        before update on ${table}
        for each row
        execute function ${FN_NAME}();

        create trigger ${TG_NAME}_insert
        before insert on ${table}
        for each row
        execute function ${FN_NAME}();
    `

    return out
}