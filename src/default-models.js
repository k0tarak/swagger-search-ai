'use strict';

// Keep a fixed, documented order. Return fresh nested settings for every caller.
// Successful smoke-test models first; temporarily rate-limited models remain fallbacks.
module.exports = function defaultModels() {
    return [
        { id: 'poolside/laguna-s-2.1:free', name: 'Laguna S 2.1', reasoning: { enabled: true, exclude: true } },
        { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra', reasoning: { effort: 'high', exclude: true } },
        { id: 'cohere/north-mini-code:free', name: 'North Mini Code', reasoning: { enabled: true, exclude: true } },
        { id: 'qwen/qwen3.8-27b:free', name: 'Qwen3.8 27B', reasoning: { effort: 'medium', exclude: true } },
        { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', reasoning: { enabled: true, exclude: true } },
        { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B A4B', reasoning: { enabled: true, exclude: true } }
    ].map(model => ({ ...model, maxTokens: 8192,
        provider: { allow_fallbacks: true, sort: 'latency', max_price: { prompt: 0, completion: 0, request: 0 } } }));
};
