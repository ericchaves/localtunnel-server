import log from 'book';
import Koa from 'koa';
import tldjs from 'tldjs';
import Debug from 'debug';
import http from 'http';
import { hri } from 'human-readable-ids';
import Router from 'koa-router';

import ClientManager from './lib/ClientManager.js';

const debug = Debug('localtunnel:server');

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

export default function(opt) {
    opt = opt || {};

    const validHosts = (opt.domain) ? [opt.domain] : undefined;
    const myTldjs = tldjs.fromUserSettings({ validHosts });
    const landingPage = opt.landing || 'https://localtunnel.github.io/www/';

    function GetClientIdFromHostname(hostname) {
        return myTldjs.getSubdomain(hostname);
    }

    const manager = new ClientManager(opt);

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

    debug('URL configuration: schema=%s, publicUrlPort=%d, defaultPort=%d',
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

        debug('Built public URL: %s (tunnelId=%s, hostname=%s, port=%d)',
              url, tunnelId, hostname, publicUrlPort);

        return url;
    }

    // Admin API app (for tunnel creation and management)
    const adminApp = new Koa();
    const adminRouter = new Router();

    // Admin API routes
    adminRouter.get('/api/status', async (ctx) => {
        debug('GET /api/status - Request received');
        const stats = manager.stats;
        ctx.body = {
            tunnels: stats.tunnels,
            mem: process.memoryUsage(),
        };
        debug('GET /api/status - Response: %d tunnels, %d MB memory', stats.tunnels, Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
    });

    adminRouter.get('/api/tunnels/:id/status', async (ctx) => {
        const clientId = ctx.params.id;
        debug('GET /api/tunnels/%s/status - Request received', clientId);
        const client = manager.getClient(clientId);
        if (!client) {
            debug('GET /api/tunnels/%s/status - Client not found', clientId);
            ctx.throw(404);
            return;
        }

        const stats = client.stats();
        ctx.body = {
            connected_sockets: stats.connectedSockets,
        };
        debug('GET /api/tunnels/%s/status - Response: %d connected sockets', clientId, stats.connectedSockets);
    });

    // root endpoint for tunnel creation
    adminRouter.get('/', async (ctx, next) => {
        const path = ctx.request.path;
        debug('GET / - Request received from %s, path: %s', ctx.request.ip, path);

        // skip anything not on the root path
        if (path !== '/') {
            debug('GET / - Path is not root, passing to next middleware');
            await next();
            return;
        }

        const isNewClientRequest = ctx.query['new'] !== undefined;
        if (isNewClientRequest) {
            const reqId = hri.random();
            const clientIP = getClientIP(ctx.request);
            debug('GET / - Making new client with random id: %s from IP: %s', reqId, clientIP);
            const info = await manager.newClient(reqId, { ip: clientIP });

            const url = buildPublicUrl(info.id, ctx.request.host);
            info.url = url;
            debug('GET / - New tunnel created: %s (port: %d)', url, info.port);
            ctx.body = info;
            return;
        }

        // no new client request, send to landing page
        debug('GET / - No new client request, redirecting to landing page: %s', landingPage);
        ctx.redirect(landingPage);
    });

    // anything after the / path is a request for a specific client name
    // This is a backwards compat feature
    adminRouter.get('/:id', async (ctx) => {
        const reqId = ctx.params.id;
        const clientIP = getClientIP(ctx.request);
        debug('GET /%s - Request received from %s (IP: %s) for custom subdomain', reqId, ctx.request.ip, clientIP);

        // limit requested hostnames to 63 characters
        if (! /^(?:[a-z0-9][a-z0-9\-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/.test(reqId)) {
            const msg = 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.';
            debug('GET /%s - Invalid subdomain format, rejecting request', reqId);
            ctx.status = 403;
            ctx.body = {
                message: msg,
            };
            return;
        }

        debug('GET /%s - Making new client with custom id from IP: %s', reqId, clientIP);

        try {
            const info = await manager.newClient(reqId, { ip: clientIP });

            const url = buildPublicUrl(info.id, ctx.request.host);
            info.url = url;
            debug('GET /%s - Custom tunnel created: %s (port: %d)', reqId, url, info.port);
            ctx.body = info;
            return;
        } catch (err) {
            // Handle IP mismatch error in strict mode
            if (err.message.includes('reserved by another client')) {
                debug('GET /%s - Subdomain reserved for different IP', reqId);
                ctx.status = 409;  // Conflict
                ctx.body = {
                    message: err.message,
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
        debug('Admin server - Request: %s %s from %s', req.method, req.url, req.socket.remoteAddress);
        adminCallback(req, res);
    });

    // Create main public server (for tunnel traffic)
    const server = http.createServer();

    server.on('request', (req, res) => {
        // without a hostname, we won't know who the request is for
        const hostname = req.headers.host;
        debug('Public server - Request: %s %s from %s, Host: %s', req.method, req.url, req.socket.remoteAddress, hostname);

        if (!hostname) {
            debug('Public server - Missing Host header, rejecting request');
            res.statusCode = 400;
            res.end('Host header is required');
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            // If no clientId, this might be an admin request on the main server
            // (when admin port is not specified separately)
            debug('Public server - No clientId found, treating as admin request');
            adminCallback(req, res);
            return;
        }

        debug('Public server - Routing to client: %s', clientId);
        const client = manager.getClient(clientId);
        if (!client) {
            debug('Public server - Client not found: %s', clientId);
            res.statusCode = 404;
            res.end('404');
            return;
        }

        debug('Public server - Handling request for client: %s', clientId);
        client.handleRequest(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
        const hostname = req.headers.host;
        debug('Public server - WebSocket upgrade request from %s, Host: %s', req.socket.remoteAddress, hostname);

        if (!hostname) {
            debug('Public server - WebSocket upgrade: Missing Host header, destroying socket');
            socket.destroy();
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            debug('Public server - WebSocket upgrade: No clientId found, destroying socket');
            socket.destroy();
            return;
        }

        debug('Public server - WebSocket upgrade: Routing to client: %s', clientId);
        const client = manager.getClient(clientId);
        if (!client) {
            debug('Public server - WebSocket upgrade: Client not found: %s, destroying socket', clientId);
            socket.destroy();
            return;
        }

        debug('Public server - WebSocket upgrade: Handling upgrade for client: %s', clientId);
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
