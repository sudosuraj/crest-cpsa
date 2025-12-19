/**
 * CPSA Quiz Data - Dynamic RAG-based Question Generation with Pagination
 * 
 * This file serves as a bridge between the RAG system and the quiz UI.
 * Questions are generated dynamically from the PDF study notes using the RAG module.
 * 
 * Features:
 * - Pagination: 20 questions per page
 * - Progressive topic advancement: chunks are processed in order
 * - Duplicate detection: questions are hashed to avoid repeats
 * - Minimum 120 questions target (6 pages)
 */

// Empty quizData - will be populated dynamically from RAG
const quizData = {};

// Question ID counter for unique IDs
let questionIdCounter = 0;

// Pagination state per appendix
const appendixState = {};

// Page size constant
const PAGE_SIZE = 20;
// Reduced from 120 to 20 - generate only one page at a time
// Additional questions are generated only on explicit user action (clicking "Load More")
const MIN_QUESTIONS_TARGET = 20;

/**
 * Simple hash function for question deduplication
 */
function hashQuestion(text) {
    if (!text) return '0';
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

/**
 * Initialize or get state for an appendix
 */
function getAppendixState(appendixLetter) {
    if (!appendixState[appendixLetter]) {
        appendixState[appendixLetter] = {
            appendix: appendixLetter,
            nextChunkIdx: 0,
            allQuestions: [],
            questionHashes: new Set(),
            currentPage: 0,
            exhausted: false,
            totalChunks: 0
        };
    }
    return appendixState[appendixLetter];
}

/**
 * Convert RAG question format to quiz format
 */
function convertToQuizFormat(ragQuestion) {
    const correctAnswer = ragQuestion.options[ragQuestion.correct];
    const incorrectAnswers = ragQuestion.options.filter((_, i) => i !== ragQuestion.correct);
    
    return {
        question: ragQuestion.question,
        answer: correctAnswer.replace(/^[A-D]\)\s*/, ''),
        incorrect: incorrectAnswers.map(opt => opt.replace(/^[A-D]\)\s*/, '')),
        explanation: ragQuestion.explanation,
        appendix: ragQuestion.appendix,
        appendix_title: ragQuestion.appendix_title,
        section_id: ragQuestion.section_id,
        section_title: ragQuestion.section_title,
        source_chunk_id: ragQuestion.source_chunk_id
    };
}

/**
 * Load first page of questions for an appendix (20 questions)
 * @param {string} appendixLetter - The appendix letter (A-J)
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Object>} - Questions for page 1
 */
async function loadAppendixFirstPage(appendixLetter, onProgress = null) {
    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        return { questions: {}, hasMore: false, currentPage: 0, totalQuestions: 0 };
    }

    await RAG.initialize();

    // Reset state for this appendix
    const state = getAppendixState(appendixLetter);
    state.nextChunkIdx = 0;
    state.allQuestions = [];
    state.questionHashes = new Set();
    state.currentPage = 0;
    state.exhausted = false;
    state.totalChunks = RAG.getAppendixChunkCount(appendixLetter);

    // Clear any existing questions for this appendix from quizData
    Object.keys(quizData).forEach(key => {
        if (quizData[key].appendix === appendixLetter) {
            delete quizData[key];
        }
    });

    // Generate first batch
    const result = await RAG.generateQuestionsBatch(
        appendixLetter,
        state.nextChunkIdx,
        PAGE_SIZE,
        state.questionHashes,
        onProgress
    );

    // Update state
    state.nextChunkIdx = result.nextChunkIdx;
    state.exhausted = result.exhausted;
    result.newHashes.forEach(h => state.questionHashes.add(h));

    // Convert and store questions
    const pageQuestions = {};
    result.questions.forEach(q => {
        const id = String(questionIdCounter++);
        const converted = convertToQuizFormat(q);
        quizData[id] = converted;
        state.allQuestions.push({ id, ...converted });
        pageQuestions[id] = converted;
    });

    state.currentPage = 1;
    console.log(`Loaded page 1 with ${result.questions.length} questions for Appendix ${appendixLetter}`);

    return {
        questions: pageQuestions,
        hasMore: !state.exhausted && state.allQuestions.length < MIN_QUESTIONS_TARGET,
        currentPage: state.currentPage,
        totalQuestions: state.allQuestions.length,
        exhausted: state.exhausted,
        chunksProcessed: state.nextChunkIdx,
        totalChunks: state.totalChunks
    };
}

