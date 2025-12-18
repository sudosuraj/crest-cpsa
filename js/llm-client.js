/**
 * Global LLM API Client with Rate Limiting, Retry Logic, and Queue Management
 * 
 * This module provides a centralized way to make LLM API calls with:
 * - Global request queue with configurable concurrency
 * - Exponential backoff with jitter for 429 errors
 * - Retry-After header support
 * - Request prioritization (foreground vs background)
 * - Circuit breaker pattern for sustained failures
 */

const LLMClient = (function() {
    // Configuration
    const CONFIG = {
        endpoint: 'https://api.llm7.io/v1/chat/completions',
        model: 'gpt-4o-mini',
        maxConcurrent: 1,           // Max concurrent requests (conservative to avoid 429)
        minRequestSpacing: 1500,    // Minimum ms between starting requests (increased from 1000)
        maxRetries: 3,              // Max retry attempts for retryable errors
        baseBackoffMs: 2000,        // Base backoff time for retries (increased from 1000)
        maxBackoffMs: 60000,        // Maximum backoff time (increased from 30000)
        requestTimeout: 30000,      // Request timeout in ms
        circuitBreakerThreshold: 3, // Consecutive failures before circuit opens (reduced from 5)
        circuitBreakerResetMs: 120000, // Time before circuit breaker resets (increased from 60000)
        rateLimitCooldownMs: 30000, // Extra cooldown after hitting rate limit
        storageKey: 'llm_client_state' // Key for persisting state
    };

    // Queue state
    const requestQueue = [];
    let activeRequests = 0;
    let lastRequestTime = 0;
    let isProcessing = false;

    // Circuit breaker state
    let consecutiveFailures = 0;
    let circuitOpenUntil = 0;

    // Rate limit state (persisted across reloads)
    let rateLimitCooldownUntil = 0;
    let dynamicSpacing = CONFIG.minRequestSpacing; // Increases after 429s

    // Cross-tab coordination
    let broadcastChannel = null;
    try {
        broadcastChannel = new BroadcastChannel('llm_client_sync');
        broadcastChannel.onmessage = handleBroadcastMessage;
    } catch (e) {
        console.warn('BroadcastChannel not available, cross-tab sync disabled');
    }

    // Load persisted state on init
    loadPersistedState();

    // Statistics for debugging
    const stats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        retriedRequests: 0,
        rateLimitHits: 0,
        cacheHits: 0
    };

    /**
     * Load persisted rate limit state from localStorage
     */
    function loadPersistedState() {
        try {
            const saved = localStorage.getItem(CONFIG.storageKey);
            if (saved) {
                const state = JSON.parse(saved);
                if (state.rateLimitCooldownUntil && state.rateLimitCooldownUntil > Date.now()) {
                    rateLimitCooldownUntil = state.rateLimitCooldownUntil;
                    console.log(`LLMClient: Rate limit cooldown active until ${new Date(rateLimitCooldownUntil).toISOString()}`);
                }
                if (state.dynamicSpacing) {
                    dynamicSpacing = Math.min(state.dynamicSpacing, CONFIG.maxBackoffMs);
                }
            }
        } catch (e) {
            console.warn('Failed to load LLMClient state:', e);
        }
    }

    /**
     * Save rate limit state to localStorage
     */
    function savePersistedState() {
        try {
            localStorage.setItem(CONFIG.storageKey, JSON.stringify({
                rateLimitCooldownUntil,
                dynamicSpacing,
                lastUpdated: Date.now()
            }));
        } catch (e) {
            console.warn('Failed to save LLMClient state:', e);
        }
    }

    /**
     * Handle messages from other tabs
     */
    function handleBroadcastMessage(event) {
        const { type, data } = event.data;
        if (type === 'rate_limit') {
            // Another tab hit a rate limit, apply cooldown here too
            if (data.cooldownUntil > rateLimitCooldownUntil) {
                rateLimitCooldownUntil = data.cooldownUntil;
                dynamicSpacing = Math.max(dynamicSpacing, data.dynamicSpacing || CONFIG.minRequestSpacing);
                console.log(`LLMClient: Rate limit synced from another tab, cooldown until ${new Date(rateLimitCooldownUntil).toISOString()}`);
            }
        }
    }

    /**
     * Broadcast rate limit to other tabs
     */
    function broadcastRateLimit() {
        if (broadcastChannel) {
            try {
                broadcastChannel.postMessage({
                    type: 'rate_limit',
                    data: {
                        cooldownUntil: rateLimitCooldownUntil,
                        dynamicSpacing
                    }
                });
            } catch (e) {
                console.warn('Failed to broadcast rate limit:', e);
            }
        }
    }

    /**
     * Priority levels for requests
     */
    const Priority = {
        HIGH: 1,      // User-initiated foreground requests
        NORMAL: 2,    // Standard requests
        LOW: 3        // Background preloading
    };

    /**
     * Add jitter to backoff time to prevent thundering herd
     */
    function addJitter(ms) {
        const jitter = Math.random() * 0.3 * ms; // 0-30% jitter
        return Math.floor(ms + jitter);
    }

    /**
     * Calculate exponential backoff time
     */
    function calculateBackoff(attempt, retryAfterMs = null) {
        if (retryAfterMs) {
            return addJitter(retryAfterMs);
        }
        const exponentialBackoff = Math.min(
            CONFIG.baseBackoffMs * Math.pow(2, attempt),
            CONFIG.maxBackoffMs
        );
        return addJitter(exponentialBackoff);
    }

    /**
     * Check if error is retryable
     */
    function isRetryableError(status, error) {
        if (status === 429) return true; // Rate limited
        if (status >= 500 && status < 600) return true; // Server errors
        if (!status && error) return true; // Network errors
        return false;
    }

    /**
     * Parse Retry-After header (can be seconds or HTTP date)
     */
    function parseRetryAfter(response) {
        const retryAfter = response.headers.get('Retry-After');
        if (!retryAfter) return null;
        
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
            return seconds * 1000;
        }
        
        // Try parsing as HTTP date
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
        
        return null;
    }

    /**
     * Check if circuit breaker is open
     */
    function isCircuitOpen() {
        if (Date.now() < circuitOpenUntil) {
            return true;
        }
        // Reset circuit breaker if time has passed
        if (circuitOpenUntil > 0 && Date.now() >= circuitOpenUntil) {
            circuitOpenUntil = 0;
            consecutiveFailures = 0;
        }
        return false;
    }

    /**
     * Record a failure for circuit breaker
     */
    function recordFailure() {
        consecutiveFailures++;
        if (consecutiveFailures >= CONFIG.circuitBreakerThreshold) {
            circuitOpenUntil = Date.now() + CONFIG.circuitBreakerResetMs;
            console.warn(`LLMClient: Circuit breaker opened for ${CONFIG.circuitBreakerResetMs}ms after ${consecutiveFailures} consecutive failures`);
        }
    }

    /**
     * Record a success for circuit breaker
     */
    function recordSuccess() {
        consecutiveFailures = 0;
    }

    /**
     * Make a single API request with timeout
     */
    async function makeRequest(payload) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

        try {
            const response = await fetch(CONFIG.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: payload.model || CONFIG.model,
                    messages: payload.messages,
                    max_tokens: payload.max_tokens || 600,
                    temperature: payload.temperature || 0.7
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    /**
     * Execute a request with retry logic
     */
    async function executeWithRetry(payload, priority) {
        let lastError = null;
        
        for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
            // Check circuit breaker
            if (isCircuitOpen()) {
                throw new Error('Circuit breaker is open - too many recent failures');
            }

            try {
                const response = await makeRequest(payload);
                
                if (response.ok) {
                    recordSuccess();
                    stats.successfulRequests++;
                    return await response.json();
                }

                // Handle rate limiting
                if (response.status === 429) {
                    stats.rateLimitHits++;
                    const retryAfterMs = parseRetryAfter(response);
                    
                    // Set cooldown and increase dynamic spacing
                    const cooldownMs = retryAfterMs || CONFIG.rateLimitCooldownMs;
                    rateLimitCooldownUntil = Date.now() + cooldownMs;
                    dynamicSpacing = Math.min(dynamicSpacing * 2, CONFIG.maxBackoffMs);
                    
                    // Persist and broadcast to other tabs
                    savePersistedState();
                    broadcastRateLimit();
                    
                    if (attempt < CONFIG.maxRetries) {
                        const backoffMs = calculateBackoff(attempt, retryAfterMs);
                        console.warn(`LLMClient: Rate limited (429), cooldown ${cooldownMs}ms, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${CONFIG.maxRetries})`);
                        stats.retriedRequests++;
                        await new Promise(resolve => setTimeout(resolve, backoffMs));
                        continue;
                    }
                }

                // Handle other retryable errors
                if (isRetryableError(response.status) && attempt < CONFIG.maxRetries) {
                    const backoffMs = calculateBackoff(attempt);
                    console.warn(`LLMClient: Server error (${response.status}), retrying in ${backoffMs}ms (attempt ${attempt + 1}/${CONFIG.maxRetries})`);
                    stats.retriedRequests++;
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }

                // Non-retryable error
                recordFailure();
                throw new Error(`API error: ${response.status} ${response.statusText}`);

            } catch (error) {
                lastError = error;
                
                // Network errors are retryable
                if (error.name === 'AbortError') {
                    lastError = new Error('Request timeout');
                }
                
                if (attempt < CONFIG.maxRetries && isRetryableError(null, error)) {
                    const backoffMs = calculateBackoff(attempt);
                    console.warn(`LLMClient: Network error, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${CONFIG.maxRetries}):`, error.message);
                    stats.retriedRequests++;
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }
                
                recordFailure();
                throw lastError;
            }
        }

        recordFailure();
        stats.failedRequests++;
        throw lastError || new Error('Max retries exceeded');
    }

    /**
     * Process the request queue
     */
    async function processQueue() {
        if (isProcessing) return;
        isProcessing = true;

        while (requestQueue.length > 0) {
            // Check if we can start a new request
            if (activeRequests >= CONFIG.maxConcurrent) {
                await new Promise(resolve => setTimeout(resolve, 100));
                continue;
            }

            // Check rate limit cooldown (persisted across reloads and tabs)
            if (Date.now() < rateLimitCooldownUntil) {
                const waitTime = rateLimitCooldownUntil - Date.now();
                console.log(`LLMClient: Rate limit cooldown active, waiting ${waitTime}ms`);
                await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 5000)));
                continue;
            }

            // Use dynamic spacing (increases after 429s, gradually decreases on success)
            const currentSpacing = Math.max(CONFIG.minRequestSpacing, dynamicSpacing);
            const timeSinceLastRequest = Date.now() - lastRequestTime;
            if (timeSinceLastRequest < currentSpacing) {
                await new Promise(resolve => 
                    setTimeout(resolve, currentSpacing - timeSinceLastRequest)
                );
            }

            // Get highest priority request
            requestQueue.sort((a, b) => a.priority - b.priority);
            const request = requestQueue.shift();
            
            if (!request) continue;

            activeRequests++;
            lastRequestTime = Date.now();
            stats.totalRequests++;

            // Execute request asynchronously
            executeWithRetry(request.payload, request.priority)
                .then(result => {
                    request.resolve(result);
                    // Gradually reduce dynamic spacing on success
                    if (dynamicSpacing > CONFIG.minRequestSpacing) {
                        dynamicSpacing = Math.max(CONFIG.minRequestSpacing, dynamicSpacing * 0.9);
                        savePersistedState();
                    }
                })
                .catch(error => {
                    request.reject(error);
                })
                .finally(() => {
                    activeRequests--;
                });
        }

        isProcessing = false;
    }

    /**
     * Queue a request for execution
     * @param {Object} payload - The request payload (messages, max_tokens, temperature)
     * @param {number} priority - Request priority (use Priority constants)
     * @returns {Promise<Object>} - The API response
     */
    function request(payload, priority = Priority.NORMAL) {
        return new Promise((resolve, reject) => {
            requestQueue.push({
                payload,
                priority,
                resolve,
                reject,
                queuedAt: Date.now()
            });
            
            // Start processing if not already running
            processQueue();
        });
    }

    /**
     * High-priority request (for user-initiated actions)
     */
    function requestHighPriority(payload) {
        return request(payload, Priority.HIGH);
    }

    /**
     * Low-priority request (for background preloading)
     */
    function requestLowPriority(payload) {
        return request(payload, Priority.LOW);
    }

    /**
     * Get current queue status
     */
    function getStatus() {
        return {
            queueLength: requestQueue.length,
            activeRequests,
            isCircuitOpen: isCircuitOpen(),
            circuitResetsIn: circuitOpenUntil > 0 ? Math.max(0, circuitOpenUntil - Date.now()) : 0,
            stats: { ...stats }
        };
    }

    /**
     * Clear the queue (for cleanup)
     */
    function clearQueue() {
        while (requestQueue.length > 0) {
            const request = requestQueue.shift();
            request.reject(new Error('Queue cleared'));
        }
    }

    /**
     * Update configuration
     */
    function configure(options) {
        Object.assign(CONFIG, options);
    }

    /**
     * Check if queue is idle (no pending or active requests)
     */
    function isIdle() {
        return requestQueue.length === 0 && activeRequests === 0;
    }

    /**
     * Wait for queue to become idle
     */
    async function waitForIdle(timeoutMs = 60000) {
        const startTime = Date.now();
        while (!isIdle()) {
            if (Date.now() - startTime > timeoutMs) {
                throw new Error('Timeout waiting for queue to become idle');
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return {
        request,
        requestHighPriority,
        requestLowPriority,
        getStatus,
        clearQueue,
        configure,
        isIdle,
        waitForIdle,
        Priority,
        // Expose config for debugging
        getConfig: () => ({ ...CONFIG })
    };
})();

// Make LLMClient available globally
if (typeof window !== 'undefined') {
    window.LLMClient = LLMClient;
}
