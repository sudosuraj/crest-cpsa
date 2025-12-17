/**
 * CPSA Quiz Data - Dynamic RAG-based Question Generation
 * 
 * This file now serves as a bridge between the RAG system and the quiz UI.
 * Questions are generated dynamically from the PDF study notes using the RAG module.
 * 
 * The quizData object is populated on-demand when users select an appendix.
 */

// Empty quizData - will be populated dynamically from RAG
const quizData = {};

// Track which appendices have been loaded
const loadedAppendices = new Set();

// Question ID counter for unique IDs
let questionIdCounter = 0;

/**
 * Load questions for a specific appendix using RAG
 * @param {string} appendixLetter - The appendix letter (A-J)
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Object>} - Questions keyed by ID
 */
async function loadAppendixQuestions(appendixLetter, onProgress = null) {
    if (loadedAppendices.has(appendixLetter)) {
        // Return already loaded questions for this appendix
        const existing = {};
        Object.entries(quizData).forEach(([id, q]) => {
            if (q.appendix === appendixLetter) {
                existing[id] = q;
            }
        });
        return existing;
    }

    // Ensure RAG is initialized
    if (typeof RAG === 'undefined') {
        console.error('RAG module not loaded');
        return {};
    }

    await RAG.initialize();

    // Generate questions using RAG
    const questions = await RAG.generateQuestionsForAppendix(appendixLetter, {
        questionsPerChunk: 2,
        onProgress: onProgress,
        delayBetweenCalls: 1200
    });

    // Convert to quizData format
    const newQuestions = {};
    questions.forEach(q => {
        const id = String(questionIdCounter++);
        
        // Convert from RAG format to quiz format
        const correctAnswer = q.options[q.correct];
        const incorrectAnswers = q.options.filter((_, i) => i !== q.correct);
        
        quizData[id] = {
            question: q.question,
            answer: correctAnswer.replace(/^[A-D]\)\s*/, ''), // Remove A) B) C) D) prefix
            incorrect: incorrectAnswers.map(opt => opt.replace(/^[A-D]\)\s*/, '')),
            explanation: q.explanation,
            appendix: q.appendix,
            appendix_title: q.appendix_title,
            section_id: q.section_id,
            section_title: q.section_title,
            source_chunk_id: q.source_chunk_id
        };
        
        newQuestions[id] = quizData[id];
    });

    loadedAppendices.add(appendixLetter);
    console.log(`Loaded ${Object.keys(newQuestions).length} questions for Appendix ${appendixLetter}`);
    
    return newQuestions;
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
 * Check if an appendix has been loaded
 * @param {string} appendixLetter - The appendix letter
 * @returns {boolean}
 */
function isAppendixLoaded(appendixLetter) {
    return loadedAppendices.has(appendixLetter);
}

/**
 * Get questions for a specific appendix (already loaded)
 * @param {string} appendixLetter - The appendix letter
 * @returns {Object} - Questions keyed by ID
 */
function getAppendixQuestions(appendixLetter) {
    const questions = {};
    Object.entries(quizData).forEach(([id, q]) => {
        if (q.appendix === appendixLetter) {
            questions[id] = q;
        }
    });
    return questions;
}

/**
 * Get total question count
 * @returns {number}
 */
function getTotalQuestionCount() {
    return Object.keys(quizData).length;
}

/**
 * Clear all loaded questions and reset
 */
function clearAllQuestions() {
    Object.keys(quizData).forEach(key => delete quizData[key]);
    loadedAppendices.clear();
    questionIdCounter = 0;
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

// Export functions for use in app.js
window.QuizDataLoader = {
    loadAppendixQuestions,
    getAvailableAppendices,
    isAppendixLoaded,
    getAppendixQuestions,
    getTotalQuestionCount,
    clearAllQuestions,
    clearQuestionsCache
};
    "3": {
        "question": "Which is the least secure encryption cipher of those listed below?",
        "answer": "DES",
        "incorrect": [
