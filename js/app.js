    let score = 0; // Initialize the score
    let totalQuestions = 0; // Will be updated dynamically as questions are generated
    const chatHistory = []; // Chatbot conversation
    let chatGreeted = false; // Only show the welcome bubble once per load
    const CHAT_MAX_LENGTH = 400;
    const MAX_CHAT_TURNS = 12;
    
    // HTML escape helper to prevent XSS when inserting untrusted content
    function escapeHtml(str) {
        if (typeof str !== 'string') return str;
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
    const blockedPhrases = [
        /ignore (all )?previous/i,
        /forget (all )?prior/i,
        /you are now my/i,
        /pretend to be/i,
        /system prompt/i,
        /developer mode/i,
        /bypass/i,
        /jailbreak/i,
        /<script/i
    ];
    const answerState = {}; // Tracks last selected answers per question
    const flaggedQuestions = new Set(); // Track flagged questions
    let searchDebounceTimer = null; // For debouncing search input
    
    // ==================== PROGRESS PERSISTENCE ====================
    const STORAGE_KEY = 'cpsa_quiz_progress';
    const STREAK_KEY = 'cpsa_quiz_streak';
    const BADGES_KEY = 'cpsa_quiz_badges';
    const STUDY_TIME_KEY = 'cpsa_study_time';
    let sessionStartTime = Date.now();
    
    // Load saved progress from localStorage
    function loadProgress() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const data = JSON.parse(saved);
                score = data.score || 0;
                Object.assign(answerState, data.answerState || {});
                data.flagged?.forEach(id => flaggedQuestions.add(id));
                return data;
            }
        } catch (e) {
            console.error('Error loading progress:', e);
        }
        return null;
    }
    
    // Save progress to localStorage
    function saveProgress() {
        try {
            const data = {
                score,
                answerState,
                flagged: Array.from(flaggedQuestions),
                lastUpdated: Date.now()
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.error('Error saving progress:', e);
        }
    }
    
    // ==================== STUDY TIME TRACKING ====================
    function getStudyTime() {
        try {
            return parseInt(localStorage.getItem(STUDY_TIME_KEY) || '0');
        } catch (e) {
            return 0;
        }
    }
    
    function saveStudyTime() {
        try {
            const currentSession = Math.floor((Date.now() - sessionStartTime) / 1000);
            const totalTime = getStudyTime() + currentSession;
            localStorage.setItem(STUDY_TIME_KEY, totalTime.toString());
            sessionStartTime = Date.now();
        } catch (e) {
            console.error('Error saving study time:', e);
        }
    }
    
    // Save study time periodically and on page unload
    setInterval(saveStudyTime, 60000);
    window.addEventListener('beforeunload', saveStudyTime);
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveStudyTime();
    });
    
    // ==================== STREAK TRACKING ====================
    function loadStreak() {
        try {
            const saved = localStorage.getItem(STREAK_KEY);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.error('Error loading streak:', e);
        }
        return { count: 0, lastDate: null, history: [] };
    }
    
    function updateStreak() {
        const streak = loadStreak();
        const today = new Date().toDateString();
        
        if (streak.lastDate === today) {
            // Already practiced today
            return streak;
        }
        
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        
        if (streak.lastDate === yesterday.toDateString()) {
            // Continuing streak
            streak.count++;
        } else if (streak.lastDate !== today) {
            // Streak broken, start fresh
            streak.count = 1;
        }
        
        streak.lastDate = today;
        streak.history = streak.history || [];
        if (!streak.history.includes(today)) {
            streak.history.push(today);
            // Keep only last 7 days
            if (streak.history.length > 7) {
                streak.history = streak.history.slice(-7);
            }
        }
        
        try {
            localStorage.setItem(STREAK_KEY, JSON.stringify(streak));
        } catch (e) {
            console.error('Error saving streak:', e);
        }
        
        return streak;
    }
    
    function renderStreak() {
        const streak = loadStreak();
        const streakCount = document.getElementById('streak-count');
        const streakIndicator = document.getElementById('streak-indicator');
        
        if (streakCount) {
            streakCount.textContent = streak.count;
        }
        
        if (streakIndicator) {
            // Show last 7 days as dots
            streakIndicator.innerHTML = '';
            const today = new Date();
            for (let i = 6; i >= 0; i--) {
                const date = new Date(today);
                date.setDate(date.getDate() - i);
                const dateStr = date.toDateString();
                const dot = document.createElement('span');
                dot.className = 'streak-dot' + (streak.history?.includes(dateStr) ? ' active' : '');
                dot.title = date.toLocaleDateString('en-US', { weekday: 'short' });
                streakIndicator.appendChild(dot);
            }
        }
    }
    
    // ==================== BADGE SYSTEM ====================
    // Note: Badge icons use emojis as they're displayed in toast notifications where emojis are appropriate
    const BADGE_DEFINITIONS = [
        { id: 'first_answer', name: 'First Steps', desc: 'Answer your first question', icon: '[*]', check: (stats) => stats.attempted >= 1 },
        { id: 'ten_correct', name: 'Getting Started', desc: 'Get 10 questions correct', icon: '[+]', check: (stats) => stats.correct >= 10 },
        { id: 'fifty_correct', name: 'Knowledge Seeker', desc: 'Get 50 questions correct', icon: '[?]', check: (stats) => stats.correct >= 50 },
        { id: 'hundred_correct', name: 'Century Club', desc: 'Get 100 questions correct', icon: '[!]', check: (stats) => stats.correct >= 100 },
        { id: 'all_categories', name: 'Well Rounded', desc: 'Answer questions in all categories', icon: '[@]', check: (stats) => stats.categoriesAttempted >= 12 },
        { id: 'perfect_category', name: 'Category Master', desc: 'Get 100% in any category', icon: '[#]', check: (stats) => stats.perfectCategories >= 1 },
        { id: 'streak_3', name: 'Consistent', desc: 'Maintain a 3-day streak', icon: '[^]', check: (stats) => stats.streak >= 3 },
        { id: 'streak_7', name: 'Dedicated', desc: 'Maintain a 7-day streak', icon: '[&]', check: (stats) => stats.streak >= 7 },
        { id: 'accuracy_80', name: 'Sharp Mind', desc: 'Achieve 80% overall accuracy', icon: '[%]', check: (stats) => stats.accuracy >= 80 && stats.attempted >= 50 },
        { id: 'half_complete', name: 'Halfway There', desc: 'Answer 400+ questions', icon: '[>]', check: (stats) => stats.attempted >= 400 },
        { id: 'completionist', name: 'Completionist', desc: 'Answer all 803 questions', icon: '[$]', check: (stats) => stats.attempted >= 803 }
    ];
    
    function loadBadges() {
        try {
            const saved = localStorage.getItem(BADGES_KEY);
            return saved ? JSON.parse(saved) : [];
        } catch (e) {
            return [];
        }
    }
    
    function saveBadges(badges) {
        try {
            localStorage.setItem(BADGES_KEY, JSON.stringify(badges));
        } catch (e) {
            console.error('Error saving badges:', e);
        }
    }
    
    function checkAndAwardBadges() {
        const earnedBadges = loadBadges();
        const stats = calculateStats();
        const streak = loadStreak();
        stats.streak = streak.count;
        
        let newBadges = [];
        
        BADGE_DEFINITIONS.forEach(badge => {
            if (!earnedBadges.includes(badge.id) && badge.check(stats)) {
                earnedBadges.push(badge.id);
                newBadges.push(badge);
            }
        });
        
        if (newBadges.length > 0) {
            saveBadges(earnedBadges);
            newBadges.forEach(badge => {
                showToast(`Badge earned: ${badge.icon} ${badge.name}!`);
            });
        }
        
        return earnedBadges;
    }
    
    function calculateStats() {
        const attempted = Object.keys(answerState).length;
        const correct = Object.values(answerState).filter(a => a.correct).length;
        const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
        
        // Calculate category stats
        const categoryStats = {};
        Object.entries(answerState).forEach(([qId, state]) => {
            const question = quizData[qId];
            if (question) {
                const category = categorizeQuestion(question);
                if (!categoryStats[category]) {
                    categoryStats[category] = { attempted: 0, correct: 0 };
                }
                categoryStats[category].attempted++;
                if (state.correct) {
                    categoryStats[category].correct++;
                }
            }
        });
        
        const categoriesAttempted = Object.keys(categoryStats).length;
        const perfectCategories = Object.values(categoryStats).filter(
            cat => cat.attempted >= 5 && cat.correct === cat.attempted
        ).length;
        
        return { attempted, correct, accuracy, categoriesAttempted, perfectCategories, categoryStats };
    }
    
    // ==================== TOAST NOTIFICATIONS ====================
    function showToast(message, duration = 3000) {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        container.appendChild(toast);
        
        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
    
    // ==================== BACK TO TOP ====================
    function setupBackToTop() {
        const btn = document.getElementById('back-to-top');
        if (!btn) return;
        
        window.addEventListener('scroll', () => {
            if (window.scrollY > 400) {
                btn.classList.add('show');
            } else {
                btn.classList.remove('show');
            }
        }, { passive: true });
        
        btn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }
    
    // ==================== OFFLINE DETECTION ====================
    function setupOfflineDetection() {
        const indicator = document.getElementById('offline-indicator');
        if (!indicator) return;
        
        function updateOnlineStatus() {
            if (navigator.onLine) {
                indicator.classList.remove('show');
            } else {
                indicator.classList.add('show');
            }
        }
        
        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        updateOnlineStatus();
    }
    
    // ==================== SERVICE WORKER REGISTRATION ====================
    function registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/CREST/sw.js')
                .then(reg => console.log('Service Worker registered:', reg.scope))
                .catch(err => console.log('Service Worker registration failed:', err));
        }
    }
    
    // ==================== FILTER FUNCTIONALITY ====================
    function setupFilters() {
        const filterSelect = document.getElementById('filter-select');
        if (!filterSelect) return;
        
        filterSelect.addEventListener('change', () => {
            applyFilters();
        });
    }
    
    function applyFilters() {
        const filterSelect = document.getElementById('filter-select');
        const searchInput = document.getElementById('search-input');
        const filterValue = filterSelect?.value || 'all';
        const searchQuery = searchInput?.value?.toLowerCase() || '';
        
        document.querySelectorAll('.question-container').forEach(container => {
            const qId = container.dataset.questionId;
            const state = answerState[qId];
            const isFlagged = flaggedQuestions.has(qId);
            const questionText = container.querySelector('h3')?.textContent?.toLowerCase() || '';
            
            let showByFilter = true;
            switch (filterValue) {
                case 'unanswered':
                    showByFilter = !state;
                    break;
                case 'correct':
                    showByFilter = state?.correct === true;
                    break;
                case 'incorrect':
                    showByFilter = state?.correct === false;
                    break;
                case 'flagged':
                    showByFilter = isFlagged;
                    break;
                default:
                    showByFilter = true;
            }
            
            const showBySearch = !searchQuery || questionText.includes(searchQuery);
            container.style.display = (showByFilter && showBySearch) ? '' : 'none';
        });
        
        // Update category visibility
        document.querySelectorAll('.category-section').forEach(section => {
            const visibleQuestions = section.querySelectorAll('.question-container:not([style*="display: none"])');
            section.style.display = visibleQuestions.length > 0 ? '' : 'none';
        });
        
        updateCounts();
    }
    
    // ==================== DEBOUNCED SEARCH ====================
    function setupDebouncedSearch() {
        const searchInput = document.getElementById('search-input');
        if (!searchInput) return;
        
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                applyFilters();
            }, 300);
        });
    }
    
    
    // Update progress grid in the Progress panel (tab)
    function updateProgressGridPanel() {
        const grid = document.getElementById('progress-grid-panel');
        if (!grid) return;
        
        const stats = calculateStats();
        const categorizedQuestions = {};
        
        // Group questions by category
        Object.entries(quizData).forEach(([id, q]) => {
            const category = categorizeQuestion(q);
            if (!categorizedQuestions[category]) {
                categorizedQuestions[category] = [];
            }
            categorizedQuestions[category].push(id);
        });
        
        grid.innerHTML = '';
        
        Object.entries(categorizedQuestions).forEach(([category, questions]) => {
            const catStats = stats.categoryStats[category] || { attempted: 0, correct: 0 };
            const total = questions.length;
            const percentage = total > 0 ? Math.round((catStats.correct / total) * 100) : 0;
            
            const item = document.createElement('div');
            item.className = 'progress-item';
            item.innerHTML = `
                <div class="progress-item-header">
                    <span class="progress-item-name" title="${category}">${category}</span>
                    <div class="progress-item-actions">
                        <span class="progress-item-stats">${catStats.correct}/${total}</span>
                        <button class="category-reset-btn" data-category="${category}" title="Reset ${category} progress">Reset</button>
                    </div>
                </div>
                <div class="progress-item-bar">
                    <div class="progress-item-fill" style="width: ${percentage}%"></div>
                </div>
            `;
            
            // Add click handler for reset button
            const resetBtn = item.querySelector('.category-reset-btn');
            if (resetBtn) {
                resetBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const cat = e.target.dataset.category;
                    // resetCategoryProgress already has confirmation dialog
                    resetCategoryProgress(cat);
                    updateProgressGridPanel();
                });
            }
            
            grid.appendChild(item);
        });
    }
    
    // ==================== FLAG FOR REVIEW ====================
    function toggleFlag(questionId) {
        if (flaggedQuestions.has(questionId)) {
            flaggedQuestions.delete(questionId);
        } else {
            flaggedQuestions.add(questionId);
        }
        saveProgress();
        
        // Update UI
        const container = document.querySelector(`.question-container[data-question-id="${questionId}"]`);
        if (container) {
            container.classList.toggle('flagged', flaggedQuestions.has(questionId));
            const flagBtn = container.querySelector('.flag-button');
            if (flagBtn) {
                flagBtn.classList.toggle('flagged', flaggedQuestions.has(questionId));
                flagBtn.textContent = flaggedQuestions.has(questionId) ? '[!] Flagged' : '[_] Flag';
            }
        }
    }
    
    // ==================== SHARE PROGRESS ====================
    function generateShareText() {
        const stats = calculateStats();
        const streak = loadStreak();
        const badges = loadBadges();
        
        return `CPSA Quiz Progress
- Score: ${stats.correct}/${stats.attempted} (${stats.accuracy}% accuracy)
- Streak: ${streak.count} days
- Badges: ${badges.length}/${BADGE_DEFINITIONS.length}

Practice at: https://sudosuraj.github.io/CREST/`;
    }
    
    function shareProgress() {
        const text = generateShareText();
        
        if (navigator.share) {
            navigator.share({
                title: 'My CPSA Quiz Progress',
                text: text,
                url: 'https://sudosuraj.github.io/CREST/'
            }).catch(() => {
                copyToClipboard(text);
            });
        } else {
            copyToClipboard(text);
        }
    }
    
    function copyToClipboard(text) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('Progress copied to clipboard!');
        }).catch(() => {
            showToast('Could not copy to clipboard');
        });
    }
    
    // ==================== RESET PROGRESS ====================
    function resetProgress() {
        if (!confirm('Are you sure you want to reset all progress? This cannot be undone.')) {
            return;
        }
        
        // Clear state
        score = 0;
        Object.keys(answerState).forEach(key => delete answerState[key]);
        flaggedQuestions.clear();
        
        // Clear localStorage
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STREAK_KEY);
        localStorage.removeItem(BADGES_KEY);
        
        // Reload page to reset UI
        location.reload();
    }
    
    // Reset progress for a specific category
    function resetCategoryProgress(categoryName) {
        if (!confirm(`Reset progress for "${categoryName}"? This will clear your answers and flags for this category.`)) {
            return;
        }
        
        const categorizedQuestions = {};
        Object.keys(quizData).forEach(key => {
            const questionObj = quizData[key];
            const category = categorizeQuestion(questionObj);
            if (!categorizedQuestions[category]) {
                categorizedQuestions[category] = [];
            }
            categorizedQuestions[category].push({ key, questionObj });
        });
        
        const questions = categorizedQuestions[categoryName];
        if (!questions) return;
        
        let resetCount = 0;
        
        questions.forEach(({ key }) => {
            // Check if this question was answered
            if (answerState[key]) {
                // Subtract from score if it was correct
                if (answerState[key].correct) {
                    score--;
                }
                delete answerState[key];
                resetCount++;
            }
            
            // Clear flags
            flaggedQuestions.delete(key);
            
            // Reset DOM for this question
            const container = document.querySelector(`.question-container[data-question-id="${key}"]`);
            if (!container) return;
            
            // Remove status classes
            container.classList.remove("flagged", "answered-correct", "answered-incorrect");
            
            // Reset flag button
            const flagBtn = container.querySelector(".flag-button");
            if (flagBtn) {
                flagBtn.classList.remove("flagged");
                flagBtn.textContent = "[_] Flag";
            }
            
            // Reset options
            container.querySelectorAll(".option").forEach(optionDiv => {
                optionDiv.classList.remove("correct", "incorrect");
                const input = optionDiv.querySelector("input[type=radio]");
                if (input) {
                    input.checked = false;
                    input.disabled = false;
                }
            });
            
            // Reset explanation panels
            const answerExplanation = container.querySelector(".answer-explanation");
            if (answerExplanation) {
                answerExplanation.classList.remove("show", "loading", "correct-explanation", "incorrect-explanation");
                answerExplanation.textContent = "";
            }
            
            // Reset explain answer button
            const explainBtn = container.querySelector(".ai-button[id^='explain-answer-btn-']");
            if (explainBtn) {
                explainBtn.disabled = true;
                explainBtn.textContent = "[AI] Explain Answer";
            }
        });
        
        // Update score display
        const scoreElement = document.getElementById("score");
        const percentageElement = document.getElementById("percentage");
        const accuracyBar = document.getElementById("accuracy-bar");
        
        if (scoreElement) {
            scoreElement.textContent = score;
        }
        
        // Update percentage
        const percentage = totalQuestions > 0 ? ((score / totalQuestions) * 100).toFixed(2) : 0;
        if (percentageElement) {
            percentageElement.textContent = percentage;
        }
        if (accuracyBar) {
            accuracyBar.style.width = `${Math.min(parseFloat(percentage), 100)}%`;
        }
        
        // Update attempted count
        const attemptedEl = document.getElementById('attempted-count');
        if (attemptedEl) {
            attemptedEl.textContent = Object.keys(answerState).length;
        }
        
        // Save progress and update UI
        saveProgress();
        updateReviewStats();
        
        showToast(`Reset ${resetCount} question${resetCount === 1 ? '' : 's'} in "${categoryName}"`);
    }
    
    // ==================== UPDATE COUNTS ====================
    function updateCounts() {
        const visibleCategories = document.querySelectorAll('.category-section:not([style*="display: none"])').length;
        const visibleQuestions = document.querySelectorAll('.question-container:not([style*="display: none"])').length;
        
        const categoryChip = document.getElementById('category-count-chip');
        const questionChip = document.getElementById('question-count-chip');
        
        if (categoryChip) categoryChip.textContent = `Categories: ${visibleCategories}`;
        if (questionChip) questionChip.textContent = `Questions: ${visibleQuestions}`;
    }

    const sanitizeUserMessage = (input) => (input || "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const isUnsafeMessage = (text) => blockedPhrases.some((pattern) => pattern.test(text));

    // Function to shuffle options randomly
    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    // Heuristic topic categorization for quick revision
    function categorizeQuestion(questionObj) {
        const text = questionObj.question.toLowerCase();

        const categories = [
            { name: "Cryptography & Hashing", keywords: ["hash", "cipher", "encryption", "rsa", "aes", "des", "3des", "diffie", "ssl", "tls", "certificate", "pki", "mac ", "hmac", "salt", "digest"] },
            { name: "Network Protocols & Ports", keywords: ["port", "udp", "tcp", "icmp", "arp", "ethernet", "ipsec", "ike", "isakmp", "ikev", "protocol", "packet", "ipv4", "ipv6", "osi", "layer", "icmp", "mpls", "bgp", "ospf", "rip", "eigrp"] },
            { name: "VPN & Remote Access", keywords: ["vpn", "pptp", "l2tp", "ipsec", "tunnel", "remote access", "site to site", "client", "ike", "psk"] },
            { name: "Windows Security", keywords: ["windows", "nt", "2000", "2003", "registry", "restrictanonymous", "sam", "sddl", "lsass", "active directory"] },
            { name: "Unix/Linux Security", keywords: ["solaris", "linux", "unix", "/etc", "shadow", "passwd", "umask", "rhosts", "cron", "pam"] },
            { name: "Authentication & Access Control", keywords: ["authentication", "password", "kerberos", "radius", "tacacs", "challenge", "token", "authorization", "access control", "aaa"] },
            { name: "Web & Application Security", keywords: ["xss", "sql", "csrf", "cookie", "session", "web", "browser", "http", "https", "cgi", "iis", "apache", "web server", "header", "input", "script"] },
            { name: "Malware & Threats", keywords: ["virus", "worm", "trojan", "malware", "rootkit", "botnet", "exploit", "payload", "shellcode"] },
            { name: "Risk, Audit & Governance", keywords: ["risk", "audit", "policy", "standard", "compliance", "treatment", "assessment", "control", "mitigation"] },
            { name: "Firewalls & IDS/IPS", keywords: ["firewall", "ids", "ips", "snort", "packet filter", "nat", "pat", "stateful", "proxy"] },
            { name: "Wireless & Mobility", keywords: ["wifi", "wireless", "wep", "wpa", "wpa2", "802.1x", "bluetooth"] }
        ];

        for (const category of categories) {
            if (category.keywords.some(keyword => text.includes(keyword))) {
                return category.name;
            }
        }
        return "General / Other";
    }

    // Function to call LLM API (no key required)
    async function callOpenAI(prompt, options = {}) {
        const { useRAG = false, ragQuery = null, topK = 5 } = options;
        
        try {
            let systemContent = 'You are a CPSA tutor. Be concise. Plain text only, no markdown. Created by Suraj Sharma (sudosuraj).';
            let userContent = prompt;
            let sources = [];
            
            // If RAG is enabled and available, retrieve relevant context
            if (useRAG && typeof RAG !== 'undefined' && RAG.isReady()) {
                const query = ragQuery || prompt;
                const retrievedChunks = RAG.search(query, topK);
                
                if (retrievedChunks.length > 0) {
                    // Use token-budgeted context formatting
                    const context = RAG.formatContext(retrievedChunks, { maxTokens: 2500 });
                    sources = RAG.formatSources(retrievedChunks);
                    
                    systemContent = `CPSA tutor with study notes. Cite sources when relevant. Plain text only.`;
                    userContent = `Reference material:\n${context}\n\nQuestion: ${prompt}`;
                }
            }
            
            // Use LLMClient if available for rate limiting, otherwise fall back to direct fetch
            let data;
            if (typeof LLMClient !== 'undefined') {
                data = await LLMClient.requestHighPriority({
                    messages: [
                        { role: 'system', content: systemContent },
                        { role: 'user', content: userContent }
                    ],
                    max_tokens: 400,
                    temperature: 0.7
                });
            } else {
                const response = await fetch('https://api.llm7.io/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'gpt-4o-mini',
                        messages: [
                            { role: 'system', content: systemContent },
                            { role: 'user', content: userContent }
                        ],
                        max_tokens: 400,
                        temperature: 0.7
                    })
                });

                if (!response.ok) {
                    throw new Error(`API error: ${response.status}`);
                }
                data = await response.json();
            }

            const answer = data.choices?.[0]?.message?.content?.trim() || 'No explanation available.';
            
            // Return with sources if RAG was used
            if (useRAG && sources.length > 0) {
                return { answer, sources };
            }
            return answer;
        } catch (error) {
            console.error('OpenAI API Error:', error);
            return `Error: Unable to fetch explanation. ${error.message}`;
        }
    }

    // Help chatbot API wrapper (keeps conversation history) - Now with RAG support
    async function callTutor(messages, options = {}) {
        const { useRAG = true } = options;
        
        // Get the last user message for RAG query
        const lastUserMessage = messages.filter(m => m.role === 'user').pop();
        const ragQuery = lastUserMessage?.content || '';
        
        let systemContent = 'CPSA study assistant. Be concise. Plain text only. Created by Suraj Sharma (sudosuraj).';
        let sources = [];
        let contextMessage = null;
        
        // If RAG is enabled and available, retrieve relevant context
        if (useRAG && typeof RAG !== 'undefined' && RAG.isReady() && ragQuery) {
            const retrievedChunks = RAG.search(ragQuery, 5);
            
            if (retrievedChunks.length > 0) {
                // Use token-budgeted context formatting
                const context = RAG.formatContext(retrievedChunks, { maxTokens: 2000 });
                sources = RAG.formatSources(retrievedChunks);
                
                // Add context as a separate message to save system prompt tokens
                contextMessage = { role: 'user', content: `[Study notes for reference]:\n${context}` };
            }
        }
        
        // Build payload with optional context message
        const payload = [
            {
                role: 'system',
                content: systemContent
            }
        ];
        
        // Add context message before conversation if RAG found relevant content
        if (contextMessage) {
            payload.push(contextMessage);
        }
        
        // Add conversation messages
        payload.push(...messages);

        try {
            // Use LLMClient if available for rate limiting, otherwise fall back to direct fetch
            let data;
            if (typeof LLMClient !== 'undefined') {
                data = await LLMClient.requestHighPriority({
                    messages: payload,
                    max_tokens: 400,
                    temperature: 0.5
                });
            } else {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 20000);
                
                try {
                    const response = await fetch('https://api.llm7.io/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        body: JSON.stringify({
                            model: 'gpt-4o-mini',
                            messages: payload,
                            max_tokens: 400,
                            temperature: 0.5
                        }),
                        signal: controller.signal
                    });

                    if (!response.ok) {
                        throw new Error(`API error: ${response.status}`);
                    }
                    data = await response.json();
                } finally {
                    clearTimeout(timeoutId);
                }
            }

            const answer = data.choices?.[0]?.message?.content?.trim() || 'No reply received.';
            
            // Return with sources if RAG was used
            if (useRAG && sources.length > 0) {
                return { answer, sources };
            }
            return answer;
        } catch (error) {
            if (error.name === 'AbortError') {
                return 'Sorry, the tutor timed out. Please try again.';
            }
            console.error('Chatbot API Error:', error);
            return `Sorry, I could not fetch a reply. ${error.message}`;
        }
    }

    // Function to explain question context - Now with RAG support
    async function explainQuestion(questionText, questionId) {
        const explanationDiv = document.getElementById(`question-explanation-${questionId}`);
        const button = document.getElementById(`explain-question-btn-${questionId}`);
        
        if (explanationDiv.classList.contains('show')) {
            explanationDiv.classList.remove('show');
            button.textContent = '[AI+RAG] Explain Question';
            return;
        }

        button.disabled = true;
        button.textContent = 'Loading...';
        explanationDiv.classList.add('show', 'loading');
        explanationDiv.textContent = 'Searching study notes and generating explanation...';

        const prompt = `For this cybersecurity question: "${questionText}" - Provide background context and key concepts/terms that are relevant to understanding this question. Use the reference material provided to give accurate information from the CPSA study notes. Focus on explaining the foundational knowledge, important terms, and context needed to answer it. Keep it concise (3-4 sentences).`;
        
        const result = await callOpenAI(prompt, { 
            useRAG: true, 
            ragQuery: questionText,
            topK: 3 
        });

        explanationDiv.classList.remove('loading');
        
        // Handle RAG response with sources
        if (result && typeof result === 'object' && result.answer) {
            let content = result.answer;
            if (result.sources && result.sources.length > 0) {
                content += '\n\n--- Sources ---\n';
                result.sources.forEach(src => {
                    content += `[${src.index}] ${src.sectionTitle} (${src.appendix})\n`;
                });
            }
            explanationDiv.textContent = content;
        } else {
            explanationDiv.textContent = result;
        }
        
        button.disabled = false;
        button.textContent = '[AI+RAG] Hide Explanation';
    }

    // Function to explain answer on demand - Now with RAG support
    async function explainAnswer(questionId) {
        const state = answerState[questionId];
        const explanationDiv = document.getElementById(`answer-explanation-${questionId}`);
        const button = document.getElementById(`explain-answer-btn-${questionId}`);
        if (!explanationDiv || !button) return;

        if (!state) {
            explanationDiv.classList.add('show');
            explanationDiv.textContent = 'Answer the question first to get an explanation.';
            return;
        }

        if (explanationDiv.classList.contains('show') && !explanationDiv.classList.contains('loading')) {
            explanationDiv.classList.remove('show');
            button.textContent = '[AI+RAG] Explain Answer';
            return;
        }

        explanationDiv.classList.remove('correct-explanation', 'incorrect-explanation');
        explanationDiv.classList.add(state.isCorrect ? 'correct-explanation' : 'incorrect-explanation', 'show', 'loading');
        explanationDiv.textContent = 'Searching study notes and generating explanation...';
        button.disabled = true;
        button.textContent = 'Loading...';

        let prompt;
        const ragQuery = `${state.questionText} ${state.correctAnswer}`;
        
        if (state.isCorrect) {
            prompt = `Explain why this answer is correct using the reference material provided. Question: "${state.questionText}" Correct Answer: "${state.selectedAnswer}". Cite the relevant source if applicable. Keep it concise (2-3 sentences).`;
        } else {
            prompt = `Explain why this answer is incorrect and why the correct answer is right, using the reference material provided. Question: "${state.questionText}" Selected Answer: "${state.selectedAnswer}" Correct Answer: "${state.correctAnswer}". Cite the relevant source if applicable. Keep it concise (3-4 sentences).`;
        }

        const result = await callOpenAI(prompt, {
            useRAG: true,
            ragQuery: ragQuery,
            topK: 3
        });

        explanationDiv.classList.remove('loading');
        
        // Handle RAG response with sources
        if (result && typeof result === 'object' && result.answer) {
            let content = result.answer;
            if (result.sources && result.sources.length > 0) {
                content += '\n\n--- Sources ---\n';
                result.sources.forEach(src => {
                    content += `[${src.index}] ${src.sectionTitle} (${src.appendix})\n`;
                });
            }
            explanationDiv.textContent = content;
        } else {
            explanationDiv.textContent = result;
        }
        
        button.disabled = false;
        button.textContent = '[AI+RAG] Hide Answer Explanation';
    }

    async function loadQuiz() {
        const quizContainer = document.getElementById("quiz-container");
        const scoreElement = document.getElementById("score");
        const percentageElement = document.getElementById("percentage");
        const totalElement = document.getElementById("total-questions");
        const accuracyBar = document.getElementById("accuracy-bar");
        const categoryCountChip = document.getElementById("category-count-chip");
        const questionCountChip = document.getElementById("question-count-chip");

        if (accuracyBar) {
            accuracyBar.style.width = "0%";
        }

        // Show appendix selection screen
        quizContainer.innerHTML = '';
        
        // Add toolbar-collapsed class to hide toolbar by default
        const mainContent = document.getElementById('main-content');
        if (mainContent) {
            mainContent.classList.add('toolbar-collapsed');
        }
        
        // Remove active state from all tabs
        document.querySelectorAll('.toolbar-tab').forEach(tab => {
            tab.classList.remove('active');
            tab.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.toolbar-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        
        const selectionScreen = document.createElement('div');
        selectionScreen.className = 'appendix-selection';
        selectionScreen.innerHTML = `
            <div class="appendix-hero">
                <h1>CREST CPSA Practice Quiz</h1>
                <p>Master penetration testing concepts with AI-generated questions from the official study notes</p>
                <div class="hero-stats">
                    <div class="hero-stat">
                        <span class="hero-stat-value">10</span>
                        <span class="hero-stat-label">Appendices</span>
                    </div>
                    <div class="hero-stat">
                        <span class="hero-stat-value">230</span>
                        <span class="hero-stat-label">Topics</span>
                    </div>
                    <div class="hero-stat">
                        <span class="hero-stat-value">1000+</span>
                        <span class="hero-stat-label">Questions</span>
                    </div>
                </div>
                <div class="hero-credits">
                    <span>Study notes by</span>
                    <a href="https://www.linkedin.com/in/ravi-solanki-876089132/" target="_blank" rel="noopener noreferrer">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg>
                        Ravi Solanki
                    </a>
                    <span class="credit-separator">|</span>
                    <span>Platform by</span>
                    <a href="https://www.linkedin.com/in/sudosuraj" target="_blank" rel="noopener noreferrer">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z"/></svg>
                        Suraj Sharma
                    </a>
                </div>
            </div>
            <div class="appendix-grid" id="appendix-grid">
                <div class="loading-appendices">Loading appendices...</div>
            </div>
        `;
        quizContainer.appendChild(selectionScreen);

        // Load appendices from RAG
        try {
            const appendices = await QuizDataLoader.getAvailableAppendices();
            const grid = document.getElementById('appendix-grid');
            grid.innerHTML = '';

            appendices.forEach(appendix => {
                const card = document.createElement('div');
                card.className = 'appendix-card';
                card.dataset.appendix = appendix.letter;
                
                // Get chunk count for this appendix
                const chunkCount = RAG.getAppendixChunkCount(appendix.letter);
                const estimatedQuestions = chunkCount * 5; // ~5 questions per chunk
                
                // Get appendix icon class
                const iconClass = `appendix-${appendix.letter.toLowerCase()}`;
                
                card.innerHTML = `
                    <div class="appendix-card-header">
                        <div class="appendix-icon ${iconClass}">${appendix.letter}</div>
                        <div class="appendix-card-info">
                            <div class="appendix-letter">Appendix ${appendix.letter}</div>
                            <div class="appendix-title">${appendix.title}</div>
                        </div>
                    </div>
                    <div class="appendix-card-body">
                        <div class="appendix-stats">
                            <div class="appendix-stat">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
                                </svg>
                                ${chunkCount} topics
                            </div>
                            <div class="appendix-stat">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                </svg>
                                ~${estimatedQuestions} questions
                            </div>
                        </div>
                        <div class="appendix-progress">
                            <div class="appendix-progress-bar" style="width: 0%"></div>
                        </div>
                        <div class="appendix-cta">
                            <span class="appendix-status">Start Practice</span>
                            <div class="appendix-arrow">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M9 5l7 7-7 7"/>
                                </svg>
                            </div>
                        </div>
                    </div>
                `;
                
                card.addEventListener('click', () => loadAppendixQuiz(appendix.letter, appendix.title));
                grid.appendChild(card);
            });

            // Note: "Load All" button removed - now processing one appendix at a time with pagination

        } catch (error) {
            console.error('Error loading appendices:', error);
            quizContainer.innerHTML = '<p class="error">Error loading appendices. Please refresh the page.</p>';
        }
    }

    // Store current appendix info for pagination
    let currentAppendix = { letter: null, title: null };

    async function loadAppendixQuiz(appendixLetter, appendixTitle) {
        const quizContainer = document.getElementById("quiz-container");
        currentAppendix = { letter: appendixLetter, title: appendixTitle };
        
        // Check if this appendix has been preloaded
        const isPreloaded = QuizDataLoader.isAppendixPreloaded && QuizDataLoader.isAppendixPreloaded(appendixLetter);
        
        if (isPreloaded) {
            // Use preloaded questions - instant display!
            console.log(`Using preloaded questions for Appendix ${appendixLetter}`);
            
            const questions = QuizDataLoader.getAllAppendixQuestions(appendixLetter);
            const paginationInfo = QuizDataLoader.getPaginationInfo(appendixLetter);
            
            // Update total questions count
            totalQuestions = QuizDataLoader.getTotalQuestionCount();
            const totalElement = document.getElementById("total-questions");
            if (totalElement) {
                totalElement.textContent = totalQuestions;
            }

            // Display the questions immediately
            displayQuestionsWithPagination(questions, appendixLetter, appendixTitle, paginationInfo);
            
            // Start loading next batch in background for when user clicks "Next"
            setTimeout(() => {
                QuizDataLoader.loadAppendixNextPage(appendixLetter, null).then(() => {
                    console.log(`Background: Next batch ready for Appendix ${appendixLetter}`);
                });
            }, 500);
            
            return;
        }
        
        // Not preloaded - show loading screen and generate questions
        quizContainer.innerHTML = `
            <div class="generation-progress">
                <h2>Generating Questions for Appendix ${appendixLetter}</h2>
                <p>${appendixTitle}</p>
                <p class="generation-info">Generating first batch of 20 questions...</p>
                <div class="progress-bar-container">
                    <div class="progress-bar" id="generation-progress-bar"></div>
                </div>
                <p id="generation-status">Initializing...</p>
            </div>
        `;

        try {
            const result = await QuizDataLoader.loadAppendixFirstPage(appendixLetter, (progress) => {
                const progressBar = document.getElementById('generation-progress-bar');
                const statusEl = document.getElementById('generation-status');
                if (progressBar) {
                    const pct = (progress.currentChunk / progress.totalChunks) * 100;
                    progressBar.style.width = `${pct}%`;
                }
                if (statusEl) {
                    statusEl.textContent = `Processing chunk ${progress.currentChunk}/${progress.totalChunks} (${progress.questionsGenerated}/${progress.targetCount} questions)`;
                }
            });

            // Update total questions count
            totalQuestions = QuizDataLoader.getTotalQuestionCount();
            const totalElement = document.getElementById("total-questions");
            if (totalElement) {
                totalElement.textContent = totalQuestions;
            }

            // Display the questions with pagination
            displayQuestionsWithPagination(result.questions, appendixLetter, appendixTitle, result);
            
            // Start loading next batch in background
            setTimeout(() => {
                QuizDataLoader.loadAppendixNextPage(appendixLetter, null).then(() => {
                    console.log(`Background: Next batch ready for Appendix ${appendixLetter}`);
                });
            }, 500);
            
        } catch (error) {
            console.error('Error generating questions:', error);
            quizContainer.innerHTML = `
                <p class="error">Error generating questions. Please try again.</p>
                <button onclick="loadQuiz()">Back to Appendix Selection</button>
            `;
        }
    }

    async function loadNextPage() {
        const quizContainer = document.getElementById("quiz-container");
        const { letter, title } = currentAppendix;
        
        if (!letter) {
            console.error('No appendix selected');
            return;
        }

        // Show loading indicator
        const nextPageBtn = document.getElementById('next-page-btn');
        if (nextPageBtn) {
            nextPageBtn.disabled = true;
            nextPageBtn.textContent = 'Generating next batch...';
        }

        try {
            const result = await QuizDataLoader.loadAppendixNextPage(letter, (progress) => {
                if (nextPageBtn) {
                    nextPageBtn.textContent = `Generating... (${progress.questionsGenerated}/${progress.targetCount})`;
                }
            });

            // Update total questions count
            totalQuestions = QuizDataLoader.getTotalQuestionCount();
            const totalElement = document.getElementById("total-questions");
            if (totalElement) {
                totalElement.textContent = totalQuestions;
            }

            // Re-display all questions with updated pagination
            const allQuestions = QuizDataLoader.getAllAppendixQuestions(letter);
            displayQuestionsWithPagination(allQuestions, letter, title, result);
            
        } catch (error) {
            console.error('Error generating next page:', error);
            if (nextPageBtn) {
                nextPageBtn.disabled = false;
                nextPageBtn.textContent = 'Next Page (Generate More)';
            }
        }
    }

    function displayQuestionsWithPagination(questions, appendixLetter, appendixTitle, paginationResult) {
        const quizContainer = document.getElementById("quiz-container");
        const scoreElement = document.getElementById("score");
        const percentageElement = document.getElementById("percentage");
        const accuracyBar = document.getElementById("accuracy-bar");
        
        // Track answers for this quiz session
        let correctAnswers = 0;
        let answeredQuestions = 0;

        // Keep toolbar hidden when viewing questions
        const mainContent = document.getElementById('main-content');
        if (mainContent) {
            mainContent.classList.add('toolbar-collapsed');
        }
        
        // Remove active state from all tabs
        document.querySelectorAll('.toolbar-tab').forEach(tab => {
            tab.classList.remove('active');
            tab.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.toolbar-panel').forEach(panel => {
            panel.classList.remove('active');
        });

        quizContainer.innerHTML = '';

        // Add header with back button and pagination info
        const header = document.createElement('div');
        header.className = 'quiz-header-pagination';
        
        const backBtn = document.createElement('button');
        backBtn.className = 'back-to-selection';
        backBtn.textContent = 'Back to Appendix Selection';
        backBtn.addEventListener('click', loadQuiz);
        header.appendChild(backBtn);

        const titleEl = document.createElement('h2');
        titleEl.className = 'appendix-quiz-title';
        // appendixTitle already contains "Appendix X: ..." so just use it directly
        titleEl.textContent = appendixTitle;
        header.appendChild(titleEl);

        // Pagination info
        const paginationInfo = QuizDataLoader.getPaginationInfo(appendixLetter);
        const infoEl = document.createElement('div');
        infoEl.className = 'pagination-info';
        infoEl.innerHTML = `
            <span class="page-counter">Page ${paginationInfo.currentPage} | ${paginationInfo.totalQuestions} questions loaded</span>
            <span class="chunk-progress">Chunks: ${paginationInfo.chunksProcessed}/${paginationInfo.totalChunks}</span>
            ${paginationInfo.exhausted ? '<span class="exhausted-badge">All content processed</span>' : ''}
        `;
        header.appendChild(infoEl);

        quizContainer.appendChild(header);

        // Create questions container - flat list without categories
        const questionsContainer = document.createElement('div');
        questionsContainer.className = 'questions-container flat-list';

        // Render questions as flat list (no category grouping)
        let questionNumber = 1;
        Object.keys(questions).forEach(key => {
            const questionObj = questions[key];
            
            // Create modern question card
            const questionCard = document.createElement("div");
            questionCard.classList.add("question-card");
            questionCard.dataset.questionId = key;

            // Question header with number badge and actions
            const questionHeader = document.createElement("div");
            questionHeader.classList.add("question-card-header");

            const questionBadge = document.createElement("span");
            questionBadge.classList.add("question-number-badge");
            questionBadge.textContent = questionNumber;

            const questionActions = document.createElement("div");
            questionActions.classList.add("question-card-actions");

            // Flag button
            const flagBtn = document.createElement("button");
            flagBtn.classList.add("flag-btn");
            flagBtn.title = "Flag for review";
            flagBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>`;
            flagBtn.addEventListener("click", () => toggleFlag(key));

            // Gemini explain button (disabled until user selects an option)
            const explainBtn = document.createElement("button");
            explainBtn.classList.add("gemini-btn");
            explainBtn.id = `explain-answer-btn-${key}`;
            explainBtn.title = "Select an answer first";
            explainBtn.disabled = true;
            explainBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none">
                <defs>
                    <linearGradient id="gemini-grad-${key}" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style="stop-color:#4285f4"/>
                        <stop offset="25%" style="stop-color:#9b72cb"/>
                        <stop offset="50%" style="stop-color:#d96570"/>
                        <stop offset="75%" style="stop-color:#d96570"/>
                        <stop offset="100%" style="stop-color:#9b72cb"/>
                    </linearGradient>
                </defs>
                <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="url(#gemini-grad-${key})"/>
            </svg>`;
            explainBtn.addEventListener("click", () => explainAnswer(key, questionObj, explainBtn));

            questionActions.appendChild(flagBtn);
            questionActions.appendChild(explainBtn);

            questionHeader.appendChild(questionBadge);
            questionHeader.appendChild(questionActions);

            // Question text
            const questionText = document.createElement("div");
            questionText.classList.add("question-card-text");
            questionText.textContent = questionObj.question;

            // Options container
            const optionsDiv = document.createElement("div");
            optionsDiv.classList.add("question-card-options");

            const allAnswers = [questionObj.answer, ...questionObj.incorrect];
            shuffleArray(allAnswers);

            allAnswers.forEach((answer, index) => {
                const optionDiv = document.createElement("div");
                optionDiv.classList.add("option-tile");
                
                const optionLetter = document.createElement("span");
                optionLetter.classList.add("option-letter");
                optionLetter.textContent = String.fromCharCode(65 + index); // A, B, C, D
                
                const optionText = document.createElement("span");
                optionText.classList.add("option-text");
                optionText.textContent = answer;
                
                optionDiv.appendChild(optionLetter);
                optionDiv.appendChild(optionText);
                optionDiv.dataset.correct = answer === questionObj.answer ? "true" : "false";

                optionDiv.addEventListener("click", function() {
                    if (this.classList.contains("answered")) {
                        return;
                    }

                    const isCorrect = this.dataset.correct === "true";
                    
                    // Mark all options as answered
                    optionsDiv.querySelectorAll(".option-tile").forEach(opt => {
                        opt.classList.add("answered");
                        if (opt.dataset.correct === "true") {
                            opt.classList.add("correct");
                        } else if (opt === this && !isCorrect) {
                            opt.classList.add("incorrect");
                        }
                    });

                    // Add feedback to card
                    questionCard.classList.add(isCorrect ? "answered-correct" : "answered-incorrect");

                    // Enable the Gemini explain button now that user has answered
                    explainBtn.disabled = false;
                    explainBtn.title = "Explain Answer";

                    // Update score
                    if (isCorrect) {
                        correctAnswers++;
                        addXP(10);
                    }
                    answeredQuestions++;
                    
                    updateCounts();
                    saveProgress();
                    checkAndAwardBadges();
                });

                optionsDiv.appendChild(optionDiv);
            });

            // Assemble the card
            questionCard.appendChild(questionHeader);
            questionCard.appendChild(questionText);
            questionCard.appendChild(optionsDiv);

            questionsContainer.appendChild(questionCard);
            questionNumber++;
        });

        quizContainer.appendChild(questionsContainer);

        // Add Next Page button if more questions available
        if (paginationInfo.hasMore || !paginationInfo.exhausted) {
            const nextPageContainer = document.createElement('div');
            nextPageContainer.className = 'next-page-container';
            
            const nextPageBtn = document.createElement('button');
            nextPageBtn.id = 'next-page-btn';
            nextPageBtn.className = 'next-page-btn';
            nextPageBtn.textContent = 'Next Page (Generate 20 More Questions)';
            nextPageBtn.addEventListener('click', loadNextPage);
            
            const progressNote = document.createElement('p');
            progressNote.className = 'progress-note';
            progressNote.textContent = `Target: ${paginationInfo.minTarget} questions minimum | Currently: ${paginationInfo.totalQuestions} questions`;
            
            nextPageContainer.appendChild(nextPageBtn);
            nextPageContainer.appendChild(progressNote);
            quizContainer.appendChild(nextPageContainer);
        } else {
            // Show completion message
            const completionMsg = document.createElement('div');
            completionMsg.className = 'completion-message';
            completionMsg.innerHTML = `
                <p>All available content for Appendix ${appendixLetter} has been processed.</p>
                <p>Total questions generated: ${paginationInfo.totalQuestions}</p>
            `;
            quizContainer.appendChild(completionMsg);
        }

        // Update stats
        updateCounts();
    }

    // Legacy functions removed:
    // - loadAllAppendices (use pagination-based loadAppendixQuiz instead)
    // - displayQuestions (use displayQuestionsWithPagination instead)
    // - expandAllCategories, collapseAllCategories, filterCategories, resetFilters (category UI removed)

    function setupUtilities() {
        // Legacy expand/collapse buttons removed - category UI no longer exists
        const resetProgressBtn = document.getElementById("reset-progress-btn");

        if (resetProgressBtn) {
            resetProgressBtn.addEventListener("click", resetProgress);
        }
        
        // Setup debounced search
        setupDebouncedSearch();
        
        // Setup filter dropdown
        setupFilters();
        
        // Setup back to top button
        setupBackToTop();
        
        // Setup offline detection
        setupOfflineDetection();
        
        // Setup share dropdown
        setupShareDropdown();
        
        // Setup tabbed toolbar
        setupTabbedToolbar();
        
        // Setup mode toggle (Study/Exam)
        setupModeToggle();
        
        // Setup view toggle (List/Single)
        setupViewToggle();
        
        // Setup XP system
        setupXPSystem();
    }
    
    // Tabbed Toolbar
    function setupTabbedToolbar() {
        const tabs = document.querySelectorAll('.toolbar-tab');
        const panels = document.querySelectorAll('.toolbar-panel');
        const moreBtn = document.getElementById('more-actions-btn');
        const moreMenu = document.getElementById('more-menu');
        const reviewFlaggedBtn = document.getElementById('review-flagged-btn');
        const mainContent = document.getElementById('main-content');
        
        // Tab switching
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                const isCurrentlyActive = tab.classList.contains('active');
                
                // If clicking the active tab, toggle toolbar visibility
                if (isCurrentlyActive && mainContent) {
                    mainContent.classList.toggle('toolbar-collapsed');
                    return;
                }
                
                // Show toolbar (remove collapsed class)
                if (mainContent) {
                    mainContent.classList.remove('toolbar-collapsed');
                }
                
                // Update tabs
                tabs.forEach(t => {
                    t.classList.remove('active');
                    t.setAttribute('aria-selected', 'false');
                });
                tab.classList.add('active');
                tab.setAttribute('aria-selected', 'true');
                
                // Update panels
                panels.forEach(p => p.classList.remove('active'));
                document.getElementById(`panel-${tabName}`).classList.add('active');
                
                // Update insights when switching to insights tab
                if (tabName === 'insights') {
                    updateInsightsSummary();
                }
                
                // Update review stats when switching to review tab
                if (tabName === 'review') {
                    updateReviewStats();
                }
                
                // Update progress grid when switching to progress tab
                if (tabName === 'progress') {
                    updateProgressGridPanel();
                }
                
            });
        });
        
        // Reset all progress button
        const resetAllBtn = document.getElementById('reset-all-progress-btn');
        if (resetAllBtn) {
            resetAllBtn.addEventListener('click', () => {
                if (confirm('Are you sure you want to reset ALL progress? This will clear all answers, XP, badges, and streaks.')) {
                    resetProgress();
                    updateProgressGridPanel();
                    showToast('All progress has been reset');
                }
            });
        }
        
        // More dropdown
        if (moreBtn && moreMenu) {
            moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isHidden = moreMenu.hidden;
                moreMenu.hidden = !isHidden;
                moreBtn.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
            });
            
            // Close on outside click
            document.addEventListener('click', () => {
                moreMenu.hidden = true;
                moreBtn.setAttribute('aria-expanded', 'false');
            });
            
            // Prevent closing when clicking inside menu
            moreMenu.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }
        
        // Review flagged button
        if (reviewFlaggedBtn) {
            reviewFlaggedBtn.addEventListener('click', () => {
                const flaggedIds = Object.entries(flaggedQuestions)
                    .filter(([_, flagged]) => flagged)
                    .map(([id, _]) => id);
                
                if (flaggedIds.length === 0) {
                    showToast('No flagged questions to review');
                    return;
                }
                
                setView('single');
                allQuestionIds = flaggedIds;
                currentQuestionIndex = 0;
                showQuestion(0);
                buildNavigatorDots();
                showToast(`Reviewing ${flaggedIds.length} flagged questions`);
            });
        }
    }
    
    // Update insights summary
    function updateInsightsSummary() {
        const attempted = Object.keys(answerState).length;
        const correct = Object.values(answerState).filter(s => s.correct).length;
        const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
        
        const accuracyEl = document.getElementById('insight-accuracy');
        const attemptedEl = document.getElementById('insight-attempted');
        const streakEl = document.getElementById('insight-streak');
        
        if (accuracyEl) accuracyEl.textContent = `${accuracy}%`;
        if (attemptedEl) attemptedEl.textContent = attempted;
        if (streakEl) streakEl.textContent = currentStreak || 0;
    }
    
    // Update review stats
    function updateReviewStats() {
        const incorrectCount = Object.values(answerState).filter(s => !s.correct).length;
        const flaggedCount = Object.values(flaggedQuestions).filter(f => f).length;
        
        const incorrectEl = document.getElementById('incorrect-review-count');
        const flaggedEl = document.getElementById('flagged-review-count');
        
        if (incorrectEl) incorrectEl.textContent = incorrectCount;
        if (flaggedEl) flaggedEl.textContent = flaggedCount;
    }
    
    // Mode toggle (Study/Exam)
    let currentMode = 'study'; // 'study' or 'exam'
    
    function setupModeToggle() {
        const studyBtn = document.getElementById('study-mode-btn');
        const examBtn = document.getElementById('exam-mode-btn');
        const quizContainer = document.getElementById('quiz-container');
        
        if (!studyBtn || !examBtn) return;
        
        studyBtn.addEventListener('click', () => setMode('study'));
        examBtn.addEventListener('click', () => setMode('exam'));
    }
    
    function setMode(mode) {
        currentMode = mode;
        const studyBtn = document.getElementById('study-mode-btn');
        const examBtn = document.getElementById('exam-mode-btn');
        const quizContainer = document.getElementById('quiz-container');
        
        if (mode === 'study') {
            studyBtn.classList.add('active');
            studyBtn.setAttribute('aria-pressed', 'true');
            examBtn.classList.remove('active');
            examBtn.setAttribute('aria-pressed', 'false');
            quizContainer.classList.remove('exam-mode');
            showToast('Study mode: See answers immediately');
        } else {
            examBtn.classList.add('active');
            examBtn.setAttribute('aria-pressed', 'true');
            studyBtn.classList.remove('active');
            studyBtn.setAttribute('aria-pressed', 'false');
            quizContainer.classList.add('exam-mode');
            showToast('Exam mode: Answers hidden until you finish');
        }
    }
    
    // View toggle (List/Single)
    let currentView = 'list'; // 'list' or 'single'
    let currentQuestionIndex = 0;
    let allQuestionIds = [];
    
    function setupViewToggle() {
        const listBtn = document.getElementById('list-view-btn');
        const singleBtn = document.getElementById('single-view-btn');
        const prevBtn = document.getElementById('prev-question-btn');
        const nextBtn = document.getElementById('next-question-btn');
        
        if (!listBtn || !singleBtn) return;
        
        listBtn.addEventListener('click', () => setView('list'));
        singleBtn.addEventListener('click', () => setView('single'));
        
        if (prevBtn) prevBtn.addEventListener('click', () => navigateQuestion(-1));
        if (nextBtn) nextBtn.addEventListener('click', () => navigateQuestion(1));
        
        // Build question ID list
        buildQuestionIdList();
    }
    
    function buildQuestionIdList() {
        allQuestionIds = [];
        document.querySelectorAll('.question-container').forEach(q => {
            const id = q.dataset.questionId;
            if (id) allQuestionIds.push(id);
        });
    }
    
    function setView(view) {
        currentView = view;
        const listBtn = document.getElementById('list-view-btn');
        const singleBtn = document.getElementById('single-view-btn');
        const singleNav = document.getElementById('single-question-nav');
        const navigator = document.getElementById('question-navigator');
        const categories = document.querySelectorAll('.category-section');
        const questions = document.querySelectorAll('.question-container');
        
        if (view === 'list') {
            listBtn.classList.add('active');
            listBtn.setAttribute('aria-pressed', 'true');
            singleBtn.classList.remove('active');
            singleBtn.setAttribute('aria-pressed', 'false');
            singleNav.classList.remove('show');
            navigator.classList.remove('show');
            
            // Show all categories and questions
            categories.forEach(c => c.style.display = '');
            questions.forEach(q => q.style.display = '');
        } else {
            singleBtn.classList.add('active');
            singleBtn.setAttribute('aria-pressed', 'true');
            listBtn.classList.remove('active');
            listBtn.setAttribute('aria-pressed', 'false');
            singleNav.classList.add('show');
            navigator.classList.add('show');
            
            // Expand all categories and hide category headers
            categories.forEach(c => {
                c.style.display = 'block';
                const questionsDiv = c.querySelector('.category-questions');
                if (questionsDiv) questionsDiv.classList.remove('collapsed');
                const title = c.querySelector('.category-title');
                if (title) title.style.display = 'none';
            });
            
            // Build navigator dots
            buildNavigatorDots();
            
            // Show only current question
            showQuestion(currentQuestionIndex);
        }
    }
    
    function buildNavigatorDots() {
        const navigator = document.getElementById('question-navigator');
        if (!navigator) return;
        
        navigator.innerHTML = '';
        allQuestionIds.forEach((id, index) => {
            const dot = document.createElement('button');
            dot.className = 'nav-dot';
            dot.textContent = index + 1;
            dot.title = `Question ${index + 1}`;
            
            // Add status classes
            if (answerState[id]) {
                dot.classList.add(answerState[id].correct ? 'correct' : 'incorrect');
            }
            if (flaggedQuestions.has(id)) {
                dot.classList.add('flagged');
            }
            if (index === currentQuestionIndex) {
                dot.classList.add('current');
            }
            
            dot.addEventListener('click', () => {
                currentQuestionIndex = index;
                showQuestion(index);
                updateNavigatorDots();
            });
            
            navigator.appendChild(dot);
        });
    }
    
    function updateNavigatorDots() {
        const dots = document.querySelectorAll('.nav-dot');
        dots.forEach((dot, index) => {
            dot.classList.toggle('current', index === currentQuestionIndex);
        });
    }
    
    function showQuestion(index) {
        const questions = document.querySelectorAll('.question-container');
        questions.forEach((q, i) => {
            q.style.display = i === index ? '' : 'none';
        });
        
        // Update counter
        const counter = document.getElementById('question-counter');
        if (counter) {
            counter.textContent = `${index + 1} / ${allQuestionIds.length}`;
        }
        
        // Update nav buttons
        const prevBtn = document.getElementById('prev-question-btn');
        const nextBtn = document.getElementById('next-question-btn');
        if (prevBtn) prevBtn.disabled = index === 0;
        if (nextBtn) nextBtn.disabled = index === allQuestionIds.length - 1;
        
        // Scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    
    function navigateQuestion(direction) {
        const newIndex = currentQuestionIndex + direction;
        if (newIndex >= 0 && newIndex < allQuestionIds.length) {
            currentQuestionIndex = newIndex;
            showQuestion(newIndex);
            updateNavigatorDots();
        }
    }
    
    // XP System
    let xp = 0;
    let level = 1;
    const XP_PER_CORRECT = 10;
    const XP_PER_INCORRECT = 2;
    const XP_PER_LEVEL = 100;
    
    function setupXPSystem() {
        // Load saved XP
        const savedXP = localStorage.getItem('cpsa_quiz_xp');
        if (savedXP) {
            const data = JSON.parse(savedXP);
            xp = data.xp || 0;
            level = data.level || 1;
        }
        renderXP();
    }
    
    function addXP(amount) {
        xp += amount;
        
        // Check for level up
        const newLevel = Math.floor(xp / XP_PER_LEVEL) + 1;
        if (newLevel > level) {
            level = newLevel;
            showToast(`Level up! You're now level ${level}!`);
        }
        
        // Save XP
        localStorage.setItem('cpsa_quiz_xp', JSON.stringify({ xp, level }));
        renderXP();
    }
    
    function renderXP() {
        const levelEl = document.getElementById('xp-level');
        const textEl = document.getElementById('xp-text');
        const barEl = document.getElementById('xp-bar');
        
        if (levelEl) levelEl.textContent = level;
        if (textEl) textEl.textContent = `${xp} XP`;
        if (barEl) {
            const xpInLevel = xp % XP_PER_LEVEL;
            const percentage = (xpInLevel / XP_PER_LEVEL) * 100;
            barEl.style.width = `${percentage}%`;
        }
    }
    
    // Sprint Timer
    let sprintActive = false;
    let sprintTimeLeft = 600; // 10 minutes in seconds
    let sprintAnswered = 0;
    let sprintInterval = null;
    
    function startSprint(duration = 600) {
        sprintActive = true;
        sprintTimeLeft = duration;
        sprintAnswered = 0;
        
        const timerEl = document.getElementById('sprint-timer');
        if (timerEl) timerEl.classList.add('active');
        
        updateSprintDisplay();
        
        sprintInterval = setInterval(() => {
            sprintTimeLeft--;
            updateSprintDisplay();
            
            if (sprintTimeLeft <= 60) {
                const timerEl = document.getElementById('sprint-timer');
                if (timerEl) timerEl.classList.add('warning');
            }
            
            if (sprintTimeLeft <= 0) {
                endSprint();
            }
        }, 1000);
        
        showToast('Sprint started! Answer as many as you can!');
    }
    
    function updateSprintDisplay() {
        const timeEl = document.getElementById('sprint-time');
        const countEl = document.getElementById('sprint-count');
        
        if (timeEl) {
            const mins = Math.floor(sprintTimeLeft / 60);
            const secs = sprintTimeLeft % 60;
            timeEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
        
        if (countEl) {
            countEl.textContent = `${sprintAnswered} answered`;
        }
    }
    
    function endSprint() {
        sprintActive = false;
        clearInterval(sprintInterval);
        
        const timerEl = document.getElementById('sprint-timer');
        if (timerEl) {
            timerEl.classList.remove('active', 'warning');
        }
        
        showToast(`Sprint complete! You answered ${sprintAnswered} questions!`);
    }
    
    function incrementSprintCount() {
        if (sprintActive) {
            sprintAnswered++;
            updateSprintDisplay();
        }
    }
    
    // Share dropdown functionality
    function setupShareDropdown() {
        const trigger = document.getElementById('share-trigger');
        const menu = document.getElementById('share-menu');
        
        if (!trigger || !menu) return;
        
        // Toggle menu on click
        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = !menu.hidden;
            menu.hidden = isOpen;
            trigger.setAttribute('aria-expanded', !isOpen);
        });
        
        // Close menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!menu.hidden && !menu.contains(e.target) && e.target !== trigger) {
                menu.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
            }
        });
        
        // Handle share options
        menu.querySelectorAll('.share-option').forEach(option => {
            option.addEventListener('click', () => {
                const platform = option.dataset.platform;
                handleShare(platform);
                menu.hidden = true;
                trigger.setAttribute('aria-expanded', 'false');
            });
        });
    }
    
    function getShareContent() {
        const scoreEl = document.getElementById('score');
        const totalEl = document.getElementById('total-questions');
        const percentageEl = document.getElementById('percentage');
        const streakEl = document.getElementById('streak-count');
        const attemptedEl = document.getElementById('attempted-count');
        
        const currentScore = scoreEl ? scoreEl.textContent : '0';
        const total = totalEl ? totalEl.textContent : '803';
        const percentage = percentageEl ? percentageEl.textContent : '0';
        const streak = streakEl ? streakEl.textContent : '0';
        const attempted = attemptedEl ? attemptedEl.textContent : '0';
        
        const url = 'https://sudosuraj.github.io/CREST/';
        
        return {
            twitter: `I'm preparing for my CREST CPSA certification!

Progress: ${currentScore}/${total} correct (${percentage}% accuracy)
${streak} day streak
${attempted} questions attempted

Free practice quiz with 803 questions - try it yourself!

${url}

#CPSA #CREST #Cybersecurity #InfoSec #PenTest`,
            
            linkedin: `Excited to share my CREST CPSA certification prep journey!

I've been using this fantastic free practice quiz to prepare for the CPSA exam:

Current Progress:
- Score: ${currentScore}/${total} correct
- Accuracy: ${percentage}%
- Streak: ${streak} days
- Questions Attempted: ${attempted}

The quiz covers all CPSA domains with 803 practice questions. If you're preparing for CREST certifications, I highly recommend checking it out!

${url}

#CPSA #CREST #Cybersecurity #PenetrationTesting #InfoSec #CareerDevelopment`,
            
            clipboard: `CREST CPSA Practice Quiz Progress

Score: ${currentScore}/${total} correct (${percentage}% accuracy)
Streak: ${streak} days
Attempted: ${attempted} questions

Try it yourself: ${url}`,
            
            url: url
        };
    }
    
    function handleShare(platform) {
        const content = getShareContent();
        
        switch (platform) {
            case 'twitter':
                const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(content.twitter)}`;
                window.open(twitterUrl, '_blank', 'width=550,height=420');
                break;
                
            case 'linkedin':
                const linkedinUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(content.url)}`;
                window.open(linkedinUrl, '_blank', 'width=550,height=420');
                showToast('LinkedIn opened! Paste your progress in the post.');
                navigator.clipboard.writeText(content.linkedin).catch(() => {});
                break;
                
            case 'copy':
                navigator.clipboard.writeText(content.clipboard).then(() => {
                    showToast('Progress copied to clipboard!');
                }).catch(() => {
                    showToast('Failed to copy. Please try again.');
                });
                break;
                
            case 'native':
                if (navigator.share) {
                    navigator.share({
                        title: 'CREST CPSA Practice Quiz',
                        text: content.clipboard,
                        url: content.url
                    }).catch(() => {});
                } else {
                    navigator.clipboard.writeText(content.clipboard).then(() => {
                        showToast('Progress copied to clipboard!');
                    }).catch(() => {});
                }
                break;
        }
    }

    function appendChatMessage(role, text) {
        const messagesEl = document.getElementById("chat-messages");
        if (!messagesEl) return null;
        const bubble = document.createElement("div");
        bubble.classList.add("chat-message", role === "user" ? "user" : "assistant");
        bubble.textContent = text;
        messagesEl.appendChild(bubble);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return bubble;
    }

    async function sendChatMessage() {
        const input = document.getElementById("chat-input");
        const sendBtn = document.getElementById("chat-send");
        const messagesEl = document.getElementById("chat-messages");
        if (!input || !sendBtn || !messagesEl) return;

        const rawContent = input.value || "";
        const content = sanitizeUserMessage(rawContent);
        if (!content) return;
        if (content.length > CHAT_MAX_LENGTH) {
            appendChatMessage("assistant", `Please keep messages under ${CHAT_MAX_LENGTH} characters.`);
            return;
        }
        if (isUnsafeMessage(content)) {
            appendChatMessage("assistant", "I can only help with CPSA study questions, not system or role-change requests.");
            input.value = "";
            return;
        }

        appendChatMessage("user", content);
        chatHistory.push({ role: "user", content });
        if (chatHistory.length > MAX_CHAT_TURNS) {
            chatHistory.shift();
        }
        input.value = "";
        input.focus();
        sendBtn.disabled = true;

        const placeholder = appendChatMessage("assistant", "Searching study notes...");
        const result = await callTutor(chatHistory.slice(-10));
        
        // Handle RAG response with sources
        let replyText;
        if (result && typeof result === 'object' && result.answer) {
            replyText = result.answer;
            if (result.sources && result.sources.length > 0) {
                replyText += '\n\n[Sources: ';
                replyText += result.sources.map(src => `${src.sectionId}`).join(', ');
                replyText += ']';
            }
        } else {
            replyText = result;
        }
        
        if (placeholder) {
            placeholder.textContent = replyText;
        }
        chatHistory.push({ role: "assistant", content: replyText });
        if (chatHistory.length > MAX_CHAT_TURNS) {
            chatHistory.shift();
        }
        sendBtn.disabled = false;
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setupChatbot() {
        const toggle = document.getElementById("chatbot-toggle");
        const panel = document.getElementById("chatbot-panel");
        const closeBtn = document.getElementById("chatbot-close");
        const sendBtn = document.getElementById("chat-send");
        const input = document.getElementById("chat-input");

        const togglePanel = (show) => {
            if (!panel) return;
            const shouldShow = typeof show === "boolean" ? show : !panel.classList.contains("show");
            panel.classList.toggle("show", shouldShow);
            if (toggle) {
                toggle.setAttribute("aria-expanded", shouldShow ? "true" : "false");
            }
            if (shouldShow && !chatGreeted) {
                appendChatMessage("assistant", "Hi! I can break down CPSA topics, explain options, or compare terms. I ignore system prompt tricks to stay on-topic.");
                chatGreeted = true;
            }
            if (shouldShow && input) {
                input.focus();
            }
        };

        if (toggle) {
            toggle.addEventListener("click", () => togglePanel());
        }
        if (closeBtn) {
            closeBtn.addEventListener("click", () => togglePanel(false));
        }
        if (sendBtn) {
            sendBtn.addEventListener("click", sendChatMessage);
        }
        if (input) {
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendChatMessage();
                }
            });
        }
    }
	
	document.addEventListener("DOMContentLoaded", () => {
        // Load saved progress first
        loadProgress();
        
        // Initialize quiz
        loadQuiz();
        setupUtilities();
        setupChatbot();
        
        // Restore UI state from saved progress
        restoreUIState();
        
        // Render streak indicator
        renderStreak();
        
        // Register service worker for PWA
        registerServiceWorker();
        
        // Update counts
        updateCounts();
        
        // Setup share dropdown (moved here to ensure it runs)
        setupShareDropdown();
    });
    
    // Restore UI state from saved progress
    function restoreUIState() {
        const scoreElement = document.getElementById("score");
        const percentageElement = document.getElementById("percentage");
        const accuracyBar = document.getElementById("accuracy-bar");
        const attemptedEl = document.getElementById("attempted-count");
        
        // Restore score display
        if (scoreElement) {
            scoreElement.textContent = score;
        }
        
        // Calculate and restore percentage
        const attempted = Object.keys(answerState).length;
        if (attempted > 0) {
            const percentage = ((score / totalQuestions) * 100).toFixed(2);
            if (percentageElement) {
                percentageElement.textContent = percentage;
            }
            if (accuracyBar) {
                const pctNumber = Math.min(parseFloat(percentage), 100);
                accuracyBar.style.width = `${pctNumber}%`;
            }
        }
        
        // Restore attempted count
        if (attemptedEl) {
            attemptedEl.textContent = attempted;
        }
        
        // Restore answered questions UI
        Object.entries(answerState).forEach(([qId, state]) => {
            const container = document.querySelector(`.question-container[data-question-id="${qId}"]`);
            if (!container) return;
            
            // Mark container as answered
            container.classList.add(state.correct ? 'answered-correct' : 'answered-incorrect');
            
            // Find and select the answered option
            const options = container.querySelectorAll('.option');
            options.forEach(optionDiv => {
                const input = optionDiv.querySelector('input');
                if (!input) return;
                
                // Disable all inputs
                input.disabled = true;
                
                // Mark correct answer
                if (input.value === state.correctAnswer) {
                    optionDiv.classList.add('correct');
                }
                
                // Mark selected answer
                if (input.value === state.selectedAnswer) {
                    input.checked = true;
                    if (!state.correct) {
                        optionDiv.classList.add('incorrect');
                    }
                }
            });
            
            // Enable explain answer button
            const explainBtn = document.getElementById(`explain-answer-btn-${qId}`);
            if (explainBtn) {
                explainBtn.disabled = false;
            }
        });
        
        // Restore flagged questions UI
        flaggedQuestions.forEach(qId => {
            const container = document.querySelector(`.question-container[data-question-id="${qId}"]`);
            if (container) {
                container.classList.add('flagged');
                const flagBtn = container.querySelector('.flag-button');
                if (flagBtn) {
                    flagBtn.classList.add('flagged');
                    flagBtn.textContent = '[!] Flagged';
                }
            }
        });
    }
    
    // ==========================================
    // PRACTICE EXAM SYSTEM
    // ==========================================
    let examActive = false;
    let examQuestions = [];
    let examAnswers = {};
    let examTimeLimit = 0;
    let examTimeLeft = 0;
    let examInterval = null;
    let examStartTime = null;
    
    function setupPracticeExam() {
        const examBtn = document.getElementById('start-exam-btn');
        const examModal = document.getElementById('exam-modal');
        const examClose = document.getElementById('exam-modal-close');
        const startConfirm = document.getElementById('start-exam-confirm');
        const reviewBtn = document.getElementById('exam-review-btn');
        const retryBtn = document.getElementById('exam-retry-btn');
        
        if (examBtn) {
            examBtn.addEventListener('click', () => openModal('exam-modal'));
        }
        
        if (examClose) {
            examClose.addEventListener('click', () => closeModal('exam-modal'));
        }
        
        if (startConfirm) {
            startConfirm.addEventListener('click', startPracticeExam);
        }
        
        if (reviewBtn) {
            reviewBtn.addEventListener('click', () => {
                closeModal('exam-modal');
                showToast('Review your answers in the quiz below');
            });
        }
        
        if (retryBtn) {
            retryBtn.addEventListener('click', () => {
                document.getElementById('exam-config').style.display = 'block';
                document.getElementById('exam-results').style.display = 'none';
            });
        }
        
        // Preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const questions = btn.dataset.questions;
                const time = btn.dataset.time;
                const cat = btn.dataset.cat;
                
                document.getElementById('exam-questions').value = questions;
                document.getElementById('exam-time').value = time;
                document.getElementById('exam-categories').value = cat;
            });
        });
        
        // Close modal on overlay click
        if (examModal) {
            examModal.addEventListener('click', (e) => {
                if (e.target === examModal) closeModal('exam-modal');
            });
        }
    }
    
    function openModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('show');
            modal.setAttribute('aria-hidden', 'false');
        }
    }
    
    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        }
    }
    
    function startPracticeExam() {
        const numQuestions = parseInt(document.getElementById('exam-questions').value);
        examTimeLimit = parseInt(document.getElementById('exam-time').value);
        const category = document.getElementById('exam-categories').value;
        
        // Get questions, filtered by category if specified
        let eligibleIds = Object.keys(quizData);
        if (category && category !== 'all') {
            eligibleIds = eligibleIds.filter(id => {
                const q = quizData[id];
                const qCategory = categorizeQuestion(q);
                return qCategory.toLowerCase().includes(category.toLowerCase());
            });
        }
        
        // Use Fisher-Yates shuffle (unbiased)
        const shuffled = [...eligibleIds];
        shuffleArray(shuffled);
        examQuestions = shuffled.slice(0, Math.min(numQuestions, shuffled.length));
        examAnswers = {};
        examStartTime = Date.now();
        
        // Update UI
        document.getElementById('exam-config').style.display = 'none';
        document.getElementById('exam-progress').style.display = 'block';
        document.getElementById('exam-results').style.display = 'none';
        document.getElementById('exam-total').textContent = examQuestions.length;
        document.getElementById('exam-answered').textContent = '0';
        
        // Start timer if time limit set
        if (examTimeLimit > 0) {
            examTimeLeft = examTimeLimit;
            updateExamTimer();
            examInterval = setInterval(() => {
                examTimeLeft--;
                updateExamTimer();
                if (examTimeLeft <= 0) {
                    endPracticeExam();
                }
            }, 1000);
        } else {
            document.getElementById('exam-timer-display').textContent = '--:--';
        }
        
        examActive = true;
        closeModal('exam-modal');
        
        // Set to exam mode
        setMode('exam');
        
        showToast(`Practice exam started! ${examQuestions.length} questions`);
    }
    
    function updateExamTimer() {
        const mins = Math.floor(examTimeLeft / 60);
        const secs = examTimeLeft % 60;
        document.getElementById('exam-timer-display').textContent = 
            `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    
    function recordExamAnswer(questionId, isCorrect) {
        if (!examActive) return;
        
        examAnswers[questionId] = isCorrect;
        const answered = Object.keys(examAnswers).length;
        document.getElementById('exam-answered').textContent = answered;
        
        const progress = (answered / examQuestions.length) * 100;
        document.getElementById('exam-progress-fill').style.width = `${progress}%`;
        
        // Check if all questions answered
        if (answered >= examQuestions.length) {
            endPracticeExam();
        }
    }
    
    function endPracticeExam() {
        examActive = false;
        if (examInterval) {
            clearInterval(examInterval);
            examInterval = null;
        }
        
        // Calculate results
        const correct = Object.values(examAnswers).filter(v => v).length;
        const total = Object.keys(examAnswers).length;
        const score = total > 0 ? Math.round((correct / total) * 100) : 0;
        const timeTaken = Math.round((Date.now() - examStartTime) / 1000);
        const mins = Math.floor(timeTaken / 60);
        const secs = timeTaken % 60;
        
        // Update results UI
        document.getElementById('exam-score').textContent = `${score}%`;
        document.getElementById('exam-correct').textContent = correct;
        document.getElementById('exam-incorrect').textContent = total - correct;
        document.getElementById('exam-time-taken').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        
        // Show results
        document.getElementById('exam-progress').style.display = 'none';
        document.getElementById('exam-results').style.display = 'block';
        openModal('exam-modal');
        
        // Save exam history
        saveExamHistory(score, correct, total, timeTaken);
    }
    
    function saveExamHistory(score, correct, total, timeTaken) {
        const history = JSON.parse(localStorage.getItem('cpsa_exam_history') || '[]');
        history.push({
            date: new Date().toISOString(),
            score,
            correct,
            total,
            timeTaken
        });
        // Keep last 50 exams
        if (history.length > 50) history.shift();
        localStorage.setItem('cpsa_exam_history', JSON.stringify(history));
    }
    
    // ==========================================
    // ANALYTICS SYSTEM
    // ==========================================
    let dailyStats = {};
    
    function setupAnalytics() {
        const analyticsBtn = document.getElementById('analytics-btn');
        const analyticsModal = document.getElementById('analytics-modal');
        const analyticsClose = document.getElementById('analytics-modal-close');
        
        if (analyticsBtn) {
            analyticsBtn.addEventListener('click', () => {
                loadAnalyticsData();
                openModal('analytics-modal');
            });
        }
        
        if (analyticsClose) {
            analyticsClose.addEventListener('click', () => closeModal('analytics-modal'));
        }
        
        // Tab switching
        document.querySelectorAll('.analytics-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                
                // Update active tab
                document.querySelectorAll('.analytics-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                // Update active panel
                document.querySelectorAll('.analytics-panel').forEach(p => p.classList.remove('active'));
                document.getElementById(`analytics-${tabName}`).classList.add('active');
                
                if (tabName === 'trends') {
                    renderTrendChart();
                } else if (tabName === 'missed') {
                    renderMissedQuestions();
                }
            });
        });
        
        // Close on overlay click
        if (analyticsModal) {
            analyticsModal.addEventListener('click', (e) => {
                if (e.target === analyticsModal) closeModal('analytics-modal');
            });
        }
    }
    
    function loadAnalyticsData() {
        // Load daily stats
        dailyStats = JSON.parse(localStorage.getItem('cpsa_daily_stats') || '{}');
        
        // Update overview stats
        const attempted = Object.keys(answerState).length;
        const correct = Object.values(answerState).filter(s => s.correct).length;
        const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
        
        document.getElementById('total-attempted').textContent = attempted;
        document.getElementById('total-correct').textContent = correct;
        document.getElementById('overall-accuracy').textContent = `${accuracy}%`;
        
        // Calculate study time from actual tracked time
        const currentSession = Math.floor((Date.now() - sessionStartTime) / 1000);
        const totalSeconds = getStudyTime() + currentSession;
        const studyMins = Math.floor(totalSeconds / 60);
        const hours = Math.floor(studyMins / 60);
        const mins = studyMins % 60;
        document.getElementById('study-time').textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
        
        // Render category stats
        renderCategoryStats();
    }
    
    function renderCategoryStats() {
        const container = document.getElementById('category-stats');
        if (!container) return;
        
        const categoryStats = {};
        
        // Calculate stats per category
        Object.entries(answerState).forEach(([qId, state]) => {
            const cat = state.category || 'Unknown';
            if (!categoryStats[cat]) {
                categoryStats[cat] = { correct: 0, total: 0 };
            }
            categoryStats[cat].total++;
            if (state.correct) categoryStats[cat].correct++;
        });
        
        container.innerHTML = Object.entries(categoryStats)
            .map(([cat, stats]) => {
                const accuracy = Math.round((stats.correct / stats.total) * 100);
                return `
                    <div class="category-stat-item">
                        <span class="category-stat-name">${escapeHtml(cat)}</span>
                        <span class="category-stat-value">${accuracy}% (${stats.correct}/${stats.total})</span>
                    </div>
                `;
            }).join('');
    }
    
    function renderTrendChart() {
        const canvas = document.getElementById('trend-canvas');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const width = canvas.parentElement.clientWidth - 32;
        const height = 160;
        canvas.width = width;
        canvas.height = height;
        
        // Get last 14 days of data
        const days = [];
        for (let i = 13; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const key = date.toISOString().split('T')[0];
            days.push({
                date: key,
                accuracy: dailyStats[key]?.accuracy || 0,
                count: dailyStats[key]?.count || 0
            });
        }
        
        // Draw chart
        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        const maxAcc = 100;
        const padding = 20;
        const chartWidth = width - padding * 2;
        const chartHeight = height - padding * 2;
        
        days.forEach((day, i) => {
            const x = padding + (i / (days.length - 1)) * chartWidth;
            const y = height - padding - (day.accuracy / maxAcc) * chartHeight;
            
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        
        ctx.stroke();
        
        // Draw dots
        ctx.fillStyle = '#2563eb';
        days.forEach((day, i) => {
            const x = padding + (i / (days.length - 1)) * chartWidth;
            const y = height - padding - (day.accuracy / maxAcc) * chartHeight;
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
        });
        
        // Update trend summary
        const last7 = days.slice(-7);
        const last30 = days;
        const avg7 = last7.reduce((a, d) => a + d.accuracy, 0) / last7.filter(d => d.count > 0).length || 0;
        const avg30 = last30.reduce((a, d) => a + d.accuracy, 0) / last30.filter(d => d.count > 0).length || 0;
        const best = Math.max(...days.map(d => d.accuracy));
        
        document.getElementById('trend-7day').textContent = `${Math.round(avg7)}%`;
        document.getElementById('trend-30day').textContent = `${Math.round(avg30)}%`;
        document.getElementById('trend-best').textContent = `${best}%`;
    }
    
    function renderMissedQuestions() {
        const container = document.getElementById('missed-questions-list');
        if (!container) return;
        
        // Get questions answered incorrectly
        const missed = Object.entries(answerState)
            .filter(([_, state]) => !state.correct)
            .map(([qId, state]) => ({
                id: qId,
                question: quizData[qId]?.question || 'Unknown question',
                attempts: state.attempts || 1
            }))
            .sort((a, b) => b.attempts - a.attempts)
            .slice(0, 10);
        
        if (missed.length === 0) {
            container.innerHTML = '<p style="color: var(--muted);">No missed questions yet. Keep practicing!</p>';
            return;
        }
        
        container.innerHTML = missed.map(q => `
            <div class="missed-question-item">
                <div class="missed-question-text">${escapeHtml(q.question.substring(0, 100))}${q.question.length > 100 ? '...' : ''}</div>
                <div class="missed-question-stats">Missed ${q.attempts} time(s)</div>
            </div>
        `).join('');
    }
    
    function recordDailyStats(isCorrect) {
        const today = new Date().toISOString().split('T')[0];
        if (!dailyStats[today]) {
            dailyStats[today] = { correct: 0, total: 0, accuracy: 0, count: 0 };
        }
        dailyStats[today].total++;
        dailyStats[today].count++;
        if (isCorrect) dailyStats[today].correct++;
        dailyStats[today].accuracy = Math.round((dailyStats[today].correct / dailyStats[today].total) * 100);
        localStorage.setItem('cpsa_daily_stats', JSON.stringify(dailyStats));
    }
    
    // ==========================================
    // REVIEW MISSED QUESTIONS SYSTEM
    // ==========================================
    function setupSpacedRepetition() {
        const reviewBtn = document.getElementById('spaced-review-btn');
        
        if (reviewBtn) {
            reviewBtn.addEventListener('click', startSpacedReview);
        }
    }
    
    function startSpacedReview() {
        // Get questions that were answered incorrectly
        const incorrectIds = Object.entries(answerState)
            .filter(([_, state]) => !state.correct)
            .map(([id, _]) => id);
        
        if (incorrectIds.length === 0) {
            showToast('No questions to review! Answer some questions first.');
            return;
        }
        
        // Switch to single view mode
        setView('single');
        
        // Build question list from incorrect answers
        allQuestionIds = incorrectIds;
        currentQuestionIndex = 0;
        
        // Show first question
        showQuestion(0);
        buildNavigatorDots();
        
        showToast(`Review mode: ${incorrectIds.length} questions to review`);
    }
    
    // ==========================================
    // PDF EXPORT
    // ==========================================
    function setupPDFExport() {
        const exportBtn = document.getElementById('export-pdf-btn');
        
        if (exportBtn) {
            exportBtn.addEventListener('click', generatePDFReport);
        }
    }
    
    function generatePDFReport() {
        // Create a printable report
        const attempted = Object.keys(answerState).length;
        const correct = Object.values(answerState).filter(s => s.correct).length;
        const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
        
        const reportHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>CPSA Quiz Progress Report</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
                    h1 { color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px; }
                    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin: 30px 0; }
                    .stat { background: #f3f4f6; padding: 20px; border-radius: 10px; }
                    .stat-value { font-size: 36px; font-weight: bold; color: #2563eb; }
                    .stat-label { color: #6b7280; margin-top: 5px; }
                    .category { margin: 10px 0; padding: 10px; background: #f9fafb; border-left: 4px solid #2563eb; }
                    .footer { margin-top: 40px; color: #9ca3af; font-size: 12px; }
                </style>
            </head>
            <body>
                <h1>CPSA Practice Quiz - Progress Report</h1>
                <p>Generated on ${new Date().toLocaleDateString()}</p>
                
                <div class="stats">
                    <div class="stat">
                        <div class="stat-value">${attempted}</div>
                        <div class="stat-label">Questions Attempted</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${correct}</div>
                        <div class="stat-label">Correct Answers</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${accuracy}%</div>
                        <div class="stat-label">Overall Accuracy</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${level}</div>
                        <div class="stat-label">Current Level</div>
                    </div>
                </div>
                
                <h2>Category Performance</h2>
                ${generateCategoryReport()}
                
                <div class="footer">
                    <p>CREST CPSA Practice Quiz - https://sudosuraj.github.io/CREST/</p>
                </div>
            </body>
            </html>
        `;
        
        // Open in new window for printing
        const printWindow = window.open('', '_blank');
        printWindow.document.write(reportHTML);
        printWindow.document.close();
        printWindow.print();
    }
    
    function generateCategoryReport() {
        const categoryStats = {};
        
        Object.entries(answerState).forEach(([qId, state]) => {
            const cat = state.category || 'Unknown';
            if (!categoryStats[cat]) {
                categoryStats[cat] = { correct: 0, total: 0 };
            }
            categoryStats[cat].total++;
            if (state.correct) categoryStats[cat].correct++;
        });
        
        return Object.entries(categoryStats)
            .map(([cat, stats]) => {
                const accuracy = Math.round((stats.correct / stats.total) * 100);
                return `<div class="category"><strong>${cat}</strong>: ${stats.correct}/${stats.total} correct (${accuracy}%)</div>`;
            }).join('');
    }
    
    // ==========================================
    // CHALLENGE MODE
    // ==========================================
    function setupChallengeMode() {
        const challengeBtn = document.getElementById('challenge-link-btn');
        const challengeModal = document.getElementById('challenge-modal');
        const challengeClose = document.getElementById('challenge-modal-close');
        const generateBtn = document.getElementById('generate-challenge');
        const copyBtn = document.getElementById('copy-challenge');
        
        if (challengeBtn) {
            challengeBtn.addEventListener('click', () => openModal('challenge-modal'));
        }
        
        if (challengeClose) {
            challengeClose.addEventListener('click', () => closeModal('challenge-modal'));
        }
        
        if (generateBtn) {
            generateBtn.addEventListener('click', generateChallengeLink);
        }
        
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                const linkInput = document.getElementById('challenge-link');
                const textToCopy = linkInput.value;
                try {
                    await navigator.clipboard.writeText(textToCopy);
                    showToast('Challenge link copied!');
                } catch (err) {
                    linkInput.select();
                    document.execCommand('copy');
                    showToast('Challenge link copied!');
                }
            });
        }
        
        // Close on overlay click
        if (challengeModal) {
            challengeModal.addEventListener('click', (e) => {
                if (e.target === challengeModal) closeModal('challenge-modal');
            });
        }
        
        // Check for challenge in URL
        checkForChallenge();
    }
    
    function generateChallengeLink() {
        const numQuestions = parseInt(document.getElementById('challenge-questions').value);
        const category = document.getElementById('challenge-category').value;
        
        let questionIds;
        
        if (category === 'missed') {
            // Get missed questions using Fisher-Yates shuffle
            const missedIds = Object.entries(answerState)
                .filter(([_, state]) => !state.correct)
                .map(([id, _]) => id);
            shuffleArray(missedIds);
            questionIds = missedIds.slice(0, numQuestions);
        } else {
            // Get random questions using Fisher-Yates shuffle
            const allIds = Object.keys(quizData);
            const shuffled = [...allIds];
            shuffleArray(shuffled);
            questionIds = shuffled.slice(0, numQuestions);
        }
        
        // Create challenge URL
        const baseUrl = window.location.origin + window.location.pathname;
        const challengeData = btoa(JSON.stringify({ q: questionIds }));
        const challengeUrl = `${baseUrl}?challenge=${challengeData}`;
        
        // Show result
        document.getElementById('challenge-link').value = challengeUrl;
        document.getElementById('challenge-result').style.display = 'block';
    }
    
    function checkForChallenge() {
        const params = new URLSearchParams(window.location.search);
        const challengeData = params.get('challenge');
        
        if (challengeData) {
            try {
                const data = JSON.parse(atob(challengeData));
                if (data.q && Array.isArray(data.q)) {
                    // Start challenge mode
                    setTimeout(() => {
                        setView('single');
                        allQuestionIds = data.q;
                        currentQuestionIndex = 0;
                        showQuestion(0);
                        buildNavigatorDots();
                        showToast(`Challenge mode: ${data.q.length} questions!`);
                    }, 1000);
                }
            } catch (e) {
                console.error('Invalid challenge data');
            }
        }
    }
    
    // ==========================================
    // SPRINT MODE SETUP
    // ==========================================
    function setupSprintMode() {
        const sprintBtn = document.getElementById('start-sprint-btn');
        
        if (sprintBtn) {
            sprintBtn.addEventListener('click', () => {
                startSprint(600); // 10 minutes
            });
        }
    }
    
    // ==========================================
    // MOBILE NAVIGATION SETUP
    // ==========================================
    let closeMobileSidebar = null;

    function setupMobileNavigation() {
        const mobileNavToggle = document.getElementById('mobile-nav-toggle');
        const mobileSidebar = document.getElementById('mobile-sidebar');
        const mobileSidebarClose = document.getElementById('mobile-sidebar-close');

        if (mobileNavToggle && mobileSidebar && mobileSidebarClose) {
            const openSidebar = () => {
                mobileSidebar.classList.add('open');
                mobileNavToggle.setAttribute('aria-expanded', 'true');
                document.body.style.overflow = 'hidden';
                
                const mainContent = document.querySelector('.app-shell');
                if (mainContent) mainContent.setAttribute('aria-hidden', 'true');
                
                const firstFocusable = mobileSidebar.querySelector('button, input, select, [tabindex]:not([tabindex="-1"])');
                if (firstFocusable) firstFocusable.focus();
            };
            
            const closeSidebar = () => {
                mobileSidebar.classList.remove('open');
                mobileNavToggle.setAttribute('aria-expanded', 'false');
                document.body.style.overflow = '';
                
                const mainContent = document.querySelector('.app-shell');
                if (mainContent) mainContent.removeAttribute('aria-hidden');
                
                mobileNavToggle.focus();
            };
            
            closeMobileSidebar = closeSidebar;
            
            mobileNavToggle.addEventListener('click', openSidebar);
            mobileSidebarClose.addEventListener('click', closeSidebar);
            
            mobileSidebar.addEventListener('click', (e) => {
                if (e.target === mobileSidebar) {
                    closeSidebar();
                }
            });
            
            document.addEventListener('keydown', (e) => {
                if (!mobileSidebar.classList.contains('open')) return;
                
                if (e.key === 'Escape') {
                    closeSidebar();
                    return;
                }
                
                if (e.key === 'Tab') {
                    const focusableElements = mobileSidebar.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
                    const firstFocusable = focusableElements[0];
                    const lastFocusable = focusableElements[focusableElements.length - 1];
                    
                    if (e.shiftKey && document.activeElement === firstFocusable) {
                        e.preventDefault();
                        lastFocusable.focus();
                    } else if (!e.shiftKey && document.activeElement === lastFocusable) {
                        e.preventDefault();
                        firstFocusable.focus();
                    }
                }
            });
        }

        const mobileSearchInput = document.getElementById('mobile-search-input');
        const mobileFilterSelect = document.getElementById('mobile-filter-select');
        const desktopSearchInput = document.getElementById('search-input');
        const desktopFilterSelect = document.getElementById('filter-select');

        if (mobileSearchInput && desktopSearchInput) {
            mobileSearchInput.addEventListener('input', () => {
                desktopSearchInput.value = mobileSearchInput.value;
                applyFilters();
            });
            
            desktopSearchInput.addEventListener('input', () => {
                mobileSearchInput.value = desktopSearchInput.value;
            });
        }

        if (mobileFilterSelect && desktopFilterSelect) {
            mobileFilterSelect.addEventListener('change', () => {
                desktopFilterSelect.value = mobileFilterSelect.value;
                applyFilters();
            });
            
            desktopFilterSelect.addEventListener('change', () => {
                mobileFilterSelect.value = desktopFilterSelect.value;
            });
        }

        const mobileStudyMode = document.getElementById('mobile-study-mode');
        const mobileExamMode = document.getElementById('mobile-exam-mode');

        if (mobileStudyMode) {
            mobileStudyMode.addEventListener('click', () => {
                setMode('study');
                mobileStudyMode.classList.add('active');
                if (mobileExamMode) mobileExamMode.classList.remove('active');
            });
        }

        if (mobileExamMode) {
            mobileExamMode.addEventListener('click', () => {
                setMode('exam');
                mobileExamMode.classList.add('active');
                if (mobileStudyMode) mobileStudyMode.classList.remove('active');
            });
        }

        const mobileStartExam = document.getElementById('mobile-start-exam');
        const mobileSprintBtn = document.getElementById('mobile-sprint-btn');
        const mobileReviewIncorrect = document.getElementById('mobile-review-incorrect');
        const mobileExpandAll = document.getElementById('mobile-expand-all');
        const mobileCollapseAll = document.getElementById('mobile-collapse-all');
        const mobileResetProgress = document.getElementById('mobile-reset-progress');

        if (mobileStartExam) {
            mobileStartExam.addEventListener('click', () => {
                const examModal = document.getElementById('exam-modal');
                if (examModal) examModal.classList.add('active');
                if (closeMobileSidebar) closeMobileSidebar();
            });
        }

        if (mobileSprintBtn) {
            mobileSprintBtn.addEventListener('click', () => {
                startSprint();
                if (closeMobileSidebar) closeMobileSidebar();
            });
        }

        if (mobileReviewIncorrect) {
            mobileReviewIncorrect.addEventListener('click', () => {
                if (desktopFilterSelect) {
                    desktopFilterSelect.value = 'incorrect';
                    if (mobileFilterSelect) mobileFilterSelect.value = 'incorrect';
                    applyFilters();
                }
                if (closeMobileSidebar) closeMobileSidebar();
            });
        }

        // Legacy expand/collapse category buttons removed - category UI no longer exists

        if (mobileResetProgress) {
            mobileResetProgress.addEventListener('click', () => {
                resetProgress();
                if (closeMobileSidebar) closeMobileSidebar();
            });
        }

        updateMobileSidebarStats();
    }

    function updateMobileSidebarStats() {
        const stats = calculateStats();
        const totalQuestions = Object.keys(quizData).length;
        const streak = loadStreak();
        
        const mobileScore = document.getElementById('mobile-score');
        const mobileTotal = document.getElementById('mobile-total');
        const mobilePercentage = document.getElementById('mobile-percentage');
        const mobileStreak = document.getElementById('mobile-streak');
        const mobileAttempted = document.getElementById('mobile-attempted');

        if (mobileScore) mobileScore.textContent = stats.correct;
        if (mobileTotal) mobileTotal.textContent = totalQuestions;
        if (mobilePercentage) mobilePercentage.textContent = stats.attempted > 0 ? Math.round((stats.correct / stats.attempted) * 100) : '0';
        if (mobileStreak) mobileStreak.textContent = streak.count || 0;
        if (mobileAttempted) mobileAttempted.textContent = stats.attempted;
    }

    // ==========================================
    // INITIALIZE ALL NEW FEATURES
    // ==========================================
    document.addEventListener('DOMContentLoaded', () => {
        // Setup new features
        setupPracticeExam();
        setupAnalytics();
        setupSpacedRepetition();
        setupPDFExport();
        setupChallengeMode();
        setupSprintMode();
        setupModeToggle();
        setupViewToggle();
        setupXPSystem();
        setupShareDropdown();
        setupMobileNavigation();
        
        // Start background preloading of all appendixes
        // This runs silently in the background to improve UX
        setTimeout(() => {
            if (typeof QuizDataLoader !== 'undefined' && QuizDataLoader.preloadAllAppendixes) {
                QuizDataLoader.preloadAllAppendixes((appendixLetter, questionCount) => {
                    console.log(`Background: Appendix ${appendixLetter} ready with ${questionCount} questions`);
                    // Update the appendix card to show it's ready
                    const card = document.querySelector(`.appendix-card[data-appendix="${appendixLetter}"]`);
                    if (card) {
                        const statusEl = card.querySelector('.appendix-status');
                        if (statusEl) {
                            statusEl.textContent = `Ready (${questionCount} questions)`;
                            statusEl.classList.add('preloaded');
                        }
                    }
                });
            }
        }, 1000); // Start preloading 1 second after page load
    });
            
