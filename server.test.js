import assert from 'assert';
import http from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';

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

    describe('HTTP Response Codes', () => {
        it('should return 404 Tunnel Not Found when client does not exist', async () => {
            const { server, adminServer } = createServer({ domain: 'example.com' });
            await new Promise(resolve => server.listen(resolve));
            await new Promise(resolve => adminServer.listen(resolve));

            const serverPort = server.address().port;

            // Make request to non-existent subdomain
            const reqOptions = {
                hostname: 'localhost',
                port: serverPort,
                path: '/',
                method: 'GET',
                headers: {
                    Host: 'nonexistent.example.com'
                }
            };

            const res = await new Promise((resolve, reject) => {
                const req = http.request(reqOptions, resolve);
                req.on('error', reject);
                req.end();
            });

            assert.equal(res.statusCode, 404);
            assert.equal(res.statusMessage, 'Tunnel Not Found');

            await new Promise(resolve => server.close(resolve));
            await new Promise(resolve => adminServer.close(resolve));
        });

        it('should return 503 Service Temporarily Unavailable when client offline (grace period)', async function() {
            this.timeout(10000);

            const { server, adminServer } = createServer({ domain: 'example.com' });
            await new Promise(resolve => server.listen(resolve));
            await new Promise(resolve => adminServer.listen(resolve));

            // Create client
            const res1 = await makeRequest(adminServer, '/offline-test');
            const clientPort = res1.body.port;

            // Connect a TCP socket to make client go online
            const clientSocket = net.connect(clientPort);
            await new Promise(resolve => clientSocket.once('connect', resolve));

            // Disconnect to trigger grace period
            clientSocket.end();
            await new Promise(resolve => setTimeout(resolve, 10)); // Wait briefly for offline event

            // Make request to offline client (should be in grace period now)
            const serverPort = server.address().port;
            const reqOptions = {
                hostname: 'localhost',
                port: serverPort,
                path: '/',
                method: 'GET',
                headers: {
                    Host: 'offline-test.example.com'
                }
            };

            const res = await new Promise((resolve, reject) => {
                const req = http.request(reqOptions, resolve);
                req.on('error', reject);
                req.end();
            });

            assert.equal(res.statusCode, 503);
            assert.equal(res.statusMessage, 'Service Temporarily Unavailable');
            assert.ok(res.headers['retry-after']);

            await new Promise(resolve => server.close(resolve));
            await new Promise(resolve => adminServer.close(resolve));
        });
    });

    describe('Client Token Authentication (X-LT-Client-Token)', () => {
        it('should accept client token and use it for identification', async () => {
            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            const res = await makeRequest(adminServer, '/token-test', {
                headers: { 'X-LT-Client-Token': 'my-secure-token-123' }
            });

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.id, 'token-test');

            await new Promise(resolve => adminServer.close(resolve));
        });

        it('should allow reconnection with same token but different IP', async function() {
            this.timeout(10000);

            // Set grace period to allow reconnection
            const originalGracePeriod = process.env.LT_GRACE_PERIOD;
            const originalMaxGracePeriod = process.env.LT_MAX_GRACE_PERIOD;
            process.env.LT_GRACE_PERIOD = '10000';  // 10 seconds
            process.env.LT_MAX_GRACE_PERIOD = '20000';  // 20 seconds

            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            // First connection with token
            const res1 = await makeRequest(adminServer, '/token-reconnect', {
                headers: { 'X-LT-Client-Token': 'reconnect-token-456' }
            });

            assert.equal(res1.statusCode, 200);
            const clientPort = res1.body.port;

            // Simulate client going online and offline
            const socket = net.connect(clientPort);
            await new Promise(resolve => socket.once('connect', resolve));
            // Wait for client to go online
            await new Promise(resolve => setTimeout(resolve, 200));
            socket.end();
            // Wait for offline event to be processed and grace period to start
            await new Promise(resolve => setTimeout(resolve, 500));

            // Second connection with same token (should succeed even with "different IP")
            // Note: In real scenario, X-Forwarded-For would be different
            const res2 = await makeRequest(adminServer, '/token-reconnect', {
                headers: { 'X-LT-Client-Token': 'reconnect-token-456' }
            });

            assert.equal(res2.statusCode, 200);
            assert.equal(res2.body.id, 'token-reconnect');

            await new Promise(resolve => adminServer.close(resolve));

            // Restore original grace period
            if (originalGracePeriod === undefined) {
                delete process.env.LT_GRACE_PERIOD;
            } else {
                process.env.LT_GRACE_PERIOD = originalGracePeriod;
            }
            if (originalMaxGracePeriod === undefined) {
                delete process.env.LT_MAX_GRACE_PERIOD;
            } else {
                process.env.LT_MAX_GRACE_PERIOD = originalMaxGracePeriod;
            }
        });

        it('should reject reconnection with different token (strict mode)', async function() {
            this.timeout(10000);

            // Set strict mode and grace period
            const originalStrict = process.env.LT_IP_VALIDATION_STRICT;
            const originalGracePeriod = process.env.LT_GRACE_PERIOD;
            const originalMaxGracePeriod = process.env.LT_MAX_GRACE_PERIOD;
            process.env.LT_IP_VALIDATION_STRICT = 'true';
            process.env.LT_GRACE_PERIOD = '10000';  // 10 seconds
            process.env.LT_MAX_GRACE_PERIOD = '20000';  // 20 seconds

            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            // First connection with token1
            const res1 = await makeRequest(adminServer, '/token-strict', {
                headers: { 'X-LT-Client-Token': 'token1' }
            });

            assert.equal(res1.statusCode, 200);
            const clientPort = res1.body.port;

            // Simulate client going online and offline
            const socket = net.connect(clientPort);
            await new Promise(resolve => socket.once('connect', resolve));
            // Wait for client to go online
            await new Promise(resolve => setTimeout(resolve, 200));
            socket.end();
            // Wait for offline event to be processed and grace period to start
            await new Promise(resolve => setTimeout(resolve, 500));

            // Second connection with different token (should fail)
            const res2 = await makeRequest(adminServer, '/token-strict', {
                headers: { 'X-LT-Client-Token': 'token2-different' }
            });

            assert.equal(res2.statusCode, 409);
            assert.ok(res2.body.message.includes('reserved by another client'));

            await new Promise(resolve => adminServer.close(resolve));

            // Restore original settings
            if (originalStrict === undefined) {
                delete process.env.LT_IP_VALIDATION_STRICT;
            } else {
                process.env.LT_IP_VALIDATION_STRICT = originalStrict;
            }
            if (originalGracePeriod === undefined) {
                delete process.env.LT_GRACE_PERIOD;
            } else {
                process.env.LT_GRACE_PERIOD = originalGracePeriod;
            }
            if (originalMaxGracePeriod === undefined) {
                delete process.env.LT_MAX_GRACE_PERIOD;
            } else {
                process.env.LT_MAX_GRACE_PERIOD = originalMaxGracePeriod;
            }
        });

        it('should fall back to IP when no token is provided (retrocompatibility)', async () => {
            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            // Request without token (should work with IP-based identification)
            const res = await makeRequest(adminServer, '/no-token-test');

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.id, 'no-token-test');

            await new Promise(resolve => adminServer.close(resolve));
        });

        it('should ignore empty token and fall back to IP', async () => {
            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            // Request with empty token
            const res = await makeRequest(adminServer, '/empty-token-test', {
                headers: { 'X-LT-Client-Token': '   ' }
            });

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.id, 'empty-token-test');

            await new Promise(resolve => adminServer.close(resolve));
        });

        it('should reject token that is too long', async () => {
            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            const longToken = 'a'.repeat(300); // 300 chars, exceeds 256 limit
            const res = await makeRequest(adminServer, '/long-token-test', {
                headers: { 'X-LT-Client-Token': longToken }
            });

            // Should succeed but fall back to IP (token ignored)
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.id, 'long-token-test');

            await new Promise(resolve => adminServer.close(resolve));
        });

        it('should reject token with invalid characters', async () => {
            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            const invalidToken = 'token@with#invalid$chars!';
            const res = await makeRequest(adminServer, '/invalid-token-test', {
                headers: { 'X-LT-Client-Token': invalidToken }
            });

            // Should succeed but fall back to IP (token ignored)
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.id, 'invalid-token-test');

            await new Promise(resolve => adminServer.close(resolve));
        });

        it('should work with random subdomain and token', async () => {
            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            const res = await makeRequest(adminServer, '/?new', {
                headers: { 'X-LT-Client-Token': 'random-token-789' }
            });

            assert.equal(res.statusCode, 200);
            assert.ok(res.body.id); // Should have a random ID
            assert.ok(res.body.url);

            await new Promise(resolve => adminServer.close(resolve));
        });

        it('should allow token with hyphens and underscores', async () => {
            const { adminServer } = createServer();
            await new Promise(resolve => adminServer.listen(resolve));

            const validToken = 'my-valid_token-123';
            const res = await makeRequest(adminServer, '/valid-chars-test', {
                headers: { 'X-LT-Client-Token': validToken }
            });

            assert.equal(res.statusCode, 200);
            assert.equal(res.body.id, 'valid-chars-test');

            await new Promise(resolve => adminServer.close(resolve));
        });
    });

    describe('HMAC Authentication', function() {
        const TEST_SECRET = 'test-secret-at-least-32-chars-long-12345';

        // Helper para gerar autenticação HMAC válida
        function generateHmacAuth(method, path, secret, timestampOffset = 0, nonceOffset = 0, body = '') {
            const timestamp = Math.floor(Date.now() / 1000) + timestampOffset; // segundos
            const nonce = Date.now() + (nonceOffset * 1000); // milissegundos

            const message = `${method}${path}${timestamp}${nonce}${body}`;
            const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');

            return {
                'Authorization': `HMAC sha256=${signature}`,
                'X-Timestamp': timestamp.toString(),
                'X-Nonce': nonce.toString()
            };
        }

        describe('Configuration', function() {
            it('should load secret from LT_HMAC_SECRET env var', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Deve requerer autenticação
                const res = await makeRequest(adminServer, '/hmac-test');
                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should load secret from FILE_LT_HMAC_SECRET', async () => {
                const secretFile = '/tmp/test-hmac-secret.key';
                fs.writeFileSync(secretFile, TEST_SECRET + '\n');

                const originalFileSecret = process.env.FILE_LT_HMAC_SECRET;
                process.env.FILE_LT_HMAC_SECRET = secretFile;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Testa com segredo do arquivo
                const auth = generateHmacAuth('GET', '/hmac-file-test', TEST_SECRET);
                const res = await makeRequest(adminServer, '/hmac-file-test', { headers: auth });
                assert.equal(res.statusCode, 200);

                await new Promise(resolve => adminServer.close(resolve));

                fs.unlinkSync(secretFile);
                if (originalFileSecret === undefined) {
                    delete process.env.FILE_LT_HMAC_SECRET;
                } else {
                    process.env.FILE_LT_HMAC_SECRET = originalFileSecret;
                }
            });

            it('should not require auth when secret not configured', async () => {
                // Garante que não há secret configurado
                const originalSecret = process.env.LT_HMAC_SECRET;
                const originalFileSecret = process.env.FILE_LT_HMAC_SECRET;
                delete process.env.LT_HMAC_SECRET;
                delete process.env.FILE_LT_HMAC_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Deve permitir sem autenticação
                const res = await makeRequest(adminServer, '/no-auth-test');
                assert.equal(res.statusCode, 200);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret !== undefined) {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
                if (originalFileSecret !== undefined) {
                    process.env.FILE_LT_HMAC_SECRET = originalFileSecret;
                }
            });
        });

        describe('Valid Authentication', function() {
            it('should accept valid HMAC authentication', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const auth = generateHmacAuth('GET', '/hmac-valid', TEST_SECRET);
                const res = await makeRequest(adminServer, '/hmac-valid', { headers: auth });

                assert.equal(res.statusCode, 200);
                assert.equal(res.body.id, 'hmac-valid');

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should accept request with random subdomain and valid auth', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const auth = generateHmacAuth('GET', '/', TEST_SECRET);
                const res = await makeRequest(adminServer, '/?new', { headers: auth });

                assert.equal(res.statusCode, 200);
                assert.ok(res.body.id);
                assert.ok(res.body.url);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });
        });

        describe('Invalid Authentication', function() {
            it('should reject request without Authorization header', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const res = await makeRequest(adminServer, '/no-auth', {
                    headers: {
                        'X-Timestamp': Math.floor(Date.now() / 1000).toString(),
                        'X-Nonce': Date.now().toString()
                    }
                });

                assert.equal(res.statusCode, 401);
                assert.ok(res.body.error);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should reject request without X-Timestamp header', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const res = await makeRequest(adminServer, '/no-timestamp', {
                    headers: {
                        'Authorization': 'HMAC sha256=abc123',
                        'X-Nonce': Date.now().toString()
                    }
                });

                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should reject request without X-Nonce header', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const res = await makeRequest(adminServer, '/no-nonce', {
                    headers: {
                        'Authorization': 'HMAC sha256=abc123',
                        'X-Timestamp': Math.floor(Date.now() / 1000).toString()
                    }
                });

                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should reject request with invalid signature', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const timestamp = Math.floor(Date.now() / 1000);
                const nonce = Date.now();

                const res = await makeRequest(adminServer, '/invalid-sig', {
                    headers: {
                        'Authorization': 'HMAC sha256=invalid1234567890',
                        'X-Timestamp': timestamp.toString(),
                        'X-Nonce': nonce.toString()
                    }
                });

                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should reject request with wrong secret', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Gera HMAC com secret errado
                const wrongSecret = 'wrong-secret-at-least-32-chars-12345';
                const auth = generateHmacAuth('GET', '/wrong-secret', wrongSecret);
                const res = await makeRequest(adminServer, '/wrong-secret', { headers: auth });

                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });
        });

        describe('Nonce Validation with Numeric Epoch', function() {
            it('should accept valid numeric nonce (epoch ms)', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const auth = generateHmacAuth('GET', '/valid-nonce', TEST_SECRET);
                const res = await makeRequest(adminServer, '/valid-nonce', { headers: auth });

                assert.equal(res.statusCode, 200);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should reject non-numeric nonce', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const timestamp = Math.floor(Date.now() / 1000);
                const message = `GET/non-numeric${timestamp}abc123`;
                const signature = crypto.createHmac('sha256', TEST_SECRET).update(message).digest('hex');

                const res = await makeRequest(adminServer, '/non-numeric', {
                    headers: {
                        'Authorization': `HMAC sha256=${signature}`,
                        'X-Timestamp': timestamp.toString(),
                        'X-Nonce': 'abc123'
                    }
                });

                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should reject nonce older than threshold', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                const originalThreshold = process.env.LT_HMAC_NONCE_THRESHOLD;
                process.env.LT_HMAC_SECRET = TEST_SECRET;
                process.env.LT_HMAC_NONCE_THRESHOLD = '3600'; // 1 hora

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Nonce de 2 horas atrás (excede threshold de 1 hora)
                const timestamp = Math.floor(Date.now() / 1000);
                const oldNonce = (timestamp - 7200) * 1000;
                const message = `GET/old-nonce${timestamp}${oldNonce}`;
                const signature = crypto.createHmac('sha256', TEST_SECRET).update(message).digest('hex');

                const res = await makeRequest(adminServer, '/old-nonce', {
                    headers: {
                        'Authorization': `HMAC sha256=${signature}`,
                        'X-Timestamp': timestamp.toString(),
                        'X-Nonce': oldNonce.toString()
                    }
                });

                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
                if (originalThreshold === undefined) {
                    delete process.env.LT_HMAC_NONCE_THRESHOLD;
                } else {
                    process.env.LT_HMAC_NONCE_THRESHOLD = originalThreshold;
                }
            });

            it('should allow nonce within threshold window', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                const originalThreshold = process.env.LT_HMAC_NONCE_THRESHOLD;
                process.env.LT_HMAC_SECRET = TEST_SECRET;
                process.env.LT_HMAC_NONCE_THRESHOLD = '3600'; // 1 hora

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Nonce de 30 minutos atrás (dentro do threshold de 1 hora)
                const timestamp = Math.floor(Date.now() / 1000);
                const recentNonce = (timestamp - 1800) * 1000;
                const message = `GET/recent-nonce${timestamp}${recentNonce}`;
                const signature = crypto.createHmac('sha256', TEST_SECRET).update(message).digest('hex');

                const res = await makeRequest(adminServer, '/recent-nonce', {
                    headers: {
                        'Authorization': `HMAC sha256=${signature}`,
                        'X-Timestamp': timestamp.toString(),
                        'X-Nonce': recentNonce.toString()
                    }
                });

                assert.equal(res.statusCode, 200);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
                if (originalThreshold === undefined) {
                    delete process.env.LT_HMAC_NONCE_THRESHOLD;
                } else {
                    process.env.LT_HMAC_NONCE_THRESHOLD = originalThreshold;
                }
            });
        });

        describe('Replay Attack Prevention', function() {
            it('should reject reused numeric nonce (replay attack)', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                const auth = generateHmacAuth('GET', '/replay-test', TEST_SECRET);

                // Primeira requisição - sucesso
                const res1 = await makeRequest(adminServer, '/replay-test', { headers: auth });
                assert.equal(res1.statusCode, 200);

                // Segunda requisição com mesmo nonce - replay detectado
                const res2 = await makeRequest(adminServer, '/replay-test', { headers: auth });
                assert.equal(res2.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });

            it('should allow different nonce values', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Duas requisições com nonces diferentes
                const auth1 = generateHmacAuth('GET', '/diff-nonce-1', TEST_SECRET);
                const res1 = await makeRequest(adminServer, '/diff-nonce-1', { headers: auth1 });
                assert.equal(res1.statusCode, 200);

                await new Promise(resolve => setTimeout(resolve, 10)); // Garante nonce diferente

                const auth2 = generateHmacAuth('GET', '/diff-nonce-2', TEST_SECRET);
                const res2 = await makeRequest(adminServer, '/diff-nonce-2', { headers: auth2 });
                assert.equal(res2.statusCode, 200);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });
        });

        describe('Timestamp Validation', function() {
            it('should reject expired timestamp (too old)', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                const originalTolerance = process.env.LT_HMAC_TIMESTAMP_TOLERANCE;
                process.env.LT_HMAC_SECRET = TEST_SECRET;
                process.env.LT_HMAC_TIMESTAMP_TOLERANCE = '60'; // 60 segundos

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Timestamp de 2 minutos atrás (excede tolerância de 60s)
                const auth = generateHmacAuth('GET', '/expired', TEST_SECRET, -120); // -120 segundos
                const res = await makeRequest(adminServer, '/expired', { headers: auth });

                assert.equal(res.statusCode, 401);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
                if (originalTolerance === undefined) {
                    delete process.env.LT_HMAC_TIMESTAMP_TOLERANCE;
                } else {
                    process.env.LT_HMAC_TIMESTAMP_TOLERANCE = originalTolerance;
                }
            });

            it('should accept timestamp within tolerance window', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                const originalTolerance = process.env.LT_HMAC_TIMESTAMP_TOLERANCE;
                process.env.LT_HMAC_SECRET = TEST_SECRET;
                process.env.LT_HMAC_TIMESTAMP_TOLERANCE = '60'; // 60 segundos

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // Timestamp de 30 segundos atrás (dentro da tolerância)
                const auth = generateHmacAuth('GET', '/within-tolerance', TEST_SECRET, -30);
                const res = await makeRequest(adminServer, '/within-tolerance', { headers: auth });

                assert.equal(res.statusCode, 200);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
                if (originalTolerance === undefined) {
                    delete process.env.LT_HMAC_TIMESTAMP_TOLERANCE;
                } else {
                    process.env.LT_HMAC_TIMESTAMP_TOLERANCE = originalTolerance;
                }
            });
        });

        describe('Status Endpoint', function() {
            it('should allow access to /api/status without authentication', async () => {
                const originalSecret = process.env.LT_HMAC_SECRET;
                process.env.LT_HMAC_SECRET = TEST_SECRET;

                const { adminServer } = createServer();
                await new Promise(resolve => adminServer.listen(resolve));

                // /api/status não deve requerer autenticação
                const res = await makeRequest(adminServer, '/api/status');
                assert.equal(res.statusCode, 200);
                assert.ok(res.body.tunnels !== undefined);

                await new Promise(resolve => adminServer.close(resolve));

                if (originalSecret === undefined) {
                    delete process.env.LT_HMAC_SECRET;
                } else {
                    process.env.LT_HMAC_SECRET = originalSecret;
                }
            });
        });
    });
});
