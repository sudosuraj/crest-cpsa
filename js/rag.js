/**
 * RAG (Retrieval-Augmented Generation) Module for CPSA Quiz
 * Implements BM25 search algorithm for client-side retrieval
 * With token budgeting to stay under 8000 token limit
 */

const RAG = (function() {
    'use strict';

    // BM25 parameters
    const K1 = 1.5;  // Term frequency saturation parameter
    const B = 0.75;  // Length normalization parameter

    // Token budget configuration (8000 total limit)
    const TOKEN_CONFIG = {
        totalLimit: 8000,           // Total token limit for API
        systemPromptReserve: 800,   // Reserve for system prompt
        userQueryReserve: 400,      // Reserve for user query
        responseReserve: 500,       // Reserve for model response
        contextBudget: 2500,        // Max tokens for RAG context (~10000 chars)
        charsPerToken: 4            // Approximate chars per token
    };

    // State
    let chunks = [];
    let index = null;
    let isInitialized = false;
    let initPromise = null;

    // Stopwords to filter out common words
    const STOPWORDS = new Set([
        'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
        'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
        'to', 'was', 'were', 'will', 'with', 'the', 'this', 'but', 'they',
        'have', 'had', 'what', 'when', 'where', 'who', 'which', 'why', 'how',
        'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
        'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
        'very', 'can', 'just', 'should', 'now', 'also', 'into', 'over', 'after',
        'before', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
        'there', 'any', 'about', 'up', 'out', 'if', 'or', 'because', 'until',
        'while', 'during', 'through', 'above', 'below', 'been', 'being', 'would',
        'could', 'might', 'must', 'shall', 'may', 'need', 'used', 'using'
    ]);

    /**
     * Tokenize and normalize text
     */
    function tokenize(text) {
        if (!text) return [];
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')  // Remove punctuation
            .split(/\s+/)
            .filter(token => token.length > 1 && !STOPWORDS.has(token));
    }

    /**
     * Build inverted index for BM25 search
     */
    function buildIndex(documents) {
        const docFreq = {};  // Document frequency for each term
        const docLengths = [];  // Length of each document
        const termFreqs = [];  // Term frequencies per document
        let totalLength = 0;

        // First pass: calculate term frequencies and document lengths
        documents.forEach((doc, docId) => {
            const tokens = tokenize(doc.text);
            const tf = {};
            
            tokens.forEach(token => {
                tf[token] = (tf[token] || 0) + 1;
            });

            termFreqs.push(tf);
            docLengths.push(tokens.length);
            totalLength += tokens.length;

            // Update document frequency
            Object.keys(tf).forEach(term => {
                docFreq[term] = (docFreq[term] || 0) + 1;
            });
        });

        const avgDocLength = totalLength / documents.length;

        return {
            docFreq,
            docLengths,
            termFreqs,
            avgDocLength,
            numDocs: documents.length
        };
    }

    /**
     * Calculate BM25 score for a document given a query
     */
    function bm25Score(queryTokens, docId, idx) {
        let score = 0;
        const docLength = idx.docLengths[docId];
        const tf = idx.termFreqs[docId];

        queryTokens.forEach(term => {
            if (!tf[term]) return;

            const termFreq = tf[term];
            const docFreq = idx.docFreq[term] || 0;
            
            // IDF calculation with smoothing
            const idf = Math.log((idx.numDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
            
            // BM25 term score
            const tfNorm = (termFreq * (K1 + 1)) / 
                (termFreq + K1 * (1 - B + B * (docLength / idx.avgDocLength)));
            
            score += idf * tfNorm;
        });

        return score;
    }

    /**
     * Search for relevant chunks
     */
    function search(query, topK = 5) {
        if (!isInitialized || !index) {
            console.warn('RAG not initialized');
            return [];
        }

        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];

        // Calculate scores for all documents
        const scores = chunks.map((chunk, docId) => ({
            chunk,
            score: bm25Score(queryTokens, docId, index)
        }));

        // Sort by score and return top K
        return scores
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(item => item.chunk);
    }

    /**
     * Search with category/appendix filter
     */
    function searchWithFilter(query, options = {}) {
        const { topK = 5, appendix = null, sectionId = null } = options;
        
        if (!isInitialized || !index) {
            console.warn('RAG not initialized');
            return [];
        }

        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return [];

        // Calculate scores with optional filtering
        const scores = chunks
            .map((chunk, docId) => {
                // Apply filters
                if (appendix && chunk.appendix !== appendix) return null;
                if (sectionId && chunk.section_id !== sectionId) return null;

                return {
                    chunk,
                    score: bm25Score(queryTokens, docId, index)
                };
            })
            .filter(item => item !== null && item.score > 0);

        // Sort by score and return top K
        return scores
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(item => item.chunk);
    }

    /**
     * Estimate token count from text (approximate: ~4 chars per token)
     */
    function estimateTokens(text) {
        if (!text) return 0;
        return Math.ceil(text.length / TOKEN_CONFIG.charsPerToken);
    }

    /**
     * Format retrieved chunks as context for LLM with token budgeting
     * Ensures we stay within the context budget
     */
    function formatContext(retrievedChunks, options = {}) {
        if (!retrievedChunks || retrievedChunks.length === 0) {
            return '';
        }

        const { maxTokens = TOKEN_CONFIG.contextBudget } = options;
        const maxChars = maxTokens * TOKEN_CONFIG.charsPerToken;
        
        let result = '';
        let currentChars = 0;
        let includedChunks = [];

        for (let i = 0; i < retrievedChunks.length; i++) {
            const chunk = retrievedChunks[i];
            const source = `[Source ${i + 1}: ${chunk.section_id}]`;
            const chunkText = `${source}\n${chunk.text}`;
            const separator = result ? '\n\n---\n\n' : '';
            const totalAddition = separator.length + chunkText.length;

            // Check if adding this chunk would exceed budget
            if (currentChars + totalAddition > maxChars) {
                // Try to add a truncated version if we have room
                const remainingChars = maxChars - currentChars - separator.length - source.length - 10;
                if (remainingChars > 100) {
                    const truncatedText = chunk.text.substring(0, remainingChars) + '...';
                    result += separator + `${source}\n${truncatedText}`;
                    includedChunks.push({ ...chunk, truncated: true });
                }
                break;
            }

            result += separator + chunkText;
            currentChars += totalAddition;
            includedChunks.push(chunk);
        }

        return result;
    }

    /**
     * Format sources for citation display
     */
    function formatSources(retrievedChunks) {
        if (!retrievedChunks || retrievedChunks.length === 0) {
            return [];
        }

        return retrievedChunks.map((chunk, i) => ({
            index: i + 1,
            appendix: chunk.appendix,
            appendixTitle: chunk.appendix_title,
            sectionId: chunk.section_id,
            sectionTitle: chunk.section_title,
            preview: chunk.text.substring(0, 150) + (chunk.text.length > 150 ? '...' : '')
        }));
    }

    /**
     * Initialize the RAG system by loading chunks
     */
    async function initialize() {
        if (isInitialized) return true;
        if (initPromise) return initPromise;

        initPromise = (async () => {
            try {
                // Try to load from cache first
                const cached = await loadFromCache();
                if (cached) {
                    chunks = cached.chunks;
                    index = cached.index;
                    isInitialized = true;
                    console.log('RAG initialized from cache');
                    return true;
                }

                // Load chunks from server
                const basePath = getBasePath();
                const response = await fetch(`${basePath}rag/chunks.json`);
                if (!response.ok) {
                    throw new Error(`Failed to load chunks: ${response.status}`);
                }

                chunks = await response.json();
                console.log(`Loaded ${chunks.length} chunks`);

                // Build index
                index = buildIndex(chunks);
                console.log('Built BM25 index');

                // Cache for future use
                await saveToCache({ chunks, index });

                isInitialized = true;
                return true;
            } catch (error) {
                console.error('Failed to initialize RAG:', error);
                isInitialized = false;
                return false;
            }
        })();

        return initPromise;
    }

    /**
     * Get base path for loading resources
     */
    function getBasePath() {
        // Handle both local development and GitHub Pages
        const path = window.location.pathname;
        if (path.includes('/CREST/')) {
            return '/CREST/';
        }
        return './';
    }

    /**
     * Load cached data from IndexedDB
     */
    async function loadFromCache() {
        try {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open('cpsa_rag_cache', 1);
                
                request.onerror = () => resolve(null);
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('cache')) {
                        db.createObjectStore('cache', { keyPath: 'id' });
                    }
                };

                request.onsuccess = (event) => {
                    const db = event.target.result;
                    const transaction = db.transaction(['cache'], 'readonly');
                    const store = transaction.objectStore('cache');
                    const getRequest = store.get('rag_data');

                    getRequest.onsuccess = () => {
                        const result = getRequest.result;
                        if (result && result.version === 1) {
                            resolve(result.data);
                        } else {
                            resolve(null);
                        }
                    };

                    getRequest.onerror = () => resolve(null);
                };
            });
        } catch (e) {
            return null;
        }
    }

    /**
     * Save data to IndexedDB cache
     */
    async function saveToCache(data) {
        try {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open('cpsa_rag_cache', 1);
                
                request.onerror = () => resolve(false);
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('cache')) {
                        db.createObjectStore('cache', { keyPath: 'id' });
                    }
                };

                request.onsuccess = (event) => {
                    const db = event.target.result;
                    const transaction = db.transaction(['cache'], 'readwrite');
                    const store = transaction.objectStore('cache');
                    
                    store.put({
                        id: 'rag_data',
                        version: 1,
                        data: data,
                        timestamp: Date.now()
                    });

                    transaction.oncomplete = () => resolve(true);
                    transaction.onerror = () => resolve(false);
                };
            });
        } catch (e) {
            return false;
        }
    }

    /**
     * Clear the cache
     */
    async function clearCache() {
        try {
            return new Promise((resolve) => {
                const request = indexedDB.deleteDatabase('cpsa_rag_cache');
                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            });
        } catch (e) {
            return false;
        }
    }

    /**
     * Get all available appendices
     */
    function getAppendices() {
        if (!isInitialized) return [];
        
        const appendices = new Map();
        chunks.forEach(chunk => {
            if (!appendices.has(chunk.appendix)) {
                appendices.set(chunk.appendix, chunk.appendix_title);
            }
        });

        return Array.from(appendices.entries()).map(([letter, title]) => ({
            letter,
            title
        })).sort((a, b) => a.letter.localeCompare(b.letter));
    }

    /**
     * Get sections for a specific appendix
     */
    function getSections(appendixLetter) {
        if (!isInitialized) return [];

        const sections = new Map();
        chunks
            .filter(chunk => chunk.appendix === appendixLetter)
            .forEach(chunk => {
                if (!sections.has(chunk.section_id)) {
                    sections.set(chunk.section_id, chunk.section_title);
                }
            });

        return Array.from(sections.entries()).map(([id, title]) => ({
            id,
            title
        }));
    }

    /**
     * Get chunk count
     */
    function getChunkCount() {
        return chunks.length;
    }

    /**
     * Check if RAG is ready
     */
    function isReady() {
        return isInitialized;
    }

    /**
     * Get token configuration for external use
     */
    function getTokenConfig() {
        return { ...TOKEN_CONFIG };
    }

    /**
     * Get chunks for a specific appendix
     */
    function getChunksForAppendix(appendixLetter) {
        if (!isInitialized) return [];
        return chunks.filter(chunk => chunk.appendix === appendixLetter);
    }

    /**
     * Generate MCQ questions from a chunk using LLM API
     * With token budgeting to stay under 8000 token limit
     */
    async function generateQuestionsFromChunk(chunk, questionsPerChunk = 2) {
        const systemPrompt = `You are a CPSA exam question generator. Generate exactly ${questionsPerChunk} multiple-choice questions based on the provided study material.

Output ONLY valid JSON array with this exact structure:
[{"question":"Question text?","options":["A) Option 1","B) Option 2","C) Option 3","D) Option 4"],"correct":0,"explanation":"Brief explanation"}]

Rules:
- Each question must have exactly 4 options (A, B, C, D)
- "correct" is the 0-based index of the correct answer (0-3)
- Questions must be directly answerable from the provided material
- Keep questions clear and concise`;

        // Truncate chunk text to fit within token budget
        const maxChunkChars = 2500 * TOKEN_CONFIG.charsPerToken; // ~2500 tokens for context
        const truncatedText = chunk.text.substring(0, maxChunkChars);

        const userPrompt = `Generate ${questionsPerChunk} MCQ questions from this CPSA study material:

Section: ${chunk.section_id} - ${chunk.section_title}
Appendix: ${chunk.appendix} - ${chunk.appendix_title}

Content:
${truncatedText}

Output ONLY the JSON array.`;

        try {
            const response = await fetch('https://api.llm7.io/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt }
                    ],
                    max_tokens: 600,
                    temperature: 0.7
                })
            });

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const data = await response.json();
            let content = data.choices?.[0]?.message?.content?.trim() || '';

            // Parse JSON from response
            if (content.startsWith('```json')) content = content.slice(7);
            if (content.startsWith('```')) content = content.slice(3);
            if (content.endsWith('```')) content = content.slice(0, -3);
            content = content.trim();

            const questions = JSON.parse(content);

            // Validate and enrich questions with source info
            return questions
                .filter(q => validateQuestion(q))
                .map(q => ({
                    ...q,
                    source_chunk_id: chunk.id,
                    appendix: chunk.appendix,
                    appendix_title: chunk.appendix_title,
                    section_id: chunk.section_id,
                    section_title: chunk.section_title
                }));
        } catch (error) {
            console.error('Question generation error:', error);
            return [];
        }
    }

    /**
     * Validate a question has required fields
     */
    function validateQuestion(q) {
        if (!q.question || !q.options || !Array.isArray(q.options)) return false;
        if (q.options.length !== 4) return false;
        if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) return false;
        return true;
    }

    // Legacy generateQuestionsForAppendix function removed - use generateQuestionsBatch for pagination

    /**
     * Generate a simple hash for question deduplication
     */
    function hashQuestion(questionText) {
        const normalized = questionText.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        // Simple FNV-1a hash
        let hash = 2166136261;
        for (let i = 0; i < normalized.length; i++) {
            hash ^= normalized.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        return hash.toString(16);
    }

    // Concurrency configuration for batch processing
    const BATCH_CONCURRENCY = 5; // Process up to 5 chunks concurrently
    const MIN_DELAY_BETWEEN_BATCHES = 500; // Minimum delay between concurrent batches

    /**
     * Process a single chunk and return questions with metadata
     * @param {Object} chunk - The chunk to process
     * @param {number} questionsPerChunk - Number of questions to generate
     * @returns {Promise<Array>} - Generated questions
     */
    async function processChunkForQuestions(chunk, questionsPerChunk) {
        try {
            return await generateQuestionsFromChunk(chunk, questionsPerChunk);
        } catch (error) {
            console.error(`Error processing chunk ${chunk.section_id}:`, error);
            return [];
        }
    }

    /**
     * Generate a batch of questions for pagination using concurrent processing
     * Starts from a specific chunk index and generates until target count is reached
     * Uses concurrent queue pattern for optimal performance
     * @param {string} appendixLetter - The appendix letter
     * @param {number} startChunkIdx - Starting chunk index
     * @param {number} targetCount - Target number of questions to generate (default 20)
     * @param {Set} existingHashes - Set of existing question hashes to avoid duplicates
     * @param {function} onProgress - Progress callback
     * @returns {Promise<{questions: Array, nextChunkIdx: number, newHashes: Array, exhausted: boolean}>}
     */
    async function generateQuestionsBatch(appendixLetter, startChunkIdx = 0, targetCount = 20, existingHashes = new Set(), onProgress = null) {
        if (!isInitialized) {
            await initialize();
        }

        const appendixChunks = getChunksForAppendix(appendixLetter);
        if (appendixChunks.length === 0) {
            return { questions: [], nextChunkIdx: 0, newHashes: [], exhausted: true };
        }

        const questions = [];
        const newHashes = [];
        let currentChunkIdx = startChunkIdx;
        const questionsPerChunk = 5; // Generate 5 questions per chunk for better yield

        // Process chunks in concurrent batches
        while (questions.length < targetCount && currentChunkIdx < appendixChunks.length) {
            // Determine how many chunks to process in this batch
            const remainingChunks = appendixChunks.length - currentChunkIdx;
            const batchSize = Math.min(BATCH_CONCURRENCY, remainingChunks);
            const chunksToProcess = appendixChunks.slice(currentChunkIdx, currentChunkIdx + batchSize);
            
            if (onProgress) {
                onProgress({
                    currentChunk: currentChunkIdx + 1,
                    totalChunks: appendixChunks.length,
                    section: chunksToProcess[0]?.section_id,
                    questionsGenerated: questions.length,
                    targetCount: targetCount,
                    processingBatch: batchSize
                });
            }

            // Process all chunks in this batch concurrently
            const batchPromises = chunksToProcess.map(chunk => 
                processChunkForQuestions(chunk, questionsPerChunk)
            );
            
            const batchResults = await Promise.all(batchPromises);
            
            // Collect questions from all chunks in this batch
            for (const generatedQuestions of batchResults) {
                for (const q of generatedQuestions) {
                    const hash = hashQuestion(q.question);
                    if (!existingHashes.has(hash)) {
                        questions.push(q);
                        newHashes.push(hash);
                        existingHashes.add(hash);
                        
                        if (questions.length >= targetCount) {
                            break;
                        }
                    } else {
                        console.log('Skipping duplicate question:', q.question.substring(0, 50));
                    }
                }
                
                if (questions.length >= targetCount) {
                    break;
                }
            }

            currentChunkIdx += batchSize;

            // Small delay between concurrent batches to avoid rate limiting
            if (questions.length < targetCount && currentChunkIdx < appendixChunks.length) {
                await new Promise(resolve => setTimeout(resolve, MIN_DELAY_BETWEEN_BATCHES));
            }
        }

        return {
            questions,
            nextChunkIdx: currentChunkIdx,
            newHashes,
            exhausted: currentChunkIdx >= appendixChunks.length
        };
    }

    /**
     * Get total chunk count for an appendix
     */
    function getAppendixChunkCount(appendixLetter) {
        if (!isInitialized) return 0;
        return getChunksForAppendix(appendixLetter).length;
    }

    /**
     * Load questions from IndexedDB cache
     */
    async function loadQuestionsFromCache(key) {
        try {
            return new Promise((resolve) => {
                const request = indexedDB.open('cpsa_questions_cache', 1);
                
                request.onerror = () => resolve(null);
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('questions')) {
                        db.createObjectStore('questions', { keyPath: 'id' });
                    }
                };

                request.onsuccess = (event) => {
                    const db = event.target.result;
                    const transaction = db.transaction(['questions'], 'readonly');
                    const store = transaction.objectStore('questions');
                    const getRequest = store.get(key);

                    getRequest.onsuccess = () => {
                        const result = getRequest.result;
                        if (result && result.questions) {
                            resolve(result.questions);
                        } else {
                            resolve(null);
                        }
                    };

                    getRequest.onerror = () => resolve(null);
                };
            });
        } catch (e) {
            return null;
        }
    }

    /**
     * Save questions to IndexedDB cache
     */
    async function saveQuestionsToCache(key, questions) {
        try {
            return new Promise((resolve) => {
                const request = indexedDB.open('cpsa_questions_cache', 1);
                
                request.onerror = () => resolve(false);
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('questions')) {
                        db.createObjectStore('questions', { keyPath: 'id' });
                    }
                };

                request.onsuccess = (event) => {
                    const db = event.target.result;
                    const transaction = db.transaction(['questions'], 'readwrite');
                    const store = transaction.objectStore('questions');
                    
                    store.put({
                        id: key,
                        questions: questions,
                        timestamp: Date.now()
                    });

                    transaction.oncomplete = () => resolve(true);
                    transaction.onerror = () => resolve(false);
                };
            });
        } catch (e) {
            return false;
        }
    }

    /**
     * Clear questions cache
     */
    async function clearQuestionsCache() {
        try {
            return new Promise((resolve) => {
                const request = indexedDB.deleteDatabase('cpsa_questions_cache');
                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            });
        } catch (e) {
            return false;
        }
    }

    // Public API
    return {
        initialize,
        search,
        searchWithFilter,
        formatContext,
        formatSources,
        getAppendices,
        getSections,
        getChunkCount,
        isReady,
        clearCache,
        estimateTokens,
        getTokenConfig,
        // Question generation (pagination-based)
        getChunksForAppendix,
        generateQuestionsFromChunk,
        generateQuestionsBatch,
        getAppendixChunkCount,
        hashQuestion,
        clearQuestionsCache
    };
})();

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        RAG.initialize().then(success => {
            if (success) {
                console.log('RAG system ready');
            }
        });
    });
}
