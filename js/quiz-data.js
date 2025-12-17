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
const MIN_QUESTIONS_TARGET = 120;

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

/**
 * Preload first batch of questions for all appendixes in the background
 * This runs silently without blocking the UI
 * @param {function} onAppendixLoaded - Callback when an appendix finishes loading
 * @returns {Promise<void>}
 */
async function preloadAllAppendixes(onAppendixLoaded = null) {
    if (preloadingInProgress) {
        console.log('Preloading already in progress');
        return;
    }
    
    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        return;
    }

    preloadingInProgress = true;
    console.log('Starting background preload of all appendixes...');

    try {
        await RAG.initialize();
        const appendices = RAG.getAppendices();
        
        // Load each appendix sequentially to avoid overwhelming the system
        for (const appendix of appendices) {
            if (preloadedAppendices.has(appendix.letter)) {
                console.log(`Appendix ${appendix.letter} already preloaded, skipping`);
                continue;
            }
            
            try {
                console.log(`Preloading Appendix ${appendix.letter}...`);
                
                // Initialize state for this appendix
                const state = getAppendixState(appendix.letter);
                state.nextChunkIdx = 0;
                state.allQuestions = [];
                state.questionHashes = new Set();
                state.currentPage = 0;
                state.exhausted = false;
                state.totalChunks = RAG.getAppendixChunkCount(appendix.letter);

                // Generate first batch silently (no progress callback)
                const result = await RAG.generateQuestionsBatch(
                    appendix.letter,
                    state.nextChunkIdx,
                    PAGE_SIZE,
                    state.questionHashes,
                    null // No progress callback for background loading
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
                
                console.log(`Preloaded ${result.questions.length} questions for Appendix ${appendix.letter}`);
                
                if (onAppendixLoaded) {
                    onAppendixLoaded(appendix.letter, result.questions.length);
                }
                
            } catch (error) {
                console.error(`Error preloading Appendix ${appendix.letter}:`, error);
                // Continue with other appendixes even if one fails
            }
        }
        
        console.log('Background preload complete for all appendixes');
        
    } catch (error) {
        console.error('Error during preload:', error);
    } finally {
        preloadingInProgress = false;
    }
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

// Export functions for use in app.js
window.QuizDataLoader = {
    // Pagination functions
    loadAppendixFirstPage,
    loadAppendixNextPage,
    getPageQuestions,
    getPaginationInfo,
    // Preloading functions
    preloadAllAppendixes,
    isAppendixPreloaded,
    getPreloadStatus,
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
