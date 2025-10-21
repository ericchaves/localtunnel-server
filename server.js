import Koa from 'koa';
import tldjs from 'tldjs';
import Debug from 'debug';
import http from 'http';
import { hri } from 'human-readable-ids';
import Router from 'koa-router';

import ClientManager from './lib/ClientManager.js';
import HmacAuthenticator from './lib/HmacAuthenticator.js';

const publicDebug = Debug('localtunnel:server:public');
const adminDebug = Debug('localtunnel:server:admin');

// Timeout Configuration
const WEBSOCKET_TIMEOUT = parseInt(process.env.LT_WEBSOCKET_TIMEOUT || '10000', 10);
const SOCKET_CHECK_INTERVAL = parseInt(process.env.LT_SOCKET_CHECK_INTERVAL || '100', 10);
publicDebug('Timeout configuration: WEBSOCKET_TIMEOUT=%dms, SOCKET_CHECK_INTERVAL=%dms', WEBSOCKET_TIMEOUT, SOCKET_CHECK_INTERVAL);

// Helper function to extract real client IP
function getClientIP(req) {
    const trustProxy = process.env.LT_TRUST_PROXY === 'true';

    if (trustProxy) {
        // Behind reverse proxy - use headers
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
               req.headers['x-real-ip'] ||
               req.socket.remoteAddress;
    } else {
        // Direct connection - use socket
        return req.socket.remoteAddress;
    }
}

// Helper function to extract client identifier (token or IP)
// Returns { type: 'token'|'ip', value: string }
function getClientIdentifier(req) {
    const clientToken = req.headers['x-lt-client-token'];

    // Validate token: must be non-empty string, max 256 chars, alphanumeric + hyphens + underscores
    if (clientToken && typeof clientToken === 'string' && clientToken.trim().length > 0) {
        const trimmedToken = clientToken.trim();

        // Length validation
        if (trimmedToken.length > 256) {
            adminDebug('Client token too long (%d chars), falling back to IP', trimmedToken.length);
            return { type: 'ip', value: getClientIP(req) };
        }

        // Format validation: alphanumeric, hyphens, underscores only
        if (!/^[a-zA-Z0-9_-]+$/.test(trimmedToken)) {
            adminDebug('Client token contains invalid characters, falling back to IP');
            return { type: 'ip', value: getClientIP(req) };
        }

        adminDebug('Using client token for identification: %s', trimmedToken);
        return { type: 'token', value: trimmedToken };
    }

    // No token or invalid token - fall back to IP
    const clientIP = getClientIP(req);
    return { type: 'ip', value: clientIP };
}

// Helper function to get complete socket information for logging
// Always shows socket IP:port, and real IP from headers when available
function getSocketInfo(req) {
    const socketIP = req.socket.remoteAddress;
    const socketPort = req.socket.remotePort;
    const socketInfo = `${socketIP}:${socketPort}`;

    // Check for proxy headers
    const forwardedFor = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    const realIP = req.headers['x-real-ip'];
    const headerIP = forwardedFor || realIP;

    // If there's a header IP and it's different from socket IP, show both
    if (headerIP && headerIP !== socketIP) {
        return `${socketInfo} (x-forwarded-for: ${headerIP})`;
    }

    return socketInfo;
}

// Helper to wait for client to come online
function waitForClientOnline(client, timeoutMs) {
    return new Promise((resolve) => {
        if (client.isOnline) {
            resolve(true);
            return;
        }

        const timeout = setTimeout(() => {
            client.removeListener('online', onlineHandler);
            resolve(false);
        }, timeoutMs);

        const onlineHandler = () => {
            clearTimeout(timeout);
            resolve(true);
        };

        client.once('online', onlineHandler);
    });
}

// Helper to wait for socket to become available
function waitForAvailableSocket(client, timeoutMs) {
    return new Promise((resolve) => {
        if (client.hasAvailableSockets()) {
            resolve(true);
            return;
        }

        const timeout = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);

        const checkInterval = setInterval(() => {
            if (client.hasAvailableSockets()) {
                cleanup();
                resolve(true);
            }
        }, SOCKET_CHECK_INTERVAL);

        const cleanup = () => {
            clearTimeout(timeout);
            clearInterval(checkInterval);
        };
    });
}

