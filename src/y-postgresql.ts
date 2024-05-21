import { PoolConfig } from 'pg';
import * as Y from 'yjs';
import { PgAdapter } from './pg-adapter';
import {
	flushDocument,
	getCurrentUpdateClock,
	getYDocFromDb,
	readStateVector,
	storeUpdate,
} from './utils';
/*
    Note on performance:
    - For now I will use one table for all documents
    - I will allow the user to use an index on docName for this table as option
        - This might slow down the write operations but will speed up the read operations
        - The user can decide if they want to use an index or not
    - The flushDocument method will reduce the number of records regularly and
    therefore I think the performance will be good enough
    - In the future I can add a feature to create a new table for each document
        - maybe even a new schema for each document
*/

const DEFAULT_FLUSH_SIZE = 200;
const DEFAULT_TABLE_NAME = 'yjs-writings';
const DEFAULT_USE_INDEX = false;

interface PostgresqlPersistenceOptions {
	/**
	 * The number of stored transactions per yjs-document
	 * needed until they are merged automatically into
	 * one record.
	 * Default is 200.
	 */
	flushSize?: number;

	/**
	 * Whether to use an index for the table.
	 * This can slow down write operations but speed up read operations.
	 * Default is false.
	 */
	useIndex?: boolean;

	/**
	 * The name of the table to use for storing documents.
	 * Default is "yjs-writings"
	 */
	tableName?: string;
}

export class PostgresqlPersistence {
	private flushSize: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private tr: { [docName: string]: Promise<any> };
	private _transact: <T>(docName: string, f: (db: PgAdapter) => Promise<T>) => Promise<T>;

	constructor(flushSize: number, db: PgAdapter) {
		this.flushSize = flushSize;

		// scope the queue of the transaction to each docName
		// -> this should allow concurrency for different rooms
		// Idea and adjusted code from: https://github.com/fadiquader/y-mongodb/issues/10
		this.tr = {};

		/**
		 * Execute a transaction on a database. This will ensure that other processes are
		 * currently not writing.
		 *
		 * This is a private method and might change in the future.
		 *
		 * @template T
		 *
		 * @param {function(any):Promise<T>} f A transaction that receives the pool object
		 * @return {Promise<T>}
		 */
		this._transact = <T>(docName: string, f: (dbAdapter: PgAdapter) => Promise<T>): Promise<T> => {
			if (!this.tr[docName]) {
				this.tr[docName] = Promise.resolve();
			}

			const currTr = this.tr[docName];
			let nextTr: Promise<T | null> | null = null;

			nextTr = (async () => {
				await currTr;

				let res: T | null = null;
				try {
					res = await f(db);
				} catch (err) {
					// eslint-disable-next-line no-console
					console.warn('Error during saving transaction', err);
				}

				// once the last transaction for a given docName resolves, remove it from the queue
				if (this.tr[docName] === nextTr) {
					delete this.tr[docName];
				}

				return res;
			})();

			this.tr[docName] = nextTr;

			return this.tr[docName];
		};
	}

	static async build(
		connectionOptions: PoolConfig,
		postgresqlPersistenceOptions: PostgresqlPersistenceOptions = {},
	) {
		const {
			flushSize = DEFAULT_FLUSH_SIZE,
			useIndex = DEFAULT_USE_INDEX,
			tableName = DEFAULT_TABLE_NAME,
		} = postgresqlPersistenceOptions;

		if (typeof tableName !== 'string' || !tableName) {
			throw new Error(
				'Constructor option "tableName" is not a valid string. Either dont use this option (default is "yjs-writings") or use a valid string! Take a look into the Readme for more information: https://github.com/MaxNoetzold/y-mongodb-provider#persistence--mongodbpersistenceconnectionlink-string-options-object',
			);
		}
		if (typeof useIndex !== 'boolean') {
			throw new Error(
				'Constructor option "useIndex" is not a boolean. Either dont use this option (default is "false") or use a valid boolean! Take a look into the Readme for more information: https://github.com/MaxNoetzold/y-mongodb-provider#persistence--mongodbpersistenceconnectionlink-string-options-object',
			);
		}
		if (typeof flushSize !== 'number' || flushSize <= 0) {
			throw new Error(
				'Constructor option "flushSize" is not a valid number. Either dont use this option (default is "200") or use a valid number larger than 0! Take a look into the Readme for more information: https://github.com/MaxNoetzold/y-mongodb-provider#persistence--mongodbpersistenceconnectionlink-string-options-object',
			);
		}

		const db = await PgAdapter.connect(connectionOptions, { tableName, useIndex });

		return new PostgresqlPersistence(flushSize, db);
	}

	/**
	 * Create a Y.Doc instance with the data persistet in PostgreSQL.
	 * Use this to temporarily create a Yjs document to sync changes or extract data.
	 *
	 * @param {string} docName
	 * @return {Promise<Y.Doc>}
	 */
	getYDoc(docName: string) {
		return this._transact(docName, async (db) => {
			return getYDocFromDb(db, docName, this.flushSize);
		});
	}

	/**
	 * Store a single document update to the database.
	 *
	 * @param {string} docName
	 * @param {Uint8Array} update
	 * @return {Promise<number>} Returns the oid of the stored update
	 */
	storeUpdate(docName: string, update: Uint8Array) {
		return this._transact(docName, (db) => storeUpdate(db, docName, update));
	}

	/**
	 * The state vector (describing the state of the persisted document
	 * (see https://github.com/yjs/yjs#Document-Updates for more infos)) is maintained
	 * in a separate field and constantly updated.
	 *
	 * This allows you to sync changes without actually creating a Yjs document.
	 *
	 * @param {string} docName
	 * @return {Promise<Uint8Array>}
	 */
	getStateVector(docName: string) {
		return this._transact(docName, async (db) => {
			const { clock, sv } = await readStateVector(db, docName);
			let curClock = -1;
			if (sv !== null) {
				curClock = await getCurrentUpdateClock(db, docName);
			}
			if (sv !== null && clock === curClock) {
				return sv;
			} else {
				// current state vector is outdated
				const ydoc = await getYDocFromDb(db, docName, this.flushSize);
				const newSv = Y.encodeStateVector(ydoc);
				await flushDocument(db, docName, Y.encodeStateAsUpdate(ydoc), newSv);
				return newSv;
			}
		});
	}

	/**
	 * Get the differences directly from the database.
	 * The same as Y.encodeStateAsUpdate(ydoc, stateVector).
	 * @param {string} docName
	 * @param {Uint8Array} stateVector
	 */
	async getDiff(docName: string, stateVector: Uint8Array) {
		const ydoc = await this.getYDoc(docName);
		return Y.encodeStateAsUpdate(ydoc, stateVector);
	}

	/**
	 * Delete a document, and all associated data from the database.
	 * @param {string} docName
	 * @return {Promise<void>}
	 */
	clearDocument(docName: string) {
		return this._transact(docName, async (db) => db.deleteDocument(docName));
	}

	/**
	 * Cleans up the database connection.
	 */
	destroy() {
		return this._transact('global', async (db) => {
			await db.close();
		});
	}
}
