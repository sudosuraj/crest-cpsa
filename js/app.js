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
                
                if (type === 'appendix' && /^[A-K]$/.test(value)) {
                    return { type: 'appendix', value: value };
                }
                if (type === 'tab' && ['study', 'practice', 'exam', 'review', 'insights', 'progress'].includes(parts[1].toLowerCase())) {
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
                showToast(`${badge.icon} ${badge.name}`, {
                    variant: 'badge',
                    title: 'Badge Earned!',
                    duration: 5000
                });
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
    // Enhanced toast notification system with interactive SVG animations
    function showToast(message, options = {}) {
        const duration = typeof options === 'number' ? options : (options.duration || 4000);
        const variant = options.variant || 'info';
        const title = options.title || null;
        const action = options.action || null;
        
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        
        const toast = document.createElement('div');
        toast.className = `toast toast-${variant}`;
        
        // SVG icons for different variants
        const icons = {
            info: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
            success: `<svg class="toast-icon toast-icon-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" class="success-circle"/><path d="M9 12l2 2 4-4" class="success-check"/></svg>`,
            error: `<svg class="toast-icon toast-icon-error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15" class="error-x"/><line x1="9" y1="9" x2="15" y2="15" class="error-x"/></svg>`,
            badge: `<svg class="toast-icon toast-icon-badge" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" class="badge-star"/></svg>
                    <div class="toast-sparkles">
                        <span class="sparkle s1"></span><span class="sparkle s2"></span><span class="sparkle s3"></span><span class="sparkle s4"></span>
                    </div>`,
            levelup: `<svg class="toast-icon toast-icon-levelup" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" class="levelup-ring"/><path d="M12 16V8M8 12l4-4 4 4" class="levelup-arrow"/></svg>
                      <div class="toast-glow"></div>`,
            streak: `<svg class="toast-icon toast-icon-streak" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c0 4-4 6-4 10a4 4 0 0 0 8 0c0-4-4-6-4-10z" class="flame-outer"/><path d="M12 8c0 2-2 3-2 5a2 2 0 0 0 4 0c0-2-2-3-2-5z" class="flame-inner"/></svg>`
        };
        
        // Build toast content
        let content = `
            <div class="toast-icon-wrapper">
                ${icons[variant] || icons.info}
            </div>
            <div class="toast-content">
                ${title ? `<div class="toast-title">${title}</div>` : ''}
                <div class="toast-message">${message}</div>
                ${action ? `<button class="toast-action" data-action="${action.id || 'default'}">${action.label}</button>` : ''}
            </div>
            <button class="toast-close" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        `;
        
        // Add confetti for badge/levelup variants
        if (variant === 'badge' || variant === 'levelup') {
            content += `<div class="toast-confetti">
                <span class="confetti c1"></span><span class="confetti c2"></span><span class="confetti c3"></span>
                <span class="confetti c4"></span><span class="confetti c5"></span><span class="confetti c6"></span>
            </div>`;
        }
        
        toast.innerHTML = content;
        container.appendChild(toast);
        
        // Auto-dismiss timer
        let timeoutId;
        const startTimer = () => {
            timeoutId = setTimeout(() => {
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            }, duration);
        };
        
        // Pause on hover for interactivity
        toast.addEventListener('mouseenter', () => clearTimeout(timeoutId));
        toast.addEventListener('mouseleave', startTimer);
        
        // Close button
        toast.querySelector('.toast-close').addEventListener('click', () => {
            clearTimeout(timeoutId);
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        });
        
        // Action button handler
        const actionBtn = toast.querySelector('.toast-action');
        if (actionBtn && action && action.onClick) {
            actionBtn.addEventListener('click', () => {
                action.onClick();
                clearTimeout(timeoutId);
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 300);
            });
        }
        
        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
            startTimer();
        });
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
        
        // Calculate overall progress percentage using canonical total from examQuizData (803 questions)
        // quizData only contains dynamically loaded questions, so we use examQuizData for the true total
        const totalQuestions = (typeof examQuizData !== 'undefined' && Object.keys(examQuizData).length > 0) 
            ? Object.keys(examQuizData).length 
            : 803; // Fallback to known total
        // Include ALL answered questions (both practice and exam) for progress
        const totalAttempted = Object.keys(answerState).length;
        const progressPercent = Math.min(100, Math.round((totalAttempted / totalQuestions) * 100));
        
        if (overallProgressEl) overallProgressEl.textContent = `${progressPercent}%`;
        if (questionsAnsweredEl) questionsAnsweredEl.textContent = stats.attempted;
        if (currentStreakEl) currentStreakEl.textContent = `${streak.count || 0} days`;
        
        // Count appendices/categories started (appendices with at least one question answered)
        const appendicesWithProgress = new Set();
        Object.keys(answerState).forEach(qId => {
            const q = getQuestionById(qId);
            if (q) {
                if (isExamQuestion(qId)) {
                    appendicesWithProgress.add('Exam');
                } else if (q.appendix) {
                    appendicesWithProgress.add(q.appendix);
                }
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
        
        // Group practice questions by category
        Object.entries(quizData).forEach(([id, q]) => {
            const category = categorizeQuestion(q);
            if (!categorizedQuestions[category]) {
                categorizedQuestions[category] = [];
            }
            categorizedQuestions[category].push(id);
        });
        
        // Add exam questions as a separate category if any have been answered
        const examAnsweredIds = Object.keys(answerState).filter(qId => isExamQuestion(qId));
        if (examAnsweredIds.length > 0 || (typeof examQuizData !== 'undefined' && Object.keys(examQuizData).length > 0)) {
            const examCategory = 'Exam Questions';
            if (!categorizedQuestions[examCategory]) {
                categorizedQuestions[examCategory] = [];
            }
            // Add all exam question IDs that have been answered
            examAnsweredIds.forEach(qId => {
                if (!categorizedQuestions[examCategory].includes(qId)) {
                    categorizedQuestions[examCategory].push(qId);
                }
            });
        }
        
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
        
        // Update all UI panels to reflect the flag change across all pages
        updateAllUI();
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
            
            // Reset explain answer button (icon-only)
            const explainBtn = container.querySelector(".gemini-btn[id^='explain-answer-btn-']");
            if (explainBtn) {
                explainBtn.disabled = true;
                explainBtn.title = 'Select an answer first';
                // Reset to outline icon
                const qId = key;
                explainBtn.innerHTML = getGeminiIcon(qId);
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
            updateAdditionalVisualizations(); // Update new KPIs and charts
        
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

    // ==================== CROSS-PAGE HELPER FUNCTIONS ====================
    // These helpers enable all pages to work with both practice and exam questions
    
    // Check if a question ID is from the exam panel
    function isExamQuestion(qId) {
        return qId && qId.startsWith('exam_');
    }
    
    // Get the base ID for an exam question (strips 'exam_' prefix)
    function getBaseExamId(qId) {
        return isExamQuestion(qId) ? qId.substring(5) : qId;
    }
    
    // Unified question lookup - resolves from both quizData and examQuizData
    function getQuestionById(qId) {
        // First check quizData (practice questions)
        if (quizData[qId]) {
            return quizData[qId];
        }
        // For exam questions, look up in examQuizData
        if (isExamQuestion(qId) && typeof examQuizData !== 'undefined') {
            const baseId = getBaseExamId(qId);
            const examQ = examQuizData[baseId];
            if (examQ) {
                // Return with exam-specific metadata
                return {
                    ...examQ,
                    appendix: examQ.appendix || 'Exam',
                    appendix_title: examQ.appendix_title || 'Exam Questions',
                    isExam: true
                };
            }
        }
        return null;
    }
    
    // Get category for any question ID (works for both practice and exam)
    function getCategoryForQuestion(qId) {
        const question = getQuestionById(qId);
        if (!question) return 'Unknown';
        if (isExamQuestion(qId) && !question.appendix) {
            return 'Exam Questions';
        }
        return categorizeQuestion(question);
    }

    // Function to call LLM API(no key required) - Now with CONDITIONAL RAG support
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

    // Help chatbot API wrapper (keeps conversation history) - Simplified without RAG for faster responses
    async function callTutor(messages) {
        const systemContent = 'CPSA study assistant. Be concise. Plain text only. Created by Suraj Sharma (sudosuraj).';
        
        // Build payload - simple system message + conversation
        const payload = [
            {
                role: 'system',
                content: systemContent
            },
            ...messages
        ];

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

            return data.choices?.[0]?.message?.content?.trim() || 'No reply received.';
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
        button.innerHTML = '<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';
        explanationDiv.classList.add('show', 'loading');
        explanationDiv.innerHTML = '<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';

        // Get question data for context
        const questionData = quizData[questionId];
        const correctAnswer = questionData?.answer || '';

        // Simple prompt without RAG - just explain the question and correct answer
        const prompt = `For this CPSA cybersecurity question: "${questionText}"

Correct Answer: "${correctAnswer}"

Provide background context and key concepts/terms that are relevant to understanding this question. Focus on explaining the foundational knowledge, important terms, and context needed to answer it. Keep it concise (3-4 sentences).`;
        
        // Call without RAG for faster response
        const result = await callOpenAI(prompt, { useRAG: false });

        explanationDiv.classList.remove('loading');
        explanationDiv.textContent = result || 'Unable to generate explanation.';
        
        button.disabled = false;
        button.textContent = '[AI] Hide Explanation';
    }

    // Cache for AI explanations to avoid repeated LLM calls
    const explanationCache = {};
    
    // Function to explain answer on demand - simplified to only explain why selected answer is right/wrong
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

        // Toggle: if already showing and not loading, hide it (no LLM call needed)
        if (explanationDiv.classList.contains('show') && !explanationDiv.classList.contains('loading')) {
            explanationDiv.classList.remove('show');
            // Restore the icon-only button
            button.innerHTML = getGeminiIcon(questionId);
            button.title = 'Show explanation';
            return;
        }

        // Check cache first - if we have a cached explanation, show it without LLM call
        if (explanationCache[questionId]) {
            const cached = explanationCache[questionId];
            explanationDiv.classList.remove('correct-explanation', 'incorrect-explanation', 'loading');
            explanationDiv.classList.add(cached.isCorrect ? 'correct-explanation' : 'incorrect-explanation', 'show');
            explanationDiv.textContent = cached.explanation;
            // Update button to show "hide" state with icon only
            button.innerHTML = getGeminiIconFilled(questionId);
            button.title = 'Hide explanation';
            return;
        }

        // Handle both old format {selected, correct} and new format {questionText, selectedAnswer, correctAnswer, isCorrect}
        const questionData = quizData[questionId];
        const isCorrect = state.isCorrect !== undefined ? state.isCorrect : state.correct;
        const questionText = state.questionText || (questionData ? questionData.question : '');
        const selectedAnswer = state.selectedAnswer || state.selected || '';
        const correctAnswer = state.correctAnswer || (questionData ? questionData.answer : '');

        if (!questionText || !correctAnswer) {
            explanationDiv.classList.add('show');
            explanationDiv.textContent = 'Unable to generate explanation - question data not available.';
            return;
        }

        explanationDiv.classList.remove('correct-explanation', 'incorrect-explanation');
        explanationDiv.classList.add(isCorrect ? 'correct-explanation' : 'incorrect-explanation', 'show', 'loading');
        explanationDiv.innerHTML = '<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';
        button.disabled = true;
        button.innerHTML = '<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';

        try {
            // Simplified prompt - only explain why the selected answer is right or wrong
            let prompt;
            
            if (isCorrect) {
                prompt = `Question: "${questionText}"
Your Answer: "${selectedAnswer}"

You answered correctly. Briefly explain why "${selectedAnswer}" is the right answer in 2-3 sentences.`;
            } else {
                prompt = `Question: "${questionText}"
Your Answer: "${selectedAnswer}"
Correct Answer: "${correctAnswer}"

You answered incorrectly. Briefly explain why "${selectedAnswer}" is wrong and why "${correctAnswer}" is correct in 2-3 sentences.`;
            }

            // Call without RAG for faster response
            const result = await callOpenAI(prompt, { useRAG: false });
            const explanation = result || 'Unable to generate explanation.';

            // Cache the result
            explanationCache[questionId] = {
                explanation: explanation,
                isCorrect: isCorrect
            };

            explanationDiv.classList.remove('loading');
            explanationDiv.textContent = explanation;
            
            // Update button to show "hide" state with filled icon
            button.innerHTML = getGeminiIconFilled(questionId);
            button.title = 'Hide explanation';
        } catch (error) {
            console.error('Error explaining answer:', error);
            explanationDiv.classList.remove('loading');
            explanationDiv.textContent = 'Error generating explanation. Please try again.';
            // Restore icon on error
            button.innerHTML = getGeminiIcon(questionId);
        } finally {
            button.disabled = false;
        }
    }
    
    // Helper function to get the Gemini icon SVG (outline version)
    function getGeminiIcon(id) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none">
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
    }
    
    // Helper function to get the Gemini icon SVG (filled version for active state)
    function getGeminiIconFilled(id) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20">
            <defs>
                <linearGradient id="gemini-grad-filled-${id}" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" style="stop-color:#4285f4"/>
                    <stop offset="25%" style="stop-color:#9b72cb"/>
                    <stop offset="50%" style="stop-color:#d96570"/>
                    <stop offset="75%" style="stop-color:#d96570"/>
                    <stop offset="100%" style="stop-color:#9b72cb"/>
                </linearGradient>
            </defs>
            <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="url(#gemini-grad-filled-${id})"/>
        </svg>`;
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
        
                // Show API key modal if no API key is set (one-time per session)
                const hasApiKey = typeof LLMClient !== 'undefined' && LLMClient.hasApiKey();
                const modalShownThisSession = sessionStorage.getItem('api_key_modal_shown') === 'true';
                if (!hasApiKey && !modalShownThisSession && typeof window.openApiKeyModal === 'function') {
                    sessionStorage.setItem('api_key_modal_shown', 'true');
                    window.openApiKeyModal();
                }
        
                // Track questions as they stream in
                let streamedQuestions = {};
                let firstQuestionShown = false;
        
        // Initial loading state - will be replaced as soon as first question arrives
        quizContainer.innerHTML = `
            <div class="generation-progress" id="streaming-progress">
                <div class="ai-loader">
                    <svg class="neural-network" viewBox="0 0 200 120" width="200" height="120">
                        <!-- Neural network nodes -->
                        <circle class="node node-1" cx="30" cy="30" r="8"/>
                        <circle class="node node-2" cx="30" cy="60" r="8"/>
                        <circle class="node node-3" cx="30" cy="90" r="8"/>
                        <circle class="node node-4" cx="100" cy="45" r="10"/>
                        <circle class="node node-5" cx="100" cy="75" r="10"/>
                        <circle class="node node-6" cx="170" cy="60" r="12"/>
                        <!-- Connection lines -->
                        <line class="connection c1" x1="38" y1="30" x2="90" y2="45"/>
                        <line class="connection c2" x1="38" y1="30" x2="90" y2="75"/>
                        <line class="connection c3" x1="38" y1="60" x2="90" y2="45"/>
                        <line class="connection c4" x1="38" y1="60" x2="90" y2="75"/>
                        <line class="connection c5" x1="38" y1="90" x2="90" y2="45"/>
                        <line class="connection c6" x1="38" y1="90" x2="90" y2="75"/>
                        <line class="connection c7" x1="110" y1="45" x2="158" y2="60"/>
                        <line class="connection c8" x1="110" y1="75" x2="158" y2="60"/>
                        <!-- Data flow particles -->
                        <circle class="particle p1" r="3"/>
                        <circle class="particle p2" r="3"/>
                        <circle class="particle p3" r="3"/>
                    </svg>
                    <div class="ai-loader-text">
                        <span class="ai-status">AI Processing</span>
                        <span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>
                    </div>
                </div>
                <h2>Generating Questions for Appendix ${appendixLetter}</h2>
                <p class="appendix-subtitle">${appendixTitle}</p>
                <div class="generation-stages">
                    <div class="stage active" id="stage-retrieve">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                        <span>Retrieving content</span>
                    </div>
                    <div class="stage" id="stage-generate">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v3m6.366 1.634-2.122 2.122M21 12h-3m-1.634 6.366-2.122-2.122M12 21v-3m-6.366-1.634 2.122-2.122M3 12h3m1.634-6.366 2.122 2.122"/></svg>
                        <span>Generating questions</span>
                    </div>
                    <div class="stage" id="stage-validate">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        <span>Validating output</span>
                    </div>
                </div>
                <div class="progress-bar-container">
                    <div class="progress-bar" id="generation-progress-bar"></div>
                </div>
                <p id="generation-status" class="status-text">Analyzing study materials...</p>
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
                    showToast('Error generating questions. Please try again.', { variant: 'error' });
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
                <div class="mini-loader"><span></span><span></span><span></span></div>
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

    // ==================== EXAM PANEL ====================
    // Exam panel uses pre-loaded questions from examQuizData (CREST repo)
    // Questions are shuffled on every load for variety
    
    const EXAM_STORAGE_KEY = 'cpsa_exam_progress';
    const examAnswerState = {};
    let examScore = 0;
    let examLoaded = false;
    
    function loadExamProgress() {
        try {
            const saved = localStorage.getItem(EXAM_STORAGE_KEY);
            if (saved) {
                const data = JSON.parse(saved);
                examScore = data.score || 0;
                Object.assign(examAnswerState, data.answerState || {});
                return data;
            }
        } catch (e) {
            console.error('Error loading exam progress:', e);
        }
        return null;
    }
    
    function saveExamProgress() {
        try {
            const data = {
                score: examScore,
                answerState: examAnswerState,
                lastUpdated: Date.now()
            };
            localStorage.setItem(EXAM_STORAGE_KEY, JSON.stringify(data));
            scheduleUIUpdate();
        } catch (e) {
            console.error('Error saving exam progress:', e);
        }
    }
    
    function loadExamQuiz() {
        const examContainer = document.getElementById('exam-container');
        if (!examContainer) return;
        
        // Load saved exam progress
        loadExamProgress();
        
        // Get all questions from examQuizData and shuffle them
        const questionKeys = Object.keys(examQuizData);
        shuffleArray(questionKeys);
        
        const totalQuestions = questionKeys.length;
        
        // Clear container and build UI
        examContainer.innerHTML = '';
        
        // Add header
        const header = document.createElement('div');
        header.className = 'quiz-header-pagination';
        
        const titleEl = document.createElement('h2');
        titleEl.className = 'appendix-quiz-title';
        titleEl.textContent = 'CPSA Exam Practice';
        header.appendChild(titleEl);
        
        const infoEl = document.createElement('div');
        infoEl.className = 'pagination-info';
        const examAttempted = Object.keys(examAnswerState).length;
        const examCorrect = Object.values(examAnswerState).filter(a => a.correct).length;
        const examAccuracy = examAttempted > 0 ? Math.round((examCorrect / examAttempted) * 100) : 0;
        infoEl.innerHTML = `
            <span class="page-counter">${totalQuestions} questions available</span>
            <span class="chunk-progress">Attempted: ${examAttempted} | Correct: ${examCorrect} | Accuracy: ${examAccuracy}%</span>
        `;
        header.appendChild(infoEl);
        
        // Add shuffle button
        const shuffleBtn = document.createElement('button');
        shuffleBtn.className = 'action-btn';
        shuffleBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg> Shuffle Questions';
        shuffleBtn.addEventListener('click', () => loadExamQuiz());
        header.appendChild(shuffleBtn);
        
        examContainer.appendChild(header);
        
        // Create questions container
        const questionsContainer = document.createElement('div');
        questionsContainer.id = 'exam-questions-list';
        questionsContainer.className = 'questions-container flat-list';
        
        let questionNumber = 1;
        questionKeys.forEach(key => {
            const questionObj = examQuizData[key];
            const examKey = `exam_${key}`;
            
            const questionCard = document.createElement('div');
            questionCard.classList.add('question-card');
            questionCard.dataset.questionId = examKey;
            
            // Check if already answered
            if (examAnswerState[examKey]) {
                questionCard.classList.add(examAnswerState[examKey].correct ? 'answered-correct' : 'answered-incorrect');
            }
            
            // Question header
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
            flagBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>';
            flagBtn.addEventListener('click', () => toggleFlag(examKey));
            
            // Explain button
            const explainBtn = document.createElement('button');
            explainBtn.classList.add('gemini-btn');
            explainBtn.id = `explain-answer-btn-${examKey}`;
            explainBtn.title = 'Select an answer first';
            explainBtn.disabled = !examAnswerState[examKey];
            explainBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none">
                <defs>
                    <linearGradient id="gemini-grad-${examKey}" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style="stop-color:#4285f4"/>
                        <stop offset="25%" style="stop-color:#9b72cb"/>
                        <stop offset="50%" style="stop-color:#d96570"/>
                        <stop offset="75%" style="stop-color:#d96570"/>
                        <stop offset="100%" style="stop-color:#9b72cb"/>
                    </linearGradient>
                </defs>
                <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="url(#gemini-grad-${examKey})"/>
            </svg>`;
            explainBtn.addEventListener('click', () => explainExamAnswer(examKey, questionObj));
            
            questionActions.appendChild(flagBtn);
            questionActions.appendChild(explainBtn);
            questionHeader.appendChild(questionBadge);
            questionHeader.appendChild(questionActions);
            
            // Question text
            const questionText = document.createElement('div');
            questionText.classList.add('question-card-text');
            questionText.textContent = questionObj.question;
            
            // Options container
            const optionsDiv = document.createElement('div');
            optionsDiv.classList.add('question-card-options');
            
            const allAnswers = [questionObj.answer, ...questionObj.incorrect];
            shuffleArray(allAnswers);
            
            allAnswers.forEach((answer, index) => {
                const optionDiv = document.createElement('div');
                optionDiv.classList.add('option-tile');
                
                const optionLetter = document.createElement('span');
                optionLetter.classList.add('option-letter');
                optionLetter.textContent = String.fromCharCode(65 + index);
                
                const optionText = document.createElement('span');
                optionText.classList.add('option-text');
                optionText.textContent = answer;
                
                optionDiv.appendChild(optionLetter);
                optionDiv.appendChild(optionText);
                optionDiv.dataset.correct = answer === questionObj.answer ? 'true' : 'false';
                
                // Restore previous answer state
                if (examAnswerState[examKey]) {
                    optionDiv.classList.add('answered');
                    if (optionDiv.dataset.correct === 'true') {
                        optionDiv.classList.add('correct');
                    } else if (examAnswerState[examKey].selectedAnswer === answer) {
                        optionDiv.classList.add('incorrect');
                    }
                }
                
                optionDiv.addEventListener('click', function() {
                    if (this.classList.contains('answered')) return;
                    
                    const isCorrect = this.dataset.correct === 'true';
                    const selectedAnswer = this.querySelector('.option-text').textContent;
                    
                    optionsDiv.querySelectorAll('.option-tile').forEach(opt => {
                        opt.classList.add('answered');
                        if (opt.dataset.correct === 'true') {
                            opt.classList.add('correct');
                        } else if (opt === this && !isCorrect) {
                            opt.classList.add('incorrect');
                        }
                    });
                    
                    questionCard.classList.add(isCorrect ? 'answered-correct' : 'answered-incorrect');
                    
                    explainBtn.disabled = false;
                    explainBtn.title = 'Explain Answer';
                    
                    examAnswerState[examKey] = {
                        selected: selectedAnswer,
                        correct: isCorrect,
                        timestamp: Date.now(),
                        questionText: questionObj.question,
                        selectedAnswer: selectedAnswer,
                        correctAnswer: questionObj.answer,
                        isCorrect: isCorrect
                    };
                    
                    // Also update main answerState for unified progress tracking
                    answerState[examKey] = examAnswerState[examKey];
                    
                    if (isCorrect) {
                        examScore++;
                        score++;
                        addXP(10);
                        updateStreak();
                    }
                    
                    updateCounts();
                    saveExamProgress();
                    saveProgress();
                    checkAndAwardBadges();
                    updateAllUI();
                    updateExamStats();
                });
                
                optionsDiv.appendChild(optionDiv);
            });
            
            // Answer explanation container
            const answerExplanation = document.createElement('div');
            answerExplanation.id = `answer-explanation-${examKey}`;
            answerExplanation.classList.add('answer-explanation');
            
            questionCard.appendChild(questionHeader);
            questionCard.appendChild(questionText);
            questionCard.appendChild(optionsDiv);
            questionCard.appendChild(answerExplanation);
            
            questionsContainer.appendChild(questionCard);
            questionNumber++;
        });
        
        examContainer.appendChild(questionsContainer);
        
        // Update stats
        updateExamStats();
        examLoaded = true;
    }
    
    function updateExamStats() {
        const examAttempted = Object.keys(examAnswerState).length;
        const examCorrect = Object.values(examAnswerState).filter(a => a.correct).length;
        const examAccuracy = examAttempted > 0 ? Math.round((examCorrect / examAttempted) * 100) : 0;
        
        const infoEl = document.querySelector('#exam-container .pagination-info');
        if (infoEl) {
            const totalQuestions = Object.keys(examQuizData).length;
            infoEl.innerHTML = `
                <span class="page-counter">${totalQuestions} questions available</span>
                <span class="chunk-progress">Attempted: ${examAttempted} | Correct: ${examCorrect} | Accuracy: ${examAccuracy}%</span>
            `;
        }
    }
    
    // Cache for exam AI explanations to avoid repeated LLM calls
    const examExplanationCache = {};
    
    async function explainExamAnswer(examKey, questionObj) {
        const state = examAnswerState[examKey];
        const explanationDiv = document.getElementById(`answer-explanation-${examKey}`);
        const button = document.getElementById(`explain-answer-btn-${examKey}`);
        if (!explanationDiv || !button) return;

        if (!state) {
            explanationDiv.classList.add('show');
            explanationDiv.textContent = 'Answer the question first to get an explanation.';
            return;
        }

        // Toggle: if already showing and not loading, hide it (no LLM call needed)
        if (explanationDiv.classList.contains('show') && !explanationDiv.classList.contains('loading')) {
            explanationDiv.classList.remove('show');
            // Restore the icon-only button
            button.innerHTML = getGeminiIcon(examKey);
            button.title = 'Show explanation';
            return;
        }

        // Check cache first - if we have a cached explanation, show it without LLM call
        if (examExplanationCache[examKey]) {
            const cached = examExplanationCache[examKey];
            explanationDiv.classList.remove('correct-explanation', 'incorrect-explanation', 'loading');
            explanationDiv.classList.add(cached.isCorrect ? 'correct-explanation' : 'incorrect-explanation', 'show');
            explanationDiv.textContent = cached.explanation;
            // Update button to show "hide" state with filled icon
            button.innerHTML = getGeminiIconFilled(examKey);
            button.title = 'Hide explanation';
            return;
        }

        const isCorrect = state.isCorrect;
        const questionText = questionObj.question;
        const selectedAnswer = state.selectedAnswer;
        const correctAnswer = questionObj.answer;

        if (!questionText || !correctAnswer) {
            explanationDiv.classList.add('show');
            explanationDiv.textContent = 'Unable to generate explanation - question data not available.';
            return;
        }

        explanationDiv.classList.remove('correct-explanation', 'incorrect-explanation');
        explanationDiv.classList.add(isCorrect ? 'correct-explanation' : 'incorrect-explanation', 'show', 'loading');
        explanationDiv.innerHTML = '<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';
        button.disabled = true;
        button.innerHTML = '<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';

        try {
            // Simplified prompt - only explain why the selected answer is right or wrong
            let prompt;
            
            if (isCorrect) {
                prompt = `Question: "${questionText}"
Your Answer: "${selectedAnswer}"

You answered correctly. Briefly explain why "${selectedAnswer}" is the right answer in 2-3 sentences.`;
            } else {
                prompt = `Question: "${questionText}"
Your Answer: "${selectedAnswer}"
Correct Answer: "${correctAnswer}"

You answered incorrectly. Briefly explain why "${selectedAnswer}" is wrong and why "${correctAnswer}" is correct in 2-3 sentences.`;
            }

            // Call without RAG for faster response
            const result = await callOpenAI(prompt, { useRAG: false });
            const explanation = result || 'Unable to generate explanation.';

            // Cache the result
            examExplanationCache[examKey] = {
                explanation: explanation,
                isCorrect: isCorrect
            };

            explanationDiv.classList.remove('loading');
            explanationDiv.textContent = explanation;
            
            // Update button to show "hide" state with filled icon
            button.innerHTML = getGeminiIconFilled(examKey);
            button.title = 'Hide explanation';
        } catch (error) {
            console.error('Error explaining exam answer:', error);
            explanationDiv.classList.remove('loading');
            explanationDiv.textContent = 'Error generating explanation. Please try again.';
            // Restore icon on error
            button.innerHTML = getGeminiIcon(examKey);
        } finally {
            button.disabled = false;
        }
    }

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
                
                // Render flagged questions into the review panel
                renderReviewQuestions(flaggedIds, 'Flagged Questions');
                showToast(`Showing ${flaggedIds.length} flagged questions`);
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
                
                // Render incorrect questions into the review panel
                renderReviewQuestions(incorrectIds, 'Incorrect Questions');
                showToast(`Showing ${incorrectIds.length} incorrect questions`);
            });
        }
    }
    
    // Update insights summary
    function updateInsightsSummary() {
        // Include ALL questions (both practice and exam) for insights
        const allAnswers = Object.entries(answerState);
        const attempted = allAnswers.length;
        const correct = allAnswers.filter(([, s]) => s.correct).length;
        const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : 0;
        
        // Update Insights panel stats (correct IDs from HTML)
        const totalAttemptedEl = document.getElementById('total-attempted');
        const totalCorrectEl = document.getElementById('total-correct');
        const overallAccuracyEl = document.getElementById('overall-accuracy');
        const studyTimeEl = document.getElementById('study-time');
        
        if (totalAttemptedEl) totalAttemptedEl.textContent = attempted;
        if (totalCorrectEl) totalCorrectEl.textContent = correct;
        if (overallAccuracyEl) overallAccuracyEl.textContent = `${accuracy}%`;
        
        // Update study time (getStudyTime() returns seconds, not minutes)
        if (studyTimeEl) {
            const currentSession = Math.floor((Date.now() - sessionStartTime) / 1000);
            const totalSeconds = getStudyTime() + currentSession;
            const totalMinutes = Math.floor(totalSeconds / 60);
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            studyTimeEl.textContent = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        }
        
        // Render charts and stats
        renderAccuracyDonut();
        renderCategoryStats();
        renderWeakAreas();
    }
    
    // Update review stats
    function updateReviewStats() {
        // Include ALL questions (both practice and exam) for review stats
        const allAnswers = Object.entries(answerState);
        const incorrectCount = allAnswers.filter(([, s]) => !s.correct).length;
        // Include ALL flagged questions (both practice and exam)
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
        
        // Render review donut chart
        renderReviewDonut();
    }
    
    // Render questions into the review panel's #review-list container
    function renderReviewQuestions(questionIds, title) {
        const reviewList = document.getElementById('review-list');
        if (!reviewList) return;
        
        if (questionIds.length === 0) {
            reviewList.innerHTML = '<p class="placeholder-text">No questions to review</p>';
            return;
        }
        
        let html = `<h3 class="review-section-title">${escapeHtml(title)} (${questionIds.length})</h3>`;
        
        questionIds.forEach((qId, index) => {
            // Use unified getQuestionById to resolve from both quizData and examQuizData
            const question = getQuestionById(qId);
            const state = answerState[qId];
            const isFlagged = flaggedQuestions.has(qId);
            const isExam = isExamQuestion(qId);
            
            // Handle case where question data is not available (e.g., from previous session)
            const questionText = question?.question || 'Question data not available - please reload the appendix';
            const correctAnswer = question?.answer || 'N/A';
            const selectedAnswer = state?.selectedAnswer || 'N/A';
            const isCorrect = state?.correct || false;
            const explanation = question?.explanation || '';
            const appendix = isExam ? 'Exam' : (question?.appendix || '');
            const appendixTitle = question?.appendix_title || '';
            
            html += `
                <div class="review-question-card ${isCorrect ? 'correct' : 'incorrect'} ${isFlagged ? 'flagged' : ''}" data-question-id="${qId}">
                    <div class="review-question-header">
                        <span class="review-question-number">#${index + 1}</span>
                        ${appendix ? `<span class="review-question-appendix">${isExam ? 'Exam' : 'Appendix ' + appendix}</span>` : ''}
                        <span class="review-question-status ${isCorrect ? 'correct' : 'incorrect'}">${isCorrect ? 'Correct' : 'Incorrect'}</span>
                        ${isFlagged ? '<span class="review-question-flag">Flagged</span>' : ''}
                    </div>
                    <div class="review-question-text">${escapeHtml(questionText)}</div>
                    <div class="review-answer-section">
                        <div class="review-answer ${isCorrect ? 'correct' : 'incorrect'}">
                            <span class="review-answer-label">Your answer:</span>
                            <span class="review-answer-text">${escapeHtml(selectedAnswer)}</span>
                        </div>
                        ${!isCorrect ? `
                        <div class="review-answer correct">
                            <span class="review-answer-label">Correct answer:</span>
                            <span class="review-answer-text">${escapeHtml(correctAnswer)}</span>
                        </div>
                        ` : ''}
                    </div>
                    ${explanation ? `
                    <div class="review-explanation">
                        <span class="review-explanation-label">Explanation:</span>
                        <p>${escapeHtml(explanation)}</p>
                    </div>
                    ` : ''}
                    <div class="review-question-actions">
                        <button class="action-btn small" onclick="toggleFlag('${qId}')">${isFlagged ? 'Unflag' : 'Flag for later'}</button>
                    </div>
                </div>
            `;
        });
        
        reviewList.innerHTML = html;
    }
    
    // Render category performance stats for insights panel
    function renderCategoryStats() {
        const categoryStatsEl = document.getElementById('category-stats');
        if (!categoryStatsEl) return;
        
        // Calculate stats per appendix/category - include ALL questions (practice and exam)
        const categoryStats = {};
        Object.entries(answerState).forEach(([qId, state]) => {
            // Use unified getQuestionById to resolve from both quizData and examQuizData
            const question = getQuestionById(qId);
            const isExam = isExamQuestion(qId);
            const category = isExam ? 'Exam' : (question?.appendix || 'Unknown');
            const categoryTitle = isExam ? 'Exam Questions' : (question?.appendix_title || category);
            
            if (!categoryStats[category]) {
                categoryStats[category] = { 
                    title: categoryTitle,
                    attempted: 0, 
                    correct: 0,
                    isExam: isExam
                };
            }
            categoryStats[category].attempted++;
            if (state.correct) {
                categoryStats[category].correct++;
            }
        });
        
        if (Object.keys(categoryStats).length === 0) {
            categoryStatsEl.innerHTML = '<p class="placeholder-text">Complete some questions to see category performance</p>';
            return;
        }
        
        // Sort by appendix letter (Exam goes last)
        const sortedCategories = Object.entries(categoryStats)
            .sort(([a, statsA], [b, statsB]) => {
                if (statsA.isExam) return 1;
                if (statsB.isExam) return -1;
                return a.localeCompare(b);
            });
        
        let html = '';
        sortedCategories.forEach(([category, stats]) => {
            const accuracy = stats.attempted > 0 ? Math.round((stats.correct / stats.attempted) * 100) : 0;
            const barColor = accuracy >= 80 ? 'var(--success)' : accuracy >= 60 ? 'var(--warning)' : 'var(--danger)';
            const categoryLabel = stats.isExam ? 'Exam Questions' : `Appendix ${category}: ${escapeHtml(stats.title)}`;
            
            html += `
                <div class="category-stat-item">
                    <div class="category-stat-header">
                        <span class="category-stat-name">${categoryLabel}</span>
                        <span class="category-stat-accuracy">${accuracy}%</span>
                    </div>
                    <div class="category-stat-bar">
                        <div class="category-stat-fill" style="width: ${accuracy}%; background: ${barColor}"></div>
                    </div>
                    <div class="category-stat-details">
                        ${stats.correct}/${stats.attempted} correct
                    </div>
                </div>
            `;
        });
        
        categoryStatsEl.innerHTML = html;
    }
    
    // Render weak areas analysis for insights panel
    function renderWeakAreas() {
        const weakAreasEl = document.getElementById('weak-areas');
        if (!weakAreasEl) return;
        
        // Calculate stats per appendix/category - include ALL questions (practice and exam)
        const categoryStats = {};
        Object.entries(answerState).forEach(([qId, state]) => {
            // Use unified getQuestionById to resolve from both quizData and examQuizData
            const question = getQuestionById(qId);
            const isExam = isExamQuestion(qId);
            const category = isExam ? 'Exam' : (question?.appendix || 'Unknown');
            const categoryTitle = isExam ? 'Exam Questions' : (question?.appendix_title || category);
            
            if (!categoryStats[category]) {
                categoryStats[category] = { 
                    title: categoryTitle,
                    attempted: 0, 
                    correct: 0,
                    isExam: isExam
                };
            }
            categoryStats[category].attempted++;
            if (state.correct) {
                categoryStats[category].correct++;
            }
        });
        
        // Find weak areas (categories with accuracy < 70% and at least 3 questions attempted)
        const weakAreas = Object.entries(categoryStats)
            .filter(([_, stats]) => {
                const accuracy = stats.attempted > 0 ? (stats.correct / stats.attempted) * 100 : 0;
                return stats.attempted >= 3 && accuracy < 70;
            })
            .map(([category, stats]) => ({
                category,
                title: stats.title,
                accuracy: Math.round((stats.correct / stats.attempted) * 100),
                attempted: stats.attempted,
                correct: stats.correct,
                isExam: stats.isExam
            }))
            .sort((a, b) => a.accuracy - b.accuracy);
        
        if (weakAreas.length === 0) {
            // Include ALL questions for total count
            const totalAttempted = Object.keys(answerState).length;
            if (totalAttempted < 10) {
                weakAreasEl.innerHTML = '<p class="placeholder-text">Complete more questions to identify weak areas</p>';
            } else {
                weakAreasEl.innerHTML = '<p class="placeholder-text success">Great job! No weak areas identified</p>';
            }
            return;
        }
        
        let html = '<ul class="weak-areas-list">';
        weakAreas.slice(0, 5).forEach(area => {
            const areaLabel = area.isExam ? 'Exam Questions' : `Appendix ${area.category}`;
            html += `
                <li class="weak-area-item">
                    <span class="weak-area-name">${areaLabel}</span>
                    <span class="weak-area-accuracy">${area.accuracy}% (${area.correct}/${area.attempted})</span>
                </li>
            `;
        });
        html += '</ul>';
        
        weakAreasEl.innerHTML = html;
    }
    
    // Render SVG donut chart for accuracy visualization
    function renderAccuracyDonut() {
        const container = document.getElementById('accuracy-donut');
        if (!container) return;
        
        // Include ALL questions (both practice and exam) for accuracy stats
        const allAnswers = Object.entries(answerState);
        const attempted = allAnswers.length;
        const correct = allAnswers.filter(([, s]) => s.correct).length;
        const incorrect = attempted - correct;
        
        if (attempted === 0) {
            container.innerHTML = `
                <div class="donut-placeholder">
                    <svg width="120" height="120" viewBox="0 0 120 120">
                        <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border)" stroke-width="12"/>
                    </svg>
                    <div class="donut-center">
                        <span class="donut-value">--</span>
                        <span class="donut-label">No data</span>
                    </div>
                </div>
            `;
            return;
        }
        
        const accuracy = Math.round((correct / attempted) * 100);
        const circumference = 2 * Math.PI * 50;
        const correctDash = (correct / attempted) * circumference;
        const incorrectDash = (incorrect / attempted) * circumference;
        
        // Color based on accuracy
        const accuracyColor = accuracy >= 80 ? 'var(--success)' : accuracy >= 60 ? 'var(--warning)' : 'var(--danger)';
        
        container.innerHTML = `
            <div class="donut-chart">
                <svg width="160" height="160" viewBox="0 0 120 120">
                    <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border)" stroke-width="12"/>
                    <circle cx="60" cy="60" r="50" fill="none" stroke="${accuracyColor}" stroke-width="12"
                        stroke-dasharray="${correctDash} ${circumference}"
                        stroke-dashoffset="0"
                        transform="rotate(-90 60 60)"
                        style="transition: stroke-dasharray 0.5s ease"/>
                </svg>
                <div class="donut-center">
                    <span class="donut-value">${accuracy}%</span>
                    <span class="donut-label">Accuracy</span>
                </div>
            </div>
            <div class="donut-legend">
                <div class="legend-item">
                    <span class="legend-dot correct"></span>
                    <span class="legend-text">Correct: ${correct}</span>
                </div>
                <div class="legend-item">
                    <span class="legend-dot incorrect"></span>
                    <span class="legend-text">Incorrect: ${incorrect}</span>
                </div>
            </div>
        `;
    }
    
    // Render SVG donut chart for review panel
    function renderReviewDonut() {
        const container = document.getElementById('review-donut');
        if (!container) return;
        
        // Include ALL questions (both practice and exam) for review stats
        const allAnswers = Object.entries(answerState);
        const attempted = allAnswers.length;
        const correct = allAnswers.filter(([, s]) => s.correct).length;
        const incorrect = attempted - correct;
        // Include ALL flagged questions (both practice and exam)
        const flagged = flaggedQuestions.size;
        
        if (attempted === 0) {
            container.innerHTML = `
                <div class="donut-placeholder small">
                    <svg width="100" height="100" viewBox="0 0 100 100">
                        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--border)" stroke-width="10"/>
                    </svg>
                    <div class="donut-center small">
                        <span class="donut-value">--</span>
                    </div>
                </div>
            `;
            return;
        }
        
        const accuracy = Math.round((correct / attempted) * 100);
        const circumference = 2 * Math.PI * 40;
        const correctDash = (correct / attempted) * circumference;
        
        container.innerHTML = `
            <div class="donut-chart small">
                <svg width="100" height="100" viewBox="0 0 100 100">
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--danger)" stroke-width="10" opacity="0.2"/>
                    <circle cx="50" cy="50" r="40" fill="none" stroke="var(--success)" stroke-width="10"
                        stroke-dasharray="${correctDash} ${circumference}"
                        stroke-dashoffset="0"
                        transform="rotate(-90 50 50)"
                        style="transition: stroke-dasharray 0.5s ease"/>
                </svg>
                <div class="donut-center small">
                    <span class="donut-value">${accuracy}%</span>
                </div>
            </div>
        `;
    }
    
    // ==================== ADDITIONAL KPI & VISUALIZATION FUNCTIONS ====================
    
    // Render Practice vs Exam comparison chart
    function renderPracticeExamComparison() {
        const container = document.getElementById('practice-exam-comparison');
        if (!container) return;
        
        // Calculate practice stats (non-exam questions)
        const practiceAnswers = Object.entries(answerState).filter(([qId]) => !isExamQuestion(qId));
        const practiceAttempted = practiceAnswers.length;
        const practiceCorrect = practiceAnswers.filter(([, s]) => s.correct).length;
        const practiceAccuracy = practiceAttempted > 0 ? Math.round((practiceCorrect / practiceAttempted) * 100) : 0;
        
        // Calculate exam stats
        const examAnswers = Object.entries(answerState).filter(([qId]) => isExamQuestion(qId));
        const examAttempted = examAnswers.length;
        const examCorrect = examAnswers.filter(([, s]) => s.correct).length;
        const examAccuracy = examAttempted > 0 ? Math.round((examCorrect / examAttempted) * 100) : 0;
        
        if (practiceAttempted === 0 && examAttempted === 0) {
            container.innerHTML = '<p class="placeholder-text">No data yet</p>';
            return;
        }
        
        container.innerHTML = `
            <div class="comparison-bar-group">
                <div class="comparison-bar-label"><span>Practice</span><span>${practiceCorrect}/${practiceAttempted}</span></div>
                <div class="comparison-bar">
                    <div class="comparison-bar-fill practice" style="width: ${practiceAccuracy}%">
                        ${practiceAccuracy > 15 ? `<span class="comparison-bar-value">${practiceAccuracy}%</span>` : ''}
                    </div>
                </div>
            </div>
            <div class="comparison-bar-group">
                <div class="comparison-bar-label"><span>Exam</span><span>${examCorrect}/${examAttempted}</span></div>
                <div class="comparison-bar">
                    <div class="comparison-bar-fill exam" style="width: ${examAccuracy}%">
                        ${examAccuracy > 15 ? `<span class="comparison-bar-value">${examAccuracy}%</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }
    
    // Render 7-day activity chart
    function renderWeeklyActivityChart() {
        const container = document.getElementById('weekly-activity-chart');
        if (!container) return;
        
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const today = new Date();
        const days = [];
        
        // Get last 7 days
        for (let i = 6; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            days.push({
                date: date,
                dayName: dayNames[date.getDay()],
                isToday: i === 0
            });
        }
        
        // Count questions answered per day
        const dailyCounts = days.map(day => {
            const dayStart = new Date(day.date);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(day.date);
            dayEnd.setHours(23, 59, 59, 999);
            
            let count = 0;
            Object.values(answerState).forEach(state => {
                if (state.timestamp) {
                    const answerDate = new Date(state.timestamp);
                    if (answerDate >= dayStart && answerDate <= dayEnd) {
                        count++;
                    }
                }
            });
            return count;
        });
        
        const maxCount = Math.max(...dailyCounts, 1);
        
        let html = '<div class="activity-days">';
        days.forEach((day, i) => {
            const count = dailyCounts[i];
            const height = Math.max(4, (count / maxCount) * 80);
            const barClass = day.isToday ? 'today' : (count > 0 ? 'active' : 'inactive');
            
            html += `
                <div class="activity-day">
                    <div class="activity-bar-container">
                        <div class="activity-bar ${barClass}" style="height: ${height}px" title="${count} questions"></div>
                    </div>
                    <span class="activity-day-label">${day.dayName}</span>
                    ${count > 0 ? `<span class="activity-day-count">${count}</span>` : ''}
                </div>
            `;
        });
        html += '</div>';
        
        container.innerHTML = html;
    }
    
    // Render additional KPI metrics
    function renderKPIMetrics() {
        // Average speed (questions per minute based on study time)
        const avgSpeedEl = document.getElementById('avg-speed');
        const masteryLevelEl = document.getElementById('mastery-level');
        const bestCategoryEl = document.getElementById('best-category');
        const longestStreakEl = document.getElementById('longest-streak');
        
        const totalAttempted = Object.keys(answerState).length;
        const studySeconds = getStudyTime();
        
        if (avgSpeedEl) {
            if (totalAttempted > 0 && studySeconds > 60) {
                const questionsPerMin = (totalAttempted / (studySeconds / 60)).toFixed(1);
                avgSpeedEl.textContent = `${questionsPerMin}/min`;
            } else {
                avgSpeedEl.textContent = '--';
            }
        }
        
        // Categories mastered (>80% accuracy with 5+ questions)
        if (masteryLevelEl) {
            const categoryStats = {};
            Object.entries(answerState).forEach(([qId, state]) => {
                const question = getQuestionById(qId);
                const isExam = isExamQuestion(qId);
                const category = isExam ? 'Exam' : (question?.appendix || 'Unknown');
                
                if (!categoryStats[category]) {
                    categoryStats[category] = { attempted: 0, correct: 0 };
                }
                categoryStats[category].attempted++;
                if (state.correct) categoryStats[category].correct++;
            });
            
            let masteredCount = 0;
            let bestCategory = null;
            let bestAccuracy = 0;
            
            Object.entries(categoryStats).forEach(([cat, stats]) => {
                if (stats.attempted >= 5) {
                    const accuracy = (stats.correct / stats.attempted) * 100;
                    if (accuracy >= 80) masteredCount++;
                    if (accuracy > bestAccuracy) {
                        bestAccuracy = accuracy;
                        bestCategory = cat;
                    }
                }
            });
            
            masteryLevelEl.textContent = masteredCount;
            
            if (bestCategoryEl) {
                bestCategoryEl.textContent = bestCategory ? (bestCategory.length > 8 ? bestCategory.substring(0, 8) + '...' : bestCategory) : '--';
            }
        }
        
        // Longest streak
        if (longestStreakEl) {
            const streak = loadStreak();
            longestStreakEl.textContent = `${streak.longest || streak.count || 0}d`;
        }
    }
    
    // Render recent activity feed
    function renderRecentActivity() {
        const container = document.getElementById('recent-activity');
        if (!container) return;
        
        // Get recent answers sorted by timestamp
        const recentAnswers = Object.entries(answerState)
            .filter(([, state]) => state.timestamp)
            .sort((a, b) => new Date(b[1].timestamp) - new Date(a[1].timestamp))
            .slice(0, 8);
        
        if (recentAnswers.length === 0) {
            container.innerHTML = '<p class="placeholder-text">No activity yet</p>';
            return;
        }
        
        let html = '';
        recentAnswers.forEach(([qId, state]) => {
            const question = getQuestionById(qId);
            const questionText = question?.question || 'Question';
            const truncatedText = questionText.length > 60 ? questionText.substring(0, 60) + '...' : questionText;
            const isExam = isExamQuestion(qId);
            const category = isExam ? 'Exam' : (question?.appendix || '?');
            const timeAgo = getTimeAgo(new Date(state.timestamp));
            
            html += `
                <div class="recent-activity-item">
                    <div class="recent-activity-icon ${state.correct ? 'correct' : 'incorrect'}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            ${state.correct 
                                ? '<path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/>' 
                                : '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'}
                        </svg>
                    </div>
                    <div class="recent-activity-content">
                        <div class="recent-activity-question">${escapeHtml(truncatedText)}</div>
                        <div class="recent-activity-meta">${isExam ? 'Exam' : 'App. ' + category}</div>
                    </div>
                    <span class="recent-activity-time">${timeAgo}</span>
                </div>
            `;
        });
        
        container.innerHTML = html;
    }
    
    // Helper: Get time ago string
    function getTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return 'now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h`;
        const days = Math.floor(hours / 24);
        return `${days}d`;
    }
    
    // Update all additional visualizations
    function updateAdditionalVisualizations() {
        renderPracticeExamComparison();
        renderWeeklyActivityChart();
        renderKPIMetrics();
        renderRecentActivity();
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
            showToast(`You're now level ${level}!`, {
                variant: 'levelup',
                title: 'Level Up!',
                duration: 5000
            });
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

        // Show typing indicator with animated dots (reuses existing .ai-dots CSS animation)
        const placeholder = document.createElement("div");
        placeholder.classList.add("chat-message", "assistant");
        placeholder.innerHTML = '<span class="ai-dots"><span>.</span><span>.</span><span>.</span></span>';
        messagesEl.appendChild(placeholder);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        
        const result = await callTutor(chatHistory.slice(-10));
        
        // callTutor now returns a string directly (RAG removed for faster responses)
        if (placeholder) {
            placeholder.textContent = result;
        }
        chatHistory.push({ role: "assistant", content: result });
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
	        
	        // Load exam quiz when activating exam panel
	        if (panelId === 'exam' && typeof loadExamQuiz === 'function') {
	            loadExamQuiz();
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
            
                window.openApiKeyModal = openModal;
        
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
                            closeModal();
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
        
        // Load exam quiz when switching to exam panel
        if (panelName === 'exam' && typeof loadExamQuiz === 'function') {
            loadExamQuiz();
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
                    { id: 'exam', title: 'Exam', desc: 'Full exam practice with all CREST questions' },
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
            