export default function(opt) {
    opt = opt || {};

    const validHosts = (opt.domain) ? [opt.domain] : undefined;
    const myTldjs = tldjs.fromUserSettings({ validHosts });
    const landingPage = opt.landing || 'https://localtunnel.github.io/www/';
    const retryAfter = opt.retryAfter || 5;

    function GetClientIdFromHostname(hostname) {
        return myTldjs.getSubdomain(hostname);
    }

    const manager = new ClientManager(opt);

    // Initialize HMAC authentication (if secret configured)
    let hmacAuth = null;
    if (process.env.LT_HMAC_SECRET || process.env.FILE_LT_HMAC_SECRET) {
        try {
            hmacAuth = new HmacAuthenticator({
                timestampTolerance: parseInt(process.env.LT_HMAC_TIMESTAMP_TOLERANCE || '60', 10),
                nonceThreshold: parseInt(process.env.LT_HMAC_NONCE_THRESHOLD || '3600', 10),
                nonceCacheTTL: parseInt(process.env.LT_HMAC_NONCE_CACHE_TTL || '7200', 10)
            });
            adminDebug('HMAC authentication enabled');
        } catch (err) {
            console.error('FATAL: Failed to initialize HMAC authenticator:', err.message);
            process.exit(1);
        }
    }

    // Middleware de autenticação HMAC
    async function requireHmacAuth(ctx, next) {
        if (!hmacAuth) {
            // HMAC não configurado, permite requisição
            return await next();
        }

        try {
            const result = await hmacAuth.validateRequest(ctx.request);

            if (!result.valid) {
                adminDebug('HMAC authentication failed: %s', result.reason);

                let message = result.debugMode ? result.reason : 'Invalid or expired authentication';

                // In debug mode, append details to message if available
                if (result.debugMode && result.details) {
                    message += `, ${result.details}`;
                }

                ctx.status = 401;
                ctx.body = {
                    error: 'Authentication failed',
                    message: message
                };
                return;
            }

            // Autenticação OK, continua
            await next();
        } catch (err) {
            adminDebug('HMAC authentication error: %s', err.message);
            ctx.status = 401;
            ctx.body = {
                error: 'Authentication failed',
                message: 'Invalid authentication'
            };
        }
    }

    const schema = opt.secure ? 'https' : 'http';

    // Determina porta pública para URLs geradas
    let publicUrlPort;

    if (opt.secure) {
        // HTTPS - usa LT_HTTPS_PROXY_PORT se definido, senão fallback para LT_PORT
        publicUrlPort = opt.httpsProxyPort !== undefined && !isNaN(opt.httpsProxyPort)
            ? opt.httpsProxyPort
            : opt.port;
    } else {
        // HTTP - usa LT_HTTP_PROXY_PORT se definido, senão fallback para LT_PORT
        publicUrlPort = opt.httpProxyPort !== undefined && !isNaN(opt.httpProxyPort)
            ? opt.httpProxyPort
            : opt.port;
    }

    const defaultPort = opt.secure ? 443 : 80;

    adminDebug('URL configuration: schema=%s, publicUrlPort=%d, defaultPort=%d',
          schema, publicUrlPort, defaultPort);

    // Função para construir URL pública correta
    function buildPublicUrl(tunnelId, requestHost) {
        // Remove a porta do host original (cliente pode ter conectado via porta admin)
        const hostname = requestHost.split(':')[0];

        // Constrói URL base
        let url = schema + '://' + tunnelId + '.' + hostname;

        // Adiciona porta apenas se não for a padrão
        if (publicUrlPort !== defaultPort) {
            url += ':' + publicUrlPort;
        }

        adminDebug('Built public URL: %s (tunnelId=%s, hostname=%s, port=%d)',
              url, tunnelId, hostname, publicUrlPort);

        return url;
    }

    // Admin API app (for tunnel creation and management)
    const adminApp = new Koa();
    const adminRouter = new Router();

    // Admin API routes
    adminRouter.get('/api/status', async (ctx) => {
        adminDebug('GET /api/status - Request received');
        const stats = manager.stats;
        ctx.body = {
            tunnels: stats.tunnels,
            mem: process.memoryUsage(),
        };
        adminDebug('GET /api/status - Response: %d tunnels, %d MB memory', stats.tunnels, Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
    });

    adminRouter.get('/api/tunnels/:id/status', async (ctx) => {
        const clientId = ctx.params.id;
        adminDebug('GET /api/tunnels/%s/status - Request received', clientId);
        const client = manager.getClient(clientId);
        if (!client) {
            adminDebug('GET /api/tunnels/%s/status - Client not found', clientId);
            ctx.throw(404);
            return;
        }

        const stats = client.stats();
        ctx.body = {
            connected_sockets: stats.connectedSockets,
        };
        adminDebug('GET /api/tunnels/%s/status - Response: %d connected sockets', clientId, stats.connectedSockets);
    });

    // root endpoint for tunnel creation
    adminRouter.get('/', requireHmacAuth, async (ctx, next) => {
        const path = ctx.request.path;
        adminDebug('GET / - Request received from %s, path: %s', ctx.request.ip, path);

        // skip anything not on the root path
        if (path !== '/') {
            adminDebug('GET / - Path is not root, passing to next middleware');
            await next();
            return;
        }

        const isNewClientRequest = ctx.query['new'] !== undefined;
        if (isNewClientRequest) {
            const reqId = hri.random();
            const clientIP = getClientIP(ctx.request);
            const identifier = getClientIdentifier(ctx.request);
            adminDebug('GET / - Making new client with random id: %s from IP: %s (identifier: %s=%s)',
                      reqId, clientIP, identifier.type, identifier.value);
            const info = await manager.newClient(reqId, { ip: clientIP, identifier: identifier });

            const url = buildPublicUrl(info.id, ctx.request.host);
            info.url = url;
            adminDebug('GET / - New tunnel created: %s (port: %d)', url, info.port);
            ctx.body = info;
            return;
        }

        // no new client request, send to landing page
        adminDebug('GET / - No new client request, redirecting to landing page: %s', landingPage);
        ctx.redirect(landingPage);
    });

    // anything after the / path is a request for a specific client name
    // This is a backwards compat feature
    adminRouter.get('/:id', requireHmacAuth, async (ctx) => {
        const reqId = ctx.params.id;
        const clientIP = getClientIP(ctx.request);
        const identifier = getClientIdentifier(ctx.request);
        adminDebug('GET /%s - Request received from %s (IP: %s, identifier: %s=%s) for custom subdomain',
                  reqId, ctx.request.ip, clientIP, identifier.type, identifier.value);

        // limit requested hostnames to 63 characters
        if (! /^(?:[a-z0-9][a-z0-9\-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/.test(reqId)) {
            const msg = 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.';
            adminDebug('GET /%s - Invalid subdomain format, rejecting request', reqId);
            ctx.status = 403;
            ctx.body = {
                message: msg,
            };
            return;
        }

        adminDebug('GET /%s - Making new client with custom id from IP: %s (identifier: %s=%s)',
                  reqId, clientIP, identifier.type, identifier.value);

        try {
            const info = await manager.newClient(reqId, { ip: clientIP, identifier: identifier });

            const url = buildPublicUrl(info.id, ctx.request.host);
            info.url = url;
            adminDebug('GET /%s - Custom tunnel created: %s (port: %d)', reqId, url, info.port);
            ctx.body = info;
            return;
        } catch (err) {
            // Handle IP mismatch error in strict mode
            if (err.message.includes('reserved by another client')) {
                adminDebug('GET /%s - Subdomain reserved for different IP', reqId);
                ctx.status = 409;  // Conflict
                ctx.body = {
                    error: 'Subdomain reserved',
                    message: err.message
                };
                return;
            }
            throw err;
        }
    });

    adminApp.use(adminRouter.routes());
    adminApp.use(adminRouter.allowedMethods());

    // Create admin server (for tunnel creation and management)
    const adminServer = http.createServer();
    const adminCallback = adminApp.callback();

    // Admin server only handles tunnel creation requests
    adminServer.on('request', (req, res) => {
        adminDebug('Request: %s %s from %s', req.method, req.url, getSocketInfo(req));
        adminCallback(req, res);
    });

    // Create main public server (for tunnel traffic)
    const server = http.createServer();

    server.on('request', (req, res) => {
        // do not log healthz to prevent flooding console logs
        if (req.url === '/healthz') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'healthy' }));
          return;
        } 

        // without a hostname, we won't know who the request is for
        const hostname = req.headers.host;
        publicDebug('Request: %s %s from %s, Host: %s', req.method, req.url, getSocketInfo(req), hostname);

        if (!hostname) {
            publicDebug('Missing Host header, rejecting request');
            res.statusCode = 400;
            res.end('Host header is required');
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            // If no clientId, this might be an admin request on the main server
            // (when admin port is not specified separately)
            publicDebug('No clientId found, treating as admin request');
            adminCallback(req, res);
            return;
        }

        publicDebug('Routing to client: %s', clientId);
        const client = manager.getClient(clientId);

        // CASE 1: Client does not exist
        if (!client) {
            publicDebug('Client not found: %s - Responding 404 Tunnel Not Found', clientId);
            res.statusCode = 404;
            res.statusMessage = 'Tunnel Not Found';
            res.end();
            return;
        }

        // CASE 2: Client exists but is offline (grace period)
        if (!client.isOnline && client.graceTimeout) {
            const remaining = Math.ceil(client.getGracePeriodRemaining() / 1000);
            publicDebug('Client %s offline (grace period: %ds remaining) - Responding 503 Service Temporarily Unavailable, Retry-After: %d',
                  clientId, remaining, remaining);
            res.statusCode = 503;
            res.statusMessage = 'Service Temporarily Unavailable';
            res.setHeader('Retry-After', remaining.toString());
            res.end();
            return;
        }

        // CASE 3: Client online but no sockets available
        if (client.isOnline && !client.hasAvailableSockets()) {
            publicDebug('Client %s busy (0 available sockets) - Responding 503 Service Unavailable, Retry-After: %d', clientId, retryAfter);
            res.statusCode = 503;
            res.statusMessage = 'Service Unavailable';
            res.setHeader('Retry-After', retryAfter.toString());
            res.end();
            return;
        }

        // CASE 4: Client online with sockets - process normally
        publicDebug('Handling request for client: %s', clientId);
        client.handleRequest(req, res);
    });

    server.on('upgrade', async (req, socket, head) => {
        const hostname = req.headers.host;
        publicDebug('WebSocket upgrade request from %s, Host: %s', getSocketInfo(req), hostname);

        // Helper to send HTTP response before upgrade
        const respondAndClose = (statusCode, statusMessage, retryAfter = null) => {
            const headers = [
                `HTTP/1.1 ${statusCode} ${statusMessage}`,
                'Connection: close',
            ];
            if (retryAfter) {
                headers.push(`Retry-After: ${retryAfter}`);
            }
            headers.push('', '');
            socket.write(headers.join('\r\n'));
            socket.end();
        };

        if (!hostname) {
            publicDebug('WebSocket upgrade: Missing Host header, destroying socket');
            socket.destroy();
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            publicDebug('WebSocket upgrade: No clientId found, destroying socket');
            socket.destroy();
            return;
        }

        publicDebug('WebSocket upgrade: Routing to client: %s', clientId);
        const client = manager.getClient(clientId);

        // CASE 5: Client does not exist
        if (!client) {
            publicDebug('WebSocket upgrade - Client not found: %s - Responding 404 Tunnel Not Found', clientId);
            respondAndClose(404, 'Tunnel Not Found');
            return;
        }

        // CASE 6: Client offline (grace period) - WAIT for reconnection
        if (!client.isOnline && client.graceTimeout) {
            const gracePeriodRemaining = client.getGracePeriodRemaining();
            const waitTime = Math.min(WEBSOCKET_TIMEOUT, gracePeriodRemaining);

            publicDebug('WebSocket upgrade - Client %s offline, waiting up to %dms for reconnection', clientId, waitTime);

            // Wait for client to come online
            const reconnected = await waitForClientOnline(client, waitTime);

            if (reconnected) {
                publicDebug('WebSocket upgrade - Client %s reconnected, proceeding with upgrade', clientId);
                // Continue to normal processing below
            } else {
                const remaining = Math.ceil(client.getGracePeriodRemaining() / 1000);
                publicDebug('WebSocket upgrade - Client %s timeout (%dms), Responding 503 Service Temporarily Unavailable, Retry-After: %d',
                      clientId, waitTime, remaining);
                respondAndClose(503, 'Service Temporarily Unavailable', remaining.toString());
                return;
            }
        }

        // CASE 7: Client online but no sockets - WAIT for socket
        if (client.isOnline && !client.hasAvailableSockets()) {
            publicDebug('WebSocket upgrade - Client %s has no available sockets, waiting up to %dms', clientId, WEBSOCKET_TIMEOUT);

            const socketAvailable = await waitForAvailableSocket(client, WEBSOCKET_TIMEOUT);

            if (socketAvailable) {
                publicDebug('WebSocket upgrade - Client %s socket available, proceeding with upgrade', clientId);
                // Continue to normal processing below
            } else {
                publicDebug('WebSocket upgrade - Client %s timeout (%dms), Responding 503 Service Unavailable, Retry-After: %d',
                      clientId, WEBSOCKET_TIMEOUT, retryAfter);
                respondAndClose(503, 'Service Unavailable', retryAfter.toString());
                return;
            }
        }

        // Process upgrade normally
        publicDebug('WebSocket upgrade: Handling upgrade for client: %s', clientId);
        client.handleUpgrade(req, socket);
    });

    // Return both servers
    // - server: main public server for tunnel traffic
    // - adminServer: administrative server for tunnel creation and management
    return {
        server,
        adminServer,
    };
};
