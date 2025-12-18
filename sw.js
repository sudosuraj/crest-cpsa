const CACHE_NAME = 'cpsa-quiz-v16';
const urlsToCache = [
    '/crest-cpsa/',
    '/crest-cpsa/index.html',
    '/crest-cpsa/styles/main.css',
    '/crest-cpsa/js/config.js',
    '/crest-cpsa/js/db-utils.js',
    '/crest-cpsa/js/llm-client.js',
    '/crest-cpsa/js/question-cache.js',
    '/crest-cpsa/js/p2p-sync.js',
    '/crest-cpsa/js/app.js',
    '/crest-cpsa/js/quiz-data.js',
    '/crest-cpsa/js/rag.js',
    '/crest-cpsa/manifest.json',
    '/crest-cpsa/icon-192.svg',
    '/crest-cpsa/icon-512.svg',
    '/crest-cpsa/og-image.svg',
    '/crest-cpsa/rag/index.json'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
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
                    // Fallback to cache if offline
                    return caches.match(event.request).then((response) => {
                        return response || caches.match('/crest-cpsa/index.html');
                    });
                })
        );
    } else {
        // Cache-first for other assets (images, CSS, JS, etc.)
        event.respondWith(
            caches.match(event.request)
                .then((response) => {
                    if (response) {
                        return response;
                    }
                    return fetch(event.request).then((response) => {
                        if (!response || response.status !== 200 || response.type !== 'basic' || event.request.method !== 'GET') {
                            return response;
                        }
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(event.request, responseToCache);
                        });
                        return response;
                    });
                })
                .catch(() => {
                    return caches.match('/crest-cpsa/index.html');
                })
        );
    }
});
