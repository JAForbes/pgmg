/* globals globalThis */
import process from 'node:process'
import assert from 'node:assert'
import { Buffer } from 'node:buffer'

const { crypto, TextDecoder } = globalThis

export const name = 'Connections'

export const description = `
	Now we have users and orgs, we want to be able to connect to 
	a database and see the migration tables.

	We need to safely record database url's and associate them with organizations.

	For now we assume the api can connect to the database directly.  It may be even
	in prod, this app would run locally as a desktop app, and connect to your
	instance via Wireguard / VPN / SSH.

	If it were to run in a web browser, things would get more complicated but maybe
	we could have the user install an agent on their infra that the apps servers
	can communicate with.

	For now let's keep it simple.
`


async function generateAesKey(length = 256) {
	const key = await crypto.subtle.generateKey(
		{
			name: "AES-CBC"
			,length
		},
		true,
		["encrypt", "decrypt"]
	);

	return key;
}

async function aesEncrypt(plaintext, key) {
	const ec = new globalThis.TextEncoder();
	const iv = crypto.getRandomValues(new Uint8Array(16));

	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-CBC"
			, iv
		},
		key,
		ec.encode(plaintext)
	);

	return {
		iv,
		ciphertext,
	};
}

async function aesDecrypt(ciphertext, key, iv) {
	const dec = new TextDecoder();
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-CBC"
			, iv
		},
		key,
		ciphertext
	);

	return dec.decode(plaintext);
}

