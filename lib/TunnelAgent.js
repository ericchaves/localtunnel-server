import { Agent } from 'http';
import net from 'net';
import assert from 'assert';
import log from 'book';
import Debug from 'debug';

const DEFAULT_MAX_SOCKETS = 10;

// Helper function to get TCP socket information for logging
function getTcpSocketInfo(socket) {
    const remoteIP = socket.remoteAddress;
    const remotePort = socket.remotePort;
    const localIP = socket.localAddress;
    const localPort = socket.localPort;

    if (!remoteIP || !remotePort) {
        return 'unknown';
    }

    return `${remoteIP}:${remotePort} -> ${localIP}:${localPort}`;
}

// Implements an http.Agent interface to a pool of tunnel sockets
// A tunnel socket is a connection _from_ a client that will
// service http requests. This agent is usable wherever one can use an http.Agent
class TunnelAgent extends Agent {
    constructor(options = {}) {
        super({
            keepAlive: true,
            // only allow keepalive to hold on to one socket
            // this prevents it from holding on to all the sockets so they can be used for upgrades
            maxFreeSockets: 1,
        });

        // sockets we can hand out via createConnection
        this.availableSockets = [];

        // when a createConnection cannot return a socket, it goes into a queue
        // once a socket is available it is handed out to the next callback
        this.waitingCreateConn = [];

        this.debug = Debug(`localtunnel:tunnelagent:[${options.clientId}]`);

        // track maximum allowed sockets
        this.connectedSockets = 0;
        this.maxTcpSockets = options.maxTcpSockets || DEFAULT_MAX_SOCKETS;
        this.rejectedConnections = 0; // track rejected connections for monitoring

        // specific port for this tunnel (optional)
        this.port = options.port;

        // new tcp server to service requests for this client
        this.server = net.createServer();

        // flag to avoid double starts
        this.started = false;
        this.closed = false;
    }

    stats() {
        return {
            connectedSockets: this.connectedSockets,
            rejectedConnections: this.rejectedConnections,
            availableSockets: this.availableSockets.length,
            waitingRequests: this.waitingCreateConn.length,
        };
    }

    listen() {
        const server = this.server;
        if (this.started) {
            throw new Error('already started');
        }
        this.started = true;

        server.on('close', this._onClose.bind(this));
        server.on('connection', this._onConnection.bind(this));
        server.on('error', (err) => {
            // These errors happen from killed connections, we don't worry about them
            if (err.code == 'ECONNRESET' || err.code == 'ETIMEDOUT') {
                return;
            }
            log.error(err);
        });

        return new Promise((resolve, reject) => {
            const listenHandler = () => {
                const port = server.address().port;
                this.debug('tcp server listening on port: %d', port);

                resolve({
                    // port for lt client tcp connections
                    port: port,
                });
            };

            // if a specific port is provided, listen on that port
            // otherwise, listen on a random available port
            if (this.port) {
                server.listen(this.port, listenHandler);
            } else {
                server.listen(listenHandler);
            }
        });
    }

    _onClose() {
        this.closed = true;
        this.debug('closed tcp socket');
        // flush any waiting connections
        for (const conn of this.waitingCreateConn) {
            conn(new Error('closed'), null);
        }
        this.waitingCreateConn = [];
        this.emit('end');
    }

    // new socket connection from client for tunneling requests to client
    _onConnection(socket) {
        // no more socket connections allowed
        if (this.connectedSockets >= this.maxTcpSockets) {
            this.rejectedConnections++;

            // Log every 10 rejections to avoid spam, but always log the first one
            if (this.rejectedConnections === 1 || this.rejectedConnections % 10 === 0) {
                this.debug('rejected %d connections (max sockets: %d, current: %d, available: %d, waiting: %d)',
                    this.rejectedConnections,
                    this.maxTcpSockets,
                    this.connectedSockets,
                    this.availableSockets.length,
                    this.waitingCreateConn.length
                );
            }

            // Send a message to the client before destroying the socket
            // This helps with client debugging
            try {
                const payload = JSON.stringify({
                    error: 'Too Many Connections',
                    code: 429,
                    max_sockets: this.maxTcpSockets,
                    current_sockets: this.connectedSockets,
                    available_sockets: this.availableSockets.length,
                    waiting_requests: this.waitingCreateConn.length
                });

                socket.write('HTTP/1.1 429 Too Many Connections\r\n');
                socket.write('Content-Type: application/json\r\n');
                socket.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n`);
                socket.write(`X-LT-Max-Sockets: ${this.maxTcpSockets}\r\n`);
                socket.write(`X-LT-Current-Sockets: ${this.connectedSockets}\r\n`);
                socket.write(`X-LT-Available-Sockets: ${this.availableSockets.length}\r\n`);
                socket.write(`X-LT-Waiting-Requests: ${this.waitingCreateConn.length}\r\n`);
                socket.write('Connection: close\r\n');
                socket.write('\r\n');
                socket.write(payload);
                socket.end();
            } catch (err) {
                socket.destroy();
            }
            return false;
        }

        const socketInfo = getTcpSocketInfo(socket);

        socket.once('close', (hadError) => {
            this.debug('closed socket %s (error: %s)', socketInfo, hadError);
            this.connectedSockets -= 1;
            // remove the socket from available list
            const idx = this.availableSockets.indexOf(socket);
            if (idx >= 0) {
                this.availableSockets.splice(idx, 1);
            }

            this.debug('connected sockets: %s', this.connectedSockets);
            if (this.connectedSockets <= 0) {
                this.debug('all sockets disconnected');
                this.emit('offline');
            }
        });

        // close will be emitted after this
        socket.once('error', (err) => {
            // we do not log these errors, sessions can drop from clients for many reasons
            // these are not actionable errors for our server
            socket.destroy();
        });

        if (this.connectedSockets === 0) {
            this.emit('online');
        }

        this.connectedSockets += 1;
        this.debug('new connection: %s', socketInfo);

        // if there are queued callbacks, give this socket now and don't queue into available
        const fn = this.waitingCreateConn.shift();
        if (fn) {
            this.debug('giving socket %s to queued conn request', socketInfo);
            setTimeout(() => {
                fn(null, socket);
            }, 0);
            return;
        }

        // make socket available for those waiting on sockets
        this.availableSockets.push(socket);
        this.debug('socket %s added to available pool (total: %d)', socketInfo, this.availableSockets.length);
    }

    // fetch a socket from the available socket pool for the agent
    // if no socket is available, queue
    // cb(err, socket)
    createConnection(options, cb) {
        if (this.closed) {
            cb(new Error('closed'));
            return;
        }

        this.debug('create connection requested');

        // socket is a tcp connection back to the user hosting the site
        const sock = this.availableSockets.shift();

        // no available sockets
        // wait until we have one
        if (!sock) {
            this.waitingCreateConn.push(cb);
            this.debug('no socket available - queuing request (connected: %d, available: %d, waiting: %d)',
                       this.connectedSockets, this.availableSockets.length, this.waitingCreateConn.length);
            return;
        }

        const sockInfo = getTcpSocketInfo(sock);
        this.debug('socket %s given from pool (remaining: %d)', sockInfo, this.availableSockets.length);
        cb(null, sock);
    }

    destroy() {
        this.server.close();
        super.destroy();
    }
}

export default TunnelAgent;
