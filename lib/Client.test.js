import assert from 'assert';
import http from 'http';
import { Duplex } from 'stream';
import WebSocket from 'ws';
import net from 'net';
import { EventEmitter } from 'events';

import Client from './Client.js';

class DummySocket extends Duplex {
    constructor(options) {
        super(options);
    }

    _write(chunk, encoding, callback) {
        callback();
    }

    _read(size) {
        this.push('HTTP/1.1 304 Not Modified\r\nX-Powered-By: dummy\r\n\r\n\r\n');
        this.push(null);
    }
}

class DummyWebsocket extends Duplex {
    constructor(options) {
        super(options);
        this.sentHeader = false;
    }

    _write(chunk, encoding, callback) {
        const str = chunk.toString();
        // if chunk contains `GET / HTTP/1.1` -> queue headers
        // otherwise echo back received data
        if (str.indexOf('GET / HTTP/1.1') === 0) {
            const arr = [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
            ];
            this.push(arr.join('\r\n'));
            this.push('\r\n\r\n');
        }
        else {
            this.push(str);
        }
        callback();
    }

    _read(size) {
        // nothing to implement
    }
}

class DummyAgent extends http.Agent {
    constructor() {
        super();
    }

    createConnection(options, cb) {
        cb(null, new DummySocket());
    }
}

