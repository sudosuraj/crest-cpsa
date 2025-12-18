const CACHE_NAME = 'cpsa-quiz-v22';

// Relative paths to cache - will be resolved to absolute URLs at install time
const ASSETS_TO_CACHE = [
    '',
    'index.html',
    'styles/main.css',
    'js/config.js',
    'js/db-utils.js',
    'js/llm-client.js',
    'js/question-cache.js',
    'js/p2p-sync.js',
    'js/app.js',
    'js/quiz-data.js',
    'js/rag.js',
    'manifest.json',
    'icon-192.svg',
    'icon-512.svg',
    'og-image.svg',
    'rag/index.json'
];

// Install event - cache resources with absolute URLs derived from SW scope
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Opened cache, scope:', self.registration.scope);
                // Resolve relative paths to absolute URLs using SW scope as base
                const BASE = self.registration.scope;
                const absoluteUrls = ASSETS_TO_CACHE.map(path => new URL(path, BASE).href);
                console.log('Caching URLs:', absoluteUrls);
                return cache.addAll(absoluteUrls);
            })
            .catch((error) => {
                console.log('Cache install failed:', error);
            })
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

// Helper to get absolute index.html URL from SW scope
function getIndexUrl() {
    return new URL('index.html', self.registration.scope).href;
}

// Fetch event - network-first for HTML, cache-first for other assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    const isHTML = event.request.destination === 'document' || 
                   url.pathname.endsWith('.html') || 
                   url.pathname.endsWith('/');
    
    if (isHTML) {
        // Network-first for HTML - always try to get fresh content
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                    }
                    return response;
                })
                .catch(() => {
                    // Fallback to cache if offline - ONLY match from current cache to avoid stale HTML
                    return caches.open(CACHE_NAME).then((cache) => {
                        return cache.match(event.request, { ignoreSearch: true }).then((response) => {
                            return response || cache.match(getIndexUrl(), { ignoreSearch: true });
                        });
                    });
                })
        );
    } else {
        // Cache-first for other assets (images, CSS, JS, etc.)
        // IMPORTANT: Only match from current cache to avoid serving stale assets from old caches
        // DO NOT return index.html as fallback for non-HTML requests - that breaks CSS/JS loading
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(event.request).then((response) => {
                    if (response) {
                        return response;
                    }
                    return fetch(event.request).then((networkResponse) => {
                        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic' || event.request.method !== 'GET') {
                            return networkResponse;
                        }
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });
                });
            }).catch((error) => {
                // For non-HTML assets, just return an error response
                // DO NOT return index.html - that would make CSS/JS requests receive HTML content
                console.error('Asset fetch failed:', event.request.url, error);
                return new Response('Asset not available offline', { 
                    status: 503, 
                    statusText: 'Service Unavailable' 
                });
            })
        );
    }
});
