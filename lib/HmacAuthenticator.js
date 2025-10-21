import crypto from 'crypto';
import fs from 'fs';
import Debug from 'debug';
import NonceCache from './NonceCache.js';

/**
 * HMAC-SHA256 Authenticator with shared secret
 * Provides authentication using HMAC signatures with timestamp and numeric nonce
 */
class HmacAuthenticator {
    constructor(options = {}) {
        // Initialize debug first before any other operations
        this.debug = Debug('localtunnel:authenticator:hmac');

        this.secret = this.loadSecret();
        this.timestampTolerance = options.timestampTolerance || 60; // segundos
        this.nonceThreshold = options.nonceThreshold || 3600; // segundos
        const nonceCacheTTL = options.nonceCacheTTL || 7200; // segundos
        this.nonceCache = new NonceCache(nonceCacheTTL);

        this.debug('HMAC Authenticator initialized: timestampTolerance=%ds, nonceThreshold=%ds, cacheTTL=%ds',
                  this.timestampTolerance, this.nonceThreshold, nonceCacheTTL);
    }

    /**
     * Carrega segredo de variável de ambiente ou arquivo
     * Prioridade: LT_HMAC_SECRET > FILE_LT_HMAC_SECRET
     */
    loadSecret() {
        // Prioridade: LT_HMAC_SECRET > FILE_LT_HMAC_SECRET
        if (process.env.LT_HMAC_SECRET) {
            this.debug('Loading secret from LT_HMAC_SECRET');
            const secret = process.env.LT_HMAC_SECRET.trim();
            this.validateSecret(secret);
            return secret;
        }

        if (process.env.FILE_LT_HMAC_SECRET) {
            const filePath = process.env.FILE_LT_HMAC_SECRET;
            this.debug('Loading secret from file: %s', filePath);

            try {
                const secret = fs.readFileSync(filePath, 'utf8').trim().split('\n')[0];
                this.validateSecret(secret);
                return secret;
            } catch (err) {
                throw new Error(`Failed to read HMAC secret from file ${filePath}: ${err.message}`);
            }
        }

        throw new Error('HMAC secret not configured (LT_HMAC_SECRET or FILE_LT_HMAC_SECRET required)');
    }

    /**
     * Valida o segredo
     */
    validateSecret(secret) {
        if (!secret || secret.length < 32) {
            throw new Error('HMAC secret must be at least 32 characters long');
        }
    }

    /**
     * Valida uma requisição completa
     * @param {Object} req - Objeto de requisição (Koa request)
     * @returns {Object} { valid: boolean, reason: string, ... }
     */
    async validateRequest(req) {
        const debugMode = process.env.DEBUG && process.env.DEBUG.includes('localtunnel');

        try {
            // 1. Extrai headers
            const { authorization, timestamp, nonce } = this.extractHeaders(req);

            // 2. Valida formato do Authorization
            const signature = this.parseAuthorizationHeader(authorization);

            // 3. Valida timestamp
            this.validateTimestamp(timestamp);

            // 4. Valida nonce (formato, threshold, replay)
            this.validateNonce(nonce, timestamp);

            // 5. Reconstrói mensagem
            const method = req.method;
            const path = req.path || req.url;
            const body = req.body ? JSON.stringify(req.body) : '';
            const message = this.buildMessage(method, path, timestamp, nonce, body);

            // 6. Calcula HMAC esperado
            const expectedSignature = this.calculateHmac(message);

            // 7. Verifica signature (timing-safe)
            if (!this.verifySignature(signature, expectedSignature)) {
                return {
                    valid: false,
                    reason: 'Invalid HMAC signature',
                    reasonCode: 'invalid_signature',
                    debugMode
                };
            }

            // 8. Armazena nonce no cache
            this.nonceCache.add(nonce);

            this.debug('Authentication successful for %s %s', method, path);
            return { valid: true };

        } catch (err) {
            this.debug('Authentication failed: %s', err.message);
            return {
                valid: false,
                reason: err.message,
                reasonCode: err.code || 'unknown',
                details: err.details,
                debugMode
            };
        }
    }

    /**
     * Extrai e valida presença dos headers necessários
     */
    extractHeaders(req) {
        const authorization = req.headers['authorization'] || req.headers['Authorization'];
        const timestamp = req.headers['x-timestamp'] || req.headers['X-Timestamp'];
        const nonce = req.headers['x-nonce'] || req.headers['X-Nonce'];

        if (!authorization) {
            const err = new Error('Missing Authorization header');
            err.code = 'missing_auth_header';
            throw err;
        }

        if (!timestamp) {
            const err = new Error('Missing X-Timestamp header');
            err.code = 'missing_timestamp';
            throw err;
        }

        if (!nonce) {
            const err = new Error('Missing X-Nonce header');
            err.code = 'missing_nonce';
            throw err;
        }

        return { authorization, timestamp, nonce };
    }

