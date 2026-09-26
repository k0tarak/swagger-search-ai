'use strict';

const { createSwaggerSearch } = require('./plugin.js');
const search = require('./search.js');
const assistant = require('./assistant.js');

module.exports = {
    createSwaggerSearch,
    buildSearchIndex: search.buildIndex,
    search: search.search,
    buildAssistantIndex: assistant.buildIndex,
    retrieve: assistant.retrieve,
    completeOpenRouter: assistant.complete
};
