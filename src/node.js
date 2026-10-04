import { initializeFileStore } from './store.js';
import { server } from './server.js';

initializeFileStore();
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(port, host, () => console.log(`Vantage-ARS is listening on http://${host}:${port}`));
