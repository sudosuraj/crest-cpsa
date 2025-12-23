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
        storageKey: 'llm_client_state', // Key for persisting state
        apiKeyStorageKey: 'llm_api_key', // Key for storing custom API key
        customEndpointStorageKey: 'llm_custom_endpoint', // Key for storing custom endpoint URL
        customModelStorageKey: 'llm_custom_model' // Key for storing custom model name
    };
    
    // Custom API key (user-provided to avoid 429 errors)
    let customApiKey = null;
    
    // Custom endpoint and model (user-provided for OpenAI-compatible LLMs)
    let customEndpoint = null;
    let customModel = null;

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

    // Cross-tab locking configuration
    const LOCK_CONFIG = {
        storageKey: 'llm_client_lock',
        lockTTL: 10000,           // Lock expires after 10 seconds
        heartbeatInterval: 3000,  // Heartbeat every 3 seconds
        acquireTimeout: 5000      // Max time to wait for lock
    };
    
    // Lock state
    let lockHeartbeatTimer = null;
    let isLockHolder = false;
    const tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Load persisted state on init
    loadPersistedState();
    loadApiKey();
    loadCustomSettings();
    
    // Start listening for storage changes (cross-tab lock coordination)
    if (typeof window !== 'undefined') {
        window.addEventListener('storage', handleStorageChange);
    }

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
     * Load custom API key from localStorage
     */
    function loadApiKey() {
        try {
            const savedKey = localStorage.getItem(CONFIG.apiKeyStorageKey);
            if (savedKey) {
                customApiKey = savedKey;
                console.log('LLMClient: Custom API key loaded');
            }
        } catch (e) {
            console.warn('Failed to load API key:', e);
        }
    }

    /**
     * Set custom API key (user-provided to avoid 429 errors)
     * @param {string} apiKey - The API key to use for requests
     */
    function setApiKey(apiKey) {
        if (apiKey && typeof apiKey === 'string' && apiKey.trim()) {
            customApiKey = apiKey.trim();
            try {
                localStorage.setItem(CONFIG.apiKeyStorageKey, customApiKey);
                console.log('LLMClient: Custom API key saved');
            } catch (e) {
                console.warn('Failed to save API key:', e);
            }
            return true;
        }
        return false;
    }

    /**
     * Clear custom API key
     */
    function clearApiKey() {
        customApiKey = null;
        try {
            localStorage.removeItem(CONFIG.apiKeyStorageKey);
            console.log('LLMClient: Custom API key cleared');
        } catch (e) {
            console.warn('Failed to clear API key:', e);
        }
    }

    /**
     * Check if a custom API key is set
     */
    function hasApiKey() {
        return !!customApiKey;
    }

    // ==================== OWASP SECURITY VALIDATION ====================
    
    /**
     * Validate URL format with OWASP security considerations
     * - Must be valid HTTPS URL (or HTTP for localhost development)
     * - Prevents javascript:, data:, and other dangerous schemes
     * - Validates URL structure
     * @param {string} url - The URL to validate
     * @returns {object} - { valid: boolean, error: string|null, sanitized: string|null }
     */
    function validateEndpointUrl(url) {
        if (!url || typeof url !== 'string') {
            return { valid: false, error: 'URL is required', sanitized: null };
        }
        
        const trimmedUrl = url.trim();
        
        if (trimmedUrl.length === 0) {
            return { valid: false, error: 'URL cannot be empty', sanitized: null };
        }
        
        if (trimmedUrl.length > 2048) {
            return { valid: false, error: 'URL exceeds maximum length (2048 characters)', sanitized: null };
        }
        
        // Block dangerous URL schemes (OWASP: Prevent XSS via URL injection)
        const dangerousSchemes = /^(javascript|data|vbscript|file|ftp):/i;
        if (dangerousSchemes.test(trimmedUrl)) {
            return { valid: false, error: 'Invalid URL scheme. Only HTTPS URLs are allowed.', sanitized: null };
        }
        
        try {
            const parsedUrl = new URL(trimmedUrl);
            
            // Only allow http/https protocols
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return { valid: false, error: 'Only HTTP/HTTPS URLs are allowed', sanitized: null };
            }
            
            // For non-localhost, require HTTPS (OWASP: Enforce secure transport)
            const isLocalhost = parsedUrl.hostname === 'localhost' || 
                               parsedUrl.hostname === '127.0.0.1' ||
                               parsedUrl.hostname.endsWith('.local');
            
            if (!isLocalhost && parsedUrl.protocol !== 'https:') {
                return { valid: false, error: 'HTTPS is required for non-localhost URLs', sanitized: null };
            }
            
            // Validate hostname is not empty
            if (!parsedUrl.hostname) {
                return { valid: false, error: 'Invalid URL: hostname is required', sanitized: null };
            }
            
            // Block URLs with credentials in them (OWASP: Prevent credential exposure)
            if (parsedUrl.username || parsedUrl.password) {
                return { valid: false, error: 'URLs with embedded credentials are not allowed', sanitized: null };
            }
            
            // Return sanitized URL (reconstructed from parsed components)
            const sanitizedUrl = parsedUrl.origin + parsedUrl.pathname;
            return { valid: true, error: null, sanitized: sanitizedUrl };
            
        } catch (e) {
            return { valid: false, error: 'Invalid URL format', sanitized: null };
        }
    }
    
    /**
     * Validate model name with OWASP security considerations
     * - Alphanumeric with hyphens, underscores, dots, colons, and slashes
     * - Reasonable length limit
     * - Prevents injection attacks
     * @param {string} model - The model name to validate
     * @returns {object} - { valid: boolean, error: string|null, sanitized: string|null }
     */
    function validateModelName(model) {
        if (!model || typeof model !== 'string') {
            return { valid: false, error: 'Model name is required', sanitized: null };
        }
        
        const trimmedModel = model.trim();
        
        if (trimmedModel.length === 0) {
            return { valid: false, error: 'Model name cannot be empty', sanitized: null };
        }
        
        if (trimmedModel.length > 128) {
            return { valid: false, error: 'Model name exceeds maximum length (128 characters)', sanitized: null };
        }
        
        // Allow alphanumeric, hyphens, underscores, dots, colons, and forward slashes
        // This covers formats like: gpt-4o-mini, claude-3-opus, mistral/mixtral-8x7b, org:model-name
        const validModelPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_.:\/]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
        
        if (!validModelPattern.test(trimmedModel)) {
            return { 
                valid: false, 
                error: 'Model name can only contain letters, numbers, hyphens, underscores, dots, colons, and forward slashes', 
                sanitized: null 
            };
        }
        
        // Check for path traversal attempts
        if (trimmedModel.includes('..') || trimmedModel.includes('//')) {
            return { valid: false, error: 'Invalid model name format', sanitized: null };
        }
        
        return { valid: true, error: null, sanitized: trimmedModel };
    }

    // ==================== CUSTOM ENDPOINT/MODEL MANAGEMENT ====================
    
    /**
     * Load custom endpoint and model from localStorage
     */
    function loadCustomSettings() {
        try {
            const savedEndpoint = localStorage.getItem(CONFIG.customEndpointStorageKey);
            const savedModel = localStorage.getItem(CONFIG.customModelStorageKey);
            
            if (savedEndpoint) {
                const validation = validateEndpointUrl(savedEndpoint);
                if (validation.valid) {
                    customEndpoint = validation.sanitized;
                    console.log('LLMClient: Custom endpoint loaded');
                } else {
                    localStorage.removeItem(CONFIG.customEndpointStorageKey);
                    console.warn('LLMClient: Removed invalid saved endpoint');
                }
            }
            
            if (savedModel) {
                const validation = validateModelName(savedModel);
                if (validation.valid) {
                    customModel = validation.sanitized;
                    console.log('LLMClient: Custom model loaded');
                } else {
                    localStorage.removeItem(CONFIG.customModelStorageKey);
                    console.warn('LLMClient: Removed invalid saved model');
                }
            }
        } catch (e) {
            console.warn('Failed to load custom settings:', e);
        }
    }
    
    /**
     * Set custom endpoint URL
     * @param {string} url - The endpoint URL to use
     * @returns {object} - { success: boolean, error: string|null }
     */
    function setCustomEndpoint(url) {
        if (!url || url.trim() === '') {
            customEndpoint = null;
            try {
                localStorage.removeItem(CONFIG.customEndpointStorageKey);
            } catch (e) {
                console.warn('Failed to clear custom endpoint:', e);
            }
            return { success: true, error: null };
        }
        
        const validation = validateEndpointUrl(url);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        customEndpoint = validation.sanitized;
        try {
            localStorage.setItem(CONFIG.customEndpointStorageKey, customEndpoint);
            console.log('LLMClient: Custom endpoint saved');
        } catch (e) {
            console.warn('Failed to save custom endpoint:', e);
        }
        return { success: true, error: null };
    }
    
    /**
     * Set custom model name
     * @param {string} model - The model name to use
     * @returns {object} - { success: boolean, error: string|null }
     */
    function setCustomModel(model) {
        if (!model || model.trim() === '') {
            customModel = null;
            try {
                localStorage.removeItem(CONFIG.customModelStorageKey);
            } catch (e) {
                console.warn('Failed to clear custom model:', e);
            }
            return { success: true, error: null };
        }
        
        const validation = validateModelName(model);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        
        customModel = validation.sanitized;
        try {
            localStorage.setItem(CONFIG.customModelStorageKey, customModel);
            console.log('LLMClient: Custom model saved');
        } catch (e) {
            console.warn('Failed to save custom model:', e);
        }
        return { success: true, error: null };
    }
    
    /**
     * Clear all custom settings (endpoint, model, and API key)
     */
    function clearAllCustomSettings() {
        customEndpoint = null;
        customModel = null;
        customApiKey = null;
        try {
            localStorage.removeItem(CONFIG.customEndpointStorageKey);
            localStorage.removeItem(CONFIG.customModelStorageKey);
            localStorage.removeItem(CONFIG.apiKeyStorageKey);
            console.log('LLMClient: All custom settings cleared');
        } catch (e) {
            console.warn('Failed to clear custom settings:', e);
        }
    }
    
    /**
     * Get current custom endpoint (or null if using default)
     */
    function getCustomEndpoint() {
        return customEndpoint;
    }
    
    /**
     * Get current custom model (or null if using default)
     */
    function getCustomModel() {
        return customModel;
    }
    
    /**
     * Check if custom endpoint is set
     */
    function hasCustomEndpoint() {
        return !!customEndpoint;
    }
    
    /**
     * Check if custom model is set
     */
    function hasCustomModel() {
        return !!customModel;
    }
    
    /**
     * Get the effective endpoint (custom or default)
     */
    function getEffectiveEndpoint() {
        return customEndpoint || CONFIG.endpoint;
    }
    
    /**
     * Get the effective model (custom or default)
     */
    function getEffectiveModel() {
        return customModel || CONFIG.model;
    }

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
     * Handle storage changes from other tabs (for lock coordination)
     */
    function handleStorageChange(event) {
        if (event.key === LOCK_CONFIG.storageKey && isLockHolder) {
            // Another tab may have stolen the lock, verify we still own it
            try {
                const lockData = JSON.parse(event.newValue);
                if (lockData && lockData.tabId !== tabId) {
                    // We lost the lock
                    isLockHolder = false;
                    stopLockHeartbeat();
                    console.log('LLMClient: Lost lock to another tab');
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
    }

    /**
     * Check if the current lock is valid (not expired)
     */
    function isLockValid() {
        try {
            const lockStr = localStorage.getItem(LOCK_CONFIG.storageKey);
            if (!lockStr) return false;
            
            const lockData = JSON.parse(lockStr);
            const now = Date.now();
            
            // Lock is valid if it hasn't expired
            return lockData && lockData.expiresAt > now;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if this tab holds the lock
     */
    function isLockHeldByUs() {
        try {
            const lockStr = localStorage.getItem(LOCK_CONFIG.storageKey);
            if (!lockStr) return false;
            
            const lockData = JSON.parse(lockStr);
            return lockData && lockData.tabId === tabId && lockData.expiresAt > Date.now();
        } catch (e) {
            return false;
        }
    }

    /**
     * Try to acquire the cross-tab lock
     * Returns true if lock acquired, false otherwise
     */
    function tryAcquireLock() {
        try {
            const now = Date.now();
            const lockStr = localStorage.getItem(LOCK_CONFIG.storageKey);
            
            if (lockStr) {
                const lockData = JSON.parse(lockStr);
                // Check if existing lock is still valid
                if (lockData.expiresAt > now && lockData.tabId !== tabId) {
                    return false; // Another tab holds a valid lock
                }
            }
            
            // Acquire the lock
            const newLock = {
                tabId: tabId,
                acquiredAt: now,
                expiresAt: now + LOCK_CONFIG.lockTTL
            };
            localStorage.setItem(LOCK_CONFIG.storageKey, JSON.stringify(newLock));
            
            // Verify we got it (handle race condition)
            const verifyStr = localStorage.getItem(LOCK_CONFIG.storageKey);
            const verifyData = JSON.parse(verifyStr);
            
            if (verifyData.tabId === tabId) {
                isLockHolder = true;
                startLockHeartbeat();
                return true;
            }
            
            return false;
        } catch (e) {
            console.warn('LLMClient: Error acquiring lock:', e);
            return false;
        }
    }

    /**
     * Release the cross-tab lock
     */
    function releaseLock() {
        if (!isLockHolder) return;
        
        try {
            const lockStr = localStorage.getItem(LOCK_CONFIG.storageKey);
            if (lockStr) {
                const lockData = JSON.parse(lockStr);
                if (lockData.tabId === tabId) {
                    localStorage.removeItem(LOCK_CONFIG.storageKey);
                }
            }
        } catch (e) {
            // Ignore errors
        }
        
        isLockHolder = false;
        stopLockHeartbeat();
    }

    /**
     * Start heartbeat to keep lock alive
     */
    function startLockHeartbeat() {
        stopLockHeartbeat();
        lockHeartbeatTimer = setInterval(() => {
            if (isLockHolder) {
                try {
                    const now = Date.now();
                    const newLock = {
                        tabId: tabId,
                        acquiredAt: now,
                        expiresAt: now + LOCK_CONFIG.lockTTL
                    };
                    localStorage.setItem(LOCK_CONFIG.storageKey, JSON.stringify(newLock));
                } catch (e) {
                    // If heartbeat fails, we may lose the lock
                    console.warn('LLMClient: Heartbeat failed:', e);
                }
            }
        }, LOCK_CONFIG.heartbeatInterval);
    }

    /**
     * Stop the lock heartbeat
     */
    function stopLockHeartbeat() {
        if (lockHeartbeatTimer) {
            clearInterval(lockHeartbeatTimer);
            lockHeartbeatTimer = null;
        }
    }

    /**
     * Wait to acquire the lock with timeout
     */
    async function acquireLockWithTimeout() {
        const startTime = Date.now();
        
        while (Date.now() - startTime < LOCK_CONFIG.acquireTimeout) {
            if (tryAcquireLock()) {
                return true;
            }
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 100));
        }
        
        // Timeout - check if lock is stale and force acquire
        try {
            const lockStr = localStorage.getItem(LOCK_CONFIG.storageKey);
            if (lockStr) {
                const lockData = JSON.parse(lockStr);
                if (lockData.expiresAt <= Date.now()) {
                    // Lock is stale, force acquire
                    return tryAcquireLock();
                }
            }
        } catch (e) {
            // Ignore
        }
        
        console.warn('LLMClient: Timeout waiting for cross-tab lock');
        return false;
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
     * Uses custom endpoint/model if set, otherwise falls back to defaults
     */
    async function makeRequest(payload) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.requestTimeout);

        try {
            const headers = { 'Content-Type': 'application/json' };
            
            // Add Authorization header if custom API key is set
            if (customApiKey) {
                headers['Authorization'] = `Bearer ${customApiKey}`;
            }
            
            // Use custom endpoint if set, otherwise use default
            const endpoint = getEffectiveEndpoint();
            // Use custom model if set, otherwise use default (payload.model can override)
            const model = payload.model || getEffectiveModel();
            
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    model: model,
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

                // Non-retryable error - try to get error details from response body
                recordFailure();
                let errorMessage = `API error: ${response.status} ${response.statusText}`;
                try {
                    const errorBody = await response.text();
                    if (errorBody) {
                        // Try to parse as JSON for structured error
                        try {
                            const errorJson = JSON.parse(errorBody);
                            if (errorJson.error && errorJson.error.message) {
                                errorMessage = `API error: ${response.status} - ${errorJson.error.message}`;
                            } else if (errorJson.message) {
                                errorMessage = `API error: ${response.status} - ${errorJson.message}`;
                            }
                        } catch (parseErr) {
                            // Not JSON, use raw text (truncated)
                            errorMessage = `API error: ${response.status} - ${errorBody.substring(0, 200)}`;
                        }
                    }
                    console.error('LLMClient: API error details:', { status: response.status, body: errorBody.substring(0, 500) });
                } catch (bodyErr) {
                    // Couldn't read body, use original error
                }
                throw new Error(errorMessage);

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

            // Try to acquire cross-tab lock before making request
            if (!isLockHolder && !isLockHeldByUs()) {
                const gotLock = await acquireLockWithTimeout();
                if (!gotLock) {
                    // Another tab is making requests, wait and retry
                    console.log('LLMClient: Waiting for cross-tab lock...');
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }
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
                    // Release lock when queue is empty and no active requests
                    if (requestQueue.length === 0 && activeRequests === 0) {
                        releaseLock();
                    }
                });
        }

        isProcessing = false;
        // Release lock when done processing
        if (activeRequests === 0) {
            releaseLock();
        }
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
        // API key management
        setApiKey,
        clearApiKey,
        hasApiKey,
        // Custom endpoint/model management
        setCustomEndpoint,
        setCustomModel,
        getCustomEndpoint,
        getCustomModel,
        hasCustomEndpoint,
        hasCustomModel,
        getEffectiveEndpoint,
        getEffectiveModel,
        clearAllCustomSettings,
        // Validation functions (exposed for UI feedback)
        validateEndpointUrl,
        validateModelName,
        // Expose config for debugging
        getConfig: () => ({ ...CONFIG })
    };
})();

// Make LLMClient available globally
if (typeof window !== 'undefined') {
    window.LLMClient = LLMClient;
}
