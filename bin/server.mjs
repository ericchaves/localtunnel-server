#!/usr/bin/env node

import 'localenv';
import minimist from 'minimist';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import log from 'book';
import Debug from 'debug';

import CreateServer from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

const debug = Debug('localtunnel');

const argv = minimist(process.argv.slice(2), {
    string: ['address', 'domain', 'landing', 'admin-address'],
    boolean: ['secure', 'help'],
    default: {
        secure: process.env.LT_SECURE === 'true' || false,
        port: process.env.LT_PORT || '80',
        address: process.env.LT_ADDRESS || '0.0.0.0',
        domain: process.env.LT_DOMAIN,
        'max-sockets': parseInt(process.env.LT_MAX_SOCKETS) || 10,
        'admin-port': process.env.LT_ADMIN_PORT,
        'admin-address': process.env.LT_ADMIN_ADDRESS || '0.0.0.0',
        'port-range-start': parseInt(process.env.LT_PORT_RANGE_START),
        'port-range-end': parseInt(process.env.LT_PORT_RANGE_END),
        landing: process.env.LT_LANDING,
        'http-proxy-port': parseInt(process.env.LT_HTTP_PROXY_PORT),
        'https-proxy-port': parseInt(process.env.LT_HTTPS_PROXY_PORT),
        'retry-after': parseInt(process.env.LT_RETRY_AFTER) || 5,
    }
});

if (argv.help || argv.h) {
    console.log(`
localtunnel server (v${pkg.version})
Usage: localtunnel-server [options]

Options:
  --port <num>              listen on this port for outside requests (default: 80)
  --address <ip>            IP address to bind to (default: 0.0.0.0)
  --secure                  use this flag to indicate proxy over https (default: false)
  --domain <domain>         base domain name (required for subdomains like client.domain.com)
  --max-sockets <num>       maximum number of tcp sockets per client (default: 10)
  --admin-port <num>        port for admin API (tunnel creation)
  --admin-address <ip>      IP address for admin server to bind to (default: 0.0.0.0)
  --port-range-start <num>  starting port for client TCP connections (e.g., 10000)
  --port-range-end <num>    ending port for client TCP connections (e.g., 10100)
  --landing <url>           landing page URL for root requests
  --http-proxy-port <num>   public proxy port for HTTP traffic (used in generated URLs)
  --https-proxy-port <num>  public proxy port for HTTPS traffic (used in generated URLs)
  --help, -h                show this help message

Environment Variables:
  LT_SECURE                 same as --secure
  LT_PORT                   same as --port
  LT_ADDRESS                same as --address
  LT_DOMAIN                 same as --domain
  LT_MAX_SOCKETS            same as --max-sockets
  LT_ADMIN_PORT             same as --admin-port
  LT_ADMIN_ADDRESS          same as --admin-address
  LT_PORT_RANGE_START       same as --port-range-start
  LT_PORT_RANGE_END         same as --port-range-end
  LT_LANDING                same as --landing
  LT_HTTP_PROXY_PORT        same as --http-proxy-port
  LT_HTTPS_PROXY_PORT       same as --https-proxy-port
  LT_GRACE_PERIOD           grace period (ms) before removing disconnected tunnels
  LT_MAX_GRACE_PERIOD       maximum allowed grace period (ms)
  LT_IP_VALIDATION_STRICT   strict IP validation mode (true/false)
  LT_TRUST_PROXY            trust X-Forwarded-For headers (true/false)
  LT_REQUEST_TIMEOUT        HTTP request timeout (ms)
  LT_WEBSOCKET_TIMEOUT      WebSocket upgrade timeout (ms)
`);
    process.exit(0);
}

const { server, adminServer } = CreateServer({
    max_tcp_sockets: argv['max-sockets'],
    secure: argv.secure,
    domain: argv.domain,
    portRangeStart: argv['port-range-start'],
    portRangeEnd: argv['port-range-end'],
    landing: argv.landing,
    httpProxyPort: argv['http-proxy-port'],
    httpsProxyPort: argv['https-proxy-port'],
    retryAfter: argv['retry-after'],
    port: argv.port,
});

// Start main public server (tunnel traffic)
server.listen(argv.port, argv.address, () => {
    debug('public server listening on port: %d', server.address().port);
});

// Start admin server if separate port is specified
if (argv['admin-port']) {
    adminServer.listen(argv['admin-port'], argv['admin-address'], () => {
        debug('admin server listening on port: %d', adminServer.address().port);
    });
} else {
    // If no separate admin port, merge admin routes into main server
    // This is handled by keeping backward compatibility
    debug('admin API running on same port as public server');
}

process.on('SIGINT', () => {
    process.exit();
});

process.on('SIGTERM', () => {
    process.exit();
});

process.on('uncaughtException', (err) => {
    log.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error(reason);
});

// vim: ft=javascript
