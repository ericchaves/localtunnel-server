import { hri } from 'human-readable-ids';
import Debug from 'debug';

import Client from './Client.js';
import TunnelAgent from './TunnelAgent.js';

// Manage sets of clients
//
// A client is a "user session" established to service a remote localtunnel client
class ClientManager {
    constructor(opt) {
        this.opt = opt || {};

        // id -> client instance
        this.clients = new Map();

        // statistics
        this.stats = {
            tunnels: 0
        };

        this.debug = Debug('lt:ClientManager');

        // This is totally wrong :facepalm: this needs to be per-client...
        this.graceTimeout = null;

        // Port range configuration for client TCP connections
        this.portRangeStart = this.opt.portRangeStart;
        this.portRangeEnd = this.opt.portRangeEnd;

        // Pool of available ports for clients
        this.availablePorts = [];
        this.usedPorts = new Set();

        // Initialize port pool if range is specified
        if (this.portRangeStart && this.portRangeEnd) {
            for (let port = this.portRangeStart; port <= this.portRangeEnd; port++) {
                this.availablePorts.push(port);
            }
            this.debug('initialized port pool: %d-%d (%d ports)',
                this.portRangeStart, this.portRangeEnd, this.availablePorts.length);
        }
    }

    // Get a port from the pool (if port range is configured)
    _getPort() {
        if (this.availablePorts.length === 0) {
            if (this.portRangeStart && this.portRangeEnd) {
                throw new Error('No available ports in range');
            }
            return undefined; // Let system assign random port
        }
        const port = this.availablePorts.shift();
        this.usedPorts.add(port);
        this.debug('assigned port %d from pool (%d remaining)', port, this.availablePorts.length);
        return port;
    }

    // Return a port to the pool
    _releasePort(port) {
        if (!port || !this.portRangeStart || !this.portRangeEnd) {
            return;
        }
        if (this.usedPorts.has(port)) {
            this.usedPorts.delete(port);
            this.availablePorts.push(port);
            this.debug('released port %d to pool (%d available)', port, this.availablePorts.length);
        }
    }

    // create a new tunnel with `id`
    // if the id is already used, a random id is assigned
    // if the tunnel could not be created, throws an error
    async newClient(id, options = {}) {
        const clients = this.clients;
        const stats = this.stats;
        const requestIP = options.ip;

        // Check if client ID already exists
        if (clients[id]) {
            const existingClient = clients[id];

            // Cliente existe e está no grace period (offline)
            if (existingClient.graceTimeout && !existingClient.isOnline) {
                this.debug('Client %s exists and is in grace period', id);

                // Verifica se é o IP original
                if (existingClient.originalIP === requestIP) {
                    this.debug('IP match (%s), allowing reconnection to subdomain: %s', requestIP, id);

                    // Remove client antigo (libera porta se necessário)
                    this.removeClient(id);

                    // Continua para criar novo client com mesmo ID
                    // (código de criação abaixo)
                } else {
                    // IP diferente - comportamento baseado em modo
                    const strictMode = process.env.LT_IP_VALIDATION_STRICT === 'true';

                    if (strictMode) {
                        this.debug('IP mismatch during grace period for %s: expected %s, got %s',
                                   id, existingClient.originalIP, requestIP);
                        const remainingTime = Math.ceil((30000 - (Date.now() - existingClient.createdAt)) / 1000);
                        throw new Error(`Subdomain "${id}" is reserved by another client. Try again in ${remainingTime}s or use a different subdomain.`);
                    } else {
                        // Modo silencioso: atribui ID aleatório
                        this.debug('IP mismatch for %s (expected: %s, got: %s), assigning random ID (silent mode)',
                                   id, existingClient.originalIP, requestIP);
                        id = hri.random();
                    }
                }
            } else {
                // Cliente existe e está online (não em grace period)
                // Comportamento atual: atribui ID aleatório
                this.debug('Client %s exists and is online, assigning random ID', id);
                id = hri.random();
            }
        }

        const maxSockets = this.opt.max_tcp_sockets;

        // Get port from pool if port range is configured
        const port = this._getPort();

        const agent = new TunnelAgent({
            clientId: id,
            maxSockets: 10,
            port: port,
        });

        const client = new Client({
            id,
            agent,
            originalIP: requestIP,
        });

        // add to clients map immediately
        // avoiding races with other clients requesting same id
        clients[id] = client;

        client.once('close', () => {
            this.removeClient(id);
        });

        // try/catch used here to remove client id
        try {
            const info = await agent.listen();
            ++stats.tunnels;
            return {
                id: id,
                port: info.port,
                max_conn_count: maxSockets,
            };
        }
        catch (err) {
            this.removeClient(id);
            // rethrow error for upstream to handle
            throw err;
        }
    }

    removeClient(id) {
        this.debug('removing client: %s', id);
        const client = this.clients[id];
        if (!client) {
            return;
        }

        // Release the port back to the pool
        const port = client.agent.port;
        this._releasePort(port);

        --this.stats.tunnels;
        delete this.clients[id];
        client.close();
    }

    hasClient(id) {
        return !!this.clients[id];
    }

    getClient(id) {
        return this.clients[id];
    }
}

export default ClientManager;
