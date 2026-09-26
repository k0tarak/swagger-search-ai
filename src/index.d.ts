/** Loaded OpenAPI 3.x or Swagger 2.0 document. */
export interface OpenAPIDocument {
    openapi?: string;
    swagger?: string;
    info?: object;
    paths?: object;
    components?: object;
    definitions?: object;
}

export interface SearchOptions {
    /** Maximum visible results, 1–200. Default: 40. */
    limit?: number;
    /** Try one-edit typo recovery when literal search is empty. Default: true. */
    fuzzy?: boolean;
    /** Each string groups interchangeable words, e.g. "purchase order". */
    synonyms?: string[];
    stopWords?: string[];
    /** Receives a lowercase word; return one nonempty word. */
    normalizeTerm?: (word: string) => string;
}

export interface VocabularyOptions {
    /** Minimum candidate score relative to the best match, 0–1. Default: 0.45. Lower values broaden context. */
    minScoreRatio?: number;
    synonyms?: string[];
    aliases?: [queryPhrases: string, technicalNames: string, relatedNames?: string][];
    stopWords?: string[];
    actionTerms?: string[];
    normalizeTerm?: (word: string) => string;
    technicalTermKey?: (word: string) => string;
}

export interface ModelOptions {
    id: string;
    name?: string;
    reasoning?: Record<string, unknown>;
    provider?: Record<string, unknown>;
    /** Output token allowance, including reasoning where applicable. Default: 8192. */
    maxTokens?: number;
}

export interface AIOptions extends VocabularyOptions {
    /** Replaces the entire default free-model chain. If provided, must be nonempty. */
    models?: ModelOptions[];
    keyPersistence?: { url?: boolean; localStorage?: boolean };
    fetch?: typeof fetch;
    /** Total request deadline including fallback models. Default: 120000. */
    timeoutMs?: number;
    /** Maximum characters of retrieved context; at least 200. Default: 24000. */
    contextBudget?: number;
}

interface EntryBase {
    name: string;
    detail: string;
    description: string;
    nameText: string;
    searchText: string;
    specName?: string;
    specUrl?: string;
}
export interface OperationEntry extends EntryBase {
    kind: 'operation';
    method: string;
    path: string;
    tag: string;
    operationId?: string;
    keywords: string;
    parametersText: string;
}
export interface ModelEntry extends EntryBase {
    kind: 'model';
    model: string;
    specPath: Array<string | number>;
}
export interface FieldEntry extends EntryBase {
    kind: 'field';
    model: string;
    specPath: Array<string | number>;
    type: string | string[];
    required: boolean;
}
export type SearchEntry = OperationEntry | ModelEntry | FieldEntry;
export type SearchIndex = SearchEntry[];
export interface SearchResult { total: number; entries: SearchEntry[] }

declare const assistantIndexBrand: unique symbol;
export interface AssistantIndex {
    readonly [assistantIndexBrand]: true;
    readonly warnings: string[];
    readonly nodes: ReadonlyMap<string, unknown>;
    readonly fragments: ReadonlyMap<string, unknown>;
}
export interface AssistantSource {
    id: string;
    name: string;
    kind: 'operation' | 'model';
    sourceId: string;
    schemaNames: string;
    operationId?: string;
    method?: string;
    path?: string;
    tag?: string;
    model?: string;
    specPath?: Array<string | number>;
}
export interface RetrievalResult {
    context: string;
    sources: AssistantSource[];
    diagnostics: {
        candidates: Array<{ name: string; score: number }>;
        missingSubjects?: string[];
        subjectMissing?: boolean;
        fragments?: number;
        schemas?: number;
        skipped?: number;
        warnings?: string[];
    };
}

/** Minimal public Swagger UI contract; other Swagger UI methods remain host-owned. */
export interface SwaggerUIInstance {
    getSystem(): any;
    specSelectors: { specJson(): { toJS(): OpenAPIDocument } };
}
export interface Specification { name: string; url: string }
export interface SwaggerSearchOptions {
    element: HTMLElement;
    title?: string;
    /** true or {} enables the assistant with default models. Omitted or false disables it. */
    ai?: boolean | AIOptions;
    search?: SearchOptions;
    specifications?: Specification[];
    showSpecificationName?: boolean;
    /** Timeout for each background specification download. Default: 30000. */
    catalogTimeoutMs?: number;
}
export interface SwaggerSearchExtension {
    element: HTMLDivElement;
    plugin(system: any): object;
    attach(ui: SwaggerUIInstance): boolean;
    navigate(entry: SearchEntry, options?: { source?: 'assistant' | 'search' }): void;
    /** Remove controls, abort requests and release listeners. Safe to call twice. */
    destroy(): void;
}

export function createSwaggerSearch(options: SwaggerSearchOptions): SwaggerSearchExtension;
export function buildSearchIndex(spec: OpenAPIDocument, options?: SearchOptions): SearchIndex;
export function search(index: SearchIndex, query: string, limit?: number): SearchResult;
export function buildAssistantIndex(spec: OpenAPIDocument, options?: VocabularyOptions): AssistantIndex;
export function retrieve(index: AssistantIndex, question: string, budget?: number): RetrievalResult;
export interface OpenRouterResult {
    content: string;
    model: string | null;
    /** True when the model stopped at its output limit; content is left unchanged. */
    truncated: boolean;
}
/** Error responses expose these properties in addition to Error.message. Configuration errors are TypeErrors. */
export interface OpenRouterError extends Error {
    name: 'OpenRouterError';
    code: string;
    /** Provider status, including errors delivered inside HTTP 200. Absent for network failures. */
    status?: number;
    httpStatus?: number;
    /** Whether the client may immediately try the next configured model. */
    retryable: boolean;
    /** Suggested wait from Retry-After in milliseconds, when readable by the browser. */
    retryAfterMs?: number;
}
/** Omitting models uses the same default free-model chain as ai: true. */
export function completeOpenRouter(key: string, messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal, fetcher?: typeof fetch, onFallback?: (model: string) => void,
    models?: ModelOptions[]): Promise<OpenRouterResult>;
