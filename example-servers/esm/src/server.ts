import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { setPersistence, setupWSConnection } from './websocket/utils.js';
import { PostgresqlPersistence } from 'y-postgresql';
import { IWSSharedDoc } from './websocket/interfaces.js';

const server = http.createServer((request, response) => {
	response.writeHead(200, { 'Content-Type': 'text/plain' });
	response.end('okay');
});

// y-websocket
const wss = new WebSocketServer({ server });
wss.on('connection', setupWSConnection);

/*
 * y-postgresql
 */
if (
	!process.env.PG_HOST ||
	!process.env.PG_PORT ||
	!process.env.PG_DATABASE ||
	!process.env.PG_USER ||
	!process.env.PG_PASSWORD
) {
	throw new Error('Please define the PostgreSQL connection option environment variables');
}
const pgdb = await PostgresqlPersistence.build({
	host: process.env.PG_HOST,
	port: parseInt(process.env.PG_PORT, 10),
	database: process.env.PG_DATABASE,
	user: process.env.PG_USER,
	password: process.env.PG_PASSWORD,
});

setPersistence({
	bindState: async (docName: string, ydoc: IWSSharedDoc) => {
		const persistedYdoc = await pgdb.getYDoc(docName);
		const newUpdates = Y.encodeStateAsUpdate(ydoc);
		pgdb.storeUpdate(docName, newUpdates);
		Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
		ydoc.on('update', async (update: Uint8Array) => {
			pgdb.storeUpdate(docName, update);
		});
	},
	writeState: (docName: string, ydoc: IWSSharedDoc) => {
		return new Promise((resolve) => {
			resolve(true);
		});
	},
});

server.listen(process.env.PORT, () => {
	console.log(`listening on port:${process.env.PORT}`);
});
