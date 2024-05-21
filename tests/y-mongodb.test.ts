import * as Y from 'yjs';
import pg, { Pool } from 'pg';
import format from 'pg-format';
import { PostgresqlPersistence } from '../src/y-postgresql';
import dotenv from 'dotenv';
import generateLargeText from './generateLargeText';
dotenv.config();

const connectionOptions = {
	host: process.env.PG_HOST,
	port: parseInt(`${process.env.PG_PORT}`),
	database: process.env.PG_DATABASE,
	user: process.env.PG_USER,
	password: process.env.PG_PASSWORD,
};

const storeDocWithText = async (
	pgPersistence: PostgresqlPersistence,
	docName: string,
	content: string,
) => {
	const ydoc = new Y.Doc();
	// to wait for the update to be stored in the database before we check
	const updatePromise = new Promise<void>((resolve) => {
		ydoc.on('update', async (update) => {
			await pgPersistence.storeUpdate(docName, update);
			resolve();
		});
	});

	const yText = ydoc.getText('name');
	yText.insert(0, content);

	// Wait for the update to be stored
	await updatePromise;
};

describe('store and retrieve updates', () => {
	let pool: Pool;
	let pgPersistence: PostgresqlPersistence;
	const tableName = 'yjs_writings_test';
	const docName = 'testDoc';
	const content = 'test';

	beforeAll(async () => {
		pool = new pg.Pool(connectionOptions);
		await pool.query(`SELECT 1+1;`);

		pgPersistence = await PostgresqlPersistence.build(connectionOptions, { tableName });
	});

	afterAll(async () => {
		await pool.query(format(`DROP TABLE %I`, tableName));
		await pool.end();
		await pgPersistence.destroy();
	});

	it('should store updates', async () => {
		await storeDocWithText(pgPersistence, docName, content);

		// Check that data is stored in the database
		const { rows } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName),
		);

		// it will be two because one is the stateVector and the other is the update
		expect(rows).toHaveLength(2);
	});

	it('should retrieve stored docs', async () => {
		const persistedYdoc = await pgPersistence.getYDoc(docName);

		const yText = persistedYdoc.getText('name');
		const yTextContent = yText.toString();

		expect(yTextContent).toEqual(content);
	});

	it('should store next update', async () => {
		const nextContent = 'NextTestText';

		await storeDocWithText(pgPersistence, docName, nextContent);

		const { rows } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName),
		);

		expect(rows).toHaveLength(3);
	});

	it("should flush document's updates and return state vector", async () => {
		const { rows } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName),
		);
		expect(rows).toHaveLength(3);

		const sv = await pgPersistence.getStateVector(docName);
		expect(sv).not.toBeNull();

		const { rows: rowsSecond } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName),
		);
		expect(rowsSecond).toHaveLength(2);
	});
});

describe('clearDocument with single collection', () => {
	let pool: Pool;
	let pgPersistence: PostgresqlPersistence;
	const tableName = 'yjs_writings_test';

	beforeAll(async () => {
		pool = new pg.Pool(connectionOptions);
		await pool.query(`SELECT 1+1;`);

		pgPersistence = await PostgresqlPersistence.build(connectionOptions, { tableName });
	});

	afterAll(async () => {
		await pool.query(format(`DROP TABLE %I`, tableName));
		await pool.end();
		await pgPersistence.destroy();
	});

	it('should clear document', async () => {
		const docName1 = 'testDoc1';

		/* 1. Store Data */
		await storeDocWithText(pgPersistence, docName1, 'blablabla');

		// Check that data is stored
		const { rows: rows1 } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName1),
		);
		expect(rows1).toHaveLength(2);

		/* 2. Clear data */
		await pgPersistence.clearDocument(docName1);

		// Check that data is cleared
		const { rows: rows12 } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName1),
		);
		expect(rows12).toHaveLength(0);
	});
});

describe('store multiple documents in single collection', () => {
	let pool: Pool;
	let pgPersistence: PostgresqlPersistence;
	const tableName = 'yjs_writings_test';
	const docName1 = 'testDoc1';
	const docName2 = 'testDoc2';
	const content1 = 'testOne';
	const content2 = 'testTwo';

	beforeAll(async () => {
		pool = new pg.Pool(connectionOptions);
		await pool.query(`SELECT 1+1;`);

		pgPersistence = await PostgresqlPersistence.build(connectionOptions, { tableName });
	});

	afterAll(async () => {
		await pool.query(format(`DROP TABLE %I`, tableName));
		await pool.end();
		await pgPersistence.destroy();
	});

	it('should store two docs', async () => {
		/* Store first doc */
		await storeDocWithText(pgPersistence, docName1, content1);
		const { rows: rows1 } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName1),
		);
		expect(rows1).toHaveLength(2);

		/* Store second doc */
		await storeDocWithText(pgPersistence, docName2, content2);
		const { rows: rows2 } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName2),
		);
		expect(rows2).toHaveLength(2);
	});

	it('should clear document one', async () => {
		await pgPersistence.clearDocument(docName1);

		const { rows: rows1 } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName1),
		);
		expect(rows1).toHaveLength(0);

		const { rows: rows2 } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName2),
		);
		expect(rows2).toHaveLength(2);
	});

	it('should clear document two', async () => {
		await pgPersistence.clearDocument(docName2);

		const { rows } = await pool.query(format(`SELECT * FROM %I`, tableName));
		expect(rows).toHaveLength(0);
	});
});

describe('store 40mb of data in single collection', () => {
	let pool: Pool;
	let pgPersistence: PostgresqlPersistence;
	const tableName = 'yjs_writings_test';
	const docName = 'testDoc';
	const content = generateLargeText(40);

	beforeAll(async () => {
		pool = new pg.Pool(connectionOptions);
		await pool.query(`SELECT 1+1;`);

		pgPersistence = await PostgresqlPersistence.build(connectionOptions, { tableName });
	});

	afterAll(async () => {
		await pool.query(format(`DROP TABLE %I`, tableName));
		await pool.end();
		await pgPersistence.destroy();
	});

	it('should store 40mb of text in three documents', async () => {
		await storeDocWithText(pgPersistence, docName, content);

		const { rows } = await pool.query(
			format(`SELECT * FROM %I WHERE docname = %L`, tableName, docName),
		);
		expect(rows).toHaveLength(2);
	});

	it("should retrieve the text of the stored document's updates", async () => {
		const persistedYdoc = await pgPersistence.getYDoc(docName);

		const yText = persistedYdoc.getText('name');
		const yTextContent = yText.toString();

		expect(yTextContent.length).toEqual(content.length);
	});

	it("should clear the document's updates", async () => {
		await pgPersistence.clearDocument(docName);

		const { rows } = await pool.query(format(`SELECT * FROM %I`, tableName));
		expect(rows).toHaveLength(0);
	});
});
