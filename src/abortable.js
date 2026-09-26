'use strict';

// Interceptors and custom fetchers may ignore AbortSignal. Still release the UI
// immediately, and consume any late rejection without publishing stale results.
module.exports = function abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || new Error('Request canceled.'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
};
