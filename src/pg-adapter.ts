import pg, { PoolConfig, Pool as IPool } from 'pg';
import format from 'pg-format';

const { Pool } = pg;

/*
    The dataformat is as follows:
        id: SERIAL PRIMARY KEY,
        docName: TEXT,
        value: BYTEA,
        version: ENUM ('v1', 'v1_sv')
    The id is used to identify the order of the updates.

    The docName is used to identify the different documents.

    The actual updates to the y-docs are stored in Binary format
    in the value field.

    The version is used to be able to update this library in the
    future in a way that is backwards compatible.
    Also the version is used to distinguish between the document
    and the state vector.
*/

type Update = {
	id: number;
	docname: string;
	value: Uint8Array;
	version: 'v1';
};

export class PgAdapter {
	private tableName: string;
	private pool: IPool;

	constructor(tableName: string, pool: IPool) {
		this.tableName = tableName;
		this.pool = pool;
	}

	/**
	 * Create a PostgresqlAdapter instance
	 * @param connectionOptions
	 * @param param1
	 * @param param1.tableName Name of the table where all documents are stored
	 * @param param1.useIndex Whether to use an index for the table
	 * @returns
	 */
	static async connect(
		connectionOptions: PoolConfig,
		{ tableName, useIndex }: { tableName: string; useIndex: boolean },
	) {
		const pool = new Pool(connectionOptions);
		await pool.query('SELECT 1+1;');

		// Create table if it does not exist
		const tableExistsRes = await pool.query(
			`SELECT EXISTS (
                SELECT FROM pg_tables
                WHERE schemaname = 'public'
                AND tablename  = $1
            );`,
			[tableName],
		);
		const tableExists = tableExistsRes.rows[0].exists;

		if (!tableExists) {
			await pool.query(`
			DO $$
			BEGIN
				IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ypga_version') THEN
					CREATE TYPE ypga_version AS ENUM ('v1', 'v1_sv');
				END IF;
			END
			$$;
			`);

			await pool.query(
				format(
					`
                CREATE TABLE %I (
                    id SERIAL PRIMARY KEY,
                    docname TEXT NOT NULL,
                    value BYTEA NOT NULL,
                    version ypga_version NOT NULL
                );`,
					tableName,
				),
			);
		}

		// Create index on docName if it does not exist
		if (useIndex) {
			const indexDocNameExistsRes = await pool.query(
				`SELECT EXISTS (
                    SELECT FROM pg_indexes
                    WHERE tablename = $1
                    AND indexname = $1_docname_idx
                );`,
				[tableName],
			);
			const indexDocNameExists = indexDocNameExistsRes.rows[0].exists;

			if (!indexDocNameExists) {
				await pool.query(
					format(
						`
                CREATE INDEX %I_docname_idx ON %I (docname);`,
						tableName,
						tableName,
					),
				);
			}
		}

		return new PgAdapter(tableName, pool);
	}

	/**
	 * Find the latest document id in the table. Returns -1 if no document is found.
	 * @param docName
	 * @returns
	 */
	async findLatestDocumentId(docName: string) {
		const query = format(
			`
            SELECT id FROM %I
            WHERE docname = %L
            ORDER BY id DESC
            LIMIT 1;`,
			this.tableName,
			docName,
		);
		const res = await this.pool.query(query);
		return res.rows[0]?.id ?? -1;
	}

	/**
	 * Store one update in PostgreSQL.
	 * @returns {Promise<object>} The stored document
	 */
	async insertUpdate(docName: string, value: Uint8Array) {
		const bufferValue = Buffer.from(value);
		const query = format(
			`
            INSERT INTO %I (docname, value, version)
            VALUES (%L, %L, 'v1')
            RETURNING *;`,
			this.tableName,
			docName,
			bufferValue,
		);
		const res = await this.pool.query(query);
		return res.rows[0];
	}

	private async _getStateVector(docName: string) {
		const query = format(
			`
			SELECT value FROM %I
			WHERE docname = %L
			AND version = 'v1_sv'
			LIMIT 1;`,
			this.tableName,
			docName,
		);
		const res = await this.pool.query(query);
		return res.rows[0];
	}

	/**
	 * Get the state vector of a document in PostgreSQL.
	 * @param docName
	 * @returns
	 */
	async getStateVectorBuffer(docName: string) {
		const res = await this._getStateVector(docName);
		return res?.value as Uint8Array | null;
	}

	/**
	 * Upsert the statevector for one document in PostgreSQL.
	 * @param docName
	 * @param value
	 */
	async putStateVector(docName: string, value: Uint8Array) {
		const bufferValue = Buffer.from(value);

		// Get state vector to check if it exists
		const sv = await this._getStateVector(docName);

		let query;
		if (sv) {
			query = format(
				`
				UPDATE %I
				SET value = %L
				WHERE id = %L
				RETURNING *;`,
				this.tableName,
				bufferValue,
				sv.id,
			);
		} else {
			query = format(
				`
				INSERT INTO %I (docname, value, version)
				VALUES (%L, %L, 'v1_sv')
				RETURNING *;`,
				this.tableName,
				docName,
				bufferValue,
			);
		}

		const res = await this.pool.query(query);
		return res.rows[0];
	}

	/**
	 * Delete all updates of one document in a specific range.
	 * @param docName
	 * @param from Including this id
	 * @param to Excluding this id
	 */
	async clearUpdatesRange(docName: string, from: number, to: number) {
		const query = format(
			`
            DELETE FROM %I
            WHERE docname = %L
			AND version = 'v1'
            AND id >= %L
            AND id < %L;`,
			this.tableName,
			docName,
			from,
			to,
		);
		await this.pool.query(query);
	}

	/**
	 * Get all document updates for a specific document as a cursor.
	 */
	async readUpdatesAsCursor(docName: string, callback: (records: Update[]) => void) {
		let offset = 0;
		const limit = 100;
		let rowsCount = 0;
		let rows = [];

		do {
			const query = format(
				`
            SELECT * FROM %I
            WHERE docname = %L
            AND version = 'v1'
            ORDER BY id
            LIMIT %L OFFSET %L;`,
				this.tableName,
				docName,
				limit,
				offset,
			);

			// eslint-disable-next-line no-await-in-loop
			const res = await this.pool.query(query);
			rows = res.rows;

			rowsCount += rows.length;
			callback(rows);

			offset += limit;
		} while (rows.length === limit);

		return rowsCount;
	}

	/**
	 * Delete a document, and all associated data from the database.
	 */
	async deleteDocument(docName: string) {
		const query = format(
			`
                DELETE FROM %I
                WHERE docname = %L
                RETURNING *;`,
			this.tableName,
			docName,
		);
		const res = await this.pool.query(query);
		return res.rows[0];
	}

	/**
	 * Close the connection to the database.
	 */
	async close() {
		await this.pool.end();
	}
}
