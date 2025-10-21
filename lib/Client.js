import http from 'http';
import Debug from 'debug';
import pump from 'pump';
import EventEmitter from 'events';

const debug = Debug('localtunnel:client');

// Helper function to get HTTP request socket information for logging
function getHttpSocketInfo(req) {
    if (!req || !req.socket) {
        return 'unknown';
    }
    const remoteIP = req.socket.remoteAddress;
    const remotePort = req.socket.remotePort;
    return remoteIP && remotePort ? `${remoteIP}:${remotePort}` : 'unknown';
}

// Helper function to get raw socket information for logging
function getSocketInfo(socket) {
    if (!socket) {
        return 'unknown';
    }
    const remoteIP = socket.remoteAddress;
    const remotePort = socket.remotePort;
    return remoteIP && remotePort ? `${remoteIP}:${remotePort}` : 'unknown';
}

// Grace Period Configuration
function getMaxGracePeriod() {
    const envValue = process.env.LT_MAX_GRACE_PERIOD;

    if (envValue === undefined || envValue === null || envValue === '') {
        return 300000;  // 5 minutes default
    }

    const parsed = parseInt(envValue, 10);

    if (isNaN(parsed) || parsed <= 0) {
        debug('WARN: Invalid LT_MAX_GRACE_PERIOD value: "%s", using default: 300000ms', envValue);
        return 300000;
    }

    return parsed;
}

const MAX_GRACE_PERIOD = getMaxGracePeriod();
const DEFAULT_GRACE_PERIOD = 30000;  // Default: 30 seconds (allows HTTP reconnections, IP-based reservation)

function getGracePeriod() {
    const envValue = process.env.LT_GRACE_PERIOD;

    // Absence of variable = immediate removal (default behavior)
    if (envValue === undefined || envValue === null || envValue === '') {
        debug('Grace period not configured, using default: %dms (immediate removal)', DEFAULT_GRACE_PERIOD);
        return DEFAULT_GRACE_PERIOD;
    }

    const parsed = parseInt(envValue, 10);

    // Validation: invalid value
    if (isNaN(parsed)) {
        debug('ERROR: Invalid LT_GRACE_PERIOD value: "%s", must be a number. Using default: %dms', envValue, DEFAULT_GRACE_PERIOD);
        return DEFAULT_GRACE_PERIOD;
    }

    // Validation: negative value
    if (parsed < 0) {
        debug('ERROR: Invalid LT_GRACE_PERIOD value: %d, must be >= 0. Using default: %dms', parsed, DEFAULT_GRACE_PERIOD);
        return DEFAULT_GRACE_PERIOD;
    }

    // Validation: value exceeds maximum
    if (parsed > MAX_GRACE_PERIOD) {
        debug('WARN: LT_GRACE_PERIOD %dms exceeds maximum %dms, clamping to maximum', parsed, MAX_GRACE_PERIOD);
        return MAX_GRACE_PERIOD;
    }

    // Valid value - allow any value >= 0, including values below DEFAULT for testing
    debug('Grace period configured: %dms', parsed);
    return parsed;
}

// Note: GRACE_PERIOD is called dynamically to allow runtime configuration changes (useful for testing)
const getGracePeriodValue = () => getGracePeriod();

// Request Timeout Configuration
function getRequestTimeout() {
    const envValue = process.env.LT_REQUEST_TIMEOUT;

    if (envValue === undefined || envValue === null || envValue === '') {
        return 5000;  // 5 seconds default
    }

    const parsed = parseInt(envValue, 10);

    if (isNaN(parsed) || parsed <= 0) {
        debug('WARN: Invalid LT_REQUEST_TIMEOUT value: "%s", using default: 5000ms', envValue);
        return 5000;
    }

    return parsed;
}

function getWebSocketTimeout() {
    const envValue = process.env.LT_WEBSOCKET_TIMEOUT;

    if (envValue === undefined || envValue === null || envValue === '') {
        return 10000;  // 10 seconds default
    }

    const parsed = parseInt(envValue, 10);

    if (isNaN(parsed) || parsed <= 0) {
        debug('WARN: Invalid LT_WEBSOCKET_TIMEOUT value: "%s", using default: 10000ms', envValue);
        return 10000;
    }

    return parsed;
}

const REQUEST_TIMEOUT = getRequestTimeout();
const WEBSOCKET_TIMEOUT = getWebSocketTimeout();

function getRetryAfter() {
    const envValue = process.env.LT_RETRY_AFTER;

    if (envValue === undefined || envValue === null || envValue === '') {
        return 5;  // 5 seconds default
    }

    const parsed = parseInt(envValue, 10);

    if (isNaN(parsed) || parsed <= 0) {
        debug('WARN: Invalid LT_RETRY_AFTER value: "%s", using default: 5', envValue);
        return 5;
    }

    return parsed;
}

const RETRY_AFTER = getRetryAfter();

debug('Timeout configuration: REQUEST_TIMEOUT=%dms, WEBSOCKET_TIMEOUT=%dms', REQUEST_TIMEOUT, WEBSOCKET_TIMEOUT);

