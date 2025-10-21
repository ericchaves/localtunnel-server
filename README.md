# localtunnel-server

[![Build Status](https://travis-ci.org/localtunnel/server.svg?branch=master)](https://travis-ci.org/localtunnel/server)

localtunnel exposes your localhost to the world for easy testing and sharing! No need to mess with DNS or deploy just to have others test out your changes.

This repo is the server component. If you are just looking for the CLI localtunnel app, see (https://github.com/localtunnel/localtunnel).

## overview ##

The default localtunnel client connects to the `localtunnel.me` server. You can, however, easily set up and run your own server. In order to run your own localtunnel server you must ensure that your server can meet the following requirements:

* You can set up DNS entries for your `domain.tld` and `*.domain.tld` (or `sub.domain.tld` and `*.sub.domain.tld`).
* The server can accept incoming TCP connections for any non-root TCP port (i.e. ports over 1000).

The above are important as the client will ask the server for a subdomain under a particular domain. The server will listen on any OS-assigned TCP port for client connections.

#### setup

```shell
# pick a place where the files will live
git clone git://github.com/ericchaves/localtunnel-server.git
cd localtunnel-server
npm install

# server set to run on port 1234
bin/server --port 1234
```

The localtunnel server is now running and waiting for client requests on port 1234. You will most likely want to set up a reverse proxy to listen on port 80 (or start localtunnel on port 80 directly).

**NOTE** By default, localtunnel will use subdomains for clients, if you plan to host your localtunnel server itself on a subdomain you will need to use the _--domain_ option and specify the domain name behind which you are hosting localtunnel. (i.e. my-localtunnel-server.example.com)

## Configuration

### Command Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 80 | Port for public tunnel traffic |
| `--address` | 0.0.0.0 | IP address to bind the public server |
| `--secure` | false | Enable HTTPS for tunnel traffic |
| `--domain` | - | Base domain for tunnels (required for subdomains) |
| `--max-sockets` | 10 | Maximum TCP sockets per client |
| `--admin-port` | - | Separate port for admin API (tunnel creation) |
| `--admin-address` | 0.0.0.0 | IP address for admin server |
| `--port-range-start` | - | Start of TCP port range for client connections |
| `--port-range-end` | - | End of TCP port range for client connections |
| `--landing` | - | Landing page URL for root requests |
| `--http-proxy-port` | - | Public HTTP port for generated URLs (proxy/load balancer port) |
| `--https-proxy-port` | - | Public HTTPS port for generated URLs (proxy/load balancer port) |

### Environment Variables

All options can be configured via environment variables using the `LT_` prefix:

| Environment Variable | Equivalent Option |
|---------------------|-------------------|
| `LT_PORT` | `--port` |
| `LT_ADDRESS` | `--address` |
| `LT_SECURE` | `--secure` |
| `LT_DOMAIN` | `--domain` |
| `LT_MAX_SOCKETS` | `--max-sockets` |
| `LT_ADMIN_PORT` | `--admin-port` |
| `LT_ADMIN_ADDRESS` | `--admin-address` |
| `LT_PORT_RANGE_START` | `--port-range-start` |
| `LT_PORT_RANGE_END` | `--port-range-end` |
| `LT_LANDING` | `--landing` |
| `LT_HTTP_PROXY_PORT` | `--http-proxy-port` |
| `LT_HTTPS_PROXY_PORT` | `--https-proxy-port` |

**Usage:** Create a `.env` file in the project root (see `.env.example`) or export variables:

```shell
export LT_PORT=80
export LT_DOMAIN=tunnel.example.com
bin/server
```

### Security Features

#### Separate Admin Port

Run admin operations (tunnel creation) on a separate port from public traffic:

```shell
bin/server --port 80 --admin-port 8080 --domain tunnel.example.com
```

This allows firewall rules to restrict which IPs can create tunnels while keeping public traffic open.

#### Port Range Restriction

Limit client TCP connections to a specific port range:

```shell
bin/server --port 80 --port-range-start 10000 --port-range-end 10100
```

Combined with firewall rules, this restricts which IPs can establish tunnel connections:

```shell
# Allow public traffic
ufw allow 80/tcp

# Restrict tunnel creation and client connections to specific IPs
ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
ufw allow from 192.168.1.0/24 to any port 10000:10100 proto tcp
```

See [CONFIGURATION.md](CONFIGURATION.md) for detailed examples and firewall setup.

### Grace Period & IP-based Subdomain Reservation

When a client disconnects (all TCP sockets close), the server holds the subdomain for a configurable grace period (default: 30 seconds). During this time:

- ✅ The **original client IP** can reconnect and reuse the same subdomain
- ❌ **Other IPs** cannot claim the subdomain (will receive a random subdomain or error, depending on configuration)

This feature allows clients to:
- Survive temporary network interruptions
- Recover from accidental Ctrl+C or process restarts
- Reconnect after laptop sleep/wake cycles
- Maintain the same public URL across reconnections

#### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LT_GRACE_PERIOD` | 30000 (30s) | Milliseconds to hold subdomain after disconnect |
| `LT_MAX_GRACE_PERIOD` | 300000 (5min) | Maximum allowed grace period |
| `LT_IP_VALIDATION_STRICT` | false | If true, returns 409 error on IP mismatch; if false, assigns random subdomain silently |
| `LT_TRUST_PROXY` | false | If true, uses X-Forwarded-For header for IP detection (use behind reverse proxy) |
| `LT_REQUEST_TIMEOUT` | 5000 (5s) | Timeout (ms) for HTTP requests when waiting for tunnel sockets |
| `LT_WEBSOCKET_TIMEOUT` | 10000 (10s) | Timeout (ms) for WebSocket upgrades when waiting for tunnel reconnection |

#### Behavior Examples

**Example 1: Successful Reconnection (Same IP)**
```bash
# Client creates tunnel
$ lt --port 3000 --subdomain myapp
your url is: https://myapp.tunnel.me

# Client disconnects (Ctrl+C or network issue)
# Within 30 seconds...

# Client reconnects with same subdomain
$ lt --port 3000 --subdomain myapp
your url is: https://myapp.tunnel.me  # ✅ Same subdomain restored!
```

**Example 2: Different IP Blocked (Silent Mode - Default)**
```bash
# Client A (IP 1.2.3.4) creates tunnel
$ lt --port 3000 --subdomain myapp
your url is: https://myapp.tunnel.me

# Client A disconnects (grace period active)

# Client B (IP 5.6.7.8) tries to claim same subdomain
$ lt --port 3000 --subdomain myapp
your url is: https://clever-wombat-42.tunnel.me  # ⚠️ Received different subdomain
```

**Example 3: Different IP Blocked (Strict Mode)**
```bash
# Enable strict mode
$ export LT_IP_VALIDATION_STRICT=true

# Client A (IP 1.2.3.4) creates tunnel
$ lt --port 3000 --subdomain myapp
your url is: https://myapp.tunnel.me

# Client A disconnects

# Client B (IP 5.6.7.8) tries to claim subdomain
$ lt --port 3000 --subdomain myapp
Error: Subdomain "myapp" is reserved by another client. Try again in 25s or use a different subdomain.
```

**Example 4: Behind Reverse Proxy**
```bash
# When running behind Nginx/Cloudflare
$ export LT_TRUST_PROXY=true
$ bin/server --port 8080

# Server will use X-Forwarded-For header to identify real client IP
```

#### How It Works

1. **Client connects**: Server records the client's IP address
2. **Client disconnects**: Grace period timer starts (default: 30s)
3. **During grace period**:
   - Original IP can reconnect → Gets same subdomain
   - Different IP requests subdomain → Blocked (random ID or error)
4. **After grace period**: Subdomain becomes available to any IP

#### Compatibility

This feature is **fully compatible** with the official localtunnel client:
- Automatic TCP socket reconnection works seamlessly
- HTTP reconnection (new tunnel request) preserves subdomain
- No client-side changes required

### Client Token Authentication

**New in Protocol v0.0.9-epc**: Clients can now use a token-based identifier instead of IP address for subdomain reservation.

#### Why Use Token Authentication?

Token-based identification solves several problems:
- **Dynamic IPs**: Clients with changing IPs (mobile, cloud containers) can maintain subdomains
- **NAT/Proxy**: Multiple clients behind same NAT/proxy can have unique identifiers
- **Predictable reconnection**: Same token always gets same subdomain during grace period
- **Cloud environments**: Kubernetes pods, serverless functions with ephemeral IPs

#### How to Use

Clients send the `X-LT-Client-Token` header when creating a tunnel:

```bash
# Example with curl
curl -H "X-LT-Client-Token: my-unique-token-123" \
  https://tunnel.example.com:8080/my-subdomain

# Example with custom client implementation
const headers = {
  'X-LT-Client-Token': 'my-unique-token-123'
};
```

#### Token Format

- **Characters**: Alphanumeric, hyphens, underscores only (`a-zA-Z0-9_-`)
- **Length**: 1-256 characters
- **Case-sensitive**: `Token-1` ≠ `token-1`
- **Examples**:
  - ✅ Valid: `my-token-123`, `user_abc`, `TOKEN-xyz`
  - ❌ Invalid: `token with spaces`, `token@email`, `token#special`

#### Behavior

| Scenario | Token Provided? | IP Match? | Result |
|----------|----------------|-----------|---------|
| New tunnel | No | N/A | Uses IP (legacy behavior) |
| New tunnel | Yes | N/A | Uses token as identifier |
| Reconnect | No | Yes | Allowed (IP match) |
| Reconnect | No | No | Blocked (IP mismatch) |
| **Reconnect** | **Yes** | **Any** | **Allowed if token matches** |

#### Examples

**Example 1: Token allows IP change**
```bash
# Client creates tunnel from IP 1.2.3.4
$ curl -H "X-LT-Client-Token: my-app-token" https://tunnel.me:8080/myapp
{"id":"myapp","port":10000,...}

# Client disconnects, IP changes to 5.6.7.8

# Reconnect with same token (different IP) - works!
$ curl -H "X-LT-Client-Token: my-app-token" https://tunnel.me:8080/myapp
{"id":"myapp","port":10001,...}  # ✅ Same subdomain!
```

**Example 2: Different token blocked**
```bash
# Client A with token1
$ curl -H "X-LT-Client-Token: token-a" https://tunnel.me:8080/shared
{"id":"shared",...}

# Client A disconnects (grace period active)

# Client B tries with different token
$ curl -H "X-LT-Client-Token: token-b" https://tunnel.me:8080/shared
# Strict mode: 409 error
# Silent mode: Gets random subdomain (e.g., "clever-fox-42")
```

**Example 3: Backward compatibility**
```bash
# Old clients without token still work
$ curl https://tunnel.me:8080/oldapp
{"id":"oldapp",...}  # Uses IP-based identification
```

#### Configuration

No server configuration needed! Token support is:
- ✅ **Always enabled**
- ✅ **Fully backward compatible**
- ✅ **Optional for clients**

Existing environment variables still apply:
- `LT_GRACE_PERIOD`: Works with both IP and token identification
- `LT_IP_VALIDATION_STRICT`: Now also validates token mismatches
- `LT_TRUST_PROXY`: Still used when token is not provided

#### Security Considerations

⚠️ **Important**: Client tokens are NOT authentication or encryption!

- Tokens are sent in **plain text** in HTTP headers
- Anyone with the token can "steal" the subdomain during grace period
- Use HTTPS (`--secure true`) to protect tokens in transit
- Tokens are for **session identification**, not security
- For production: Use firewall rules to restrict admin API access (see Security Features)

#### Client Implementation

For client developers, add token support:

```javascript
// Example client implementation
const tunnelRequest = {
  method: 'GET',
  path: '/my-subdomain',
  headers: {
    'X-LT-Client-Token': generateClientToken() // Your token logic
  }
};
```

See [client.spec.reference.js](./client.spec.reference.js) for full protocol specification and test examples.

### HMAC Authentication

**New in Protocol v0.0.10-epc**: Optional HMAC-SHA256 authentication for tunnel creation to prevent unauthorized tunnel creation.

#### Why Use HMAC Authentication?

HMAC authentication provides cryptographic security for tunnel creation:
- **Prevent unauthorized tunnels**: Only clients with the shared secret can create tunnels
- **Replay attack protection**: Nonce-based validation prevents reuse of captured requests
- **Timestamp validation**: Requests must be recent (configurable tolerance window)
- **No plaintext passwords**: Shared secret is never transmitted, only HMAC signatures
- **Production security**: Essential for public-facing localtunnel servers

#### Configuration

Enable HMAC authentication by setting the shared secret:

```bash
# Method 1: Environment variable
export LT_HMAC_SECRET="your-shared-secret-at-least-32-characters-long"
bin/server

# Method 2: Docker secret file
export FILE_LT_HMAC_SECRET="/run/secrets/hmac_secret"
bin/server

# Optional: Configure tolerances
export LT_HMAC_TIMESTAMP_TOLERANCE=60      # Seconds (default: 60)
export LT_HMAC_NONCE_THRESHOLD=3600        # Seconds (default: 3600)
export LT_HMAC_NONCE_CACHE_TTL=7200        # Seconds (default: 7200)
```

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `LT_HMAC_SECRET` | - | Shared secret for HMAC (min 32 chars, required to enable HMAC) |
| `FILE_LT_HMAC_SECRET` | - | Path to file containing secret (Docker secrets, Kubernetes) |
| `LT_HMAC_TIMESTAMP_TOLERANCE` | 60 | Max age of timestamp in seconds (handles clock skew) |
| `LT_HMAC_NONCE_THRESHOLD` | 3600 | Max age of nonce in seconds (prevents old nonce reuse) |
| `LT_HMAC_NONCE_CACHE_TTL` | 7200 | How long to cache used nonces (should be ≥ threshold) |

**Note**: When `LT_HMAC_SECRET` or `FILE_LT_HMAC_SECRET` is set, HMAC authentication becomes **required** for all tunnel creation requests.

#### Protocol

Clients must send three headers with tunnel creation requests:

```
Authorization: HMAC sha256=<hex_signature>
X-Timestamp: <unix_seconds>
X-Nonce: <unix_milliseconds>
```

**Signature Calculation:**
```
message = METHOD + PATH + TIMESTAMP + NONCE + BODY
signature = HMAC-SHA256(secret, message)
```

**Example:**
```javascript
const crypto = require('crypto');
const secret = 'my-shared-secret-at-least-32-characters-long';

// Request details
const method = 'GET';
const path = '/my-subdomain';
const timestamp = Math.floor(Date.now() / 1000).toString();  // Unix seconds
const nonce = Date.now().toString();  // Unix milliseconds
const body = '';  // Empty for GET requests

// Build message and calculate HMAC
const message = `${method}${path}${timestamp}${nonce}${body}`;
const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');

// Send request
const headers = {
  'Authorization': `HMAC sha256=${signature}`,
  'X-Timestamp': timestamp,
  'X-Nonce': nonce
};
```

#### Examples

**Example 1: Basic HMAC Request**
```bash
# Shell script for HMAC authenticated tunnel creation
SECRET="my-shared-secret-at-least-32-characters-long"
METHOD="GET"
PATH="/my-app"
TIMESTAMP=$(date +%s)
NONCE=$(date +%s%3N)  # Milliseconds
BODY=""

MESSAGE="${METHOD}${PATH}${TIMESTAMP}${NONCE}${BODY}"
SIGNATURE=$(echo -n "$MESSAGE" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)

curl -H "Authorization: HMAC sha256=$SIGNATURE" \
     -H "X-Timestamp: $TIMESTAMP" \
     -H "X-Nonce: $NONCE" \
     https://tunnel.example.com:8080/my-app
```

**Example 2: Client Implementation**
```javascript
// Example client with HMAC support
class SecureLocaltunnelClient {
  constructor(options) {
    this.hmacSecret = options.hmacSecret;
    // ... other options
  }

  calculateHmac(method, path, timestamp, nonce, body = '') {
    const message = `${method}${path}${timestamp}${nonce}${body}`;
    return crypto.createHmac('sha256', this.hmacSecret)
                 .update(message)
                 .digest('hex');
  }

  async createTunnel(subdomain) {
    const method = 'GET';
    const path = `/${subdomain}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = Date.now().toString();
    const signature = this.calculateHmac(method, path, timestamp, nonce);

    const response = await fetch(`https://tunnel.example.com/${subdomain}`, {
      headers: {
        'Authorization': `HMAC sha256=${signature}`,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce
      }
    });

    return await response.json();
  }
}
```

#### Validation Rules

1. **Timestamp Validation**
   - Must be within `LT_HMAC_TIMESTAMP_TOLERANCE` seconds of server time
   - Handles clock skew between client and server
   - Prevents replay attacks with old timestamps

2. **Nonce Validation**
   - Must be numeric (Unix epoch in milliseconds)
   - Cannot be older than `timestamp - LT_HMAC_NONCE_THRESHOLD`
   - Cannot be reused (cached for `LT_HMAC_NONCE_CACHE_TTL` seconds)
   - Prevents replay attacks

3. **Signature Validation**
   - Uses timing-safe comparison to prevent timing attacks
   - Message format: `METHOD` + `PATH` + `TIMESTAMP` + `NONCE` + `BODY`
   - Must match server-calculated signature

#### Error Responses

```bash
# Missing headers
HTTP/1.1 401 Unauthorized
{"message": "Missing Authorization header"}

# Invalid signature
HTTP/1.1 401 Unauthorized
{"message": "Invalid HMAC signature"}

# Expired timestamp
HTTP/1.1 401 Unauthorized
{"message": "Timestamp expired (diff: 120s, tolerance: 60s)"}

# Replay attack (nonce reused)
HTTP/1.1 401 Unauthorized
{"message": "Nonce already used (replay attack detected)"}
```

#### Security Best Practices

1. **Generate Strong Secrets**
   ```bash
   # Generate a random 64-character secret
   openssl rand -hex 32
   ```

2. **Protect the Secret**
   - Never commit secrets to version control
   - Use Docker secrets, Kubernetes secrets, or environment variables
   - Rotate secrets periodically

3. **Use HTTPS**
   - Always use `--secure true` with HMAC authentication
   - Prevents network eavesdropping
   - Protects other headers (tokens, etc.)

4. **Configure Appropriate Tolerances**
   ```bash
   # Strict configuration (for secure networks)
   LT_HMAC_TIMESTAMP_TOLERANCE=30      # 30 seconds
   LT_HMAC_NONCE_THRESHOLD=1800        # 30 minutes

   # Relaxed configuration (for clients with clock skew)
   LT_HMAC_TIMESTAMP_TOLERANCE=300     # 5 minutes
   LT_HMAC_NONCE_THRESHOLD=7200        # 2 hours
   ```

#### Compatibility

- **Backward compatible**: HMAC is optional; servers without `LT_HMAC_SECRET` work normally
- **Client support**: Requires client implementation (see `client.spec.reference.js`)
- **Status endpoint**: `/api/status` is always accessible without authentication

#### Docker Deployment with HMAC

```bash
# Using Docker secrets
echo "your-hmac-secret-at-least-32-chars" | docker secret create hmac_secret -

docker service create \
  --name localtunnel \
  --secret hmac_secret \
  -e FILE_LT_HMAC_SECRET=/run/secrets/hmac_secret \
  -e LT_DOMAIN=tunnel.example.com \
  -e LT_SECURE=true \
  -p 443:443 \
  ghcr.io/your-user/localtunnel-server:latest
```

See [client.spec.reference.js](./client.spec.reference.js) for complete HMAC protocol specification and test examples.

### Reverse Proxy Configuration

When running behind a reverse proxy (Traefik, Nginx, etc.), use these settings to ensure correct URL generation:

```shell
# Example with Traefik handling SSL on port 443
bin/server \
  --port 3000 \
  --admin-port 8080 \
  --https-proxy-port 443 \
  --secure true \
  --domain tunnel.example.com
```

**How it works:**
- Client connects to admin API via proxy: `https://tunnel.example.com:8080`
- Server generates tunnel URL using `--https-proxy-port`: `https://client-id.tunnel.example.com` (port 443 implied)
- Public traffic flows: User → Proxy:443 → Server:3000 → Client tunnel

**Without proxy (direct access):**
```shell
bin/server --port 3000 --admin-port 8080 --domain tunnel.example.com
```
- Tunnel URLs will use port 3000: `http://client-id.tunnel.example.com:3000`

**Why these variables are needed:**
- `LT_PORT` and `LT_ADMIN_PORT`: Internal container ports (not exposed to host)
- `LT_HTTP_PROXY_PORT` and `LT_HTTPS_PROXY_PORT`: Public proxy ports (what users access)
- Without these settings, URLs would incorrectly include internal ports

**Behavior:**
- When `--http-proxy-port` or `--https-proxy-port` is set, tunnel URLs use those ports
- Standard ports (80 for HTTP, 443 for HTTPS) are omitted from URLs
- Non-standard ports are included in URLs (e.g., `:8443`)
- If proxy port variables are not set, defaults to `--port` value

#### use your server

You can now use your domain with the `--host` flag for the `lt` client.

```shell
lt --host http://sub.example.tld:1234 --port 9000
```

You will be assigned a URL similar to `heavy-puma-9.sub.example.com:1234`.

If your server is acting as a reverse proxy (i.e. nginx) and is able to listen on port 80, then you do not need the `:1234` part of the hostname for the `lt` client.

## REST API

### POST /api/tunnels

Create a new tunnel. A LocalTunnel client posts to this enpoint to request a new tunnel with a specific name or a randomly assigned name.

### GET /api/status

General server information.

## Deploy

You can deploy your own localtunnel server using the prebuilt docker image.

**Note** This assumes that you have a proxy in front of the server to handle the http(s) requests and forward them to the localtunnel server on port 3000. You can use our [localtunnel-nginx](https://github.com/localtunnel/nginx) to accomplish this.

If you do not want ssl support for your own tunnel (not recommended), then you can just run the below with `--port 80` instead.

```
docker pull ghcr.io/your-user/localtunnel-server:latest

docker run -d \
  --name localtunnel \
  -p 80:80 \
  -e LT_DOMAIN=tunnel.example.com \
  ghcr.io/your-user/localtunnel-server:latest
```
