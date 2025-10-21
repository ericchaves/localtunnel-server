/**
 * LocalTunnel Client Specification Tests
 *
 * @version 1.0.0
 * @protocol-version 0.0.8-epc
 * @last-updated 2025-10-21
 *
 * This file contains a comprehensive test suite for validating localtunnel client implementations.
 * These tests are designed to be used in client projects, not in the server project.
 *
 * The server is mocked to simulate different scenarios that a client must handle.
 *
 * VERSION HISTORY:
 *   1.0.1 (2025-10-22) - Bug fixes and improvements
 *     - Added `times` parameter to mockTunnelCreationError for retry testing
 *     - Made createMockTcpServer return Promise to avoid race conditions
 *     - Fixed baseUrl to use HTTPS instead of HTTP
 *     - Added `ip` field to tunnel creation response
 *     - Added 500 error retry test and documentation
 *     - Reduced default timeout from 10000ms to 2000ms
 *     - Added closeServer helper for proper HTTP cleanup
 *     - Added ERROR_HANDLING specification for retry behavior
 *   1.0.0 (2025-10-21) - Initial release
 *     - Protocol version: 0.0.8-epc
 *     - Full test coverage for tunnel creation, TCP management, HTTP forwarding,
 *       WebSocket support, error handling, grace period, and configuration
 *     - Uses ESM and native Node.js assert/strict
 *
 * PROTOCOL COMPATIBILITY:
 *   - Server version: 0.0.8-epc
 *   - Minimum Node.js: 25.0.0
 *   - Test framework: Mocha
 *
 * BREAKING CHANGES:
 *   (none yet - this is the initial version)
 *
 * Usage:
 *   1. Copy this file to your localtunnel client project
 *   2. Replace 'YourClientClass' with your actual client implementation
 *   3. Run with: mocha client.spec.js
 *
 * Requirements:
 *   - mocha: Test runner
 *   - nock: HTTP mocking
 *
 * Note: This file uses ESM (ECMAScript Modules) format.
 *       Ensure your package.json has "type": "module"
 */

import assert from 'assert/strict';
import nock from 'nock';
import net from 'net';
import http from 'http';
import { EventEmitter } from 'events';

// =============================================================================
// SPECIFICATION VERSION & PROTOCOL INFORMATION
// =============================================================================

/**
 * Specification version information
 * Update these constants when the protocol changes
 */
const SPEC_VERSION = '1.2.1';
const PROTOCOL_VERSION = '0.0.10-epc';
const SPEC_LAST_UPDATED = '2025-10-28';

/**
 * Protocol specifications that clients must implement
 *
 * @since 1.0.0
 */
