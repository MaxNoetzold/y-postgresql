require('dotenv').config();
const http = require('http');
const WebSocketServer = require('ws').Server;
const Y = require('yjs');
const { PostgresqlPersistence } = require('y-postgresql');
const { setPersistence, setupWSConnection } = require('./websocket/utils.js');

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
const setupDbPersistence = async () => {
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
		port: parseInt(process.env.PG_PORT),
		database: process.env.PG_DATABASE,
		user: process.env.PG_USER,
		password: process.env.PG_PASSWORD,
	});

	setPersistence({
		bindState: async (docName, ydoc) => {
			const persistedYdoc = await pgdb.getYDoc(docName);
			const newUpdates = Y.encodeStateAsUpdate(ydoc);
			pgdb.storeUpdate(docName, newUpdates);
			Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
			ydoc.on('update', async (update) => {
				pgdb.storeUpdate(docName, update);
			});
		},
		writeState: () => {
			return new Promise((resolve) => {
				resolve(true);
			});
		},
	});
};

setupDbPersistence();

server.listen(process.env.PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`listening on port: ${process.env.PORT}`);
});
