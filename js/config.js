/**
 * Central configuration file for CREST CPSA Quiz
 * All magic numbers and constants are defined here for easy maintenance
 */

const CONFIG = {
    // Storage keys for localStorage
    storage: {
        PROGRESS_KEY: 'cpsa_quiz_progress',
        STREAK_KEY: 'cpsa_quiz_streak',
        BADGES_KEY: 'cpsa_quiz_badges',
        STUDY_TIME_KEY: 'cpsa_study_time',
        DAILY_STATS_KEY: 'cpsa_daily_stats',
        EXAM_HISTORY_KEY: 'cpsa_exam_history'
    },

    // Chat/Tutor settings
    chat: {
        MAX_LENGTH: 400,
        MAX_TURNS: 12
    },

    // Pagination settings
    pagination: {
        PAGE_SIZE: 20,
        MIN_QUESTIONS_TARGET: 120
    },

    // Concurrency settings for batch processing
    concurrency: {
        PRELOAD: 3,
        BATCH: 5,
        MIN_DELAY_BETWEEN_BATCHES: 500
    },

    // XP/Gamification settings
    xp: {
        PER_CORRECT: 10,
        PER_INCORRECT: 2,
        PER_LEVEL: 100
    },

    // BM25 search parameters
    bm25: {
        K1: 1.5,
        B: 0.75
    },

    // Token budgeting for LLM API calls
    tokens: {
        TOTAL_LIMIT: 8000,
        SYSTEM_PROMPT_RESERVE: 800,
        USER_QUERY_RESERVE: 400,
        RESPONSE_RESERVE: 500,
        CONTEXT_BUDGET: 2500,
        CHARS_PER_TOKEN: 4
    },

    // UI settings
    ui: {
        SEARCH_DEBOUNCE_MS: 300,
        TOAST_DURATION_MS: 3000
    },

    // Practice exam settings
    exam: {
        DEFAULT_QUESTION_COUNT: 50,
        DEFAULT_TIME_MINUTES: 60
    },

    // API endpoint
    api: {
        LLM_ENDPOINT: 'https://api.llm7.io/v1/chat/completions',
        MODEL: 'gpt-4o-mini'
    },

    // IndexedDB settings
    indexedDB: {
        DB_NAME: 'cpsa-rag-cache',
        DB_VERSION: 2,
        CHUNKS_STORE: 'chunks',
        QUESTIONS_STORE: 'questions'
    }
};

// Make CONFIG available globally
if (typeof window !== 'undefined') {
    window.CONFIG = CONFIG;
}