// A client encapsulates req/res handling using an agent
//
// If an agent is destroyed, the request handling will error
// The caller is responsible for handling a failed request
class Client extends EventEmitter {
    constructor(options) {
        super();

        const agent = this.agent = options.agent;
        const id = this.id = options.id;

        this.debug = Debug(`localtunnel:client:[${this.id}]`);
        this.isOnline = false;
        this.originalIP = options.originalIP || null;
        // Client identifier: { type: 'token'|'ip', value: string }
        this.identifier = options.identifier || { type: 'ip', value: this.originalIP };
        this.createdAt = Date.now();

        agent.on('online', () => {
            this.debug('client online %s', id);
            this.isOnline = true;
            this._clearGracePeriod();
        });

        agent.on('offline', () => {
            this.debug('client offline %s', id);
            this.isOnline = false;

            // If there was a previous timeout set, we don't want to double trigger
            this._clearGracePeriod();

            // Client is given a grace period in which they can re-connect before they are removed
            this._setGracePeriod();
        });

        // TODO(roman): an agent error removes the client, the user needs to re-connect?
        // how does a user realize they need to re-connect vs some random client being assigned same port?
        agent.once('error', (err) => {
            this.debug('ERROR: %s', err.message);
            this.close();
        });

        // Client is given a grace period in which they can connect before they are removed
        // This is set after event listeners so that online events can cancel it
        // Use setImmediate to allow synchronous online events to be processed first
        setImmediate(() => {
            // Only set grace period if client hasn't gone online yet
            if (!this.isOnline) {
                this._setGracePeriod();
            }
        });
    }

    _clearGracePeriod() {
        if (this.graceTimeout) {
            clearTimeout(this.graceTimeout);
            this.graceTimeout = null;
        }
    }

    _setGracePeriod() {
        const gracePeriod = getGracePeriodValue();
        this.debug('grace period started: %dms', gracePeriod);
        this.graceTimeout = setTimeout(() => {
            this.debug('grace period expired, removing client');
            this.close();
        }, gracePeriod).unref();
    }

    hasAvailableSockets() {
        return this.agent &&
               this.agent.availableSockets &&
               this.agent.availableSockets.length > 0;
    }

    getGracePeriodRemaining() {
        if (!this.graceTimeout || !this.createdAt) {
            return 0;
        }
        const elapsed = Date.now() - this.createdAt;
        const gracePeriod = getGracePeriodValue();
        return Math.max(0, gracePeriod - elapsed);
    }

    stats() {
        return this.agent.stats();
    }

    close() {
        this._clearGracePeriod();
        this.agent.destroy();
        this.emit('close');
    }

    handleRequest(req, res) {
        const reqSocketInfo = getHttpSocketInfo(req);
        this.debug('> %s %s from %s', req.method, req.url, reqSocketInfo);
        const opt = {
            path: req.url,
            agent: this.agent,
            method: req.method,
            headers: req.headers
        };

        const clientReq = http.request(opt, (clientRes) => {
            this.debug('< %s %s from %s (status: %d)', req.method, req.url, reqSocketInfo, clientRes.statusCode);
            // write response code and headers
            res.writeHead(clientRes.statusCode, clientRes.headers);

            // using pump is deliberate - see the pump docs for why
            pump(clientRes, res);
        });

        // Implement timeout for request
        const timeout = setTimeout(() => {
            this.debug('Request timeout after %dms for %s from %s - destroying request', REQUEST_TIMEOUT, req.url, reqSocketInfo);
            clientReq.destroy(new Error('Request timeout'));
        }, REQUEST_TIMEOUT);

        clientReq.once('error', (err) => {
            clearTimeout(timeout);

            // If headers already sent, cannot respond
            if (res.headersSent) {
                this.debug('Request error after headers sent for %s from %s: %s', req.url, reqSocketInfo, err.message);
                return;
            }

            // Respond with 503 Service Unavailable
            this.debug('Request error for %s from %s: %s - responding 503', req.url, reqSocketInfo, err.message);
            res.statusCode = 503;
            res.statusMessage = 'Service Unavailable';
            res.setHeader('Retry-After', RETRY_AFTER.toString());
            res.end();
        });

        clientReq.once('response', () => {
            clearTimeout(timeout);
        });

        // using pump is deliberate - see the pump docs for why
        pump(req, clientReq);
    }

    handleUpgrade(req, socket) {
        const socketInfo = getSocketInfo(socket);
        this.debug('> [up] %s from %s', req.url, socketInfo);

        socket.once('error', (err) => {
            // These client side errors can happen if the client dies while we are reading
            // We don't need to surface these in our logs.
            if (err.code == 'ECONNRESET' || err.code == 'ETIMEDOUT') {
                return;
            }
            this.debug('WebSocket error from %s: %s', socketInfo, err.message);
        });

        // Implement timeout for WebSocket upgrade
        const timeout = setTimeout(() => {
            this.debug('WebSocket upgrade timeout after %dms for %s from %s', WEBSOCKET_TIMEOUT, req.url, socketInfo);
            socket.end();
        }, WEBSOCKET_TIMEOUT);

        this.agent.createConnection({}, (err, conn) => {
            clearTimeout(timeout);

            this.debug('< [up] %s from %s', req.url, socketInfo);
            // any errors getting a connection mean we cannot service this request
            if (err) {
                this.debug('WebSocket upgrade error for %s from %s: %s', req.url, socketInfo, err.message);
                socket.end();
                return;
            }

            // socket may have disconnected while we waiting for a socket
            if (!socket.readable || !socket.writable) {
                this.debug('WebSocket socket %s closed while waiting', socketInfo);
                conn.destroy();
                socket.end();
                return;
            }

            // websocket requests are special in that we simply re-create the header info
            // then directly pipe the socket data
            // avoids having to rebuild the request and handle upgrades via the http client
            const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i=0 ; i < (req.rawHeaders.length-1) ; i+=2) {
                arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}`);
            }

            arr.push('');
            arr.push('');

            // using pump is deliberate - see the pump docs for why
            pump(conn, socket);
            pump(socket, conn);
            conn.write(arr.join('\r\n'));
        });
    }
}

export default Client;