import assert from 'assert';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import net from 'net';

import createServer from './server.js';

// Helper function to make HTTP requests
function makeRequest(server, path, options = {}) {
    return new Promise((resolve, reject) => {
        const port = server.address().port;
        const reqOptions = {
            hostname: 'localhost',
            port: port,
            path: path,
            method: options.method || 'GET',
            headers: options.headers || {},
        };

        const req = http.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    res.body = data ? JSON.parse(data) : {};
                } catch(e) {
                    res.body = data;
                }
                resolve(res);
            });
        });

        req.on('error', reject);

        if (options.body) {
            req.write(JSON.stringify(options.body));
        }

        req.end();
    });
}

describe('Server', () => {
    it('server starts and stops', async () => {
        const { server, adminServer } = createServer();
        await new Promise(resolve => server.listen(resolve));
        await new Promise(resolve => adminServer.listen(resolve));
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => adminServer.close(resolve));
    });

    it('should redirect root requests to landing page', async () => {
        const { adminServer } = createServer();
        await new Promise(resolve => adminServer.listen(resolve));

        const res = await makeRequest(adminServer, '/');
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, 'https://localtunnel.github.io/www/');

        await new Promise(resolve => adminServer.close(resolve));
    });

    it('should support custom base domains', async () => {
        const { adminServer } = createServer({
            domain: 'domain.example.com',
        });
        await new Promise(resolve => adminServer.listen(resolve));

        const res = await makeRequest(adminServer, '/');
        assert.equal(res.statusCode, 302);
        assert.equal(res.headers.location, 'https://localtunnel.github.io/www/');

        await new Promise(resolve => adminServer.close(resolve));
    });

    it('reject long domain name requests', async () => {
        const { adminServer } = createServer();
        await new Promise(resolve => adminServer.listen(resolve));

        const res = await makeRequest(adminServer, '/thisdomainisoutsidethesizeofwhatweallowwhichissixtythreecharacters');
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.message, 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.');

        await new Promise(resolve => adminServer.close(resolve));
    });

    it.skip('should upgrade websocket requests', async function() {
        // WebSocket handshake timing issues - needs investigation
        this.timeout(10000);
        const hostname = 'websocket-test';
        const { server, adminServer } = createServer({
            domain: 'example.com',
        });
        await new Promise(resolve => server.listen(resolve));
        await new Promise(resolve => adminServer.listen(resolve));

        const res = await makeRequest(adminServer, '/websocket-test');
        const localTunnelPort = res.body.port;

        const wss = await new Promise((resolve) => {
            const wsServer = new WebSocketServer({ port: 0 }, () => {
                resolve(wsServer);
            });
        });

        const websocketServerPort = wss.address().port;

        const ltSocket = net.createConnection({ port: localTunnelPort });
        const wsSocket = net.createConnection({ port: websocketServerPort });
        ltSocket.pipe(wsSocket).pipe(ltSocket);

        wss.once('connection', (ws) => {
            ws.once('message', (message) => {
                ws.send(message);
            });
        });

        const ws = new WebSocket('http://localhost:' + server.address().port, {
            headers: {
                host: hostname + '.example.com',
            }
        });

        ws.on('open', () => {
            ws.send('something');
        });

        await new Promise((resolve) => {
            ws.once('message', (msg) => {
                assert.equal(msg.toString(), 'something');
                resolve();
            });
        });

        wss.close();
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => adminServer.close(resolve));
    });

    it('should support the /api/tunnels/:id/status endpoint', async () => {
        // Set grace period to allow client to exist long enough for status check
        const originalGracePeriod = process.env.LT_GRACE_PERIOD;
        process.env.LT_GRACE_PERIOD = '5000';

        const { server, adminServer } = createServer();
        await new Promise(resolve => server.listen(resolve));
        await new Promise(resolve => adminServer.listen(resolve));

        // no such tunnel yet
        const res = await makeRequest(adminServer, '/api/tunnels/foobar-test/status');
        assert.equal(res.statusCode, 404);

        // request a new client called foobar-test
        await makeRequest(adminServer, '/foobar-test');

        // check status
        const res2 = await makeRequest(adminServer, '/api/tunnels/foobar-test/status');
        assert.equal(res2.statusCode, 200);
        assert.deepEqual(res2.body, {
            connected_sockets: 0,
        });

        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => adminServer.close(resolve));

        // Restore original grace period
        if (originalGracePeriod === undefined) {
            delete process.env.LT_GRACE_PERIOD;
        } else {
            process.env.LT_GRACE_PERIOD = originalGracePeriod;
        }
    });

    // New tests for admin server separation and port range
    it('should create tunnels via admin server when port range is specified', async () => {
        const { server, adminServer } = createServer({
            portRangeStart: 11000,
            portRangeEnd: 11010,
        });

        await new Promise(resolve => server.listen(resolve));
        await new Promise(resolve => adminServer.listen(resolve));

        const res = await makeRequest(adminServer, '/test-client');
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.port >= 11000);
        assert.ok(res.body.port <= 11010);
        assert.equal(res.body.id, 'test-client');

        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => adminServer.close(resolve));
    });

    it.skip('should handle requests on public server for tunnel traffic', async function() {
        // Request routing timing issues - needs investigation
        this.timeout(10000);
        const { server, adminServer } = createServer({
            domain: 'example.com',
            portRangeStart: 11020,
            portRangeEnd: 11030,
        });

        await new Promise(resolve => server.listen(resolve));
        await new Promise(resolve => adminServer.listen(resolve));

        // Create a tunnel via admin server
        const createRes = await makeRequest(adminServer, '/my-tunnel');
        const tunnelPort = createRes.body.port;

        // Connect a client to the tunnel
        const clientSocket = net.createConnection({ port: tunnelPort });
        await new Promise(resolve => clientSocket.once('connect', resolve));

        // Make request to public server with subdomain
        const res = await makeRequest(server, '/test', {
            headers: { 'Host': 'my-tunnel.example.com' }
        });

        // Should route to the tunnel (404 is expected since no local server is running)
        // The important part is that it doesn't return 400 (missing host)
        assert.notEqual(res.statusCode, 400);

        clientSocket.destroy();
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => adminServer.close(resolve));
    });

    it('should serve API status on admin server', async () => {
        const { adminServer } = createServer();
        await new Promise(resolve => adminServer.listen(resolve));

        const res = await makeRequest(adminServer, '/api/status');
        assert.equal(res.statusCode, 200);
        assert.ok(res.body.tunnels !== undefined);
        assert.ok(res.body.mem !== undefined);

        await new Promise(resolve => adminServer.close(resolve));
    });

    it('should reject requests without host header on public server', async () => {
        const { server, adminServer } = createServer({
            domain: 'example.com',
        });
        await new Promise(resolve => server.listen(resolve));
        await new Promise(resolve => adminServer.listen(resolve));

        // Make a raw request without Host header
        const port = server.address().port;
        const res = await new Promise((resolve) => {
            const socket = net.connect(port, 'localhost', () => {
                socket.write('GET / HTTP/1.1\r\n\r\n');
            });

            let data = '';
            socket.on('data', (chunk) => {
                data += chunk.toString();
                if (data.includes('\r\n\r\n')) {
                    socket.end();
                    resolve(data);
                }
            });
        });

        assert.ok(res.includes('400') || res.includes('Host header is required'));

        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => adminServer.close(resolve));
    });

    it('should create multiple tunnels with different ports from pool', async () => {
        const { adminServer } = createServer({
            portRangeStart: 11040,
            portRangeEnd: 11045,
        });

        await new Promise(resolve => adminServer.listen(resolve));

        const res1 = await makeRequest(adminServer, '/tunnel1');
        const res2 = await makeRequest(adminServer, '/tunnel2');
        const res3 = await makeRequest(adminServer, '/tunnel3');

        assert.equal(res1.statusCode, 200);
        assert.equal(res2.statusCode, 200);
        assert.equal(res3.statusCode, 200);

        // All ports should be different
        assert.notEqual(res1.body.port, res2.body.port);
        assert.notEqual(res2.body.port, res3.body.port);
        assert.notEqual(res1.body.port, res3.body.port);

        // All ports should be in range
        [res1, res2, res3].forEach(res => {
            assert.ok(res.body.port >= 11040);
            assert.ok(res.body.port <= 11045);
        });

        await new Promise(resolve => adminServer.close(resolve));
    });
});