/**
 * Load next page of questions for an appendix
 * @param {string} appendixLetter - The appendix letter (A-J)
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Object>} - Questions for next page
 */
async function loadAppendixNextPage(appendixLetter, onProgress = null) {
    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        return { questions: {}, hasMore: false, currentPage: 0, totalQuestions: 0 };
    }

    const state = getAppendixState(appendixLetter);
    
    if (state.exhausted) {
        console.log(`Appendix ${appendixLetter} is exhausted, no more questions available`);
        return {
            questions: {},
            hasMore: false,
            currentPage: state.currentPage,
            totalQuestions: state.allQuestions.length,
            exhausted: true,
            chunksProcessed: state.nextChunkIdx,
            totalChunks: state.totalChunks
        };
    }

    await RAG.initialize();

    // Generate next batch
    const result = await RAG.generateQuestionsBatch(
        appendixLetter,
        state.nextChunkIdx,
        PAGE_SIZE,
        state.questionHashes,
        onProgress
    );

    // Update state
    state.nextChunkIdx = result.nextChunkIdx;
    state.exhausted = result.exhausted;
    result.newHashes.forEach(h => state.questionHashes.add(h));

    // Convert and store questions
    const pageQuestions = {};
    result.questions.forEach(q => {
        const id = String(questionIdCounter++);
        const converted = convertToQuizFormat(q);
        quizData[id] = converted;
        state.allQuestions.push({ id, ...converted });
        pageQuestions[id] = converted;
    });

    state.currentPage++;
    console.log(`Loaded page ${state.currentPage} with ${result.questions.length} questions for Appendix ${appendixLetter}`);

    return {
        questions: pageQuestions,
        hasMore: !state.exhausted && state.allQuestions.length < MIN_QUESTIONS_TARGET,
        currentPage: state.currentPage,
        totalQuestions: state.allQuestions.length,
        exhausted: state.exhausted,
        chunksProcessed: state.nextChunkIdx,
        totalChunks: state.totalChunks
    };
}

/**
 * Get current page questions for an appendix
 * @param {string} appendixLetter - The appendix letter
 * @param {number} pageNum - Page number (1-indexed)
 * @returns {Object} - Questions for the specified page
 */
function getPageQuestions(appendixLetter, pageNum) {
    const state = getAppendixState(appendixLetter);
    const startIdx = (pageNum - 1) * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE;
    
    const pageQuestions = {};
    state.allQuestions.slice(startIdx, endIdx).forEach(q => {
        pageQuestions[q.id] = quizData[q.id];
    });
    
    return pageQuestions;
}

/**
 * Get all loaded questions for an appendix
 * @param {string} appendixLetter - The appendix letter
 * @returns {Object} - All questions keyed by ID
 */
function getAllAppendixQuestions(appendixLetter) {
    const questions = {};
    Object.entries(quizData).forEach(([id, q]) => {
        if (q.appendix === appendixLetter) {
            questions[id] = q;
        }
    });
    return questions;
}

/**
 * Get pagination info for an appendix
 * @param {string} appendixLetter - The appendix letter
 * @returns {Object} - Pagination info
 */
function getPaginationInfo(appendixLetter) {
    const state = getAppendixState(appendixLetter);
    return {
        currentPage: state.currentPage,
        totalQuestions: state.allQuestions.length,
        totalPages: Math.ceil(state.allQuestions.length / PAGE_SIZE),
        hasMore: !state.exhausted && state.allQuestions.length < MIN_QUESTIONS_TARGET,
        exhausted: state.exhausted,
        chunksProcessed: state.nextChunkIdx,
        totalChunks: state.totalChunks,
        pageSize: PAGE_SIZE,
        minTarget: MIN_QUESTIONS_TARGET
    };
}

