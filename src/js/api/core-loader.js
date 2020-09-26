import Item from 'playlist/item';
import { fixSources } from 'playlist/playlist';
import ProvidersSupported from 'providers/providers-supported';
import registerProvider from 'providers/providers-register';
import { ControlsLoader } from 'controller/controls-loader';
import { resolved } from 'polyfills/promise';
import { PlayerError, SETUP_ERROR_LOADING_CORE_JS } from 'api/errors';

let bundlePromise = null;

export const bundleContainsProviders = {};

export default function loadCoreBundle(model) {
    if (!bundlePromise) {
        bundlePromise = selectBundle(model);
    }
    return bundlePromise;
}

export function chunkLoadErrorHandler(code, error) {
    // Webpack require.ensure error: "Loading chunk 3 failed"
    return () => {
        throw new PlayerError('Network error', code, error);
    };
}

export function selectBundle(model) {
    const controls = model.get('controls');
    const polyfills = requiresPolyfills();
    const html5Provider = requiresProvider(model, 'html5');

    if (controls && polyfills && html5Provider) {
        return loadControlsPolyfillHtml5Bundle();
    }
    if (controls && html5Provider) {
        return loadControlsHtml5Bundle();
    }
    if (controls && polyfills) {
        return loadControlsPolyfillBundle();
    }
    if (controls) {
        return loadControlsBundle();
    }
    return loadCore();
}

export function requiresPolyfills() {
    const IntersectionObserverEntry = window.IntersectionObserverEntry;
    return !IntersectionObserverEntry ||
        !('IntersectionObserver' in window) ||
        !('intersectionRatio' in IntersectionObserverEntry.prototype);
}

export function requiresProvider(model, providerName) {
    const playlist = model.get('playlist');
    if (Array.isArray(playlist) && playlist.length) {
        const sources = fixSources(Item(playlist[0]), model);
        for (let i = 0; i < sources.length; i++) {
            const source = sources[i];
            const providersManager = model.getProviders();
            for (let j = 0; j < ProvidersSupported.length; j++) {
                const provider = ProvidersSupported[j];
                if (providersManager.providerSupports(provider, source)) {
                    return (provider.name === providerName);
                }
            }
        }
    }
    return false;
}

function loadControlsPolyfillHtml5Bundle() {
    const loadPromise = require.ensure([
        'controller/controller',
        'view/controls/controls',
        'intersection-observer',
        'providers/html5'
    ], function (require) {
        // These modules should be required in this order
        require('intersection-observer');
        const CoreMixin = require('controller/controller').default;
        ControlsLoader.controls = require('view/controls/controls').default;
        registerProvider(require('providers/html5').default);
        return CoreMixin;
    }, chunkLoadErrorHandler(SETUP_ERROR_LOADING_CORE_JS + 105), 'jwplayer.core.controls.polyfills.html5');
    bundleContainsProviders.html5 = loadPromise;
    return loadPromise;
}

function loadControlsHtml5Bundle() {
    const loadPromise = require.ensure([
        'controller/controller',
        'view/controls/controls',
        'providers/html5'
    ], function (require) {
        const CoreMixin = require('controller/controller').default;
        ControlsLoader.controls = require('view/controls/controls').default;
        registerProvider(require('providers/html5').default);
        return CoreMixin;
    }, chunkLoadErrorHandler(SETUP_ERROR_LOADING_CORE_JS + 104), 'jwplayer.core.controls.html5');
    bundleContainsProviders.html5 = loadPromise;
    return loadPromise;
}

function loadControlsPolyfillBundle() {
    return require.ensure([
        'controller/controller',
        'view/controls/controls',
        'intersection-observer'
    ], function (require) {
        require('intersection-observer');
        const CoreMixin = require('controller/controller').default;
        ControlsLoader.controls = require('view/controls/controls').default;
        return CoreMixin;
    }, chunkLoadErrorHandler(SETUP_ERROR_LOADING_CORE_JS + 103), 'jwplayer.core.controls.polyfills');
}

function loadControlsBundle() {
    return require.ensure([
        'controller/controller',
        'view/controls/controls'
    ], function (require) {
        const CoreMixin = require('controller/controller').default;
        ControlsLoader.controls = require('view/controls/controls').default;
        return CoreMixin;
    }, chunkLoadErrorHandler(SETUP_ERROR_LOADING_CORE_JS + 102), 'jwplayer.core.controls');
}

function loadCore() {
    return loadIntersectionObserverIfNeeded().then(() => {
        return require.ensure([
            'controller/controller'
        ], function (require) {
            return require('controller/controller').default;
        }, chunkLoadErrorHandler(SETUP_ERROR_LOADING_CORE_JS + 101), 'jwplayer.core');
    });
}

function loadIntersectionObserverIfNeeded() {
    if (requiresPolyfills()) {
        return require.ensure([
            'intersection-observer'
        ], function (require) {
            return require('intersection-observer');
        }, chunkLoadErrorHandler(SETUP_ERROR_LOADING_CORE_JS + 120), 'polyfills.intersection-observer');
    }
    return resolved;
}
