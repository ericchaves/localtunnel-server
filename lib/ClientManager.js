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

        this.debug = Debug('localtunnel:clientmanager');

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
        // Identifier can be token-based or IP-based
        const identifier = options.identifier || { type: 'ip', value: requestIP };

        // Detailed logging for debugging
        const strictMode = process.env.LT_IP_VALIDATION_STRICT === 'true';
        const gracePeriod = process.env.LT_GRACE_PERIOD || '30000';
        const trustProxy = process.env.LT_TRUST_PROXY === 'true';

        this.debug('newClient called with: requestedId=%s, requestIP=%s, identifierType=%s',
                   id, requestIP, identifier.type);
        this.debug('Configuration: strictMode=%s, gracePeriod=%sms, trustProxy=%s', strictMode, gracePeriod, trustProxy);
        this.debug('Existing client check: clientExists=%s', !!clients[id]);

        // Check if client ID already exists
        if (clients[id]) {
            const existingClient = clients[id];
            const clientAge = Date.now() - existingClient.createdAt;
            const gracePeriodRemaining = existingClient.getGracePeriodRemaining();

            this.debug('Existing client details: id=%s, isOnline=%s, hasGraceTimeout=%s, identifierType=%s, identifierValue=%s, age=%dms, gracePeriodRemaining=%dms',
                       id, existingClient.isOnline, !!existingClient.graceTimeout,
                       existingClient.identifier.type, existingClient.identifier.value, clientAge, gracePeriodRemaining);

            // Cliente existe e está no grace period (offline)
            if (existingClient.graceTimeout && !existingClient.isOnline) {
                this.debug('Client %s exists and is in grace period', id);

                // Check if identifier matches (token or IP)
                const identifierMatch = existingClient.identifier.type === identifier.type &&
                                       existingClient.identifier.value === identifier.value;

                if (identifierMatch) {
                    this.debug('%s match (%s=%s), allowing reconnection to subdomain: %s',
                              identifier.type.toUpperCase(), identifier.type, identifier.value, id);

                    // Remove client antigo (libera porta se necessário)
                    this.removeClient(id);

                    // Continua para criar novo client com mesmo ID
                    // (código de criação abaixo)
                } else {
                    // Identifier mismatch - comportamento baseado em modo
                    const strictMode = process.env.LT_IP_VALIDATION_STRICT === 'true';

                    if (strictMode) {
                        this.debug('%s mismatch during grace period for %s: expected %s=%s, got %s=%s',
                                   identifier.type.toUpperCase(), id,
                                   existingClient.identifier.type, existingClient.identifier.value,
                                   identifier.type, identifier.value);
                        const remainingTime = Math.ceil(existingClient.getGracePeriodRemaining() / 1000);
                        throw new Error(`Subdomain "${id}" is reserved by another client. Try again in ${remainingTime}s or use a different subdomain.`);
                    } else {
                        // Modo silencioso: atribui ID aleatório
                        this.debug('%s mismatch for %s (expected: %s=%s, got: %s=%s), assigning random ID (silent mode)',
                                   identifier.type.toUpperCase(), id,
                                   existingClient.identifier.type, existingClient.identifier.value,
                                   identifier.type, identifier.value);
                        id = hri.random();
                    }
                }
            } else {
                // Cliente existe e está online (não em grace period)
                // Check if identifier matches (same token/IP trying to reconnect)
                const identifierMatch = existingClient.identifier.type === identifier.type &&
                                       existingClient.identifier.value === identifier.value;

                if (identifierMatch) {
                    // Same client (same token) trying to reconnect
                    // Allow reconnection by closing old client
                    this.debug('%s match (%s=%s), allowing reconnection by replacing online client: %s',
                              identifier.type.toUpperCase(), identifier.type, identifier.value, id);

                    // Remove old client (will close all sockets and free port)
                    this.removeClient(id);

                    // Continue to create new client with same ID (code below)
                } else {
                    // Different client trying to use same subdomain
                    // Assign random ID
                    this.debug('Client %s exists and is online, but %s mismatch (%s vs %s), assigning random ID',
                              id, identifier.type, existingClient.identifier.value, identifier.value);
                    id = hri.random();
                }
            }
        }

        const maxSockets = this.opt.max_tcp_sockets;

        // Get port from pool if port range is configured
        const port = this._getPort();

        const agent = new TunnelAgent({
            clientId: id,
            maxTcpSockets: maxSockets,
            port: port,
        });

        const client = new Client({
            id,
            agent,
            originalIP: requestIP,
            identifier: identifier,
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
            this.debug('Client created successfully: finalId=%s, assignedPort=%d, originalIP=%s, totalTunnels=%d',
                       id, info.port, requestIP, stats.tunnels);
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