/**
 * Get all available appendices from RAG
 * @returns {Promise<Array>} - Array of appendix objects {letter, title}
 */
async function getAvailableAppendices() {
    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        return [];
    }
    
    await RAG.initialize();
    return RAG.getAppendices();
}

/**
 * Check if an appendix has any loaded questions
 * @param {string} appendixLetter - The appendix letter
 * @returns {boolean}
 */
function isAppendixStarted(appendixLetter) {
    const state = appendixState[appendixLetter];
    return state && state.allQuestions.length > 0;
}

/**
 * Get total question count across all appendices
 * @returns {number}
 */
function getTotalQuestionCount() {
    return Object.keys(quizData).length;
}

/**
 * Clear all loaded questions and reset all state
 */
function clearAllQuestions() {
    Object.keys(quizData).forEach(key => delete quizData[key]);
    Object.keys(appendixState).forEach(key => delete appendixState[key]);
    questionIdCounter = 0;
}

/**
 * Clear questions for a specific appendix
 */
function clearAppendixQuestions(appendixLetter) {
    // Remove from quizData
    Object.keys(quizData).forEach(key => {
        if (quizData[key].appendix === appendixLetter) {
            delete quizData[key];
        }
    });
    // Reset state
    delete appendixState[appendixLetter];
}

/**
 * Clear questions cache (forces regeneration)
 */
async function clearQuestionsCache() {
    if (typeof RAG !== 'undefined') {
        await RAG.clearQuestionsCache();
    }
    clearAllQuestions();
}

// Preloading state
let preloadingInProgress = false;
let preloadedAppendices = new Set();
let preloadingPaused = false;
let lastRateLimitTime = 0;

// Concurrency limit for parallel preloading - reduced to 1 to avoid competing with foreground
const PRELOAD_CONCURRENCY = 1;

// Delay before starting preload after first page loads (ms)
const PRELOAD_DELAY_MS = 3000;

// Cooldown after rate limit before resuming preload (ms)
const RATE_LIMIT_COOLDOWN_MS = 30000;

/**
 * Check if preloading should be paused
 * @returns {boolean}
 */
function shouldPausePreloading() {
    // Pause if explicitly paused
    if (preloadingPaused) return true;
    
    // Pause if we hit a rate limit recently
    if (Date.now() - lastRateLimitTime < RATE_LIMIT_COOLDOWN_MS) {
        console.log('Preloading paused due to recent rate limit');
        return true;
    }
    
    // Pause if LLMClient queue has pending requests (foreground work)
    if (typeof LLMClient !== 'undefined') {
        const status = LLMClient.getStatus();
        if (status.queueLength > 0 || status.activeRequests > 0) {
            console.log('Preloading paused - foreground requests in progress');
            return true;
        }
        if (status.isCircuitOpen) {
            console.log('Preloading paused - circuit breaker open');
            return true;
        }
    }
    
    return false;
}

/**
 * Record a rate limit event to pause preloading
 */
function recordRateLimit() {
    lastRateLimitTime = Date.now();
}

/**
 * Process a single appendix for preloading
 * Uses low priority to not compete with foreground requests
 * @param {Object} appendix - The appendix object with letter and title
 * @param {function} onAppendixLoaded - Callback when appendix finishes loading
 * @returns {Promise<void>}
 */
