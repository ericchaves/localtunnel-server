import Debug from 'debug';

/**
 * Cache em memória para prevenir replay attacks
 * Armazena nonces já usados com TTL
 */
class NonceCache {
    constructor(ttl = 7200, cleanupIntervalMs = null) { // TTL em segundos
        this.cache = new Map(); // nonce -> expiryTime (ms)
        this.ttl = ttl * 1000; // Converte para ms
        this.debug = Debug('localtunnel:noncecache');

        this.debug('NonceCache initialized: TTL=%ds', ttl);

        // Cleanup automático - usa env var ou default 60 segundos
        const interval = cleanupIntervalMs || parseInt(process.env.LT_NONCE_CLEANUP_INTERVAL) || 60000;
        this.cleanupInterval = setInterval(() => this.cleanup(), interval);
        this.cleanupInterval.unref(); // Não impede o processo de terminar
    }

    /**
     * Verifica se nonce já existe no cache (e não expirou)
     * @param {number} nonce - Unix epoch em milissegundos
     * @returns {boolean}
     */
    has(nonce) {
        const nonceStr = nonce.toString();

        if (!this.cache.has(nonceStr)) {
            return false;
        }

        // Verifica se ainda não expirou
        const expiryTime = this.cache.get(nonceStr);
        const now = Date.now();

        if (now >= expiryTime) {
            // Expirou, remove
            this.cache.delete(nonceStr);
            return false;
        }

        return true;
    }

    /**
     * Adiciona nonce ao cache com TTL
     * @param {number} nonce - Unix epoch em milissegundos
     */
    add(nonce) {
        const nonceStr = nonce.toString();
        const expiryTime = Date.now() + this.ttl;

        this.cache.set(nonceStr, expiryTime);
        this.debug('Nonce added: %s (expires at: %d)', nonceStr, expiryTime);
    }

    /**
     * Remove nonces expirados do cache
     * Chamado periodicamente pelo interval
     */
    cleanup() {
        const now = Date.now();
        let removed = 0;

        for (const [nonce, expiryTime] of this.cache.entries()) {
            if (now >= expiryTime) {
                this.cache.delete(nonce);
                removed++;
            }
        }

        if (removed > 0) {
            this.debug('Cleanup: removed %d expired nonces (remaining: %d)', removed, this.cache.size);
        }
    }

    /**
     * Limpa todo o cache
     */
    clear() {
        this.cache.clear();
        this.debug('Cache cleared');
    }

    /**
     * Retorna o tamanho atual do cache
     * @returns {number}
     */
    size() {
        return this.cache.size;
    }

    /**
     * Retorna estatísticas do cache
     * @returns {Object}
     */
    stats() {
        return {
            size: this.cache.size,
            ttl: this.ttl,
        };
    }

    /**
     * Destroy o cache e limpa o interval
     */
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.clear();
        this.debug('NonceCache destroyed');
    }
}

export default NonceCache;