describe('Client', () => {
    it('should handle request', async () => {
        const agent = new DummyAgent();
        const client = new Client({ agent });

        const server = http.createServer((req, res) => {
            client.handleRequest(req, res);
        });

        await new Promise(resolve => server.listen(resolve));

        const address = server.address();
        const opt = {
            host: 'localhost',
            port: address.port,
            path: '/',
        };

        const res = await new Promise((resolve) => {
            const req = http.get(opt, (res) => {
                resolve(res);
            });
            req.end();
        });
        assert.equal(res.headers['x-powered-by'], 'dummy');
        server.close();
    });

    it('should handle upgrade', async () => {
        // need a websocket server and a socket for it
        class DummyWebsocketAgent extends http.Agent {
            constructor() {
                super();
            }

            createConnection(options, cb) {
                cb(null, new DummyWebsocket());
            }
        }

        const agent = new DummyWebsocketAgent();
        const client = new Client({ agent });

        const server = http.createServer();
        server.on('upgrade', (req, socket, head) => {
            client.handleUpgrade(req, socket);
        });

        await new Promise(resolve => server.listen(resolve));

        const address = server.address();

        const netClient = await new Promise((resolve) => {
            const newClient = net.createConnection({ port: address.port }, () => {
                resolve(newClient);
            });
        });

        const out = [
            'GET / HTTP/1.1',
            'Connection: Upgrade',
            'Upgrade: websocket'
        ];

        netClient.write(out.join('\r\n') + '\r\n\r\n');

        {
            const data = await new Promise((resolve) => {
                netClient.once('data', (chunk) => {
                    resolve(chunk.toString());
                });
            });
            const exp = [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
            ];
            assert.equal(exp.join('\r\n') + '\r\n\r\n', data);
        }

        {
            netClient.write('foobar');
            const data = await new Promise((resolve) => {
                netClient.once('data', (chunk) => {
                    resolve(chunk.toString());
                });
            });
            assert.equal('foobar', data);
        }

        netClient.destroy();
        server.close();
    });

    describe('Grace Period', () => {
        it('should cancel grace period when agent goes online', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-online' });
            let closeCalled = false;

            client.on('close', () => {
                closeCalled = true;
            });

            // Simulate client going online before grace period expires
            setImmediate(() => {
                agent.emit('online');
            });

            // Wait longer than default grace period would be
            setTimeout(() => {
                assert(!closeCalled, 'Client should not be closed when agent goes online');
                client.close();
                done();
            }, 100);
        });

        it('should restart grace period when agent goes offline again', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-offline-restart' });
            let closeCalled = false;

            client.on('close', () => {
                closeCalled = true;
            });

            // Go online to cancel initial grace period
            setImmediate(() => {
                agent.emit('online');
            });

            // Should NOT be closed when online
            setTimeout(() => {
                assert(!closeCalled, 'Client should not be closed when online');

                // Go offline again - this should restart grace period
                agent.emit('offline');

                // With 100ms grace period, should close after timeout
                setTimeout(() => {
                    assert(closeCalled, 'Client should be closed after going offline with grace period');
                    done();
                }, 150);
            }, 50);
        });

        it('should prevent double close when offline is called multiple times', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-multiple-offline' });
            let closeCount = 0;

            client.on('close', () => {
                closeCount++;
            });

            // Go online first to cancel initial grace period
            agent.emit('online');

            // Emit offline multiple times
            setImmediate(() => {
                agent.emit('offline');
                agent.emit('offline');
                agent.emit('offline');
            });

            // Wait and verify close was called only once (wait longer than grace period)
            setTimeout(() => {
                assert.equal(closeCount, 1, 'Close should only be called once despite multiple offline events');
                done();
            }, 150);
        });

        it('should clear grace period timeout on explicit close', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-explicit-close' });
            let closeCount = 0;

            client.on('close', () => {
                closeCount++;
            });

            // Go online to cancel initial grace period
            agent.emit('online');

            // Explicitly close the client
            setImmediate(() => {
                client.close();
                assert.equal(closeCount, 1, 'Close should be called once');

                // Wait to ensure close is not called again
                setTimeout(() => {
                    assert.equal(closeCount, 1, 'Close should still be called only once');
                    done();
                }, 100);
            });
        });

        it('should handle rapid online/offline transitions', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-rapid-transitions' });
            let closeCalled = false;

            client.on('close', () => {
                closeCalled = true;
            });

            // Rapid transitions
            agent.emit('online');
            agent.emit('offline');
            agent.emit('online');
            agent.emit('offline');
            agent.emit('online');

            // Should NOT be closed because we ended on online
            setTimeout(() => {
                assert(!closeCalled, 'Client should not be closed after ending in online state');
                client.close();
                done();
            }, 100);
        });

        it('should close after grace period when agent never comes online', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-never-online' });
            let closeCalled = false;

            client.on('close', () => {
                closeCalled = true;
            });

            // Should close after minimum 100ms grace period
            setTimeout(() => {
                assert(closeCalled, 'Client should be closed after grace period when agent never comes online');
                done();
            }, 150);
        });

        it('should properly cleanup graceTimeout on close', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-cleanup' });

            setImmediate(() => {
                // Go online first
                agent.emit('online');

                // Verify graceTimeout is null when online
                assert.equal(client.graceTimeout, null, 'graceTimeout should be null when online');

                // Go offline to set grace timeout
                agent.emit('offline');
                assert.notEqual(client.graceTimeout, null, 'graceTimeout should be set when offline');

                // Close explicitly
                client.close();

                // Verify cleanup happened
                assert.equal(client.graceTimeout, null, 'graceTimeout should be null after close');
                done();
            });
        });

        it('should support reconnection within grace period if agent comes online', (done) => {
            const agent = new EventEmitter();
            agent.stats = () => ({});
            agent.destroy = () => {};

            const client = new Client({ agent, id: 'test-reconnect' });
            let closeCalled = false;

            client.on('close', () => {
                closeCalled = true;
            });

            // Simulate quick reconnection by going online immediately
            agent.emit('online');

            setTimeout(() => {
                assert(!closeCalled, 'Client should not be closed when reconnected quickly');

                // Now test that going offline triggers grace period
                agent.emit('offline');

                // Wait for grace period to expire
                setTimeout(() => {
                    assert(closeCalled, 'Client should be closed after final offline');
                    done();
                }, 150);
            }, 50);
        });
    });
});