async function preloadSingleAppendix(appendix, onAppendixLoaded) {
    if (preloadedAppendices.has(appendix.letter)) {
        console.log(`Appendix ${appendix.letter} already preloaded, skipping`);
        return;
    }
    
    // Check if we should pause before starting
    while (shouldPausePreloading()) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Check if preloading was cancelled
        if (!preloadingInProgress) return;
    }
    
    try {
        console.log(`Preloading Appendix ${appendix.letter} (low priority)...`);
        
        // Initialize state for this appendix
        const state = getAppendixState(appendix.letter);
        state.nextChunkIdx = 0;
        state.allQuestions = [];
        state.questionHashes = new Set();
        state.currentPage = 0;
        state.exhausted = false;
        state.totalChunks = RAG.getAppendixChunkCount(appendix.letter);

        // Generate first batch with LOW priority and background flag
        const result = await RAG.generateQuestionsBatch(
            appendix.letter,
            state.nextChunkIdx,
            PAGE_SIZE,
            state.questionHashes,
            null, // No progress callback for background loading
            { priority: 'low', isBackground: true }
        );

        // Update state
        state.nextChunkIdx = result.nextChunkIdx;
        state.exhausted = result.exhausted;
        result.newHashes.forEach(h => state.questionHashes.add(h));

        // Convert and store questions
        result.questions.forEach(q => {
            const id = String(questionIdCounter++);
            const converted = convertToQuizFormat(q);
            quizData[id] = converted;
            state.allQuestions.push({ id, ...converted });
        });

        state.currentPage = 1;
        preloadedAppendices.add(appendix.letter);
        
        const stats = result.stats || { cacheHits: 0, apiCalls: 0 };
        console.log(`Preloaded ${result.questions.length} questions for Appendix ${appendix.letter} (cache: ${stats.cacheHits}, api: ${stats.apiCalls})`);
        
        if (onAppendixLoaded) {
            onAppendixLoaded(appendix.letter, result.questions.length);
        }
        
    } catch (error) {
        console.error(`Error preloading Appendix ${appendix.letter}:`, error);
        // Check if this was a rate limit error
        if (error.message && error.message.includes('429')) {
            recordRateLimit();
        }
        // Don't throw - allow other appendixes to continue
    }
}

/**
 * Concurrent queue processor - processes items with limited parallelism
 * @param {Array} items - Items to process
 * @param {number} concurrency - Max concurrent operations
 * @param {function} processor - Async function to process each item
 * @returns {Promise<void>}
 */
async function processConcurrentQueue(items, concurrency, processor) {
    const queue = [...items];
    const activePromises = new Set();
    
    while (queue.length > 0 || activePromises.size > 0) {
        // Fill up to concurrency limit
        while (queue.length > 0 && activePromises.size < concurrency) {
            const item = queue.shift();
            const promise = processor(item).finally(() => {
                activePromises.delete(promise);
            });
            activePromises.add(promise);
        }
        
        // Wait for at least one to complete before continuing
        if (activePromises.size > 0) {
            await Promise.race(activePromises);
        }
    }
}

/**
 * Preload first batch of questions for all appendixes in the background
 * Waits for delay after first page loads to not compete with foreground
 * Uses sequential processing (concurrency=1) to minimize API pressure
 * @param {function} onAppendixLoaded - Callback when an appendix finishes loading
 * @param {Object} options - Options (skipDelay: boolean, excludeAppendix: string)
 * @returns {Promise<void>}
 */
async function preloadAllAppendixes(onAppendixLoaded = null, options = {}) {
    // DISABLED: Background preloading is disabled to reduce API pressure and 429 errors
    // Users can manually load more questions by clicking "Load More" button
    // To re-enable, set options.forceEnable = true
    const { skipDelay = false, excludeAppendix = null, forceEnable = false } = options;
    
    if (!forceEnable) {
        console.log('Background preloading is disabled to reduce API pressure. Use "Load More" button for additional questions.');
        return;
    }
    
    if (preloadingInProgress) {
        console.log('Preloading already in progress');
        return;
    }
    
    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        return;
    }

    preloadingInProgress = true;
    
    // Wait before starting preload to let foreground requests complete
    if (!skipDelay) {
        console.log(`Waiting ${PRELOAD_DELAY_MS}ms before starting background preload...`);
        await new Promise(resolve => setTimeout(resolve, PRELOAD_DELAY_MS));
    }
    
    // Check if preloading was cancelled during delay
    if (!preloadingInProgress) {
        console.log('Preloading cancelled during delay');
        return;
    }
    
    console.log(`Starting background preload (concurrency: ${PRELOAD_CONCURRENCY})...`);

    try {
        await RAG.initialize();
        let appendices = RAG.getAppendices();
        
        // Exclude the currently active appendix (already loaded)
        if (excludeAppendix) {
            appendices = appendices.filter(a => a.letter !== excludeAppendix);
        }
        
        // Process appendixes sequentially to minimize API pressure
        await processConcurrentQueue(
            appendices,
            PRELOAD_CONCURRENCY,
            (appendix) => preloadSingleAppendix(appendix, onAppendixLoaded)
        );
        
        console.log('Background preload complete for all appendixes');
        
    } catch (error) {
        console.error('Error during preload:', error);
    } finally {
        preloadingInProgress = false;
    }
}