export const action = async (sql) => {
	await sql`
		create table app.encrypted_value(
			encrypted_value_id uuid primary key default gen_random_uuid()
			, encrypted_value_hex text not null
			, encrypted_value_iv_hex text not null
			, algo text not null
			, key_sha256 text not null
			, value_sha256 text
			, key_format text not null -- jwk
			, created_at timestamptz default now()
		)
	`

	await sql`
		create table app.conn(
			conn_id uuid primary key default gen_random_uuid() 
			, host text
			, password uuid not null references app.encrypted_value(encrypted_value_id)
			, username text not null
			, port int not null
			, database text not null default 'postgres'
			, org text not null references app.org(org)
			, name text not null
			, tags text[] not null default '{}'
			, created_at timestamptz default now()
		)
	`

	const service_key_sha256 = 
		Buffer.from(await crypto.subtle.digest('SHA-256', new globalThis.TextEncoder('utf-8').encode(process.env.ENC_KEY_JWK))).toString('hex')

		

	{
		const key_sha256 = service_key_sha256

		// this is the jwk the services will have access to as well
		// (figure out rolling keys in a later migration)
		const jwk =  JSON.parse(process.env.ENC_KEY_JWK)
		const serviceEncryptionKey = await crypto.subtle.importKey('jwk', jwk, 'AES-CBC', jwk.ext, jwk.key_ops)
		
			// Each org gets their own encryption key, we export it so we can put it in the db
		const exportedOrgJWK = await crypto.subtle.exportKey('jwk', await generateAesKey())

		const value_sha256 = 
			Buffer.from(await crypto.subtle.digest('SHA-256', new globalThis.TextEncoder('utf-8').encode(
				JSON.stringify(exportedOrgJWK)
			))).toString('hex')

		// we encrypt it using the serviceEncryptionKey, which is only available at runtime to the services that need it
		const { iv, ciphertext } = await aesEncrypt(
			JSON.stringify(exportedOrgJWK), serviceEncryptionKey
		)

		// store the org key
		await sql`
			insert into app.encrypted_value
			${sql({
				// we made a jwk for the org, encrypted using the service jwk
				encrypted_value_hex: Buffer.from(ciphertext).toString('hex')
				,encrypted_value_iv_hex: Buffer.from(iv).toString('hex')
				,algo: 'AES-CBC'
				// so we know what key we need to decrypt it
				// we use the service jwk sha 
				,key_sha256
				,value_sha256
				,key_format: 'jwk'
			})}
		`

		
		const [input] = await sql`
			select * 
			from app.encrypted_value
			where key_sha256 = ${key_sha256}
		`
		const encrypted_value = Buffer.from(input.encrypted_value_hex, 'hex')
		const encrypted_value_iv = Buffer.from(input.encrypted_value_iv_hex, 'hex')

		// prove we can decrypt it
		const decrypted = await aesDecrypt(new Uint8Array(Buffer.from(encrypted_value, 'hex')), serviceEncryptionKey, new Uint8Array(Buffer.from(encrypted_value_iv, 'hex')))
		assert.equal(decrypted, JSON.stringify(exportedOrgJWK))
		
		{
			// import the key so we can import a database connection password with it
			const jwk = JSON.parse(decrypted)
			const org_key = await crypto.subtle.importKey('jwk', jwk, 'AES-CBC', jwk.ext, jwk.key_ops)

			// hardcode the password for this example, but this would come from the user
			const { iv, ciphertext } = await aesEncrypt('password', org_key)


			// hash the encryption key so we can know which encryption key decrypts the password
			const key_sha256 = 
				Buffer.from(await crypto.subtle.digest('SHA-256', new globalThis.TextEncoder('utf-8').encode(decrypted))).toString('hex')

			
			const value_sha256 = 
				Buffer.from(await crypto.subtle.digest('SHA-256', new globalThis.TextEncoder('utf-8').encode(
					'password'
				))).toString('hex')



			// store the encrypted password and link it to the new stored postgres connection
			await sql`
				with ev as (
					insert into app.encrypted_value
					${sql({
						// we made a jwk for the org, encrypted using the service jwk
						encrypted_value_hex: Buffer.from(ciphertext).toString('hex')
						,encrypted_value_iv_hex: Buffer.from(iv).toString('hex')
						,algo: 'AES-CBC'
						// so we know what key we need to decrypt it
						// we use the service jwk sha 
						,key_sha256
						,value_sha256
						,key_format: 'jwk'
					})}
					returning *
				)
				insert into app.conn(
					host
					, password
					, username
					, port
					, database
					, org
					, name
				)
				select 'postgres', encrypted_value_id, 'postgres', '5432', 'postgres', 'harth', 'localhost test db'
				from ev
			`
		}

		{
			// we grab the connection, the encryption metadata for the password
			// and the encryption metadata for org encryption key
			// this could be recursive later but just assuming two steps is probably fine
			const [conn] = await sql`
				select app.conn.*, to_json(EVP) as password_encryption_metadata, to_json(OV) as org_encryption_metadata
				from app.conn
				inner join app.encrypted_value EVP on password = encrypted_value_id
				inner join app.encrypted_value OV on EVP.key_sha256 = OV.value_sha256
					and OV.key_sha256 = ${service_key_sha256}
			`

			// now we want to decrypt the org key
			let org_key;
			{
				const input = conn.org_encryption_metadata
				const encrypted_value = Buffer.from(input.encrypted_value_hex, 'hex')
				const encrypted_value_iv = Buffer.from(input.encrypted_value_iv_hex, 'hex')
				const decrypted = await aesDecrypt(new Uint8Array(Buffer.from(encrypted_value, 'hex')), serviceEncryptionKey, new Uint8Array(Buffer.from(encrypted_value_iv, 'hex')))
				const jwk = JSON.parse(decrypted)
				org_key = await crypto.subtle.importKey('jwk', jwk, 'AES-CBC', jwk.ext, jwk.key_ops)
			}

			// and now the password via the org key
			let password;
			{
				const input = conn.password_encryption_metadata
				const encrypted_value = Buffer.from(input.encrypted_value_hex, 'hex')
				const encrypted_value_iv = Buffer.from(input.encrypted_value_iv_hex, 'hex')
				const decrypted = await aesDecrypt(new Uint8Array(Buffer.from(encrypted_value, 'hex')), org_key, new Uint8Array(Buffer.from(encrypted_value_iv, 'hex')))
				
				password = decrypted
			}

			// now build the connection string

			console.log(`postgres://${conn.username}:${password}@${conn.host}:${conn.port}/${conn.database}`)
		}
		
	}

}
