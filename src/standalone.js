'use strict';

const { createSwaggerSearch } = require('./plugin.js');
const { validateSpecifications } = require('./openapi.js');

function mount({ element, openapi, ai, title, primaryName, swagger = {}, search, catalogTimeoutMs } = {}) {
    if (!element || typeof element.append !== 'function') throw new TypeError('element must be a DOM element');
    if (!openapi || (typeof openapi !== 'string' && typeof openapi !== 'object') ||
        (typeof openapi === 'string' && !openapi.trim())) {
        throw new TypeError('openapi must be a URL, an OpenAPI object, or a list of named URLs');
    }
    if (!swagger || typeof swagger !== 'object' || Array.isArray(swagger)) throw new TypeError('swagger must be an options object');
    if (['url', 'urls', 'spec', 'domNode', 'dom_id', 'configUrl', 'queryConfigEnabled', 'urls.primaryName'].some(key => key in swagger)) {
        throw new TypeError('Pass specification and mount element through openapi and element, not swagger');
    }
    const multiple = Array.isArray(openapi);
    if (multiple) {
        validateSpecifications(openapi, element.ownerDocument.baseURI);
        if (primaryName && !openapi.some(item => item.name === primaryName)) {
            throw new TypeError('primaryName must match a specification name');
        }
    }
    const doc = element.ownerDocument;
    if (!doc?.defaultView || !element.isConnected) throw new TypeError('element must be connected to a browser document');
    if (doc.getElementById('api-search-input')) throw new Error('Use one Swagger Search AI instance per document. Call destroy() before mounting again.');
    const SwaggerUIBundle = require('swagger-ui-dist/swagger-ui-bundle.js');
    const SwaggerUIStandalonePreset = require('swagger-ui-dist/swagger-ui-standalone-preset.js');
    const controls = doc.createElement('div');
    const swaggerRoot = doc.createElement('div');
    swaggerRoot.className = 'swagger-search-ai-swagger';
    if (!doc.getElementById('swagger-ui')) swaggerRoot.id = 'swagger-ui';
    element.append(controls, swaggerRoot);
    let extension;
    try {
        extension = createSwaggerSearch({ element: controls, ai, title, search, catalogTimeoutMs, showSpecificationName: multiple,
            specifications: multiple ? openapi : undefined });
    } catch (error) { controls.remove(); swaggerRoot.remove(); throw error; }
    const lifetime = { destroyed: false, unmount: () => {} };
    const lifecycle = system => ({ wrapComponents: { App: Original => function App(props) {
        const [disposed, setDisposed] = system.React.useState(lifetime.destroyed);
        lifetime.unmount = () => setDisposed(true);
        return disposed || lifetime.destroyed ? null : system.React.createElement(Original, props);
    } } });
    const originalComplete = swagger.onComplete;
    let ui;
    try { ui = SwaggerUIBundle({
        ...swagger,
        ...(multiple ? { urls: openapi, 'urls.primaryName': primaryName || openapi[0].name,
            presets: swagger.presets || [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
            layout: swagger.layout || 'StandaloneLayout' }
            : typeof openapi === 'string' ? { url: openapi } : { spec: openapi }),
        domNode: swaggerRoot,
        deepLinking: swagger.deepLinking ?? true,
        validatorUrl: swagger.validatorUrl === undefined ? null : swagger.validatorUrl,
        plugins: [...(swagger.plugins || []), extension.plugin, lifecycle],
        onComplete() {
            // Hosts may complete synchronously; wait until the instance is assigned.
            queueMicrotask(() => {
                if (lifetime.destroyed) return;
                extension.attach(ui);
                originalComplete?.();
            });
        }
    }); } catch (error) {
        lifetime.destroyed = true; lifetime.unmount();
        extension.destroy(); controls.remove(); swaggerRoot.remove();
        throw error;
    }
    return { ui, ...extension, destroy() {
        if (lifetime.destroyed) return;
        lifetime.destroyed = true;
        extension.destroy();
        lifetime.unmount();
        controls.remove(); swaggerRoot.remove();
    } };
}

module.exports = { mount };