/**
 * Stop any in-progress preloading
 */
function stopPreloading() {
    if (preloadingInProgress) {
        console.log('Stopping preloading...');
        preloadingInProgress = false;
        preloadingPaused = true;
    }
}

/**
 * Resume preloading after it was paused
 */
function resumePreloading() {
    preloadingPaused = false;
}

/**
 * Check if an appendix has been preloaded
 * @param {string} appendixLetter - The appendix letter
 * @returns {boolean}
 */
function isAppendixPreloaded(appendixLetter) {
    return preloadedAppendices.has(appendixLetter);
}

/**
 * Get preloading status
 * @returns {Object} - Preloading status info
 */
function getPreloadStatus() {
    return {
        inProgress: preloadingInProgress,
        preloadedCount: preloadedAppendices.size,
        preloadedAppendices: Array.from(preloadedAppendices)
    };
}

/**
 * STREAMING RAG: Load questions progressively with callback for each question
 * This is TRUE RAG - retrieves chunks, generates questions, streams them to UI immediately
 * Students see the FIRST question in 2-3 seconds instead of waiting for all 20!
 * 
 * @param {string} appendixLetter - The appendix letter (A-J)
 * @param {Object} options - Configuration options
 * @param {function} options.onQuestion - Called for EACH question as it arrives (key for fast UX!)
 * @param {function} options.onProgress - Progress callback
 * @param {function} options.onComplete - Called when generation is complete
 * @param {function} options.onError - Called on errors
 * @param {number} options.targetCount - Target number of questions (default 20)
 * @returns {Promise<Object>} - Final result with all questions
 */
