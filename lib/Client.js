import http from 'http';
import Debug from 'debug';
import pump from 'pump';
import EventEmitter from 'events';

const debug = Debug('localtunnel:client');

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

const GRACE_PERIOD = getGracePeriod();

// A client encapsulates req/res handling using an agent
//
// If an agent is destroyed, the request handling will error
// The caller is responsible for handling a failed request
class Client extends EventEmitter {
    constructor(options) {
        super();

        const agent = this.agent = options.agent;
        const id = this.id = options.id;

        this.debug = Debug(`lt:Client[${this.id}]`);
        this.isOnline = false;
        this.originalIP = options.originalIP || null;
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
        this.debug('grace period started: %dms', GRACE_PERIOD);
        this.graceTimeout = setTimeout(() => {
            this.debug('grace period expired, removing client');
            this.close();
        }, GRACE_PERIOD).unref();
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
        this.debug('> %s', req.url);
        const opt = {
            path: req.url,
            agent: this.agent,
            method: req.method,
            headers: req.headers
        };

        const clientReq = http.request(opt, (clientRes) => {
            this.debug('< %s', req.url);
            // write response code and headers
            res.writeHead(clientRes.statusCode, clientRes.headers);

            // using pump is deliberate - see the pump docs for why
            pump(clientRes, res);
        });

        // this can happen when underlying agent produces an error
        // in our case we 504 gateway error this?
        // if we have already sent headers?
        clientReq.once('error', (err) => {
            // TODO(roman): if headers not sent - respond with gateway unavailable
        });

        // using pump is deliberate - see the pump docs for why
        pump(req, clientReq);
    }

    handleUpgrade(req, socket) {
        this.debug('> [up] %s', req.url);
        socket.once('error', (err) => {
            // These client side errors can happen if the client dies while we are reading
            // We don't need to surface these in our logs.
            if (err.code == 'ECONNRESET' || err.code == 'ETIMEDOUT') {
                return;
            }
            this.debug('ERROR: %s', err.message);
        });

        this.agent.createConnection({}, (err, conn) => {
            this.debug('< [up] %s', req.url);
            // any errors getting a connection mean we cannot service this request
            if (err) {
                socket.end();
                return;
            }

            // socket met have disconnected while we waiting for a socket
            if (!socket.readable || !socket.writable) {
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