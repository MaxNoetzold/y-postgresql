# PostgreSQL database adapter for [Yjs](https://github.com/yjs/yjs)

Persistent PostgreSQL storage for a [y-websocket](https://github.com/yjs/y-websocket) server. You can use this adapter to easily store and retrieve Yjs documents in/from PostgreSQL.

### Notes:

- This package is not officially supported by the Yjs team.

## Use it (Installation)

You need Node version 16 or newer.

It is available at [npm](https://www.npmjs.com/package/y-postgresql).

```sh
npm i y-postgresql
```

#### Simple Server Example

There are full working server examples in the `example-servers` directory.

```ts
import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { setPersistence, setupWSConnection } from './websocket/utils.js';
import { IWSSharedDoc } from './websocket/interfaces.js';
import { PostgresqlPersistence } from 'y-postgresql';

const server = http.createServer((request, response) => {
	response.writeHead(200, { 'Content-Type': 'text/plain' });
	response.end('okay');
});

// y-websocket
const wss = new WebSocketServer({ server });
wss.on('connection', yUtils.setupWSConnection);

/*
 * y-postgresql
 * with all available options. Check API below for more infos.
 */
const pgdb = await PostgresqlPersistence.build(
	{
		host: process.env.PG_HOST,
		port: parseInt(process.env.PG_PORT, 10),
		database: process.env.PG_DATABASE,
		user: process.env.PG_USER,
		password: process.env.PG_PASSWORD,
	},
	{ tableName: 'yjs-writings', useIndex: false, flushSize: 200 },
);

/*
 Persistence must have the following signature:
{ bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise }
*/
yUtils.setPersistence({
	bindState: async (docName, ydoc) => {
		// Here you listen to granular document updates and store them in the database
		// You don't have to do this, but it ensures that you don't lose content when the server crashes
		// See https://github.com/yjs/yjs#Document-Updates for documentation on how to encode
		// document updates

		// official default code from: https://github.com/yjs/y-websocket/blob/37887badc1f00326855a29fc6b9197745866c3aa/bin/utils.js#L36
		const persistedYdoc = await pgdb.getYDoc(docName);
		const newUpdates = Y.encodeStateAsUpdate(ydoc);
		pgdb.storeUpdate(docName, newUpdates);
		Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
		ydoc.on('update', async (update: Uint8Array) => {
			pgdb.storeUpdate(docName, update);
		});
	},
	writeState: async (docName, ydoc) => {
		// This is called when all connections to the document are closed.
		// In the future, this method might also be called in intervals or after a certain number of updates.
		return new Promise((resolve) => {
			// When the returned Promise resolves, the document will be destroyed.
			// So make sure that the document really has been written to the database.
			resolve();
		});
	},
});

server.listen(process.env.PORT, () => {
	console.log(`listening on port:${process.env.PORT}`);
});
```

## API

### `persistence = await PostgresqlPersistence.build(connectionOptions: pg.PoolConfig, persistenceOptions: object)`

Create a y-postgresql persistence instance.

```js
import { PostgresqlPersistence } from 'y-postgresql';

const pgdb = await PostgresqlPersistence.build(connectionOptions, {
	tableName: 'yjs-writings',
	useIndex: false,
	flushSize: 200,
});
```

Options:

- tableName
  - The name of the table to use for storing documents.
  - Default: `"yjs-writings"`
- flushSize
  - The number of transactions needed until they are merged automatically into one document
  - Default: `200`
- useIndex
  - Whether to use an index for the table (on docname property).
  - This can slow down write operations but speed up read operations..
  - Default: `false`

#### `persistence.getYDoc(docName: string): Promise<Y.Doc>`

Create a Y.Doc instance with the data persistet in PostgreSQL. Use this to temporarily create a Yjs document to sync changes or extract data.

#### `persistence.storeUpdate(docName: string, update: Uint8Array): Promise<number>`

Store a single document update to the database. It returns the id of the stored update.

#### `persistence.getStateVector(docName: string): Promise<Uint8Array>`

The state vector (describing the state of the persisted document - see
[Yjs docs](https://github.com/yjs/yjs#Document-Updates)) is maintained in a separate
field and constantly updated.

This allows you to sync changes without actually creating a Yjs document.

Performance Note: The state vector in the database is frequently outdated, leading to its recreation within this function. This process requires the creation of the Yjs document, which often makes it no more efficient than simply loading the entire document.

#### `persistence.getDiff(docName: string, stateVector: Uint8Array): Promise<Uint8Array>`

Get the differences directly from the database. The same as
`Y.encodeStateAsUpdate(ydoc, stateVector)`.

Note on performance: This function first loads the full document behind "docName".

#### `persistence.clearDocument(docName: string): Promise`

Delete a document, and all associated data from the database.

#### `persistence.destroy(): Promise`

Close the database connection for a clean exit.

## Contributing

We welcome contributions! Please follow these steps to contribute:

1. Fork the repository.
2. Set up your development environment: `npm install`.
3. Make your changes and ensure tests pass: `npm test`.
4. Submit a pull request with your changes.

## Testing

To run the test suite, you first need to copy the `EXAMPLE_TEST.env`, rename it to `.env` and fill in the connection options for the PostgreSQL database. Then run the following command:

```sh
npm test
```

## License

y-postgresql is licensed under the [MIT License](./LICENSE).

<max.noetzold@gmail.com>
