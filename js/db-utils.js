/**
 * IndexedDB utility wrapper for CREST CPSA Quiz
 * Centralizes all IndexedDB operations to reduce code duplication
 */

const DBUtils = (function() {
    const DB_NAME = 'cpsa-rag-cache';
    const DB_VERSION = 2;
    
    let dbInstance = null;
    
    /**
     * Opens or creates the IndexedDB database
     * @returns {Promise<IDBDatabase>}
     */
    async function openDB() {
        if (dbInstance) {
            return dbInstance;
        }
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            
            request.onerror = () => {
                console.error('Failed to open IndexedDB:', request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                dbInstance = request.result;
                resolve(dbInstance);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // Create chunks store if it doesn't exist
                if (!db.objectStoreNames.contains('chunks')) {
                    db.createObjectStore('chunks', { keyPath: 'id' });
                }
                
                // Create questions store if it doesn't exist
                if (!db.objectStoreNames.contains('questions')) {
                    db.createObjectStore('questions', { keyPath: 'chunkId' });
                }
            };
        });
    }
    
    /**
     * Gets an item from a store
     * @param {string} storeName - The name of the object store
     * @param {string} key - The key to retrieve
     * @returns {Promise<any>}
     */
    async function get(storeName, key) {
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            
            request.onerror = () => {
                console.error(`Failed to get ${key} from ${storeName}:`, request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                resolve(request.result);
            };
        });
    }
    
    /**
     * Gets all items from a store
     * @param {string} storeName - The name of the object store
     * @returns {Promise<any[]>}
     */
    async function getAll(storeName) {
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            
            request.onerror = () => {
                console.error(`Failed to get all from ${storeName}:`, request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                resolve(request.result || []);
            };
        });
    }
    
    /**
     * Puts an item into a store
     * @param {string} storeName - The name of the object store
     * @param {any} item - The item to store (must have keyPath property)
     * @returns {Promise<void>}
     */
    async function put(storeName, item) {
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(item);
            
            request.onerror = () => {
                console.error(`Failed to put item in ${storeName}:`, request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                resolve();
            };
        });
    }
    
    /**
     * Puts multiple items into a store
     * @param {string} storeName - The name of the object store
     * @param {any[]} items - The items to store
     * @returns {Promise<void>}
     */
    async function putAll(storeName, items) {
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            
            let completed = 0;
            let hasError = false;
            
            items.forEach(item => {
                const request = store.put(item);
                
                request.onerror = () => {
                    if (!hasError) {
                        hasError = true;
                        console.error(`Failed to put items in ${storeName}:`, request.error);
                        reject(request.error);
                    }
                };
                
                request.onsuccess = () => {
                    completed++;
                    if (completed === items.length && !hasError) {
                        resolve();
                    }
                };
            });
            
            if (items.length === 0) {
                resolve();
            }
        });
    }
    
    /**
     * Deletes an item from a store
     * @param {string} storeName - The name of the object store
     * @param {string} key - The key to delete
     * @returns {Promise<void>}
     */
    async function remove(storeName, key) {
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);
            
            request.onerror = () => {
                console.error(`Failed to delete ${key} from ${storeName}:`, request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                resolve();
            };
        });
    }
    
    /**
     * Clears all items from a store
     * @param {string} storeName - The name of the object store
     * @returns {Promise<void>}
     */
    async function clear(storeName) {
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.clear();
            
            request.onerror = () => {
                console.error(`Failed to clear ${storeName}:`, request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                resolve();
            };
        });
    }
    
    /**
     * Checks if a key exists in a store
     * @param {string} storeName - The name of the object store
     * @param {string} key - The key to check
     * @returns {Promise<boolean>}
     */
    async function has(storeName, key) {
        const item = await get(storeName, key);
        return item !== undefined;
    }
    
    /**
     * Gets the count of items in a store
     * @param {string} storeName - The name of the object store
     * @returns {Promise<number>}
     */
    async function count(storeName) {
        const db = await openDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.count();
            
            request.onerror = () => {
                console.error(`Failed to count ${storeName}:`, request.error);
                reject(request.error);
            };
            
            request.onsuccess = () => {
                resolve(request.result);
            };
        });
    }
    
    /**
     * Closes the database connection
     */
    function close() {
        if (dbInstance) {
            dbInstance.close();
            dbInstance = null;
        }
    }
    
    // Store names constants
    const STORES = {
        CHUNKS: 'chunks',
        QUESTIONS: 'questions'
    };
    
    return {
        openDB,
        get,
        getAll,
        put,
        putAll,
        remove,
        clear,
        has,
        count,
        close,
        STORES
    };
})();

// Make DBUtils available globally
if (typeof window !== 'undefined') {
    window.DBUtils = DBUtils;
}
