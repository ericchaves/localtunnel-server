import assert from 'assert';
import net from 'net';

import ClientManager from './ClientManager.js';

describe('ClientManager', () => {
    it('should construct with no tunnels', () => {
        const manager = new ClientManager();
        assert.equal(manager.stats.tunnels, 0);
    });

    it('should create a new client with random id', async () => {
        const manager = new ClientManager();
        const client = await manager.newClient();
        assert(manager.hasClient(client.id));
        manager.removeClient(client.id);
    });

    it('should create a new client with id', async () => {
        const manager = new ClientManager();
        const client = await manager.newClient('foobar');
        assert(manager.hasClient('foobar'));
        manager.removeClient('foobar');
    });

    it('should create a new client with random id if previous exists', async () => {
        const manager = new ClientManager();
        const clientA = await manager.newClient('foobar');
        const clientB = await manager.newClient('foobar');
        assert(clientA.id, 'foobar');
        assert(manager.hasClient(clientB.id));
        assert(clientB.id != clientA.id);
        manager.removeClient(clientB.id);
        manager.removeClient('foobar');
    });

    it('should remove client once it goes offline', async () => {
        const manager = new ClientManager();
        const client = await manager.newClient('foobar');

        const socket = await new Promise((resolve) => {
            const netClient = net.createConnection({ port: client.port }, () => {
                resolve(netClient);
            });
        });

        // Wait for connection to be established
        await new Promise(resolve => setTimeout(resolve, 100));

        const closePromise = new Promise(resolve => socket.once('close', resolve));
        socket.end();
        await closePromise;

        // With 100ms grace period, client should be closed after grace period expires
        await new Promise(resolve => setTimeout(resolve, 150));
        assert(!manager.hasClient('foobar'));
    }).timeout(5000);

    it('should remove correct client once it goes offline', async () => {
        const manager = new ClientManager();
        const clientFoo = await manager.newClient('foo');
        const clientBar = await manager.newClient('bar');

        const socket = await new Promise((resolve) => {
            const netClient = net.createConnection({ port: clientFoo.port }, () => {
                resolve(netClient);
            });
        });

        // Wait for connection to be established
        await new Promise(resolve => setTimeout(resolve, 100));

        // With 100ms grace period, clientBar should be closed after grace period (no connection)
        await new Promise(resolve => setTimeout(resolve, 150));

        // foo should still be ok - it has an active connection
        assert(manager.hasClient('foo'));

        // clientBar should be removed - nothing connected to it
        assert(!manager.hasClient('bar'));

        manager.removeClient('foo');
        socket.end();
    }).timeout(5000);

    it('should remove clients if they do not connect within 5 seconds', async () => {
        const manager = new ClientManager();
        const clientFoo = await manager.newClient('foo');
        assert(manager.hasClient('foo'));

        // wait past grace period (1s)
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert(!manager.hasClient('foo'));
    }).timeout(5000);

    // New tests for port range functionality
    it('should initialize port pool when port range is specified', () => {
        const manager = new ClientManager({
            portRangeStart: 10000,
            portRangeEnd: 10010,
        });

        assert.equal(manager.availablePorts.length, 11); // 10000 to 10010 inclusive
        assert.equal(manager.portRangeStart, 10000);
        assert.equal(manager.portRangeEnd, 10010);
    });

    it('should not initialize port pool when port range is not specified', () => {
        const manager = new ClientManager();
        assert.equal(manager.availablePorts.length, 0);
    });

    it('should assign ports from the pool to new clients', async () => {
        const manager = new ClientManager({
            portRangeStart: 10020,
            portRangeEnd: 10022,
        });

        const client1 = await manager.newClient('client1');
        assert.ok(client1.port >= 10020 && client1.port <= 10022);

        const client2 = await manager.newClient('client2');
        assert.ok(client2.port >= 10020 && client2.port <= 10022);

        assert.notEqual(client1.port, client2.port);

        manager.removeClient('client1');
        manager.removeClient('client2');
    });

    it('should return port to pool when client is removed', async () => {
        const manager = new ClientManager({
            portRangeStart: 10030,
            portRangeEnd: 10032,
        });

        const initialAvailable = manager.availablePorts.length;

        const client = await manager.newClient('test-client');
        const assignedPort = client.port;

        // Port should be removed from available pool
        assert.equal(manager.availablePorts.length, initialAvailable - 1);
        assert.ok(manager.usedPorts.has(assignedPort));

        manager.removeClient('test-client');

        // Port should be returned to available pool
        assert.equal(manager.availablePorts.length, initialAvailable);
        assert.ok(!manager.usedPorts.has(assignedPort));
    });

    it('should throw error when port pool is exhausted', async () => {
        const manager = new ClientManager({
            portRangeStart: 10040,
            portRangeEnd: 10041, // Only 2 ports available
        });

        const client1 = await manager.newClient('client1');
        const client2 = await manager.newClient('client2');

        // All ports are now used
        assert.equal(manager.availablePorts.length, 0);

        // Try to create a third client
        let errorThrown = false;
        try {
            await manager.newClient('client3');
        } catch (err) {
            errorThrown = true;
            assert.equal(err.message, 'No available ports in range');
        }

        assert.ok(errorThrown);

        manager.removeClient('client1');
        manager.removeClient('client2');
    });

    it('should reuse released ports for new clients', async () => {
        const manager = new ClientManager({
            portRangeStart: 10050,
            portRangeEnd: 10050, // Only 1 port
        });

        const client1 = await manager.newClient('client1');
        const port1 = client1.port;

        manager.removeClient('client1');

        // Create new client - should get the same port
        const client2 = await manager.newClient('client2');
        assert.equal(client2.port, port1);

        manager.removeClient('client2');
    });

    it('should work without port range (backward compatibility)', async () => {
        const manager = new ClientManager();
        const client = await manager.newClient('test');

        // Should get a random port
        assert.ok(client.port > 0);
        assert.equal(manager.availablePorts.length, 0);

        manager.removeClient('test');
    });

    it('should handle concurrent port allocation correctly', async () => {
        const manager = new ClientManager({
            portRangeStart: 10060,
            portRangeEnd: 10065,
        });

        // Create multiple clients concurrently
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(manager.newClient(`client${i}`));
        }

        const clients = await Promise.all(promises);

        // Verify all clients got unique ports
        const ports = clients.map(c => c.port);
        const uniquePorts = new Set(ports);
        assert.equal(uniquePorts.size, 5);

        // All ports should be in range
        ports.forEach(port => {
            assert.ok(port >= 10060 && port <= 10065);
        });

        // Cleanup
        for (let i = 0; i < 5; i++) {
            manager.removeClient(`client${i}`);
        }
    });

    describe('IP-based subdomain reservation', () => {
        it('should allow same IP to reconnect with same subdomain during grace period', async () => {
            const manager = new ClientManager();
            const clientIP = '192.168.1.100';

            // Criar cliente inicial
            const client1 = await manager.newClient('test-ip-subdomain', { ip: clientIP });
            assert.equal(client1.id, 'test-ip-subdomain');
            const originalPort = client1.port;

            // Obter referência ao client object
            const clientObj = manager.getClient('test-ip-subdomain');

            // Simular desconexão (offline) SEM remover do map
            // Emitir offline para iniciar grace period
            clientObj.agent.emit('offline');

            // Aguardar um pouco (menos que grace period)
            await new Promise(resolve => setTimeout(resolve, 50));

            // Verificar que client ainda existe (em grace period)
            assert.ok(manager.hasClient('test-ip-subdomain'), 'Client should still exist during grace period');

            // Tentar reconectar com mesmo IP
            const client2 = await manager.newClient('test-ip-subdomain', { ip: clientIP });
            assert.equal(client2.id, 'test-ip-subdomain', 'Should reuse same subdomain');

            manager.removeClient('test-ip-subdomain');
        }).timeout(35000);

        it('should block different IP during grace period (silent mode)', async () => {
            const manager = new ClientManager();
            const originalIP = '192.168.1.100';
            const differentIP = '192.168.1.200';

            // Criar cliente inicial
            const client1 = await manager.newClient('test-ip-block', { ip: originalIP });
            assert.equal(client1.id, 'test-ip-block');

            // Obter referência ao client object
            const clientObj = manager.getClient('test-ip-block');

            // Simular desconexão (offline) SEM remover do map
            clientObj.agent.emit('offline');

            // Aguardar um pouco (menos que grace period)
            await new Promise(resolve => setTimeout(resolve, 50));

            // Tentar conectar com IP diferente (modo silent)
            const client2 = await manager.newClient('test-ip-block', { ip: differentIP });
            assert.notEqual(client2.id, 'test-ip-block', 'Should receive random subdomain in silent mode');

            // Cleanup
            manager.removeClient('test-ip-block');
            manager.removeClient(client2.id);
        }).timeout(35000);

        it('should throw error on IP mismatch in strict mode', async () => {
            const originalEnv = process.env.LT_IP_VALIDATION_STRICT;
            process.env.LT_IP_VALIDATION_STRICT = 'true';

            try {
                const manager = new ClientManager();
                const originalIP = '192.168.1.100';
                const differentIP = '192.168.1.200';

                // Criar cliente inicial
                const client1 = await manager.newClient('test-ip-strict', { ip: originalIP });
                assert.equal(client1.id, 'test-ip-strict');

                // Obter referência ao client object
                const clientObj = manager.getClient('test-ip-strict');

                // Simular desconexão (offline) SEM remover do map
                clientObj.agent.emit('offline');

                // Aguardar um pouco (menos que grace period)
                await new Promise(resolve => setTimeout(resolve, 50));

                // Tentar conectar com IP diferente deve lançar erro
                let errorThrown = false;
                try {
                    await manager.newClient('test-ip-strict', { ip: differentIP });
                } catch (err) {
                    errorThrown = true;
                    assert.ok(err.message.includes('reserved by another client'));
                }
                assert.ok(errorThrown, 'Should throw error in strict mode');

                // Cleanup
                manager.removeClient('test-ip-strict');
            } finally {
                if (originalEnv === undefined) {
                    delete process.env.LT_IP_VALIDATION_STRICT;
                } else {
                    process.env.LT_IP_VALIDATION_STRICT = originalEnv;
                }
            }
        }).timeout(35000);

        it('should allow any IP after grace period expires', async () => {
            // Usar grace period curto para esse teste
            const originalGracePeriod = process.env.LT_GRACE_PERIOD;
            process.env.LT_GRACE_PERIOD = '200'; // 200ms

            try {
                const manager = new ClientManager();
                const originalIP = '192.168.1.100';
                const differentIP = '192.168.1.200';

                // Criar cliente inicial
                const client1 = await manager.newClient('test-ip-expire', { ip: originalIP });
                assert.equal(client1.id, 'test-ip-expire');

                // Obter referência ao client object
                const clientObj = manager.getClient('test-ip-expire');

                // Simular desconexão (offline)
                clientObj.agent.emit('offline');

                // Aguardar grace period expirar (client será removido automaticamente)
                await new Promise(resolve => setTimeout(resolve, 300));

                // Client deve ter sido removido após grace period
                assert.ok(!manager.hasClient('test-ip-expire'), 'Client should be removed after grace period');

                // Tentar criar novo client com IP diferente após grace period
                const client2 = await manager.newClient('test-ip-expire', { ip: differentIP });
                assert.equal(client2.id, 'test-ip-expire', 'Should allow after grace period expires');

                manager.removeClient('test-ip-expire');
            } finally {
                if (originalGracePeriod === undefined) {
                    delete process.env.LT_GRACE_PERIOD;
                } else {
                    process.env.LT_GRACE_PERIOD = originalGracePeriod;
                }
            }
        }).timeout(35000);
    });
});
