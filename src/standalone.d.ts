import type { OpenAPIDocument, Specification, SwaggerSearchOptions, SwaggerSearchExtension, SwaggerUIInstance } from './index';

export interface MountOptions extends Omit<SwaggerSearchOptions, 'specifications' | 'showSpecificationName'> {
    openapi: string | OpenAPIDocument | Specification[];
    primaryName?: string;
    /** Swagger UI configuration, excluding fields owned by mount(). */
    swagger?: Record<string, unknown>;
}
export interface MountedSwaggerSearch extends SwaggerSearchExtension { ui: SwaggerUIInstance }
export function mount(options: MountOptions): MountedSwaggerSearch;
