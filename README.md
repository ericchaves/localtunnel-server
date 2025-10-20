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
