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

    // Meta-content patterns to filter out - these generate irrelevant questions
    // about syllabus structure instead of actual exam content
    const META_CONTENT_PATTERNS = [
        /missing from the official crest cpsa syllabus/i,
        /author'?s? notes?:/i,
        /couldn'?t find any/i,
        /\[placeholder\]/i,
        /\[to be added\]/i,
        /\[section missing\]/i
    ];

    // Meta-question patterns to filter out - questions about syllabus structure
    const META_QUESTION_PATTERNS = [
        /primary focus of appendix/i,
        /missing from the official.*syllabus/i,
        /indicated as missing/i,
        /considered important in the context of.*certification/i,
        /inferred.*based on the.*study material/i,
        /true regarding the official.*syllabus/i,
        /what is appendix [a-j]/i,
        /which appendix/i,
        /the syllabus document/i,
        /the study material/i,
        /the provided material/i,
        /according to the.*material/i
    ];

    /**
     * ENHANCED: Check if a chunk contains meta-content that shouldn't be used for question generation
     * Now less aggressive - only skips true placeholder content, not short but valid chunks
     * @param {Object} chunk - The chunk to check
     * @returns {boolean} - True if chunk should be skipped
     */
    function isMetaContentChunk(chunk) {
        if (!chunk || !chunk.text) return true;
        
        const text = chunk.text.trim();
        
        // ENHANCED: Only skip truly empty or placeholder chunks
        // Reduced threshold from 100 to 50 chars to preserve short but valid content
        if (text.length < 50) return true;
        
        // Check for meta-content patterns
        for (const pattern of META_CONTENT_PATTERNS) {
            if (pattern.test(text)) {
                // Only skip if the chunk is primarily placeholder content
                // (i.e., the placeholder text is a significant portion of the chunk)
                if (text.length < 200) {
                    console.log(`Skipping meta-content chunk: ${chunk.section_id}`);
                    return true;
                }
            }
        }
        
        return false;
    }

    /**
     * Check if a question is about meta-content (syllabus structure, appendix organization, etc.)
     * @param {Object} question - The question to check
     * @returns {boolean} - True if question should be filtered out
     */
    function isMetaQuestion(question) {
        if (!question || !question.question) return true;
        
        const questionText = question.question;
        const explanationText = question.explanation || '';
        
        // Check question text against meta-question patterns
        for (const pattern of META_QUESTION_PATTERNS) {
            if (pattern.test(questionText) || pattern.test(explanationText)) {
                console.log(`Filtering meta-question: ${questionText.substring(0, 60)}...`);
                return true;
            }
        }
        
        return false;
    }

    // Token budget configuration (8000 total limit)
    // ENHANCED: Increased context budget for better coverage
    const TOKEN_CONFIG = {
        totalLimit: 8000,           // Total token limit for API
        systemPromptReserve: 800,   // Reserve for system prompt
        userQueryReserve: 300,      // Reserve for user query (reduced)
        responseReserve: 1200,      // Reserve for model response (increased for more questions)
        contextBudget: 4000,        // Max tokens for RAG context (~16000 chars) - INCREASED
        charsPerToken: 4,           // Approximate chars per token
        maxChunkChars: 3000         // Max chars per chunk before splitting (no hard truncation)
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

    // ENHANCED: Security-specific terms to preserve during tokenization
    // These patterns are extracted before general tokenization to preserve their meaning
    const SECURITY_TERM_PATTERNS = [
        // Nmap flags and options
        /-s[STUFNAXWMP]/gi,           // -sS, -sT, -sU, -sF, -sN, -sA, -sX, -sW, -sM, -sP
        /-p[\d,-]+/gi,                // -p80, -p1-1000, -p-
        /-[oOAT]\d?/gi,               // -oA, -O, -T4, etc.
        /-P[NnSsAaUuYy]/gi,           // -Pn, -PS, -PA, etc.
        // Port specifications
        /\d{1,5}\/(?:tcp|udp)/gi,     // 80/tcp, 443/tcp, 53/udp
        // CVE identifiers
        /CVE-\d{4}-\d+/gi,            // CVE-2021-44228
        // File permissions
        /-?[rwx-]{9,10}/g,            // -rw-r--r--, rwxr-xr-x
        // IP addresses and CIDR
        /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?/g,
        // Common security acronyms (preserve case-insensitive)
        /\b(?:XSS|CSRF|SQLi|LFI|RFI|SSRF|XXE|IDOR|RCE|DOS|DDOS)\b/gi,
        // HTTP methods
        /\b(?:GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD|TRACE)\b/g,
        // Registry paths
        /HKEY_[A-Z_]+/gi,
        // Common tool names
        /\b(?:nmap|burp|metasploit|wireshark|sqlmap|nikto|dirb|gobuster|hydra|john|hashcat)\b/gi
    ];

    /**
     * Extract security-specific terms from text before general tokenization
     * @param {string} text - Input text
     * @returns {Array} - Array of extracted security terms
     */
    function extractSecurityTerms(text) {
        if (!text) return [];
        const terms = [];
        for (const pattern of SECURITY_TERM_PATTERNS) {
            const matches = text.match(pattern);
            if (matches) {
                terms.push(...matches.map(m => m.toLowerCase().replace(/[^\w/-]/g, '')));
            }
        }
        return terms;
    }

    /**
     * ENHANCED: Tokenize and normalize text while preserving security-specific terms
     * Improvements:
     * 1. Extracts security terms (flags, ports, CVEs) before normalization
     * 2. Preserves important punctuation in technical terms
     * 3. Handles hyphenated terms better
     */
    function tokenize(text) {
        if (!text) return [];
        
        // First extract security-specific terms
        const securityTerms = extractSecurityTerms(text);
        
        // Then do general tokenization
        const generalTokens = text
            .toLowerCase()
            // Preserve hyphens in compound words but remove other punctuation
            .replace(/[^\w\s-]/g, ' ')
            // Split on whitespace
            .split(/\s+/)
            // Filter out stopwords and very short tokens
            .filter(token => {
                const cleaned = token.replace(/-/g, '');
                return cleaned.length > 1 && !STOPWORDS.has(cleaned);
            });
        
        // Combine and deduplicate
        const allTokens = [...new Set([...securityTerms, ...generalTokens])];
        return allTokens;
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
     * Search with scores - returns chunks with their BM25 scores
     * Used for conditional RAG (only attach context if score is high enough)
     */
    function searchWithScores(query, topK = 5) {
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

        // Sort by score and return top K with scores
        return scores
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
    
    /**
     * Get a specific chunk by ID
     * Used for explain buttons to get the source chunk directly
     */
    function getChunkById(chunkId) {
        if (!isInitialized) return null;
        return chunks.find(chunk => chunk.id === chunkId) || null;
    }
    
    /**
     * Check if a query is likely CPSA-specific
     * Used to decide whether to attach RAG context
     */
    function isCPSAQuery(query) {
        if (!query) return false;
        const lowerQuery = query.toLowerCase();
        const cpsakeywords = [
            'cpsa', 'crest', 'appendix', 'penetration', 'pentest',
            'vulnerability', 'exploit', 'security', 'audit', 'assessment',
            'nmap', 'burp', 'metasploit', 'wireshark', 'sqlmap',
            'xss', 'csrf', 'sql injection', 'buffer overflow',
            'reconnaissance', 'enumeration', 'privilege escalation',
            'osint', 'footprinting', 'scanning', 'exploitation'
        ];
        return cpsakeywords.some(keyword => lowerQuery.includes(keyword));
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
        if (path.includes('/crest-cpsa/')) {
            return '/crest-cpsa/';
        }
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

    // Session seed for chunk shuffling - different each page load
    const sessionSeed = Date.now() + Math.random();
    
    /**
     * Seeded random number generator (mulberry32)
     * Produces consistent results for the same seed
     */
    function seededRandom(seed) {
        return function() {
            let t = seed += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    
    /**
     * Shuffle array using Fisher-Yates with seeded random
     * Same seed + same array = same shuffle result
     */
    function shuffleWithSeed(array, seed) {
        const result = [...array];
        const random = seededRandom(seed);
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    }
    
    // Cache shuffled chunks per appendix for consistent paging within session
    const shuffledChunksCache = {};

    /**
     * Get chunks for a specific appendix (filters out meta-content chunks)
     * Chunks are shuffled per session so users see different questions each time
     */
    function getChunksForAppendix(appendixLetter) {
        if (!isInitialized) return [];
        
        // Return cached shuffled chunks if available (for consistent paging)
        if (shuffledChunksCache[appendixLetter]) {
            return shuffledChunksCache[appendixLetter];
        }
        
        // Filter chunks for this appendix
        const appendixChunks = chunks.filter(chunk => 
            chunk.appendix === appendixLetter && !isMetaContentChunk(chunk)
        );
        
        // Shuffle with session seed + appendix letter for variety
        const seed = sessionSeed + appendixLetter.charCodeAt(0);
        const shuffled = shuffleWithSeed(appendixChunks, seed);
        
        // Cache for consistent paging within this session
        shuffledChunksCache[appendixLetter] = shuffled;
        
        return shuffled;
    }

    /**
     * Generate MCQ questions from a chunk using LLM API
     * With token budgeting to stay under 8000 token limit
     * Now uses LLMClient for rate limiting and QuestionCache for persistence
     * @param {Object} chunk - The chunk to generate questions from
     * @param {number} questionsPerChunk - Number of questions to generate
     * @param {Object} options - Options (priority: 'high'|'low', skipCache: boolean)
     */
    async function generateQuestionsFromChunk(chunk, questionsPerChunk = 5, options = {}) {
        const { priority = 'normal', skipCache = false } = options;
        
        // Check cache first (unless skipCache is true)
        if (!skipCache && typeof QuestionCache !== 'undefined') {
            try {
                const cached = await QuestionCache.get(chunk.id, { questionsPerChunk });
                if (cached && cached.length > 0) {
                    console.log(`Cache hit for chunk ${chunk.id}: ${cached.length} questions`);
                    // Enrich cached questions with source info
                    return cached.map(q => ({
                        ...q,
                        source_chunk_id: chunk.id,
                        appendix: chunk.appendix,
                        appendix_title: chunk.appendix_title,
                        section_id: chunk.section_id,
                        section_title: chunk.section_title,
                        cached: true
                    }));
                }
            } catch (cacheError) {
                console.warn('Cache read error:', cacheError);
            }
        }
        
        const systemPrompt = `You are a CPSA (CREST Practitioner Security Analyst) exam question generator. Generate exactly ${questionsPerChunk} challenging multiple-choice questions based on the provided study material.

Output ONLY valid JSON array with this exact structure:
[{"question":"Question text?","options":["A) Option 1","B) Option 2","C) Option 3","D) Option 4"],"correct":0,"explanation":"Brief explanation"}]

QUESTION DIFFICULTY - Generate HARD exam-level questions:
- Focus on scenario-based questions: "A penetration tester discovers X. What is the MOST appropriate next step?"
- Test application of knowledge, not just recall: "Which technique would be MOST effective for..."
- Include questions about trade-offs and best practices: "What is the PRIMARY advantage of..."
- Ask about attack chains and methodology: "After gaining initial access via X, which attack would..."
- Test understanding of when/why to use specific tools or techniques
- Avoid simple definition questions like "What is X?" - instead ask "In which scenario would X be preferred over Y?"

CRITICAL - OPTION LENGTH UNIFORMITY (students guess by length otherwise):
Follow this process for EACH question:
1. First, write the correct answer with the detail it needs
2. Count the EXACT number of words in the correct answer
3. Write each distractor with the SAME word count (+/- 1 word maximum)
4. Verify all 4 options have similar character length (within 20% of each other)

DISTRACTOR QUALITY - Make wrong answers equally specific and plausible:
- All distractors MUST be real security concepts from the SAME specific domain as the correct answer
- If correct answer mentions a specific tool/technique, distractors must mention equally specific alternatives
- Distractors should represent common misconceptions or things a less-prepared candidate might confuse
- Each distractor must be a legitimate concept that could plausibly answer the question
- Never use vague/generic distractors when the correct answer is specific
- Never use obviously wrong, joke, or unrelated answers

STRICT OPTION FORMAT:
- Target 5-10 words per option (allows for technical terms)
- ALL 4 options MUST have the same word count (within 1 word difference)
- ALL 4 options MUST have similar character length (within 20% of longest)
- Use identical grammatical structure for all options (parallel construction)
- If one option has a technical term, others should have equally technical terms
- Never use "All of the above" or "None of the above"

FORBIDDEN QUESTION TYPES - NEVER generate these:
- Questions about the syllabus structure, appendix organization, or document format
- Questions asking "What is the focus of Appendix X?" or "Which section covers Y?"
- Questions about what is "missing" from the syllabus or study material
- Questions referencing "the provided material" or "according to the study notes"
- Meta-questions about the certification exam itself rather than technical content
- Questions that could only be answered by reading the document structure, not security knowledge

Rules:
- Each question must have exactly 4 options (A, B, C, D)
- "correct" is the 0-based index of the correct answer (0-3)
- Questions must test TECHNICAL SECURITY KNOWLEDGE, not document structure
- Explanation should cite the specific security concept being tested`;

        // ENHANCED: Dynamic token budgeting instead of hard truncation
        // Calculate available chars based on token budget
        // System prompt ~800 tokens, response ~1200 tokens, leaving ~6000 tokens for context
        const availableTokens = TOKEN_CONFIG.totalLimit - TOKEN_CONFIG.systemPromptReserve - TOKEN_CONFIG.responseReserve - TOKEN_CONFIG.userQueryReserve;
        const maxChunkChars = Math.min(
            availableTokens * TOKEN_CONFIG.charsPerToken,  // Token-based limit
            TOKEN_CONFIG.maxChunkChars                      // Config-based limit (3000 chars)
        );
        
        // Use full chunk text if within budget, otherwise truncate at sentence boundary
        let chunkText = chunk.text;
        if (chunkText.length > maxChunkChars) {
            // Try to truncate at a sentence boundary for better context
            const truncateAt = chunkText.lastIndexOf('.', maxChunkChars);
            if (truncateAt > maxChunkChars * 0.7) {
                chunkText = chunkText.substring(0, truncateAt + 1);
            } else {
                chunkText = chunkText.substring(0, maxChunkChars);
            }
            console.log(`Chunk ${chunk.id} truncated from ${chunk.text.length} to ${chunkText.length} chars`);
        }

        const userPrompt = `Generate ${questionsPerChunk} MCQ questions from this CPSA study material:

Section: ${chunk.section_id} - ${chunk.section_title}
Appendix: ${chunk.appendix} - ${chunk.appendix_title}

Content:
${chunkText}

Output ONLY the JSON array.`;

        try {
            // LLMClient is required - no direct fetch fallback to ensure rate limiting
            if (typeof LLMClient === 'undefined') {
                throw new Error('LLMClient not available - ensure llm-client.js is loaded before rag.js');
            }
            
            const requestFn = priority === 'high' ? LLMClient.requestHighPriority :
                              priority === 'low' ? LLMClient.requestLowPriority :
                              LLMClient.request;
            const data = await requestFn({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 800,
                temperature: 0.7
            });

            let content = data.choices?.[0]?.message?.content?.trim() || '';

            // Parse JSON from response
            if (content.startsWith('```json')) content = content.slice(7);
            if (content.startsWith('```')) content = content.slice(3);
            if (content.endsWith('```')) content = content.slice(0, -3);
            content = content.trim();

            const questions = JSON.parse(content);

            // Separate valid and invalid questions, filtering out meta-questions
            const validQuestions = [];
            const invalidQuestions = [];
            for (const q of questions) {
                // First check if it's a meta-question (about syllabus structure, etc.)
                if (isMetaQuestion(q)) {
                    continue; // Skip meta-questions entirely
                }
                if (validateQuestion(q)) {
                    validQuestions.push(q);
                } else {
                    invalidQuestions.push(q);
                }
            }
            
            // Try to repair invalid questions (only if we have some and it's worth the API call)
            let repairedQuestions = [];
            if (invalidQuestions.length > 0 && invalidQuestions.length <= 3) {
                console.log(`Attempting to repair ${invalidQuestions.length} questions with unbalanced options`);
                repairedQuestions = await repairQuestionOptions(invalidQuestions, { priority });
            }
            
            // Combine valid and repaired questions
            const allValidQuestions = [...validQuestions, ...repairedQuestions];
            
            // Cache the valid questions
            if (allValidQuestions.length > 0 && typeof QuestionCache !== 'undefined') {
                try {
                    await QuestionCache.set(chunk.id, allValidQuestions, {
                        appendix: chunk.appendix,
                        sectionId: chunk.section_id
                    }, { questionsPerChunk });
                    console.log(`Cached ${allValidQuestions.length} questions for chunk ${chunk.id}`);
                } catch (cacheError) {
                    console.warn('Cache write error:', cacheError);
                }
            }

            // Enrich questions with source info
            return allValidQuestions.map(q => ({
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
     * Validate a question has required fields and balanced option lengths
     * Returns { valid: boolean, reason?: string } for detailed feedback
     */
    function validateQuestion(q, returnDetails = false) {
        const fail = (reason) => returnDetails ? { valid: false, reason } : false;
        const pass = () => returnDetails ? { valid: true } : true;
        
        if (!q.question || !q.options || !Array.isArray(q.options)) {
            return fail('missing_fields');
        }
        if (q.options.length !== 4) {
            return fail('wrong_option_count');
        }
        if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) {
            return fail('invalid_correct_index');
        }
        
        // Extract option texts (remove A), B), etc. prefixes)
        const optionTexts = q.options.map(opt => opt.replace(/^[A-D]\)\s*/, '').trim());
        
        // Check word count balance
        const wordCounts = optionTexts.map(text => text.split(/\s+/).length);
        const maxWords = Math.max(...wordCounts);
        const minWords = Math.min(...wordCounts);
        const correctWords = wordCounts[q.correct];
        
        // Stricter validation: max word variance of 2 words (down from 5)
        if (maxWords - minWords > 2) {
            return fail('word_count_variance');
        }
        
        // Reject if correct answer is longest by more than 1 word (down from 3)
        const otherWordCounts = wordCounts.filter((_, i) => i !== q.correct);
        const maxOtherWords = Math.max(...otherWordCounts);
        if (correctWords > maxOtherWords + 1) {
            return fail('correct_too_long_words');
        }
        
        // NEW: Check character length ratio to catch long technical terms
        const charLengths = optionTexts.map(text => text.length);
        const maxChars = Math.max(...charLengths);
        const minChars = Math.min(...charLengths);
        const correctChars = charLengths[q.correct];
        
        // Reject if character length ratio exceeds 1.5 (50% longer)
        if (minChars > 0 && maxChars / minChars > 1.5) {
            return fail('char_length_ratio');
        }
        
        // Reject if correct answer is significantly longer in characters
        const otherCharLengths = charLengths.filter((_, i) => i !== q.correct);
        const maxOtherChars = Math.max(...otherCharLengths);
        if (maxOtherChars > 0 && correctChars / maxOtherChars > 1.3) {
            return fail('correct_too_long_chars');
        }
        
        return pass();
    }

    /**
     * Repair questions with unbalanced options by calling LLM to rewrite them
     * Only rewrites the options, preserving the question and correct answer index
     * @param {Array} questions - Questions that failed validation
     * @param {Object} options - Options (priority)
     * @returns {Promise<Array>} - Repaired questions
     */
    async function repairQuestionOptions(questions, options = {}) {
        if (!questions || questions.length === 0) return [];
        
        const { priority = 'normal' } = options;
        
        // Build repair prompt
        const questionsToRepair = questions.map((q, i) => ({
            index: i,
            question: q.question,
            options: q.options,
            correct: q.correct,
            explanation: q.explanation
        }));
        
        const systemPrompt = `You are fixing quiz questions where the options have uneven lengths, making it easy to guess the answer.

Your task: Rewrite ONLY the options to have uniform length while preserving meaning and correctness.

Rules:
1. Keep the same correct answer index (0-3)
2. Keep the same meaning for each option
3. Make ALL 4 options have the SAME word count (within 1 word)
4. Make ALL 4 options have similar character length (within 20%)
5. Use parallel grammatical structure
6. Keep technical accuracy - don't oversimplify

Output ONLY valid JSON array with the repaired questions in the same format.`;

        const userPrompt = `Repair these questions by making all options uniform in length:

${JSON.stringify(questionsToRepair, null, 2)}

Output ONLY the JSON array with repaired questions. Keep the same structure, just fix the option lengths.`;

        try {
            if (typeof LLMClient === 'undefined') {
                console.warn('LLMClient not available for repair');
                return [];
            }
            
            const requestFn = priority === 'high' ? LLMClient.requestHighPriority :
                              priority === 'low' ? LLMClient.requestLowPriority :
                              LLMClient.request;
            
            const data = await requestFn({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 1500,
                temperature: 0.3  // Lower temperature for more consistent repairs
            });

            let content = data.choices?.[0]?.message?.content?.trim() || '';
            
            // Parse JSON from response
            if (content.startsWith('```json')) content = content.slice(7);
            if (content.startsWith('```')) content = content.slice(3);
            if (content.endsWith('```')) content = content.slice(0, -3);
            content = content.trim();

            const repairedQuestions = JSON.parse(content);
            
            // Validate repaired questions and merge back metadata
            const validRepaired = [];
            for (const repaired of repairedQuestions) {
                const originalIdx = repaired.index;
                if (originalIdx === undefined || originalIdx >= questions.length) continue;
                
                const original = questions[originalIdx];
                const merged = {
                    ...original,
                    question: repaired.question || original.question,
                    options: repaired.options || original.options,
                    correct: repaired.correct !== undefined ? repaired.correct : original.correct,
                    explanation: repaired.explanation || original.explanation
                };
                
                // Validate the repaired question
                if (validateQuestion(merged)) {
                    validRepaired.push(merged);
                    console.log(`Repaired question ${originalIdx}: options now balanced`);
                }
            }
            
            return validRepaired;
        } catch (error) {
            console.error('Question repair error:', error);
            return [];
        }
    }

    /**
     * Generate questions from MULTIPLE chunks in a SINGLE API call
     * This reduces API calls from 4 to 1-2 for a page of 20 questions
     * Respects 8k token limit by truncating chunk content appropriately
     * 
     * @param {Array} chunksToProcess - Array of chunks to process together
     * @param {number} totalQuestions - Total questions to generate across all chunks
     * @param {Object} options - Options (priority, skipCache)
     * @returns {Promise<Array>} - Generated questions with source info
     */
    async function generateQuestionsFromMultipleChunks(chunksToProcess, totalQuestions = 15, options = {}) {
        const { priority = 'high', skipCache = false } = options;
        
        if (!chunksToProcess || chunksToProcess.length === 0) {
            return [];
        }

        // Check cache for each chunk first - collect cached questions
        const cachedQuestions = [];
        const uncachedChunks = [];
        
        if (!skipCache && typeof QuestionCache !== 'undefined') {
            for (const chunk of chunksToProcess) {
                try {
                    const cached = await QuestionCache.get(chunk.id, { questionsPerChunk: 5 });
                    if (cached && cached.length > 0) {
                        console.log(`Cache hit for chunk ${chunk.id}: ${cached.length} questions`);
                        cachedQuestions.push(...cached.map(q => ({
                            ...q,
                            source_chunk_id: chunk.id,
                            appendix: chunk.appendix,
                            appendix_title: chunk.appendix_title,
                            section_id: chunk.section_id,
                            section_title: chunk.section_title,
                            cached: true
                        })));
                    } else {
                        uncachedChunks.push(chunk);
                    }
                } catch (cacheError) {
                    console.warn('Cache read error:', cacheError);
                    uncachedChunks.push(chunk);
                }
            }
        } else {
            uncachedChunks.push(...chunksToProcess);
        }

        // If we have enough cached questions, return them
        if (cachedQuestions.length >= totalQuestions) {
            return cachedQuestions.slice(0, totalQuestions);
        }

        // If no uncached chunks, return what we have
        if (uncachedChunks.length === 0) {
            return cachedQuestions;
        }

        // Calculate how many more questions we need
        const questionsNeeded = totalQuestions - cachedQuestions.length;
        const questionsPerChunk = Math.ceil(questionsNeeded / uncachedChunks.length);

        // ENHANCED: Dynamic token budgeting for multi-chunk context
        // Calculate available tokens for context based on config
        const availableTokens = TOKEN_CONFIG.totalLimit - TOKEN_CONFIG.systemPromptReserve - TOKEN_CONFIG.responseReserve - TOKEN_CONFIG.userQueryReserve;
        const totalAvailableChars = availableTokens * TOKEN_CONFIG.charsPerToken;
        
        // Distribute available chars across chunks, with minimum per chunk
        const minCharsPerChunk = 500;
        const maxCharsPerChunk = Math.max(
            minCharsPerChunk,
            Math.floor(totalAvailableChars / Math.max(uncachedChunks.length, 1))
        );
        
        let combinedContent = '';
        const chunkMetadata = [];
        
        for (let i = 0; i < uncachedChunks.length; i++) {
            const chunk = uncachedChunks[i];
            // Use full chunk text if within budget, otherwise truncate at sentence boundary
            let chunkText = chunk.text;
            if (chunkText.length > maxCharsPerChunk) {
                const truncateAt = chunkText.lastIndexOf('.', maxCharsPerChunk);
                if (truncateAt > maxCharsPerChunk * 0.7) {
                    chunkText = chunkText.substring(0, truncateAt + 1);
                } else {
                    chunkText = chunkText.substring(0, maxCharsPerChunk);
                }
            }
            combinedContent += `\n--- SECTION ${i + 1}: ${chunk.section_id} - ${chunk.section_title} ---\n${chunkText}\n`;
            chunkMetadata.push({
                index: i + 1,
                chunk: chunk,
                section_id: chunk.section_id
            });
        }

        const systemPrompt = `You are a CPSA (CREST Practitioner Security Analyst) exam question generator. Generate exactly ${questionsNeeded} challenging multiple-choice questions based on the provided study material sections.

Output ONLY valid JSON array with this exact structure:
[{"question":"Question text?","options":["A) Option 1","B) Option 2","C) Option 3","D) Option 4"],"correct":0,"explanation":"Brief explanation","section":1}]

QUESTION DIFFICULTY - Generate HARD exam-level questions:
- Focus on scenario-based questions: "A penetration tester discovers X. What is the MOST appropriate next step?"
- Test application of knowledge, not just recall: "Which technique would be MOST effective for..."
- Include questions about trade-offs and best practices: "What is the PRIMARY advantage of..."
- Ask about attack chains and methodology: "After gaining initial access via X, which attack would..."
- Test understanding of when/why to use specific tools or techniques
- Avoid simple definition questions like "What is X?" - instead ask "In which scenario would X be preferred over Y?"

CRITICAL - OPTION LENGTH UNIFORMITY (students guess by length otherwise):
Follow this process for EACH question:
1. First, write the correct answer with the detail it needs
2. Count the EXACT number of words in the correct answer
3. Write each distractor with the SAME word count (+/- 1 word maximum)
4. Verify all 4 options have similar character length (within 20% of each other)

DISTRACTOR QUALITY - Make wrong answers equally specific and plausible:
- All distractors MUST be real security concepts from the SAME specific domain as the correct answer
- If correct answer mentions a specific tool/technique, distractors must mention equally specific alternatives
- Distractors should represent common misconceptions or things a less-prepared candidate might confuse
- Each distractor must be a legitimate concept that could plausibly answer the question
- Never use vague/generic distractors when the correct answer is specific
- Never use obviously wrong, joke, or unrelated answers

STRICT OPTION FORMAT:
- Target 5-10 words per option (allows for technical terms)
- ALL 4 options MUST have the same word count (within 1 word difference)
- ALL 4 options MUST have similar character length (within 20% of longest)
- Use identical grammatical structure for all options (parallel construction)
- If one option has a technical term, others should have equally technical terms
- Never use "All of the above" or "None of the above"

FORBIDDEN QUESTION TYPES - NEVER generate these:
- Questions about the syllabus structure, appendix organization, or document format
- Questions asking "What is the focus of Appendix X?" or "Which section covers Y?"
- Questions about what is "missing" from the syllabus or study material
- Questions referencing "the provided material" or "according to the study notes"
- Meta-questions about the certification exam itself rather than technical content
- Questions that could only be answered by reading the document structure, not security knowledge

Rules:
- Each question must have exactly 4 options (A, B, C, D)
- "correct" is the 0-based index of the correct answer (0-3)
- "section" is the section number (1, 2, 3, etc.) the question is based on
- Distribute questions evenly across all sections
- Questions must test TECHNICAL SECURITY KNOWLEDGE, not document structure`;

        const userPrompt = `Generate ${questionsNeeded} MCQ questions from these CPSA study material sections:
${combinedContent}

Output ONLY the JSON array with ${questionsNeeded} questions distributed across all sections.`;

        try {
            // LLMClient is required - no direct fetch fallback to ensure rate limiting
            if (typeof LLMClient === 'undefined') {
                throw new Error('LLMClient not available - ensure llm-client.js is loaded before rag.js');
            }
            
            const requestFn = priority === 'high' ? LLMClient.requestHighPriority :
                              priority === 'low' ? LLMClient.requestLowPriority :
                              LLMClient.request;
            const data = await requestFn({
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 1500,
                temperature: 0.7
            });

            let content = data.choices?.[0]?.message?.content?.trim() || '';

            // Parse JSON from response
            if (content.startsWith('```json')) content = content.slice(7);
            if (content.startsWith('```')) content = content.slice(3);
            if (content.endsWith('```')) content = content.slice(0, -3);
            content = content.trim();

            const questions = JSON.parse(content);
            
            // Separate valid and invalid questions, filtering out meta-questions
            const validQuestions = [];
            const invalidQuestions = [];
            for (const q of questions) {
                // First check if it's a meta-question (about syllabus structure, etc.)
                if (isMetaQuestion(q)) {
                    continue; // Skip meta-questions entirely
                }
                if (validateQuestion(q)) {
                    validQuestions.push(q);
                } else {
                    invalidQuestions.push(q);
                }
            }
            
            // Try to repair invalid questions (only if we have some and it's worth the API call)
            let repairedQuestions = [];
            if (invalidQuestions.length > 0 && invalidQuestions.length <= 5) {
                console.log(`Attempting to repair ${invalidQuestions.length} questions with unbalanced options`);
                repairedQuestions = await repairQuestionOptions(invalidQuestions, { priority });
            }
            
            // Combine valid and repaired questions
            const allValidQuestions = [...validQuestions, ...repairedQuestions];

            // Enrich questions with source info based on section number
            const enrichedQuestions = allValidQuestions.map(q => {
                const sectionNum = q.section || 1;
                const metadata = chunkMetadata[Math.min(sectionNum - 1, chunkMetadata.length - 1)] || chunkMetadata[0];
                const chunk = metadata.chunk;
                
                return {
                    ...q,
                    source_chunk_id: chunk.id,
                    appendix: chunk.appendix,
                    appendix_title: chunk.appendix_title,
                    section_id: chunk.section_id,
                    section_title: chunk.section_title
                };
            });

            // Cache questions grouped by chunk
            if (enrichedQuestions.length > 0 && typeof QuestionCache !== 'undefined') {
                // Group questions by source chunk for caching
                const questionsByChunk = {};
                for (const q of enrichedQuestions) {
                    if (!questionsByChunk[q.source_chunk_id]) {
                        questionsByChunk[q.source_chunk_id] = [];
                    }
                    questionsByChunk[q.source_chunk_id].push(q);
                }
                
                // Cache each group
                for (const [chunkId, chunkQuestions] of Object.entries(questionsByChunk)) {
                    const chunk = uncachedChunks.find(c => c.id === chunkId);
                    if (chunk) {
                        try {
                            await QuestionCache.set(chunkId, chunkQuestions, {
                                appendix: chunk.appendix,
                                sectionId: chunk.section_id
                            }, { questionsPerChunk: 5 });
                            console.log(`Cached ${chunkQuestions.length} questions for chunk ${chunkId}`);
                        } catch (cacheError) {
                            console.warn('Cache write error:', cacheError);
                        }
                    }
                }
            }

            // Share questions via P2P for other students to use
            if (enrichedQuestions.length > 0 && typeof P2PSync !== 'undefined' && P2PSync.isAvailable()) {
                const appendix = enrichedQuestions[0]?.appendix;
                if (appendix) {
                    P2PSync.shareQuestions(enrichedQuestions, appendix);
                }
            }

            // Combine cached and newly generated questions
            return [...cachedQuestions, ...enrichedQuestions];
        } catch (error) {
            console.error('Multi-chunk question generation error:', error);
            // Return cached questions if we have any
            return cachedQuestions;
        }
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

    // Concurrency configuration - reduced to work with LLMClient queue
    // LLMClient handles actual concurrency, this just controls how many we queue at once
    const BATCH_SIZE = 2; // Process 2 chunks at a time (LLMClient will serialize them)

    /**
     * Process a single chunk and return questions with metadata
     * @param {Object} chunk - The chunk to process
     * @param {number} questionsPerChunk - Number of questions to generate
     * @param {Object} options - Options to pass to generateQuestionsFromChunk
     * @returns {Promise<Array>} - Generated questions
     */
    async function processChunkForQuestions(chunk, questionsPerChunk, options = {}) {
        try {
            return await generateQuestionsFromChunk(chunk, questionsPerChunk, options);
        } catch (error) {
            console.error(`Error processing chunk ${chunk.section_id}:`, error);
            return [];
        }
    }

    /**
     * Generate a batch of questions for pagination
     * Uses cache-first approach: loads cached questions first, then generates missing ones
     * @param {string} appendixLetter - The appendix letter
     * @param {number} startChunkIdx - Starting chunk index
     * @param {number} targetCount - Target number of questions to generate (default 20)
     * @param {Set} existingHashes - Set of existing question hashes to avoid duplicates
     * @param {function} onProgress - Progress callback
     * @param {Object} options - Options (priority: 'high'|'low'|'normal', isBackground: boolean)
     * @returns {Promise<{questions: Array, nextChunkIdx: number, newHashes: Array, exhausted: boolean}>}
     */
    async function generateQuestionsBatch(appendixLetter, startChunkIdx = 0, targetCount = 20, existingHashes = new Set(), onProgress = null, options = {}) {
        if (!isInitialized) {
            await initialize();
        }

        const { priority = 'normal', isBackground = false } = options;
        const appendixChunks = getChunksForAppendix(appendixLetter);
        if (appendixChunks.length === 0) {
            return { questions: [], nextChunkIdx: 0, newHashes: [], exhausted: true };
        }

        const questions = [];
        const newHashes = [];
        let currentChunkIdx = startChunkIdx;
        const questionsPerChunk = 5; // Generate 5 questions per chunk for better yield
        
        // Track cache hits for progress reporting
        let cacheHits = 0;
        let apiCalls = 0;

        // Process chunks one at a time (LLMClient handles rate limiting)
        while (questions.length < targetCount && currentChunkIdx < appendixChunks.length) {
            const chunk = appendixChunks[currentChunkIdx];
            
            if (onProgress) {
                onProgress({
                    currentChunk: currentChunkIdx + 1,
                    totalChunks: appendixChunks.length,
                    section: chunk.section_id,
                    questionsGenerated: questions.length,
                    targetCount: targetCount,
                    cacheHits,
                    apiCalls,
                    status: 'processing'
                });
            }

            // Generate questions for this chunk (cache-first via generateQuestionsFromChunk)
            const generatedQuestions = await processChunkForQuestions(chunk, questionsPerChunk, { priority });
            
            // Track if this was a cache hit
            if (generatedQuestions.length > 0 && generatedQuestions[0].cached) {
                cacheHits++;
            } else if (generatedQuestions.length > 0) {
                apiCalls++;
            }
            
            // Collect questions, deduplicating by hash
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

            currentChunkIdx++;

            // For background tasks, check if we should yield to foreground
            if (isBackground && typeof LLMClient !== 'undefined') {
                const status = LLMClient.getStatus();
                // If there are high-priority requests waiting, pause background work
                if (status.queueLength > 0) {
                    console.log('Background task yielding to foreground requests');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        if (onProgress) {
            onProgress({
                currentChunk: currentChunkIdx,
                totalChunks: appendixChunks.length,
                questionsGenerated: questions.length,
                targetCount: targetCount,
                cacheHits,
                apiCalls,
                status: 'complete'
            });
        }

        return {
            questions,
            nextChunkIdx: currentChunkIdx,
            newHashes,
            exhausted: currentChunkIdx >= appendixChunks.length,
            stats: { cacheHits, apiCalls }
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

    /**
     * STREAMING RAG: Generate questions progressively with callback for each question
     * This is TRUE RAG - retrieves chunks, generates questions, streams them to UI immediately
     * @param {string} appendixLetter - The appendix letter
     * @param {Object} options - Configuration options
     * @param {number} options.targetCount - Target number of questions (default 20)
     * @param {number} options.startChunkIdx - Starting chunk index (default 0)
     * @param {Set} options.existingHashes - Set of existing question hashes to avoid duplicates
     * @param {function} options.onQuestion - Callback fired for EACH question as it's generated (key for fast UX!)
     * @param {function} options.onProgress - Progress callback
     * @param {function} options.onComplete - Called when generation is complete
     * @param {function} options.onError - Called on errors
     * @returns {Promise<{questions: Array, nextChunkIdx: number, exhausted: boolean}>}
     */
    async function generateQuestionsStreaming(appendixLetter, options = {}) {
        const {
            targetCount = 20,
            startChunkIdx = 0,
            existingHashes = new Set(),
            onQuestion = null,      // Called for EACH question - this is the key!
            onProgress = null,
            onComplete = null,
            onError = null,
            priority = 'high',
            useBatching = true      // Use batched generation for fewer API calls
        } = options;

        if (!isInitialized) {
            await initialize();
        }

        const appendixChunks = getChunksForAppendix(appendixLetter);
        if (appendixChunks.length === 0) {
            if (onComplete) onComplete({ questions: [], exhausted: true });
            return { questions: [], nextChunkIdx: 0, exhausted: true };
        }

        const questions = [];
        const newHashes = new Set();
        let currentChunkIdx = startChunkIdx;
        let cacheHits = 0;
        let apiCalls = 0;
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;
        
        // BATCHED GENERATION: Process 3-4 chunks at once to reduce API calls
        // This cuts API calls from 4 to 1-2 for a page of 20 questions
        const CHUNKS_PER_BATCH = 3;  // Process 3 chunks per API call (fits in 8k tokens)
        const QUESTIONS_PER_BATCH = 15; // Generate ~15 questions per batch

        while (questions.length < targetCount && currentChunkIdx < appendixChunks.length) {
            // Get the next batch of chunks
            const batchEndIdx = Math.min(currentChunkIdx + CHUNKS_PER_BATCH, appendixChunks.length);
            const chunksToProcess = appendixChunks.slice(currentChunkIdx, batchEndIdx);
            
            if (onProgress) {
                onProgress({
                    currentChunk: currentChunkIdx + 1,
                    totalChunks: appendixChunks.length,
                    section: chunksToProcess[0]?.section_id,
                    questionsGenerated: questions.length,
                    targetCount,
                    cacheHits,
                    apiCalls,
                    status: 'generating',
                    batchSize: chunksToProcess.length
                });
            }

            try {
                // Generate questions from multiple chunks in ONE API call
                const questionsNeeded = Math.min(QUESTIONS_PER_BATCH, targetCount - questions.length);
                const generatedQuestions = useBatching 
                    ? await generateQuestionsFromMultipleChunks(chunksToProcess, questionsNeeded, { priority })
                    : await processChunkForQuestions(chunksToProcess[0], 5, { priority });
                
                if (generatedQuestions.length === 0) {
                    consecutiveFailures++;
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        console.warn('Too many consecutive failures, stopping generation');
                        if (onError) onError({ type: 'consecutive_failures', count: consecutiveFailures });
                        break;
                    }
                } else {
                    consecutiveFailures = 0;
                    apiCalls++;
                }

                // Track cache hits
                const cachedCount = generatedQuestions.filter(q => q.cached).length;
                if (cachedCount > 0) cacheHits++;

                // Stream each question to the UI immediately!
                for (const q of generatedQuestions) {
                    const hash = hashQuestion(q.question);
                    if (!existingHashes.has(hash) && !newHashes.has(hash)) {
                        questions.push(q);
                        newHashes.add(hash);
                        existingHashes.add(hash);

                        // Call onQuestion for each question immediately
                        if (onQuestion) {
                            onQuestion(q, questions.length, targetCount);
                        }

                        if (questions.length >= targetCount) {
                            break;
                        }
                    }
                }
            } catch (error) {
                console.error(`Error generating questions for batch starting at chunk ${currentChunkIdx}:`, error);
                consecutiveFailures++;
                if (onError) onError({ type: 'batch_error', startChunk: currentChunkIdx, error });
                
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    break;
                }
            }

            // Move to next batch of chunks
            currentChunkIdx = batchEndIdx;
        }

        const result = {
            questions,
            nextChunkIdx: currentChunkIdx,
            newHashes: Array.from(newHashes),
            exhausted: currentChunkIdx >= appendixChunks.length,
            stats: { cacheHits, apiCalls, consecutiveFailures }
        };

        if (onProgress) {
            onProgress({
                currentChunk: currentChunkIdx,
                totalChunks: appendixChunks.length,
                questionsGenerated: questions.length,
                targetCount,
                cacheHits,
                apiCalls,
                status: 'complete'
            });
        }

        if (onComplete) {
            onComplete(result);
        }

        return result;
    }

    // Public API
    return {
        initialize,
        search,
        searchWithFilter,
        searchWithScores,       // Returns chunks with BM25 scores for conditional RAG
        getChunkById,           // Get specific chunk by ID for explain buttons
        isCPSAQuery,            // Check if query is CPSA-specific
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
        generateQuestionsFromMultipleChunks,  // Batched generation for fewer API calls
        generateQuestionsBatch,
        getAppendixChunkCount,
        hashQuestion,
        clearQuestionsCache,
        // Streaming RAG - shows questions immediately as they're generated
        generateQuestionsStreaming
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
