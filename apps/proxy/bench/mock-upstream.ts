// A fast stand-in for Google, for load tests: answers every request with a small JSON body.
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 9090);
const body = JSON.stringify({ results: [{ place_id: 'ChIJbench' }], status: 'OK' });
createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
  });
}).listen(port, '0.0.0.0');
process.stdout.write(`mock upstream on :${port}\n`);