async function loadAppendixStreaming(appendixLetter, options = {}) {
    const {
        onQuestion = null,
        onProgress = null,
        onComplete = null,
        onError = null,
        targetCount = PAGE_SIZE
    } = options;

    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        if (onError) onError({ type: 'rag_not_loaded' });
        return { questions: {}, hasMore: false, currentPage: 0, totalQuestions: 0 };
    }

    await RAG.initialize();
    
    // Reset state for this appendix
    const state = getAppendixState(appendixLetter);
    state.nextChunkIdx = 0;
    state.allQuestions = [];
    state.questionHashes = new Set();
    state.currentPage = 0;
    state.exhausted = false;
    state.totalChunks = RAG.getAppendixChunkCount(appendixLetter);

    // Clear any existing questions for this appendix from quizData
    Object.keys(quizData).forEach(key => {
        if (quizData[key].appendix === appendixLetter) {
            delete quizData[key];
        }
    });

    const pageQuestions = {};
    
    // Check if user has set their own API key (highest priority)
    const hasUserApiKey = typeof LLMClient !== 'undefined' && LLMClient.hasApiKey();
    
    // Check if LLM is available (not in circuit breaker or rate limit cooldown)
    const isLLMAvailable = () => {
        if (typeof LLMClient === 'undefined') return false;
        const status = LLMClient.getStatus();
        return !status.isCircuitOpen && !status.isInCooldown;
    };
    
    // PRIORITY ORDER:
    // 1. User API key set -> Always use LLM (most prioritized)
    // 2. No API key -> Use LLM7 anonymous mode, keep P2P synced
    // 3. LLM has issues -> Fall back to P2P
    
    // Always subscribe to P2P for realtime dual sync (regardless of priority)
    if (typeof P2PSync !== 'undefined' && P2PSync.isAvailable()) {
        P2PSync.subscribeToAppendix(appendixLetter);
    }
    
    let useLLM = true;
    let llmFailed = false;
    
    // If user has API key, skip P2P-first and go straight to LLM
    if (hasUserApiKey) {
        console.log('LLM-PRIORITY: User API key detected, using LLM directly');
        useLLM = true;
    } else if (!isLLMAvailable()) {
        // LLM7 anonymous mode has issues (circuit breaker or rate limit)
        console.log('LLM-FALLBACK: LLM7 unavailable (circuit breaker or rate limit), trying P2P first');
        useLLM = false;
    } else {
        // No API key, LLM7 anonymous mode available - try LLM first but be ready to fall back
        console.log('LLM-ANONYMOUS: Using LLM7 anonymous mode (8k token limit)');
        useLLM = true;
    }
    
    // If LLM is not available, try P2P first
    if (!useLLM && typeof P2PSync !== 'undefined' && P2PSync.isAvailable()) {
        try {
            console.log(`P2P-FALLBACK: Waiting for P2P questions for Appendix ${appendixLetter}...`);
            const p2pQuestions = await P2PSync.getQuestionsFromPool(appendixLetter, { 
                minCount: targetCount, 
                timeoutMs: 3000 
            });
            if (p2pQuestions && p2pQuestions.length >= targetCount) {
                console.log(`P2P-FALLBACK: Found ${p2pQuestions.length} questions from P2P for Appendix ${appendixLetter}`);
                
                // Use P2P questions - convert and store them
                const questionsToUse = p2pQuestions.slice(0, targetCount);
                questionsToUse.forEach((q, idx) => {
                    const id = String(questionIdCounter++);
                    const converted = convertToQuizFormat(q);
                    quizData[id] = converted;
                    state.allQuestions.push({ id, ...converted });
                    pageQuestions[id] = converted;
                    state.questionHashes.add(hashQuestion(q.question));
                    
                    if (onQuestion) {
                        onQuestion(converted, id, idx + 1, questionsToUse.length);
                    }
                });
                
                state.currentPage = 1;
                
                const finalResult = {
                    questions: pageQuestions,
                    hasMore: p2pQuestions.length > targetCount,
                    currentPage: state.currentPage,
                    totalQuestions: state.allQuestions.length,
                    exhausted: false,
                    chunksProcessed: 0,
                    totalChunks: state.totalChunks,
                    stats: { p2pHits: questionsToUse.length, apiCalls: 0, source: 'p2p' }
                };
                
                if (onComplete) {
                    onComplete(finalResult);
                }
                
                return finalResult;
            } else {
                console.log(`P2P-FALLBACK: Only ${p2pQuestions ? p2pQuestions.length : 0} questions from P2P, need ${targetCount}. Will try LLM anyway.`);
                useLLM = true; // Try LLM even if it might fail
            }
        } catch (e) {
            console.warn('P2P-FALLBACK: Error getting P2P questions', e);
            useLLM = true; // Try LLM as last resort
        }
    }

    // Use LLM (either with user API key or LLM7 anonymous mode)
    let result;
    try {
        result = await RAG.generateQuestionsStreaming(appendixLetter, {
            targetCount,
            startChunkIdx: state.nextChunkIdx,
            existingHashes: state.questionHashes,
            
            // Called for each question immediately - REALTIME streaming
            onQuestion: (ragQuestion, currentCount, total) => {
                const id = String(questionIdCounter++);
                const converted = convertToQuizFormat(ragQuestion);
                quizData[id] = converted;
                state.allQuestions.push({ id, ...converted });
                pageQuestions[id] = converted;
                
                // Call the UI callback so it can display this question immediately!
                if (onQuestion) {
                    onQuestion(converted, id, currentCount, total);
                }
                
                // REALTIME DUAL SYNC: Share each question to P2P as it's generated
                if (typeof P2PSync !== 'undefined' && P2PSync.isAvailable()) {
                    P2PSync.shareQuestions([ragQuestion], appendixLetter).catch(() => {});
                }
            },
            
            onProgress: (progress) => {
                if (onProgress) {
                    onProgress({
                        ...progress,
                        appendix: appendixLetter,
                        totalChunks: state.totalChunks,
                        source: hasUserApiKey ? 'user_api' : 'llm7_anonymous'
                    });
                }
            },
            
            onError: (error) => {
                console.error('Streaming RAG error:', error);
                llmFailed = true;
                if (onError) onError(error);
            }
        });
    } catch (e) {
        console.error('LLM generation failed:', e);
        llmFailed = true;
        
        // LLM failed - try P2P as final fallback
        if (typeof P2PSync !== 'undefined' && P2PSync.isAvailable()) {
            console.log('LLM-FAILED: Attempting P2P fallback...');
            try {
                const p2pQuestions = await P2PSync.getQuestionsFromPool(appendixLetter, { 
                    minCount: Math.max(5, targetCount / 2), // Accept fewer questions as fallback
                    timeoutMs: 5000 
                });
                if (p2pQuestions && p2pQuestions.length > 0) {
                    console.log(`P2P-RECOVERY: Found ${p2pQuestions.length} questions from P2P after LLM failure`);
                    
                    const questionsToUse = p2pQuestions.slice(0, targetCount);
                    questionsToUse.forEach((q, idx) => {
                        const id = String(questionIdCounter++);
                        const converted = convertToQuizFormat(q);
                        quizData[id] = converted;
                        state.allQuestions.push({ id, ...converted });
                        pageQuestions[id] = converted;
                        state.questionHashes.add(hashQuestion(q.question));
                        
                        if (onQuestion) {
                            onQuestion(converted, id, idx + 1, questionsToUse.length);
                        }
                    });
                    
                    state.currentPage = 1;
                    
                    const finalResult = {
                        questions: pageQuestions,
                        hasMore: p2pQuestions.length > targetCount,
                        currentPage: state.currentPage,
                        totalQuestions: state.allQuestions.length,
                        exhausted: false,
                        chunksProcessed: 0,
                        totalChunks: state.totalChunks,
                        stats: { p2pHits: questionsToUse.length, apiCalls: 0, source: 'p2p_fallback', llmFailed: true }
                    };
                    
                    if (onComplete) {
                        onComplete(finalResult);
                    }
                    
                    return finalResult;
                }
            } catch (p2pError) {
                console.error('P2P fallback also failed:', p2pError);
            }
        }
        
        // Both LLM and P2P failed
        if (onError) onError({ type: 'all_sources_failed', error: e });
        return { 
            questions: pageQuestions, 
            hasMore: false, 
            currentPage: 0, 
            totalQuestions: Object.keys(pageQuestions).length,
            stats: { source: 'failed', llmFailed: true, p2pFailed: true }
        };
    }

    // Update state
    state.nextChunkIdx = result.nextChunkIdx;
    state.exhausted = result.exhausted;
    state.currentPage = 1;

    console.log(`Streamed ${result.questions.length} questions for Appendix ${appendixLetter} (source: ${hasUserApiKey ? 'user_api' : 'llm7_anonymous'})`);

    const finalResult = {
        questions: pageQuestions,
        hasMore: !state.exhausted && state.allQuestions.length < MIN_QUESTIONS_TARGET,
        currentPage: state.currentPage,
        totalQuestions: state.allQuestions.length,
        exhausted: state.exhausted,
        chunksProcessed: state.nextChunkIdx,
        totalChunks: state.totalChunks,
        stats: { 
            ...result.stats, 
            source: hasUserApiKey ? 'user_api' : 'llm7_anonymous',
            p2pSynced: typeof P2PSync !== 'undefined' && P2PSync.isAvailable()
        }
    };

    if (onComplete) {
        onComplete(finalResult);
    }

    return finalResult;
}