const PROTOCOL_SPECS = {
  // Tunnel creation endpoint
  TUNNEL_CREATION_METHOD: 'GET',
  TUNNEL_CREATION_PATH_RANDOM: '/?new',
  TUNNEL_CREATION_PATH_CUSTOM: '/:subdomain',

  // Response format (JSON)
  RESPONSE_FIELDS: ['id', 'port', 'max_conn_count', 'url'],

  // Client Token Authentication (NEW in 0.0.9-epc)
  CLIENT_TOKEN_HEADER: 'X-LT-Client-Token',
  CLIENT_TOKEN_OPTIONAL: true,
  CLIENT_TOKEN_MAX_LENGTH: 256,
  CLIENT_TOKEN_PATTERN: /^[a-zA-Z0-9_-]+$/,
  CLIENT_TOKEN_PRIORITY_OVER_IP: true,

  // HMAC Authentication (NEW in 0.0.10-epc)
  HMAC_ALGORITHM: 'sha256',
  HMAC_AUTH_HEADER: 'Authorization',
  HMAC_AUTH_FORMAT: 'HMAC sha256=<hex_signature>',
  HMAC_TIMESTAMP_HEADER: 'X-Timestamp',
  HMAC_NONCE_HEADER: 'X-Nonce',
  HMAC_MESSAGE_FORMAT: 'METHOD+PATH+TIMESTAMP+NONCE+BODY',
  HMAC_OPTIONAL: true, // Server may require HMAC (LT_HMAC_SECRET)
  HMAC_TIMESTAMP_TOLERANCE: 60, // seconds (default)
  HMAC_NONCE_THRESHOLD: 3600, // seconds (default)
  HMAC_NONCE_TYPE: 'numeric', // Unix epoch in milliseconds

  // Subdomain validation
  SUBDOMAIN_MIN_LENGTH: 4,
  SUBDOMAIN_MAX_LENGTH: 63,
  SUBDOMAIN_PATTERN: /^(?:[a-z0-9][a-z0-9\-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/,

  // Connection parameters
  DEFAULT_MAX_SOCKETS: 10,
  DEFAULT_GRACE_PERIOD: 30000, // ms
  DEFAULT_REQUEST_TIMEOUT: 5000, // ms
  DEFAULT_WEBSOCKET_TIMEOUT: 10000, // ms,

  // Socket limit enforcement (NEW in 0.0.10-epc)
  // When client exceeds max_conn_count, server responds with HTTP 429
  SOCKET_LIMIT_RESPONSE: {
    STATUS_CODE: 429,
    HEADERS: {
      'X-LT-Max-Sockets': 'Maximum number of sockets allowed',
      'X-LT-Current-Sockets': 'Current number of connected sockets',
      'X-LT-Available-Sockets': 'Number of sockets available for reuse',
      'X-LT-Waiting-Requests': 'Number of queued requests waiting for a socket'
    },
    CLIENT_SHOULD: [
      'Respect max_conn_count from tunnel creation response',
      'Reuse existing connections from the pool',
      'Not open more connections than max_conn_count',
      'Stop trying to open new connections when limit is reached'
    ]
  },

  // HTTP status codes
  STATUS_OK: 200,
  STATUS_FOUND: 302,
  STATUS_FORBIDDEN: 403,
  STATUS_NOT_FOUND: 404,
  STATUS_CONFLICT: 409,
  STATUS_TOO_MANY_CONNECTIONS: 429,
  STATUS_INTERNAL_SERVER_ERROR: 500,
  STATUS_SERVICE_UNAVAILABLE: 503,

  // Error handling behavior
  ERROR_HANDLING: {
    // 4xx Client Errors: Fail immediately, do not retry
    CLIENT_ERRORS_NO_RETRY: true,

    // 5xx Server Errors: Retry with exponential backoff
    SERVER_ERRORS_RETRY: true,
    SERVER_ERROR_MAX_RETRIES: 3,
    SERVER_ERROR_RETRY_DELAY_MS: 1000,

    // Network errors (ECONNREFUSED, etc): Retry indefinitely
    NETWORK_ERRORS_RETRY_INDEFINITELY: true
  },

  // Required client capabilities
  CAPABILITIES: [
    'tunnel_creation',
    'tcp_socket_management',
    'http_forwarding',
    'websocket_upgrade',
    'error_handling',
    'grace_period_reconnection'
  ]
};

// =============================================================================
// MOCK SERVER SETUP
// =============================================================================

/**
 * Mock server responses and behaviors
 */
class MockLocalTunnelServer {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://localtunnel.me';
    this.domain = options.domain || 'localtunnel.me';
    this.port = options.port || 443;
    this.tcpServers = new Map();
    this.tunnels = new Map();
  }

  /**
   * Mock tunnel creation endpoint
   */
  mockTunnelCreation(subdomain = null, options = {}) {
    const tunnelId = subdomain || this._generateRandomId();
    const tcpPort = options.port || this._getRandomPort();
    const maxConnCount = options.maxConnCount || 10;

    const path = subdomain ? `/${subdomain}` : '/';
    const scope = nock(this.baseUrl)
      .get(path)
      .query(subdomain ? {} : { new: '' })
      .reply(options.statusCode || 200, {
        id: tunnelId,
        ip: '127.0.0.1', // Return localhost so TCP connection works
        port: tcpPort,
        max_conn_count: maxConnCount,
        url: `https://${tunnelId}.${this.domain}`
      });

    this.tunnels.set(tunnelId, {
      id: tunnelId,
      port: tcpPort,
      maxConnCount: maxConnCount,
      sockets: []
    });

    return { tunnelId, tcpPort, maxConnCount, scope };
  }

  /**
   * Mock tunnel creation with error
   */
  mockTunnelCreationError(subdomain, statusCode, errorMessage, times = 1) {
    const path = subdomain ? `/${subdomain}` : '/';
    return nock(this.baseUrl)
      .get(path)
      .query(subdomain ? {} : { new: '' })
      .times(times)
      .reply(statusCode, { message: errorMessage });
  }

  /**
   * Mock tunnel creation with 409 (Conflict - subdomain reserved)
   */
  mockSubdomainReserved(subdomain, remainingTime = 25) {
    return this.mockTunnelCreationError(
      subdomain,
      409,
      `Subdomain "${subdomain}" is reserved by another client. Try again in ${remainingTime}s or use a different subdomain.`
    );
  }

  /**
   * Mock tunnel creation with 403 (Invalid subdomain format)
   */
  mockInvalidSubdomain(subdomain) {
    return this.mockTunnelCreationError(
      subdomain,
      403,
      'Invalid subdomain format. Must be 4-63 alphanumeric characters (hyphens allowed in middle).'
    );
  }

  /**
   * Create a mock TCP server for client connections
   * Returns a promise that resolves when server is listening
   */
  createMockTcpServer(port, options = {}) {
    return new Promise((resolve) => {
      const server = net.createServer();
      const emitter = new EventEmitter();
      const sockets = [];

      server.on('connection', (socket) => {
        sockets.push(socket);
        emitter.emit('clientConnected', socket);

        socket.on('data', (data) => {
          emitter.emit('clientData', socket, data);
        });

        socket.on('close', () => {
          const index = sockets.indexOf(socket);
          if (index > -1) sockets.splice(index, 1);
          emitter.emit('clientDisconnected', socket);
        });
      });

      server.listen(port, () => {
        emitter.emit('serverReady', port);

        const mockServer = {
          server,
          emitter,
          sockets,
          close: () => {
            return new Promise((resolveClose) => {
              sockets.forEach(s => s.destroy());
              server.close(() => {
                this.tcpServers.delete(port);
                resolveClose();
              });
            });
          }
        };

        this.tcpServers.set(port, mockServer);
        resolve(mockServer);
      });
    });
  }

  /**
   * Simulate server sending HTTP request to client socket
   */
  sendHttpRequest(socket, options = {}) {
    const method = options.method || 'GET';
    const path = options.path || '/';
    const headers = options.headers || { host: 'example.com' };
    const body = options.body || '';

    const headerLines = Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`);

    const request = [
      `${method} ${path} HTTP/1.1`,
      ...headerLines,
      '',
      body
    ].join('\r\n');

    socket.write(request);
  }

  /**
   * Simulate server sending WebSocket upgrade request
   */
  sendWebSocketUpgrade(socket, options = {}) {
    const path = options.path || '/';
    const headers = {
      'Host': 'example.com',
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      ...options.headers
    };

    this.sendHttpRequest(socket, {
      method: 'GET',
      path,
      headers
    });
  }

  /**
   * Helper to generate random subdomain
   */
  _generateRandomId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Helper to get random port
   */
  _getRandomPort() {
    return 10000 + Math.floor(Math.random() * 1000);
  }

  /**
   * Cleanup all mocks
   */
  async cleanup() {
    nock.cleanAll();

    const closePromises = [];
    for (const [port, { server, sockets }] of this.tcpServers) {
      closePromises.push(new Promise((resolve) => {
        sockets.forEach(s => s.destroy());
        server.close(() => resolve());
      }));
    }

    await Promise.all(closePromises);
    this.tcpServers.clear();
    this.tunnels.clear();
  }
}

// =============================================================================
// MOCK LOCAL HTTP SERVER
// =============================================================================

/**
 * Mock local HTTP server that the client will forward requests to
 */
class MockLocalServer {
  constructor(port = 3000) {
    this.port = port;
    this.server = null;
    this.requestHandler = null;
  }

  start(handler) {
    return new Promise((resolve) => {
      this.requestHandler = handler || ((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello from local service');
      });

      this.server = http.createServer(this.requestHandler);
      this.server.listen(this.port, () => resolve());
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to properly close HTTP servers
 * Ensures all connections are closed before server.close() completes
 */
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    // Force close all connections first (Node.js 18+)
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

// =============================================================================
// CLIENT INTERFACE SPECIFICATION
// =============================================================================

/**
 * This is the interface that your client implementation should follow.
 * Replace this with your actual client class when running tests.
 */
class LocalTunnelClientInterface {
  /**
   * Create a new tunnel client
   * @param {Object} options
   * @param {number} options.port - Local port to tunnel
   * @param {string} options.host - Tunnel server host (default: 'https://localtunnel.me')
   * @param {string} options.subdomain - Requested subdomain (optional)
   * @param {number} options.maxSockets - Maximum concurrent connections (default: 10)
   */
  constructor(options) {
    throw new Error('Replace LocalTunnelClientInterface with your actual client implementation');
  }

  /**
   * Open the tunnel connection
   * @returns {Promise<Object>} Tunnel info { url, id, port, maxConnCount }
   */
  async open() {
    throw new Error('Not implemented');
  }

  /**
   * Close the tunnel connection
   * @returns {Promise<void>}
   */
  async close() {
    throw new Error('Not implemented');
  }

  /**
   * Get tunnel information
   * @returns {Object} { url, id, isConnected, socketCount }
   */
  getInfo() {
    throw new Error('Not implemented');
  }

  /**
   * Events:
   * - 'request' (info) - Emitted when a request is received
   * - 'error' (err) - Emitted on errors
   * - 'close' - Emitted when tunnel is closed
   * - 'dead' - Emitted when tunnel cannot be recovered
   */
}

// =============================================================================
// TEST SUITE
// =============================================================================

describe('LocalTunnel Client Specification', function() {
  let mockServer;
  let localServer;

  // Tests use mocks, so we can use shorter timeout
  // Note: this applies to hooks (before, beforeEach, afterEach) AND tests
  this.timeout(2000);

  beforeEach(function() {
    mockServer = new MockLocalTunnelServer({
      baseUrl: 'https://localtunnel.me',
      domain: 'localtunnel.me'
    });

    localServer = new MockLocalServer(3000);
  });

  afterEach(async function() {
    await mockServer.cleanup();
    await localServer.stop();
  });

  // ===========================================================================
  // SPECIFICATION VERSION INFORMATION
  // ===========================================================================

  describe('Specification Version', function() {
    it('should display version information', function() {
      console.log('\n  📋 LocalTunnel Client Specification');
      console.log(`  ├─ Spec Version: ${SPEC_VERSION}`);
      console.log(`  ├─ Protocol Version: ${PROTOCOL_VERSION}`);
      console.log(`  ├─ Last Updated: ${SPEC_LAST_UPDATED}`);
      console.log('  └─ Status: Active\n');
    });

    it('should document protocol specifications', function() {
      console.log('  📝 Protocol Requirements:');
      console.log(`  ├─ Subdomain Length: ${PROTOCOL_SPECS.SUBDOMAIN_MIN_LENGTH}-${PROTOCOL_SPECS.SUBDOMAIN_MAX_LENGTH} chars`);
      console.log(`  ├─ Max Sockets: ${PROTOCOL_SPECS.DEFAULT_MAX_SOCKETS}`);
      console.log(`  ├─ Grace Period: ${PROTOCOL_SPECS.DEFAULT_GRACE_PERIOD}ms`);
      console.log(`  ├─ Request Timeout: ${PROTOCOL_SPECS.DEFAULT_REQUEST_TIMEOUT}ms`);
      console.log(`  └─ WebSocket Timeout: ${PROTOCOL_SPECS.DEFAULT_WEBSOCKET_TIMEOUT}ms\n`);
    });

    it('should list required client capabilities', function() {
      console.log('  ✅ Required Client Capabilities:');
      PROTOCOL_SPECS.CAPABILITIES.forEach((cap, idx) => {
        const isLast = idx === PROTOCOL_SPECS.CAPABILITIES.length - 1;
        const prefix = isLast ? '  └─' : '  ├─';
        console.log(`${prefix} ${cap}`);
      });
      console.log('');
    });
  });

  // ===========================================================================
  // TUNNEL CREATION TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('Tunnel Creation', function() {
    it('should request tunnel with random subdomain', async function() {
      const { tunnelId, tcpPort, scope } = mockServer.mockTunnelCreation();

      // TODO: Replace with your client implementation
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const info = await client.open();
      //
      // assert.equal(info.id, tunnelId);
      // assert.equal(info.port, tcpPort);
      // assert(info.url);
      // assert(scope.isDone());

      // This test will fail until you implement your client
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should request tunnel with specific subdomain', async function() {
      const requestedSubdomain = 'myapp';
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation(requestedSubdomain);

      // TODO: Replace with your client implementation
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: requestedSubdomain
      // });
      //
      // const info = await client.open();
      //
      // assert.equal(info.id, requestedSubdomain);

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should parse tunnel creation response correctly', async function() {
      const { tunnelId, tcpPort, maxConnCount } = mockServer.mockTunnelCreation('testapp', {
        maxConnCount: 15
      });

      // TODO: Verify client parses all fields correctly
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'testapp'
      // });
      //
      // const info = await client.open();
      //
      // assert.equal(info.id, tunnelId);
      // assert.equal(info.port, tcpPort);
      // assert.equal(info.max_conn_count, maxConnCount);
      // assert.equal(info.url, `https://${tunnelId}.localhost.test`);

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle invalid subdomain format (403)', async function() {
      const invalidSubdomain = 'ab'; // Too short
      mockServer.mockInvalidSubdomain(invalidSubdomain);

      // TODO: Verify client handles 403 error
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: invalidSubdomain
      // });
      //
      // try {
      //   await client.open();
      //   assert.fail('Should have thrown error');
      // } catch (err) {
      //   assert(err.message.includes('Invalid subdomain format'));
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle subdomain reserved error (409)', async function() {
      const subdomain = 'reserved';
      mockServer.mockSubdomainReserved(subdomain, 25);

      // TODO: Verify client handles 409 error
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: subdomain
      // });
      //
      // try {
      //   await client.open();
      //   assert.fail('Should have thrown error');
      // } catch (err) {
      //   assert(err.message.includes('reserved by another client'));
      //   assert(err.message.includes('25s'));
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should validate subdomain format before sending request', async function() {
      const invalidSubdomains = [
        'ab',           // Too short
        'a'.repeat(64), // Too long
        'test@app',     // Invalid character
        'Test-App',     // Uppercase
        '-testapp',     // Starts with hyphen
        'testapp-',     // Ends with hyphen
        'test..app',    // Double dots
      ];

      // TODO: Verify client validates subdomain format locally
      // for (const invalid of invalidSubdomains) {
      //   const client = new YourClientClass({
      //     port: 3000,
      //     host: 'http://localhost:8080',
      //     subdomain: invalid
      //   });
      //
      //   try {
      //     await client.open();
      //     assert.fail(`Should reject invalid subdomain: ${invalid}`);
      //   } catch (err) {
      //     assert.match(err.message, /invalid|subdomain|format/i);
      //   }
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // TCP SOCKET MANAGEMENT TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('TCP Socket Management', function() {
    it('should establish TCP connection to assigned port', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      const connectionPromise = new Promise((resolve) => {
        tcpMock.emitter.once('clientConnected', resolve);
      });

      // TODO: Verify client connects to TCP port
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // await client.open();
      //
      // const socket = await connectionPromise;
      // assert(socket);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should maintain multiple TCP connections (up to max_conn_count)', async function() {
      const maxConnCount = 5;
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation(null, { maxConnCount });
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      let connectionCount = 0;
      tcpMock.emitter.on('clientConnected', () => {
        connectionCount++;
      });

      // TODO: Verify client creates multiple connections
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   maxSockets: maxConnCount
      // });
      //
      // await client.open();
      //
      // // Wait for connections to establish
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // assert(connectionCount >= 1);
      // assert(connectionCount <= maxConnCount);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should reconnect on socket disconnection', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      let connectionCount = 0;
      const connections = [];

      tcpMock.emitter.on('clientConnected', (socket) => {
        connectionCount++;
        connections.push(socket);
      });

      // TODO: Verify client reconnects after disconnect
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // await client.open();
      // await new Promise(resolve => setTimeout(resolve, 200));
      //
      // const initialCount = connectionCount;
      //
      // // Force disconnect first socket
      // connections[0].destroy();
      //
      // // Wait for reconnection
      // await new Promise(resolve => setTimeout(resolve, 1000));
      //
      // assert(connectionCount > initialCount);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should respect max_conn_count limit', async function() {
      const maxConnCount = 3;
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation(null, { maxConnCount });
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      let connectionCount = 0;
      tcpMock.emitter.on('clientConnected', () => {
        connectionCount++;
      });

      // TODO: Verify client respects connection limit
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   maxSockets: maxConnCount
      // });
      //
      // await client.open();
      //
      // // Wait for all connections
      // await new Promise(resolve => setTimeout(resolve, 1000));
      //
      // assert.equal(connectionCount, maxConnCount);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should keep sockets alive with keep-alive', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Verify client enables TCP keep-alive
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // // Check if keep-alive is enabled
      // assert.equal(socket.connecting, false);
      // // Note: Actual keep-alive check depends on implementation

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // HTTP REQUEST FORWARDING TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('HTTP Request Forwarding', function() {
    it('should receive HTTP request from tunnel socket and forward to local service', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      let localRequestReceived = false;
      await localServer.start((req, res) => {
        localRequestReceived = true;
        assert.equal(req.method, 'GET');
        assert.equal(req.url, '/test');
        res.writeHead(200);
        res.end('OK');
      });

      // TODO: Verify client forwards requests
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // // Send HTTP request to client
      // mockServer.sendHttpRequest(socket, {
      //   method: 'GET',
      //   path: '/test',
      //   headers: { host: 'localhost' }
      // });
      //
      // // Wait for local server to receive request
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // assert(localRequestReceived);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should forward response back through tunnel socket', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      await localServer.start((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Hello World');
      });

      // TODO: Verify client returns response
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // const responsePromise = new Promise((resolve) => {
      //   let data = '';
      //   socket.on('data', (chunk) => {
      //     data += chunk.toString();
      //     if (data.includes('\r\n\r\n')) {
      //       resolve(data);
      //     }
      //   });
      // });
      //
      // mockServer.sendHttpRequest(socket, {
      //   method: 'GET',
      //   path: '/',
      //   headers: { host: 'localhost' }
      // });
      //
      // const response = await responsePromise;
      //
      // assert(response.includes('HTTP/1.1 200'));
      // assert(response.includes('Hello World'));

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should support different HTTP methods (GET, POST, PUT, DELETE)', async function() {
      const methods = ['GET', 'POST', 'PUT', 'DELETE'];

      for (const method of methods) {
        const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
        const tcpMock = mockServer.createMockTcpServer(tcpPort);

        let receivedMethod = null;
        await localServer.start((req, res) => {
          receivedMethod = req.method;
          res.writeHead(200);
          res.end('OK');
        });

        // TODO: Verify client supports all HTTP methods
        // const client = new YourClientClass({
        //   port: 3000,
        //   host: 'http://localhost:8080'
        // });
        //
        // const socketPromise = new Promise((resolve) => {
        //   tcpMock.emitter.once('clientConnected', resolve);
        // });
        //
        // await client.open();
        // const socket = await socketPromise;
        //
        // mockServer.sendHttpRequest(socket, {
        //   method: method,
        //   path: '/test',
        //   headers: { host: 'localhost' }
        // });
        //
        // await new Promise(resolve => setTimeout(resolve, 300));
        //
        // assert.equal(receivedMethod, method);

        await tcpMock.close();
        await localServer.stop();
      }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should preserve request headers', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      const testHeaders = {
        'host': 'example.com',
        'user-agent': 'TestAgent/1.0',
        'x-custom-header': 'CustomValue',
        'content-type': 'application/json'
      };

      let receivedHeaders = null;
      await localServer.start((req, res) => {
        receivedHeaders = req.headers;
        res.writeHead(200);
        res.end('OK');
      });

      // TODO: Verify client preserves headers
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // mockServer.sendHttpRequest(socket, {
      //   method: 'POST',
      //   path: '/api/test',
      //   headers: testHeaders
      // });
      //
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // for (const [key, value] of Object.entries(testHeaders)) {
      //   assert.equal(receivedHeaders[key], value);
      // }

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle POST request with body', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      const requestBody = JSON.stringify({ test: 'data' });
      let receivedBody = '';

      await localServer.start((req, res) => {
        req.on('data', chunk => {
          receivedBody += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200);
          res.end('OK');
        });
      });

      // TODO: Verify client forwards request body
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // mockServer.sendHttpRequest(socket, {
      //   method: 'POST',
      //   path: '/api/data',
      //   headers: {
      //     'host': 'localhost',
      //     'content-type': 'application/json',
      //     'content-length': requestBody.length
      //   },
      //   body: requestBody
      // });
      //
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // assert.equal(receivedBody, requestBody);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // WEBSOCKET SUPPORT TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('WebSocket Support', function() {
    it('should detect WebSocket upgrade request', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Verify client detects WebSocket upgrade
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // let upgradeDetected = false;
      // client.on('upgrade', () => {
      //   upgradeDetected = true;
      // });
      //
      // mockServer.sendWebSocketUpgrade(socket);
      //
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // assert(upgradeDetected);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should forward WebSocket upgrade to local service', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      let upgradeReceived = false;

      // Create HTTP server that handles upgrades
      const httpServer = http.createServer();
      httpServer.on('upgrade', (req, socket, head) => {
        upgradeReceived = true;
        assert.equal(req.headers.upgrade, 'websocket');
        socket.end();
      });

      await new Promise(resolve => {
        httpServer.listen(3000, resolve);
      });

      // TODO: Verify client forwards WebSocket upgrade
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // mockServer.sendWebSocketUpgrade(socket);
      //
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // assert(upgradeReceived);

      httpServer.close();
      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should maintain bidirectional WebSocket communication', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Verify bidirectional WebSocket data flow
      // This is a complex test that requires actual WebSocket frame handling
      // For now, just verify the upgrade is forwarded correctly

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // ERROR HANDLING TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('Error Handling', function() {
    it('should handle 503 Service Unavailable', async function() {
      // This would be returned when server has no available sockets
      // Client should retry or handle gracefully

      // TODO: Test handling of 503 during tunnel operation
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should respect Retry-After header', async function() {
      // When server returns 503 with Retry-After header,
      // client should wait before retrying

      // TODO: Test Retry-After handling
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle socket timeout', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      await localServer.start((req, res) => {
        // Intentionally delay response to trigger timeout
        setTimeout(() => {
          res.writeHead(200);
          res.end('Late response');
        }, 10000);
      });

      // TODO: Verify client handles request timeout
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   timeout: 1000 // 1 second timeout
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // mockServer.sendHttpRequest(socket, {
      //   method: 'GET',
      //   path: '/slow'
      // });
      //
      // // Wait for timeout
      // await new Promise(resolve => setTimeout(resolve, 2000));
      //
      // // Client should have handled timeout gracefully
      // const info = client.getInfo();
      // assert(info.isConnected);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle local service connection errors', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // Don't start local server - connection should fail

      // TODO: Verify client handles connection errors to local service
      // const client = new YourClientClass({
      //   port: 3000, // Nothing listening here
      //   host: 'http://localhost:8080'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // let errorEmitted = false;
      // client.on('error', (err) => {
      //   errorEmitted = true;
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // const responsePromise = new Promise((resolve) => {
      //   let data = '';
      //   socket.on('data', (chunk) => {
      //     data += chunk.toString();
      //     if (data.includes('\r\n\r\n')) {
      //       resolve(data);
      //     }
      //   });
      // });
      //
      // mockServer.sendHttpRequest(socket, {
      //   method: 'GET',
      //   path: '/'
      // });
      //
      // const response = await responsePromise;
      //
      // // Should return 503 or similar error
      // assert.match(response, /503|500|502/);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should emit error events on failures', async function() {
      // TODO: Verify client emits error events
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://invalid-host-that-does-not-exist:8080'
      // });
      //
      // let errorEmitted = false;
      // client.on('error', (err) => {
      //   errorEmitted = true;
      //   assert(err instanceof Error);
      // });
      //
      // try {
      //   await client.open();
      // } catch (err) {
      //   // Expected
      // }
      //
      // assert(errorEmitted);

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should retry on 500 server errors with limit', async function() {
      // This test needs more time because of retry logic (3 retries × 1s = 3s)
      this.timeout(5000);

      // Mock 500 error 3 times to test retry logic
      mockServer.mockTunnelCreationError(null, 500, 'Internal Server Error', 3);

      // TODO: Verify client retries on 5xx errors
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'https://localtunnel.me',
      //   maxRetries: 3
      // });
      //
      // try {
      //   await client.open();
      //   assert.fail('Should have thrown after max retries');
      // } catch (err) {
      //   assert(err.message.includes('Server error after'));
      //   assert(err.message.includes('retries'));
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle tunnel server disconnection', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Verify client handles server disconnect
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // await client.open();
      //
      // // Close all server sockets
      // for (const socket of tcpMock.sockets) {
      //   socket.destroy();
      // }
      //
      // // Wait for client to detect disconnect
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // // Client should attempt to reconnect
      // const info = client.getInfo();
      // assert(info.socketCount > 0); // Should reconnect

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // GRACE PERIOD & IP VALIDATION TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('Grace Period & IP Validation', function() {
    it('should reconnect from same IP and keep subdomain during grace period', async function() {
      // First connection
      const subdomain = 'test-grace';
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation(subdomain);
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Test grace period reconnection
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: subdomain
      // });
      //
      // const info1 = await client.open();
      // assert.equal(info1.id, subdomain);
      //
      // // Close client
      // await client.close();
      //
      // // Mock same subdomain available during grace period
      // const { tunnelId: tunnelId2 } = mockServer.mockTunnelCreation(subdomain);
      //
      // // Reconnect quickly (within grace period)
      // const client2 = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: subdomain
      // });
      //
      // const info2 = await client2.open();
      // assert.equal(info2.id, subdomain);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle IP mismatch during grace period (strict mode)', async function() {
      // In strict mode, different IP trying to claim subdomain during grace period
      // should receive 409 Conflict

      const subdomain = 'test-strict';
      mockServer.mockSubdomainReserved(subdomain, 25);

      // TODO: Test strict IP validation
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: subdomain
      // });
      //
      // try {
      //   await client.open();
      //   expect.fail('Should have thrown 409 error');
      // } catch (err) {
      //   assert.equal(err.statusCode || err.status, 409);
      //   assert(err.message.includes('reserved'));
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should receive random subdomain when IP mismatch in non-strict mode', async function() {
      // In non-strict mode, different IP gets random subdomain instead of error

      // TODO: Test non-strict IP validation
      // This requires more complex server mocking to simulate the behavior

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle grace period expiration', async function() {
      // After grace period expires, subdomain becomes available to anyone

      // TODO: Test grace period expiration
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // CLIENT TOKEN AUTHENTICATION TESTS
  // @since 1.1.0 (Protocol 0.0.9-epc)
  // ===========================================================================

  describe('Client Token Authentication (X-LT-Client-Token)', function() {
    it('should send client token header when configured', async function() {
      const clientToken = 'my-test-token-123';
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation('token-test');

      // TODO: Verify client sends X-LT-Client-Token header
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'token-test',
      //   clientToken: clientToken  // New option
      // });
      //
      // // Mock server should receive the header
      // const scope = nock('http://localhost:8080')
      //   .matchHeader('X-LT-Client-Token', clientToken)
      //   .get('/token-test')
      //   .reply(200, { id: tunnelId, port: tcpPort, max_conn_count: 10, url: '...' });
      //
      // await client.open();
      //
      // assert(scope.isDone());

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should allow reconnection with same token from different IP', async function() {
      const clientToken = 'reconnect-token-456';
      const subdomain = 'token-reconnect';

      // First connection
      const { tunnelId: id1, tcpPort: port1 } = mockServer.mockTunnelCreation(subdomain);

      // TODO: Test reconnection with token
      // const client1 = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: subdomain,
      //   clientToken: clientToken
      // });
      //
      // await client1.open();
      // await client1.close();
      //
      // // Simulate IP change but same token
      // const { tunnelId: id2 } = mockServer.mockTunnelCreation(subdomain);
      //
      // const client2 = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: subdomain,
      //   clientToken: clientToken  // Same token
      // });
      //
      // const info = await client2.open();
      // assert.equal(info.id, subdomain); // Should get same subdomain

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should work without token (backward compatibility)', async function() {
      // Client without token should still work using IP-based identification
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation('no-token');

      // TODO: Verify backward compatibility
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'no-token'
      //   // No clientToken specified
      // });
      //
      // const info = await client.open();
      // assert.equal(info.id, 'no-token');

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should validate token format locally before sending', async function() {
      const invalidTokens = [
        'token with spaces',
        'token@invalid',
        'token#special',
        'a'.repeat(300), // Too long
      ];

      // TODO: Verify client validates token format
      // for (const invalidToken of invalidTokens) {
      //   const client = new YourClientClass({
      //     port: 3000,
      //     host: 'http://localhost:8080',
      //     clientToken: invalidToken
      //   });
      //
      //   try {
      //     await client.open();
      //     assert.fail(`Should reject invalid token: ${invalidToken}`);
      //   } catch (err) {
      //     assert.match(err.message, /invalid|token|format/i);
      //   }
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should allow valid token characters (alphanumeric, hyphens, underscores)', async function() {
      const validToken = 'Valid-Token_123';
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation('valid-token');

      // TODO: Verify valid token is accepted
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'valid-token',
      //   clientToken: validToken
      // });
      //
      // const info = await client.open();
      // assert.equal(info.id, 'valid-token');

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // HMAC AUTHENTICATION TESTS
  // @since 1.2.0 (Protocol 0.0.10-epc)
  // ===========================================================================

  describe('HMAC Authentication (Optional)', function() {
    it('should support HMAC authentication when server requires it', async function() {
      // When server has LT_HMAC_SECRET configured, all tunnel requests need HMAC auth
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation('hmac-test');

      // TODO: Verify client can send HMAC authentication headers
      // const secret = 'my-shared-secret-at-least-32-chars-long';
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'hmac-test',
      //   hmacSecret: secret  // New option
      // });
      //
      // // Client should calculate and send:
      // // - Authorization: HMAC sha256=<signature>
      // // - X-Timestamp: <unix_seconds>
      // // - X-Nonce: <unix_ms>
      //
      // const scope = nock('http://localhost:8080')
      //   .matchHeader('Authorization', /^HMAC sha256=[a-f0-9]+$/)
      //   .matchHeader('X-Timestamp', /^\d+$/)
      //   .matchHeader('X-Nonce', /^\d+$/)
      //   .get('/hmac-test')
      //   .reply(200, { id: tunnelId, port: tcpPort, max_conn_count: 10, url: '...' });
      //
      // await client.open();
      // assert(scope.isDone());

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should calculate HMAC signature correctly', async function() {
      // Message format: METHOD + PATH + TIMESTAMP + NONCE + BODY
      // const crypto = require('crypto');
      // const secret = 'test-secret-32-characters-long!!';
      // const method = 'GET';
      // const path = '/test-subdomain';
      // const timestamp = '1735401600'; // Unix seconds
      // const nonce = '1735401600000'; // Unix milliseconds
      // const body = ''; // Empty for GET
      //
      // const message = `${method}${path}${timestamp}${nonce}${body}`;
      // const expectedSignature = crypto.createHmac('sha256', secret).update(message).digest('hex');
      //
      // // TODO: Verify your client calculates the same signature
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'test-subdomain',
      //   hmacSecret: secret
      // });
      //
      // // Mock the timestamp/nonce to known values for testing
      // const signature = client._calculateHmacSignature(method, path, timestamp, nonce, body);
      // assert.equal(signature, expectedSignature);

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should use numeric nonce (Unix epoch in milliseconds)', async function() {
      // Nonce must be a numeric value (Date.now())
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation('nonce-test');

      // TODO: Verify client uses numeric nonce
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'nonce-test',
      //   hmacSecret: 'secret-32-chars-long-secret-here!!'
      // });
      //
      // const scope = nock('http://localhost:8080')
      //   .matchHeader('X-Nonce', (value) => {
      //     const nonce = parseInt(value, 10);
      //     return !isNaN(nonce) && nonce > 0 && nonce.toString().length >= 13; // Millisecond precision
      //   })
      //   .get('/nonce-test')
      //   .reply(200, { id: tunnelId, port: tcpPort, max_conn_count: 10, url: '...' });
      //
      // await client.open();
      // assert(scope.isDone());

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should use current Unix timestamp in seconds', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation('timestamp-test');

      // TODO: Verify client uses Unix timestamp in seconds
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'timestamp-test',
      //   hmacSecret: 'secret-32-chars-long-secret-here!!'
      // });
      //
      // const now = Math.floor(Date.now() / 1000);
      // const scope = nock('http://localhost:8080')
      //   .matchHeader('X-Timestamp', (value) => {
      //     const timestamp = parseInt(value, 10);
      //     const diff = Math.abs(timestamp - now);
      //     return diff < 5; // Within 5 seconds
      //   })
      //   .get('/timestamp-test')
      //   .reply(200, { id: tunnelId, port: tcpPort, max_conn_count: 10, url: '...' });
      //
      // await client.open();
      // assert(scope.isDone());

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should not send HMAC headers when server does not require it', async function() {
      // Backward compatibility: if no hmacSecret provided, don't send HMAC headers
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation('no-hmac');

      // TODO: Verify client doesn't send HMAC headers when not configured
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'no-hmac'
      //   // No hmacSecret provided
      // });
      //
      // const scope = nock('http://localhost:8080')
      //   .get('/no-hmac')
      //   .reply(function(uri, requestBody) {
      //     // Verify HMAC headers are NOT present
      //     assert.equal(this.req.headers['authorization'], undefined);
      //     assert.equal(this.req.headers['x-timestamp'], undefined);
      //     assert.equal(this.req.headers['x-nonce'], undefined);
      //     return [200, { id: tunnelId, port: tcpPort, max_conn_count: 10, url: '...' }];
      //   });
      //
      // await client.open();
      // assert(scope.isDone());

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should handle 401 Unauthorized when HMAC signature is invalid', async function() {
      mockServer.mockTunnelCreationError('hmac-fail', 401, 'Invalid HMAC signature');

      // TODO: Verify client handles HMAC authentication failure
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   subdomain: 'hmac-fail',
      //   hmacSecret: 'wrong-secret-different-from-server'
      // });
      //
      // try {
      //   await client.open();
      //   assert.fail('Should have thrown error');
      // } catch (err) {
      //   assert(err.message.includes('HMAC') || err.message.includes('Unauthorized'));
      //   assert.equal(err.statusCode || err.status, 401);
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should validate HMAC secret length (min 32 characters)', async function() {
      const shortSecret = 'too-short'; // Less than 32 chars

      // TODO: Verify client validates secret length before using
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   hmacSecret: shortSecret
      // });
      //
      // try {
      //   await client.open();
      //   assert.fail('Should reject short HMAC secret');
      // } catch (err) {
      //   assert.match(err.message, /secret|length|32|characters/i);
      // }

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // CLIENT LIFECYCLE TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('Client Lifecycle', function() {
    it('should provide tunnel information via getInfo()', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Test getInfo() method
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // await client.open();
      //
      // const info = client.getInfo();
      // assert(info.url);
      // assert.equal(info.id, tunnelId);
      // assert.equal(info.isConnected, true);
      // assert(info.socketCount !== undefined);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should cleanly close all connections', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      let disconnectCount = 0;
      tcpMock.emitter.on('clientDisconnected', () => {
        disconnectCount++;
      });

      // TODO: Test clean shutdown
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // await client.open();
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // const initialSockets = tcpMock.sockets.length;
      //
      // await client.close();
      //
      // await new Promise(resolve => setTimeout(resolve, 500));
      //
      // assert.equal(disconnectCount, initialSockets);
      // assert.equal(tcpMock.sockets.length, 0);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should emit close event when tunnel closes', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Test close event
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // let closeEmitted = false;
      // client.on('close', () => {
      //   closeEmitted = true;
      // });
      //
      // await client.open();
      // await client.close();
      //
      // assert(closeEmitted);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should emit request event for each incoming request', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      await localServer.start((req, res) => {
        res.writeHead(200);
        res.end('OK');
      });

      // TODO: Test request event emission
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080'
      // });
      //
      // let requestCount = 0;
      // client.on('request', (info) => {
      //   requestCount++;
      //   assert(info.method);
      //   assert(info.path);
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // // Send multiple requests
      // mockServer.sendHttpRequest(socket, { method: 'GET', path: '/1' });
      // await new Promise(resolve => setTimeout(resolve, 200));
      // mockServer.sendHttpRequest(socket, { method: 'POST', path: '/2' });
      // await new Promise(resolve => setTimeout(resolve, 200));
      //
      // assert.equal(requestCount, 2);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });

  // ===========================================================================
  // CONFIGURATION TESTS
  // @since 1.0.0
  // ===========================================================================

  describe('Configuration', function() {
    it('should support custom host configuration', async function() {
      const customHost = 'http://custom.tunnel.host:8080';
      mockServer = new MockLocalTunnelServer({
        baseUrl: customHost,
        domain: 'custom.tunnel.host'
      });

      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();

      // TODO: Test custom host
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: customHost
      // });
      //
      // const info = await client.open();
      // assert(info.url.includes('custom.tunnel.host'));

      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should support custom maxSockets configuration', async function() {
      const customMaxSockets = 20;
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation(null, {
        maxConnCount: customMaxSockets
      });
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // TODO: Test custom maxSockets
      // const client = new YourClientClass({
      //   port: 3000,
      //   host: 'http://localhost:8080',
      //   maxSockets: customMaxSockets
      // });
      //
      // await client.open();
      // await new Promise(resolve => setTimeout(resolve, 1000));
      //
      // // Should create up to customMaxSockets connections
      // assert(tcpMock.sockets.length <= customMaxSockets);

      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });

    it('should support local_host option for local service', async function() {
      const { tunnelId, tcpPort } = mockServer.mockTunnelCreation();
      const tcpMock = mockServer.createMockTcpServer(tcpPort);

      // Start server on custom host
      const customLocalServer = new MockLocalServer(3001);
      await customLocalServer.start((req, res) => {
        res.writeHead(200);
        res.end('Custom host response');
      });

      // TODO: Test custom local host
      // const client = new YourClientClass({
      //   port: 3001,
      //   host: 'http://localhost:8080',
      //   local_host: 'localhost'
      // });
      //
      // const socketPromise = new Promise((resolve) => {
      //   tcpMock.emitter.once('clientConnected', resolve);
      // });
      //
      // await client.open();
      // const socket = await socketPromise;
      //
      // mockServer.sendHttpRequest(socket, {
      //   method: 'GET',
      //   path: '/'
      // });
      //
      // await new Promise(resolve => setTimeout(resolve, 500));
      // // Request should have reached custom local server

      await customLocalServer.stop();
      await tcpMock.close();
      assert.fail('Replace with your client implementation'); // Remove this line when implementing
    });
  });
});

// =============================================================================
// USAGE INSTRUCTIONS
// =============================================================================

/*

TO USE THIS TEST SUITE:

1. Install dependencies in your client project:
   npm install --save-dev mocha nock

2. Ensure your package.json has "type": "module" for ESM support

3. Replace 'YourClientClass' with your actual client implementation

4. Uncomment the test code blocks (marked with TODO comments)

5. Run tests:
   mocha client.spec.js

   The first tests will display version information:
   - Specification version (this file's version)
   - Protocol version (server version it's compatible with)
   - Protocol requirements and capabilities

6. Ensure your client implementation:
   - Extends EventEmitter or implements event handling
   - Has constructor accepting options: { port, host, subdomain, maxSockets }
   - Implements async open() method that returns tunnel info
   - Implements async close() method
   - Implements getInfo() method
   - Emits events: 'request', 'error', 'close', 'dead'

VERSIONING:

This specification file follows semantic versioning (MAJOR.MINOR.PATCH):

- MAJOR: Breaking changes in protocol or test structure
- MINOR: New tests added for new protocol features (backwards compatible)
- PATCH: Bug fixes, documentation updates, clarifications

When updating your client to a new protocol version:
1. Check the VERSION HISTORY at the top of this file
2. Review BREAKING CHANGES section
3. Update your client to match new PROTOCOL_SPECS constants
4. Run tests to ensure compatibility

Current Version: 1.2.0
Protocol Compatibility: 0.0.10-epc
Last Updated: 2025-10-28

VERSION HISTORY:
  1.2.1 (2025-10-28) - Socket Limit Enforcement
    - Documented HTTP 429 (Too Many Connections) response
    - Added SOCKET_LIMIT_RESPONSE specification
    - Server now returns detailed headers: X-LT-Max-Sockets, X-LT-Current-Sockets,
      X-LT-Available-Sockets, X-LT-Waiting-Requests
    - Clear guidance for clients on respecting max_conn_count
    - Enhanced error messages to help client debugging
  1.2.0 (2025-10-28) - HMAC Authentication
    - Added HMAC-SHA256 authentication with shared secret
    - Required headers: Authorization (HMAC sha256=<signature>), X-Timestamp, X-Nonce
    - Message format: METHOD + PATH + TIMESTAMP + NONCE + BODY
    - Numeric nonce (Unix epoch milliseconds) for replay attack prevention
    - Timestamp tolerance and nonce threshold for clock skew handling
    - Fully optional - backward compatible with non-HMAC servers
    - Added PROTOCOL_SPECS for HMAC configuration
    - Added comprehensive test suite for HMAC authentication
  1.1.0 (2025-10-28) - Client Token Authentication
    - Added X-LT-Client-Token header support for token-based identification
    - Allows reconnection with same token from different IPs
    - Fully backward compatible - token is optional
    - Added PROTOCOL_SPECS for token configuration
    - Added test suite for token authentication
  1.0.1 (2025-10-22) - Bug fixes and improvements
    - Previous version details...

EXAMPLE CLIENT INTERFACE:

import { EventEmitter } from 'events';

class MyLocalTunnelClient extends EventEmitter {
  constructor(options) {
    super();
    this.port = options.port;
    this.host = options.host || 'https://localtunnel.me';
    this.subdomain = options.subdomain;
    this.maxSockets = options.maxSockets || 10;
    this.clientToken = options.clientToken; // NEW: Optional client token (v1.1.0)
    // ... your implementation
  }

  async open() {
    // 1. Request tunnel creation
    // 2. Connect TCP sockets
    // 3. Start handling requests
    // 4. Return { url, id, port, maxConnCount }
  }

  async close() {
    // Close all sockets and cleanup
  }

  getInfo() {
    return {
      url: this.url,
      id: this.tunnelId,
      isConnected: this.isConnected,
      socketCount: this.sockets.length
    };
  }
}

*/