    /**
     * Faz parse do Authorization header
     * Formato esperado: "HMAC sha256=abc123..."
     */
    parseAuthorizationHeader(authorization) {
        const match = authorization.match(/^HMAC\s+sha256=([a-f0-9]+)$/i);

        if (!match) {
            const err = new Error('Invalid Authorization header format (expected: HMAC sha256=<hex>)');
            err.code = 'invalid_auth_format';
            throw err;
        }

        return match[1];
    }

    /**
     * Valida o timestamp
     * Verifica se está dentro da janela de tolerância
     */
    validateTimestamp(timestampStr) {
        const timestamp = parseInt(timestampStr, 10);

        if (isNaN(timestamp)) {
            const err = new Error('Invalid timestamp (must be numeric)');
            err.code = 'invalid_timestamp';
            throw err;
        }

        const now = Math.floor(Date.now() / 1000);
        const diff = Math.abs(now - timestamp);

        if (diff > this.timestampTolerance) {
            const err = new Error(`Timestamp expired (diff: ${diff}s, tolerance: ${this.timestampTolerance}s)`);
            err.code = 'expired_timestamp';
            err.details = `Request timestamp: ${timestamp}, Server time: ${now}`;
            throw err;
        }

        this.debug('Timestamp valid: %d (diff: %ds)', timestamp, now - timestamp);
    }

    /**
     * Valida o nonce
     * - Deve ser numérico (Unix epoch em milissegundos)
     * - Não pode ser muito antigo (anterior ao threshold)
     * - Não pode ser muito no futuro (além da tolerância do timestamp)
     * - Não pode ter sido usado antes (replay check)
     */
    validateNonce(nonceStr, timestampStr) {
        const nonce = parseInt(nonceStr, 10);

        if (isNaN(nonce)) {
            const err = new Error('Invalid nonce (must be numeric Unix epoch in milliseconds)');
            err.code = 'invalid_nonce';
            throw err;
        }

        const timestamp = parseInt(timestampStr, 10);

        // Nonce não pode ser muito antigo (anterior ao threshold)
        const minAllowedNonce = (timestamp - this.nonceThreshold) * 1000;
        if (nonce < minAllowedNonce) {
            const err = new Error(`Nonce too old (threshold: ${this.nonceThreshold}s)`);
            err.code = 'nonce_too_old';
            err.details = `Nonce: ${nonce}, Min allowed: ${minAllowedNonce}`;
            throw err;
        }

        // Nonce não pode ser muito no futuro
        const maxAllowedNonce = (timestamp + this.timestampTolerance) * 1000;
        if (nonce > maxAllowedNonce) {
            const err = new Error(`Nonce too new (tolerance: ${this.timestampTolerance}s)`);
            err.code = 'nonce_too_new';
            err.details = `Nonce: ${nonce}, Max allowed: ${maxAllowedNonce}`;
            throw err;
        }

        // Verifica replay (nonce já usado)
        if (this.nonceCache.has(nonce)) {
            const err = new Error('Nonce already used (replay attack detected)');
            err.code = 'replay_detected';
            err.details = `Nonce: ${nonce}`;
            throw err;
        }

        this.debug('Nonce valid: %d', nonce);
    }

    /**
     * Constrói a mensagem para HMAC
     * Formato: METHOD + PATH + TIMESTAMP + NONCE + BODY
     */
    buildMessage(method, path, timestamp, nonce, body = '') {
        return `${method}${path}${timestamp}${nonce}${body}`;
    }

    /**
     * Calcula HMAC-SHA256 da mensagem
     */
    calculateHmac(message) {
        return crypto
            .createHmac('sha256', this.secret)
            .update(message)
            .digest('hex');
    }

    /**
     * Verifica assinatura usando comparação timing-safe
     */
    verifySignature(provided, expected) {
        // Timing-safe comparison
        const providedBuf = Buffer.from(provided, 'hex');
        const expectedBuf = Buffer.from(expected, 'hex');

        if (providedBuf.length !== expectedBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(providedBuf, expectedBuf);
    }

    /**
     * Retorna estatísticas do autenticador
     */
    getStats() {
        return {
            cacheSize: this.nonceCache.size(),
            timestampTolerance: this.timestampTolerance,
            nonceThreshold: this.nonceThreshold
        };
    }

    /**
     * Destroy o autenticador e libera recursos
     */
    destroy() {
        this.nonceCache.destroy();
    }
}

export default HmacAuthenticator;