/**
 * STREAMING RAG: Load next page of questions progressively
 * @param {string} appendixLetter - The appendix letter (A-J)
 * @param {Object} options - Same options as loadAppendixStreaming
 * @returns {Promise<Object>} - Final result with all questions
 */
async function loadAppendixNextPageStreaming(appendixLetter, options = {}) {
    const {
        onQuestion = null,
        onProgress = null,
        onComplete = null,
        onError = null,
        targetCount = PAGE_SIZE
    } = options;

    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        if (onError) onError({ type: 'rag_not_loaded' });
        return { questions: {}, hasMore: false, currentPage: 0, totalQuestions: 0 };
    }
    
    // Ensure P2P subscription is active for this appendix
    if (typeof P2PSync !== 'undefined' && P2PSync.isAvailable()) {
        P2PSync.subscribeToAppendix(appendixLetter);
    }

    const state = getAppendixState(appendixLetter);
    
    if (state.exhausted) {
        console.log(`Appendix ${appendixLetter} is exhausted, no more questions available`);
        const result = {
            questions: {},
            hasMore: false,
            currentPage: state.currentPage,
            totalQuestions: state.allQuestions.length,
            exhausted: true,
            chunksProcessed: state.nextChunkIdx,
            totalChunks: state.totalChunks
        };
        if (onComplete) onComplete(result);
        return result;
    }

    await RAG.initialize();

    const pageQuestions = {};

    // Check if user has set their own API key (highest priority)
    const hasUserApiKey = typeof LLMClient !== 'undefined' && LLMClient.hasApiKey();
    
    // Use streaming RAG for next page with REALTIME P2P sync
    const result = await RAG.generateQuestionsStreaming(appendixLetter, {
        targetCount,
        startChunkIdx: state.nextChunkIdx,
        existingHashes: state.questionHashes,
        
        onQuestion: (ragQuestion, currentCount, total) => {
            const id = String(questionIdCounter++);
            const converted = convertToQuizFormat(ragQuestion);
            quizData[id] = converted;
            state.allQuestions.push({ id, ...converted });
            pageQuestions[id] = converted;
            
            if (onQuestion) {
                onQuestion(converted, id, currentCount, total);
            }
            
            // REALTIME DUAL SYNC: Share each question to P2P as it's generated
            if (typeof P2PSync !== 'undefined' && P2PSync.isAvailable()) {
                P2PSync.shareQuestions([ragQuestion], appendixLetter).catch(() => {});
            }
        },
        
        onProgress,
        onError
    });

    // Update state
    state.nextChunkIdx = result.nextChunkIdx;
    state.exhausted = result.exhausted;
    state.currentPage++;

    console.log(`Streamed page ${state.currentPage} with ${result.questions.length} questions for Appendix ${appendixLetter} (source: ${hasUserApiKey ? 'user_api' : 'llm7_anonymous'})`);

    const finalResult = {
        questions: pageQuestions,
        hasMore: !state.exhausted && state.allQuestions.length < MIN_QUESTIONS_TARGET,
        currentPage: state.currentPage,
        totalQuestions: state.allQuestions.length,
        exhausted: state.exhausted,
        chunksProcessed: state.nextChunkIdx,
        totalChunks: state.totalChunks,
        stats: { 
            ...result.stats, 
            source: hasUserApiKey ? 'user_api' : 'llm7_anonymous',
            p2pSynced: typeof P2PSync !== 'undefined' && P2PSync.isAvailable()
        }
    };

    if (onComplete) {
        onComplete(finalResult);
    }

    return finalResult;
}

// Export functions for use in app.js
window.QuizDataLoader = {
    // STREAMING RAG - shows questions immediately as they're generated (FAST!)
    loadAppendixStreaming,
    loadAppendixNextPageStreaming,
    // Legacy pagination functions (waits for all questions before returning)
    loadAppendixFirstPage,
    loadAppendixNextPage,
    getPageQuestions,
    getPaginationInfo,
    // Preloading functions
    preloadAllAppendixes,
    isAppendixPreloaded,
    getPreloadStatus,
    stopPreloading,
    resumePreloading,
    // Rate limit handling
    recordRateLimit,
    // Legacy/utility functions
    getAvailableAppendices,
    isAppendixStarted,
    getAllAppendixQuestions,
    getTotalQuestionCount,
    clearAllQuestions,
    clearAppendixQuestions,
    clearQuestionsCache,
    // Constants
    PAGE_SIZE,
    MIN_QUESTIONS_TARGET
};
