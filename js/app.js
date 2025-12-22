    let score = 0; // Initialize the score
    let totalQuestions = 0; // Will be updated dynamically as questions are generated
    const chatHistory = []; // Chatbot conversation
    let chatGreeted = false; // Only show the welcome bubble once per load
    const CHAT_MAX_LENGTH = 400;
    const MAX_CHAT_TURNS = 12;
    
    // ==================== URL ROUTER ====================
    // Hash-based routing for better student navigation
    // Supports: #appendix/A, #appendix/B, #tab/review, #tab/insights, #tab/progress
    const Router = {
        currentRoute: { type: null, value: null },
        isNavigating: false,
        
        // Parse the current URL hash into a route object
        parseHash() {
            const hash = window.location.hash.slice(1); // Remove the #
            if (!hash) return { type: 'tab', value: 'study' };
            
            const parts = hash.split('/');
            if (parts.length >= 2) {
                const type = parts[0].toLowerCase();
                const value = parts[1].toUpperCase();
                
                if (type === 'appendix' && /^[A-J]$/.test(value)) {
                    return { type: 'appendix', value: value };
                }
                if (type === 'tab' && ['study', 'practice', 'review', 'insights', 'progress'].includes(parts[1].toLowerCase())) {
                    return { type: 'tab', value: parts[1].toLowerCase() };
                }
            }
            
            return { type: 'home', value: null };
        },
        
        // Navigate to a new route (updates URL and triggers navigation)
        navigate(type, value, options = {}) {
            const { replace = false, skipHandler = false } = options;
            
            let hash = '';
            if (type === 'appendix' && value) {
                hash = `#appendix/${value}`;
            } else if (type === 'tab' && value) {
                hash = `#tab/${value}`;
            }
            
            // Update URL
            if (replace) {
                history.replaceState({ type, value }, '', hash || window.location.pathname);
            } else {
                history.pushState({ type, value }, '', hash || window.location.pathname);
            }
            
            this.currentRoute = { type, value };
            
            // Update breadcrumbs
            this.updateBreadcrumbs(type, value);
            
            if (!skipHandler) {
                this.handleRoute({ type, value });
            }
        },
        
        // Go back to home (appendix selection)
        goHome(options = {}) {
            this.navigate('home', null, options);
        },
        
        // Smart back navigation - uses history.back() with fallback to home
        goBack() {
            if (window.history.length > 1) {
                window.history.back();
            } else {
                this.goHome();
            }
        },
        
        // Handle route changes (called on popstate and initial load)
        async handleRoute(route) {
            if (this.isNavigating) return;
            this.isNavigating = true;
            
            try {
                if (route.type === 'appendix' && route.value) {
                    // Load the specific appendix
                    const appendixTitle = APPENDIX_TITLES[route.value] || `Appendix ${route.value}`;
                    await loadAppendixQuiz(route.value, appendixTitle.replace(/^Appendix [A-J]: /, ''));
                } else if (route.type === 'tab' && route.value) {
                    // Switch to the specified tab - pass updateUrl: false to prevent history loop
                    if (typeof switchPanel === 'function') {
                        switchPanel(route.value, { updateUrl: false });
                    }
                } else {
                    // Home - show appendix selection
                    await loadQuiz();
                }
            } finally {
                this.isNavigating = false;
            }
        },
        
        // Update breadcrumbs based on current route
        updateBreadcrumbs(type, value) {
            const breadcrumbs = document.getElementById('breadcrumbs');
            if (!breadcrumbs) return;
            
            let html = '<a href="#" class="breadcrumb-item" data-nav="home">Home</a>';
            
            if (type === 'appendix' && value) {
                const title = APPENDIX_TITLES[value] || `Appendix ${value}`;
                html += `<span class="breadcrumb-separator">/</span>`;
                html += `<span class="breadcrumb-item active">${title}</span>`;
            } else if (type === 'tab' && value) {
                const tabName = value.charAt(0).toUpperCase() + value.slice(1);
                html += `<span class="breadcrumb-separator">/</span>`;
                html += `<span class="breadcrumb-item active">${tabName}</span>`;
            }
            
            breadcrumbs.innerHTML = html;
            
            // Add click handler for home breadcrumb
            const homeLink = breadcrumbs.querySelector('[data-nav="home"]');
            if (homeLink) {
                homeLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    Router.goHome();
                });
            }
        },
        
        // Initialize the router
        init() {
            // Handle browser back/forward buttons
            window.addEventListener('popstate', (event) => {
                const route = event.state || this.parseHash();
                this.currentRoute = route;
                this.updateBreadcrumbs(route.type, route.value);
                this.handleRoute(route);
            });
            
            // Handle initial route on page load
            const initialRoute = this.parseHash();
            this.currentRoute = initialRoute;
            this.updateBreadcrumbs(initialRoute.type, initialRoute.value);
            
            // Return the initial route so the app can handle it
            return initialRoute;
        }
    };
    
    // Make Router available globally for other modules
    window.Router = Router;
    
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
            scheduleUIUpdate();
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
            // Detect the correct base path for service worker registration
            const basePath = window.location.pathname.includes('/crest-cpsa/') ? '/crest-cpsa/' : 
                            window.location.pathname.includes('/CREST/') ? '/CREST/' : '/';
            navigator.serviceWorker.register(basePath + 'sw.js')
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
        
        // Support both old (.question-container) and new (.question-card) DOM structures
        const questionElements = document.querySelectorAll('.question-card, .question-container');
        questionElements.forEach(container => {
            const qId = container.dataset.questionId;
            const state = answerState[qId];
            const isFlagged = flaggedQuestions.has(qId);
            // Support both old (h3) and new (.question-card-text) question text elements
            const questionText = (container.querySelector('.question-card-text')?.textContent || 
                                 container.querySelector('h3')?.textContent || '').toLowerCase();
            
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
        
        // Update category visibility (for legacy category-based UI)
        document.querySelectorAll('.category-section').forEach(section => {
            const visibleQuestions = section.querySelectorAll('.question-container:not([style*="display: none"]), .question-card:not([style*="display: none"])');
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
        const stats = calculateStats();
        const streak = loadStreak();
        
        // Update Progress panel overview stats (correct IDs from HTML)
        const overallProgressEl = document.getElementById('overall-progress');
        const questionsAnsweredEl = document.getElementById('questions-answered');
        const appendicesStartedEl = document.getElementById('appendices-started');
        const currentStreakEl = document.getElementById('current-streak');
        const progressRingFill = document.getElementById('progress-ring-fill');
        
        // Calculate overall progress percentage
        const totalQuestions = Object.keys(quizData).length || 1;
        const progressPercent = Math.round((stats.attempted / totalQuestions) * 100);
        
        if (overallProgressEl) overallProgressEl.textContent = `${progressPercent}%`;
        if (questionsAnsweredEl) questionsAnsweredEl.textContent = stats.attempted;
        if (currentStreakEl) currentStreakEl.textContent = `${streak.count || 0} days`;
        
        // Count appendices started (appendices with at least one question answered)
        const appendicesWithProgress = new Set();
        Object.keys(answerState).forEach(qId => {
            const q = quizData[qId];
            if (q && q.appendix) {
                appendicesWithProgress.add(q.appendix);
            }
        });
        if (appendicesStartedEl) appendicesStartedEl.textContent = appendicesWithProgress.size;
        
        // Update progress ring SVG
        if (progressRingFill) {
            const circumference = 2 * Math.PI * 54; // r=54 from HTML
            const offset = circumference - (progressPercent / 100) * circumference;
            progressRingFill.style.strokeDasharray = `${circumference}`;
            progressRingFill.style.strokeDashoffset = `${offset}`;
        }
        
        if (!grid) return;
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
        
        // Update UI - support both old (.question-container) and new (.question-card) DOM structures
        const container = document.querySelector(`.question-card[data-question-id="${questionId}"]`) || 
                         document.querySelector(`.question-container[data-question-id="${questionId}"]`);
        if (container) {
            container.classList.toggle('flagged', flaggedQuestions.has(questionId));
            // Support both old (.flag-button) and new (.flag-btn) button classes
            const flagBtn = container.querySelector('.flag-btn') || container.querySelector('.flag-button');
            if (flagBtn) {
                flagBtn.classList.toggle('flagged', flaggedQuestions.has(questionId));
                // Update SVG fill for new UI, or text for old UI
                if (flagBtn.querySelector('svg')) {
                    flagBtn.querySelector('svg').style.fill = flaggedQuestions.has(questionId) ? 'currentColor' : 'none';
                } else {
                    flagBtn.textContent = flaggedQuestions.has(questionId) ? '[!] Flagged' : '[_] Flag';
                }
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

Practice at: https://sudosuraj.github.io/crest-cpsa/`;
    }
    
    function shareProgress() {
        const text = generateShareText();
        
        if (navigator.share) {
            navigator.share({
                title: 'My CPSA Quiz Progress',
                text: text,
                url: 'https://sudosuraj.github.io/crest-cpsa/'
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

    // ==================== CENTRALIZED UI UPDATE ====================
    let uiUpdateTimer = null;
    
    function updateAllUI() {
        updateCounts();
        updateProgressGridPanel();
        updateInsightsSummary();
        updateReviewStats();
        updateMobileSidebarStats();
        updateSidebarStats(); // Update desktop sidebar stats (event-driven, not polling)
        renderStreak();
        renderXP();
        
        // Update nav bar stats
        const stats = calculateStats();
        const percentageElement = document.getElementById("percentage");
        const accuracyBar = document.getElementById("accuracy-bar");
        const attemptedCount = document.getElementById("attempted-count");
        
        if (percentageElement) {
            const percentage = stats.attempted > 0 ? Math.round((stats.correct / stats.attempted) * 100) : 0;
            percentageElement.textContent = percentage;
        }
        if (accuracyBar) {
            const percentage = stats.attempted > 0 ? Math.round((stats.correct / stats.attempted) * 100) : 0;
            accuracyBar.style.width = `${percentage}%`;
        }
        if (attemptedCount) {
            attemptedCount.textContent = stats.attempted;
        }
    }
    
    function scheduleUIUpdate() {
        if (uiUpdateTimer) {
            clearTimeout(uiUpdateTimer);
        }
        uiUpdateTimer = setTimeout(() => {
            updateAllUI();
            uiUpdateTimer = null;
        }, 100);
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

    // Appendix-based categorization for progress tracking
    const APPENDIX_TITLES = {
        'A': 'Appendix A: Soft Skills & Assessment',
        'B': 'Appendix B: Core Technical Skills',
        'C': 'Appendix C: Background Info & Open Source',
        'D': 'Appendix D: Networking Equipment',
        'E': 'Appendix E: Microsoft Windows Security',
        'F': 'Appendix F: Unix Security Assessment',
        'G': 'Appendix G: Web Technologies',
        'H': 'Appendix H: Web Testing Methodologies',
        'I': 'Appendix I: Web Testing Techniques',
        'J': 'Appendix J: Databases',
        'K': 'Appendix K: Important Notes & Quick Reference'
    };

    function categorizeQuestion(questionObj) {
        // Use appendix metadata if available (preferred)
        if (questionObj.appendix) {
            return APPENDIX_TITLES[questionObj.appendix] || `Appendix ${questionObj.appendix}`;
        }
        if (questionObj.appendix_title) {
            return questionObj.appendix_title;
        }
        return "Unknown Appendix";
    }

    // Function to call LLM API (no key required) - Now with CONDITIONAL RAG support
    // For explain buttons: uses source_chunk_id directly if provided (more accurate, fewer tokens)
    // For general queries: only attaches RAG if query is CPSA-specific OR has high BM25 score
    async function callOpenAI(prompt, options = {}) {
        const { useRAG = false, ragQuery = null, topK = 5, sourceChunkId = null, scoreThreshold = 5.0 } = options;
        
        try {
            let systemContent = 'You are a CPSA tutor. Be concise. Plain text only, no markdown. Created by Suraj Sharma (sudosuraj).';
            let userContent = prompt;
            let sources = [];
            
            // OPTIMIZED RAG: Use source_chunk_id directly if provided (for explain buttons)
            // This is more accurate and uses fewer tokens than broad search
            if (useRAG && typeof RAG !== 'undefined' && RAG.isReady()) {
                let retrievedChunks = [];
                
                if (sourceChunkId) {
                    // Direct chunk lookup - most efficient for explain buttons
                    const sourceChunk = RAG.getChunkById(sourceChunkId);
                    if (sourceChunk) {
                        retrievedChunks = [sourceChunk];
                    }
                } else {
                    // Conditional RAG for general queries
                    const query = ragQuery || prompt;
                    const isCPSASpecific = RAG.isCPSAQuery(query);
                    const scoredResults = RAG.searchWithScores(query, topK);
                    const topScore = scoredResults.length > 0 ? scoredResults[0].score : 0;
                    
                    // Only attach RAG context if query is CPSA-specific OR has high BM25 score
                    if (isCPSASpecific || topScore >= scoreThreshold) {
                        retrievedChunks = scoredResults.map(r => r.chunk);
                    }
                }
                
                if (retrievedChunks.length > 0) {
                    // Use token-budgeted context formatting
                    const context = RAG.formatContext(retrievedChunks, { maxTokens: 2500 });
                    sources = RAG.formatSources(retrievedChunks);
                    
                    systemContent = `CPSA tutor with study notes. Cite sources when relevant. Plain text only.`;
                    userContent = `Reference material:\n${context}\n\nQuestion: ${prompt}`;
                }
            }
            
            // LLMClient is required - no direct fetch fallback to ensure rate limiting
            if (typeof LLMClient === 'undefined') {
                throw new Error('LLMClient not available - ensure llm-client.js is loaded before app.js');
            }
            
            const data = await LLMClient.requestHighPriority({
                messages: [
                    { role: 'system', content: systemContent },
                    { role: 'user', content: userContent }
                ],
                max_tokens: 400,
                temperature: 0.7
            });

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

    // Help chatbot API wrapper (keeps conversation history) - Now with CONDITIONAL RAG support
    // Only does RAG search if query is CPSA-specific (avoids unnecessary search for general questions)
    async function callTutor(messages, options = {}) {
        const { useRAG = true, scoreThreshold = 5.0 } = options;
        
        // Get the last user message for RAG query
        const lastUserMessage = messages.filter(m => m.role === 'user').pop();
        const ragQuery = lastUserMessage?.content || '';
        
        let systemContent = 'CPSA study assistant. Be concise. Plain text only. Created by Suraj Sharma (sudosuraj).';
        let sources = [];
        let contextMessage = null;
        
        // CONDITIONAL RAG: Only do RAG search if query is CPSA-specific
        // This avoids unnecessary BM25 search for general questions like "hello" or "thanks"
        if (useRAG && typeof RAG !== 'undefined' && RAG.isReady() && ragQuery) {
            // First check if query is CPSA-specific BEFORE doing any search
            const isCPSASpecific = RAG.isCPSAQuery(ragQuery);
            
            // Only do BM25 search if query is CPSA-specific
            if (isCPSASpecific) {
                const scoredResults = RAG.searchWithScores(ragQuery, 5);
                const topScore = scoredResults.length > 0 ? scoredResults[0].score : 0;
                
                // Only attach RAG context if BM25 score is high enough
                if (topScore >= scoreThreshold) {
                    const retrievedChunks = scoredResults.map(r => r.chunk);
                    
                    if (retrievedChunks.length > 0) {
                        // Use token-budgeted context formatting
                        const context = RAG.formatContext(retrievedChunks, { maxTokens: 2000 });
                        sources = RAG.formatSources(retrievedChunks);
                        
                        // Add context as a separate message to save system prompt tokens
                        contextMessage = { role: 'user', content: `[Study notes for reference]:\n${context}` };
                    }
                }
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
            // LLMClient is required - no direct fetch fallback to ensure rate limiting
            if (typeof LLMClient === 'undefined') {
                throw new Error('LLMClient not available - ensure llm-client.js is loaded before app.js');
            }
            
            const data = await LLMClient.requestHighPriority({
                messages: payload,
                max_tokens: 400,
                temperature: 0.5
            });

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

    // Function to explain question context - OPTIMIZED: uses source_chunk_id for direct lookup
    async function explainQuestion(questionText, questionId) {
        const explanationDiv = document.getElementById(`question-explanation-${questionId}`);
        const button = document.getElementById(`explain-question-btn-${questionId}`);
        
        if (explanationDiv.classList.contains('show')) {
            explanationDiv.classList.remove('show');
            button.textContent = '[AI] Explain Question';
            return;
        }

        button.disabled = true;
        button.textContent = 'Loading...';
        explanationDiv.classList.add('show', 'loading');
        explanationDiv.textContent = 'Generating explanation...';

        // Get source_chunk_id from question data for direct lookup (more efficient than search)
        const questionData = quizData[questionId];
        const sourceChunkId = questionData?.source_chunk_id || null;

        const prompt = `For this cybersecurity question: "${questionText}" - Provide background context and key concepts/terms that are relevant to understanding this question. Use the reference material provided to give accurate information from the CPSA study notes. Focus on explaining the foundational knowledge, important terms, and context needed to answer it. Keep it concise (3-4 sentences).`;
        
        const result = await callOpenAI(prompt, { 
            useRAG: true, 
            sourceChunkId,  // Direct chunk lookup - more efficient than broad search
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

    // Function to explain answer on demand - OPTIMIZED: uses source_chunk_id for direct lookup
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
            button.textContent = '[AI] Explain Answer';
            return;
        }

        // Handle both old format {selected, correct} and new format {questionText, selectedAnswer, correctAnswer, isCorrect}
        const questionData = quizData[questionId];
        const isCorrect = state.isCorrect !== undefined ? state.isCorrect : state.correct;
        const questionText = state.questionText || (questionData ? questionData.question : '');
        const selectedAnswer = state.selectedAnswer || state.selected || '';
        const correctAnswer = state.correctAnswer || (questionData ? questionData.answer : '');
        const sourceChunkId = questionData?.source_chunk_id || null;

        if (!questionText || !correctAnswer) {
            explanationDiv.classList.add('show');
            explanationDiv.textContent = 'Unable to generate explanation - question data not available.';
            return;
        }

        explanationDiv.classList.remove('correct-explanation', 'incorrect-explanation');
        explanationDiv.classList.add(isCorrect ? 'correct-explanation' : 'incorrect-explanation', 'show', 'loading');
        explanationDiv.textContent = 'Generating explanation...';
        button.disabled = true;
        button.textContent = 'Loading...';

        try {
            let prompt;
            const ragQuery = `${questionText} ${correctAnswer}`;
            
            if (isCorrect) {
                prompt = `Explain why this answer is correct using the reference material provided. Question: "${questionText}" Correct Answer: "${selectedAnswer}". Cite the relevant source if applicable. Keep it concise (2-3 sentences).`;
            } else {
                prompt = `Explain why this answer is incorrect and why the correct answer is right, using the reference material provided. Question: "${questionText}" Selected Answer: "${selectedAnswer}" Correct Answer: "${correctAnswer}". Cite the relevant source if applicable. Keep it concise (3-4 sentences).`;
            }

            const result = await callOpenAI(prompt, {
                useRAG: true,
                sourceChunkId,  // Direct chunk lookup - more efficient than broad search
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
                explanationDiv.textContent = result || 'Unable to generate explanation.';
            }
            
            button.textContent = '[AI+RAG] Hide Answer Explanation';
        } catch (error) {
            console.error('Error explaining answer:', error);
            explanationDiv.classList.remove('loading');
            explanationDiv.textContent = 'Error generating explanation. Please try again.';
        } finally {
            button.disabled = false;
        }
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
        
        // Remove active state from all tabs, then activate practice panel
        // This ensures the practice panel is visible when showing appendix selection
        document.querySelectorAll('.toolbar-tab').forEach(tab => {
            tab.classList.remove('active');
            tab.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.toolbar-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        
        // Re-activate the practice panel since appendix selection is displayed there
        const practicePanel = document.getElementById('practice-panel');
        const practiceTab = document.getElementById('tab-practice');
        if (practicePanel) practicePanel.classList.add('active');
        if (practiceTab) {
            practiceTab.classList.add('active');
            practiceTab.setAttribute('aria-selected', 'true');
        }
        
        const selectionScreen = document.createElement('div');
        selectionScreen.className = 'appendix-selection';
        selectionScreen.innerHTML = `
            <div class="appendix-hero">
                <h1>CREST CPSA Practice Quiz</h1>
                <p>Master penetration testing concepts with AI-generated questions from the study notes</p>
                <div class="hero-stats">
                    <div class="hero-stat">
                        <span class="hero-stat-value">11</span>
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
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/>
                                </svg>
                                ${chunkCount} topics
                            </div>
                            <div class="appendix-stat">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
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
                
                card.addEventListener('click', () => {
                    // Use Router to navigate - this updates URL and handles navigation
                    Router.navigate('appendix', appendix.letter, { skipHandler: true });
                    loadAppendixQuiz(appendix.letter, appendix.title);
                });
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
        
        // CRITICAL: Ensure practice panel is active before loading any content
        // This fixes the blank page bug when navigating to appendix routes
        const practicePanel = document.getElementById('practice-panel');
        const practiceTab = document.getElementById('tab-practice');
        if (practicePanel) practicePanel.classList.add('active');
        if (practiceTab) {
            practiceTab.classList.add('active');
            practiceTab.setAttribute('aria-selected', 'true');
        }
        
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
        
        // Not preloaded - use STREAMING RAG to show questions immediately as they're generated
        // This is TRUE RAG: retrieves chunks, generates questions, streams them to UI
        
        // Track questions as they stream in
        let streamedQuestions = {};
        let firstQuestionShown = false;
        
        // Initial loading state - will be replaced as soon as first question arrives
        quizContainer.innerHTML = `
            <div class="generation-progress" id="streaming-progress">
                <h2>Generating Questions for Appendix ${appendixLetter}</h2>
                <p>${appendixTitle}</p>
                <p class="generation-info">Using RAG to generate questions from study notes...</p>
                <div class="progress-bar-container">
                    <div class="progress-bar" id="generation-progress-bar"></div>
                </div>
                <p id="generation-status">Retrieving relevant content...</p>
                <p class="streaming-hint">Questions will appear as they're generated!</p>
            </div>
        `;

        try {
            // Use STREAMING RAG - questions appear immediately as they're generated!
            const result = await QuizDataLoader.loadAppendixStreaming(appendixLetter, {
                // THIS IS THE KEY: Called for EACH question as it arrives
                onQuestion: (question, id, currentCount, targetCount) => {
                    streamedQuestions[id] = question;
                    
                    // Show questions as soon as we have the first one!
                    if (!firstQuestionShown) {
                        firstQuestionShown = true;
                        // Replace loading screen with questions display
                        displayQuestionsWithPagination(streamedQuestions, appendixLetter, appendixTitle, {
                            hasMore: true,
                            currentPage: 1,
                            totalQuestions: currentCount,
                            exhausted: false,
                            isStreaming: true,
                            streamProgress: { current: currentCount, target: targetCount }
                        });
                    } else {
                        // Update the streaming indicator
                        const streamingIndicator = document.getElementById('streaming-indicator');
                        if (streamingIndicator) {
                            streamingIndicator.textContent = `Generating: ${currentCount}/${targetCount} questions`;
                        }
                        
                        // Add the new question to the display
                        addStreamedQuestion(question, id, currentCount);
                    }
                },
                
                onProgress: (progress) => {
                    // Update progress bar if still showing loading screen
                    const progressBar = document.getElementById('generation-progress-bar');
                    const statusEl = document.getElementById('generation-status');
                    if (progressBar && !firstQuestionShown) {
                        const pct = (progress.currentChunk / progress.totalChunks) * 100;
                        progressBar.style.width = `${pct}%`;
                    }
                    if (statusEl && !firstQuestionShown) {
                        statusEl.textContent = `Processing section ${progress.section} (${progress.questionsGenerated} questions)`;
                    }
                },
                
                onError: (error) => {
                    console.error('Streaming RAG error:', error);
                    // Show error but don't stop if we have some questions
                    if (Object.keys(streamedQuestions).length === 0) {
                        quizContainer.innerHTML = `
                            <p class="error">Error generating questions. Please try again.</p>
                            <button onclick="Router.goHome()">Back to Appendix Selection</button>
                        `;
                    }
                }
            });

            // Update total questions count
            totalQuestions = QuizDataLoader.getTotalQuestionCount();
            const totalElement = document.getElementById("total-questions");
            if (totalElement) {
                totalElement.textContent = totalQuestions;
            }

            // Final display update with complete results
            displayQuestionsWithPagination(result.questions, appendixLetter, appendixTitle, result);
            
            // Remove streaming indicator
            const streamingIndicator = document.getElementById('streaming-indicator');
            if (streamingIndicator) {
                streamingIndicator.remove();
            }
            
            // Automatically continue generating more questions if available
            if (result.hasMore && !result.exhausted) {
                continuouslyGenerateMoreQuestions(appendixLetter);
            }
            
        } catch (error) {
            console.error('Error generating questions:', error);
            quizContainer.innerHTML = `
                <p class="error">Error generating questions. Please try again.</p>
                <button onclick="Router.goHome()">Back to Appendix Selection</button>
            `;
        }
    }
    
    /**
     * Add a single streamed question to the display
     * Called when a new question arrives during streaming RAG
     * Matches the structure used in displayQuestionsWithPagination
     */
    function addStreamedQuestion(question, id, questionNumber) {
        const questionsContainer = document.getElementById('questions-list');
        if (!questionsContainer) return;
        
        // Create question card matching existing structure
        const questionCard = document.createElement('div');
        questionCard.classList.add('question-card', 'fade-in');
        questionCard.dataset.questionId = id;

        // Question header with number badge and actions
        const questionHeader = document.createElement('div');
        questionHeader.classList.add('question-card-header');

        const questionBadge = document.createElement('span');
        questionBadge.classList.add('question-number-badge');
        questionBadge.textContent = questionNumber;

        const questionActions = document.createElement('div');
        questionActions.classList.add('question-card-actions');

        // Flag button
        const flagBtn = document.createElement('button');
        flagBtn.classList.add('flag-btn');
        flagBtn.title = 'Flag for review';
        flagBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>`;
        flagBtn.addEventListener('click', () => toggleFlag(id));

        // Gemini explain button (disabled until user selects an option)
        const explainBtn = document.createElement('button');
        explainBtn.classList.add('gemini-btn');
        explainBtn.id = `explain-answer-btn-${id}`;
        explainBtn.title = 'Select an answer first';
        explainBtn.disabled = true;
        explainBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <defs>
                <linearGradient id="gemini-grad-${id}" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#4285f4"/>
                    <stop offset="25%" style="stop-color:#9b72cb"/>
                    <stop offset="50%" style="stop-color:#d96570"/>
                    <stop offset="75%" style="stop-color:#d96570"/>
                    <stop offset="100%" style="stop-color:#9b72cb"/>
                </linearGradient>
            </defs>
            <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" stroke="url(#gemini-grad-${id})" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        explainBtn.addEventListener('click', () => explainAnswer(id));

        questionActions.appendChild(flagBtn);
        questionActions.appendChild(explainBtn);
        questionHeader.appendChild(questionBadge);
        questionHeader.appendChild(questionActions);

        // Question text
        const questionText = document.createElement('p');
        questionText.classList.add('question-card-text');
        questionText.textContent = question.question;

        // Options
        const optionsDiv = document.createElement('div');
        optionsDiv.classList.add('question-card-options');

        const allAnswers = [question.answer, ...question.incorrect];
        shuffleArray(allAnswers);

        allAnswers.forEach((answer, index) => {
            const optionDiv = document.createElement('div');
            optionDiv.classList.add('option-tile');
            
            const optionLetter = document.createElement('span');
            optionLetter.classList.add('option-letter');
            optionLetter.textContent = String.fromCharCode(65 + index); // A, B, C, D
            
            const optionText = document.createElement('span');
            optionText.classList.add('option-text');
            optionText.textContent = answer;
            
            optionDiv.appendChild(optionLetter);
            optionDiv.appendChild(optionText);
            optionDiv.dataset.correct = answer === question.answer ? 'true' : 'false';

            optionDiv.addEventListener('click', function() {
                if (this.classList.contains('answered')) {
                    return;
                }

                const isCorrect = this.dataset.correct === 'true';
                const selectedAnswer = this.querySelector('.option-text').textContent;
                
                // Mark all options as answered
                optionsDiv.querySelectorAll('.option-tile').forEach(opt => {
                    opt.classList.add('answered');
                    if (opt.dataset.correct === 'true') {
                        opt.classList.add('correct');
                    } else if (opt === this && !isCorrect) {
                        opt.classList.add('incorrect');
                    }
                });

                // Add feedback to card
                questionCard.classList.add(isCorrect ? 'answered-correct' : 'answered-incorrect');

                // Enable the Gemini explain button now that user has answered
                explainBtn.disabled = false;
                explainBtn.title = 'Explain Answer';

                // Update answerState for progress tracking and AI explain
                answerState[id] = {
                    selected: selectedAnswer,
                    correct: isCorrect,
                    timestamp: Date.now(),
                    questionText: question.question,
                    selectedAnswer: selectedAnswer,
                    correctAnswer: question.answer,
                    isCorrect: isCorrect
                };

                // Update score
                if (isCorrect) {
                    score++;
                    addXP(10);
                    updateStreak(); // Update streak on first correct answer of the day
                }
                
                updateCounts();
                saveProgress();
                checkAndAwardBadges();
                updateAllUI(); // Update Progress/Review/Insights/Streak in real time
            });

            optionsDiv.appendChild(optionDiv);
        });

        // Answer explanation container (for AI explanations)
        const answerExplanation = document.createElement("div");
        answerExplanation.id = `answer-explanation-${id}`;
        answerExplanation.classList.add("answer-explanation");

        // Assemble the card
        questionCard.appendChild(questionHeader);
        questionCard.appendChild(questionText);
        questionCard.appendChild(optionsDiv);
        questionCard.appendChild(answerExplanation);

        questionsContainer.appendChild(questionCard);
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

            // Show streaming indicator
            const streamingIndicator = document.getElementById('streaming-indicator');
            if (streamingIndicator) {
                streamingIndicator.classList.remove('hidden');
                const streamingText = streamingIndicator.querySelector('.streaming-text');
                if (streamingText) {
                    streamingText.textContent = 'Generating more questions...';
                }
            }

        // Get current question count to know where to start numbering
        const questionsContainer = document.getElementById('questions-list');
        let currentQuestionCount = questionsContainer ? questionsContainer.children.length : 0;

        try {
            // Use streaming version for progressive question display
            const result = await QuizDataLoader.loadAppendixNextPageStreaming(letter, {
                onQuestion: (question, id) => {
                    currentQuestionCount++;
                    addStreamedQuestion(question, id, currentQuestionCount);
                    
                    // Update total questions count as each arrives
                    totalQuestions = QuizDataLoader.getTotalQuestionCount();
                    const totalElement = document.getElementById("total-questions");
                    if (totalElement) {
                        totalElement.textContent = totalQuestions;
                    }
                },
                onProgress: (progress) => {
                    if (nextPageBtn) {
                        nextPageBtn.textContent = `Generating... (${progress.questionsGenerated}/${progress.targetCount})`;
                    }
                    if (streamingIndicator) {
                        const streamingText = streamingIndicator.querySelector('.streaming-text');
                        if (streamingText) {
                            streamingText.textContent = `Generating questions... ${progress.questionsGenerated}/${progress.targetCount}`;
                        }
                    }
                },
                onComplete: (finalResult) => {
                    // Hide streaming indicator
                    if (streamingIndicator) {
                        streamingIndicator.classList.add('hidden');
                    }
                    
                    // Update pagination info
                    const paginationInfo = QuizDataLoader.getPaginationInfo(letter);
                    const paginationEl = document.getElementById('pagination-info');
                    if (paginationEl && paginationInfo) {
                        paginationEl.textContent = `Page ${paginationInfo.currentPage} of ${paginationInfo.totalPages} (${paginationInfo.totalQuestions} questions)`;
                    }
                    
                    // Update next page button
                    if (nextPageBtn) {
                        if (finalResult.hasMore) {
                            nextPageBtn.disabled = false;
                            nextPageBtn.textContent = 'Next Page (Generate More)';
                        } else {
                            nextPageBtn.textContent = 'All questions generated!';
                            nextPageBtn.disabled = true;
                        }
                    }
                },
                onError: (error) => {
                    console.error('Error generating next page:', error);
                    if (streamingIndicator) {
                        streamingIndicator.classList.add('hidden');
                    }
                    if (nextPageBtn) {
                        nextPageBtn.disabled = false;
                        nextPageBtn.textContent = 'Next Page (Generate More)';
                    }
                    showToast('Error generating questions. Please try again.', 'error');
                }
            });
            
        } catch (error) {
            console.error('Error generating next page:', error);
            if (streamingIndicator) {
                streamingIndicator.classList.add('hidden');
            }
            if (nextPageBtn) {
                nextPageBtn.disabled = false;
                nextPageBtn.textContent = 'Next Page (Generate More)';
            }
            showToast('Error generating questions. Please try again.', 'error');
        }
    }

    /**
     * Continuously generate more questions until all content is exhausted
     * This replaces the manual "Next Page" button with automatic generation
     */
    async function continuouslyGenerateMoreQuestions(appendixLetter, retryCount = 0) {
        const MAX_RETRIES = 3;
        const questionsContainer = document.getElementById('questions-list');
        if (!questionsContainer) return;

        let currentQuestionCount = questionsContainer.children.length;
        
        // Show a subtle indicator that more questions are being generated
        let continuousIndicator = document.getElementById('continuous-generation-indicator');
        if (!continuousIndicator) {
            continuousIndicator = document.createElement('div');
            continuousIndicator.id = 'continuous-generation-indicator';
            continuousIndicator.className = 'continuous-generation-indicator';
            continuousIndicator.innerHTML = `
                <span class="streaming-pulse"></span>
                <span class="streaming-text">Generating more questions...</span>
            `;
            questionsContainer.parentNode.appendChild(continuousIndicator);
        }
        continuousIndicator.classList.remove('hidden');

        try {
            const result = await QuizDataLoader.loadAppendixNextPageStreaming(appendixLetter, {
                onQuestion: (question, id) => {
                    currentQuestionCount++;
                    addStreamedQuestion(question, id, currentQuestionCount);
                    
                    // Update total questions count as each arrives
                    totalQuestions = QuizDataLoader.getTotalQuestionCount();
                    const totalElement = document.getElementById("total-questions");
                    if (totalElement) {
                        totalElement.textContent = totalQuestions;
                    }
                    
                    // Update pagination info
                    const paginationInfo = QuizDataLoader.getPaginationInfo(appendixLetter);
                    const infoEl = document.querySelector('.pagination-info');
                    if (infoEl && paginationInfo) {
                        infoEl.innerHTML = `
                            <span class="page-counter">Page ${paginationInfo.currentPage} | ${paginationInfo.totalQuestions} questions loaded</span>
                            <span class="chunk-progress">Chunks: ${paginationInfo.chunksProcessed}/${paginationInfo.totalChunks}</span>
                            ${paginationInfo.exhausted ? '<span class="exhausted-badge">All content processed</span>' : ''}
                        `;
                    }
                },
                onProgress: (progress) => {
                    const streamingText = continuousIndicator.querySelector('.streaming-text');
                    if (streamingText) {
                        streamingText.textContent = `Generating questions... ${progress.questionsGenerated}/${progress.targetCount}`;
                    }
                },
                onComplete: (finalResult) => {
                    // If there are more questions to generate, continue automatically
                    if (finalResult.hasMore && !finalResult.exhausted) {
                        // Small delay to prevent overwhelming the API
                        setTimeout(() => {
                            continuouslyGenerateMoreQuestions(appendixLetter, 0);
                        }, 500);
                    } else {
                        // All done - hide the indicator and show completion message
                        continuousIndicator.classList.add('hidden');
                        
                        // Update pagination info to show completion
                        const paginationInfo = QuizDataLoader.getPaginationInfo(appendixLetter);
                        const infoEl = document.querySelector('.pagination-info');
                        if (infoEl && paginationInfo) {
                            infoEl.innerHTML = `
                                <span class="page-counter">${paginationInfo.totalQuestions} questions generated</span>
                                <span class="chunk-progress">Chunks: ${paginationInfo.chunksProcessed}/${paginationInfo.totalChunks}</span>
                                <span class="exhausted-badge">All content processed</span>
                            `;
                        }
                        
                        console.log(`Continuous generation complete for Appendix ${appendixLetter}: ${paginationInfo ? paginationInfo.totalQuestions : 'unknown'} questions`);
                    }
                },
                onError: (error) => {
                    console.error('Error in continuous generation:', error);
                    // Retry on error if we haven't exceeded max retries
                    if (retryCount < MAX_RETRIES) {
                        console.log(`Retrying continuous generation (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                        setTimeout(() => {
                            continuouslyGenerateMoreQuestions(appendixLetter, retryCount + 1);
                        }, 2000 * (retryCount + 1));
                    } else {
                        continuousIndicator.classList.add('hidden');
                    }
                }
            });
        } catch (error) {
            console.error('Error in continuous generation:', error);
            // Retry on error if we haven't exceeded max retries
            if (retryCount < MAX_RETRIES) {
                console.log(`Retrying continuous generation (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
                setTimeout(() => {
                    continuouslyGenerateMoreQuestions(appendixLetter, retryCount + 1);
                }, 2000 * (retryCount + 1));
            } else {
                continuousIndicator.classList.add('hidden');
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
        
        // Remove active state from all tabs, then activate practice panel
        // This ensures the practice panel is visible when displaying questions
        document.querySelectorAll('.toolbar-tab').forEach(tab => {
            tab.classList.remove('active');
            tab.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.toolbar-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        
        // Re-activate the practice panel since quiz content is displayed there
        const practicePanel = document.getElementById('practice-panel');
        const practiceTab = document.getElementById('tab-practice');
        if (practicePanel) practicePanel.classList.add('active');
        if (practiceTab) {
            practiceTab.classList.add('active');
            practiceTab.setAttribute('aria-selected', 'true');
        }

        quizContainer.innerHTML = '';

        // Add header with back button and pagination info
        const header = document.createElement('div');
        header.className = 'quiz-header-pagination';
        
        const backBtn = document.createElement('button');
        backBtn.className = 'back-to-selection back-btn';
        backBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg> Back';
        backBtn.addEventListener('click', () => Router.goHome());
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

        // Add streaming indicator if questions are being streamed
        if (paginationResult.isStreaming) {
            const streamingIndicator = document.createElement('div');
            streamingIndicator.id = 'streaming-indicator';
            streamingIndicator.className = 'streaming-indicator';
            const progress = paginationResult.streamProgress || { current: 0, target: 20 };
            streamingIndicator.innerHTML = `
                <span class="streaming-pulse"></span>
                <span class="streaming-text">Generating: ${progress.current}/${progress.target} questions</span>
            `;
            quizContainer.appendChild(streamingIndicator);
        }

        // Create questions container - flat list without categories
        // ID is 'questions-list' so addStreamedQuestion can find it
        const questionsContainer = document.createElement('div');
        questionsContainer.id = 'questions-list';
        questionsContainer.className = 'questions-container flat-list';

        // Render questions as flat list (no category grouping)
        // Shuffle question order for variety (options are also shuffled within each question)
        const questionKeys = Object.keys(questions);
        shuffleArray(questionKeys);
        
        let questionNumber = 1;
        questionKeys.forEach(key => {
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
            explainBtn.addEventListener("click", () => explainAnswer(key));

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
                    const selectedAnswer = this.querySelector(".option-text").textContent;
                    
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

                    // Update answerState for progress tracking and AI explain
                    answerState[key] = {
                        selected: selectedAnswer,
                        correct: isCorrect,
                        timestamp: Date.now(),
                        questionText: questionObj.question,
                        selectedAnswer: selectedAnswer,
                        correctAnswer: questionObj.answer,
                        isCorrect: isCorrect
                    };

                    // Update score
                    if (isCorrect) {
                        score++;
                        correctAnswers++;
                        addXP(10);
                        updateStreak(); // Update streak on first correct answer of the day
                    }
                    answeredQuestions++;
                    
                    updateCounts();
                    saveProgress();
                    checkAndAwardBadges();
                    updateAllUI(); // Update Progress/Review/Insights/Streak in real time
                });

                optionsDiv.appendChild(optionDiv);
            });

            // Answer explanation container (for AI explanations)
            const answerExplanation = document.createElement("div");
            answerExplanation.id = `answer-explanation-${key}`;
            answerExplanation.classList.add("answer-explanation");

            // Assemble the card
            questionCard.appendChild(questionHeader);
            questionCard.appendChild(questionText);
            questionCard.appendChild(optionsDiv);
            questionCard.appendChild(answerExplanation);

            questionsContainer.appendChild(questionCard);
            questionNumber++;
        });

        quizContainer.appendChild(questionsContainer);

        // Show completion message only when all content is exhausted
        // (No "Next Page" button - questions are generated continuously)
        if (paginationInfo.exhausted) {
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
        
            // Setup mobile menu toggle
            const mobileMenuBtn = document.getElementById("mobile-menu-btn");
            const sideNav = document.getElementById("side-nav");
            const mobileNavOverlay = document.getElementById("mobile-nav-overlay");
        
            if (mobileMenuBtn && sideNav) {
                mobileMenuBtn.addEventListener("click", () => {
                    sideNav.classList.toggle('open');
                    if (mobileNavOverlay) {
                        mobileNavOverlay.hidden = !sideNav.classList.contains('open');
                    }
                });
            
                // Close sidebar when clicking overlay
                if (mobileNavOverlay) {
                    mobileNavOverlay.addEventListener("click", () => {
                        sideNav.classList.remove('open');
                        mobileNavOverlay.hidden = true;
                    });
                }
            
                // Close sidebar when clicking a nav button on mobile
                const navButtons = sideNav.querySelectorAll('.nav-btn');
                navButtons.forEach(btn => {
                    btn.addEventListener("click", () => {
                        if (window.innerWidth <= 768) {
                            sideNav.classList.remove('open');
                            if (mobileNavOverlay) mobileNavOverlay.hidden = true;
                        }
                    });
                });
            }
        
            // Setup sidebar collapse
        const sideNavCollapse = document.getElementById("side-nav-collapse");
        if (sideNavCollapse && sideNav) {
            const savedCollapsed = localStorage.getItem('cpsa_sidebar_collapsed') === 'true';
            if (savedCollapsed) {
                sideNav.classList.add('collapsed');
            }
            sideNavCollapse.addEventListener("click", () => {
                sideNav.classList.toggle('collapsed');
                const isCollapsed = sideNav.classList.contains('collapsed');
                localStorage.setItem('cpsa_sidebar_collapsed', isCollapsed);
                sideNavCollapse.setAttribute('aria-expanded', !isCollapsed);
            });
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
        const moreBtn = document.getElementById('more-actions-btn');
        const moreMenu = document.getElementById('more-menu');
        const reviewFlaggedBtn = document.getElementById('review-flagged-btn');
        const reviewIncorrectBtn = document.getElementById('review-incorrect-btn');
        const mainContent = document.getElementById('main-content');
        
        // Tab switching - use centralized switchPanel for consistent routing
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
                
                // Use centralized switchPanel which handles URL updates
                switchPanel(tabName);
                
                // Update tab-specific content
                if (tabName === 'insights') {
                    updateInsightsSummary();
                }
                if (tabName === 'review') {
                    updateReviewStats();
                }
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
                // flaggedQuestions is a Set, convert to array directly
                const flaggedIds = Array.from(flaggedQuestions);
                
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
        
        // Review incorrect button
        if (reviewIncorrectBtn) {
            reviewIncorrectBtn.addEventListener('click', () => {
                // Get questions that were answered incorrectly
                const incorrectIds = Object.entries(answerState)
                    .filter(([_, state]) => !state.correct)
                    .map(([id, _]) => id);
                
                if (incorrectIds.length === 0) {
                    showToast('No incorrect questions to review! Answer some questions first.');
                    return;
                }
                
                setView('single');
                allQuestionIds = incorrectIds;
                currentQuestionIndex = 0;
                showQuestion(0);
                buildNavigatorDots();
                showToast(`Reviewing ${incorrectIds.length} incorrect questions`);
            });
        }
    }
    
    // Update insights summary
    function updateInsightsSummary() {
        const attempted = Object.keys(answerState).length;
        const correct = Object.values(answerState).filter(s => s.correct).length;
        const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
        
        // Update Insights panel stats (correct IDs from HTML)
        const totalAttemptedEl = document.getElementById('total-attempted');
        const totalCorrectEl = document.getElementById('total-correct');
        const overallAccuracyEl = document.getElementById('overall-accuracy');
        const studyTimeEl = document.getElementById('study-time');
        
        if (totalAttemptedEl) totalAttemptedEl.textContent = attempted;
        if (totalCorrectEl) totalCorrectEl.textContent = correct;
        if (overallAccuracyEl) overallAccuracyEl.textContent = `${accuracy}%`;
        
        // Update study time
        if (studyTimeEl) {
            const totalMinutes = getStudyTime();
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            studyTimeEl.textContent = `${hours}h ${minutes}m`;
        }
    }
    
    // Update review stats
    function updateReviewStats() {
        const incorrectCount = Object.values(answerState).filter(s => !s.correct).length;
        // flaggedQuestions is a Set, use .size instead of Object.values()
        const flaggedCount = flaggedQuestions.size;
        
        // Update Review panel stats (correct IDs from HTML)
        const incorrectEl = document.getElementById('incorrect-count');
        const flaggedEl = document.getElementById('flagged-count');
        
        if (incorrectEl) incorrectEl.textContent = incorrectCount;
        if (flaggedEl) flaggedEl.textContent = flaggedCount;
        
        // Update sidebar review badge (shows total items needing review)
        const reviewBadge = document.getElementById('review-count');
        if (reviewBadge) {
            const totalReviewCount = incorrectCount + flaggedCount;
            reviewBadge.textContent = totalReviewCount;
        }
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
        const listBtn = document.getElementById('list-view-btn');
        const singleBtn = document.getElementById('single-view-btn');
        const singleNav = document.getElementById('single-question-nav');
        const navigator = document.getElementById('question-navigator');
        
        // Guard: view toggle elements only exist when quiz is displayed
        if (!listBtn || !singleBtn || !singleNav || !navigator) {
            return;
        }
        
        currentView = view;
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
        
        const url = 'https://sudosuraj.github.io/crest-cpsa/';
        
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
            const shouldShow = typeof show === "boolean" ? show : !panel.classList.contains("open");
            panel.classList.toggle("open", shouldShow);
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
	
	// Helper function to activate a panel - used during startup to ensure a panel is always active
	    function activatePanel(panelId) {
	        // Deactivate all tabs and panels first
	        document.querySelectorAll('.toolbar-tab').forEach(tab => {
	            tab.classList.remove('active');
	            tab.setAttribute('aria-selected', 'false');
	        });
	        document.querySelectorAll('.toolbar-panel').forEach(panel => {
	            panel.classList.remove('active');
	        });
        
	        // Activate the specified panel and tab
	        const panel = document.getElementById(`${panelId}-panel`);
	        const tab = document.getElementById(`tab-${panelId}`);
	        if (panel) panel.classList.add('active');
	        if (tab) {
	            tab.classList.add('active');
	            tab.setAttribute('aria-selected', 'true');
	        }
	        
	        // Notify PDF viewer iframe when Notes panel becomes visible
	        if (panelId === 'notes') {
	            const pdfViewer = document.getElementById('pdf-viewer');
	            if (pdfViewer && pdfViewer.contentWindow) {
	                pdfViewer.contentWindow.postMessage({ type: 'panelVisible' }, window.location.origin);
	            }
	        }
	    }

	    document.addEventListener("DOMContentLoaded", async () => {
	        // Load saved progress first
	        loadProgress();
        
	        // Initialize the Router and get the initial route from URL hash
	        const initialRoute = Router.init();
        
	        // Handle initial route - either load specific appendix or show home
	        if (initialRoute.type === 'appendix' && initialRoute.value) {
	            // Deep link to specific appendix - load it directly
	            const appendixTitle = APPENDIX_TITLES[initialRoute.value] || `Appendix ${initialRoute.value}`;
	            await loadAppendixQuiz(initialRoute.value, appendixTitle.replace(/^Appendix [A-J]: /, ''));
	        } else if (initialRoute.type === 'tab' && initialRoute.value) {
	            // Deep link to specific tab - load home first, then switch tab
	            await loadQuiz();
	            activatePanel(initialRoute.value);
	        } else {
	            // Default: show appendix selection and activate Practice panel
	            await loadQuiz();
	            activatePanel('practice');
	        }
        
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
        
        // Restore answered questions UI - support both old and new DOM structures
        Object.entries(answerState).forEach(([qId, state]) => {
            const container = document.querySelector(`.question-card[data-question-id="${qId}"]`) ||
                             document.querySelector(`.question-container[data-question-id="${qId}"]`);
            if (!container) return;
            
            // Mark container as answered
            container.classList.add(state.correct ? 'answered-correct' : 'answered-incorrect');
            
            // Find and select the answered option - support both old (.option) and new (.option-tile) structures
            const options = container.querySelectorAll('.option-tile, .option');
            options.forEach(optionDiv => {
                // For new UI (.option-tile), check data-correct attribute
                if (optionDiv.classList.contains('option-tile')) {
                    optionDiv.classList.add('answered');
                    const optionText = optionDiv.querySelector('.option-text')?.textContent;
                    if (optionDiv.dataset.correct === 'true') {
                        optionDiv.classList.add('correct');
                    }
                    if (optionText === state.selectedAnswer && !state.correct) {
                        optionDiv.classList.add('incorrect');
                    }
                } else {
                    // For old UI (.option), check input value
                    const input = optionDiv.querySelector('input');
                    if (!input) return;
                    
                    input.disabled = true;
                    
                    if (input.value === state.correctAnswer) {
                        optionDiv.classList.add('correct');
                    }
                    
                    if (input.value === state.selectedAnswer) {
                        input.checked = true;
                        if (!state.correct) {
                            optionDiv.classList.add('incorrect');
                        }
                    }
                }
            });
            
            // Enable explain answer button
            const explainBtn = document.getElementById(`explain-answer-btn-${qId}`);
            if (explainBtn) {
                explainBtn.disabled = false;
            }
        });
        
        // Restore flagged questions UI - support both old and new DOM structures
        flaggedQuestions.forEach(qId => {
            const container = document.querySelector(`.question-card[data-question-id="${qId}"]`) ||
                             document.querySelector(`.question-container[data-question-id="${qId}"]`);
            if (container) {
                container.classList.add('flagged');
                const flagBtn = container.querySelector('.flag-btn') || container.querySelector('.flag-button');
                if (flagBtn) {
                    flagBtn.classList.add('flagged');
                    if (flagBtn.querySelector('svg')) {
                        flagBtn.querySelector('svg').style.fill = 'currentColor';
                    } else {
                        flagBtn.textContent = '[!] Flagged';
                    }
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
                    <p>CREST CPSA Practice Quiz - https://sudosuraj.github.io/crest-cpsa/</p>
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
    
    // ==========================================
    // P2P STATUS INDICATOR
    // ==========================================
    function setupP2PStatusIndicator() {
        const statusEl = document.getElementById('p2p-status');
        const countEl = document.getElementById('p2p-online-count');
        
        if (!statusEl || !countEl) return;
        
        function updateP2PStatus() {
            if (typeof P2PSync === 'undefined' || !P2PSync.isAvailable()) {
                statusEl.style.display = 'none';
                return;
            }
            
            statusEl.style.display = 'flex';
            const onlineCount = P2PSync.getOnlineCount();
            countEl.textContent = onlineCount;
            
            const stats = P2PSync.getStats();
            if (stats.questionsReceived > 0 || stats.questionsSent > 0) {
                statusEl.classList.add('syncing');
                statusEl.title = 'P2P Sync: ' + stats.questionsSent + ' sent, ' + stats.questionsReceived + ' received';
            } else {
                statusEl.classList.remove('syncing');
                statusEl.title = 'P2P Question Sync';
            }
        }
        
        updateP2PStatus();
        setInterval(updateP2PStatus, 5000);
        
        if (typeof P2PSync !== 'undefined') {
            P2PSync.onQuestionReceived(() => {
                updateP2PStatus();
                statusEl.classList.add('syncing');
                setTimeout(() => statusEl.classList.remove('syncing'), 2000);
            });
        }
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
    // API KEY SETTINGS
    // ==========================================
    function setupApiKeySettings() {
        const modal = document.getElementById('api-key-modal');
        const btn = document.getElementById('api-key-btn');
        const closeBtn = document.getElementById('api-key-modal-close');
        const saveBtn = document.getElementById('save-api-key');
        const clearBtn = document.getElementById('clear-api-key');
        const input = document.getElementById('api-key-input');
        const status = document.getElementById('api-key-status');
        const indicator = document.getElementById('api-key-indicator');
        
        if (!modal || !btn) return;
        
        function updateStatus() {
            if (typeof LLMClient !== 'undefined' && LLMClient.hasApiKey()) {
                status.textContent = 'API key is set';
                status.className = 'api-key-status success';
                indicator.hidden = false;
            } else {
                status.textContent = 'No API key set (using shared quota)';
                status.className = 'api-key-status';
                indicator.hidden = true;
            }
        }
        
        function openModal() {
            modal.setAttribute('aria-hidden', 'false');
            modal.classList.add('show');
            updateStatus();
        }
        
        function closeModal() {
            modal.setAttribute('aria-hidden', 'true');
            modal.classList.remove('show');
            input.value = '';
        }
        
        btn.addEventListener('click', openModal);
        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        
        saveBtn.addEventListener('click', () => {
            const key = input.value.trim();
            if (key) {
                if (typeof LLMClient !== 'undefined' && LLMClient.setApiKey(key)) {
                    showToast('API key saved successfully');
                    updateStatus();
                    input.value = '';
                } else {
                    showToast('Failed to save API key', 'error');
                }
            } else {
                showToast('Please enter an API key', 'error');
            }
        });
        
        clearBtn.addEventListener('click', () => {
            if (typeof LLMClient !== 'undefined') {
                LLMClient.clearApiKey();
                showToast('API key cleared');
                updateStatus();
            }
        });
        
        updateStatus();
    }

    // ==========================================
    // DESKTOP SIDEBAR NAVIGATION
    // ==========================================
    
    // Centralized panel switching function (avoids brittle .click() delegation)
    // options.updateUrl: whether to update the URL (default: true)
    function switchPanel(panelName, options = {}) {
        const { updateUrl = true } = options;
        const toolbarTabs = document.querySelectorAll('.toolbar-tab');
        const toolbarPanels = document.querySelectorAll('.toolbar-panel');
        const sidebarNavItems = document.querySelectorAll('.sidebar-nav-item');
        
        // Update toolbar tabs
        toolbarTabs.forEach(tab => {
            const isActive = tab.dataset.tab === panelName;
            tab.classList.toggle('active', isActive);
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        
        // Update toolbar panels
        toolbarPanels.forEach(panel => {
            panel.classList.toggle('active', panel.id === `${panelName}-panel`);
        });
        
        // Update sidebar nav items
        sidebarNavItems.forEach(nav => {
            const isActive = nav.dataset.panel === panelName;
            nav.classList.toggle('active', isActive);
            nav.setAttribute('aria-current', isActive ? 'page' : 'false');
        });
        
        // Update URL for deep linking (only for non-practice tabs)
        if (updateUrl && panelName !== 'practice' && typeof Router !== 'undefined') {
            Router.navigate('tab', panelName, { skipHandler: true });
        }
    }
    
    // Update sidebar stats (called from updateAllUI, not setInterval)
    function updateSidebarStats() {
        const percentage = document.getElementById('percentage');
        const streakCount = document.getElementById('streak-count');
        const attemptedCount = document.getElementById('attempted-count');
        
        const sidebarAccuracy = document.getElementById('sidebar-accuracy');
        const sidebarStreak = document.getElementById('sidebar-streak');
        const sidebarAttempted = document.getElementById('sidebar-attempted');
        
        if (percentage && sidebarAccuracy) {
            sidebarAccuracy.textContent = percentage.textContent + '%';
        }
        if (streakCount && sidebarStreak) {
            sidebarStreak.textContent = streakCount.textContent;
        }
        if (attemptedCount && sidebarAttempted) {
            sidebarAttempted.textContent = attemptedCount.textContent;
        }
    }
    
    function setupDesktopSidebar() {
        const sidebarNavItems = document.querySelectorAll('.sidebar-nav-item');
        
        // Sidebar nav clicks use centralized switchPanel
        sidebarNavItems.forEach(item => {
            item.addEventListener('click', () => {
                const panel = item.dataset.panel;
                if (panel === 'practice') {
                    // Always go to appendix cards page and update URL
                    Router.navigate('home', null, { skipHandler: true });
                    loadQuiz();
                }
                switchPanel(panel);
            });
        });
        
        // Note: Toolbar tab clicks are handled by setupTabbedToolbar() to avoid double-binding
        
        // Sidebar action buttons - call functions directly instead of .click()
        const sidebarStartExam = document.getElementById('sidebar-start-exam');
        const sidebarSprint = document.getElementById('sidebar-sprint');
        
        if (sidebarStartExam) {
            sidebarStartExam.addEventListener('click', () => {
                if (typeof startPracticeExam === 'function') {
                    startPracticeExam();
                } else {
                    // Fallback to clicking the button if function not available
                    const startExamBtn = document.getElementById('start-exam-btn');
                    if (startExamBtn) startExamBtn.click();
                }
            });
        }
        
        if (sidebarSprint) {
            sidebarSprint.addEventListener('click', () => {
                if (typeof startSprintMode === 'function') {
                    startSprintMode();
                } else {
                    // Fallback to clicking the button if function not available
                    const startSprintBtn = document.getElementById('start-sprint-btn');
                    if (startSprintBtn) startSprintBtn.click();
                }
            });
        }
        
        // Initial sidebar stats update
        updateSidebarStats();
    }

        // ==========================================
        // COMMAND PALETTE SEARCH
        // ==========================================
        function setupCommandPalette() {
            const searchTrigger = document.getElementById('search-trigger');
            const commandPalette = document.getElementById('command-palette');
            const commandSearch = document.getElementById('command-search');
            const commandResults = document.getElementById('command-results');
        
            if (!searchTrigger || !commandPalette || !commandSearch || !commandResults) return;
        
            function openCommandPalette() {
                commandPalette.hidden = false;
                commandSearch.value = '';
                commandSearch.focus();
                renderResults('');
            }
        
            function closeCommandPalette() {
                commandPalette.hidden = true;
                commandSearch.value = '';
            }
        
            function renderResults(query) {
                const lowerQuery = query.toLowerCase().trim();
                let html = '';
            
                const appendices = [
                    { letter: 'A', title: 'Soft Skills and Assessment Management' },
                    { letter: 'B', title: 'Core Technical Skills' },
                    { letter: 'C', title: 'Background Information Gathering & Open Source Intelligence' },
                    { letter: 'D', title: 'Networking Equipment' },
                    { letter: 'E', title: 'Microsoft Windows Security Assessment' },
                    { letter: 'F', title: 'Unix Security Assessment' },
                    { letter: 'G', title: 'Web Technologies' },
                    { letter: 'H', title: 'Web Testing Methodologies' },
                    { letter: 'I', title: 'Web Testing Techniques' },
                    { letter: 'J', title: 'Databases' }
                ];
            
                const filteredAppendices = appendices.filter(a => 
                    !lowerQuery || 
                    a.letter.toLowerCase().includes(lowerQuery) || 
                    a.title.toLowerCase().includes(lowerQuery)
                );
            
                if (filteredAppendices.length > 0) {
                    html += '<div class="command-group"><div class="command-group-title">Appendices</div>';
                    filteredAppendices.forEach(a => {
                        html += `<button class="command-item" data-action="appendix" data-value="${a.letter}">
                            <strong>Appendix ${a.letter}:</strong> ${a.title}
                        </button>`;
                    });
                    html += '</div>';
                }
            
                const panels = [
                    { id: 'practice', title: 'Practice', desc: 'Start practicing questions' },
                    { id: 'review', title: 'Review', desc: 'Review incorrect and flagged questions' },
                    { id: 'insights', title: 'Insights', desc: 'View performance analytics' },
                    { id: 'progress', title: 'Progress', desc: 'Track your learning journey' }
                ];
            
                const filteredPanels = panels.filter(p => 
                    !lowerQuery || 
                    p.title.toLowerCase().includes(lowerQuery) || 
                    p.desc.toLowerCase().includes(lowerQuery)
                );
            
                if (filteredPanels.length > 0) {
                    html += '<div class="command-group"><div class="command-group-title">Navigation</div>';
                    filteredPanels.forEach(p => {
                        html += `<button class="command-item" data-action="panel" data-value="${p.id}">
                            <strong>${p.title}</strong> - ${p.desc}
                        </button>`;
                    });
                    html += '</div>';
                }
            
                if (lowerQuery && lowerQuery.length >= 2) {
                    html += '<div class="command-group"><div class="command-group-title">Search in PDF</div>';
                    html += `<button class="command-item" data-action="search-pdf" data-value="${encodeURIComponent(query)}">
                        <strong>Search in Study Notes:</strong> "${escapeHtml(query)}"
                    </button>`;
                    html += '</div>';
                }
            
                if (!html) {
                    html = '<div class="command-group"><div class="command-group-title">No results found</div></div>';
                }
            
                commandResults.innerHTML = html;
            
                commandResults.querySelectorAll('.command-item').forEach(item => {
                    item.addEventListener('click', () => {
                        const action = item.dataset.action;
                        const value = item.dataset.value;
                    
                        if (action === 'appendix') {
                            const appendix = appendices.find(a => a.letter === value);
                            if (appendix) {
                                Router.navigate('appendix', value, { skipHandler: true });
                                loadAppendixQuiz(value, appendix.title);
                            }
                        } else if (action === 'panel') {
                            if (typeof switchPanel === 'function') {
                                switchPanel(value);
                            }
                        } else if (action === 'search-pdf') {
                            if (typeof switchPanel === 'function') {
                                switchPanel('study');
                            }
                            const pdfViewer = document.getElementById('pdf-viewer');
                            if (pdfViewer && pdfViewer.contentWindow) {
                                pdfViewer.contentWindow.postMessage({ type: 'search', query: decodeURIComponent(value) }, window.location.origin);
                            }
                        }
                    
                        closeCommandPalette();
                    });
                });
            }
        
            searchTrigger.addEventListener('click', openCommandPalette);
        
            commandPalette.addEventListener('click', (e) => {
                if (e.target === commandPalette) {
                    closeCommandPalette();
                }
            });
        
            commandSearch.addEventListener('input', (e) => {
                renderResults(e.target.value);
            });
        
            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                    e.preventDefault();
                    if (commandPalette.hidden) {
                        openCommandPalette();
                    } else {
                        closeCommandPalette();
                    }
                }
                if (e.key === 'Escape' && !commandPalette.hidden) {
                    closeCommandPalette();
                }
            });
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
            setupApiKeySettings();
            setupDesktopSidebar();
            setupCommandPalette();
            
            // Setup "Start Practice" button on Study page
            const goToPracticeBtn = document.getElementById('go-to-practice-btn');
            if (goToPracticeBtn) {
                goToPracticeBtn.addEventListener('click', () => {
                    if (typeof switchPanel === 'function') {
                        switchPanel('practice', { updateUrl: true });
                    }
                });
            }
        
        // Setup P2P status indicator updates
        setupP2PStatusIndicator();
        
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
            
