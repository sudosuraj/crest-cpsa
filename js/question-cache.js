/**
 * Question Cache - Persistent storage for generated questions
 * 
 * This module provides IndexedDB-based caching for LLM-generated questions.
 * Questions are cached at the chunk level with versioning to handle prompt changes.
 * 
 * Features:
 * - Chunk-level caching with version control
 * - Automatic cache invalidation on prompt/model changes
 * - Cache statistics and management
 * - Bulk operations for efficiency
 */

const QuestionCache = (function() {
    const DB_NAME = 'cpsa-question-cache';
    const DB_VERSION = 1;
    const STORE_NAME = 'questions';
    
    // Cache version - increment when prompt format or validation rules change
    // v2: Added meta-question filtering to prevent syllabus structure questions
    const CACHE_VERSION = 2;
    
    // Default model used for generation
    const DEFAULT_MODEL = 'gpt-4o-mini';
    
    let db = null;
    let initPromise = null;

    /**
     * Generate a cache key for a chunk
     * Key includes all factors that affect question generation
     */
    function generateCacheKey(chunkId, options = {}) {
        const model = options.model || DEFAULT_MODEL;
        const questionsPerChunk = options.questionsPerChunk || 5;
        const promptVersion = options.promptVersion || CACHE_VERSION;
        
        return `${chunkId}:${model}:${promptVersion}:${questionsPerChunk}`;
    }

    /**
     * Initialize the database
     */
    async function initialize() {
        if (db) return db;
        if (initPromise) return initPromise;

        initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                console.error('QuestionCache: Failed to open database:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                db = request.result;
                console.log('QuestionCache: Database initialized');
                resolve(db);
            };

            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                
                // Create questions store if it doesn't exist
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    const store = database.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
                    
                    // Create indexes for efficient queries
                    store.createIndex('chunkId', 'chunkId', { unique: false });
                    store.createIndex('appendix', 'appendix', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                    
                    console.log('QuestionCache: Created questions store');
                }
            };
        });

        return initPromise;
    }

    /**
     * Get cached questions for a chunk
     * @param {string} chunkId - The chunk ID
     * @param {Object} options - Options (model, questionsPerChunk, promptVersion)
     * @returns {Promise<Array|null>} - Cached questions or null if not found
     */
    async function get(chunkId, options = {}) {
        await initialize();
        
        const cacheKey = generateCacheKey(chunkId, options);
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(cacheKey);

            request.onerror = () => {
                console.error('QuestionCache: Failed to get:', request.error);
                resolve(null);
            };

            request.onsuccess = () => {
                const result = request.result;
                if (result && result.questions && Array.isArray(result.questions)) {
                    resolve(result.questions);
                } else {
                    resolve(null);
                }
            };
        });
    }

    /**
     * Store questions for a chunk
     * @param {string} chunkId - The chunk ID
     * @param {Array} questions - The generated questions
     * @param {Object} metadata - Additional metadata (appendix, sectionId, etc.)
     * @param {Object} options - Options (model, questionsPerChunk, promptVersion)
     * @returns {Promise<boolean>} - Success status
     */
    async function set(chunkId, questions, metadata = {}, options = {}) {
        await initialize();
        
        const cacheKey = generateCacheKey(chunkId, options);
        
        const entry = {
            cacheKey,
            chunkId,
            questions,
            appendix: metadata.appendix || '',
            sectionId: metadata.sectionId || '',
            model: options.model || DEFAULT_MODEL,
            promptVersion: options.promptVersion || CACHE_VERSION,
            questionsPerChunk: options.questionsPerChunk || 5,
            createdAt: Date.now()
        };

        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(entry);

            request.onerror = () => {
                console.error('QuestionCache: Failed to set:', request.error);
                resolve(false);
            };

            request.onsuccess = () => {
                resolve(true);
            };
        });
    }

    /**
     * Get all cached questions for an appendix
     * @param {string} appendixLetter - The appendix letter
     * @returns {Promise<Array>} - Array of cache entries
     */
    async function getByAppendix(appendixLetter) {
        await initialize();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('appendix');
            const request = index.getAll(appendixLetter);

            request.onerror = () => {
                console.error('QuestionCache: Failed to get by appendix:', request.error);
                resolve([]);
            };

            request.onsuccess = () => {
                // Filter to only return entries with current cache version
                const results = (request.result || []).filter(
                    entry => entry.promptVersion === CACHE_VERSION
                );
                resolve(results);
            };
        });
    }

    /**
     * Get all cached questions (flattened)
     * @param {string} appendixLetter - The appendix letter
     * @returns {Promise<Array>} - Array of questions with metadata
     */
    async function getAllQuestionsForAppendix(appendixLetter) {
        const entries = await getByAppendix(appendixLetter);
        const allQuestions = [];
        
        for (const entry of entries) {
            for (const question of entry.questions) {
                allQuestions.push({
                    ...question,
                    source_chunk_id: entry.chunkId,
                    cached: true
                });
            }
        }
        
        return allQuestions;
    }

    /**
     * Check if a chunk is cached
     * @param {string} chunkId - The chunk ID
     * @param {Object} options - Options
     * @returns {Promise<boolean>}
     */
    async function has(chunkId, options = {}) {
        const cached = await get(chunkId, options);
        return cached !== null;
    }

    /**
     * Delete cached questions for a chunk
     * @param {string} chunkId - The chunk ID
     * @param {Object} options - Options
     * @returns {Promise<boolean>}
     */
    async function remove(chunkId, options = {}) {
        await initialize();
        
        const cacheKey = generateCacheKey(chunkId, options);
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(cacheKey);

            request.onerror = () => {
                console.error('QuestionCache: Failed to remove:', request.error);
                resolve(false);
            };

            request.onsuccess = () => {
                resolve(true);
            };
        });
    }

    /**
     * Clear all cached questions for an appendix
     * @param {string} appendixLetter - The appendix letter
     * @returns {Promise<number>} - Number of entries deleted
     */
    async function clearAppendix(appendixLetter) {
        await initialize();
        
        const entries = await getByAppendix(appendixLetter);
        let deleted = 0;
        
        for (const entry of entries) {
            const success = await new Promise((resolve) => {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.delete(entry.cacheKey);
                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            });
            if (success) deleted++;
        }
        
        return deleted;
    }

    /**
     * Clear all cached questions
     * @returns {Promise<boolean>}
     */
    async function clearAll() {
        await initialize();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onerror = () => {
                console.error('QuestionCache: Failed to clear:', request.error);
                resolve(false);
            };

            request.onsuccess = () => {
                console.log('QuestionCache: Cleared all entries');
                resolve(true);
            };
        });
    }

    /**
     * Get cache statistics
     * @returns {Promise<Object>}
     */
    async function getStats() {
        await initialize();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const countRequest = store.count();
            const allRequest = store.getAll();

            let totalEntries = 0;
            let totalQuestions = 0;
            const appendixCounts = {};
            let oldestEntry = null;
            let newestEntry = null;

            allRequest.onsuccess = () => {
                const entries = allRequest.result || [];
                totalEntries = entries.length;
                
                for (const entry of entries) {
                    totalQuestions += entry.questions ? entry.questions.length : 0;
                    
                    const appendix = entry.appendix || 'unknown';
                    appendixCounts[appendix] = (appendixCounts[appendix] || 0) + 1;
                    
                    if (!oldestEntry || entry.createdAt < oldestEntry.createdAt) {
                        oldestEntry = entry;
                    }
                    if (!newestEntry || entry.createdAt > newestEntry.createdAt) {
                        newestEntry = entry;
                    }
                }

                resolve({
                    totalEntries,
                    totalQuestions,
                    appendixCounts,
                    cacheVersion: CACHE_VERSION,
                    oldestEntryDate: oldestEntry ? new Date(oldestEntry.createdAt).toISOString() : null,
                    newestEntryDate: newestEntry ? new Date(newestEntry.createdAt).toISOString() : null
                });
            };

            allRequest.onerror = () => {
                resolve({
                    totalEntries: 0,
                    totalQuestions: 0,
                    appendixCounts: {},
                    cacheVersion: CACHE_VERSION,
                    error: 'Failed to get stats'
                });
            };
        });
    }

    /**
     * Get cached chunk IDs for an appendix
     * @param {string} appendixLetter - The appendix letter
     * @returns {Promise<Set<string>>} - Set of cached chunk IDs
     */
    async function getCachedChunkIds(appendixLetter) {
        const entries = await getByAppendix(appendixLetter);
        return new Set(entries.map(e => e.chunkId));
    }

    return {
        initialize,
        get,
        set,
        has,
        remove,
        getByAppendix,
        getAllQuestionsForAppendix,
        clearAppendix,
        clearAll,
        getStats,
        getCachedChunkIds,
        generateCacheKey,
        CACHE_VERSION
    };
})();

// Make QuestionCache available globally
if (typeof window !== 'undefined') {
    window.QuestionCache = QuestionCache;
}
