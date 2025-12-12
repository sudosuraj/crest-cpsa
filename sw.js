const CACHE_NAME = 'cpsa-quiz-v4';
const urlsToCache = [
    '/CREST/',
    '/CREST/index.html',
    '/CREST/manifest.json',
    '/CREST/sitemap.xml',
    '/CREST/robots.txt'
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
                        return response || caches.match('/CREST/index.html');
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
                    return caches.match('/CREST/index.html');
                })
        );
    }
});
